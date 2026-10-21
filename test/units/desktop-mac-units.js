// [desktop apps] The macOS backend of the desktop tool (src/desktop/mac-*.js, platforms.js), plain Node with a stand-in execFile / spawn:
// no osascript, screencapture or open is ever run, nothing touches the user's apps and no macOS permission prompt can appear. Covers the
// argument building (the script is fixed; the AI's text only ever travels as a JSON argument), the tree read into element ids and paths,
// the permission errors and their System Settings card, the macOS never list, the key parser, open_app's lookup, the Esc / takeover
// probe and the platform switch.
require('../helpers/_tmp-cleanup');
const { EventEmitter } = require('events');
const policy = require('../../src/desktop/policy');
const treeLib = require('../../src/desktop/tree');
const keys = require('../../src/desktop/keys');
const platforms = require('../../src/desktop/platforms');
const macTree = require('../../src/desktop/mac-tree');
const macClient = require('../../src/desktop/mac-client');
const macProbe = require('../../src/desktop/mac-probe');
const { createDesktop } = require('../../src/desktop');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = JSON.stringify;
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const SOURCE = 'function run(argv) { return "{}"; } // the fixed script';
const HOSTILE = '"); do shell script "rm -rf ~" --` $(x) \' \n';

// A stand-in execFile: records (file, args, opts) and answers from `reply(file, args)` -> { stdout } | { err, stderr }.
function fakeExec(reply) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; setImmediate(() => cb(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', '')); };
    calls.push({ file, args, opts, child });
    Promise.resolve().then(() => reply(file, args, child)).then((r) => { if (r === 'hang' || child.killed) return; setImmediate(() => cb(r?.err || null, r?.stdout ?? '', r?.stderr ?? '')); });
    return child;
  };
  return { execFile, calls };
}
const ok = (o = {}) => ({ stdout: `${J({ ok: true, ...o })}\n` });

