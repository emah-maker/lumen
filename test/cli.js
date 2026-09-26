// Sign in with the Anthropic CLI: signed-in detection, a real install of `ant` from the official
// release (checksum-verified), and the settings UI. The browser OAuth step itself needs a person.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  // 1. Detection reads the CLI's config dir.
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-antcfg-'));
  process.env.ANTHROPIC_CONFIG_DIR = config;
  const cliAuth = require('../cli-auth');
  check('not signed in without credentials', cliAuth.profileState().signedIn === false, JSON.stringify(cliAuth.profileState()));
  fs.mkdirSync(path.join(config, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(config, 'active_config'), 'work');
  fs.writeFileSync(path.join(config, 'credentials', 'work.json'), JSON.stringify({ access_token: 'test-access-token-123', refresh_token: 'test-refresh-token-456' }));
  const state = cliAuth.profileState();
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
  await ui.evaluate(() => { document.getElementById('toggle-sidebar').click(); });
  await ui.waitForTimeout(500);
  await ui.evaluate(() => document.getElementById('open-settings').click());
  await ui.waitForTimeout(600);
  check('signed out: "Sign in with Anthropic" is offered', await ui.isVisible('#cli-login') && !(await ui.isVisible('#cli-logout')), 'buttons wrong');
  check('signed out: status explains the next step', /sign in/i.test(await ui.textContent('#cli-status')), await ui.textContent('#cli-status'));
  await app.close();

  app = await run(config);
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => { document.getElementById('toggle-sidebar').click(); });
  await ui.waitForTimeout(500);
  await ui.evaluate(() => document.getElementById('open-settings').click());
  await ui.waitForTimeout(600);
  check('signed in: shows the profile and Sign out', (await ui.textContent('#cli-status')).includes('"work"') && await ui.isVisible('#cli-logout'), await ui.textContent('#cli-status'));
  await app.close();

  fs.rmSync(bin, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
