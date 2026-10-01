// The readable text of a tab, for what goes with a sidebar message: the page context, the tabs picked
// with "@" and the read_tabs tool (agent.js).
//
// Electron's executeJavaScriptInIsolatedWorld holds every call until the page has stopped loading
// (did-stop-loading), and a page is "loading" while any image, video, ad or iframe of it is still on
// its way. Asking about a page that was still loading waited out the 4 s timeout and then sent no page
// text at all (measured: a page with one slow image, 4,005 ms and an empty context, on every message).
//
// The text is read at once instead, through the tab's DevTools session (main.js applyChromeIdentity
// attaches one to every tab): a named isolated world (Page.createIsolatedWorld: the same DOM, its own
// globals, so the page can neither see the read nor tamper with it, as with Claude's world in
// agent.js), evaluated without waiting for the load. A document still being parsed is read once it is
// parsed (at most PARSE_WAIT_MS). Without that session (another debugger has the tab), the read goes
// the old way: Electron's isolated world, after the load.
//
// Only text is read: no element registry (read_page's), so a page with thousands of links costs a few
// milliseconds, and the ids read_page gave the model are left as they were.

const TEXT_CHUNK = 12000; // as read_page's first chunk (page-scripts.js)
const PARSE_WAIT_MS = 1500;
const WORLD_NAME = 'lumen-page-text';

// The script: { url, title, text (the first `chars` characters), totalTextChars }.
function textScript(chars = TEXT_CHUNK) {
  const n = Math.max(0, Math.floor(Number(chars) || 0));
  return `(async () => {
    if (document.readyState === 'loading') {
      await new Promise((done) => { document.addEventListener('DOMContentLoaded', done, { once: true }); setTimeout(done, ${PARSE_WAIT_MS}); });
    }
    const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
    return { url: location.href, title: document.title, text: text.slice(0, ${n}), totalTextChars: text.length };
  })()`;
}

// The read through the DevTools session; null when it can't be used (the caller falls back).
async function readViaDevTools(wc, script) {
  const dbg = wc.debugger;
  if (!dbg || typeof dbg.isAttached !== 'function' || !dbg.isAttached()) return null;
  const send = (method, params) => dbg.sendCommand(method, params);
  const { frameTree } = await send('Page.getFrameTree');
  const frame = frameTree?.frame;
  if (!frame?.id) return null;
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD_NAME, grantUniveralAccess: false });
  if (!Number.isInteger(executionContextId)) return null;
  const out = await send('Runtime.evaluate', { expression: script, contextId: executionContextId, returnByValue: true, awaitPromise: true, silent: true });
  if (out?.exceptionDetails) return null;
  // A new page committed meanwhile: what came back may be the old page's (or no page's). Read again the old way.
  const after = await send('Page.getFrameTree');
  if (after?.frameTree?.frame?.loaderId !== frame.loaderId) return null;
  const value = out?.result?.value;
  return value && typeof value === 'object' ? value : null;
}

// The page's text, or a rejection: a page that didn't answer in timeoutMs, a closed tab.
// fallback(script, timeoutMs): the old way (agent.js runScript, in Claude's isolated world).
async function readPageText(wc, { chars = TEXT_CHUNK, timeoutMs = 4000, fallback } = {}) {
  const script = textScript(chars);
  const started = Date.now();
  let timer;
  const fast = Promise.race([
    readViaDevTools(wc, script).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
  const value = await fast;
  if (value) return value;
  if (wc.isDestroyed?.()) throw new Error('The tab was closed.');
  if (typeof fallback !== 'function') throw new Error('The page did not respond.');
  return fallback(script, Math.max(1, timeoutMs - (Date.now() - started)));
}

module.exports = { readPageText, textScript, TEXT_CHUNK, WORLD_NAME };
