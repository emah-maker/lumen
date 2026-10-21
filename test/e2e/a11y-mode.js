// [a11y mode] Accessibility switched on by another program (a password manager's desktop app, Phone Link) must not let a big page stall
// the main process (features/a11y-mode.js). In the app, hidden (LUMEN_TEST_BACKGROUND=1), on a 50,000-element page with iframes that
// re-renders on resize: another program turns accessibility on (app.setAccessibilitySupportEnabled(true), what Chromium does when a
// UI Automation client asks), then the page takes focus, the sidebar opens and closes; the main process must keep answering.
//   - auto, no screen reader: cut down to nativeAPIs, the main process never stalls (it did for 1.5 to 1.8 s per change)
//   - auto, a screen reader running: the full set stays
//   - Settings "On": full; "Off": nothing; back to Automatic: cut down again
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };
const PAGE = `<!doctype html><title>Big page</title><body><form>${'<input type=email name=e><input type=password name=p>'.repeat(10)}</form><div id=app></div><script>
const app = document.getElementById('app');
function build() { const f = document.createDocumentFragment(); for (let i = 0; i < 2000; i++) { const d = document.createElement('div'); for (let j = 0; j < 25; j++) { const s = document.createElement('span'); s.textContent = 'item ' + i + '.' + j; d.appendChild(s); } f.appendChild(d); } app.replaceChildren(f); }
build();
for (let k = 0; k < 25; k++) { const fr = document.createElement('iframe'); fr.srcdoc = '<body>' + '<p>x</p>'.repeat(500) + '</body>'; document.body.appendChild(fr); }
addEventListener('resize', build);
</script></body>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-a11ymode-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `http://127.0.0.1:${server.address().port}/big`);
    await sleep(3000);
    const features = () => app.evaluate(({ app: a }) => a.getAccessibilitySupportFeatures());
    const setPref = (v) => app.evaluate((_e, val) => global.__settings.backend.set('screenReaderSupport', val), v);
    // Another program asks for accessibility (what Chromium does for a UI Automation client).
    const otherProgramAsks = () => app.evaluate(({ app: a }) => a.setAccessibilitySupportEnabled(true));
    const mainLag = async (ms) => { let max = 0; const end = Date.now() + ms; while (Date.now() < end) { const a = Date.now(); await app.evaluate(() => 1); max = Math.max(max, Date.now() - a); await sleep(40); } return max; };
    const focusPage = () => app.evaluate(({ webContents }) => { const t = global.__windows.list()[0].tabs[0]; const wc = webContents.fromId(t.contentsId); wc.focus(); wc.executeJavaScript("document.querySelector('input').focus()"); });
    const workout = async () => {
      let worst = 0;
      await focusPage(); worst = Math.max(worst, await mainLag(1200));
      await ui.click('#prompt').catch(() => {}); worst = Math.max(worst, await mainLag(600));
      await ui.click('#toggle-sidebar'); worst = Math.max(worst, await mainLag(1500));
      await focusPage(); worst = Math.max(worst, await mainLag(1200));
      await ui.click('#toggle-sidebar'); worst = Math.max(worst, await mainLag(1500));
      return worst;
    };
    const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

    check('the setting defaults to Automatic', (await app.evaluate(() => global.__settings.backend.prefs?.().screenReaderSupport ?? 'auto')) === 'auto', 'not auto');
    await app.evaluate(() => { global.__a11yScreenReader = false; });
    await otherProgramAsks();
    const cut = await waitFor(async () => same(await features(), ['nativeAPIs']));
    check('auto, no screen reader: accessibility another program asked for is kept to nativeAPIs', cut, JSON.stringify(await features()));
    const lagAuto = await workout();
    check(`...and the main process keeps answering through focus changes and the sidebar (worst ${lagAuto} ms, was 1500+)`, lagAuto < 400, lagAuto);
    await mainLag(300);
    await app.evaluate(() => { global.__a11yScreenReader = true; });
    await app.evaluate(({ app: a }) => { a.setAccessibilitySupportFeatures([]); });
    await otherProgramAsks();
    const full = await waitFor(async () => (await features()).includes('webContents'));
    check('auto, a screen reader running: the full set stays', full, JSON.stringify(await features()));
    await app.evaluate(() => { global.__a11yScreenReader = false; });
    await setPref('off');
    check('Off: nothing', await waitFor(async () => (await features()).length === 0), JSON.stringify(await features()));
    await setPref('on');
    check('On: the full set', await waitFor(async () => (await features()).includes('webContents')), JSON.stringify(await features()));
    await setPref('auto');
    check('back to Automatic (no screen reader): cut down again', await waitFor(async () => same(await features(), ['nativeAPIs'])), JSON.stringify(await features()));
    const pure = require('../../src/features/a11y-mode');
    check('decide: nothing asked for -> leave it', pure.decide({ mode: 'auto', enabled: false, screenReader: false }) === null);
    check('decide: off -> []', JSON.stringify(pure.decide({ mode: 'off', enabled: true, screenReader: true })) === '[]');
    check('decide: on or a screen reader -> full', pure.decide({ mode: 'on', enabled: true, screenReader: false }) === 'full' && pure.decide({ mode: 'auto', enabled: true, screenReader: true }) === 'full');
    check('the probe never runs on the main thread (execFile, hidden)', /execFile\('powershell\.exe'/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'features', 'a11y-mode.js'), 'utf8')) && !/Sync\(/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'features', 'a11y-mode.js'), 'utf8')));
  } finally {
    await app.close().catch(() => {});
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}
  }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
