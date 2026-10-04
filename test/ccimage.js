// Claude Code (full access) making a picture with its own tools, in the real app with a fake `claude` CLI and a throwaway
// profile and home folder: the CLI's stream has a Bash tool call that runs a (fake) image CLI, then a reply naming the file.
// Full access on: no "can't make pictures" notice, and the picture the run wrote is shown in the chat (and kept with it);
// a picture that was already there, one outside the home folder and a fake one (SVG bytes) are not; "/image …" arrives as
// words. Full access off: the notice, now saying what to do, and nothing from the reply's paths is shown.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FAKE = `
const fs = require('fs');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type !== 'user') continue;
    const text = msg.message.content.map((c) => c.text || '').join('\\n');
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), text }) + '\\n');
    const dir = process.env.FAKE_OUT_DIR;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_G', name: 'Bash', input: { command: 'grok --cwd "' + dir + '" --permission-mode acceptEdits --allow image_gen --sandbox workspace -p "Use image_gen: a small blue paper plane icon. Do not run any other tool."', description: 'Draw the picture with grok' } }] } });
    setTimeout(() => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dir + '/plane.png', png); // written during the run
      fs.writeFileSync(dir + '/fake.png', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_G', content: 'ok' }] } });
      const reply = 'Here it is: ' + dir + '/plane.png (also ' + process.env.FAKE_OLD + ', ' + process.env.FAKE_OUTSIDE + ' and ' + dir + '/fake.png)';
      out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: 'sess-1', total_cost_usd: 0, usage: {} });
    }, 300);
  }
});
`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ccimg-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, 'Pictures'), { recursive: true });
  const elsewhere = path.join(root, 'elsewhere'); fs.mkdirSync(elsewhere);
  const fake = path.join(root, 'fake-claude.js'); fs.writeFileSync(fake, FAKE);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const oldPic = path.join(home, 'Pictures', 'old.png'); fs.writeFileSync(oldPic, png); fs.utimesSync(oldPic, new Date(Date.now() - 86400e3), new Date(Date.now() - 86400e3));
  const outsidePic = path.join(elsewhere, 'new.png'); fs.writeFileSync(outsidePic, png);
  const outDir = path.join(home, 'Pictures', 'out');
  const log = path.join(root, 'fake.log');

  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_CLAUDE_BIN: fake, FAKE_LOG: log, FAKE_OUT_DIR: outDir, FAKE_OLD: oldPic, FAKE_OUTSIDE: outsidePic },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The fake CLI stands in for `claude` (run as Node), and the user's home folder is the throwaway one.
  await app.evaluate((_e, { fakePath, fakeHome }) => {
    const { spawn } = process.mainModule.require('child_process');
    const os = process.mainModule.require('os');
    os.homedir = () => fakeHome;
    const cc = global.__agent.engines.claudecode;
    cc.bin = fakePath;
    cc.spawn = (bin, argv, opts) => spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' } });
  }, { fakePath: fake, fakeHome: home });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(500);
  let ids = [];
  for (let i = 0; i < 20 && !ids.includes('claudecode:default'); i++) { await sleep(300); ids = await ui.$$eval('#model option', (os) => os.map((o) => o.value)); }
  check('the picker offers Claude Code (the fake CLI is found)', ids.includes('claudecode:default'), J(ids));
  await ui.selectOption('#model', 'claudecode:default');
  const send = async (text) => {
    await ui.fill('#prompt', text);
    await ui.press('#prompt', 'Enter');
    await sleep(300);
    await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 20000 });
  };
  const notices = () => ui.evaluate(() => [...document.querySelectorAll('#messages .notice')].map((n) => n.textContent));
  const pics = () => ui.evaluate(() => document.querySelectorAll('#messages .gen-img img').length);
  const lastRun = () => { const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); return lines[lines.length - 1]; };

  // ---- full access on
  await app.evaluate(() => global.__settings.backend.set('claudeCodeFullAccess', true));
  await send('draw a small blue paper plane icon');
  const first = lastRun();
  check('full access: Claude Code runs in the home folder with its own tools (bypassPermissions, no tool lockdown)', fs.realpathSync(first.cwd) === fs.realpathSync(home) && first.argv.includes('bypassPermissions') && !first.argv.includes('--tools'), J(first));
  check('full access: the system prompt tells it how to make a picture and name the file', /append-system-prompt/.test(first.argv.join(' ')) && /full path/.test(first.argv[first.argv.indexOf('--append-system-prompt') + 1] || ''), first.argv.join(' ').slice(0, 200));
  check('full access: no "can\'t make pictures" notice', !(await notices()).some((n) => /can't make pictures/.test(n)), J(await notices()));
  check('full access: the shell step is shown', await ui.evaluate(() => /Draw the picture with grok/.test(document.getElementById('messages').textContent)), 'no step');
  check('full access: exactly the picture written during the run is shown (not the old file, the one outside home, or the SVG)', (await pics()) === 1, String(await pics()));
  const shown = await ui.evaluate(() => { const i = document.querySelector('.gen-img img'); return i && { ok: i.complete && i.naturalWidth === 1, src: i.src.slice(0, 22) }; });
  check('it is a decoded PNG from a data URL', shown?.ok && shown.src === 'data:image/png;base64,', J(shown));
  const stored = fs.readdirSync(path.join(profile, 'generated-images'), { recursive: true }).filter((f) => f.endsWith('.img'));
  check('it is kept with the chat in the image store', stored.length === 1, J(stored));

  await send('/image a paper plane');
  check('full access: "/image a paper plane" reaches the CLI as words', /Generate an image: a paper plane/.test(lastRun().text) && !/(^|\n)\/image/.test(lastRun().text), lastRun().text.slice(0, 300));
  check('full access: still no notice after /image', !(await notices()).some((n) => /can't make pictures/.test(n)), J(await notices()));

  // ---- full access off
  await ui.click('#new-chat');
  await sleep(400);
  await app.evaluate(() => global.__settings.backend.set('claudeCodeFullAccess', false));
  await ui.selectOption('#model', 'claudecode:default');
  const before = await pics();
  await send('draw a small blue paper plane icon');
  const off = await notices();
  check('full access off: the notice says what to do', off.some((n) => /can't make pictures/.test(n) && /full access/.test(n) && /Settings > AI/.test(n) && /model menu/.test(n)), J(off));
  check('full access off: the run is the locked-down one, and its reply\'s paths show nothing', lastRun().argv.includes('dontAsk') && lastRun().argv.includes('--tools') && (await pics()) === 0 && before >= 0, J(lastRun().argv));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function J(v) { return JSON.stringify(v); }
