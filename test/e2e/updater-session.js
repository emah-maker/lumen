// The update download against a real Lumen (hidden), with no real network.
//  1. Content blocking never reaches the updater: the default session's ad blocker cancels a tracker request; the same request
//     through the updater's session (features/update-net.js, the one updates.js downloads with) goes through, and a signed,
//     redirected release URL arrives byte for byte (no query parameter dropped or rewritten on the way).
//  2. features/zip-update.stage() through that session against a local 127.0.0.1 "GitHub": latest.yml and a zip behind a 302 to a
//     signed URL that only the newest redirect may use. The first try is cut off mid-stream; the update still stages (resumed
//     with a Range request, or restarted when the server ignores ranges), after a 503, and a download that never works says why.
// Temp layout only: the "install" is a throwaway folder, the profile and TEMP are throwaway too (the staging step prepares a
// swap-helper folder in TEMP and clears older ones, which must never be the real TEMP).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const crypto = require('crypto');
const http = require('http');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const os = require('os');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const skip = (label) => console.log(`SKIP  ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..', '..');

// A zip with one stored entry: Lumen.exe, "MZ" + filler, big enough to pass the swap helper's size check.
function makeZip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt32LE(crc >>> 0, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(local, n, data); central.push(cen, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

(async () => {
  const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(11 * 1024 * 1024)]);
  const zip = makeZip([['Lumen/Lumen.exe', exe], ['Lumen/resources/app/new-file.js', Buffer.from('// new')]]);
  const hash = crypto.createHash('sha512').update(zip).digest('base64');
  const NAME = 'Lumen-9.9.9-win-x64.zip';

  // ---- the local "GitHub"
  let mode = 'plain';
  let log = [];
  let token = 0;
  let blobHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push({ path: u.pathname, range: req.headers.range || '', query: u.search });
    if (u.pathname === '/latest.yml') { res.setHeader('Content-Type', 'text/yaml'); return res.end(`version: 9.9.9\nfiles:\n  - url: ${NAME}\n    sha512: ${hash}\n    size: ${zip.length}\npath: ${NAME}\nsha512: ${hash}\n`); }
    if (u.pathname === `/releases/download/v9.9.9/${NAME}`) {
      token += 1; // each redirect is a new signed address; only the newest one still works
      res.writeHead(302, { Location: `/blob/${NAME}?sp=r&se=2026-10-17T10%3A00%3A00Z&sig=tok${token}%2Babc%3D&jwt=j${token}&utm_source=signed` });
      return res.end();
    }
    if (u.pathname === `/blob/${NAME}`) {
      blobHits += 1;
      if (u.searchParams.get('sig') !== `tok${token}+abc=`) { res.writeHead(403); return res.end('expired'); }
      if (mode === '503' && blobHits === 1) { res.writeHead(503); return res.end(); }
      const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
      const honor = m && mode !== 'drop-norange';
      const from = honor ? Number(m[1]) : 0;
      const body = zip.subarray(from);
      const head = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), ETag: '"zip1"', 'Accept-Ranges': 'bytes' };
      if (honor) { res.writeHead(206, { ...head, 'Content-Range': `bytes ${from}-${zip.length - 1}/${zip.length}` }); } else res.writeHead(200, head);
      const cut = (mode === 'always-drop' || (mode.startsWith('drop') && blobHits === 1)) ? Math.floor(body.length * 0.4) : -1;
      if (cut < 0) return res.end(body);
      res.write(body.subarray(0, cut), () => setTimeout(() => res.socket.destroy(), 50));
      return;
    }
    res.writeHead(404); res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-updater-session-profile-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-updater-session-tmp-')); // TEMP of the app under test
  const layout = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-updater-session-install-'));
  const app = await electron.launch({
    args: ['--host-resolver-rules=MAP github.test 127.0.0.1, MAP release-assets.githubusercontent.com 127.0.0.1, MAP ads.doubleclick.net 127.0.0.1', ROOT],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: tmpHome, TMP: tmpHome },
  });
  try {
    await app.firstWindow();

    // ---- 1. content blocking
    const probe = (url, viaUpdater) => app.evaluate(async (electronMod, [u, up, root]) => {
      const req = process.mainModule.require('module').createRequire(`${root}/package.json`);
      try {
        let res;
        if (up) res = await (await req(`${root}/src/features/update-net.js`).createUpdateNet({ electron: electronMod, proxy: () => ({ mode: 'system' }) }).get()).fetch(u);
        else res = await electronMod.net.fetch(u);
        return `ok ${res.status} ${(await res.text()).slice(0, 20)}`;
      } catch (e) { return `ERR ${e.message}`; }
    }, [url, viaUpdater, ROOT]);
    const tracker = `http://ads.doubleclick.net:${port}/pagead/ads?x=1`;
    let blocked = '';
    for (let i = 0; i < 60 && !/BLOCKED/.test(blocked); i++) { blocked = await probe(tracker, false); if (!/BLOCKED/.test(blocked)) await sleep(250); }
    check('content blocking: the default session cancels a tracker request, so its handlers are live in this run', /ERR net::ERR_BLOCKED_BY_CLIENT/.test(blocked), blocked);
    const viaUpdater = await probe(tracker, true);
    check('content blocking: the same request through the updater session is never cancelled', /^ok 404/.test(viaUpdater), viaUpdater);
    log = []; token = 0; blobHits = 0; mode = 'plain';
    const signed = await probe(`http://github.test:${port}/releases/download/v9.9.9/${NAME}`, true);
    const blob = log.find((l) => l.path.startsWith('/blob/'));
    check('content blocking: a signed release redirect is followed with every query parameter intact', /^ok 200/.test(signed) && blob && blob.query === `?sp=r&se=2026-10-17T10%3A00%3A00Z&sig=tok1%2Babc%3D&jwt=j1&utm_source=signed`, JSON.stringify([signed, blob]));

    // ---- 2. staging against the local server
    if (process.platform !== 'win32') {
      skip('stage: the Windows staging path (bsdtar, exe check) runs on Windows only');
    } else {
      let n = 0;
      const stageRun = async (label, m, delays = [100, 100, 100, 100]) => {
        mode = m; log = []; token = 0; blobHits = 0;
        const dir = path.join(layout, `${label}-${++n}`, 'Lumen');
        fs.mkdirSync(dir, { recursive: true });
        const execPath = path.join(dir, 'Lumen.exe');
        fs.writeFileSync(execPath, 'x');
        const out = await app.evaluate(async (electronMod, [root, base, execP, name, delayList]) => {
          const req = process.mainModule.require('module').createRequire(`${root}/package.json`);
          const Z = req(`${root}/src/features/zip-update.js`);
          const net = await req(`${root}/src/features/update-net.js`).createUpdateNet({ electron: electronMod, proxy: () => ({ mode: 'system' }) }).get();
          const yml = await (await net.fetch(`${base}/latest.yml`)).text();
          const sha512 = /sha512: (\S+)/.exec(yml)[1];
          const retries = []; const progress = [];
          try {
            await Z.stage({ net, asset: { name, url: `${base}/releases/download/v9.9.9/${name}` }, version: '9.9.9', files: [{ url: name, sha512 }], execPath: execP, onRetry: (r) => retries.push(r.key), onProgress: (p) => progress.push(p), retry: { delays: delayList } });
            const st = Z.readStaged(execP, process.platform, () => null);
            return { retries, progress: progress.slice(-1), staged: st ? { version: st.version, root: st.staged.root } : null };
          } catch (e) { return { retries, error: e.message, reasonKey: e.reasonKey }; }
        }, [ROOT, `http://127.0.0.1:${port}`, execPath, NAME, delays]);
        return { ...out, dir, execPath, requests: log.filter((l) => l.path.startsWith('/blob/')) };
      };
      const stagedOk = (r) => r.staged && r.staged.version === '9.9.9' && fs.existsSync(path.join(r.staged.root, 'Lumen.exe')) && fs.statSync(path.join(r.staged.root, 'Lumen.exe')).size === exe.length && fs.readFileSync(path.join(r.staged.root, 'resources', 'app', 'new-file.js'), 'utf8') === '// new';

      const a = await stageRun('drop-resume', 'drop-resume');
      check('stage: a connection cut mid-stream is retried and the update stages', stagedOk(a) && a.retries.includes('dropped'), JSON.stringify([a.error, a.retries, a.staged]));
      check('stage: ...resumed with a Range request, on a fresh signed redirect (the first signed URL had expired)', a.requests.length === 2 && /^bytes=\d+-$/.test(a.requests[1].range) && a.requests[0].query !== a.requests[1].query && /tok2/.test(a.requests[1].query), JSON.stringify(a.requests));
      check('stage: ...and the staged exe is byte-identical to the one in the zip (sha512 held across the resume)', stagedOk(a) && crypto.createHash('sha512').update(fs.readFileSync(path.join(a.staged.root, 'Lumen.exe'))).digest('base64') === crypto.createHash('sha512').update(exe).digest('base64'), '');

      const b = await stageRun('drop-norange', 'drop-norange');
      check('stage: a server that ignores Range gets a clean second download and the update stages', stagedOk(b) && b.requests.length === 2 && b.requests[1].range !== '' , JSON.stringify([b.error, b.requests]));

      const c = await stageRun('503', '503');
      check('stage: a 503 is retried and the update stages', stagedOk(c) && c.retries.includes('server'), JSON.stringify([c.error, c.retries, c.requests, c.staged]));

      const d = await stageRun('always-drop', 'always-drop', [50, 50]);
      check('stage: a download that never completes ends with the plain reason, not a Chromium code', d.error && d.reasonKey === 'dropped' && d.retries.length === 2 && !d.staged, JSON.stringify(d));
      check('stage: ...after all its tries and nothing staged', fs.existsSync(path.join(d.dir, '..', 'Lumen.update', 'staged.json')) === false, '');
    }
  } finally {
    await app.close().catch(() => {});
    server.close();
    for (const dir of [profile, tmpHome, layout]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall updater-session checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
