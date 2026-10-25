// "Connect Claude Code" in one click, in the real app (Settings > AI > "Let other apps use Lumen", and the Allow prompt of a token-less Claude Code).
// A fake `claude` (a tiny Node script that records its arguments) and temp config files stand in for the real CLI and the real configs: nothing outside the
// temp profile is touched.
//   - Settings: Connect Claude Code makes the claude-code token app and runs `mcp remove` / `mcp add --scope user ... LUMEN_CLIENT_TOKEN_FILE=<file>`; it says what to do next
//   - a second click reuses the same app; a missing CLI says so and shows the command to copy
//   - a token-less Claude Code's Allow prompt offers "Set up Claude Code's key" (and only that app's does), and the button runs the same setup
//   - Cursor: only the "lumen" entry of its user config is edited, the old file is kept as .bak
// LUMEN_SHOT_DIR: where the before/after PNGs go (default: the temp folder).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('../helpers/settings-tab');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-lumen-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-fake-'));
  const shots = process.env.LUMEN_SHOT_DIR || os.tmpdir();
  const log = path.join(fakeDir, 'calls.jsonl');
  const fakeJs = path.join(fakeDir, 'fake-claude.js');
  fs.writeFileSync(fakeJs, `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cursorDir = path.join(fakeDir, '.cursor');
  fs.mkdirSync(cursorDir);
  const cursorFile = path.join(cursorDir, 'mcp.json');
  const cursorBefore = JSON.stringify({ mcpServers: { other: { command: 'node', args: ['x.js'] } }, keep: true }, null, 2);
  fs.writeFileSync(cursorFile, cursorBefore);

  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const errors = [];
  try {
    const ui = await app.firstWindow();
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await sleep(500);
    await app.evaluate((_e, [js, cursor]) => {
      global.__externalStrict = true;
      global.__externalConnectSeams = { claude: { command: process.execPath, args: [js], env: { ELECTRON_RUN_AS_NODE: '1' } }, configPath: (k) => (k === 'cursor' ? cursor : null) };
    }, [fakeJs, cursorFile]);
    const info = () => app.evaluate(() => global.__externalApps.info());
    const shot = async (name, run) => {
      if (run) await run("document.querySelector('#ea-setup')?.scrollIntoView({ block: 'center' })");
      await sleep(400); // (let the frame paint before it is captured)
      const b64 = run
        ? await app.evaluate(async (_e, id) => { const wc = global.__settings.contents(id); wc.invalidate(); await new Promise((r) => setTimeout(r, 300)); return (await wc.capturePage()).toPNG().toString('base64'); }, run.id)
        : await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(shots, name), Buffer.from(b64, 'base64'));
    };

    const inSettings = await openSettingsTab(app, 'external-apps');
    await waitFor(() => inSettings("document.querySelector('#ea-status')?.textContent !== ''"));
    await inSettings("[...document.querySelectorAll('#ea-setup [role=tab]')].find((b) => b.textContent === 'Claude Code').click()");
    check('the Claude Code tab has a Connect button', (await inSettings("document.querySelector('#ea-connect')?.textContent")) === 'Connect Claude Code', await inSettings("document.querySelector('#ea-connect')?.textContent"));
    await shot('connect-before-settings.png', inSettings);

    // ---- Connect Claude Code
    await inSettings("document.querySelector('#ea-connect').click()");
    const said = await waitFor(async () => { const t = await inSettings("document.querySelector('#ea-connect-note')?.textContent || ''"); return /connected with its own key/.test(t) ? t : null; });
    check('the note says Claude Code is connected with its own key and what to do next', /Restart Claude Code sessions \(or \/mcp, then Reconnect\)/.test(said || ''), said);
    const i1 = await info();
    const cc = i1.apps.find((a) => a.app === 'claude-code');
    const tokenFile = cc && (await app.evaluate((_e, id) => global.__externalApps.tokenFile(id), cc.id));
    check('the claude-code token app exists, with a token file in the profile; Lumen is on', Boolean(cc) && cc.kind === 'token' && tokenFile.startsWith(path.join(profile, 'external-app-tokens')) && fs.existsSync(tokenFile) && i1.enabled, JSON.stringify(i1.apps));
    const c1 = calls();
    check('the CLI got `mcp remove lumen --scope user`, then `mcp add lumen --scope user` with the token file', c1.length === 2 && c1[0].join(' ') === 'mcp remove lumen --scope user' && c1[1].slice(0, 5).join(' ') === 'mcp add lumen --scope user' && c1[1].includes(`LUMEN_CLIENT_TOKEN_FILE=${tokenFile}`) && c1[1].includes('--') && !c1.flat().some((a) => /project/.test(a)), JSON.stringify(c1));
    check('the shown command names the same file (and no secret)', (await inSettings("document.querySelector('#ea-snippet').textContent")).includes(tokenFile));
    await shot('connect-after-settings.png', inSettings);
    await inSettings("document.querySelector('#ea-connect').click()");
    await waitFor(() => calls().length === 4);
    check('a second click reuses the same app (still one claude-code app)', (await info()).apps.filter((a) => a.app === 'claude-code').length === 1 && calls().length === 4);

    // ---- the Allow prompt of a token-less Claude Code
    await inSettings("window.lumenSettings.ai.externalApps.setRequireToken(false)"); // (tokens are required after the first switch-on: this is a user who kept token-less clients)
    const ask = (name) => app.evaluate(async (_e, n) => {
      const s = { clientName: n, engine: null, controller: new AbortController(), disconnect() {} };
      await global.__externalApps.ext.admit(s, {}, { defer: true });
      global.__externalApps.ext.admitForCall(s);
      return true;
    }, name);
    await ask('claude-code');
    check('the toolbar prompt offers "Set up Claude Code’s key"', await waitFor(() => ui.$('#external-bar .external-setup-key')), 'no button');
    check('...for the client named claude-code', /claude-code/.test(await ui.$eval('#external-bar', (e) => e.textContent)), await ui.$eval('#external-bar', (e) => e.textContent));
    await shot('connect-before-prompt.png');
    await ui.click('#external-bar .external-setup-key');
    const done = await waitFor(async () => { const t = await ui.$eval('#external-bar .external-setup-key', (e) => e.textContent); return /Key set/.test(t) ? t : null; });
    check('the button runs the same setup and says to restart Claude Code', done === 'Key set. Restart Claude Code.' && calls().length === 6, `${done} ${calls().length}`);
    await shot('connect-after-prompt.png');
    await ui.click('#external-bar button.primary'); // Allow this time
    check('Settings lists the token-less Claude Code with the same offer', await waitFor(() => inSettings("Boolean(document.querySelector('.ea-app .ea-setup-key'))")), 'no button in the list');
    await app.evaluate(async () => { global.__externalApps.ext.state().prompts.forEach((p) => global.__externalApps.ext.answer(p.id, 'deny')); });
    await ask('Fake App');
    check('another app’s prompt does not', await waitFor(() => ui.$eval('#external-bar', (e) => /Fake App/.test(e.textContent) && !e.querySelector('.external-setup-key'))), 'button on another app');

    // ---- Cursor: only its "lumen" entry
    const r = await inSettings("window.lumenSettings.ai.externalApps.connect('cursor')");
    const now = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    check('Cursor: ok, the other entry and the other keys are untouched, "lumen" names its token file', r.ok && now.keep === true && now.mcpServers.other.command === 'node' && Object.keys(now.mcpServers).join() === 'other,lumen' && /external-app-tokens/.test(now.mcpServers.lumen.env.LUMEN_CLIENT_TOKEN_FILE), JSON.stringify([r, now]).slice(0, 300));
    check('...and the old file is kept as .bak', fs.readFileSync(`${cursorFile}.bak`, 'utf8') === cursorBefore);
    const none = await inSettings("window.lumenSettings.ai.externalApps.connect('vscode')");
    check('an app whose config the test did not point at is not touched (no real file)', none.ok === false && /Copy the text below|doesn’t know/.test(none.error || ''), JSON.stringify(none));
    check('no page errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
