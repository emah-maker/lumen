// [desktop apps] The AI operating other programs on this computer (src/desktop/, agent.js desktop tool), plain Node: no Electron, no real
// windows, no helper process. The permission model (off by default, Once / Always / No, the never-available list: consent.exe, password
// managers, banking, terminals, Lumen itself, password fields), the tree pruning, the key parsing, the one-tool schema budget, the controller
// with a stand-in helper (approval, blocked apps, Stop, Esc, "you took over", untrusted wrapping), the helper client and the banner.
require('./_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const policy = require('../src/desktop/policy');
const treeLib = require('../src/desktop/tree');
const keys = require('../src/desktop/keys');
const { createDesktop } = require('../src/desktop');
const { createClient, scriptFile } = require('../src/desktop/client');
const { createBanner } = require('../src/desktop/banner');
const { createDesktopSettings } = require('../src/desktop/settings');
const { Agent, requestFor, validateInput, EXTERNAL_TOOLS, DEFAULT_MODEL } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = JSON.stringify;
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- permission model
  {
    const base = { master: true, terminals: false, allowed: [], once: new Set(), lumenPid: 4242, lumenExe: 'C:\\Lumen\\Lumen.exe' };
    const word = { proc: 'WINWORD', title: 'Report.docx - Word', pid: 10, exe: 'C:\\Office\\WINWORD.EXE' };
    check('master switch off: an ordinary app is "off", with the way to turn it on', policy.decide(word, { ...base, master: false }).status === 'off' && /Settings > AI/.test(policy.OFF_TEXT));
    check('master on, app unknown: ask (with a friendly name)', J(policy.decide(word, base)) === J({ status: 'ask', app: 'winword', name: 'Microsoft Word' }), J(policy.decide(word, base)));
    check('Once: allowed for this chat only (the once set), not "always"', policy.decide(word, { ...base, once: new Set(['winword']) }).status === 'allow' && policy.decide(word, { ...base, once: new Set(['winword']) }).always === false);
    check('Always: allowed from the Settings list, by process name in any case', policy.decide({ ...word, proc: 'winword.EXE' }, { ...base, allowed: [{ app: 'winword', name: 'Microsoft Word' }] }).status === 'allow');
    check('Revoke: the app asks again once it leaves the list', policy.decide(word, { ...base, allowed: [] }).status === 'ask');
    const never = [
      ['consent.exe (UAC)', { proc: 'consent', title: 'User Account Control' }],
      ['LogonUI (sign-in)', { proc: 'LogonUI', title: 'Sign in' }],
      ['LockApp (lock screen)', { proc: 'LockApp', title: 'Windows default lock screen' }],
      ['credential UI', { proc: 'CredentialUIBroker', title: 'Windows Security' }],
      ['Windows Security by title', { proc: 'SecHealthUI', title: 'Windows Security' }],
      ['UAC by title under another process', { proc: 'something', title: 'User Account Control' }],
      ['1Password', { proc: '1Password', title: 'Vault' }],
      ['Bitwarden', { proc: 'Bitwarden', title: 'My vault' }],
      ['KeePassXC', { proc: 'KeePassXC', title: 'Passwords.kdbx' }],
      ['a password manager named in the title', { proc: 'electron', title: 'Dashlane - Passwords' }],
      ['Quicken (finance)', { proc: 'qw', title: 'Quicken' }],
      ['a finance app by process', { proc: 'Coinbase', title: 'Coinbase' }],
      ['a bank in a browser window', { proc: 'chrome', title: 'Online Banking - Chase Online - Google Chrome' }],
      ['Lumen by pid', { proc: 'electron', title: 'Lumen', pid: 4242 }],
      ['Lumen by name', { proc: 'Lumen', title: 'New tab' }],
      ['Lumen by exe path', { proc: 'x', title: 'y', exe: 'c:\\lumen\\lumen.exe' }],
      ['cmd', { proc: 'cmd', title: 'Command Prompt' }],
      ['PowerShell', { proc: 'powershell', title: 'Windows PowerShell' }],
      ['Windows Terminal', { proc: 'WindowsTerminal', title: 'Terminal' }],
      ['Windows Settings', { proc: 'SystemSettings', title: 'Settings' }],
      ['Registry Editor', { proc: 'regedit', title: 'Registry Editor' }],
    ];
    for (const [label, win] of never) {
      const all = policy.decide(win, { ...base, allowed: [{ app: policy.procKey(win.proc) }], once: new Set([policy.procKey(win.proc)]) });
      // (terminals are the one group Settings can open up: the other rows must stay blocked even listed, answered Once and with everything on)
      check(`never: ${label} is blocked, even when listed and allowed once`, all.status === 'blocked' && all.reason.length > 20, J(all));
    }
    check('terminals: allowed only with their own Settings switch (then they still ask)', policy.decide({ proc: 'cmd', title: 'x' }, { ...base, terminals: true }).status === 'ask' && policy.decide({ proc: 'cmd', title: 'x' }, base).status === 'blocked');
    check('the Windows key and Alt+F4 are never sent, Lumen\'s master switch cannot override them (keys.js)', /Windows key/.test(String(keys.parseKeys.bind(null, 'win+r') && (() => { try { keys.parseKeys('win+r'); } catch (e) { return e.message; } })())));
    check('clean: drops never-apps, duplicates and junk; keeps a friendly name', J(policy.clean([{ app: 'WINWORD.EXE', name: 'Microsoft Word', added: 5 }, 'winword', { app: 'consent' }, { app: '1password' }, { app: '../x' }, 7, null, { app: 'excel' }])) === J([{ app: 'winword', name: 'Microsoft Word', added: 5 }, { app: 'excel', name: 'Microsoft Excel', added: 0 }]), J(policy.clean([{ app: 'WINWORD.EXE', name: 'Microsoft Word', added: 5 }, 'winword', { app: 'consent' }, { app: 'excel' }])));
    check('friendly names: Word, Explorer, MATLAB; unknown programs get a readable one', policy.friendlyName('explorer') === 'File Explorer' && policy.friendlyName('MATLAB') === 'MATLAB' && policy.friendlyName('winword.exe') === 'Microsoft Word' && policy.friendlyName('mytool') === 'Mytool' && policy.friendlyName('x', 'Acme Studio') === 'Acme Studio');
    check('not Windows: one clean sentence', /Not available on this platform/.test(policy.NOT_WINDOWS));
  }

  // ---- tree pruning
  {
    const node = (t, n, extra = {}, c) => ({ t: `ControlType.${t}`, n, ...extra, ...(c ? { c } : {}) });
    const root = node('Window', 'Form', { i: 'e1' }, [
      node('Pane', '', {}, [
        node('Edit', 'Your name', { i: 'e2', v: 'Ada', p: 'v' }),
        node('Button', 'Greet', { i: 'e3', p: 'i' }, [node('Text', 'Greet')]),
        { pw: true },
        node('Edit', 'Secret', { pw: true, v: 'hunter2-DO-NOT-LEAK' }),
        node('CheckBox', 'I agree', { i: 'e4', k: true }),
        node('Button', 'Off', { i: 'e5', en: false }),
        node('Button', 'Scrolled away', { i: 'e6', off: true }),
        node('ScrollBar', 'x'),
        node('Pane', '', {}, [node('Text', 'Hello world')]),
      ]),
    ]);
    const r = treeLib.prune(root);
    const text = treeLib.render({ title: 'Form', proc: 'x', name: 'Test' }, root);
    check('prune: names, kinds, values and ids; layout panes vanish; a button\'s own label is not said twice', /\[e2\] Edit "Your name" = "Ada"/.test(text) && /\[e3\] Button "Greet"\n/.test(`${text}\n`) && !/Pane/.test(text) && (text.match(/"Greet"/g) || []).length === 1, text);
    check('prune: checked, disabled; offscreen and scroll bars left out and counted', /\[e4\] CheckBox "I agree" \(checked\)/.test(text) && /\[e5\] Button "Off" \(disabled\)/.test(text) && !/Scrolled away|ScrollBar/.test(text) && r.omitted.offscreen === 1);
    check('prune: password fields are dropped with their value, and only counted', !/hunter2|Secret/.test(text) && r.omitted.passwords === 2 && /2 password fields left out/.test(text), text);
    check('prune: a password inside a hidden or cut-off branch is still counted, never shown', treeLib.prune({ t: 'Window', n: 'w', i: 'e1', c: [{ t: 'Pane', n: 'p', off: true, c: [{ pw: true }] }] }).omitted.passwords === 1);
    const wide = { t: 'Window', n: 'big', i: 'e1', c: Array.from({ length: 500 }, (_, i) => node('Button', `Button number ${i}`, { i: `e${i + 2}` })) };
    const big = treeLib.prune(wide);
    check('prune: capped at the node limit and the size limit, with the rest counted', big.shown === treeLib.MAX_NODES && big.omitted.more === 500 + 1 - treeLib.MAX_NODES && treeLib.render({ title: 'w' }, wide).length < treeLib.MAX_CHARS + 600, J([big.shown, big.omitted]));
    check('prune: long names and values are cut', treeLib.prune({ t: 'Window', n: 'x'.repeat(500), i: 'e1' }).lines[0].length < 140);
    check('prune: an empty window says so', /nothing readable/.test(treeLib.render({ title: 't' }, { t: 'ControlType.Window' })));
  }

  // ---- keys
  {
    const p = (k) => keys.parseKeys(k).seq;
    check('keys: ctrl+s, Enter, a sequence, F5, arrows, shift+tab', p('ctrl+s') === '^s' && p('Enter') === '{ENTER}' && p('ctrl+a ctrl+c') === '^a^c' && p('F5') === '{F5}' && p('Down') === '{DOWN}' && p('shift+tab') === '+{TAB}', J([p('ctrl+s'), p('shift+tab')]));
    check('keys: ctrl+shift+s groups its modifiers', p('ctrl+shift+s') === '^+s');
    const bad = (k) => { try { keys.parseKeys(k); return null; } catch (e) { return e.message; } };
    check('keys: Alt+F4, Ctrl+Alt+Del, Ctrl+Shift+Esc, Alt+Tab, Win+anything, Ctrl+Esc are refused with a reason', /closes the app/.test(bad('alt+f4')) && /Ctrl\+Alt\+Delete/.test(bad('ctrl+alt+delete')) && /Task Manager/.test(bad('ctrl+shift+esc')) && /focus_app/.test(bad('alt+tab')) && /Windows key/.test(bad('win+r')) && /Start menu/.test(bad('ctrl+esc')));
    check('keys: nonsense and empty are refused, not sent', bad('') && bad('ctrl+') !== undefined && bad('blorp') && bad(`${'a '.repeat(60)}`));
    check('typed text is escaped so "50% (done) [x]" is typed as written', keys.escapeText('50% (done) [x]') === '50{%} {(}done{)} {[}x{]}' && keys.escapeText('a+b') === 'a{+}b' && keys.escapeText('line1\nline2') === 'line1{ENTER}line2');
  }

  // ---- the tool: one dispatcher, compact, offered only when it should be
  {
    const msgs = (text) => Object.assign([{ role: 'user', content: text }], { settings: { model: DEFAULT_MODEL } });
    const off = requestFor(msgs('hi').settings, msgs('hi'));
    const on = requestFor(msgs('hi').settings, msgs('hi'), undefined, { desktop: true });
    const def = on.tools.find((t) => t.name === 'desktop');
    check('tool: absent from the default request, so the tool budget (17.5k) is untouched', !off.tools.some((t) => t.name === 'desktop') && JSON.stringify(off.tools).length < 17500, String(JSON.stringify(off.tools).length));
    check('tool: one dispatcher, desktop(action, args), under 700 characters', def && Object.keys(def.input_schema.properties).join() === 'action,args' && def.input_schema.required.join() === 'action' && JSON.stringify(def).length < 700, String(JSON.stringify(def).length));
    check('tool: the eight actions are in the enum, and in the description', J(def.input_schema.properties.action.enum) === J(['list_apps', 'focus_app', 'read_app', 'click', 'type', 'press_keys', 'screenshot_app', 'open_app']) && def.description.length < 420);
    check('tool: with it on, the whole list is still a modest step up (one tool)', JSON.stringify(on.tools).length - JSON.stringify(off.tools).length < 700 && on.tools.filter((t) => t.cache_control).length === 1 && on.tools[on.tools.length - 1].cache_control, String(JSON.stringify(on.tools).length));
    check('tool: input is checked like any other tool', validateInput('desktop', { action: 'list_apps' }) === null && validateInput('desktop', {}) !== null && validateInput('desktop', { action: 5 }) !== null && validateInput('desktop', { action: 'read_app', args: 'x' }) !== null);
    check('tool: not listed to MCP clients or the CLI engines', !EXTERNAL_TOOLS.some((t) => t.name === 'desktop'));
    const ag = read('src/ai/agent.js');
    check('lists: tab-free (it works on no tab) and a reading tool (what an app shows is untrusted: it taints the run)', /TAB_FREE_TOOLS = new Set\([^)]*'desktop'/.test(ag) && /READING_TOOLS = new Set\([^)]*'desktop'/.test(ag));
    check('approval: an app card is never auto-answered by Bypass permissions', /action !== 'app' && this\.bypassOn\(\)/.test(ag));
    const agent = new Agent({ desktopAccess: () => false });
    const offered = (text) => agent.desktopOffered([{ role: 'user', content: text }]);
    check('offer: the tool is offered when the chat asks for an app, switch off (so the AI can ask to turn it on)', ['Open Word and fix the heading in my report', 'In Excel, sum column B', 'use File Explorer to find my thesis', 'run my MATLAB script on this computer', 'can you operate other apps on my PC?'].every(offered));
    check('offer: ordinary requests do not pay for it', ['Summarize this page', 'what is the word for happy', 'search the web for pizza', 'write a word problem', 'fix the bug in my code'].every((t) => !offered(t)));
    check('offer: the switch on offers it for every request', new Agent({ desktopAccess: () => true }).desktopOffered([{ role: 'user', content: 'hello' }]) === true);
  }

  // ---- the controller, with a stand-in helper
  const makeRig = ({ apps = [], master = true, terminals = false, allowed = [], winapi, platform = 'win32', treeFor, banner } = {}) => {
    const calls = [];
    const store = { master, terminals, allowed: allowed.slice() };
    const client = {
      call: async (cmd, args = {}) => {
        calls.push([cmd, args]);
        if (cmd === 'apps') return { ok: true, apps };
        if (cmd === 'tree') return { ok: true, tree: treeFor ? treeFor(args) : { t: 'ControlType.Window', n: 'Form', i: 'e1', c: [{ t: 'ControlType.Edit', n: 'Name', i: 'e2', v: 'Ada' }, { pw: true }] } };
        if (cmd === 'invoke') return { ok: true, method: 'invoke' };
        if (cmd === 'settext') return { ok: true, method: 'value' };
        if (cmd === 'keys') return { ok: true, sent: true };
        if (cmd === 'focus') return { ok: true, foreground: true };
        if (cmd === 'shot') return { ok: true, image: 'QUJD'.repeat(40) };
        if (cmd === 'resolve') return { ok: true, found: store.found || [] };
        if (cmd === 'launch') { apps.push({ hwnd: 900, pid: 90, proc: 'notepad', title: 'Untitled - Notepad', exe: 'C:\\Windows\\notepad.exe', description: 'Notepad' }); return { ok: true }; }
        return { ok: true };
      },
      destroy() {},
    };
    const settings = { master: () => store.master, terminals: () => store.terminals, allowed: () => store.allowed, allow: (app, name) => { store.allowed.push({ app, name }); }, setMaster: (on) => { store.master = on; } };
    const events = [];
    const asked = [];
    let answer = true;
    const ban = banner || { shown: [], updates: [], hidden: 0, async show(app, o) { this.shown.push([app, o]); }, async update(o) { this.updates.push(o); }, hide() { this.hidden++; } };
    const stops = [];
    const unregistered = [];
    const ctx = { emit: (e) => events.push(e), signal: new AbortController().signal, once: new Set(), ask: async (card) => { asked.push(card); return typeof answer === 'function' ? answer(card) : answer; } };
    const d = createDesktop({ client, settings, banner: ban, winapi, platform, stopRun: () => stops.push(1), icon: async () => null, shortcut: { register: (k) => unregistered.push(['reg', k]), unregister: (k) => unregistered.push(['unreg', k]) }, lumen: { pid: 4242, exe: 'C:\\Lumen\\Lumen.exe' } });
    return { d, calls, store, events, asked, ctx, ban, stops, shortcuts: unregistered, setAnswer: (a) => { answer = a; }, settings };
  };
  const word = { hwnd: 100, pid: 10, proc: 'WINWORD', title: 'Report.docx - Word', exe: 'C:\\Office\\WINWORD.EXE', description: 'Microsoft Word' };
  const consent = { hwnd: 101, pid: 11, proc: 'consent', title: 'User Account Control', exe: 'C:\\Windows\\System32\\consent.exe' };
  const keepass = { hwnd: 102, pid: 12, proc: 'KeePass', title: 'Passwords - KeePass', exe: 'C:\\KeePass\\KeePass.exe' };
  const shell = { hwnd: 103, pid: 13, proc: 'cmd', title: 'Command Prompt', exe: 'C:\\Windows\\System32\\cmd.exe' };
  const lumenWin = { hwnd: 104, pid: 4242, proc: 'Lumen', title: 'New tab', exe: 'C:\\Lumen\\Lumen.exe' };
  const slack = { hwnd: 105, pid: 14, proc: 'slack', title: 'Slack | secret-project | Acme', exe: 'C:\\Slack\\slack.exe' };

  {
    const rig = makeRig({ apps: [word, consent, keepass, shell, lumenWin, slack], platform: 'darwin' });
    check('not Windows: every action answers "Not available on this platform"', /Not available on this platform/.test(await rejects(() => rig.d.run({ action: 'list_apps' }, rig.ctx))) && rig.calls.length === 0);
  }
  {
    const rig = makeRig({ apps: [word], master: false });
    rig.setAnswer(false);
    const msg = await rejects(() => rig.d.run({ action: 'list_apps' }, rig.ctx));
    check('switch off: the first use asks to turn it on (one card, with the explanation); No leaves it off', /off/i.test(msg) && rig.asked.length === 1 && /Let the AI use other apps/.test(rig.asked[0].title) && rig.asked[0].noAlways === true && rig.store.master === false && rig.calls.length === 0, J([msg, rig.asked.length]));
    rig.setAnswer(true);
    const text = await rig.d.run({ action: 'list_apps' }, rig.ctx);
    check('switch off, user says yes: it is turned on and the call goes on', rig.store.master === true && /Microsoft Word/.test(text));
  }
  {
    const rig = makeRig({ apps: [word, consent, keepass, shell, lumenWin, slack] });
    const text = await rig.d.run({ action: 'list_apps' }, rig.ctx);
    check('list_apps: names the apps, hides titles until allowed, never lists the blocked windows (only counts them)', /w100  Microsoft Word \(asks you first/.test(text) && !/Report\.docx/.test(text) && !/secret-project/.test(text) && !/consent|KeePass|Command Prompt|User Account/i.test(text) && /3 other windows are never available/.test(text) || /4 other windows/.test(text), text);
    check('list_apps: asks nothing', rig.asked.length === 0);
  }
  {
    const rig = makeRig({ apps: [word, consent, keepass, shell, lumenWin] });
    const bad = [];
    for (const w of ['w101', 'w102', 'w103', 'w104']) for (const action of ['focus_app', 'read_app', 'screenshot_app']) bad.push([w, action, await rejects(() => rig.d.run({ action, args: { id: w } }, rig.ctx))]);
    check('blocked windows (consent.exe, a password manager, a terminal, Lumen) are refused for every action, with the reason, and nothing is asked or run', bad.every(([, , m]) => m && /never|Lumen|password manager|terminal|prompt/i.test(m)) && rig.asked.length === 0 && !rig.calls.some(([c]) => ['tree', 'focus', 'shot'].includes(c)), J(bad));
    check('a blocked app is not opened by open_app either: nothing is started', true);
    rig.store.found = [{ key: 'k1', name: 'Command Prompt', exe: 'C:\\Windows\\System32\\cmd.exe', exact: true }];
    const m = await rejects(() => rig.d.run({ action: 'open_app', args: { name: 'Command Prompt' } }, rig.ctx));
    check('open_app on a terminal: refused before anything starts', /terminal/i.test(m) && !rig.calls.some(([c]) => c === 'launch'), J([m, rig.calls.map((c) => c[0])]));
    rig.store.found = [{ key: 'k2', name: 'Windows Security', exe: 'C:\\Windows\\System32\\SecurityHealthSystray.exe', exact: true }];
    const m2 = await rejects(() => rig.d.run({ action: 'open_app', args: { name: 'Windows Security' } }, rig.ctx));
    check('open_app on Windows Security: refused', /security/i.test(m2) && !rig.calls.some(([c]) => c === 'launch'), m2);
  }
  {
    const rig = makeRig({ apps: [word] });
    rig.setAnswer(false);
    const m = await rejects(() => rig.d.run({ action: 'read_app', args: { name: 'word' } }, rig.ctx));
    check('No: the AI is told the user did not allow it, nothing is read, and no session starts', /did not let the AI use Microsoft Word/.test(m) && !rig.calls.some(([c]) => c === 'tree') && !rig.d.active() && rig.asked.length === 1);
    check('the approval card names the app and the window, and explains Once and Always', /Allow the AI to use Microsoft Word\?/.test(rig.asked[0].title) && /Report\.docx/.test(rig.asked[0].args) && /Once/.test(rig.asked[0].detail) && /Always/.test(rig.asked[0].detail));
    rig.setAnswer(true);
    const out = await rig.d.run({ action: 'read_app', args: { name: 'word' } }, rig.ctx);
    check('Once: it reads, wrapped as untrusted content, the password field left out and counted', /^<untrusted_page_content source="app: Microsoft Word">/.test(out) && /\[e2\] Edit "Name" = "Ada"/.test(out) && /1 password field left out/.test(out), out);
    check('Once: remembered for this chat (the second call does not ask), not saved to Settings', rig.asked.length === 2 && rig.ctx.once.has('winword') && rig.store.allowed.length === 0);
    await rig.d.run({ action: 'read_app', args: { name: 'word' } }, rig.ctx);
    check('...and a later call asks nothing more', rig.asked.length === 2);
    const rig2 = makeRig({ apps: [word] });
    rig2.setAnswer('always');
    await rig2.d.run({ action: 'read_app', args: { name: 'word' } }, rig2.ctx);
    check('Always: the app goes to the Settings list', J(rig2.store.allowed) === J([{ app: 'winword', name: 'Microsoft Word' }]));
    const fresh = makeRig({ apps: [word], allowed: [{ app: 'winword', name: 'Microsoft Word' }] });
    await fresh.d.run({ action: 'read_app', args: { name: 'word' } }, fresh.ctx);
    check('a listed app is used without a card, in a new chat too', fresh.asked.length === 0 && fresh.calls.some(([c]) => c === 'tree'));
  }
  {
    const rig = makeRig({ apps: [word], allowed: [{ app: 'winword' }] });
    await rig.d.run({ action: 'read_app', args: { name: 'word' } }, rig.ctx);
    check('banner: shown while the app is used, named; the global Stop shortcut is registered for the run only', J(rig.ban.shown.map((s) => s[0])) === J(['Microsoft Word']) && rig.shortcuts.some((s) => s[0] === 'reg' && s[1] === 'Ctrl+Alt+Esc'));
    const card = rig.events.find((e) => e.type === 'desktop_card');
    check('card: surface "app", the app name, the window title, a "working" status and the task', card && card.surface === 'app' && card.app === 'Microsoft Word' && card.title === 'Report.docx - Word' && card.status === 'working' && /Reading Microsoft Word/.test(card.task), J(card));
    await rig.d._thumb();
    const withThumb = rig.events.filter((e) => e.type === 'desktop_card' && e.thumbnail);
    check('card: a live thumbnail comes from the helper as a data: image', withThumb.length > 0 && /^data:image\/jpeg;base64,/.test(withThumb[withThumb.length - 1].thumbnail));
    const before = rig.events.length;
    await rig.d._thumb();
    check('card: an unchanged picture is not sent again', rig.events.length === before);
    rig.d.finishRun();
    check('run end: banner hidden, shortcut released, card says completed', rig.ban.hidden === 1 && rig.shortcuts.some((s) => s[0] === 'unreg') && rig.events[rig.events.length - 1].status === 'completed' && !rig.d.active());
  }
  {
    // click / type
    const rig = makeRig({ apps: [word], allowed: [{ app: 'winword' }] });
    check('click before reading: the AI is told to read first', /Read the app first/.test(await rejects(() => rig.d.run({ action: 'click', args: { element: 'e3' } }, rig.ctx))));
    await rig.d.run({ action: 'read_app', args: { name: 'word' } }, rig.ctx);
    check('click and type: an id from the read goes to the helper (invoke / settext); ids are checked', /Clicked e3 \(invoke\)/.test(await rig.d.run({ action: 'click', args: { element: 'e3' } }, rig.ctx)) && /Typed 5 characters into e2/.test(await rig.d.run({ action: 'type', args: { element: 'e2', text: 'hello', submit: true } }, rig.ctx)) && rig.calls.some(([c, a]) => c === 'settext' && a.el === 'e2' && a.submit === true) && /Pass element/.test(await rejects(() => rig.d.run({ action: 'click', args: { element: 'x; rm -rf' } }, rig.ctx))));
    check('type: too much text in one call is refused', /Too much text/.test(await rejects(() => rig.d.run({ action: 'type', args: { element: 'e2', text: 'x'.repeat(9000) } }, rig.ctx))));
    check('press_keys: a safe shortcut is sent as SendKeys text; Alt+F4 never reaches the helper', /Pressed ctrl\+s/.test(await rig.d.run({ action: 'press_keys', args: { keys: 'ctrl+s' } }, rig.ctx)) && rig.calls.some(([c, a]) => c === 'keys' && a.seq === '^s') && /closes the app/.test(await rejects(() => rig.d.run({ action: 'press_keys', args: { keys: 'alt+f4' } }, rig.ctx))) && !rig.calls.some(([c, a]) => c === 'keys' && /%\{?F4/.test(a.seq)));
    const shot = await rig.d.run({ action: 'screenshot_app', args: { name: 'word' } }, rig.ctx);
    check('screenshot_app: an image block and a caption', Array.isArray(shot) && shot[0].type === 'image' && shot[0].source.media_type === 'image/jpeg' && /Microsoft Word/.test(shot[1].text));
    check('unknown action: refused with the list', /Unknown action/.test(await rejects(() => rig.d.run({ action: 'format_c' }, rig.ctx))));
  }
  {
    // Stop, Esc, takeover
    let esc = false; let typing = false; let cursor = { x: 10, y: 10 }; let underCursor = 0; let foreground = 0;
    const winapi = { ok: true, cursor: () => ({ ...cursor }), pidUnderCursor: () => underCursor, foregroundPid: () => foreground, escapeDown: () => esc, mouseDown: () => false, typing: () => typing };
    let t = 1000;
    const rig = makeRig({ apps: [word], allowed: [{ app: 'winword' }], winapi });
    const clock = createDesktop({ client: { call: async () => ({ ok: true, apps: [word], tree: { t: 'ControlType.Window', n: 'F', i: 'e1' } }) }, settings: rig.settings, banner: rig.ban, winapi, now: () => t, stopRun: () => rig.stops.push('x'), shortcut: {}, lumen: { pid: 4242, exe: '' } });
    await clock.run({ action: 'read_app', args: { name: 'word' } }, rig.ctx);
    underCursor = 10; foreground = 10; cursor = { x: 10, y: 10 };
    clock._poll();
    check('takeover: nothing happens while the user does nothing', !clock.paused());
    cursor = { x: 80, y: 60 };
    clock._poll();
    check('takeover: the mouse moving over the app pauses the AI; the banner says so', clock.paused() && rig.ban.updates.some((u) => u.paused === true), J(rig.ban.updates));
    let resolved = false;
    const waiting = clock.run({ action: 'click', args: { element: 'e1' } }, rig.ctx).then(() => { resolved = true; }, () => { resolved = 'err'; });
    await sleep(30);
    check('takeover: the next action waits for Resume', resolved === false);
    clock.resume();
    await waiting;
    check('takeover: Resume lets it carry on (and unpauses the banner)', resolved === true && !clock.paused() && rig.ban.updates.some((u) => u.paused === false));
    underCursor = 99; cursor = { x: 500, y: 500 };
    clock._poll();
    check('takeover: the mouse moving over another program is not a takeover', !clock.paused());
    underCursor = 10; typing = true; foreground = 10;
    clock._poll();
    check('takeover: typing in the app (keyboard) pauses it too', clock.paused());
    clock.resume();
    typing = false;
    esc = true; clock._poll();
    t += 800; clock._poll();
    check('Esc held ~0.7 s stops the run at once (and the run is stopped); a tap would not', rig.stops.length === 1 && !clock.active(), J([rig.stops, clock.active()]));
    esc = false;
    const rig2 = makeRig({ apps: [word], allowed: [{ app: 'winword' }], winapi });
    await rig2.d.run({ action: 'read_app', args: { name: 'word' } }, rig2.ctx);
    esc = true; rig2.d._poll(); esc = false; rig2.d._poll();
    check('Esc tapped (not held) does not stop it', rig2.d.active() && rig2.stops.length === 0);
    rig2.d.stop('banner');
    check('Stop (banner or card): the run is stopped, banner hidden, card says stopped, next calls refuse', rig2.stops.length === 1 && !rig2.d.active() && rig2.ban.hidden === 1 && rig2.events[rig2.events.length - 1].status === 'stopped');
    const abort = new AbortController();
    const rig3 = makeRig({ apps: [word], allowed: [{ app: 'winword' }] });
    rig3.ctx.signal = abort.signal;
    await rig3.d.run({ action: 'read_app', args: { name: 'word' } }, rig3.ctx);
    abort.abort();
    check('the chat\'s own Stop ends the banner and the card too', !rig3.d.active() && rig3.ban.hidden === 1 && rig3.events[rig3.events.length - 1].status === 'stopped');
  }

  // ---- the helper client
  {
    const { EventEmitter } = require('events');
    const spawned = [];
    const fakeSpawn = (file, args) => {
      const child = new EventEmitter();
      const lines = [];
      child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
      child.stdin = Object.assign(new EventEmitter(), { write: (s) => { lines.push(s); return true; }, end() {} });
      child.kill = () => { child.killed = true; };
      child.pid = 1234 + spawned.length;
      child.lines = lines;
      spawned.push({ file, args, child });
      setImmediate(() => child.stdout.emit('data', '{"t":"hello","v":1}\n'));
      return child;
    };
    const c = createClient({ spawn: fakeSpawn, scriptFile: () => 'C:\\tmp\\uia-x.ps1', now: Date.now, idleMs: 60000 });
    const p = c.call('apps');
    await sleep(10);
    const sent = JSON.parse(spawned[0].child.lines[0]);
    check('client: powershell -File <script>, hidden through cli-utils options, no command text from the AI', spawned[0].file === 'powershell.exe' && spawned[0].args.join(' ') === '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\tmp\\uia-x.ps1' && sent.cmd === 'apps' && typeof sent.id === 'number');
    spawned[0].child.stdout.emit('data', `${J({ id: sent.id, ok: true, apps: [] })}\n`);
    check('client: a call resolves with the helper\'s JSON line', J((await p).apps) === '[]');
    const failing = c.call('tree', { hwnd: 1 });
    await sleep(10);
    const sent2 = JSON.parse(spawned[0].child.lines[1]);
    spawned[0].child.stdout.emit('data', `${J({ id: sent2.id, ok: false, error: 'No item e9.' })}\n`);
    check('client: a helper error comes back as an Error with its text', await rejects(() => failing) === 'No item e9.');
    const slow = createClient({ spawn: fakeSpawn, scriptFile: () => 'x.ps1' });
    const t0 = Date.now();
    const m = await rejects(() => slow.call('apps', {}, { timeoutMs: 80 }));
    check('client: a call that never answers times out (and the stuck helper is replaced, not waited for)', /did not answer in time/.test(m) && Date.now() - t0 < 1500, m);
    const mac = createClient({ platform: 'darwin' });
    check('client: not Windows: rejects as unavailable, starts nothing', /Not available on this platform/.test(await rejects(() => mac.call('apps'))));
    const written = [];
    const f1 = scriptFile({ read: () => Buffer.from('script'), write: (p, b) => written.push(p), mkdir: () => {}, exists: () => false, tmp: 'T' });
    const f2 = scriptFile({ read: () => Buffer.from('script'), write: () => written.push('again'), mkdir: () => {}, exists: () => true, tmp: 'T' });
    check('client: the script is written to the temp folder named by its content hash, once', f1 === f2 && /lumen-desktop[\\/]uia-[0-9a-f]{10}\.ps1$/.test(f1) && written.length === 1);
    c.destroy(); slow.destroy();
  }

  // ---- the banner
  {
    const sent = [];
    const handlers = new Map();
    let shows = 0;
    const created = [];
    class FakeWin {
      constructor(opts) { created.push(opts); this.webContents = { send: (ch, s) => sent.push([ch, s]) }; this.vis = false; }
      setAlwaysOnTop() {} setIgnoreMouseEvents() {} on() {} setBounds() {}
      loadURL() { return Promise.resolve(); }
      isDestroyed() { return false; } isVisible() { return this.vis; }
      showInactive() { this.vis = true; shows++; } hide() { this.vis = false; } destroy() {}
    }
    const electron = { BrowserWindow: FakeWin, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, ipcMain: { on: (ch, fn) => handlers.set(ch, fn) } };
    const actions = [];
    const b = createBanner({ electron, onAction: (a) => actions.push(a) });
    await b.show('Microsoft Word');
    const o = created[0];
    check('banner: frameless, transparent, always on top, never focusable, not in the taskbar, sandboxed, shown without activating', o.frame === false && o.transparent === true && o.alwaysOnTop === true && o.focusable === false && o.skipTaskbar === true && o.webPreferences.sandbox === true && o.webPreferences.contextIsolation === true && shows === 1);
    check('banner: says what is happening and offers Stop; paused offers Resume', sent[sent.length - 1][1].text === 'The AI is using Microsoft Word' && (await b.update({ paused: true }), /You took over Microsoft Word/.test(sent[sent.length - 1][1].text)) && sent[sent.length - 1][1].paused === true);
    const own = { id: 'banner' };
    b.show('x').catch(() => {});
    const win = created.length ? null : null;
    handlers.get('desktop-banner:action')({ sender: { not: 'the banner' } }, 'stop');
    check('banner: a message from any page but its own is ignored', actions.length === 0 && own.id === 'banner' && win === null);
    b.press('stop'); b.press('resume'); b.press('format');
    check('banner: press() (tests) answers Stop and Resume only', J(actions) === J(['stop', 'resume']));
    b.hide();
    check('banner: hide() hides it', !b.visible());
    const quiet = createBanner({ electron, hidden: true, onAction: () => {} });
    const n = created.length;
    await quiet.show('Word');
    check('banner: in a test run it is never created on screen', created.length === n && quiet.visible() && /Word/.test(quiet.state().text));
  }

  // ---- settings, docs, the module stays out of startup
  {
    const bag = {};
    const s = createDesktopSettings({ readSettings: () => ({ ...bag }), writeSettings: (v) => { Object.assign(bag, v); }, now: () => 7 });
    check('settings: everything is off by default, nothing listed', s.master() === false && s.terminals() === false && s.allowed().length === 0);
    s.allow('WINWORD.EXE', 'Microsoft Word'); s.allow('winword', 'Word'); s.allow('consent'); s.allow('1password');
    check('settings: Always adds one entry per app; never-apps cannot be added', J(s.allowed()) === J([{ app: 'winword', name: 'Word', added: 7 }]), J(s.allowed()));
    s.remove('WINWORD'); s.allow('excel'); s.clear();
    check('settings: Revoke removes one, Remove all clears', s.allowed().length === 0);
    s.allow('cmd');
    check('settings: a terminal can be listed only once its own switch is on', s.allowed().length === 0 && (bag.aiDesktopTerminals = true, s.allow('cmd'), s.allowed().length === 1));
    const backend = read('src/settings/settings-backend.js');
    check('settings: the three keys exist, off by default; the app list is changed only from its card and the Settings list', /aiDesktopControl: false,/.test(backend) && /aiDesktopTerminals: false,/.test(backend) && /aiDesktopApps: \[\],/.test(backend) && /key === 'aiDesktopApps'\) throw/.test(backend));
    const locale = JSON.parse(read('src/locales/en.json'));
    const used = new Set([...read('src/renderer/desktop-card.js').matchAll(/tr\('([a-z.A-Z]+)'/g)].map((m) => m[1]));
    check('locale: every string the card uses, and the settings and approval texts, exist', [...used].every((k) => k in locale) && ['settings.ai.desktopControl', 'settings.ai.desktopControlDesc', 'settings.ai.desktopTerminals', 'settings.ai.desktopTerminalsDesc', 'settings.ai.desktopApps', 'settings.ai.desktopAppsDesc', 'approval.app.once', 'approval.app.always'].every((k) => k in locale), [...used].filter((k) => !(k in locale)).join());
    const main = read('src/main.js');
    check('main: the desktop modules load on first use (no top-level require of src/desktop), the Settings channels exist', !/^const .*require\('\.\/desktop/m.test(main) && /require\('\.\/desktop\/wire'\)/.test(main) && /'settings:desktop-apps'/.test(main) && /'settings:remove-desktop-app'/.test(main));
    check('agent: it loads the policy lazily, only for a desktop step label', !/^const .*require\('\.\.\/desktop/m.test(read('src/ai/agent.js')));
    const helper = read('src/desktop/uia-helper.ps1');
    check('helper: password fields are reported with nothing else and refused for invoke / settext', /IsPassword\) \{ return @\{ pw = \$true \}/.test(helper) && /That is a password field\. The AI never uses these\./.test(helper) && /\$PWRE/.test(helper));
    check('helper: nothing from a request is run as code; only an app that `resolve` found can be launched, with no arguments', !/Invoke-Expression|iex |\[scriptblock\]::Create|Start-Process -FilePath \$req|-ArgumentList/.test(helper) && /Start-Process -FilePath \$path$/m.test(helper.replace(/\r/g, '')));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
