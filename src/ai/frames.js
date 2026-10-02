// Embedded frames (iframes) for the AI's page tools: a claude.ai artifact, a Google Docs or Notion
// embed, a CodePen, a payment widget. Claude's page scripts run in the main frame only (agent.js
// runScript, page-text.js), and an iframe's document is out of their reach: cross-origin, or out of
// process altogether (an OOPIF, a frame of another site, which site isolation puts in its own renderer).
//
// Each frame is read where it is instead, through the tab's DevTools session (main.js applyChromeIdentity
// attaches one to every tab and auto-attaches every out-of-process frame as a flat child session,
// which track() records): Page.createIsolatedWorld in that frame (the same DOM, its own globals, so
// the page can neither see the read nor tamper with it, as with Claude's world in the main frame) and
// Runtime.evaluate there. Electron's WebFrameMain.executeJavaScript runs in the frame's main world, so
// it is never used. A frame in the main frame's process is reached through the main session; a frame
// of another process through its own session (that session's frame tree holds it and its same-process
// children).
//
// Frames too small to be content (ad and tracking pixels), hidden ones, frames below a hidden one and
// frames on a site where the user turned AI off are not read. Elements of a frame get ids that name the
// frame: frame n's element k is n * ID_BASE + k (main-frame ids stay 1, 2, …), so click / type_text /
// hover find them in that frame's registry. Frame numbers are kept per tab until the top page changes.
//
// Without a DevTools session (another debugger has the tab) no frame is read: the main frame's own
// walk then reaches same-origin frames, as before.

const WORLD = 'lumen-claude-frames';
const ID_BASE = 100000;
const MAX_FRAMES = 16;
const MAX_DEPTH = 4;
const MIN_SIZE = 16; // px: anything narrower or shorter is a pixel, not content
const FRAME_CHARS = 4000; // text from one frame
const FRAMES_CHARS = 10000; // text from all frames of a page

// ---- out-of-process frames: the flat child sessions of each tab's debugger
const sessionsOf = new WeakMap(); // webContents -> Map(sessionId -> targetId)

// Called before the tab's debugger auto-attaches to its frames (main.js), so no session is missed.
function track(wc) {
  if (!wc?.debugger || sessionsOf.has(wc)) return;
  const sessions = new Map();
  sessionsOf.set(wc, sessions);
  wc.debugger.on('message', (_e, method, params) => {
    if (method === 'Target.attachedToTarget' && params?.targetInfo?.type === 'iframe') sessions.set(params.sessionId, params.targetInfo.targetId);
    else if (method === 'Target.detachedFromTarget') sessions.delete(params?.sessionId);
  });
  wc.debugger.on('detach', () => sessions.clear());
}

const available = (wc) => {
  try { return Boolean(!wc.isDestroyed?.() && wc.debugger?.isAttached?.()); } catch { return false; }
};

// ---- ids
const encodeId = (n, k) => n * ID_BASE + k;
const decodeId = (id) => (Number.isInteger(id) && id > ID_BASE ? { n: Math.floor(id / ID_BASE), k: id % ID_BASE } : null);

// ---- labels: "[embedded frame: claude.site — Artifact]"
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
function siteOf(url) {
  if (!/^https?:/i.test(url || '')) return 'inline';
  try { return new URL(url).host; } catch { return 'inline'; }
}
// (Page text goes inside <untrusted_page_content>: a frame's title can't close it.)
const defang = (s) => String(s).replace(/<(\/?)untrusted_page_content/gi, '‹$1untrusted_page_content');
const labelOf = (frame, title) => defang(`[embedded frame: ${siteOf(frame.url)}${clean(title, 80) ? ` — ${clean(title, 80)}` : ''}]`);

// The main text and the frames' text in one string of at most `cap` characters. The frames get the room
// the main text leaves, and at least 40% of it when there are any; each is headed by its label.
function compose(mainText, frameTexts, cap) {
  const main = String(mainText || '');
  const parts = frameTexts.filter((f) => String(f.text || '').trim());
  if (!parts.length) return main.slice(0, cap);
  const blocks = parts.map((f) => `\n\n${f.label}\n${defang(String(f.text).trim())}${f.totalTextChars > f.text.length ? '\n[frame text cut short]' : ''}`);
  const framesLen = blocks.reduce((n, b) => n + b.length, 0);
  const frameRoom = Math.min(framesLen, Math.max(cap - main.length, Math.floor(cap * 0.4)));
  const mainPart = main.slice(0, cap - frameRoom);
  let rest = frameRoom;
  let out = mainPart;
  for (const b of blocks) {
    if (rest <= 0) break;
    out += b.slice(0, rest);
    rest -= b.length;
  }
  return out;
}

