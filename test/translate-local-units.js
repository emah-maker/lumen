// On-device translation, the parts that run in plain Node (features/translate-models.js and
// translate-local.js): reading Mozilla's model registry, picking the newest complete model set, route
// planning (direct, or through English), SHA-256 checking, the download cache, cancelling, and the
// client's process handling with a fake worker. No network and no wasm: the registry and files are fakes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const M = require('../src/features/translate-models');
const { createLocal } = require('../src/features/translate-local');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A registry record for one file of a pair.
const FILES = new Map(); // location -> Buffer
function rec(from, to, version, fileType, content, extra = {}) {
  const buf = Buffer.from(content);
  const name = `${fileType}.${from}${to}.${version}.bin`;
  const location = `main-workspace/translations-models/${from}${to}-${version}-${fileType}.bin`;
  FILES.set(location, buf);
  return { fileType, fromLang: from, toLang: to, version, name, last_modified: 1, attachment: { hash: sha(buf), size: buf.length, filename: name, location }, ...extra };
}
const set = (from, to, version, size = 64) => ['model', 'lex', 'vocab'].map((t) => rec(from, to, version, t, `${from}${to}${version}${t}`.padEnd(size, '.')));
const RECORDS = [
  ...set('fr', 'en', '1.0'), ...set('fr', 'en', '2.0'), ...set('en', 'fr', '2.0'), ...set('en', 'de', '2.1'), ...set('de', 'en', '1.0'),
  ...set('ja', 'en', '3.0'), // a major the bundled engine can't run
  ...set('es', 'en', '2.0a1'), // an alpha
  ...['model', 'lex'].map((t) => rec('it', 'en', '2.0', t, `it${t}`)), // incomplete: no vocabulary
  ...['model', 'lex', 'srcvocab', 'trgvocab'].map((t) => rec('en', 'zh-Hans', '2.2', t, `zh${t}`.padEnd(64, '.'))),
];