(async () => {
  // ---- the platform switch
  {
    check('platforms: Windows and macOS have a backend, Linux does not (yet)', platforms.supported('win32') && platforms.supported('darwin') && !platforms.supported('linux') && platforms.backendFor('linux') === null);
    const shape = Object.keys(platforms.BACKENDS.win32).sort();
    check('platforms: every backend has the same shape (a Linux one slots in the same way)', J(Object.keys(platforms.BACKENDS.darwin).sort()) === J(shape), J(shape));
    check('platforms: on macOS Lumen is its .app bundle (the never list compares the bundle path)', platforms.backendFor('darwin').lumenExe('/Applications/Lumen.app/Contents/MacOS/Lumen') === '/Applications/Lumen.app');
    check('platforms: open_app starts only an .app bundle by full path on macOS, an .exe on Windows', platforms.backendFor('darwin').launchable('/applications/textedit.app') && !platforms.backendFor('darwin').launchable('textedit') && !platforms.backendFor('darwin').launchable('/bin/sh') && platforms.backendFor('win32').launchable('c:\\x\\a.exe'));
    const d = createDesktop({ platform: 'linux', settings: { master: () => true }, client: { call: async () => { throw new Error('ran'); } } });
    check('platforms: on Linux every action answers "Not available on this platform" and starts nothing', /Not available on this platform/.test((await rejects(() => d.run({ action: 'list_apps' }, {})))?.message) && /macOS/.test(policy.NOT_SUPPORTED));
  }

  // ---- argument building: no interpolation
  {
    const args = macClient.jxaArgs(SOURCE, 'settext', { text: HOSTILE });
    check('jxaArgs: osascript -l JavaScript -e <fixed script> <command> <json>', J(args.slice(0, 3)) === J(['-l', 'JavaScript', '-e']) && args[3] === SOURCE && args[4] === 'settext' && JSON.parse(args[5]).text === HOSTILE && args.length === 6);
    check('captureArgs: a numeric window id only, no sound, no shadow', J(macClient.captureArgs('42; rm -rf /', '/tmp/x.jpg')) === J(['-x', '-o', '-t', 'jpg', '-l', '42', '/tmp/x.jpg']) || J(macClient.captureArgs(42.9, '/t.jpg')) === J(['-x', '-o', '-t', 'jpg', '-l', '42', '/t.jpg']), J(macClient.captureArgs(42.9, '/t.jpg')));
    check('sipsArgs: width and quality are clamped numbers', J(macClient.sipsArgs('/a.jpg', '/b.jpg', 'x', 500)) === J(['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', '--resampleWidth', '1000', '/a.jpg', '--out', '/b.jpg']));

    const fx = fakeExec((file, a) => {
      if (a[4] === 'tree') return ok({ tree: { r: 'AXWindow', n: 'Doc', p: [], c: [{ r: 'AXTextField', n: 'Name', v: 'Ada', p: [0] }, { r: 'AXButton', n: 'Save', p: [1] }] } });
      return ok({ method: 'value' });
    });
    const c = macClient.createMacClient({ execFile: fx.execFile, source: () => SOURCE });
    await c.call('tree', { hwnd: 7, pid: 70, start: 1 });
    await c.call('settext', { hwnd: 7, pid: 70, start: 1, title: 'Doc', el: 'e1', text: HOSTILE, submit: true });
    await c.call('keys', { hwnd: 7, pid: 70, start: 1, chords: keys.parseKeysMac('cmd+s').chords });
    check('client: every helper call is osascript with the same fixed script, whatever the AI typed', fx.calls.every((x) => x.file === 'osascript' && x.args[3] === SOURCE) && fx.calls.length === 3);
    check('client: the typed text travels only inside the JSON argument', !fx.calls.some((x) => x.args.slice(0, 5).some((v) => String(v).includes('rm -rf'))) && JSON.parse(fx.calls[1].args[5]).text === HOSTILE && JSON.parse(fx.calls[1].args[5]).submit === true);
    check('client: no shell option is ever passed (execFile with an argument array)', fx.calls.every((x) => !x.opts.shell && Array.isArray(x.args)));
    check('client: settext sends the element path, role, name and description from the last read (not the id), and the approved window title', J(JSON.parse(fx.calls[1].args[5]).path) === '[0]' && JSON.parse(fx.calls[1].args[5]).role === 'AXTextField' && JSON.parse(fx.calls[1].args[5]).name === 'Name' && JSON.parse(fx.calls[1].args[5]).desc === '' && JSON.parse(fx.calls[1].args[5]).title === 'Doc');
    check('client: keys go as key codes / characters with modifiers', J(JSON.parse(fx.calls[2].args[5]).chords) === J([{ mods: ['command'], key: 's' }]));
    check('client: an id that was not read is refused before anything runs', /Read the app first/.test((await rejects(() => c.call('invoke', { hwnd: 7, el: 'e99' })))?.message) && fx.calls.length === 3);
    check('client: an id read from another window is refused', /Read the app first/.test((await rejects(() => c.call('invoke', { hwnd: 8, el: 'e1' })))?.message));
  }

  // ---- the tree read into ids
  {
    const raw = { r: 'AXWindow', n: 'Form', p: [], c: [
      { r: 'AXGroup', n: '', p: [0], c: [
        { r: 'AXTextField', n: 'Your name', v: 'Ada', p: [0, 0] },
        { r: 'AXButton', n: 'Greet', p: [0, 1] },
        { r: 'AXTextField', sr: 'AXSecureTextField', n: 'Password', v: 'hunter2-DO-NOT-LEAK', p: [0, 2] },
        { pw: true },
        { r: 'AXCheckBox', n: 'I agree', v: 1, p: [0, 4] },
        { r: 'AXButton', n: 'Off', en: false, p: [0, 5] },
        { r: 'AXStaticText', n: '', v: 'Hello there', p: [0, 6] },
      ] },
    ] };
    const { tree, refs } = macTree.toNodes(raw);
    const text = treeLib.render({ title: 'Form', name: 'TextEdit' }, tree);
    check('tree: roles map to the kinds tree.js knows (AXTextField -> Edit, AXButton -> Button, AXCheckBox -> CheckBox)', /\[e1\] Edit "Your name" = "Ada"/.test(text) && /\[e2\] Button "Greet"/.test(text) && /CheckBox "I agree" \(checked\)/.test(text), text);
    check('tree: ids map to the child-index path, role, name and description', J(refs.get('e1')) === J({ path: [0, 0], role: 'AXTextField', name: 'Your name', desc: '' }) && J(refs.get('e2').path) === '[0,1]');
    const nameless = macTree.toNodes({ r: 'AXWindow', p: [], c: [{ r: 'AXButton', p: [0] }, { r: 'AXButton', p: [1] }, { r: 'AXButton', d: 'Back', p: [2] }, { r: 'AXTextArea', p: [3] }] });
    check('tree: an item with neither name nor description gets no id (it could not be told from another), unless it is the only one of its role', nameless.refs.size === 2 && [...nameless.refs.values()].some((r) => r.desc === 'Back') && [...nameless.refs.values()].some((r) => r.role === 'AXTextArea') && ![...nameless.refs.values()].some((r) => r.role === 'AXButton' && !r.desc));
    check('tree: a secure text field leaves nothing but the count (no name, no value, no id)', !/hunter2|Password"/.test(J(tree)) && /2 password fields left out/.test(text) && ![...refs.values()].some((r) => /Password/.test(r.name)), text);
    check('tree: disabled items say so; static text shows its value', /Button "Off" \(disabled\)/.test(text) && /Hello there/.test(text));
    check('tree: a node without a path (the window itself) gets no id', !tree.i);
    check('tree: unknown roles fall back to their name without AX', macTree.kindOfRole('AXFancyThing') === 'FancyThing' && macTree.kindOfRole('') === 'Element');
  }

  // ---- permissions
  {
    check('permissionOf: "assistive access" and -25211 -> Accessibility', macClient.permissionOf('System Events got an error: osascript is not allowed assistive access. (-1719)') === 'accessibility' && macClient.permissionOf('', -25211) === 'accessibility');
    check('permissionOf: -1719 alone is "invalid index" (an item that went away), not a permission', macClient.permissionOf("System Events got an error: Can't get UI element 3 of window 1. Invalid index. (-1719)", -1719) === '' && macClient.permissionOf('', -1719) === '');
    check('permissionOf: -1743 (Apple events not allowed) -> Automation; anything else -> nothing', macClient.permissionOf('Not authorized to send Apple events to System Events. (-1743)') === 'automation' && macClient.permissionOf('That window is gone.') === '');
    check('the settings links open the right Privacy & Security panes', macClient.PERMISSIONS.accessibility.url === 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' && macClient.PERMISSIONS.screen.url === 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');

    const helperSays = fakeExec(() => ({ stdout: J({ ok: false, error: 'System Events got an error: osascript is not allowed assistive access.', code: -1719 }) }));
    const e1 = await rejects(() => macClient.createMacClient({ execFile: helperSays.execFile, source: () => SOURCE }).call('apps'));
    check('client: the helper reporting -1719 becomes an Accessibility error with its link', e1?.permission === 'accessibility' && /Privacy_Accessibility$/.test(e1.settingsUrl) && /Accessibility/.test(e1.message), e1?.message);
    const crashed = fakeExec(() => ({ err: Object.assign(new Error('Command failed'), { code: 1 }), stderr: 'execution error: Not authorized to send Apple events to System Events. (-1743)' }));
    const e2 = await rejects(() => macClient.createMacClient({ execFile: crashed.execFile, source: () => SOURCE }).call('apps'));
    check('client: osascript failing with -1743 on stderr becomes an Automation error', e2?.permission === 'automation' && /Privacy_Automation$/.test(e2.settingsUrl));
    const mine = fakeExec(() => ({ stdout: J({ ok: false, error: 'That window is gone. (-1719 is in a title)', mine: true }) }));
    const e3 = await rejects(() => macClient.createMacClient({ execFile: mine.execFile, source: () => SOURCE }).call('focus', { hwnd: 1 }));
    check('client: the helper own errors are passed on as they are (fromHelper), not read as permission', e3?.fromHelper === true && !e3.permission);

    const never = fakeExec(() => ok());
    const noAx = macClient.createMacClient({ execFile: never.execFile, source: () => SOURCE, access: { accessibility: () => false, screen: () => true } });
    const e4 = await rejects(() => noAx.call('apps'));
    check('client: no Accessibility (Electron check, no prompt): refused before osascript runs', e4?.permission === 'accessibility' && never.calls.length === 0);
    const shots = fakeExec((file, a) => (file === 'osascript' ? ok({ onscreen: true, title: 'Doc' }) : ok()));
    const noScreen = macClient.createMacClient({ execFile: shots.execFile, source: () => SOURCE, access: { accessibility: () => true, screen: () => false } });
    const e5 = await rejects(() => noScreen.call('shot', { hwnd: 5, pid: 50, w: 400, q: 50 }));
    check('client: no Screen Recording: a screenshot is a Screen Recording error and screencapture never runs', e5?.permission === 'screen' && /Privacy_ScreenCapture$/.test(e5.settingsUrl) && !shots.calls.some((x) => x.file === 'screencapture'));
    check('client: no Screen Recording: the live card just skips (no error, no capture)', (await noScreen.call('frame', { hwnd: 5, pid: 50, title: 'Doc' })).skip === true);
    const removed = [];
    const blank = macClient.createMacClient({ execFile: shots.execFile, source: () => SOURCE, fs: { mkdir: async () => {}, readFile: async () => Buffer.alloc(0), unlink: async (p) => { removed.push(p); } } });
    const e6 = await rejects(() => blank.call('shot', { hwnd: 5, pid: 50, w: 400, q: 50 }));
    check('client: a blank capture (macOS wrote nothing) is read as Screen Recording missing, and the temp files are removed', e6?.permission === 'screen' && removed.length === 2, e6?.message);
    const pic = macClient.createMacClient({ execFile: shots.execFile, source: () => SOURCE, resize: (buf, w) => `R${w}${buf.toString()}`, fs: { mkdir: async () => {}, readFile: async () => Buffer.from('JPG'), unlink: async () => {} } });
    const r = await pic.call('shot', { hwnd: 5, pid: 50, w: 420, q: 55 });
    const cap = shots.calls.find((x) => x.file === 'screencapture');
    check('client: a screenshot is screencapture -l <window id> -x, then resized', r.image === 'R420JPG' && cap && cap.args.includes('-l') && cap.args[cap.args.indexOf('-l') + 1] === '5' && cap.args.includes('-x'));
    const f1 = await pic.call('frame', { hwnd: 5, pid: 50, title: 'Doc', w: 340, q: 50, reset: true });
    const f2 = await pic.call('frame', { hwnd: 5, pid: 50, title: 'Doc', w: 340, q: 50 });
    const f3 = await pic.call('frame', { hwnd: 5, pid: 50, title: 'Other', w: 340, q: 50 });
    check('client: live frames: a picture, then "same" when unchanged, and a new title is reported before any capture', f1.image && f2.same === true && f3.retitle === 'Doc', J([f1, f2, f3]));
  }

  // ---- the permission card in the controller
  {
    const asked = [];
    const opened = [];
    const settings = { master: () => true, terminals: () => false, allowed: () => [], allow: () => {}, setMaster: () => {} };
    const client = { call: async () => { throw macClient.permissionError('accessibility'); }, abort() {}, destroy() {} };
    const d = createDesktop({ platform: 'darwin', client, settings, winapi: { ok: true }, openSettings: async (u) => opened.push(u), lumen: { pid: 1, exe: '/Applications/Lumen.app' } });
    const ctx = { signal: new AbortController().signal, once: new Set(), emit: () => {}, tainted: () => false, ask: async (card) => { asked.push(card); return true; } };
    const e = await rejects(() => d.run({ action: 'list_apps' }, ctx));
    check('controller: a missing permission shows a card with "Open System Settings" and the AI is told what to ask for', /Accessibility/.test(e?.message) && asked.length === 1 && asked[0].allowLabel === 'Open System Settings' && asked[0].noAlways === true && /Accessibility/.test(asked[0].title), J(asked));
    check('controller: the button opens the Accessibility pane (Lumen grants nothing itself)', J(opened) === J(['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']));
    await rejects(() => d.run({ action: 'list_apps' }, ctx));
    check('controller: the card is shown once per run, not on every retry', asked.length === 1 && opened.length === 1);
    const no = createDesktop({ platform: 'darwin', client, settings, winapi: { ok: true }, openSettings: async (u) => opened.push(u), lumen: { pid: 1, exe: '' } });
    await rejects(() => no.run({ action: 'list_apps' }, { ...ctx, signal: new AbortController().signal, ask: async () => false }));
    check('controller: "No" on the card opens nothing', opened.length === 1);
  }

  // ---- the controller on macOS: the same model, with the macOS key parser
  {
    const W = { hwnd: 31, pid: 77, start: 5, proc: 'TextEdit', description: 'TextEdit', bundle: 'com.apple.TextEdit', exe: '/System/Applications/TextEdit.app', title: 'Notes.txt' };
    const T = { hwnd: 32, pid: 78, start: 6, proc: 'Terminal', description: 'Terminal', bundle: 'com.apple.Terminal', exe: '/System/Applications/Utilities/Terminal.app', title: 'bash' };
    const calls = [];
    const client = { call: async (cmd, a) => { calls.push([cmd, a]); return cmd === 'apps' ? { ok: true, apps: [W, T] } : { ok: true, sent: true, foreground: true }; }, abort() {}, destroy() {} };
    const store = { allowed: [{ app: '/system/applications/textedit.app', name: 'TextEdit' }] };
    const settings = { master: () => true, terminals: () => false, allowed: () => store.allowed, allow: () => {}, setMaster: () => {} };
    const api = { ok: true, start() { this.started = (this.started || 0) + 1; }, stop() { this.stopped = (this.stopped || 0) + 1; }, failed: () => false, cursor: () => ({ x: 0, y: 0 }), pidUnderCursor: () => 0, foregroundPid: () => 0, escapeDown: () => false, mouseDown: () => false, typing: () => false };
    const d = createDesktop({ platform: 'darwin', client, settings, winapi: api, banner: { async show() {}, async update() {}, hide() {} }, shortcut: { register() {}, unregister() {} }, lumen: { pid: 1, exe: '/Applications/Lumen.app' } });
    const ctx = { signal: new AbortController().signal, once: new Set(), emit: () => {}, tainted: () => false, ask: async () => true };
    const list = await d.run({ action: 'list_apps' }, ctx);
    check('controller (macOS): list_apps shows an allowed app with its title and hides a terminal', /w31 {2}TextEdit - "Notes\.txt"/.test(list) && !/Terminal/.test(list.split('\n').filter((l) => /^w/.test(l)).join('\n')) && /never available/.test(list), list);
    const out = await d.run({ action: 'press_keys', args: { name: 'TextEdit', keys: 'cmd+s' } }, ctx);
    const sent = calls.find((c) => c[0] === 'keys');
    check('controller (macOS): press_keys sends cmd+s as a macOS chord to the approved window', /Pressed cmd\+s in TextEdit/.test(out) && sent && J(sent[1].chords) === J([{ mods: ['command'], key: 's' }]) && sent[1].hwnd === 31 && sent[1].start === 5);
    check('controller (macOS): the Esc / takeover checks start with the session', api.started === 1);
    const q = await rejects(() => d.run({ action: 'press_keys', args: { name: 'TextEdit', keys: 'cmd+q' } }, ctx));
    check('controller (macOS): cmd+q is refused before anything is sent', /quits the app/.test(q?.message) && calls.filter((c) => c[0] === 'keys').length === 1);
    const t = await rejects(() => d.run({ action: 'read_app', args: { name: 'Terminal' } }, ctx));
    check('controller (macOS): Terminal is refused with the reason', /terminal/i.test(t?.message));
    d.finishRun(ctx.signal);
    check('controller (macOS): the checks stop when the run ends', api.stopped >= 1);
    const broken = createDesktop({ platform: 'darwin', client, settings, winapi: { ...api, failed: () => true }, banner: { async show() {}, async update() {}, hide() {} }, lumen: { pid: 1, exe: '' } });
    const b = await rejects(() => broken.run({ action: 'focus_app', args: { name: 'TextEdit' } }, ctx));
    check('controller (macOS): if the Esc / takeover checks cannot run, the AI does not use apps at all', /could not start/.test(b?.message));
  }

  // ---- the never list on macOS
  {
    const base = { master: true, terminals: false, allowed: [], once: new Set(), lumenPid: 4242, lumenExe: '/Applications/Lumen.app' };
    const mac = (name, bundle, dir = '/Applications', title = 'x', extra = {}) => ({ proc: name, description: name, bundle, exe: `${dir}/${name}.app`, title, pid: 9, ...extra });
    const never = [
      ['Keychain Access', mac('Keychain Access', 'com.apple.keychainaccess', '/System/Applications/Utilities')],
      ['Passwords', mac('Passwords', 'com.apple.Passwords', '/System/Applications')],
      ['1Password', mac('1Password', 'com.1password.1password')],
      ['1Password 7', mac('1Password 7', 'com.agilebits.onepassword7')],
      ['Bitwarden', mac('Bitwarden', 'com.bitwarden.desktop')],
      ['System Settings', mac('System Settings', 'com.apple.systempreferences', '/System/Applications', 'Privacy & Security')],
      ['Activity Monitor', mac('Activity Monitor', 'com.apple.ActivityMonitor', '/System/Applications/Utilities')],
      ['Script Editor', mac('Script Editor', 'com.apple.ScriptEditor2', '/System/Applications/Utilities')],
      ['loginwindow', mac('loginwindow', 'com.apple.loginwindow', '/System/Library/CoreServices')],
      ['SecurityAgent', mac('SecurityAgent', 'com.apple.SecurityAgent', '/System/Library/Frameworks/Security.framework/Versions/A/MachServices')],
      ['a bank in Safari', mac('Safari', 'com.apple.Safari', '/Applications', 'Chase Online - Online Banking')],
      ['Lumen by its bundle path', mac('Lumen', 'com.lumen.browser', '/Applications', 'New tab', { pid: 5 })],
      ['Lumen by pid (a development build is Electron.app)', mac('Electron', 'com.github.Electron', '/tmp', 'Lumen', { pid: 4242 })],
      ['a renamed app is still what its bundle id says (Terminal)', mac('Notes2', 'com.apple.Terminal')],
    ];
    for (const [label, win] of never) {
      const all = policy.decide(win, { ...base, allowed: [{ app: policy.exeKey(win.exe) }], once: new Set([policy.exeKey(win.exe)]) });
      check(`never (macOS): ${label} is blocked, even when listed and allowed once`, all.status === 'blocked' && all.reason.length > 20, J(all));
    }
    const terminal = mac('Terminal', 'com.apple.Terminal', '/System/Applications/Utilities');
    const iterm = mac('iTerm', 'com.googlecode.iterm2');
    check('terminals (macOS): Terminal and iTerm are blocked unless "Also allow terminals" is on, and then they ask', policy.decide(terminal, base).status === 'blocked' && policy.decide(iterm, base).status === 'blocked' && policy.decide(terminal, { ...base, terminals: true }).status === 'ask' && policy.decide(iterm, { ...base, terminals: true }).status === 'ask');
    const word = mac('Microsoft Word', 'com.microsoft.Word');
    check('macOS: an ordinary app asks first, keyed by its bundle path (forward slashes kept, lower case)', policy.decide(word, base).status === 'ask' && policy.decide(word, base).app === '/applications/microsoft word.app' && policy.decide(word, base).name === 'Microsoft Word');
    check('macOS: an approval covers that bundle path only, not a copy elsewhere', policy.decide(word, { ...base, allowed: [{ app: '/applications/microsoft word.app' }] }).status === 'allow' && policy.decide({ ...word, exe: '/Users/me/Downloads/Microsoft Word.app' }, { ...base, allowed: [{ app: '/applications/microsoft word.app' }] }).status === 'ask');
    check('macOS: Word, TextEdit and Pages are document apps; Safari, Mail and Finder are not', policy.isDocumentApp(word) && policy.isDocumentApp(mac('TextEdit', 'com.apple.TextEdit')) && policy.isDocumentApp(mac('Pages', 'com.apple.iWork.Pages')) && !policy.isDocumentApp(mac('Safari', 'com.apple.Safari')) && !policy.isDocumentApp(mac('Mail', 'com.apple.mail')) && !policy.isDocumentApp(mac('Finder', 'com.apple.finder')));
    check('macOS: Finder and VS Code carry the "can start a terminal" warning', /terminal/.test(policy.decide(mac('Finder', 'com.apple.finder', '/System/Library/CoreServices'), base).warn) && /terminal/.test(policy.decide(mac('Visual Studio Code', 'com.microsoft.VSCode'), base).warn));
    check('clean: keeps macOS bundle paths, drops never-apps and bare names', J(policy.clean([{ app: '/Applications/Microsoft Word.app', name: 'Microsoft Word' }, { app: '/System/Applications/Utilities/Keychain Access.app' }, { app: 'TextEdit' }, { app: '/bin/sh' }])) === J([{ app: '/applications/microsoft word.app', name: 'Microsoft Word', added: 0 }]));
    check('Windows paths are unchanged (backslashes, lower case)', policy.exeKey('C:/Office/WINWORD.EXE') === 'c:\\office\\winword.exe' && policy.baseOf('C:\\Office\\WINWORD.EXE') === 'winword' && policy.baseOf('/Applications/Microsoft Word.app') === 'microsoft word');
  }

  // ---- keys on macOS
  {
    const bad = (k) => { try { keys.parseKeysMac(k); return ''; } catch (e) { return e.message; } };
    check('keys (macOS): cmd+s, a sequence, named keys and F-keys', J(keys.parseKeysMac('cmd+s').chords) === J([{ mods: ['command'], key: 's' }]) && J(keys.parseKeysMac('cmd+a cmd+c').chords.map((c) => c.key)) === '["a","c"]' && keys.parseKeysMac('Enter').chords[0].code === 36 && keys.parseKeysMac('shift+tab').chords[0].code === 48 && keys.parseKeysMac('f5').chords[0].code === 96 && J(keys.parseKeysMac('ctrl+option+shift+x').chords[0].mods) === J(['control', 'option', 'shift']));
    check('keys (macOS): Cmd+Q, Cmd+Tab, Cmd+Space, Option+Cmd+Esc, Ctrl+Cmd+Q, Shift+Cmd+Q, Ctrl+arrows, fn and the Windows key are refused', /quits/.test(bad('cmd+q')) && /switches/.test(bad('cmd+tab')) && /Spotlight/.test(bad('cmd+space')) && /Force Quit/.test(bad('cmd+option+esc')) && /locks/.test(bad('ctrl+cmd+q')) && /logs out/.test(bad('cmd+shift+q')) && /Spaces/.test(bad('ctrl+left')) && /fn/.test(bad('fn+f')) && /cmd/.test(bad('win+r')) && /Not a key/.test(bad('cmd+launch')));
    check('keys (macOS): function keys only on their own; F3 and F11 never', keys.parseKeysMac('f5').chords[0].code === 96 && /only on its own/.test(bad('cmd+f5')) && /only on its own/.test(bad('ctrl+f2')) && /only on its own/.test(bad('option+f12')) && /only on its own/.test(bad('shift+f1')) && /Mission Control/.test(bad('f3')) && /Mission Control/.test(bad('F11')));
    check('keys (macOS): typed characters are data, not syntax', J(keys.parseKeysMac('"').chords[0]) === J({ mods: [], key: '"' }));
  }

  // ---- open_app: only what it found in the Applications folders
  {
    const dirs = { '/Applications': ['Microsoft Word.app', 'Notes.txt', 'TextEdit Plus.app'], '/System/Applications': ['TextEdit.app'] };
    const readdir = (d) => { if (!dirs[d]) throw new Error('ENOENT'); return dirs[d]; };
    const found = macClient.findApps('textedit', { readdir, dirs: Object.keys(dirs) });
    check('findApps: matches .app bundles by name, exact first-class, with full paths', J(found.map((f) => [f.exe, f.exact])) === J([['/Applications/TextEdit Plus.app', false], ['/System/Applications/TextEdit.app', true]]));
    const ids = { '/System/Applications/TextEdit.app': 'com.apple.TextEdit\n' };
    const fx = fakeExec((file, a) => (file === 'plutil' ? (ids[a[a.length - 1].replace('/Contents/Info.plist', '')] ? { stdout: ids[a[a.length - 1].replace('/Contents/Info.plist', '')] } : { err: new Error('no key') }) : ok()));
    const c = macClient.createMacClient({ execFile: fx.execFile, source: () => SOURCE, readdir, dirs: Object.keys(dirs) });
    const r = await c.call('resolve', { name: 'TextEdit' });
    check('resolve: each found app gets its bundle id from Contents/Info.plist through plutil (argument array, no shell)', r.found.find((f) => f.exact).bundle === 'com.apple.TextEdit' && r.found.find((f) => !f.exact).bundle === '' && fx.calls.filter((x) => x.file === 'plutil').length === 2 && J(fx.calls[0].args) === J(macClient.plistArgs('/Applications/TextEdit Plus.app')));
    const before = fx.calls.length;
    await c.call('launch', { key: '/System/Applications/TextEdit.app' });
    check('launch: open -a <the path resolve found>', fx.calls.length === before + 1 && fx.calls[before].file === 'open' && J(fx.calls[before].args) === J(['-a', '/System/Applications/TextEdit.app']));
    const e = await rejects(() => c.call('launch', { key: '/System/Applications/Utilities/Terminal.app' }));
    check('launch: a path resolve did not return is never started', /Only an app open_app found/.test(e?.message) && fx.calls.length === before + 1);
    const e2 = await rejects(() => c.call('launch', { key: '/Applications/TextEdit Plus.app' }));
    check('launch: an app whose bundle id could not be read is not started', /could not be checked/.test(e2?.message) && fx.calls.length === before + 1);

    // the controller: the bundle id is part of the check made before anything starts
    const launched = [];
    const settings = { master: () => true, terminals: () => false, allowed: () => [], allow: () => {}, setMaster: () => {} };
    const notes = [{ name: 'Notes', exe: '/Applications/Notes.app', key: '/Applications/Notes.app', exact: true, bundle: 'com.apple.Terminal' }];
    const client = { call: async (cmd) => { if (cmd === 'launch') launched.push(1); return cmd === 'resolve' ? { ok: true, found: notes } : cmd === 'apps' ? { ok: true, apps: [] } : { ok: true }; }, abort() {}, destroy() {} };
    const d = createDesktop({ platform: 'darwin', client, settings, winapi: { ok: true }, lumen: { pid: 1, exe: '/Applications/Lumen.app' } });
    const asked = [];
    const blockedOpen = await rejects(() => d.run({ action: 'open_app', args: { name: 'Notes' } }, { signal: new AbortController().signal, once: new Set(), emit: () => {}, tainted: () => false, ask: async (card) => { asked.push(card); return true; } }));
    check('open_app: a renamed blocked app (Notes.app whose bundle id is Terminal) is refused before it starts, without a card', /terminal/i.test(blockedOpen?.message) && launched.length === 0 && asked.length === 0, blockedOpen?.message);
  }

  // ---- Stop kills what is running
  {
    const fx = fakeExec(() => 'hang');
    const c = macClient.createMacClient({ execFile: fx.execFile, source: () => SOURCE });
    const p = rejects(() => c.call('keys', { hwnd: 1, chords: [] }));
    await new Promise((r) => setImmediate(r));
    c.abort('Stopped by the user.');
    const e = await p;
    check('client: abort kills the running osascript and the call ends as aborted', e?.aborted === true && fx.calls[0].child.killed === true);
  }

  // ---- the Esc / takeover probe
  {
    let t = 1000;
    const spawned = [];
    const spawn = (file, args) => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.kill = () => { c.killed = true; }; spawned.push({ file, args, c }); return c; };
    const p = macProbe.load({ spawn, source: () => SOURCE, now: () => t });
    check('probe: nothing runs until a session starts', p.ok && spawned.length === 0 && p.escapeDown() === false && p.failed() === false);
    p.start();
    check('probe: osascript -l JavaScript -e <fixed script>', spawned.length === 1 && spawned[0].file === 'osascript' && J(spawned[0].args.slice(0, 4)) === J(['-l', 'JavaScript', '-e', SOURCE]));
    spawned[0].c.stdout.emit('data', `${J({ esc: true, typing: false, down: false, x: 5, y: 6, front: 77, under: 77 })}\n${J({ esc: true, typing: true, down: true, x: 9, y: 9, front: 77, under: 78 })}\n`);
    check('probe: the latest line answers the checks', p.escapeDown() && p.typing() && p.mouseDown() && J(p.cursor()) === J({ x: 9, y: 9 }) && p.foregroundPid() === 77 && p.pidUnderCursor() === 78 && !p.failed());
    t += macProbe.STALE_MS + 10;
    check('probe: a stream that stopped coming is "failed" and answers nothing (Esc is not trusted to work)', p.failed() && !p.escapeDown() && p.cursor() === null);
    p.stop();
    check('probe: stop kills it and clears the state', spawned[0].c.killed === true && p.failed() === false);
    p.start();
    spawned[1].c.emit('exit', 1);
    check('probe: a probe that ended with an error is "failed"', p.failed() === true);
  }

  // ---- mac-helper.jxa itself, run in a Node sandbox against a stand-in System Events (never the real one)
  {
    const vm = require('vm');
    const SRC = require('fs').readFileSync(macClient.SCRIPT, 'utf8');
    // A small model of one app (pid 77) and its windows: elements answer role(), name()... like System Events specifiers, and record what is sent.
    const world = (opts = {}) => {
      const w = { front: 77, focused: null, focusThrows: false, sent: [], raised: [], onKey: null };
      const el = (o) => {
        const e = { _v: o.value ?? '', uiElements: o.kids || [] };
        Object.assign(e, { role: () => o.role, subrole: () => o.subrole || '', name: () => o.name || '', description: () => o.desc || '', position: () => o.pos || [10, 10], size: () => o.size || [50, 20] });
        Object.defineProperty(e, 'value', { get: () => () => e._v, set: (v) => { if (o.fixedValue) throw new Error('not settable'); e._v = v; if (w.onSet) w.onSet(e); } });
        Object.defineProperty(e, 'focused', { get: () => () => w.focused === e, set: () => { if (o.focusable !== false) w.focused = e; } });
        e.actions = { name: () => ['AXPress', 'AXRaise'], byName: (n) => ({ perform: () => { if (n === 'AXRaise') w.raised.push(o.name); else w.sent.push(['press', o.name]); } }) };
        e.attributes = { byName: () => ({ value: () => false }) };
        return e;
      };
      w.el = el;
      const wins = opts.build ? opts.build(el) : [el({ role: 'AXWindow', name: 'Doc', pos: [0, 0], size: [800, 600], kids: opts.kids || [] })];
      const coll = Object.assign([...wins], { position: () => wins.map((x) => x.position()), size: () => wins.map((x) => x.size()), name: () => wins.map((x) => x.name()) });
      const proc = { windows: coll, attributes: { byName: () => ({ value: () => { if (w.focusThrows) throw new Error('AXError'); return w.focused; } }) } };
      Object.defineProperty(proc, 'frontmost', { set: () => { if (!opts.stuckBehind) w.front = 77; } });
      const send = (rec) => { w.sent.push(rec); if (w.onKey) w.onKey(rec); };
      const se = { processes: { whose: (q) => (q.unixId === 77 ? [proc] : []) }, keystroke: (t, o) => send(['keystroke', t, o || null]), keyCode: (c, o) => send(['keyCode', c, o || null]), click: () => send(['click']) };
      const app = { activationPolicy: 0, processIdentifier: 77, localizedName: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit', bundleURL: { isNil: () => false, path: '/System/Applications/TextEdit.app' }, launchDate: { isNil: () => false, timeIntervalSince1970: 5 }, hidden: false };
      const cg = opts.cg || [{ kCGWindowLayer: 0, kCGWindowNumber: 31, kCGWindowOwnerPID: 77, kCGWindowName: opts.cgTitle || '', kCGWindowIsOnscreen: true, kCGWindowBounds: { X: 0, Y: 0, Width: 800, Height: 600 } }];
      const $ = (x) => x;
      $.NSWorkspace = { sharedWorkspace: { runningApplications: { count: 1, objectAtIndex: () => app }, get frontmostApplication() { return { isNil: () => false, processIdentifier: w.front }; } } };
      $.CGWindowListCopyWindowInfo = () => cg;
      const ctx = vm.createContext({ ObjC: { import() {}, unwrap: (x) => x, deepUnwrap: (x) => x, castRefToObject: (x) => x }, $, Application: () => se, delay: () => {} });
      vm.runInContext(SRC, ctx);
      w.call = (cmd, data) => JSON.parse(ctx.run([cmd, JSON.stringify({ hwnd: 31, pid: 77, start: 5000, ...data })]));
      return w;
    };
    const keysSent = (w) => w.sent.filter((x) => x[0] === 'keystroke' || x[0] === 'keyCode');

    // (1) keys: the focus is checked before every chord; a focus that cannot be read counts as a password field
    {
      const w = world();
      w.focused = w.el({ role: 'AXTextField', name: 'Search' });
      const r = w.call('keys', { chords: [{ mods: ['command'], key: 's' }, { mods: [], code: 36 }] });
      check('helper keys: with an ordinary focus every chord is sent', r.ok && keysSent(w).length === 2 && J(keysSent(w)[0]) === J(['keystroke', 's', { using: ['command down'] }]), J(r));
      const secure = world();
      secure.focused = secure.el({ role: 'AXTextField', subrole: 'AXSecureTextField', name: 'Password' });
      const r2 = secure.call('keys', { chords: [{ mods: ['command'], key: 'v' }] });
      check('helper keys: focus on a password field -> refused, nothing sent', !r2.ok && /password field/.test(r2.error) && keysSent(secure).length === 0, J(r2));
      const blind = world();
      blind.focusThrows = true;
      const r3 = blind.call('keys', { chords: [{ mods: [], code: 36 }] });
      check('helper keys: a focus that cannot be read is treated as a password field (fails closed)', !r3.ok && /could not be checked/.test(r3.error) && keysSent(blind).length === 0, J(r3));
      const none = world();
      const r4 = none.call('keys', { chords: [{ mods: [], code: 36 }] });
      check('helper keys: no focused item at all -> refused', !r4.ok && keysSent(none).length === 0);
      const mid = world();
      mid.focused = mid.el({ role: 'AXTextField', name: 'Search' });
      mid.onKey = () => { mid.focused = mid.el({ role: 'AXTextField', subrole: 'AXSecureTextField', name: 'PIN' }); };
      const r5 = mid.call('keys', { chords: [{ mods: [], key: 'a' }, { mods: [], key: 'b' }, { mods: [], key: 'c' }] });
      check('helper keys: focus moving to a password field mid-sequence stops before the next chord', !r5.ok && keysSent(mid).length === 1 && /after 1 of the keys/.test(r5.error), J(r5));
      const behind = world({ stuckBehind: true });
      behind.front = 12;
      behind.focused = behind.el({ role: 'AXTextField', name: 'x' });
      const r6 = behind.call('keys', { chords: [{ mods: [], code: 36 }] });
      check('helper keys: another app in front that will not give way -> refused, nothing sent', !r6.ok && /Another app/.test(r6.error) && keysSent(behind).length === 0);
    }

    // (1) and (4) type: the focus is confirmed on the element before Cmd+A or typing, and checked before every piece and before Enter
    {
      const typing = (o = {}, data = {}) => {
        const w = world({ build: (el) => { const fld = el({ role: 'AXTextArea', name: 'Body', fixedValue: true, ...o }); w0.fld = fld; return [el({ role: 'AXWindow', name: 'Doc', pos: [0, 0], size: [800, 600], kids: [fld] })]; } });
        return w;
      };
      let w0 = {};
      const w = typing();
      const r = w.call('settext', { path: [0], role: 'AXTextArea', name: 'Body', desc: '', text: 'hello world, this is longer than sixteen' });
      check('helper type: a field that cannot be set is focused, then Cmd+A and the text go in pieces of 16', r.ok && r.method === 'keys' && J(keysSent(w).map((x) => x[1])) === J(['a', 'hello world, thi', 's is longer than', ' sixteen']), J(keysSent(w)));
      w0 = {};
      const nf = typing({ focusable: false });
      const r2 = nf.call('settext', { path: [0], role: 'AXTextArea', name: 'Body', desc: '', text: 'hi' });
      check('helper type: focus could not be put on the item -> refused before Cmd+A or any typing', !r2.ok && /could not put the keyboard focus/.test(r2.error) && keysSent(nf).length === 0, J(r2));
      w0 = {};
      const moved = typing();
      moved.onKey = (rec) => { if (rec[1] !== 'a') moved.focused = moved.el({ role: 'AXTextField', subrole: 'AXSecureTextField', name: 'Password' }); };
      const r3 = moved.call('settext', { path: [0], role: 'AXTextArea', name: 'Body', desc: '', text: 'x'.repeat(40) });
      check('helper type: focus moving to a password field stops typing before the next piece', !r3.ok && /password field/.test(r3.error) && keysSent(moved).length === 2, J(keysSent(moved)));
      w0 = {};
      const away = typing();
      away.onKey = (rec) => { if (rec[1] !== 'a') away.focused = away.el({ role: 'AXTextField', name: 'Other' }); };
      const r4 = away.call('settext', { path: [0], role: 'AXTextArea', name: 'Body', desc: '', text: 'x'.repeat(40) });
      check('helper type: focus moving to another item stops typing', !r4.ok && /left that item/.test(r4.error) && keysSent(away).length === 2, J(r4));
      w0 = {};
      const sub = typing({ role: 'AXTextField', name: 'To', fixedValue: false });
      sub.onSet = () => { sub.focused = sub.el({ role: 'AXTextField', subrole: 'AXSecureTextField', name: 'Password' }); };
      const r5 = sub.call('settext', { path: [0], role: 'AXTextField', name: 'To', desc: '', text: 'ada@example.com', submit: true });
      check('helper type: the value is set directly, but Enter is not pressed once the focus is on a password field', !r5.ok && /password field/.test(r5.error) && keysSent(sub).length === 0 && w0.fld._v === 'ada@example.com', J(r5));
      w0 = {};
      const ok2 = typing({ role: 'AXTextField', name: 'To', fixedValue: false });
      const r6 = ok2.call('settext', { path: [0], role: 'AXTextField', name: 'To', desc: '', text: 'ada', submit: true });
      check('helper type: value set, focus still on the field -> Enter is pressed', r6.ok && r6.method === 'value' && J(keysSent(ok2)) === J([['keyCode', 36, null]]), J(r6));

      // (3) the element at the path must still have the same role, name and description
      w0 = {};
      const stale = typing({ desc: 'Message body' });
      const r7 = stale.call('settext', { path: [0], role: 'AXTextArea', name: 'Body', desc: 'Subject', text: 'hi' });
      check('helper: an id whose element now has another description is refused as stale', !r7.ok && /changed since it was read/.test(r7.error) && keysSent(stale).length === 0, J(r7));
      w0 = {};
      const gone = typing();
      const r8 = gone.call('settext', { path: [5], role: 'AXTextArea', name: 'Body', desc: '', text: 'hi' });
      check('helper: a path that no longer exists is "gone", not a permission problem', !r8.ok && /gone/.test(r8.error) && r8.mine === true);
      w0 = {};
      const pw = typing({ subrole: 'AXSecureTextField', role: 'AXTextField', name: 'Password' });
      const r9 = pw.call('settext', { path: [0], role: 'AXTextField', name: 'Password', desc: '', text: 'x' });
      check('helper: typing into a secure text field is refused', !r9.ok && /password field/.test(r9.error) && w0.fld._v === '');
    }

    // (7) two windows of the app at the same place and size
    {
      const two = (a, b, cgTitle = '') => world({ cgTitle, build: (el) => [el({ role: 'AXWindow', name: a, pos: [0, 0], size: [800, 600] }), el({ role: 'AXWindow', name: b, pos: [0, 0], size: [800, 600] })] });
      const w = two('Report A', 'Report B');
      const r = w.call('focus', { title: 'Report B' });
      check('helper: same place and size -> the approved title picks the window', r.ok && J(w.raised) === J(['Report B']), J([r, w.raised]));
      const w2 = two('Report A', 'Report B');
      const r2 = w2.call('focus', { title: '' });
      check('helper: same place and size and no title to tell them apart -> refused', !r2.ok && /same place and size/.test(r2.error) && w2.raised.length === 0, J(r2));
      const w3 = two('Untitled', 'Untitled');
      w3.focused = w3.el({ role: 'AXTextField', name: 'x' });
      const r3 = w3.call('keys', { title: 'Untitled', chords: [{ mods: [], code: 36 }] });
      check('helper: same place, size and title -> refused, nothing sent', !r3.ok && /same place and size/.test(r3.error) && keysSent(w3).length === 0);
      const one = world({ build: (el) => [el({ role: 'AXWindow', name: 'Renamed', pos: [0, 0], size: [800, 600] })] });
      check('helper: one window at that place is used even if its title changed since', one.call('focus', { title: 'Old title' }).ok && J(one.raised) === J(['Renamed']));
    }
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
