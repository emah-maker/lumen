// [hang recorder] In the app, hidden (LUMEN_TEST_BACKGROUND=1): a block of the main process is named in <userData>/diagnostics/hangs.jsonl
// (features/hang-recorder.js), and ordinary use writes nothing.
//   - tabs opened, the sidebar toggled, the main process answering: no hangs.jsonl, no line
//   - mark('test:block') busy for 2.5 s: one line, durationMs >= 2000, 'test:block' in open (and in slow), only labels in it
//   - an ipcMain.on handler busy for 3.7 s: a provisional line appears while main is still stuck, names 'ipc:test:block-on', and the final
//     line (same id) replaces it, so the file holds one line for the hang
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path'); const fs = require('fs'); const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-hangrec-'));
  const file = path.join(profile, 'diagnostics', 'hangs.jsonl');
  const lines = () => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    check('the recorder is installed and exposed for tests', await app.evaluate(() => typeof global.__hangRecorder?.mark === 'function'), 'no global.__hangRecorder');
    // The recorder's heartbeat and worker start after the first window loads: wait until they run.
    await sleep(1500);

    // ---- ordinary use writes nothing
    for (let i = 0; i < 3; i++) await ui.keyboard.press('Control+t').catch(() => {});
    await ui.click('#toggle-sidebar'); await sleep(700); await ui.click('#toggle-sidebar'); await sleep(700);
    await sleep(2500);
    check('normal use (tabs, sidebar) writes no line', lines().length === 0 && !fs.existsSync(file), JSON.stringify(lines()));

    // ---- a block named by mark()
    const t0 = Date.now();
    await app.evaluate(() => global.__hangRecorder.mark('test:block', () => { const e = Date.now() + 2500; while (Date.now() < e); }));
    check('the block took about 2.5 s (the test did stall main)', Date.now() - t0 >= 2400, Date.now() - t0);
    const one = await waitFor(() => lines().find((l) => l.open?.includes('test:block')), 6000);
    check('hangs.jsonl names test:block, durationMs >= 2000', Boolean(one) && one.durationMs >= 2000 && one.durationMs < 4500, JSON.stringify(lines()));
    check('...as an unfinished breadcrumb and as a slow one', Boolean(one) && one.open.includes('test:block') && (one.slow || []).some((e) => e.l === 'test:block'), JSON.stringify(one));
    check('...with the version, a time, and no provisional mark on the final line', Boolean(one) && typeof one.v === 'string' && one.v.length > 0 && !Number.isNaN(Date.parse(one.time)) && !one.provisional, JSON.stringify(one));
    check('...and only fixed labels (no URLs or titles)', Boolean(one) && JSON.stringify(one).indexOf('://') < 0 && one.recent.every((e) => /^[\w:.\- /?]+$/.test(e.l)), JSON.stringify(one && one.recent));
    check('the recent breadcrumbs include real handler names', Boolean(one) && one.recent.some((e) => /^(ipc|win|app):/.test(e.l) || e.l === 'layout' || e.l === 'sendTabs'), JSON.stringify(one && one.recent));
    check('exactly one line so far', lines().length === 1, lines().length);

    // ---- an ipcMain handler that blocks: provisional at 3 s while main is stuck, replaced by the final line
    await app.evaluate(({ ipcMain }) => { ipcMain.on('test:block-on', () => { const e = Date.now() + 3700; while (Date.now() < e); }); });
    const pending = app.evaluate(({ ipcMain }) => { ipcMain.emit('test:block-on', {}); return 1; });
    const prov = await waitFor(() => lines().find((l) => l.provisional), 9000);
    check('a provisional line is written at 3 s, while main is still blocked', Boolean(prov) && prov.durationMs >= 3000 && prov.open.includes('ipc:test:block-on'), JSON.stringify(lines()));
    await pending;
    const fin = await waitFor(() => lines().find((l) => !l.provisional && l.open?.includes('ipc:test:block-on')), 6000);
    check('the final line replaces it: same id, durationMs >= 3500, one line for the hang', Boolean(fin) && Boolean(prov) && fin.id === prov.id && fin.durationMs >= 3500 && lines().length === 2 && !lines().some((l) => l.provisional), JSON.stringify(lines()));

    // ---- and the app still works afterwards
    check('the main process answers after the hangs', (await app.evaluate(() => 1)) === 1, '');
    await sleep(1500);
    check('no extra line after the hangs ended', lines().length === 2, JSON.stringify(lines()));
  } catch (err) {
    failures++;
    console.log(`FAIL  test crashed -> ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nall passed');
})();
