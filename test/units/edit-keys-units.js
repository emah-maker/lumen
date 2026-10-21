// The AI's edit shortcuts (features/edit-keys.js, ai/agent.js press_key / editShortcut). Plain Node, fakes only:
// the Ctrl/Cmd + letter mapping, the clipboard snapshot and restore, a sidebar run that gets the user's clipboard back, an outside
// agent that keeps a private buffer, and the refusals (kept-off tab, hands-off mode) that apply as for typing.
require('../helpers/_tmp-cleanup');
const E = require('../../src/features/edit-keys');
const H = require('../../src/features/agent-hands-off');
const { Agent } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  // ---- the key mapping
  const map = (k, m) => E.editCommand(k, m);
  check('Ctrl+A/C/V/X/Z/Y map to selectAll, copy, paste, cut, undo, redo', ['a', 'c', 'v', 'x', 'z', 'y'].map((k) => map(k, ['control'])).join() === 'selectAll,copy,paste,cut,undo,redo');
  check('Cmd (meta) means the same, and so does an upper-case letter', map('v', ['meta']) === 'paste' && map('V', ['control']) === 'paste');
  check('Ctrl+Shift+Z is redo, Ctrl+Shift+V pastes as plain text', map('z', ['control', 'shift']) === 'redo' && map('v', ['control', 'shift']) === 'pasteAndMatchStyle');
  check('other keys are not edit commands: plain letters, Shift+letter, Alt combos, Ctrl+other letters, arrows, Ctrl+Home',
    [map('v', []), map('Z', ['shift']), map('v', ['control', 'alt']), map('b', ['control']), map('ArrowDown', ['control', 'shift']), map('Home', ['control']), map('Enter', ['control']), map('v', undefined), map(undefined, ['control'])].every((c) => c === null));
  check('cut, copy and paste touch the clipboard; undo, redo and select all do not', ['cut', 'copy', 'paste', 'pasteAndMatchStyle'].every(E.touchesClipboard) && !['undo', 'redo', 'selectAll'].some(E.touchesClipboard));

  // ---- the snapshot (this Electron's clipboard is the async web one: read() / write() with ClipboardItems, readText() a Promise)
  class Item {
    constructor(parts) { this.parts = parts; this.types = Object.keys(parts); }
    getType(type) { return Promise.resolve(this.parts[type]); }
  }
  const makeClip = (init) => {
    const c = { parts: { ...init }, writes: 0, ClipboardItem: Item };
    return Object.assign(c, {
      read: async () => (Object.keys(c.parts).length ? [new Item(c.parts)] : []),
      readText: async () => c.parts['text/plain'] || '',
      writeText: async (t) => { c.writes++; c.parts = { 'text/plain': t }; },
      write: async (items) => { c.writes++; c.parts = { ...items[0].parts }; },
      clear: () => { c.writes++; c.parts = {}; },
    });
  };
  const IMAGE = { tag: 'png bytes' };
  {
    const clip = makeClip({ 'text/plain': 'hello', 'text/html': '<b>hello</b>', 'image/png': IMAGE });
    const snap = await E.snapshotClipboard(clip);
    await clip.writeText('something else');
    await E.restoreClipboard(clip, snap);
    check('the snapshot restores text, html and image', clip.parts['text/plain'] === 'hello' && clip.parts['text/html'] === '<b>hello</b>' && clip.parts['image/png'] === IMAGE, JSON.stringify(clip.parts));
    const none = makeClip({});
    const snap2 = await E.snapshotClipboard(none);
    await none.writeText('x');
    await E.restoreClipboard(none, snap2);
    check('an empty clipboard is restored as empty', Object.keys(none.parts).length === 0);
    await E.restoreClipboard(none, null);
    const broken = { read: async () => { throw new Error('no'); } };
    check('a clipboard that cannot be read gives no snapshot, and restoring nothing does nothing', (await E.snapshotClipboard(broken)) === null && Object.keys(none.parts).length === 0);
  }

  // ---- the tool layer
  const state = { calls: [], sys: makeClip({ 'text/plain': 'user copied this', 'text/html': '<i>user</i>' }), off: false, hands: false, ai: false, editorText: '', selection: 'picked text', frame: false };
  const wc = {
    id: 50, isLoading: () => false, executeJavaScriptInIsolatedWorld: async () => undefined, executeJavaScript: async () => undefined, isDestroyed: () => false, getTitle: () => 't', getURL: () => 'https://docs.test/d',
    cut: () => { state.calls.push('cut'); if (state.selection) state.sys.writeText(state.selection); },
    copy: () => { state.calls.push('copy'); if (state.selection) state.sys.writeText(state.selection); },
    paste: () => { state.calls.push('paste'); state.editorText += state.sys.parts['text/plain'] || ''; },
    pasteAndMatchStyle: () => { state.calls.push('pasteAndMatchStyle'); },
    undo: () => state.calls.push('undo'), redo: () => state.calls.push('redo'), selectAll: () => state.calls.push('selectAll'),
    insertText: (t) => { state.calls.push('insertText'); state.editorText += t; },
  };
  const browser = {
    activeTab: () => ({ id: 5, webContents: wc }), tabById: (id) => (id === 5 ? { id, webContents: wc } : null),
    listTabs: () => [{ id: 5, title: 't', url: wc.getURL(), active: true }],
    effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'none', maxSteps: () => 0, autoApprove: () => false, bypassPermissions: () => false,
    handsOff: () => state.hands, isAiTab: () => state.ai, tabOff: () => state.off, typingText: () => '', deviceAccess: () => true, profileDir: () => '', clipboard: state.sys,
  };
  const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5' }));
  agent.closeSignedInTabs = () => {};
  agent.taskTabInFront = () => true;
  agent.waitForUserTyping = async () => {};
  agent.focusInFrame = async () => state.frame;
  const signal = new AbortController().signal;
  const txt = () => state.sys.parts['text/plain'];
  const key = (k, modifiers) => ['press_key', { key: k, ...(modifiers ? { modifiers } : {}) }];
  const sidebar = async (list) => {
    const out = [];
    const chat = []; chat.settings = { model: 'claude-opus-5' };
    await agent.inTask(5, signal, async () => { for (const [n, i] of list) out.push(await agent.execute(n, i).catch((e) => `ERROR: ${e.message}`)); }, chat, null, { chatId: 'a1b2c3d4e5f60718', hosts: new Set(['docs.test']) });
    return out;
  };
  const asAgent = async (list, priv) => {
    const out = [];
    await agent.inTask(5, signal, async () => { for (const [n, i] of list) out.push(await agent.execute(n, i).catch((e) => `ERROR: ${e.message}`)); }, null, null, { mcp: true, rec: {}, clipboard: priv });
    return out;
  };

  // sidebar: cut, paste; the user's clipboard comes back at the end of the run
  let out = await sidebar([key('x', ['control']), key('v', ['control'])]);
  check('the sidebar AI\'s Ctrl+X and Ctrl+V run the native cut and paste on the page', state.calls.join() === 'cut,paste' && state.editorText === 'picked text', JSON.stringify({ calls: state.calls, out }));
  check('...and the user\'s clipboard is back when the run ends', txt() === 'user copied this' && state.sys.parts['text/html'] === '<i>user</i>', JSON.stringify(state.sys.parts));
  state.calls.length = 0;
  out = await sidebar([key('a', ['control']), key('z', ['control']), key('y', ['control'])]);
  check('select all, undo and redo run natively and never snapshot or touch the clipboard', state.calls.join() === 'selectAll,undo,redo' && txt() === 'user copied this', JSON.stringify({ calls: state.calls, out }));
  // a run that fails still puts the clipboard back
  await state.sys.writeText('user copied this');
  const chat = []; chat.settings = {};
  await agent.inTask(5, signal, async () => { await agent.execute('press_key', { key: 'x', modifiers: ['control'] }); throw new Error('boom'); }, chat, null, { chatId: 'a1b2c3d4e5f60718', hosts: new Set(['docs.test']) }).catch(() => {});
  check('a run that throws still gets the user\'s clipboard back', txt() === 'user copied this', txt());
  // something the user copies mid-run is theirs: the end-of-run restore leaves it alone
  await state.sys.writeText('user copied this');
  const midRun = []; midRun.settings = {};
  await agent.inTask(5, signal, async () => {
    await agent.execute('press_key', { key: 'x', modifiers: ['control'] });
    await state.sys.writeText('copied by the user during the run');
  }, midRun, null, { chatId: 'a1b2c3d4e5f60718', hosts: new Set(['docs.test']) });
  check('a clipboard the user changed mid-run is not overwritten by the restore', txt() === 'copied by the user during the run', txt());
  await state.sys.writeText('user copied this');
  await sidebar([key('x', ['control'])]);
  check('...while an untouched one (still what the AI left) is restored', txt() === 'user copied this', txt());

  // the user's request to put text on their clipboard stays
  await sidebar([['clipboard', { action: 'write', text: 'FOR THE USER' }], key('c', ['control'])]);
  check('a clipboard write by the AI stays, even when the run also copied (what it copied is rolled back)', txt() === 'FOR THE USER', txt());
  await state.sys.writeText('FOR THE USER');
  await sidebar([['clipboard', { action: 'write', text: 'FOR THE USER' }]]);
  check('on its own, a clipboard write stays after the run', txt() === 'FOR THE USER', txt());

  // an outside agent: private buffer
  await state.sys.write([new Item({ 'text/plain': 'user copied this', 'text/html': '<i>user</i>' })]);
  state.calls.length = 0; state.editorText = '';
  const priv = H.privateClipboard();
  out = await asAgent([key('x', ['control']), key('v', ['control'])], priv);
  check('an outside agent\'s cut lands in its own buffer, and its paste types that text in', priv.readText() === 'picked text' && state.editorText === 'picked text' && state.calls.join() === 'cut,insertText', JSON.stringify({ priv: priv.readText(), calls: state.calls, out }));
  check('...the system clipboard is the user\'s again right away (text and html)', txt() === 'user copied this' && state.sys.parts['text/html'] === '<i>user</i>', JSON.stringify(state.sys.parts));
  state.calls.length = 0;
  out = await asAgent([key('v', ['control'])], H.privateClipboard());
  check('with an empty buffer an outside agent pastes nothing, never the user\'s clipboard', !state.calls.includes('paste') && !state.calls.includes('insertText') && /empty/.test(out[0]), JSON.stringify(out));
  state.selection = '';
  out = await asAgent([key('c', ['control'])], H.privateClipboard());
  check('copying with nothing selected says so and leaves the clipboard alone', /nothing was selected/.test(out[0]) && txt() === 'user copied this', JSON.stringify({ out, sys: txt() }));
  state.selection = 'picked text';
  state.frame = true; state.calls.length = 0;
  out = await asAgent([key('v', ['control'])], (() => { const p = H.privateClipboard(); p.writeText('abc'); return p; })());
  check('in a frame an outside agent\'s paste goes through the frame (never wc.insertText there)', !state.calls.includes('insertText'), JSON.stringify(out));
  state.frame = false;

  // refusals apply as for typing
  state.calls.length = 0; state.off = true;
  out = await sidebar([key('x', ['control']), key('v', ['control']), key('a', ['control'])]);
  check('a tab kept off the AI refuses every edit shortcut and nothing runs', out.every((o) => /keeps the AI from acting on this tab/.test(o)) && state.calls.length === 0, JSON.stringify({ out, calls: state.calls }));
  out = await asAgent([key('x', ['control']), key('v', ['control'])], H.privateClipboard());
  check('...for an outside agent too', out.every((o) => /keeps the AI from acting on this tab/.test(o)) && state.calls.length === 0, JSON.stringify(out));
  state.off = false; state.hands = true; state.ai = false;
  out = await sidebar([key('x', ['control']), key('v', ['control']), key('z', ['control'])]);
  check('hands-off mode refuses them on a tab the AI did not open', out.every((o) => /^ERROR/.test(o)) && state.calls.length === 0, JSON.stringify({ out, calls: state.calls }));
  state.ai = true;
  out = await sidebar([key('x', ['control'])]);
  check('...and allows them in a tab the AI opened', state.calls.join() === 'cut', JSON.stringify({ out, calls: state.calls }));
  state.hands = false;

  const msg = await refused(() => agent.execute('press_key', { key: 'v', modifiers: ['control'] }));
  check('called outside any run it still works (no scope, nothing to restore)', msg === null || !/Cannot read/.test(msg), msg);

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
