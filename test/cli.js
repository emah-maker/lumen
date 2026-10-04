// Sign in with the Anthropic CLI: signed-in detection, a real install of `ant` from the official
// release (checksum-verified), and the settings UI. The browser OAuth step itself needs a person.
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('./settings-tab');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  // 1. Detection reads the CLI's config dir.
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-antcfg-'));
  process.env.ANTHROPIC_CONFIG_DIR = config;
  const cliAuth = require('../src/ai/cli-auth');
  check('not signed in without credentials', cliAuth.profileState().signedIn === false, JSON.stringify(cliAuth.profileState()));
  fs.mkdirSync(path.join(config, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(config, 'active_config'), 'work');
  fs.writeFileSync(path.join(config, 'credentials', 'work.json'), JSON.stringify({ access_token: 'test-access-token-123', refresh_token: 'test-refresh-token-456' }));
  const state = cliAuth.freshProfileState(); // profileState() is kept for 2s; a new sign-in shows after that
  check('signed in when the active profile has credentials', state.signedIn === true && state.profile === 'work', JSON.stringify(state));

  // 2. A real install into a throwaway folder.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-antbin-'));
  let installed = null;
  try {
    installed = await cliAuth.installAnt(bin);
  } catch (err) {
    check('installs the Anthropic CLI', false, err.message);
  }
  if (installed) check('installs the Anthropic CLI (checksum verified, runs)', fs.existsSync(installed), installed);
  const found = await cliAuth.findAnt(bin);
  check('finds the installed CLI', found === installed, found);

  // 3. Settings UI: the button and status line, signed out and signed in.
  const run = (cfg) => electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', ANTHROPIC_CONFIG_DIR: cfg } });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-antcfg-empty-'));
  let app = await run(empty);
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  let inSettings = await openSettingsTab(app);
  await ui.waitForTimeout(800);
  let cli = await inSettings("({ button: document.getElementById('ai-cli-button')?.textContent, status: document.getElementById('ai-cli-status')?.textContent })");
  check('signed out: "Sign in" is offered', cli.button === 'Sign in', JSON.stringify(cli));
  check('signed out: status explains the next step', /sign-in|not signed in/i.test(cli.status), cli.status);
  await app.close();

  app = await run(config);
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  inSettings = await openSettingsTab(app);
  await ui.waitForTimeout(800);
  cli = await inSettings("({ button: document.getElementById('ai-cli-button')?.textContent, status: document.getElementById('ai-cli-status')?.textContent })");
  check('signed in: shows the profile and Sign out', cli.status.includes('“work”') && cli.button === 'Sign out', JSON.stringify(cli));
  await app.close();

  fs.rmSync(bin, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
