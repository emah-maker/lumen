// [device access] Settings > AI > "Let the AI use files on this computer" (features/device-access.js, agent.js localFiles,
// dragTool, clipboardTool), plain Node (no Electron, no network): resolving what the model wrote to a path, the places that
// are never reachable (Lumen's profile, credentials folders, .env files), list_files, upload_file paths through the real tool
// layer with a stand-in tab (off by default, the card, nothing set when refused), drag through a stand-in DevTools session,
// the clipboard, and the pinch-zoom setting.
require('./_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../src/features/device-access');
const { Agent, EXTERNAL_TOOLS, validateInput } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const J = JSON.stringify;

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-device-')));
const profile = path.join(home, 'Library', 'Application Support', 'Lumen');
const opts = { home, profile };
for (const dir of ['Desktop/shots', 'Downloads', '.ssh', 'Library/Application Support/Lumen', 'project']) fs.mkdirSync(path.join(home, dir), { recursive: true });
const put = (rel, data = 'x', ageMin = 0) => { const p = path.join(home, rel); fs.writeFileSync(p, data); const t = Date.now() / 1000 - ageMin * 60; fs.utimesSync(p, t, t); return p; };
put('Desktop/old.png', 'png', 60);
put('Desktop/Screenshot 2026-10-08.png', 'png', 1);
put('Desktop/notes.txt', 'hi', 30);
put('Desktop/.hidden', 'h');
put('Desktop/empty.png', '', 90);
put('.ssh/id_ed25519', 'secret');
put('project/.env', 'KEY=1');
put('project/.env.example', 'KEY=');
put('Library/Application Support/Lumen/Cookies', 'c');
fs.symlinkSync(path.join(home, '.ssh/id_ed25519'), path.join(home, 'Desktop/sneaky.png'));
{ const t = Date.now() / 1000 - 120 * 60; fs.utimesSync(path.join(home, 'Desktop/shots'), t, t); }