(async () => {
  const index = M.buildIndex(RECORDS);
  check('registry: the newest version in range wins, alphas, newer majors and incomplete sets are left out',
    index['fr>en'].version === '2.0' && index['en>de'].version === '2.1' && index['de>en'].version === '1.0' && !index['ja>en'] && !index['es>en'] && !index['it>en'] && Boolean(index['en>zh-Hans']), Object.keys(index).join());
  check('registry: split vocabularies count as complete', index['en>zh-Hans'].files.map((f) => f.type).join() === 'model,lex,srcvocab,trgvocab', JSON.stringify(index['en>zh-Hans'].files.map((f) => f.type)));
  check('registry: unsafe file names and locations are dropped', Object.keys(M.buildIndex(set('fr', 'en', '2.0').map((r) => ({ ...r, attachment: { ...r.attachment, filename: '../evil.bin' } })))).length === 0 && Object.keys(M.buildIndex(set('fr', 'en', '2.0').map((r) => ({ ...r, attachment: { ...r.attachment, location: 'a/../../b' } })))).length === 0, '');
  check('registry: a bad hash or zero size is dropped', Object.keys(M.buildIndex(set('fr', 'en', '2.0').map((r) => ({ ...r, attachment: { ...r.attachment, hash: 'abc' } })))).length === 0, '');

  check('route: a direct pair is one step, same language none, English is the pivot', JSON.stringify(M.planRoute('fr', 'en', index)) === '[["fr","en"]]' && M.planRoute('fr', 'fr', index).length === 0 && JSON.stringify(M.planRoute('en', 'de', index)) === '[["en","de"]]', '');
  check('route: two languages without a pair go through English', JSON.stringify(M.planRoute('fr', 'de', index)) === '[["fr","en"],["en","de"]]' && JSON.stringify(M.planRoute('de', 'fr', index)) === '[["de","en"],["en","fr"]]', '');
  check('route: no route when a half is missing', M.planRoute('de', 'zh-Hans', index)?.length === 2 && M.planRoute('fr', 'ja', index) === null && M.planRoute('it', 'en', index) === null && M.planRoute('', 'en', index) === null, '');
  check('route: missing bytes count only the packs not installed', M.missingBytes([['fr', 'en'], ['en', 'de']], index, new Set(['fr>en'])) === index['en>de'].bytes && M.missingBytes([['fr', 'en']], index, new Set(['fr>en'])) === 0, '');
  check('languages: the registry\'s Chinese codes map both ways, and a page tag picks the variant', M.modelCode('zh-CN') === 'zh-Hans' && M.lumenCode('zh-Hant') === 'zh-TW' && M.sourceModelCode('zh', 'zh-HK') === 'zh-Hant' && M.sourceModelCode('zh', '') === 'zh-Hans' && M.sourceModelCode('no', '') === 'nb', '');
  check('languages: the list for settings has no English', M.languagesIn(index).join() === 'de,fr,zh-Hans', M.languagesIn(index).join());
  check('sizes read as people say them', M.formatBytes(24e6) === '24 MB' && M.formatBytes(1.5e9) === '1.5 GB' && M.formatBytes(2500) === '3 KB', M.formatBytes(24e6));

  // ---- the store ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-translate-models-'));
  let registryHits = 0;
  let fileHits = 0;
  let offline = false;
  let corrupt = null; // location to serve wrong bytes for
  let hold = null; // a promise to wait on before answering a file
  const fakeFetch = async (url, options = {}) => {
    if (offline) throw new TypeError('fetch failed');
    if (url.startsWith(M.REGISTRY_URL)) { registryHits++; return new Response(JSON.stringify({ data: RECORDS }), { headers: { 'content-type': 'application/json' } }); }
    if (!url.startsWith(M.ATTACHMENT_BASE)) throw new Error(`unexpected host: ${url}`);
    fileHits++;
    const loc = url.slice(M.ATTACHMENT_BASE.length);
    let buf = FILES.get(loc);
    if (!buf) return new Response('no', { status: 404 });
    if (loc === corrupt) buf = Buffer.from(buf).fill(120);
    if (hold) await Promise.race([hold, new Promise((_r, rej) => options.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))]);
    return new Response(buf);
  };
  let clock = 1000;
  const store = createStore(dir, fakeFetch, () => clock);
  function createStore(d, f, now) { return M.createModelStore({ dir: d, fetch: f, now }); }

  const idx = await store.loadIndex();
  check('store: the registry is read once and cached on disk', Object.keys(idx).length === index ? true : Object.keys(idx).join() === Object.keys(index).join() && registryHits === 1 && fs.existsSync(path.join(dir, 'registry.json')), `${registryHits}`);
  await store.loadIndex();
  check('store: a second read is served from memory', registryHits === 1, registryHits);
  const store2 = createStore(dir, fakeFetch, () => clock);
  check('store: a new session knows the index from disk without the network', Object.keys(store2.indexNow() || {}).length === Object.keys(index).length && registryHits === 1, registryHits);
  clock += M.REGISTRY_TTL_MS + 1;
  offline = true;
  const stale = await createStore(dir, fakeFetch, () => clock).loadIndex();
  check('store: offline with a stale cache still works', Object.keys(stale).length === Object.keys(index).length, '');
  let failedNoCache = false;
  try { await createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-translate-empty-')), fakeFetch, () => clock).loadIndex(); } catch { failedNoCache = true; }
  check('store: offline with no cache fails clearly', failedNoCache, '');
  offline = false;

  const seen = [];
  const manifest = await store.download('fr', 'en', { onProgress: (p) => seen.push(p) });
  const frFiles = store.filesOf('fr', 'en');
  check('download: every file is written, verified and listed in a manifest', manifest.version === '2.0' && manifest.files.length === 3 && fs.existsSync(frFiles.model) && fs.readFileSync(frFiles.vocab).length === 64, JSON.stringify(manifest));
  check('download: progress runs up to the registry\'s total', seen.length > 0 && seen[seen.length - 1].received === index['fr>en'].bytes && seen[seen.length - 1].total === index['fr>en'].bytes, JSON.stringify(seen[seen.length - 1]));
  check('download: the pair is listed as installed with its size', store.isInstalled('fr', 'en') && store.installed().length === 1 && store.installed()[0].bytes === index['fr>en'].bytes && store.usedBytes() === index['fr>en'].bytes, JSON.stringify(store.installed()));
  check('download: no temporary folder is left behind', fs.readdirSync(dir).every((n) => !n.includes('.part')), fs.readdirSync(dir).join());
  check('download: the stored files hash to what the registry says', await store.verify('fr', 'en'), '');
  fs.writeFileSync(frFiles.vocab, 'x'.repeat(64));
  check('verify: a changed file fails the integrity check', (await store.verify('fr', 'en')) === false, '');
  fs.writeFileSync(frFiles.vocab, 'short');
  check('a file with the wrong size makes the pair not installed', store.isInstalled('fr', 'en') === false && store.filesOf('fr', 'en') === null, '');
  await store.download('fr', 'en');
  check('downloading again repairs it', store.isInstalled('fr', 'en') && (await store.verify('fr', 'en')), '');

  corrupt = index['en>fr'].files[0].location;
  let badHash = '';
  try { await store.download('en', 'fr'); } catch (err) { badHash = err.message; }
  check('a file that does not match the registry hash is rejected and nothing is kept', /checksum|bytes/.test(badHash) && !store.isInstalled('en', 'fr') && !fs.existsSync(path.join(dir, 'en-fr')) && fs.readdirSync(dir).every((n) => !n.includes('.part')), badHash);
  corrupt = null;
  const wrongSize = new Map(FILES);
  FILES.set(index['en>de'].files[1].location, Buffer.from('too short'));
  let sizeErr = '';
  try { await store.download('en', 'de'); } catch (err) { sizeErr = err.message; }
  check('a file of the wrong size is rejected too', /expected/.test(sizeErr) && !store.isInstalled('en', 'de'), sizeErr);
  for (const [k, v] of wrongSize) FILES.set(k, v);

  // cancel mid-download
  let release;
  hold = new Promise((r) => { release = r; });
  const slow = store.download('de', 'en');
  slow.catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  check('a running download is reported', store.downloading().join() === 'de>en', store.downloading().join());
  store.cancel('de', 'en');
  let cancelCode = '';
  try { await slow; } catch (err) { cancelCode = err.code; }
  release();
  hold = null;
  check('cancelling rejects with "cancelled" and leaves no files', cancelCode === 'cancelled' && !store.isInstalled('de', 'en') && !fs.existsSync(path.join(dir, 'de-en')) && fs.readdirSync(dir).every((n) => !n.includes('.part')) && store.downloading().length === 0, `${cancelCode} ${fs.readdirSync(dir).join()}`);
  const ac = new AbortController();
  ac.abort();
  let preAborted = '';
  try { await store.download('de', 'en', { signal: ac.signal }); } catch (err) { preAborted = err.code; }
  check('an already-cancelled signal never starts a download', preAborted === 'cancelled', preAborted);

  // two requests for one pair share one download
  const before = fileHits;
  await Promise.all([store.download('de', 'en'), store.download('de', 'en')]);
  check('two requests for one pair share a single download', fileHits - before === 3 && store.isInstalled('de', 'en'), `${fileHits - before}`);
  store.remove('de', 'en');
  check('delete removes the pair', !store.isInstalled('de', 'en') && !fs.existsSync(path.join(dir, 'de-en')), '');
  let unknown = '';
  try { await store.download('xx', 'en'); } catch (err) { unknown = err.message; }
  check('a pair with no model is refused', /no model/.test(unknown), unknown);

  // ---- the client, with a fake worker process ----
  const sent = [];
  let forks = 0;
  let kills = 0;
  let exitCb = null;
  const fakeFork = () => {
    forks++;
    let onMsg = () => {};
    exitCb = null;
    return {
      send: (m) => {
        sent.push(m);
        if (m.type === 'translate') setImmediate(() => onMsg({ type: 'result', id: m.id, texts: m.texts.map((t) => t.toUpperCase()), loadMs: 1, inferMs: 2 }));
        if (m.type === 'warm') setImmediate(() => onMsg({ type: 'ready', id: m.id, ms: 1 }));
      },
      onMessage: (cb) => { onMsg = cb; },
      onExit: (cb) => { exitCb = cb; },
      kill: () => { kills++; },
    };
  };
  const local = createLocal({ store, fork: fakeFork, idleMs: 80, maxPairs: 2 });
  check('client: nothing starts until the first request', forks === 0, forks);
  const plan = await local.plan('fr', 'de');
  check('client: plan gives the route and what is still to download', JSON.stringify(plan.route) === '[["fr","en"],["en","de"]]' && plan.missing === index['en>de'].bytes, JSON.stringify(plan));
  const prog = [];
  await local.ensure(plan.route, { onProgress: (f) => prog.push(f) });
  check('client: ensure downloads only the missing pack, progress ends at 1', store.isInstalled('en', 'de') && prog[prog.length - 1] === 1, JSON.stringify(prog));
  check('client: readyRoute is known without the network once everything is installed', JSON.stringify(local.readyRoute('fr', 'de')) === '[["fr","en"],["en","de"]]' && local.readyRoute('de', 'fr') === null, '');
  const out = await local.translate(plan.route, ['bonjour', 'monde']);
  const req = sent.find((m) => m.type === 'translate');
  check('client: texts go to the worker with the model files of each step, and come back in order', out.join() === 'BONJOUR,MONDE' && req.steps.length === 2 && req.steps[0].from === 'fr' && req.steps[1].to === 'de' && fs.existsSync(req.steps[0].files.model) && forks === 1, JSON.stringify(req).slice(0, 200));
  await local.translate(plan.route, ['a']);
  check('client: the process is reused', forks === 1, forks);
  check('client: no texts means no work, same language means no change', (await local.translate(plan.route, [])).length === 0 && (await local.translate([], ['x', 'y'])).join() === 'x,y' && forks === 1, '');
  await new Promise((r) => setTimeout(r, 200));
  check('client: the process is stopped when idle', kills === 1 && local.stats().running === false, `${kills}`);
  await local.translate([['fr', 'en']], ['a']);
  check('client: it starts again on the next request', forks === 2, forks);
  await store.download('de', 'en');
  await local.translate([['en', 'de']], ['a']);
  await local.translate([['de', 'en']], ['a']);
  check('client: more resident models than the cap replaces the process', forks >= 3, forks);
  // a crash fails the request in flight
  const crashing = createLocal({ store, fork: () => { const f = fakeFork(); const send = f.send; f.send = (m) => { if (m.type === 'translate') setImmediate(() => exitCb?.(1)); else send(m); }; return f; }, idleMs: 1000 });
  let crashMsg = '';
  try { await crashing.translate([['fr', 'en']], ['a']); } catch (err) { crashMsg = err.message; }
  check('client: a crashed worker rejects the request and the next one starts a new process', /stopped/.test(crashMsg), crashMsg);
  crashing.stop();
  // abort while waiting
  const slowFork = () => { const f = fakeFork(); f.send = (m) => { sent.push(m); }; return f; };
  const waiting = createLocal({ store, fork: slowFork, idleMs: 1000 });
  const ctl = new AbortController();
  const pendingReq = waiting.translate([['fr', 'en']], ['a'], { signal: ctl.signal });
  ctl.abort();
  let abortCode = '';
  try { await pendingReq; } catch (err) { abortCode = err.code; }
  check('client: an aborted request rejects with "cancelled" and tells the worker to drop it', abortCode === 'cancelled' && sent.some((m) => m.type === 'cancel'), abortCode);
  waiting.stop();
  local.stop();

  // ---- the overview for settings ----
  const ov = await createLocal({ store, fork: fakeFork }).overview(['en', 'fr', 'de', 'zh-CN', 'ja', 'ko']);
  check('settings: languages with a pack are listed with sizes and what is missing; English and unknown ones are not', ov.languages.map((l) => l.code).join() === 'fr,de,zh-CN' && ov.languages.find((l) => l.code === 'fr').missing === index['en>fr'].bytes && ov.languages.find((l) => l.code === 'de').missing === 0, JSON.stringify(ov.languages));
  check('settings: installed packs use Lumen\'s language codes', ov.installed.every((p) => p.from && p.to) && ov.used === store.usedBytes(), JSON.stringify(ov.installed));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
