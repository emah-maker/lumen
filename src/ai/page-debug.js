// Debugging aids for the AI's tools (get_console, get_network, wait_for network_idle, JS dialogs). Shared by the sidebar agent
// and the MCP server, since both run agent.js's tools. Everything here is built on Electron's own events, so a tab pays
// nothing until the AI first works in it:
//   - the page's console: webContents 'console-message' (uncaught errors arrive there too) and 'render-process-gone';
//   - its requests: session.webRequest.onSendHeaders / onCompleted / onErrorOccurred. The ad blocker and the Safe Browsing
//     gate own onBeforeRequest and onHeadersReceived (Electron keeps ONE listener per event per session), so those are
//     left alone, and none of the three used here is registered anywhere else. They are added to a session when its first
//     tab is watched and removed (set to null) when its last watched tab is gone. A request the blocker cancels shows up
//     in onErrorOccurred as net::ERR_BLOCKED_BY_CLIENT and never "starts", so it cannot hold a network_idle wait;
//   - JS dialogs: Page.javascriptDialogOpening on the tab's debugger. Every ordinary tab already has one attached with the
//     Page domain on (main.js applyChromeIdentity); this only listens and answers, it never attaches (another debugger
//     there means no dialog control, and handle_dialog says so).
// Capture starts when a tab is first watched (the AI's first tool call there), so a first get_console / get_network can only
// show what happened since then, and the output says so.
// Pure formatting and policy live here too (no Electron needed), so test/page-debug-units.js runs them with fakes.

const { IdleTracker } = require('./idle-tracker');

const CONSOLE_CAP = 300;
const REQUEST_CAP = 500;
const DEFAULT_LINES = 100;
const MAX_LINES = 300;
const TEXT_CAP = 300; // characters of one console message
const OPEN_CAP = 500; // requests tracked as in flight at once (a leak guard: one that never ends is dropped)

class Ring {
  constructor(cap) { this.cap = cap; this.items = []; }
  push(item) { this.items.push(item); if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap); }
  all() { return this.items; }
  get length() { return this.items.length; }
}

// ---- console entries

// Electron 35+ passes one event with level ('info'|'warning'|'error'|'debug'), message, lineNumber and sourceId; older
// versions passed (event, level 0-3, message, line, sourceId). Both end up as { level, text, line, source }.
function normalizeConsole(a, b, c, d, e) {
  let level, text, line, source;
  if (a && typeof a === 'object' && 'message' in a) ({ level, message: text, lineNumber: line, sourceId: source } = a);
  else { level = b; text = c; line = d; source = e; }
  if (typeof level === 'number') level = ['debug', 'info', 'warning', 'error'][level] || 'info';
  level = ['error', 'warning', 'info', 'debug'].includes(level) ? level : 'info';
  return { level, text: String(text ?? ''), line: Number.isFinite(line) ? line : 0, source: String(source ?? '') };
}

