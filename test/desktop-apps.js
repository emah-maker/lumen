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
  const testApp2 = cp.spawn(exe, [`${title} B`, '-3000,500'], { stdio: 'ignore', windowsHide: false }); // a second window, for the focus-change test
  const policy = require('../src/desktop/policy');
  let app = null;
  try {
    await sleep(1500);
    app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');

    // The rig, in the main process: a call context that records its events and answers cards from a variable.
    await app.evaluate((_e, pid) => {
      const w = global.__desktop.wired();
      global.__da = { w, events: [], asked: [], answer: true, once: new Set(), pid, gaps: [] };
      const d = global.__da;
      d.ctx = { emit: (e) => d.events.push(e), signal: new AbortController().signal, once: d.once, tainted: () => d.tainted === true, ask: async (card) => { d.asked.push(card); return typeof d.answer === 'function' ? d.answer(card) : d.answer; } };
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
    check('read_app omits the password box AND a box that is not IsPassword but is named "Card PIN": no value, no name, only the count', !/s3cret|Secret|txtSecret|plain-looking|Card PIN|txtPin/.test(read.v) && /2 password fields left out/.test(read.v), read.v);
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
      return { pwNodes: all.length, keys: all.map((n) => Object.keys(n).join()), json: JSON.stringify(t.tree).includes('s3cret') || JSON.stringify(t.tree).includes('plain-looking') || JSON.stringify(t.tree).includes('Card PIN') };
    }, hwnd);
    check('the helper reports both the password box and the "Card PIN" box (never IsPassword) as {pw:true} with nothing else, and neither value is anywhere in the tree', direct.pwNodes === 2 && direct.keys.every((k) => k === 'pw') && !direct.json, JSON.stringify(direct));

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

    // the live picture. Typing and clicking through Lumen: a picture comes after each action (the title changes too: it is judged first, then shown)
    const frames = () => app.evaluate(() => global.__da.events.filter((e) => e.type === 'desktop_card' && e.thumbnail).length);
    const liveStats = () => app.evaluate(() => global.__da.w.controller.liveStats());
    const f0 = await frames();
    for (let i = 0; i < 6; i++) { await run('type', { element: edit, text: `Name number ${i} ${'x'.repeat(i * 3)}` }); await run('click', { element: button }); await sleep(250); }
    check('live: the card gets a new picture after each action in the app, though its title changes every time', (await frames()) - f0 >= 6, (await frames()) - f0);
    // A window that changes by itself (ten times a second): the helper's pictures arrive at several a second, with Lumen doing nothing but forwarding them
    const testApp3 = cp.spawn(exe, [`${title} C`, '-3000,900', 'animate'], { stdio: 'ignore', windowsHide: false });
    try {
      await sleep(1800);
      const apps3 = await run('list_apps');
      const mine3 = await app.evaluate(async (_e, pid) => { const x = (await global.__da.w.controller.apps(true)).find((w) => w.pid === pid); return x ? 'w' + x.hwnd : null; }, testApp3.pid);
      check('live: the animated test window is listed', Boolean(mine3) && apps3.ok, apps3.v);
      const first3 = await run('read_app', { id: mine3 });
      check('live: the AI uses the animated window (the card follows it)', first3.ok && /Tick/.test(first3.v), first3.v);
      const measure = async (ms) => {
        const s0 = await liveStats();
        const a0 = await frames();
        await app.evaluate(() => { global.__da.gaps.length = 0; });
        const t0 = Date.now();
        await sleep(ms);
        const liveGap = await app.evaluate(() => Math.max(0, ...global.__da.gaps)); // (read before anything else is asked of the main process)
        const secs = (Date.now() - t0) / 1000;
        const s1 = await liveStats();
        const got = (await frames()) - a0;
        const perMs = s1.frames > s0.frames ? Math.round((s1.helperMs - s0.helperMs) / (s1.frames - s0.frames)) : 0;
        const kb = s1.frames > s0.frames ? Math.round((s1.bytes - s0.bytes) / (s1.frames - s0.frames) / 1024 * 0.75) : 0;
        return { got, secs, fps: got / secs, perMs, kb, liveGap, calls: s1.calls - s0.calls };
      };
      await app.evaluate(() => { global.__desktopLight = false; }); // (a test run is often in software drawing, which is the slow pace: this run is the normal one)
      // The main thread's worst stall with the picture loop stopped, then with it running (the least of two windows each: one-off stalls are the machine's, a systematic one shows in both)
      await app.evaluate(() => { global.__da.w.controller._live().stop(); });
      const quietGaps = [];
      for (let i = 0; i < 2; i++) { await app.evaluate(() => { global.__da.gaps.length = 0; }); await sleep(3000); quietGaps.push(await app.evaluate(() => Math.max(0, ...global.__da.gaps))); }
      await app.evaluate(() => { global.__da.w.controller._live().start(); });
      await sleep(1500);
      const runs = [await measure(4000), await measure(4000)];
      const full = runs[0].fps >= runs[1].fps ? runs[0] : runs[1];
      const liveGap = Math.min(runs[0].liveGap, runs[1].liveGap);
      const baseGap = Math.min(...quietGaps);
      console.log(`      live, animated window, full effects: ${full.got} pictures in ${full.secs.toFixed(1)} s (${full.fps.toFixed(1)}/s), helper ${full.perMs} ms per picture, about ${full.kb} KB each; worst main-thread gap ${liveGap} ms with it, ${baseGap} ms without`);
      check(`live: a window that changes by itself gets about 3-10 pictures a second (${runs.map((r) => r.fps.toFixed(1)).join(' and ')}/s)`, runs.every((r) => r.fps >= 3 && r.fps <= 10), JSON.stringify(runs));
      check(`live: the pictures add no stall to Lumen's main thread (worst ${liveGap} ms, ${baseGap} ms with the loop stopped; the bar is the larger of 20 ms and that plus 8)`, liveGap <= Math.max(20, baseGap + 8), `${liveGap} vs ${baseGap}`);
      const pic = await app.evaluate(() => { const e = global.__da.events.filter((x) => x.type === 'desktop_card' && x.thumbnail).pop(); const b = Buffer.from(e.thumbnail.split(',')[1], 'base64'); let w = 0; for (let i = 2; i < b.length - 9; ) { if (b[i] !== 0xFF) { i++; continue; } const m = b[i + 1]; if (m >= 0xC0 && m <= 0xC3) { w = b.readUInt16BE(i + 7); break; } i += 2 + b.readUInt16BE(i + 2); } return { w, bytes: b.length, jpeg: b[0] === 0xFF && b[1] === 0xD8 }; });
      check(`live: each picture is a small JPEG (the card's width: ${pic.w} px, ${Math.round(pic.bytes / 1024)} KB)`, pic.jpeg && pic.w > 0 && pic.w <= 680 && pic.bytes < 120 * 1024, JSON.stringify(pic));
      await app.evaluate(() => { global.__desktopLight = true; });
      await sleep(1500);
      const light = await measure(5000);
      console.log(`      live, animated window, Light graphics: ${light.got} pictures in ${light.secs.toFixed(1)} s (${light.fps.toFixed(1)}/s), helper ${light.perMs} ms per picture`);
      check(`live: Light graphics / software drawing: a slower rate (${light.fps.toFixed(1)}/s, at most 1.6)`, light.fps > 0 && light.fps <= 1.6, JSON.stringify(light));
      await app.evaluate(() => { global.__desktopLight = undefined; });
      // the window stops changing: the pictures stop (the animation ends when its process does; a minimized window is skipped by the helper)
      cp.spawnSync('taskkill', ['/PID', String(testApp3.pid), '/T', '/F'], { windowsHide: true });
      await sleep(2500);
      const stateAfter = await state();
      check('live: the window closes: the session ends (stopped) and no more pictures come', !stateAfter.active && (await app.evaluate(() => global.__da.events.filter((e) => e.type === 'desktop_card').pop().status)) === 'stopped');
      const z0 = await frames();
      await sleep(1500);
      check('live: nothing more is captured after that', (await frames()) === z0);
    } finally { try { cp.spawnSync('taskkill', ['/PID', String(testApp3.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ } }

    // the banner and Stop (test hook)
    await run('read_app', { id: `w${hwnd}` }); // (a new session on the first test window)
    const st = await state();
    check('the banner is up while the AI uses the app (hidden in tests), naming the app', st.active && st.banner.visible && /The AI is using LumenUiaTestApp/.test(st.banner.text), JSON.stringify(st.banner));
    check('the global Stop shortcut is registered only while it works', (await app.evaluate(() => global.__da.w.controller.shortcut.registered())).includes('Ctrl+Alt+Esc'));
    await app.evaluate(() => { global.__da.stopped = 0; });
    await app.evaluate(() => global.__da.w.controller.banner.press('stop'));
    await sleep(100);
    const stopped = await state();
    check('Stop on the banner ends the session: banner gone, shortcut released, card says stopped', !stopped.active && !stopped.banner.visible && (await app.evaluate(() => global.__da.w.controller.shortcut.registered().length === 0 && global.__da.events.filter((e) => e.type === 'desktop_card').pop().status === 'stopped')));

    // Always, then Revoke
    const exePath = await app.evaluate(async (_e, pid) => (await global.__da.w.controller.apps(true)).find((w) => w.pid === pid).app, testApp.pid);
    check('the app the helper reports is its full image path (lower case): approvals are by path, not by name', /^[a-z]:\\.*lumenuiatestapp\.exe$/.test(exePath), exePath);
    await app.evaluate(() => { global.__da.once.clear(); });
    await setAnswer('always');
    await run('read_app', { id: `w${hwnd}` });
    check('Always: the app is in Settings > Apps the AI can use', (await state()).allowed.some((a) => a.app === exePath), JSON.stringify((await state()).allowed));
    const askedBefore = (await state()).asked;
    await app.evaluate(() => { global.__da.once.clear(); });
    await run('read_app', { id: `w${hwnd}` });
    check('a listed app asks nothing', (await state()).asked === askedBefore);
    // a run that has read untrusted content: an Always app still asks before it is acted on
    await run('read_app', { id: 'w' + hwnd });
    await app.evaluate(() => { global.__da.tainted = true; });
    await setAnswer(false);
    const askedT = (await state()).asked;
    const readNow = await run('read_app', { id: 'w' + hwnd });
    const edit2 = (/\[(e\d+)\] Edit "Your name"/.exec(readNow.v) || [])[1];
    const tainted1 = await run('click', { element: (/\[(e\d+)\] Button "Greet"/.exec(readNow.v) || [])[1] });
    check('tainted run: clicking an Always app asks a card ("read content earlier"), and No means it is not clicked', !tainted1.ok && /did not allow this action/.test(tainted1.v) && (await state()).asked === askedT + 1 && (await app.evaluate(() => /read content earlier/.test(global.__da.asked[global.__da.asked.length - 1].title))), JSON.stringify(tainted1));
    await setAnswer(true);
    const tainted2 = await run('type', { element: edit2, text: 'Tainted ok' });
    check('tainted run: after a Yes the single action goes ahead (and the next one asks again)', tainted2.ok && (await state()).asked === askedT + 2 && (await run('type', { element: edit2, text: 'again' })).ok && (await state()).asked === askedT + 3);
    await app.evaluate(() => { global.__da.tainted = false; });

    // the keyboard guard, in the real helper: pieces of at most 16, and the foreground / focus / password are re-checked before EACH piece.
    // (The foreground a test sees is scripted with real windows: this session has no interactive desktop, and no key is ever sent: they are collected.)
    const guard = (args) => app.evaluate(async (_e, a) => {
      const w = global.__da.w.controller;
      const wins = await w.apps(true);
      const A = wins.find((x) => x.pid === a.pidA); const B = wins.find((x) => x.pid === a.pidB);
      const c = w.client();
      const tr = await c.call('tree', { hwnd: A.hwnd, pid: A.pid, hpid: 0, start: A.start, max: 700 });
      let el = null; const walk = (n) => { if (!n) return; if (n.n === 'Your name' && n.i) el = n.i; (n.c || []).forEach(walk); }; walk(tr.tree);
      const states = a.states.map((st) => ({ hwnd: st[0] === 'B' ? B.hwnd : A.hwnd, password: /pw$/.test(st) }));
      const target = { hwnd: A.hwnd, pid: A.pid, hpid: 0, start: A.start };
      try {
        const r = a.chords ? await c.call('keys', { ...target, chords: a.chords, test: { sink: true, states } }) : await c.call('settext', { ...target, el, text: a.text, forceKeys: true, test: { sink: true, states } });
        return { ok: true, sink: r.sink };
      } catch (e) { return { ok: false, message: e.message }; }
    }, { pidA: testApp.pid, pidB: testApp2.pid, ...args });
    const text40 = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn';
    const g1 = await guard({ text: text40, states: ['A'] });
    check('keyboard: 40 characters are sent as pieces of at most 16 (16 + 16 + 8) and nothing is lost when focus stays', g1.ok && g1.sink.length === 3 && g1.sink.every((p) => p.length <= 16) && g1.sink.join('') === text40, JSON.stringify(g1));
    const text64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzAB';
    const g2 = await guard({ text: text64, states: ['A', 'A', 'B'] });
    check('keyboard: focus moves to a second window after two pieces: typing stops, 32 of 64 characters were typed, the remaining 32 are NOT (and the AI is told exactly that)', !g2.ok && /32 of 64 characters were typed/.test(g2.message) && /NOT typed/.test(g2.message) && g2.message.includes('[sink: ' + text64.slice(0, 32) + ']') && !g2.message.includes(text64.slice(32, 40)), JSON.stringify(g2));
    const g3 = await guard({ text: 'hello world 12345', states: ['B'] });
    check('keyboard: focus already elsewhere before the first piece: nothing at all is typed', !g3.ok && /0 of 17 characters were typed/.test(g3.message), JSON.stringify(g3));
    const g4 = await guard({ chords: ['a', 'b', 'c', 'd'], states: ['A', 'Apw'] });
    check('keyboard: press_keys moves the focus into a password field after one key: the next keys are NOT sent (the focused element is checked as a password like a read is)', !g4.ok && /password field/.test(g4.message) && /1 of 4 characters were typed/.test(g4.message) && g4.message.includes('[sink: a]'), JSON.stringify(g4));
    const g5 = await guard({ chords: ['^a', '^c'], states: ['A'] });
    check('keyboard: key chords are sent one at a time, each checked', g5.ok && JSON.stringify(g5.sink) === '["^a","^c"]', JSON.stringify(g5));
    const g6 = await guard({ text: 'x'.repeat(600), states: ['A'] });
    check('keyboard: key-by-key typing is capped at 500 characters (a field without the Value pattern cannot take more)', !g6.ok && /500 characters/.test(g6.message), JSON.stringify(g6));
    const g7 = await app.evaluate(async (_e, a) => {
      const w = global.__da.w.controller; const wins = await w.apps(true); const A = wins.find((x) => x.pid === a.pidA); const B = wins.find((x) => x.pid === a.pidB);
      try { await w.client().call('tree', { hwnd: A.hwnd, pid: B.pid, hpid: 0, start: A.start, max: 10 }); return 'allowed'; } catch (e) { return e.message; }
    }, { pidA: testApp.pid, pidB: testApp2.pid });
    check('every call re-checks the window still belongs to the approved program: a window with another owner (pid) is refused', /now belongs to a different program/.test(g7), g7);

    // Stop in the middle of a call: the helper is killed, the call ends at once, a fresh helper serves the next call
    await setAnswer(true);
    await run('read_app', { id: 'w' + hwnd });
    const stopRun = await app.evaluate(async (_e, a) => {
      const w = global.__da.w.controller; const wins = await w.apps(true); const A = wins.find((x) => x.pid === a.pidA);
      const c = w.client();
      const tr = await c.call('tree', { hwnd: A.hwnd, pid: A.pid, hpid: 0, start: A.start, max: 700 });
      let el = null; const walk = (n) => { if (!n) return; if (n.n === 'Your name' && n.i) el = n.i; (n.c || []).forEach(walk); }; walk(tr.tree);
      const helperBefore = c.pid();
      const t0 = Date.now();
      let outcome = null;
      const inflight = c.call('settext', { hwnd: A.hwnd, pid: A.pid, hpid: 0, start: A.start, el, text: 'z'.repeat(200), forceKeys: true, test: { sink: true, states: [{ hwnd: A.hwnd }], delay: 400 } }, { timeoutMs: 30000 }).then(() => { outcome = 'finished'; }, (e) => { outcome = e.message; });
      await new Promise((r) => setTimeout(r, 900));
      const mid = outcome;
      w.stop('test');
      await inflight;
      return { mid, outcome, ms: Date.now() - t0, helperBefore, alive: c.alive() };
    }, { pidA: testApp.pid });
    check('Stop mid-call: the 200-character typing (13 pieces, ~5 s) is cut off by Stop within about a second, not allowed to finish', stopRun.mid === null && /Stopped by the user/.test(stopRun.outcome) && stopRun.ms < 2500 && stopRun.alive === false, JSON.stringify(stopRun));
    const afterStop = await run('list_apps');
    check('after Stop the next call just works (a fresh helper starts on demand)', afterStop.ok && /LumenUiaTestApp/.test(afterStop.v), afterStop.v);

    const ipcList = await app.evaluate(() => global.__da.w.settings.allowed().length);
    await app.evaluate((_e, p) => global.__da.w.settings.remove(p), exePath);
    await setAnswer(false);
    const askedNow = (await state()).asked;
    const revoked = await run('read_app', { id: `w${hwnd}` });
    check('Revoke: the app asks again and No refuses it', ipcList === 1 && !revoked.ok && (await state()).asked === askedNow + 1, JSON.stringify(revoked));

    // blocked windows: Lumen itself, by the real pid and image of this running copy
    const mainInfo = await app.evaluate(() => ({ pid: process.pid, exe: process.execPath }));
    const lumenDecision = policy.decide({ proc: 'electron', title: 'Lumen', pid: mainInfo.pid, exe: mainInfo.exe }, { master: true, lumenPid: mainInfo.pid, lumenExe: mainInfo.exe, allowed: [{ app: policy.exeKey(mainInfo.exe) }] });
    check('Lumen\'s own process (this running copy\'s pid and image) is blocked even if it were listed', lumenDecision.status === 'blocked' && /Lumen itself/.test(lumenDecision.reason), JSON.stringify(lumenDecision));
    const lumenId = await app.evaluate(async () => { const x = (await global.__da.w.controller.apps(true)).find((w) => w.pid === process.pid); return x ? 'w' + x.hwnd : null; });
    if (lumenId) { const r = await run('read_app', { id: lumenId }); check('read_app on one of Lumen\'s own windows is refused', !r.ok && /Lumen itself/.test(r.v), r.v); }

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
    try { cp.spawnSync('taskkill', ['/PID', String(testApp2.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ }
    for (const dir of [work, profile]) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* left in temp */ } }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
