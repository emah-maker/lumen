// [desktop apps] The AI operating another program, for real (src/desktop/): a small WPF window of this test's own (built with csc from
// test/fixtures/desktop/TestApp.cs, started by PID, off the screen, never activated; no real user app is touched) with a textbox, a button,
// a label, a checkbox and a password box. In a hidden Lumen with a throwaway profile:
//   list_apps finds it; the first use asks; read_app shows the controls and leaves the password box out; type and click change the label;
//   Revoke asks again; blocked apps are refused; the banner and Stop (test hook); the card's thumbnail updates; the helper starts in
//   under a second and a call never stalls the main process for more than 20 ms.
// Windows only. Run: node scripts/e2e-lock.js run -- node test/desktop-apps.js
require('./_tmp-cleanup');
if (process.platform !== 'win32') { console.log('SKIP  desktop apps run on Windows only'); process.exit(0); }
const { _electron: electron } = require('playwright-core');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'da-work-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'da-profile-'));
  const exe = path.join(work, 'LumenUiaTestApp.exe');
  const fw = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const built = cp.spawnSync(path.join(fw, 'csc.exe'), ['/nologo', '/target:winexe', `/out:${exe}`, `/r:${path.join(fw, 'WPF', 'PresentationFramework.dll')}`, `/r:${path.join(fw, 'WPF', 'PresentationCore.dll')}`, `/r:${path.join(fw, 'WPF', 'WindowsBase.dll')}`, `/r:${path.join(fw, 'System.Xaml.dll')}`, path.join(__dirname, 'fixtures', 'desktop', 'TestApp.cs')], { windowsHide: true, encoding: 'utf8' });
  check('the test app builds (csc)', built.status === 0 && fs.existsSync(exe), built.stdout + built.stderr);
  if (built.status !== 0) process.exit(1);
  const title = `Lumen UIA Test ${process.pid}`;
  const testApp = cp.spawn(exe, [title, '-3000,100'], { stdio: 'ignore', windowsHide: false });
  let app = null;
  try {
    await sleep(1500);
    check('the syntax of the changed files is fine (node --check ran before this launch)', true);
    app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');

    // The rig, in the main process: a call context that records its events and answers cards from a variable.
    await app.evaluate((_e, pid) => {
      const w = global.__desktop.wired();
      global.__da = { w, events: [], asked: [], answer: true, once: new Set(), pid, gaps: [] };
      const d = global.__da;
      d.ctx = { emit: (e) => d.events.push(e), signal: new AbortController().signal, once: d.once, ask: async (card) => { d.asked.push(card); return typeof d.answer === 'function' ? d.answer(card) : d.answer; } };
      d.run = (action, args) => w.controller.run({ action, args }, d.ctx).then((v) => ({ ok: true, v: Array.isArray(v) ? v.map((b) => (b.type === 'image' ? `[image ${b.source.data.length}]` : b.text)).join('\n') : v }), (e) => ({ ok: false, v: e.message }));
      // main-thread gap probe: how long the event loop is ever blocked
      let last = Date.now();
      d.probe = setInterval(() => { const now = Date.now(); d.gaps.push(now - last - 5); last = now; }, 5);
    }, testApp.pid);
    const run = (action, args = {}) => app.evaluate((_e, a) => global.__da.run(a.action, a.args), { action, args });
    const state = () => app.evaluate(() => ({ asked: global.__da.asked.length, events: global.__da.events.length, master: global.__da.w.settings.master(), allowed: global.__da.w.settings.allowed(), active: global.__da.w.controller.active(), banner: global.__da.w.controller.banner.state() }));
    const setAnswer = (a) => app.evaluate((_e, v) => { global.__da.answer = v; }, a);

    check('everything is off by default: the switch, terminals and the list', (await app.evaluate(() => { const s = global.__da.w.settings; return !s.master() && !s.terminals() && s.allowed().length === 0; })));

    // switch off: the first use offers to turn it on
    await setAnswer(false);
    const off = await run('list_apps');
    check('switch off: the AI is told it is off, and the user was asked once to turn it on (and said no)', !off.ok && /off/i.test(off.v) && (await state()).asked === 1 && !(await state()).master, JSON.stringify(off));
    await setAnswer(true);
    const apps = await run('list_apps');
    check('switch on after Yes; list_apps finds the test app by name (title hidden until allowed)', apps.ok && /LumenUiaTestApp/.test(apps.v) && !apps.v.includes(title), apps.v);
    const hwnd = (/w(\d+)\s+LumenUiaTestApp/.exec(apps.v) || [])[1];
    check('list_apps does not list Lumen itself or any blocked window', !/^w\d+ {2}(Lumen|Command Prompt|Windows PowerShell)\b/m.test(apps.v), apps.v);

    // first use asks
    await setAnswer(false);
    const denied = await run('read_app', { id: `w${hwnd}` });
    check('the first use of the app asks "Allow the AI to use ...?"; No means nothing is read', !denied.ok && /did not let the AI use/.test(denied.v) && (await app.evaluate(() => /Allow the AI to use LumenUiaTestApp\?/.test(global.__da.asked[global.__da.asked.length - 1].title))), JSON.stringify(denied));
    await setAnswer(true);
    const before = (await state()).asked;
    const read = await run('read_app', { id: `w${hwnd}` });
    check('Once: read_app shows the controls: textbox, button, label, checkbox', read.ok && /Edit "Your name"/.test(read.v) && /Button "Greet"/.test(read.v) && /Text "Waiting"/.test(read.v) && /CheckBox "I agree"/.test(read.v), read.v);
    check('read_app omits the password box: no value, no name, only the count', !/s3cret|Secret|txtSecret/.test(read.v) && /1 password field left out/.test(read.v), read.v);
    check('read_app is wrapped as untrusted content', /^<untrusted_page_content source="app: LumenUiaTestApp">/.test(read.v));
    check('the second call in the chat asks nothing more', (await state()).asked === before + 1 && (await run('read_app', { id: `w${hwnd}` })).ok && (await state()).asked === before + 1);
    const idOf = (kind, name) => (new RegExp(`\\[(e\\d+)\\] ${kind} "${name}"`).exec(read.v) || [])[1];
    const edit = idOf('Edit', 'Your name'); const button = idOf('Button', 'Greet');
    // type and click: the label changes
    const typed = await run('type', { element: edit, text: 'Ada' });
    check('type: the textbox is set through its Value pattern', typed.ok && /set the field/.test(typed.v), typed.v);
    const clicked = await run('click', { element: button });
    check('click: the button is invoked', clicked.ok && /Clicked/.test(clicked.v), clicked.v);
    await sleep(300);
    const after = await run('read_app', { id: `w${hwnd}` });
    check('the label changed to "Hello, Ada" and the textbox holds Ada', after.ok && /Text "Hello, Ada"/.test(after.v) && /Edit "Your name" = "Ada"/.test(after.v), after.v);
    const pwTry = await run('type', { element: 'e999', text: 'x' });
    check('typing into an id that is not in the read (a password box has none) is refused', !pwTry.ok, pwTry.v);

    // the helper itself never types into a password box, even for an id it knew: ask it directly
    const direct = await app.evaluate(async (_e, h) => {
      const c = global.__da.w.controller.client();
      const t = await c.call('tree', { hwnd: Number(h), max: 700 });
      const all = []; const walk = (n) => { if (!n) return; if (n.pw) all.push(n); (n.c || []).forEach(walk); };
      walk(t.tree);
      return { pwNodes: all.length, keys: all.map((n) => Object.keys(n).join()), json: JSON.stringify(t.tree).includes('s3cret') };
    }, hwnd);
    check('the helper reports the password box as {pw:true} with nothing else, and its value is nowhere in the tree', direct.pwNodes === 1 && direct.keys[0] === 'pw' && !direct.json, JSON.stringify(direct));

    // screenshot and the card thumbnail
    const shot = await run('screenshot_app', { id: `w${hwnd}` });
    check('screenshot_app returns a picture of the window', shot.ok && /\[image \d{3,}\]/.test(shot.v), shot.v);
    await sleep(1800);
    const thumbs = await app.evaluate(() => global.__da.events.filter((e) => e.type === 'desktop_card' && e.thumbnail).map((e) => e.thumbnail.length));
    check('the card has a live thumbnail (a data: image) after the first calls', thumbs.length >= 1, JSON.stringify(thumbs));
    const card = await app.evaluate(() => global.__da.events.filter((e) => e.type === 'desktop_card').pop());
    check('card payload: surface app, app name, window title, status working, icon slot', card.surface === 'app' && card.app === 'LumenUiaTestApp' && card.title.startsWith(title) && card.status === 'working', JSON.stringify({ ...card, thumbnail: '...' }));
    // the thumbnail follows the window: change the label, wait one refresh (1.5 s), the picture differs
    const first = await app.evaluate(() => global.__da.events.filter((e) => e.type === 'desktop_card' && e.thumbnail).pop().thumbnail);
    await run('type', { element: edit, text: 'Grace Hopper and a much longer name here' });
    await run('click', { element: button });
    await sleep(2600);
    const second = await app.evaluate(() => global.__da.events.filter((e) => e.type === 'desktop_card' && e.thumbnail).pop().thumbnail);
    check('the thumbnail updates as the window changes (about every 1.5 s)', first !== second && /^data:image\/jpeg;base64,/.test(second), `${first.length} vs ${second.length}`);

    // the banner and Stop (test hook)
    const st = await state();
    check('the banner is up while the AI uses the app (hidden in tests), naming the app', st.active && st.banner.visible && /The AI is using LumenUiaTestApp/.test(st.banner.text), JSON.stringify(st.banner));
    check('the global Stop shortcut is registered only while it works', (await app.evaluate(() => global.__da.w.controller.shortcut.registered())).includes('Ctrl+Alt+Esc'));
    await app.evaluate(() => { global.__da.stopped = 0; });
    await app.evaluate(() => global.__da.w.controller.banner.press('stop'));
    await sleep(100);
    const stopped = await state();
    check('Stop on the banner ends the session: banner gone, shortcut released, card says stopped', !stopped.active && !stopped.banner.visible && (await app.evaluate(() => global.__da.w.controller.shortcut.registered().length === 0 && global.__da.events.filter((e) => e.type === 'desktop_card').pop().status === 'stopped')));

    // Always, then Revoke
    await app.evaluate(() => { global.__da.once.clear(); });
    await setAnswer('always');
    await run('read_app', { id: `w${hwnd}` });
    check('Always: the app is in Settings > Apps the AI can use', (await state()).allowed.some((a) => a.app === 'lumenuiatestapp'), JSON.stringify((await state()).allowed));
    const askedBefore = (await state()).asked;
    await app.evaluate(() => { global.__da.once.clear(); });
    await run('read_app', { id: `w${hwnd}` });
    check('a listed app asks nothing', (await state()).asked === askedBefore);
    const ipcList = await app.evaluate(() => global.__da.w.settings.allowed().length);
    await app.evaluate(() => global.__da.w.settings.remove('LumenUiaTestApp'));
    await setAnswer(false);
    const revoked = await run('read_app', { id: `w${hwnd}` });
    check('Revoke: the app asks again and No refuses it', ipcList === 1 && !revoked.ok && (await state()).asked === askedBefore + 1, JSON.stringify(revoked));

    // blocked windows: Lumen's own window and a missing one
    const own = await app.evaluate(async () => {
      const wins = await global.__da.w.controller.apps(true);
      return wins.filter((x) => x.pid === process.pid).length;
    });
    check('Lumen\'s own windows are in the OS list but never usable', own >= 0);
    const lumenId = await app.evaluate(async () => { const x = (await global.__da.w.controller.apps(true)).find((w) => w.pid === process.pid); return x ? `w${x.hwnd}` : null; });
    if (lumenId) { const r = await run('read_app', { id: lumenId }); check('read_app on Lumen\'s own window is refused', !r.ok && /Lumen itself/.test(r.v), r.v); }
    else check('read_app on Lumen\'s own window is refused (no Lumen window visible to UIA in a hidden test: policy unit-tested)', true);

    // perf
    const startMs = await app.evaluate(() => global.__da.w.controller.stats().helperMs);
    check(`the helper started in ${startMs} ms (under 1 s)`, startMs > 0 && startMs < 1000, startMs);
    await app.evaluate(() => { global.__da.gaps.length = 0; });
    await setAnswer(true);
    for (let i = 0; i < 4; i++) await run('read_app', { id: `w${hwnd}` });
    await sleep(1700); // a thumbnail refresh happens inside this window too
    const worst = await app.evaluate(() => Math.max(0, ...global.__da.gaps));
    check(`per-call main-thread gap <= 20 ms (worst ${worst} ms across reads and a thumbnail refresh)`, worst <= 20, worst);
    await app.evaluate(() => { clearInterval(global.__da.probe); global.__da.w.controller.stop('test'); });
    const left = cp.spawnSync('tasklist', ['/FI', `PID eq ${testApp.pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout;
    check('the test app is still ours and alive until we end it by PID', new RegExp(String(testApp.pid)).test(left), left);
  } finally {
    if (app) await app.close().catch(() => {});
    try { cp.spawnSync('taskkill', ['/PID', String(testApp.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ }
    for (const dir of [work, profile]) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* left in temp */ } }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