// "https://x.com/static/app.js?v=3" -> "app.js"; "" stays "".
function sourceName(source) {
  const clean = String(source || '').split(/[?#]/)[0];
  return clean.slice(clean.lastIndexOf('/') + 1) || clean;
}

// ---- request entries

// Electron's resourceType -> the label shown and filtered on. webRequest does not tell fetch() from XMLHttpRequest (both are
// 'xhr'), so the filters `xhr` and `fetch` mean the same thing.
const TYPE_LABEL = { mainFrame: 'document', subFrame: 'document', stylesheet: 'css', script: 'script', image: 'image', font: 'font', object: 'object', xhr: 'xhr', ping: 'ping', cspReport: 'csp', media: 'media', webSocket: 'ws', other: 'other' };
const typeLabel = (resourceType) => TYPE_LABEL[resourceType] || String(resourceType || 'other').toLowerCase();

// The address as shown: host + path, the query and fragment dropped (they often carry tokens and ids) unless asked for.
function displayUrl(url, { includeQuery = false, max = 140 } = {}) {
  let out = String(url || '');
  try {
    const u = new URL(out);
    if (!/^https?:$|^wss?:$/.test(u.protocol)) out = `${u.protocol}${u.pathname.slice(0, 40)}`;
    else out = `${u.host}${u.pathname}${includeQuery ? u.search : ''}`;
  } catch { out = out.split(/[?#]/)[0]; }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// ---- filters and lines (pure)

const LEVEL_RANK = { error: 3, warning: 2, info: 1, debug: 0 };
const LEVEL_MIN = { error: 3, warning: 2, info: 1, all: 0 };
const LEVEL_TAG = { error: 'err', warning: 'warn', info: 'info', debug: 'log' };

const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const clampLines = (n) => Math.min(Math.max(Math.floor(Number(n)) || DEFAULT_LINES, 1), MAX_LINES);
// Page text goes inside <untrusted_page_content>: it cannot close it.
const defang = (s) => String(s).replace(/<(\/?)untrusted_page_content/gi, '‹$1untrusted_page_content');

function consoleLine(e) {
  const where = e.source ? ` (${sourceName(e.source)}${e.line ? `:${e.line}` : ''})` : '';
  const text = e.text.replace(/\s+/g, ' ').trim();
  return `[${LEVEL_TAG[e.level]}] ${clock(e.t)} ${text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP - 1)}…` : text}${where}`;
}

// entries: the capture's console entries (each with a seq); opts: { level, since_last, lines }. cursor: seq already shown.
// Returns { lines, shown, matched, hidden, total, last } (the newest seq seen, to move the cursor).
function selectConsole(entries, { level = 'warning', since_last = false, lines = DEFAULT_LINES } = {}, cursor = 0) {
  const min = LEVEL_MIN[level] ?? LEVEL_MIN.warning;
  const pool = since_last ? entries.filter((e) => e.seq > cursor) : entries;
  const matched = pool.filter((e) => LEVEL_RANK[e.level] >= min);
  const cap = clampLines(lines);
  const shown = matched.slice(-cap); // the newest ones
  return { lines: shown.map(consoleLine), shown: shown.length, matched: matched.length, hidden: pool.length - matched.length, total: entries.length, last: entries.length ? entries[entries.length - 1].seq : cursor };
}

const failedEntry = (r) => Boolean(r.error) || r.status >= 400;

function networkLine(r, { includeQuery = false } = {}) {
  const outcome = r.error ? `ERR ${r.error}` : String(r.status || '---');
  const ms = Number.isFinite(r.ms) ? ` ${Math.round(r.ms)}ms` : '';
  return `${r.method || 'GET'} ${outcome} ${displayUrl(r.url, { includeQuery })}${ms} ${r.type}${r.cached ? ' (cache)' : ''}`;
}

// opts: { failed, type, url_contains, since_last, include_query, lines }.
function selectNetwork(entries, { failed = false, type = 'all', url_contains = '', since_last = false, include_query = false, lines = DEFAULT_LINES } = {}, cursor = 0) {
  const want = type === 'fetch' ? 'xhr' : type; // (webRequest reports both as xhr)
  const needle = String(url_contains || '').toLowerCase();
  const pool = since_last ? entries.filter((e) => e.seq > cursor) : entries;
  const matched = pool.filter((r) => (!failed || failedEntry(r)) && (want === 'all' || r.type === want) && (!needle || r.url.toLowerCase().includes(needle)));
  const shown = matched.slice(-clampLines(lines));
  return { lines: shown.map((r) => networkLine(r, { includeQuery: include_query })), shown: shown.length, matched: matched.length, total: entries.length, last: entries.length ? entries[entries.length - 1].seq : cursor };
}

// ---- JS dialogs

// What to do the moment a dialog opens:
//   alert        accept (it only says something; leaving it open stalls every tool call on the page);
//   beforeunload accept ("leave") only when the AI started the navigation itself (navigate, go_back, go_forward, reload),
//                else dismiss ("stay"): a page the user is working in is never left because a click or a script moved it;
//   confirm/prompt  hold: the AI decides with handle_dialog. They are never answered automatically: a "yes" can be the
//                real action (delete, send), and a prompt wants text only the AI or the user has.
function dialogPolicy({ type, aiNavigating = false } = {}) {
  if (type === 'alert') return 'accept';
  if (type === 'beforeunload') return aiNavigating ? 'accept' : 'dismiss';
  return 'hold';
}

// The page's own words, shortened and with anything that could pose as markup or a new line removed.
const dialogText = (s, max = 100) => { const t = String(s ?? '').replace(/[\s<>"`]+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

const dialogHeader = (d) => `Dialog open: ${d.type} "${dialogText(d.message)}"${d.type === 'prompt' ? ` (default "${dialogText(d.defaultPrompt, 40)}")` : ''} — use handle_dialog`;
const dialogNote = (n) => `Dialog ${n.action === 'accept' ? 'accepted' : 'dismissed'} automatically: ${n.type} "${dialogText(n.message)}"`;

// ---- one tab's capture

class TabCapture {
  constructor(wc, { now = Date.now, consoleCap = CONSOLE_CAP, requestCap = REQUEST_CAP } = {}) {
    this.wc = wc;
    this.now = now;
    this.since = now(); // when capture began
    this.console = new Ring(consoleCap);
    this.requests = new Ring(requestCap);
    this.open = new Map(); // request id -> { at, method, url, type }
    this.tracker = new IdleTracker();
    this.seq = 0;
    this.consoleCursor = 0; // since_last: what get_console last showed
    this.networkCursor = 0;
    this.aiNav = 0; // > 0 while a navigate / go_back / go_forward / reload of the AI's runs
    this.dialog = null; // a confirm/prompt held for handle_dialog
    this.notes = []; // automatic dialog answers not yet told to the model
    this.waiters = new Set(); // called when a dialog is held
    this.busy = 0; // AI tool calls running on this tab (agent.js executeDebugged)
    this.lastAiAt = 0; // when the last one ended
  }

  // The AI is working in the tab: a tool call is running there, or one ended in the last AI_DIALOG_MS (a click's dialog can
  // open just after the click returns). Only then is a page's dialog the AI's to answer (PageDebug.pageDialog).
  aiActive() { return this.busy > 0 || this.now() - this.lastAiAt < AI_DIALOG_MS; }

  addConsole(entry) { this.console.push({ ...entry, seq: ++this.seq, t: this.now() }); }

  requestStart(details) {
    const at = this.now();
    const type = typeLabel(details.resourceType);
    if (this.open.size >= OPEN_CAP) this.open.delete(this.open.keys().next().value);
    this.open.set(details.id, { at, method: details.method, url: details.url, type });
    this.tracker.start(details.id, { url: details.url, type, at });
  }

  // `error`: net::ERR_... for a failed request, else the status code is read from the details.
  requestEnd(details, error = '') {
    const at = this.now();
    const start = this.open.get(details.id);
    this.open.delete(details.id);
    this.tracker.end(details.id, at);
    this.requests.push({
      seq: ++this.seq, t: at, method: details.method || start?.method || 'GET', url: details.url || start?.url || '',
      status: error ? 0 : details.statusCode || 0, error: error || '', ms: start ? at - start.at : NaN,
      type: start?.type || typeLabel(details.resourceType), cached: Boolean(details.fromCache),
    });
  }

  hold(dialog) {
    this.dialog = dialog;
    for (const fn of [...this.waiters]) fn(dialog);
  }
  // settle: the page is going away (navigation, crash) with a dialog of Lumen's own still held: answer it "no" so the page's
  // blocked call returns (a CDP dialog closes with its page by itself).
  release({ settle = false } = {}) {
    const d = this.dialog;
    this.dialog = null;
    if (settle && d?.respond) { try { d.respond(false); } catch { /* the page is gone */ } }
  }
  note(n) { this.notes.push(n); if (this.notes.length > 5) this.notes.shift(); }
}

// ---- the manager

const AI_DIALOG_MS = 3000;
const WEB_FILTER = { urls: ['http://*/*', 'https://*/*'] };

class PageDebug {
  constructor({ now = Date.now, consoleCap, requestCap } = {}) {
    this.opts = { now, consoleCap, requestCap };
    this.byWc = new WeakMap(); // webContents -> TabCapture
    this.sessions = new Map(); // session -> Map(webContents id -> TabCapture)
  }

  captureOf(wc) { return wc ? this.byWc.get(wc) || null : null; }

  // Starts capturing a tab (once), and returns its capture. Safe to call on every tool call.
  watch(wc) {
    if (!wc || typeof wc.on !== 'function' || typeof wc.once !== 'function' || wc.isDestroyed?.()) return null; // (not a real webContents: nothing to watch)
    const have = this.byWc.get(wc);
    if (have) { this.keepPageOn(have); return have; }
    const cap = new TabCapture(wc, this.opts);
    this.byWc.set(wc, cap);
    const id = wc.id;

    const onConsole = (...args) => { const e = normalizeConsole(...args); if (e.text) cap.addConsole(e); };
    const onGone = (_e, details) => { cap.addConsole({ level: 'error', text: `The page crashed (${details?.reason || 'unknown reason'})`, line: 0, source: '' }); cap.open.clear(); cap.tracker.clear(); cap.release({ settle: true }); };
    const onNav = (details) => { const d = details?.isMainFrame !== undefined ? details : { isMainFrame: true }; if (d.isMainFrame && !d.isSameDocument) cap.release({ settle: true }); }; // a dialog does not outlive its page
    const onMessage = (_e, method, params, sessionId) => this.onDebuggerMessage(cap, method, params, sessionId);
    wc.on('console-message', onConsole);
    wc.on('render-process-gone', onGone);
    wc.on('did-start-navigation', onNav);
    let hasDebugger = false;
    try { if (wc.debugger?.isAttached?.()) { wc.debugger.on('message', onMessage); hasDebugger = true; } } catch { /* no dialog control on this tab */ }
    cap.dialogControl = hasDebugger;
    this.keepPageOn(cap);

    const ses = (() => { try { return wc.session; } catch { return null; } })();
    if (ses?.webRequest) this.join(ses, id, cap);
    wc.once('destroyed', () => {
      for (const fn of [...cap.waiters]) fn(null);
      if (ses) this.leave(ses, id);
    });
    return cap;
  }

  // The Page domain must be on for dialog events. Already on in ordinary tabs; a CDP client that switched it off is undone here
  // (at most every 30 s, and never waited on).
  keepPageOn(cap) {
    if (!cap.dialogControl) return;
    const t = cap.now();
    if (cap.pageOnAt && t - cap.pageOnAt < 30000) return;
    cap.pageOnAt = t;
    try { Promise.resolve(cap.wc.debugger.sendCommand('Page.enable', {})).catch(() => {}); } catch { /* gone */ }
  }

  // ---- session listeners (Electron keeps one per event: these three are free, see the file header)
  join(ses, id, cap) {
    let tabs = this.sessions.get(ses);
    if (!tabs) {
      tabs = new Map();
      this.sessions.set(ses, tabs);
      const wr = ses.webRequest;
      wr.onSendHeaders(WEB_FILTER, (d) => { tabs.get(d.webContentsId)?.requestStart(d); });
      wr.onCompleted(WEB_FILTER, (d) => { tabs.get(d.webContentsId)?.requestEnd(d); });
      wr.onErrorOccurred(WEB_FILTER, (d) => { tabs.get(d.webContentsId)?.requestEnd(d, d.error || 'failed'); });
    }
    tabs.set(id, cap);
  }

  leave(ses, id) {
    const tabs = this.sessions.get(ses);
    if (!tabs) return;
    tabs.delete(id);
    if (tabs.size) return;
    this.sessions.delete(ses);
    try { ses.webRequest.onSendHeaders(null); ses.webRequest.onCompleted(null); ses.webRequest.onErrorOccurred(null); } catch { /* the session is gone */ }
  }

  // ---- dialogs
  onDebuggerMessage(cap, method, params, sessionId) {
    if (method === 'Page.javascriptDialogClosed') { cap.release(); return; }
    if (method !== 'Page.javascriptDialogOpening') return;
    const dialog = { type: params?.type || 'alert', message: String(params?.message ?? ''), defaultPrompt: String(params?.defaultPrompt ?? ''), sessionId: sessionId || undefined };
    const action = dialogPolicy({ type: dialog.type, aiNavigating: cap.aiNav > 0 });
    if (action === 'hold') { cap.hold(dialog); return; }
    this.answer(cap, dialog, action === 'accept').catch(() => {});
    cap.note({ ...dialog, action });
    cap.addConsole({ level: 'warning', text: `[dialog] ${dialogNote({ ...dialog, action })}`, line: 0, source: '' });
  }

  // Lumen draws a page's alert/confirm/prompt itself (preload/page-dialogs-preload.js asks main.js over a sync IPC and the page
  // waits for the answer), so CDP's Page.javascriptDialogOpening never fires for them: main.js offers each one here first.
  // respond(accept, promptText) answers the page. -> true when it is the AI's to handle (the AI is working in the tab:
  // TabCapture.aiActive), with the same policy as a CDP dialog (an alert accepted and noted, a confirm/prompt held for
  // handle_dialog); false: the user's overlay shows it as before.
  pageDialog(wc, { kind, message, defaultValue } = {}, respond) {
    const cap = this.captureOf(wc);
    if (!cap || !cap.aiActive() || typeof respond !== 'function') return false;
    const type = kind === 'confirm' || kind === 'prompt' ? kind : 'alert';
    const dialog = { type, message: String(message ?? ''), defaultPrompt: String(defaultValue ?? ''), respond };
    const action = dialogPolicy({ type, aiNavigating: cap.aiNav > 0 });
    if (action === 'hold') {
      cap.release({ settle: true }); // (one page cannot have two open; a stale one is answered "no")
      cap.hold(dialog);
      return true;
    }
    respond(action === 'accept');
    cap.note({ ...dialog, action });
    cap.addConsole({ level: 'warning', text: `[dialog] ${dialogNote({ ...dialog, action })}`, line: 0, source: '' });
    return true;
  }

  async answer(cap, dialog, accept, promptText) {
    if (dialog.respond) return dialog.respond(accept, promptText); // one of Lumen's own (pageDialog)
    const params = { accept, ...(promptText !== undefined ? { promptText } : {}) };
    await cap.wc.debugger.sendCommand('Page.handleJavaScriptDialog', params, dialog.sessionId);
  }

  // handle_dialog. Returns the text for the model; throws when there is nothing to answer.
  async handleDialog(wc, { accept, text } = {}) {
    const cap = this.captureOf(wc);
    const dialog = cap?.dialog;
    if (!cap?.dialogControl && !dialog?.respond) throw new Error('Lumen cannot see dialogs on this tab (another debugger is attached to it).');
    if (!dialog) throw new Error('No confirm or prompt dialog is open on that tab.');
    await this.answer(cap, dialog, accept === true, dialog.type === 'prompt' && accept === true ? String(text ?? '') : undefined);
    cap.release();
    return `${accept === true ? 'Accepted' : 'Dismissed'} the ${dialog.type} "${dialogText(dialog.message)}"${dialog.type === 'prompt' && accept === true ? ` with ${JSON.stringify(dialogText(text ?? '', 60))}` : ''}.`;
  }

  // Runs fn (a navigation of the AI's own) so a beforeunload dialog it raises may be answered "leave".
  async withAiNavigation(wc, fn) {
    const cap = this.captureOf(wc);
    if (!cap) return fn();
    cap.aiNav++;
    try { return await fn(); } finally { setTimeout(() => { cap.aiNav = Math.max(0, cap.aiNav - 1); }, 1500).unref?.(); } // (the dialog can open just after loadURL returns)
  }

  // What the model is told ahead of a tool result: dialogs answered since the last call (once), and a dialog still open.
  headerFor(wc) {
    const cap = this.captureOf(wc);
    if (!cap) return '';
    const lines = cap.notes.splice(0).map(dialogNote);
    if (cap.dialog) lines.push(dialogHeader(cap.dialog));
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  // A tool call that stalls on a page dialog ends as soon as the dialog is held: resolves with { dialog } instead of the
  // call's result (the abandoned call settles on its own once the dialog is answered).
  race(wc, promise) {
    const cap = this.captureOf(wc);
    if (!cap) return promise;
    return new Promise((resolve, reject) => {
      const onHold = (dialog) => { if (dialog) resolve({ dialog }); };
      cap.waiters.add(onHold);
      promise.then(resolve, reject).finally(() => cap.waiters.delete(onHold));
    });
  }

  // ---- the tools' text
  console(wc, input = {}, { pageUrl = '' } = {}) {
    const cap = this.watch(wc);
    if (!cap) throw new Error('No page to read the console of.');
    const sel = selectConsole(cap.console.all(), input, cap.consoleCursor);
    cap.consoleCursor = sel.last;
    const level = LEVEL_MIN[input.level] === undefined ? 'warning' : input.level;
    const head = `Console of ${pageUrl || 'the tab'}: capture began ${clock(cap.since)} (earlier output is not available), ${cap.console.length} entr${cap.console.length === 1 ? 'y' : 'ies'} held${input.since_last ? ', since the last call' : ''}. Showing ${level === 'all' ? 'everything' : level === 'error' ? 'errors' : level === 'warning' ? 'warnings and errors' : 'info, warnings and errors'}: ${sel.shown}${sel.matched > sel.shown ? ` of ${sel.matched} (newest)` : ''}${sel.hidden ? `; ${sel.hidden} lower-level hidden (level:"all")` : ''}.`;
    return `<untrusted_page_content>\n${defang(head)}\n${sel.lines.length ? defang(sel.lines.join('\n')) : '(nothing to show)'}\n</untrusted_page_content>`;
  }

  network(wc, input = {}, { pageUrl = '' } = {}) {
    const cap = this.watch(wc);
    if (!cap) throw new Error('No page to read the requests of.');
    const sel = selectNetwork(cap.requests.all(), input, cap.networkCursor);
    cap.networkCursor = sel.last;
    const inflight = cap.tracker.describe(cap.now());
    const head = `Requests of ${pageUrl || 'the tab'}: capture began ${clock(cap.since)} (earlier requests are not available), ${cap.requests.length} held${input.since_last ? ', since the last call' : ''}${inflight ? `; now ${inflight}` : ''}. Showing ${sel.shown}${sel.matched > sel.shown ? ` of ${sel.matched} (newest)` : ''}${input.include_query ? '' : '; query strings left out (include_query:true)'}. fetch and xhr are one kind here.`;
    return `<untrusted_page_content>\n${defang(head)}\n${sel.lines.length ? defang(sel.lines.join('\n')) : '(nothing to show)'}\n</untrusted_page_content>`;
  }
}

module.exports = {
  PageDebug, TabCapture, Ring, normalizeConsole, sourceName, typeLabel, displayUrl, selectConsole, selectNetwork, consoleLine, networkLine,
  dialogPolicy, dialogHeader, dialogNote, dialogText, clock, CONSOLE_CAP, REQUEST_CAP, DEFAULT_LINES, MAX_LINES,
};