// ---- the DevTools side
const send = (wc, method, params = {}, sessionId) => wc.debugger.sendCommand(method, params, sessionId);

function within(promise, ms, what = 'The frame did not respond.') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); })]).finally(() => clearTimeout(timer));
}

async function worldIn(wc, frameId, sessionId) {
  const { executionContextId } = await send(wc, 'Page.createIsolatedWorld', { frameId, worldName: WORLD, grantUniveralAccess: false }, sessionId);
  if (!Number.isInteger(executionContextId)) throw new Error('No isolated world in the frame.');
  return executionContextId;
}

// Evaluates `script` in Claude's isolated world of a frame from list() and returns its value.
async function run(wc, frame, script, timeoutMs = 10000, { userGesture = false } = {}) {
  const exec = async () => {
    const contextId = await worldIn(wc, frame.id, frame.sessionId);
    const out = await send(wc, 'Runtime.evaluate', { expression: script, contextId, returnByValue: true, awaitPromise: true, silent: true, userGesture }, frame.sessionId);
    if (out?.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description?.split('\n')[0] || out.exceptionDetails.text || 'Script failed in the frame.');
    return out?.result?.value;
  };
  return within(exec(), timeoutMs, 'The embedded frame did not respond. Try again.');
}

// Where a frame's element (<iframe>) is in its parent's viewport, and whether it is shown.
function ownerBox() {
  const r = this.getBoundingClientRect();
  const s = this.ownerDocument.defaultView.getComputedStyle(this);
  const shown = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  return { x: r.left + this.clientLeft + (parseFloat(s.paddingLeft) || 0), y: r.top + this.clientTop + (parseFloat(s.paddingTop) || 0), w: this.clientWidth, h: this.clientHeight, shown };
}
async function boxOf(wc, frame, parent) {
  const { backendNodeId } = await send(wc, 'DOM.getFrameOwner', { frameId: frame.id }, parent.sessionId);
  const executionContextId = await worldIn(wc, parent.id, parent.sessionId);
  const { object } = await send(wc, 'DOM.resolveNode', { backendNodeId, executionContextId }, parent.sessionId);
  try {
    const out = await send(wc, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: ownerBox.toString(), returnByValue: true, silent: true }, parent.sessionId);
    return out?.result?.value || null;
  } finally {
    send(wc, 'Runtime.releaseObject', { objectId: object.objectId }, parent.sessionId).catch(() => {});
  }
}

const numbers = new WeakMap(); // webContents -> { loaderId, byFrame: Map(frameId -> n), next }
function numberOf(wc, loaderId, frameId) {
  let state = numbers.get(wc);
  if (!state || state.loaderId !== loaderId) numbers.set(wc, state = { loaderId, byFrame: new Map(), next: 1 });
  if (!state.byFrame.has(frameId)) state.byFrame.set(frameId, state.next++);
  return state.byFrame.get(frameId);
}

// The tab's readable frames, top to bottom: [{ n, id, sessionId, url, x, y, w, h, depth }] (x, y: the
// frame's content box in the tab's viewport, CSS px), plus how many were left out because AI is off on
// their site. allow(url): false for such a site. [] without a DevTools session.
async function list(wc, { allow = () => true, timeoutMs = 3000 } = {}) {
  if (!available(wc)) return { frames: [], aiOff: 0 };
  const build = async () => {
    const nodes = new Map(); // frameId -> { id, parentId, url, sessionId }
    const add = (tree, sessionId, root) => {
      const f = tree?.frame;
      if (!f?.id) return;
      if (!nodes.has(f.id) || (root && sessionId)) nodes.set(f.id, { id: f.id, parentId: f.parentId, url: `${f.url || ''}${f.urlFragment || ''}`, sessionId });
      for (const child of tree.childFrames || []) add(child, sessionId, false);
    };
    const { frameTree: top } = await send(wc, 'Page.getFrameTree');
    add(top, undefined, true);
    const sessions = [...(sessionsOf.get(wc)?.keys() || [])];
    const trees = await Promise.all(sessions.map((sid) => send(wc, 'Page.getFrameTree', {}, sid).then((r) => [sid, r.frameTree]).catch(() => null)));
    for (const entry of trees) if (entry) add(entry[1], entry[0], true);
    const children = new Map();
    for (const node of nodes.values()) {
      if (!node.parentId || !nodes.has(node.parentId)) continue;
      if (!children.has(node.parentId)) children.set(node.parentId, []);
      children.get(node.parentId).push(node);
    }
    const out = [];
    let aiOff = 0;
    let level = [{ node: nodes.get(top.frame.id), x: 0, y: 0, depth: 0 }];
    while (level.length && out.length < MAX_FRAMES) {
      const next = [];
      await Promise.all(level.map(async (parent) => {
        if (parent.depth >= MAX_DEPTH) return;
        for (const node of children.get(parent.node.id) || []) {
          const box = await boxOf(wc, node, parent.node).catch(() => null);
          if (!box || !box.shown || box.w < MIN_SIZE || box.h < MIN_SIZE) continue;
          if (!allow(node.url)) { aiOff++; continue; }
          next.push({ node, x: parent.x + box.x, y: parent.y + box.y, w: box.w, h: box.h, depth: parent.depth + 1 });
        }
      }));
      next.sort((a, b) => a.depth - b.depth || a.y - b.y || a.x - b.x);
      for (const f of next) {
        if (out.length >= MAX_FRAMES) break;
        out.push({ n: numberOf(wc, top.frame.loaderId, f.node.id), id: f.node.id, sessionId: f.node.sessionId, url: f.node.url, x: Math.round(f.x), y: Math.round(f.y), w: f.w, h: f.h, depth: f.depth });
      }
      level = next;
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x || a.depth - b.depth);
    return { frames: out, aiOff };
  };
  try { return await within(build(), timeoutMs); } catch { return { frames: [], aiOff: 0 }; }
}

