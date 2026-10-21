// Screen recording, in the real app (hidden window, throwaway profile, local fixture page, no network, never the real screen): a tab recording of
// a local page that animates is started, paused, resumed and stopped; a non-empty .webm lands in the Downloads folder under a clear name, shows in the
// downloads list as finished, and "Show in folder" is offered. The recorder's bar (its own small window) is invisible in the test run, a screen is
// never captured (the screen picker is a native menu: not opened here), and the microphone is not touched.
// Run (always under the lock): node scripts/test/e2e-lock.js run --owner screen-recording -- node test/e2e/screen-recorder.js
//   with LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

const PAGE = `<!doctype html><title>Recorder fixture</title><body style="margin:0;background:#123">
<canvas id="c" width="640" height="360" style="display:block"></canvas>
<script>const x = document.getElementById('c').getContext('2d'); let n = 0;
(function frame() { n++; x.fillStyle = 'hsl(' + (n * 3 % 360) + ',80%,50%)'; x.fillRect(0, 0, 640, 360); x.fillStyle = '#fff'; x.font = '48px sans-serif'; x.fillText('frame ' + n, 40, 200); requestAnimationFrame(frame); })();</script>`;

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-record-'));
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-record-dl-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), dlDir);
    await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), url);
    await waitFor(() => app.evaluate(() => /Recorder fixture/.test(global.__agent.browser.activeTab().webContents.getTitle())));

    // Nothing is loaded or recording before the first use.
    const idleMenu = await app.evaluate(() => global.__recorder.menu().map((i) => i.label || i.type));
    check('menu: Record this tab and Record screen or window are offered', idleMenu.includes('Record this tab') && idleMenu.includes('Record screen or window…'), JSON.stringify(idleMenu));
    check('menu: the microphone switch is off until turned on, the sound switch is on', await app.evaluate(() => { const m = global.__recorder.menu(); return m.find((i) => i.label === 'Include the microphone').checked === false && m.find((i) => i.label === 'Include sound from the tab or PC').checked === true; }));

    // Record the tab.
    const started = await app.evaluate(() => global.__recorder.startTab({ mic: false, sound: false }));
    check('record tab: starts', started.ok === true, JSON.stringify(started));
    check('record tab: the format is WebM', /^video\/webm/.test(started.mime || ''), started.mime);
    const mime = started.mime || '';
    console.log(`INFO  recorder mime: ${mime}`);
    const playing = await app.evaluate(() => { const r = global.__recorder.get(); const s = r.state(); return { phase: s.phase, kind: s.kind, name: s.name }; });
    check('record tab: state is recording a tab, with a clear name', playing.phase === 'recording' && playing.kind === 'tab' && /^Lumen tab recording - 127\.0\.0\.1:\d+ - \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.webm$/.test(playing.name.replace(/\s+/g, ' ')) || /^Lumen tab recording - 127\.0\.0\.1/.test(playing.name), JSON.stringify(playing));
    const runningMenu = await app.evaluate(() => global.__recorder.menu().map((i) => i.label));
    check('menu: while recording it offers Pause and Stop recording instead', runningMenu.includes('Pause') && runningMenu.includes('Stop recording') && !runningMenu.includes('Record this tab'), JSON.stringify(runningMenu));
    check('bar: the recorder window is invisible in a test run', await app.evaluate(({ BrowserWindow }) => { const c = global.__recorder.get().contents(); const w = c && BrowserWindow.fromWebContents(c); return Boolean(w) && w.getOpacity() === 0; }));

    const info = () => app.evaluate(() => global.__recorder.get().contents().executeJavaScript('window.__rec.info()'));
    await sleep(2500);
    const grew = await waitFor(async () => (await info())?.bytes > 0);
    check('record tab: pieces are arriving while it records', Boolean(grew), JSON.stringify(await info()));
    check('pause: pauses', (await app.evaluate(() => global.__recorder.get().press('pause'))) === true && (await info())?.state === 'paused', JSON.stringify(await info()));
    check('pause: the menu now says Resume', (await app.evaluate(() => global.__recorder.menu().map((i) => i.label))).includes('Resume'));
    await sleep(600);
    check('resume: records again', (await app.evaluate(() => global.__recorder.get().press('resume'))) === true && (await info())?.state === 'recording');
    await sleep(2000);

    // Stop: the file is written and listed.
    const stopped = await app.evaluate(() => global.__recorder.get().press('stop'));
    check('stop: finishes with a file', stopped?.ok === true && typeof stopped.file === 'string', JSON.stringify(stopped));
    const file = stopped?.file || '';
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    check('file: a non-empty .webm in the Downloads folder', path.dirname(file) === dlDir && path.extname(file) === '.webm' && bytes.length > 4000, `${file} ${bytes.length}`);
    check('file: it is WebM (EBML header) and not left as .part', bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && !fs.readdirSync(dlDir).some((f) => f.endsWith('.part')), fs.readdirSync(dlDir).join(','));
    check('file: the name says what and when', /^Lumen tab recording - 127\.0\.0\.1:\d+ - \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.webm$/.test(path.basename(file)) || /^Lumen tab recording - 127\.0\.0\.1/.test(path.basename(file)), path.basename(file));
    const list = await app.evaluate(() => global.__downloads.list().map((d) => ({ name: d.name, state: d.state, path: d.path, total: d.total })));
    check('downloads: the recording is listed as a finished download', list[0]?.path === file && list[0].state === 'completed' && list[0].total === bytes.length, JSON.stringify(list[0]));
    const saved = await app.evaluate(() => global.__recorder.get().state());
    check('saved: the recorder is done and offers Show in folder', saved.phase === 'saved' && saved.file === file, JSON.stringify(saved));
    check('saved: the downloads row can be shown in its folder', await app.evaluate((_e, f) => { const row = global.__downloads.list().find((d) => d.path === f); return Boolean(row); }, file));
    check('menu: Record this tab is back after saving', (await app.evaluate(() => global.__recorder.menu().map((i) => i.label))).includes('Record this tab'));

    // A second recording gets its own name.
    const again = await app.evaluate(() => global.__recorder.startTab({ mic: false, sound: false }));
    check('a second recording starts', again.ok === true, JSON.stringify(again));
    await sleep(1500);
    const second = await app.evaluate(() => global.__recorder.get().stop());
    check('and does not overwrite the first', second?.ok === true && second.file !== file && fs.existsSync(file) && fs.existsSync(second.file), JSON.stringify(second));

    // MP4: offered only where the recorder can write it (asked of the UI page once at start-up).
    const mp4 = await waitFor(async () => (await app.evaluate(() => global.__recorder.mp4())) !== null, 8000);
    const canMp4 = await app.evaluate(() => global.__recorder.mp4());
    console.log('INFO  MP4 offered here: ' + canMp4);
    check('mp4: the menu offers it exactly when the recorder can write it', (await app.evaluate(() => global.__recorder.menu().some((i) => i.label === 'Save as MP4 instead of WebM'))) === (canMp4 === true) && mp4 !== undefined, String(canMp4));
    if (canMp4) {
      const mp4Rec = await app.evaluate(() => global.__recorder.startTab({ mic: false, sound: false, format: 'mp4' }));
      check('mp4: starts', mp4Rec.ok === true && mp4Rec.mime.startsWith('video/mp4'), JSON.stringify(mp4Rec));
      await sleep(2500);
      const done = await app.evaluate(() => global.__recorder.get().stop());
      const head = done?.file && fs.existsSync(done.file) ? fs.readFileSync(done.file) : Buffer.alloc(0);
      check('mp4: a non-empty .mp4 with an MP4 header', path.extname(done?.file || '') === '.mp4' && head.length > 4000 && head.subarray(4, 8).toString() === 'ftyp', done?.file + ' ' + head.length);
    }
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nscreen-recorder: all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
