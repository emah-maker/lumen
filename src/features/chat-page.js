// lumen://chat: the sidebar's conversation as a full page in an ordinary tab (renderer/chat-page.html).
// One chat, two views: the sidebar and this page both show whatever main.js's agent holds, so
// something sent in one shows in the other (see broadcast/beginRun below).
//
// Like the Bookmarks and Downloads pages it is a local file in a tab that main opens with a
// dedicated preload (chat-preload.js). That preload exposes only the chat calls, and every call is
// checked again here: it must come from the top frame of a chat tab showing the chat page. The
// tab is locked to the page (guardTab), and no other tab may navigate to it (guardOthers), so a
// web page can neither load it nor read the chats through it. Private windows never get any of
// this: they have no sidebar and no way to open a chat tab.
//
// The AI's browser tools must not act on the chat tab itself, so a run started here works in the
// tab the user last looked at (pickTargetTab), shown in the page's header.
const path = require('path');
const { pathToFileURL } = require('url');

const CHAT_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'chat-page.html')).href;
const PRELOAD = path.join(__dirname, 'chat-preload.js');

// Local file URLs compare without case (Windows paths do) and ignore the query and hash.
const bare = (url) => { try { const u = new URL(String(url)); u.search = ''; u.hash = ''; return u.protocol === 'file:' ? u.href.toLowerCase() : ''; } catch { return ''; } };
const isChatUrl = (url) => typeof url === 'string' && bare(url) === CHAT_URL.toLowerCase();
const displayUrl = () => 'lumen://chat';
// lumen://chat (chrome://chat works too) typed in the address bar.
const parseChatInput = (text) => (/^(?:lumen|chrome):\/\/chat\/?$/i.test(String(text || '').trim()) ? { page: 'chat' } : null);

// What the page may ask main for, beyond the chat channels main.js already serves the sidebar:
// the same handlers, opened to this page and nothing else. Anything not listed is refused.
const CHAT_IPC = new Set([
  'agent:ask', 'agent:stop', 'agent:reset', 'agent:rewind', 'agent:approve', 'agent:auto-allow', 'agent:undo', 'agent:ai-tabs-close', 'agent:ai-tabs-undo',
  'chats:list', 'chats:open', 'chats:show-tab', 'chats:stop', 'chats:rename', 'chats:delete', 'chats:export', 'chats:close-tabs',
  'settings:get', 'settings:set-model', 'openrouter:models',
  'usage:get', 'prefs:ui', 'ui:strings', 'settings-page:open',
  'chatpage:state', 'chatpage:back', 'chatpage:link', 'tabs:ask-list',
  'skills:menu', 'skills:context', 'skills:prepare', 'skills:draft-from-chat', // the "/" menu (features/skills.js)
]);

// The tab an AI run started from the chat page works in: the one the user looked at most recently
// that is an ordinary page (not a chat tab, not Settings, not a page the AI may never touch).
// tabs: [{ id, chat, offLimits, closing, viewedAt, lastActiveAt }]. Returns an id, or null.
function pickTargetTab(tabs) {
  let best = null;
  for (const t of tabs || []) {
    if (!t || t.chat || t.offLimits || t.closing) continue;
    const key = [t.viewedAt || 0, t.lastActiveAt || 0];
    if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] >= best.key[1])) best = { id: t.id, key };
  }
  return best ? best.id : null;
}

// Locks a chat tab to its page: nothing else loads in it, and anything that still commits there
// moves to an ordinary tab (`leave(url)`) while this one closes, as Settings does.
function guardTab(wc, leave) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-frame-navigate', (event) => { if (!event.isMainFrame || !isChatUrl(event.url)) event.preventDefault(); });
  wc.on('will-navigate', (event) => { if (!isChatUrl(event.url)) event.preventDefault(); });
  wc.on('will-redirect', (event) => event.preventDefault());
  wc.on('did-navigate', (_e, url) => { if (!isChatUrl(url)) setImmediate(() => leave(url)); });
  wc.on('will-attach-webview', (event) => event.preventDefault());
}

// Every other tab: no navigation, redirect or frame load may reach the chat page.
function guardOthers(wc) {
  const block = (event) => { if (isChatUrl(event.url)) event.preventDefault(); };
  wc.on('will-navigate', block);
  wc.on('will-frame-navigate', block);
  wc.on('will-redirect', block);
}

// The one run that may be live: who started it and what it was, so the other view can show it, and
// a page opened mid-run can say it is running.
function createRunTracker() {
  let run = null;
  return {
    start: (info) => { run = { runId: info.runId, text: String(info.text || ''), fromChat: Boolean(info.fromChat), target: info.target ?? null }; return run; },
    end: () => { run = null; },
    setTarget: (id) => { if (run) run.target = id; },
    get: () => (run ? { ...run } : null),
    running: () => run !== null,
  };
}

