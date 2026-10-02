// On-device translation, the download path in plain Node (features/translate-models.js): a failing
// sibling file, a full disk, a stalled connection, stale half-downloads, and two callers sharing one
// pair. Fake registry, fake fetch (real streams), fake write stream where a disk error is needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');
const M = require('../src/features/translate-models');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = new Map();
function rec(from, to, fileType, content) {
  const buf = Buffer.from(content);
  const name = `${fileType}.${from}${to}.bin`;
  const location = `w/${from}${to}-${fileType}.bin`;
  FILES.set(location, buf);
  return { fileType, fromLang: from, toLang: to, version: '2.0', name, last_modified: 1, attachment: { hash: sha(buf), size: buf.length, filename: name, location } };
}
const set = (from, to) => ['model', 'lex', 'vocab'].map((t) => rec(from, to, t, `${from}${to}${t}`.padEnd(4096, '.')));
const RECORDS = [...set('fr', 'en'), ...set('de', 'en'), ...set('es', 'en'), ...set('it', 'en')];

// How each location behaves: 'ok' | 404 | 'stall-first' (hangs after some bytes once) | 'stall' (always) | 'slow' (trickles until aborted)
const behaviour = new Map();
const calls = [];
let alive = 0; // file streams still running
function bodyOf(buf, mode, signal, tallyOnce) {
  let sent = 0;
  let over = false;
  const tally = () => { if (!over) { over = true; tallyOnce(); } };
  signal?.addEventListener('abort', tally, { once: true });
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
      if (mode === 'slow') {
        await new Promise((resolve, reject) => { const t = setTimeout(resolve, 20); signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true }); }).catch((e) => controller.error(e));
        if (signal?.aborted) return;
        controller.enqueue(buf.subarray(sent, sent + 16));
        sent += 16;
        if (sent >= buf.length) { tally(); controller.close(); }
        return;
      }
      if (sent >= 512 && (mode === 'stall' || mode === 'stall-first')) {
        await new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })).catch((e) => controller.error(e));
        return;
      }
      controller.enqueue(buf.subarray(sent, sent + 512));
      sent += 512;
      if (sent >= buf.length) { tally(); controller.close(); }
    },
    cancel() { tally(); },
  });
}
const fetchImpl = async (url, { signal } = {}) => {
  if (url.startsWith(M.REGISTRY_URL)) return new Response(JSON.stringify({ data: RECORDS }), { headers: { 'content-type': 'application/json' } });
  const loc = url.slice(M.ATTACHMENT_BASE.length);
  calls.push(loc);
  let mode = behaviour.get(loc) || 'ok';
  if (mode === 'stall-first') { behaviour.set(loc, 'ok'); }
  if (mode === 404) return new Response('no', { status: 404 });
  alive++;
  return new Response(bodyOf(FILES.get(loc), mode, signal, () => { alive--; }));
};

const tmpDirs = [];
const newDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-translate-dl-')); tmpDirs.push(d); return d; };
const parts = (d) => fs.readdirSync(d).filter((n) => n.includes('.part'));
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e)));
process.on('uncaughtException', (e) => unhandled.push(String(e)));