(async () => {
  // ---- what the model wrote -> a path
  {
    const r = (raw) => D.resolvePath(raw, opts);
    check('~/, file://, quoted, bare-name and relative forms all land under the home folder', r('~/Desktop/a.png') === path.join(home, 'Desktop/a.png') && r(`file://${home}/Desktop/a%20b.png`) === path.join(home, 'Desktop/a b.png') && r(`"${home}/x"`) === path.join(home, 'x') && r('desktop') === path.join(home, 'Desktop') && r('Downloads/f.pdf') === path.join(home, 'Downloads/f.pdf') && r('~') === home, J([r('~/Desktop/a.png'), r('desktop')]));
    check('dot-dots are normalized away (the block list sees the real place)', r('~/Desktop/../.ssh/id_ed25519') === path.join(home, '.ssh/id_ed25519'));
    check('empty, NUL and network paths are refused', ['', '  ', 'a\0b', '//server/share/x', '\\\\server\\share'].every((v) => throws(() => r(v))), J(['', 'a\0b'].map((v) => throws(() => r(v)))));
  }

  // ---- never reachable
  {
    const b = (rel) => D.blockedReason(path.join(home, rel), opts);
    check('Lumen\'s own profile is out of reach', /Lumen's own profile/.test(b('Library/Application Support/Lumen/Cookies')) && /profile/.test(b('Library/Application Support/Lumen')));
    check('credentials folders are out of reach', ['.ssh/id_rsa', '.aws/credentials', '.gnupg/x', 'Library/Keychains/login.keychain-db', '.config/gh/hosts.yml'].every((x) => b(x)), J(['.ssh/id_rsa', '.aws/credentials'].map(b)));
    check('.env and key files anywhere are out of reach; .env.example is not', b('project/.env') && b('project/.env.local') && b('Desktop/server.pem') && b('Desktop/id_rsa') && !b('project/.env.example') && !b('Desktop/photo.png'), J([b('project/.env.example')]));
    check('a link on the Desktop pointing at a key is refused by where it really goes', /credentials/.test(throws(() => D.checkedPath('~/Desktop/sneaky.png', 'file', opts)) || ''), throws(() => D.checkedPath('~/Desktop/sneaky.png', 'file', opts)));
    check('a folder or a missing file is refused for upload, with the reason', /is a folder/.test(throws(() => D.checkedPath('~/Desktop/shots', 'file', opts)) || '') && /does not exist/.test(throws(() => D.checkedPath('~/Desktop/nope.png', 'file', opts)) || ''));
  }

  // ---- list_files
  {
    const out = D.listFiles({}, opts);
    const lines = out.split('\n');
    check('the Desktop by default, newest first, folders marked, hidden files left out', /^~\/Desktop \(/.test(lines[0]) && lines[1].endsWith('Screenshot 2026-10-08.png') && out.includes('shots/') && !out.includes('.hidden') && out.indexOf('notes.txt') < out.indexOf('old.png'), out);
    check('links into credentials are not even listed', !out.includes('sneaky.png'), out);
    check('match takes a glob or words', D.listFiles({ match: '*.png' }, opts).includes('old.png') && !D.listFiles({ match: '*.png' }, opts).includes('notes.txt') && D.listFiles({ match: 'screenshot 10' }, opts).includes('Screenshot 2026-10-08.png'));
    check('limit cuts and says how many more', /… \d+ more/.test(D.listFiles({ limit: 1 }, opts)), D.listFiles({ limit: 1 }, opts));
    check('hidden:true shows dot files', D.listFiles({ hidden: true }, opts).includes('.hidden'));
    check('listing a credentials folder or the profile is refused', /credentials/.test(throws(() => D.listFiles({ folder: '~/.ssh' }, opts)) || '') && /profile/.test(throws(() => D.listFiles({ folder: '~/Library/Application Support/Lumen' }, opts)) || ''));
    check('it ends by saying how to upload one by path', /upload_file's paths/.test(out));
  }

  // ---- the tools as every engine sees them
  {
    const names = EXTERNAL_TOOLS.map((t) => t.name);
    check('drag, list_files and clipboard are listed to every engine and MCP client', ['drag', 'list_files', 'clipboard'].every((n) => names.includes(n)), J(names));
    const up = EXTERNAL_TOOLS.find((t) => t.name === 'upload_file');
    check('upload_file lists paths and still needs only element_id', Boolean(up.input_schema.properties.paths) && J(up.input_schema.required) === '["element_id"]');
    check('short descriptions (every message pays for them)', EXTERNAL_TOOLS.filter((t) => ['drag', 'list_files', 'clipboard'].includes(t.name)).every((t) => t.description.length < 220));
    check('drag needs a from and a to', /from_id|from_x/.test(validateInput('drag', { to_id: 3 }) || '') && /to_id|to_x/.test(validateInput('drag', { from_id: 3 }) || '') && validateInput('drag', { from_id: 1, to_x: 3, to_y: 4 }) === null, J([validateInput('drag', { to_id: 3 }), validateInput('drag', { from_id: 1, to_x: 3, to_y: 4 })]));
    check('clipboard needs read or write', validateInput('clipboard', { action: 'read' }) === null && Boolean(validateInput('clipboard', { action: 'erase' })) && Boolean(validateInput('clipboard', {})));
  }

  // ---- the tool layer, with a stand-in tab
  {
    const state = { url: 'https://forms.example.com/new', access: false, auto: false, bypass: false, calls: [], dragIntercept: false, clip: 'copied words' };
    const listeners = new Set();
    const dbg = {
      isAttached: () => true, attach() {}, detach() {}, on: (_n, fn) => listeners.add(fn), removeListener: (_n, fn) => listeners.delete(fn),
      sendCommand: async (method, params) => {
        state.calls.push([method, params]);
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1 && state.dragIntercept) for (const fn of listeners) fn({}, 'Input.dragIntercepted', { data: { items: [], dragOperationsMask: 1 } });
        return method === 'Runtime.evaluate' ? { result: { objectId: 'obj-1' } } : {};
      },
    };
    const probe = { status: 'input', how: 'input', label: 'Photo', tag: 'input', accept: 'image/*', multiple: true, disabled: false, directory: false };
    const wc = {
      id: 7, debugger: dbg, getURL: () => state.url, isDestroyed: () => false, isLoading: () => false, on() {}, removeListener() {}, getZoomFactor: () => 1,
      executeJavaScriptInIsolatedWorld: async (_w, [{ code }]) => {
        if (code.includes("removeAttribute('data-lumen-upload')")) return true;
        if (code.includes('const wanted =')) return { files: ['Screenshot 2026-10-08.png'], shown: [true], alerts: [], events: { input: 1, change: 1 } };
        if (code.includes("status: 'missing'")) return probe;
        return 'quiet';
      },
    };
    const tab = { id: 1, webContents: wc };
    const clipboard = { readText: () => state.clip, writeText: (t) => { state.clip = t; } };
    const browser = {
      activeTab: () => tab, tabById: (id) => (id === 1 ? tab : null), listTabs: () => [{ id: 1, title: 't', url: state.url, active: true }],
      effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0,
      autoApprove: () => state.auto, bypassPermissions: () => state.bypass, handsOff: () => false, isAiTab: () => false, tabOff: () => false, typingText: () => '',
      deviceAccess: () => state.access, profileDir: () => profile, clipboard,
    };
    const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5' }));
    agent.closeSignedInTabs = () => {};
    agent.newActionLog = () => ({});
    agent.undoSummary = () => null;
    agent.uploads = { resolve: () => [] };
    agent.taskTabInFront = () => true;
    agent.locateElement = async (_wc, id) => ({ 1: { x: 10, y: 20 }, 2: { x: 110, y: 220 } }[id] || null);
    const signal = new AbortController().signal;
    const events = [];
    let hosts = new Set();
    let answer = true;
    const emit = (e) => { events.push(e); if (e.type === 'approval') setImmediate(() => agent.resolveApproval(e.approvalId, /^upload/.test(e.action || '') ? answer : true)); };
    const chatMessages = () => { const m = []; m.settings = { model: 'claude-opus-5' }; return m; };
    const call = (name, input, { external = false } = {}) => agent.inTask(1, signal, async () => {
      await agent.ensureAllowed(name, emit, signal, { hosts, who: external ? 'Claude Code' : 'Claude', external, input, run: external ? { tainted: false } : undefined });
      return agent.execute(name, input);
    }, chatMessages(), null, { chatId: 'a1b2c3d4e5f60718', hosts });
    const cards = () => events.filter((e) => e.type === 'approval' && /^upload/.test(e.action));
    const sets = () => state.calls.filter(([m]) => m === 'DOM.setFileInputFiles');
    const reset = () => { events.length = 0; state.calls.length = 0; hosts = new Set(); state.access = false; state.auto = false; state.bypass = false; answer = true; state.dragIntercept = false; };
    const shot = path.join(home, 'Desktop/Screenshot 2026-10-08.png');

    reset();
    let msg = await refused(() => call('upload_file', { element_id: 1, paths: ['~/Desktop/Screenshot 2026-10-08.png'] }));
    check('off by default: paths are refused with how to turn it on, nothing set', /Let the AI use files on this computer/.test(msg || '') && sets().length === 0, msg);
    msg = await refused(() => call('list_files', {}));
    check('off by default: list_files is refused the same way', /Let the AI use files on this computer/.test(msg || ''), msg);
    msg = await refused(() => call('clipboard', { action: 'read' }));
    check('off by default: reading the clipboard is refused', /Let the AI use files on this computer/.test(msg || ''), msg);

    // with the setting on (and the user's real home swapped for the test one through the absolute paths)
    reset(); state.access = true;
    const done = await call('upload_file', { element_id: 1, paths: [shot] });
    const set = sets()[0]?.[1];
    check('on: the file is set on the field after one card that names it and the site', set && J(set.files) === J([shot]) && cards().length === 1 && /Screenshot 2026-10-08\.png/.test(cards()[0].title) && /forms\.example\.com/.test(cards()[0].title) && /Put Screenshot/.test(done), J([set, cards().map((c) => c.title), done]));
    state.calls.length = 0;
    await call('upload_file', { element_id: 1, paths: [shot] });
    check('the next upload to the same site in the chat does not ask again', cards().length === 1 && sets().length === 1);

    reset(); state.access = true; answer = false;
    msg = await refused(() => call('upload_file', { element_id: 1, paths: [shot] }));
    check('a declined card uploads nothing', /did not allow/.test(msg || '') && sets().length === 0, msg);

    reset(); state.access = true; state.bypass = true;
    await call('upload_file', { element_id: 1, paths: [shot] });
    check('Bypass permissions: no card, the file is set', cards().length === 0 && sets().length === 1, J(cards()));

    reset(); state.access = true;
    msg = await refused(() => call('upload_file', { element_id: 1, paths: [path.join(home, '.ssh/id_ed25519')] }));
    check('a key file is refused before any card, nothing set', /credentials/.test(msg || '') && cards().length === 0 && sets().length === 0, msg);
    msg = await refused(() => call('upload_file', { element_id: 1, paths: [path.join(profile, 'Cookies')] }));
    check('a file in Lumen\'s profile is refused', /profile/.test(msg || '') && sets().length === 0, msg);
    msg = await refused(() => call('upload_file', { element_id: 1, paths: [path.join(home, 'Desktop/empty.png')] }));
    check('an empty file is refused with its name', /empty/.test(msg || '') && sets().length === 0, msg);
    msg = await refused(() => call('upload_file', { element_id: 1, paths: [path.join(home, 'Desktop/notes.txt')] }));
    check('a file the field does not accept is refused before the card', /accepts/.test(msg || '') && cards().length === 0 && sets().length === 0, msg);

    reset(); state.access = true;
    const listed = await call('list_files', { folder: path.join(home, 'Desktop'), match: '*.png' });
    check('on: list_files lists the folder', listed.includes('Screenshot 2026-10-08.png') && !listed.includes('notes.txt'), listed);
    const clip = await call('clipboard', { action: 'read' });
    check('on: the clipboard is read, marked as untrusted', clip.includes('copied words') && clip.includes('<untrusted_page_content>'), clip);
    reset();
    await call('clipboard', { action: 'write', text: 'hello' });
    check('writing the clipboard needs no setting', state.clip === 'hello');

    // drag
    reset();
    const moved = await call('drag', { from_id: 1, to_id: 2 });
    const mouse = state.calls.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p]) => p);
    check('drag: press at the source, held moves, release at the target', mouse[1]?.type === 'mousePressed' && mouse[1].x === 10 && mouse[1].y === 20 && mouse.at(-1).type === 'mouseReleased' && mouse.at(-1).x === 110 && mouse.at(-1).y === 220 && mouse.filter((p) => p.type === 'mouseMoved' && p.buttons === 1).length >= 10 && /held/.test(moved), J(mouse.slice(0, 3)));
    reset();
    state.dragIntercept = true;
    const dropped = await call('drag', { from_id: 1, to_id: 2 });
    const drags = state.calls.filter(([m]) => m === 'Input.dispatchDragEvent').map(([, p]) => p.type);
    check('drag: an HTML5 drag-and-drop gets enter, over and drop at the target', J(drags) === '["dragEnter","dragOver","drop"]' && /drag-and-drop/.test(dropped), J([drags, dropped]));
    check('drag: drag interception is switched off again', J(state.calls.filter(([m]) => m === 'Input.setInterceptDrags').map(([, p]) => p.enabled)) === '[true,false]');
    reset();
    msg = await refused(() => call('drag', { from_x: 5, from_y: 5, to_id: 2 }));
    check('drag by screenshot point needs a screenshot first', /screenshot/i.test(msg || ''), msg);
    msg = await refused(() => call('drag', { from_id: 9, to_id: 2 }));
    check('drag from a stale id says to read again', /No element with id 9/.test(msg || ''), msg);
  }

  // ---- pinch zoom: on by default, a real setting
  {
    const backend = fs.readFileSync(path.join(__dirname, '../src/settings/settings-backend.js'), 'utf8');
    check('pinchZoom defaults on and aiDeviceAccess defaults off', /pinchZoom: true,/.test(backend) && /aiDeviceAccess: false,/.test(backend));
    check('every tab gets the visual zoom limits, again after each navigation', /function pinchZoom\(wc\)/.test(backend) && /setVisualZoomLevelLimits\(1, max\)/.test(backend) && (backend.match(/pinchZoom\(wc\);/g) || []).length >= 2);
  }

  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