// deps: { ipcMain, tabs(), alive(t), ui(), openTab(url, opts), switchTab(id), requestCloseTab(id),
//         managersOpen(), isPrivateSender(event), chatView(), tabInfo(tab), agentOffLimits(tab) }
function create(deps) {
  const runs = createRunTracker();

  const chatTabs = () => deps.tabs().filter((t) => t.managerPage === 'chat' && deps.alive(t) && !t.closing);
  // Chat pages in every window (deps.allTabs): a page in a window that is not the one in front is still a chat page,
  // its calls are still allowed and it still hears broadcasts (a model picked in another window, say).
  const everyChatTab = () => (deps.allTabs || deps.tabs)().filter((t) => t.managerPage === 'chat' && deps.alive(t) && !t.closing);
  const isChatSender = (event) => {
    const wc = event?.sender;
    return Boolean(wc) && event.senderFrame === wc.mainFrame && isChatUrl(event.senderFrame?.url)
      && everyChatTab().some((t) => t.view.webContents === wc);
  };
  const allows = (event, channel) => CHAT_IPC.has(channel) && isChatSender(event);

  // The sidebar plus every open chat page; nothing but the sender itself when there is no page, so
  // the sidebar behaves exactly as it always did until a page exists.
  function surfaces() {
    const pages = everyChatTab().map((t) => t.view.webContents);
    if (!pages.length) return [];
    const ui = deps.ui();
    return [...(ui ? [ui] : []), ...pages].filter((wc) => !wc.isDestroyed());
  }
  function broadcast(channel, payload, except = null) {
    for (const wc of surfaces()) if (wc !== except) wc.send(channel, payload);
  }
  // A run's event to whoever asked, and to the other views when a page is open.
  function emit(sender, channel, payload) {
    const to = new Set(surfaces());
    if (sender) to.add(sender);
    for (const wc of to) if (!wc.isDestroyed()) wc.send(channel, payload);
  }

  // ---- the tab the AI works in
  const summaries = () => deps.tabs().filter((t) => deps.alive(t) || t.sleeping).map((t) => ({
    id: t.id, chat: t.managerPage === 'chat', offLimits: deps.agentOffLimits(t), closing: Boolean(t.closing), viewedAt: t.viewedAt, lastActiveAt: t.lastActiveAt,
  }));
  const pick = () => pickTargetTab(summaries());
  function targetInfo() {
    const id = runs.running() ? runs.get().target : pick();
    const tab = id == null ? null : deps.tabs().find((t) => t.id === id);
    return tab ? deps.tabInfo(tab) : null;
  }
  function pushTarget() {
    if (!chatTabs().length) return;
    const info = targetInfo();
    const key = info ? `${info.id}|${info.title}|${info.url}` : '';
    if (key === pushTarget.last) return;
    pushTarget.last = key;
    for (const t of chatTabs()) t.view.webContents.send('chat:target', info);
  }

  // A run starts (`event.sender` asked). From the chat page it is pinned to the target tab, and a
  // tab is opened if there is none. Other views hear about it so they show the same turn.
  function beginRun(event, { text, runId, images }) {
    const fromChat = isChatSender(event);
    let pinned = null;
    if (fromChat) {
      pinned = pick();
      if (pinned == null) pinned = deps.openTab(undefined, { background: true }).id;
    }
    runs.start({ runId, text, fromChat, target: pinned });
    if (fromChat) pushTarget();
    broadcast('chat:run-start', { text, runId, images: (images || []).map((i) => ({ media_type: i.media_type, data: i.data })) }, event.sender);
    return fromChat;
  }
  const endRun = () => { runs.end(); pushTarget.last = null; pushTarget(); };
  // The tab a chat-page run's tools act on (null: the run does not come from the page).
  const runTarget = () => { const r = runs.get(); return r && r.fromChat ? r.target : null; };
  function retarget(id) { runs.setTarget(id); pushTarget(); }

  // ---- opening and leaving the page
  function open() {
    const id = deps.managersOpen();
    deps.ui()?.send('chat:sidebar', false); // the sidebar folds away: the page has the whole conversation
    return id;
  }
  function back() {
    const to = pick(); // the tab looked at last, before the page
    if (to != null) deps.switchTab(to);
    for (const t of chatTabs()) deps.requestCloseTab(t.id);
    deps.ui()?.send('chat:sidebar', true);
  }

  function register() {
    const { ipcMain } = deps;
    // A private window's UI has no chat calls at all; this also refuses one that found its way here.
    ipcMain.on('chat:open-page', (event) => { if (!deps.isPrivateSender(event)) open(); });
    ipcMain.handle('chatpage:state', () => ({ view: deps.chatView(), run: runs.get(), target: targetInfo() }));
    ipcMain.on('chatpage:back', () => back());
    ipcMain.on('chatpage:link', (_e, url) => { if (/^https?:\/\//i.test(String(url))) deps.openTab(String(url)); });
  }

  return { register, isChatSender, allows, broadcast, emit, beginRun, endRun, runTarget, retarget, pushTarget, open, back, pick, chatTabs, everyChatTab, surfaces, runs };
}

module.exports = { create, pickTargetTab, createRunTracker, isChatUrl, displayUrl, parseChatInput, guardTab, guardOthers, CHAT_URL, PRELOAD, CHAT_IPC };
