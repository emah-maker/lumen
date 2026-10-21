// Hidden run: the Meeting helper button loads meeting.js / meeting.css and shows the panel.
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
(async () => {
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lumen-meeting-open-'));
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  let ok = true;
  const check = (label, pass, detail = '') => { if (!pass) ok = false; console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  -> ${detail}`}`); };
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    check('meeting.js is not loaded at startup', await ui.evaluate(() => !window.meetingUi));
    await ui.evaluate(() => document.getElementById('meeting-btn').click());
    await ui.waitForFunction(() => window.meetingUi && !document.getElementById('meeting-panel').hidden, null, { timeout: 15000 }).catch(() => {});
    const st = await ui.evaluate(() => ({ loaded: Boolean(window.meetingUi), shown: !document.getElementById('meeting-panel').hidden, css: [...document.styleSheets].some((s) => /meeting\.css/.test(s.href || '')) }));
    check('clicking Meeting helper loads it and shows the panel', st.loaded && st.shown, JSON.stringify(st));
    check('its stylesheet is loaded', st.css, JSON.stringify(st));
    await ui.evaluate(() => document.getElementById('meeting-btn').click());
    check('a second click closes it', await ui.evaluate(() => document.getElementById('meeting-panel').hidden));
  } finally { await app.close(); }
  process.exit(ok ? 0 : 1);
})();