const keepAlive = setInterval(() => {}, 1000); // the store's timers are unref'd
(async () => {
  const loc = (from, to, type) => `w/${from}${to}-${type}.bin`;

  // 1. a sibling fails while another file is still streaming
  {
    const dir = newDir();
    behaviour.clear(); calls.length = 0;
    behaviour.set(loc('fr', 'en', 'lex'), 404);
    behaviour.set(loc('fr', 'en', 'model'), 'slow');
    behaviour.set(loc('fr', 'en', 'vocab'), 'slow');
    const store = M.createModelStore({ dir, fetch: fetchImpl, retryDelayMs: 5 });
    let err = null;
    try { await store.download('fr', 'en'); } catch (e) { err = e; }
    await sleep(100);
    check('sibling failure: the real error is reported (not a cleanup error)', err && /lex\.fr.*answered 404/.test(err.message), err && err.message);
    check('sibling failure: nothing is left behind and no stream keeps downloading', parts(dir).length === 0 && !fs.existsSync(path.join(dir, 'fr-en')) && alive === 0 && store.downloading().length === 0, `${parts(dir)} alive=${alive}`);
  }

  // 2. a disk error in the middle of a download
  {
    const dir = newDir();
    behaviour.clear(); calls.length = 0; unhandled.length = 0;
    let opened = 0;
    const openWrite = () => {
      opened++;
      let n = 0;
      return new Writable({ write(chunk, _e, cb) { if (++n > 2) cb(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })); else cb(); } });
    };
    const store = M.createModelStore({ dir, fetch: fetchImpl, openWrite, retryDelayMs: 5 });
    let err = null;
    try { await store.download('de', 'en'); } catch (e) { err = e; }
    await sleep(50);
    check('disk error: surfaces as the download error (ENOSPC), is not retried, never unhandled', err?.code === 'ENOSPC' && unhandled.length === 0 && opened === 3, `${err?.code} unhandled=${unhandled} opened=${opened}`);
    check('disk error: cleans up', parts(dir).length === 0 && alive === 0, `${parts(dir)} alive=${alive}`);
  }

  // 3. not enough free disk space is caught before any byte is fetched
  {
    const dir = newDir();
    behaviour.clear(); calls.length = 0;
    const store = M.createModelStore({ dir, fetch: fetchImpl, freeBytes: () => 1000 });
    let err = null;
    try { await store.download('es', 'en'); } catch (e) { err = e; }
    check('disk space: refused up front with a clear message, nothing fetched', err?.code === 'ENOSPC' && /free disk space/i.test(err.message) && calls.length === 0 && parts(dir).length === 0, `${err?.message} calls=${calls.length}`);
  }

  // 4. a stalled file is retried once; a file that keeps stalling fails
  {
    const dir = newDir();
    behaviour.clear(); calls.length = 0;
    behaviour.set(loc('it', 'en', 'model'), 'stall-first');
    const store = M.createModelStore({ dir, fetch: fetchImpl, stallMs: 60, retryDelayMs: 5 });
    const started = Date.now();
    const manifest = await store.download('it', 'en').catch((e) => e);
    check('stall: no data for stallMs aborts that file and one automatic retry succeeds', manifest.files?.length === 3 && store.isInstalled('it', 'en') && calls.filter((c) => c === loc('it', 'en', 'model')).length === 2 && Date.now() - started < 3000, manifest.message || JSON.stringify(calls));
    check('stall: the finished pair verifies', await store.verify('it', 'en'), '');

    const dir2 = newDir();
    behaviour.clear(); calls.length = 0;
    behaviour.set(loc('it', 'en', 'lex'), 'stall');
    const store2 = M.createModelStore({ dir: dir2, fetch: fetchImpl, stallMs: 60, retryDelayMs: 5 });
    const err = await store2.download('it', 'en').catch((e) => e);
    await sleep(50);
    check('stall: a file that stalls again fails with "no data" after exactly one retry, and cleans up', err?.code === 'stalled' && calls.filter((c) => c === loc('it', 'en', 'lex')).length === 2 && parts(dir2).length === 0 && alive === 0, `${err?.message} calls=${calls.length} alive=${alive}`);
  }

  // 5. stale half-downloads are swept
  {
    const dir = newDir();
    fs.mkdirSync(path.join(dir, 'fr-en.part-123-456'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'fr-en.part-123-456', 'model.bin'), 'x');
    const store = M.createModelStore({ dir, fetch: fetchImpl });
    check('sweep: a leftover *.part-* folder is removed when the store is created', parts(dir).length === 0, parts(dir));
    fs.mkdirSync(path.join(dir, 'de-en.part-9-9'), { recursive: true });
    store.installed();
    check('sweep: and again whenever installed() is read', parts(dir).length === 0, parts(dir));
  }

  // 6. two callers share one pair: one cancelling does not stop the other
  {
    const dir = newDir();
    behaviour.clear(); calls.length = 0;
    for (const t of ['model', 'lex', 'vocab']) behaviour.set(loc('es', 'en', t), 'slow');
    const store = M.createModelStore({ dir, fetch: fetchImpl });
    const a = new AbortController();
    const b = new AbortController();
    const pa = store.download('es', 'en', { signal: a.signal }).catch((e) => e);
    const pb = store.download('es', 'en', { signal: b.signal }).catch((e) => e);
    await sleep(60);
    a.abort();
    const ra = await pa;
    check('shared download: the caller that aborts is cancelled', ra?.code === 'cancelled', ra?.message);
    check('shared download: the other caller keeps the download running', store.downloading().length === 1, store.downloading());
    const rb = await pb;
    check('shared download: and it completes for them', rb?.files?.length === 3 && store.isInstalled('es', 'en'), rb?.message);

    // all callers abort -> the download stops
    store.remove('es', 'en');
    const c = new AbortController();
    const d = new AbortController();
    const pc = store.download('es', 'en', { signal: c.signal }).catch((e) => e);
    const pd = store.download('es', 'en', { signal: d.signal }).catch((e) => e);
    await sleep(60);
    c.abort();
    d.abort();
    const [rc, rd] = [await pc, await pd];
    await sleep(60);
    check('shared download: it stops once every caller has aborted, leaving nothing', rc?.code === 'cancelled' && rd?.code === 'cancelled' && !store.isInstalled('es', 'en') && parts(dir).length === 0 && alive === 0 && store.downloading().length === 0, `${rc?.code} ${rd?.code} ${parts(dir)} alive=${alive}`);
  }

  // 7. the settings page's cancel stops only its own download, not a tab's
  {
    const { createLocal } = require('../src/features/translate-local');
    const dir = newDir();
    behaviour.clear(); calls.length = 0;
    for (const t of ['model', 'lex', 'vocab']) behaviour.set(loc('es', 'en', t), 'slow');
    const store = M.createModelStore({ dir, fetch: fetchImpl });
    const local = createLocal({ store, fork: () => { throw new Error('no worker here'); } });
    const tabCtl = new AbortController();
    const tab = local.ensure([['es', 'en']], { signal: tabCtl.signal }).catch((e) => e);
    await sleep(40);
    const page = local.downloadLanguage('es').catch((e) => e);
    await sleep(40);
    local.cancelLanguage('es');
    const pr = await page;
    check('settings cancel: the page download reports cancelled', pr?.code === 'cancelled', pr?.message);
    check('settings cancel: a tab download of the same pack keeps going and completes', (await tab) === undefined && store.isInstalled('es', 'en'), store.downloading());
    // and the page's cancel does stop a download nobody else wants
    store.remove('es', 'en');
    const only = local.downloadLanguage('es').catch((e) => e);
    await sleep(40);
    local.cancelLanguage();
    const orr = await only;
    await sleep(60);
    check('settings cancel: with no other caller it stops and cleans up', orr?.code === 'cancelled' && store.downloading().length === 0 && parts(dir).length === 0 && alive === 0, `${orr?.code} alive=${alive}`);
  }

  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  check('no unhandled errors', unhandled.length === 0, unhandled.join('; '));
  clearInterval(keepAlive);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