// The frame an element id names (decodeId), freshly placed, or null when it is gone.
async function find(wc, n, opts) {
  const { frames } = await list(wc, opts);
  return frames.find((f) => f.n === n) || null;
}

// Runs `script` in every listed frame (each bounded by timeoutMs); [{ frame, value }] for those that answered.
async function each(wc, frames, script, timeoutMs = 3000) {
  const out = await Promise.all(frames.map((frame) => run(wc, frame, typeof script === 'function' ? script(frame) : script, timeoutMs)
    .then((value) => ({ frame, value }), () => null)));
  return out.filter(Boolean);
}

// The text of each readable frame: [{ label, url, text, totalTextChars }], at most FRAME_CHARS each and
// FRAMES_CHARS in all. textScript(chars) is page-text.js's script ({ title, text, totalTextChars }).
async function readTexts(wc, textScript, { allow, timeoutMs = 2000 } = {}) {
  const started = Date.now();
  const { frames } = await list(wc, { allow, timeoutMs });
  const left = Math.max(300, timeoutMs - (Date.now() - started));
  const read = await each(wc, frames, textScript(FRAME_CHARS), left);
  let room = FRAMES_CHARS;
  const out = [];
  for (const { frame, value } of read) {
    const text = String(value?.text || '').trim();
    if (!text || room <= 0) continue;
    out.push({ label: labelOf(frame, value.title), url: frame.url, text: text.slice(0, room), totalTextChars: value.totalTextChars ?? text.length });
    room -= Math.min(text.length, room);
  }
  return out;
}

// ---- input into frames, through the DevTools session: Electron's sendInputEvent misses frames of
// another process in a tab that isn't composited on screen, and its insertText into such a frame
// crashed the page's renderer. Coordinates are CSS px of the tab's viewport.
async function mouseClick(wc, x, y) {
  await send(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const mouseMove = (wc, x, y) => send(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const insertText = (wc, text) => send(wc, 'Input.insertText', { text });
// A key (agent.js KEY_CODES names, or one character) to the focused frame: Electron's key events go to
// the main frame's widget, which a frame of another process never hears.
const VK = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35, Space: 32, Delete: 46 };
const MODIFIER_BITS = { alt: 1, control: 2, meta: 4, shift: 8 };
async function pressKey(wc, key, modifiers = []) {
  const bits = modifiers.reduce((n, m) => n | (MODIFIER_BITS[m] || 0), 0);
  const char = key === 'Enter' ? '\r' : key === 'Space' ? ' ' : [...key].length === 1 ? key : '';
  const code = VK[key] ?? (char ? char.toUpperCase().charCodeAt(0) : 0);
  const name = key === 'Space' ? ' ' : key;
  const text = char && !modifiers.some((m) => m !== 'shift') ? char : undefined;
  await send(wc, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, windowsVirtualKeyCode: code, modifiers: bits, ...(text ? { text, unmodifiedText: text } : {}) });
  await send(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key: name, windowsVirtualKeyCode: code, modifiers: bits });
}
// (In Claude's world of the main frame: is the focus inside one of its frames?)
const FOCUS_IN_FRAME = "Boolean(document.activeElement && /^I?FRAME$/.test(document.activeElement.tagName))";

module.exports = {
  WORLD, ID_BASE, MAX_FRAMES, MIN_SIZE, FRAME_CHARS, FRAMES_CHARS,
  track, available, encodeId, decodeId, siteOf, labelOf, defang, compose, list, find, run, each, readTexts, mouseClick, mouseMove, insertText, pressKey, FOCUS_IN_FRAME,
};
