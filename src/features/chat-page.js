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
// A spare chat page (main.js makeSpareChat) is made in the background so a chat tab opens at once. The preload (chat-preload.js) holds
// its calls back until main hands it to a tab; the one call it makes at once is the interface strings (SPARE_IPC).
const SPARE_FLAG = '--lumen-spare-chat';
const SPARE_IPC = new Set(['ui:strings']);

// Local file URLs compare without case (Windows paths do) and ignore the query and hash.
const bare = (url) => { try { const u = new URL(String(url)); u.search = ''; u.hash = ''; return u.protocol === 'file:' ? u.href.toLowerCase() : ''; } catch { return ''; } };
const isChatUrl = (url) => typeof url === 'string' && bare(url) === CHAT_URL.toLowerCase();
const CANVAS_FRAME_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'canvas-frame.html')).href;
const isCanvasFrameUrl = (url) => typeof url === 'string' && bare(url) === CANVAS_FRAME_URL.toLowerCase();
const displayUrl = () => 'lumen://chat';
// lumen://chat (chrome://chat works too) typed in the address bar.
const parseChatInput = (text) => (/^(?:lumen|chrome):\/\/chat\/?$/i.test(String(text || '').trim()) ? { page: 'chat' } : null);

// Limits for what the page may send when it schedules a routine (the page is untrusted).
const ROUTINE_LIMITS = { prompt: 8000, title: 80, when: 500 };
const routineHelpers = {
  parseScheduleText: (text) => require('./routines').parseScheduleText(text),
  // Only the schedule's own fields, with plain types: nothing else the page sent gets through.
  pickSchedule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    if (typeof raw.repeat === 'string') out.repeat = raw.repeat.slice(0, 16);
    if (typeof raw.time === 'string') out.time = raw.time.slice(0, 16);
    if (Array.isArray(raw.days)) out.days = raw.days.slice(0, 7).map(Number);
    if (typeof raw.hours === 'number' || typeof raw.hours === 'string') out.hours = Number(raw.hours);
    if (typeof raw.at === 'number' || typeof raw.at === 'string') out.at = typeof raw.at === 'string' ? raw.at.slice(0, 40) : raw.at;
    if (typeof raw.cron === 'string') out.cron = raw.cron.slice(0, 120);
    return out;
  },
  checkSpec(spec, limits) {
    if (!spec || typeof spec !== 'object') return 'Nothing to save.';
    if (typeof spec.prompt !== 'string' || !spec.prompt.trim()) return 'Write what the routine should do.';
    if (spec.prompt.length > limits.prompt) return 'That request is too long.';
    if (typeof spec.title !== 'string' || !spec.title.trim()) return 'Give the routine a name.';
    if (spec.title.length > limits.title) return 'That name is too long.';
    if (!routineHelpers.pickSchedule(spec.schedule)) return 'Pick when it runs.';
    return '';
  },
};

// What the page may ask main for, beyond the chat channels main.js already serves the sidebar:
// the same handlers, opened to this page and nothing else. Anything not listed is refused.
const CHAT_IPC = new Set([
  'agent:thumbs-visible', 'agent:open-preview', 'chips:info', 'chips:watch', 'chips:open', 'tabs:hide-ai', 'agent:ask', 'agent:stop', 'agent:reset', 'agent:rewind', 'agent:rewind-user', 'agent:version', 'agent:feedback', 'agent:screen-drop', 'agent:btw', 'agent:btw-cancel', 'agent:approve', 'agent:send-undo', 'agent:send-stop', 'agent:auto-allow', 'agent:permission-mode', 'agent:helpers', 'agent:prefer-fractions', 'agent:helper-stop', 'agent:undo', 'agent:ai-tabs-close', 'agent:ai-tabs-undo', 'desktop:open', 'desktop:control',
  'uploads:stash', 'uploads:discard', 'agent:upload-choose', // files attached to a message, and the "Choose file…" card
  'chats:list', 'chats:open', 'chats:share', 'chats:show-tab', 'chats:stop', 'chats:rename', 'chats:delete', 'chats:undo-delete', 'chats:pin', 'chats:archive', 'chats:search', 'chats:export', 'chats:markdown', 'chats:temporary', 'chats:project-save', 'chats:project-delete', 'chats:project-set', 'chats:project-move', 'chats:project-restore', 'chats:new-in-project', 'chats:project-pick-folder', 'chats:project-folder', 'chats:work-folder', 'chats:run-now', 'chats:close-tabs', 'chats:project-get', 'chats:project-files-add', 'chats:project-file-remove', 'chats:project-search', 'chats:project-link', 'chats:project-add-tab', 'chats:project-memory-forget', 'chats:project-defaults', 'chats:project-undo',
  'images:data', 'images:save', 'images:copy', 'images:remote', 'images:open-tab', // pictures the AI made
  'aifiles:preview', 'aifiles:open', // files the AI made (features/ai-files.js)
  'notes:act', // (notes) "Add to notes" under a reply (main.js; features/notes-hub.js)
  'memory:list', 'memory:undo', 'memory:forget', // (memory) the "Remembered" row in the chat and /memory
  'settings:get', 'settings:set-model', 'settings:set-effort', 'openrouter:models',
  'usage:get', 'prefs:ui', 'ui:strings', 'settings-page:open',
  'chatpage:state', 'chatpage:back', 'chatpage:home', 'chatpage:link', 'tabs:ask-list',
  'skills:menu', 'skills:context', 'skills:prepare', 'skills:draft-from-chat', 'skills:offer-save', 'skills:offer-update', // the "/" menu and the save / update cards (features/skills.js)
  'chat:routine-preview', 'chat:routine-create', // "Schedule this" on the page: read a schedule phrase, save a routine (registerRoutines below)
  'dictation:status', 'dictation:transcribe', // (dictation) voice input in the chat box (main.js; ai/dictation.js)
  'offers:get', 'offers:act', // the "New in Lumen" card (main.js; features/feature-offers.js)
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
  // (a subframe may load only the canvas preview's own page, which the sandboxed <iframe> in chat-canvas.js shows)
  wc.on('will-frame-navigate', (event) => { if (event.isMainFrame ? !isChatUrl(event.url) : !isCanvasFrameUrl(event.url)) event.preventDefault(); });
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

// deps: { ipcMain, tabs(), alive(t), ui(), openTab(url, opts), switchTab(id), requestCloseTab(id), goHome(tabId), goChat(tabId),
//         managersOpen(), isPrivateSender(event), chatView(), userName(), tabInfo(tab), agentOffLimits(tab), spareContents(),
//         sidebarWants(wc, payload) -> bool (optional: is a sync / run start about the chat the sidebar shows) }
function create(deps) {
  const runs = createRunTracker();
  const drafts = new Map(); // chat tab id -> { text, send } carried from the new-tab page's box, handed to the page once (chatpage:state)

  const chatTabs = () => deps.tabs().filter((t) => t.managerPage === 'chat' && deps.alive(t) && !t.closing);
  // Chat pages in every window (deps.allTabs): a page in a window that is not the one in front is still a chat page,
  // its calls are still allowed and it still hears broadcasts (a model picked in another window, say).
  const everyChatTab = () => (deps.allTabs || deps.tabs)().filter((t) => t.managerPage === 'chat' && deps.alive(t) && !t.closing);
  const isChatSender = (event) => {
    const wc = event?.sender;
    return Boolean(wc) && event.senderFrame === wc.mainFrame && isChatUrl(event.senderFrame?.url)
      && everyChatTab().some((t) => t.view.webContents === wc);
  };
  // (the spare page, before a tab has taken it: the interface strings only)
  const isSpareSender = (event) => { const wc = deps.spareContents?.(); return Boolean(wc) && event?.sender === wc && event.senderFrame === wc.mainFrame && isChatUrl(event.senderFrame?.url); };
  const allows = (event, channel) => (CHAT_IPC.has(channel) && isChatSender(event)) || (SPARE_IPC.has(channel) && isSpareSender(event));

  // The sidebar plus every open chat page; nothing but the sender itself when there is no page, so
  // the sidebar behaves exactly as it always did until a page exists.
  function surfaces() {
    const pages = everyChatTab().map((t) => t.view.webContents);
    if (!pages.length) return [];
    const ui = deps.ui();
    return [...(ui ? [ui] : []), ...pages].filter((wc) => !wc.isDestroyed());
  }
  // A chat page keeps the chat it was left on (its tab's own chat, deps.chatOf): a sync or a run of some other chat, started in the
  // sidebar or another tab, never replaces what it shows. The sidebar and a page with no chat of its own take everything.
  const chatOfPage = (wc) => { const t = everyChatTab().find((x) => x.view.webContents === wc); return t && deps.chatOf ? deps.chatOf(t.id) : null; };
  const pageWants = (wc, payload) => { const about = payload?.view?.id ?? payload?.chatId; const own = about ? chatOfPage(wc) : null; return !own || own === about; };
  // The sidebar is tied to its window's front tab, not to the last thing a chat page did: a page in another tab that starts a new chat,
  // opens one, edits a reply or begins a run must not turn the sidebar of the tab the user is on into that chat (it would show the page's
  // chat, with the box emptied, while main still believed it showed its own). The sidebar takes a sync only for the chat it shows.
  const sidebarWants = (wc, payload) => !deps.sidebarWants || deps.sidebarWants(wc, payload);
  // `except`: a webContents, or a list of them, that are not sent to.
  function broadcast(channel, payload, except = null) {
    const pages = new Set(everyChatTab().map((t) => t.view.webContents));
    const scoped = channel === 'chat:sync' || channel === 'chat:run-start';
    const skip = new Set(Array.isArray(except) ? except : [except]);
    for (const wc of surfaces()) {
      if (skip.has(wc)) continue;
      if (scoped && (pages.has(wc) ? !pageWants(wc, payload) : !sidebarWants(wc, payload))) continue;
      wc.send(channel, payload);
    }
  }
  // A run's event to whoever asked, and to the other views when a page is open.
  function emit(sender, channel, payload) {
    const to = new Set(surfaces().filter((wc) => channel !== 'agent:event' || wc === sender || pageWants(wc, payload)));
    if (sender) to.add(sender);
    for (const wc of to) if (!wc.isDestroyed()) wc.send(channel, payload);
  }

  // ---- the tab the AI works in
  const summaries = () => deps.tabs().filter((t) => deps.alive(t) || t.sleeping).map((t) => ({
    id: t.id, chat: t.managerPage === 'chat', offLimits: deps.agentOffLimits(t), closing: Boolean(t.closing), viewedAt: t.viewedAt, lastActiveAt: t.lastActiveAt,
  }));
  const pick = () => pickTargetTab(summaries());
  // [working-on chip] A run the agent no longer has (it ended or was cancelled without the page hearing of it) is not a run: it is dropped
  // here, so a tab never stays marked as worked on. deps.runLive(runId) is main's word on whether that run is still going.
  const liveRun = () => {
    const r = runs.get();
    if (r && deps.runLive && deps.runLive(r.runId) === false) { runs.end(); return false; }
    return Boolean(r);
  };
  function targetInfo() {
    const id = liveRun() ? runs.get().target : null; // [working-on chip] only a live run's tab; idle, nothing is "worked on"
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
  function beginRun(event, { text, runId, images, files, chatId = null }) {
    const fromChat = isChatSender(event);
    runs.start({ runId, text, fromChat, target: null }); // [working-on chip] no tab until a tool takes one (retarget)
    if (fromChat) pushTarget();
    broadcast('chat:run-start', { text, runId, chatId, images: (images || []).map((i) => ({ media_type: i.media_type, data: i.data })), files: files || [] }, event.sender);
    return fromChat;
  }
  const endRun = () => { runs.end(); pushTarget.last = null; pushTarget(); };
  // The tab a chat-page run's tools act on (null: the run does not come from the page).
  const runTarget = () => { const r = liveRun() ? runs.get() : null; return r && r.fromChat ? r.target : null; };
  const runFromPage = () => { const r = liveRun() ? runs.get() : null; return Boolean(r && r.fromChat); };
  function retarget(id) { runs.setTarget(id); pushTarget(); }

  // ---- opening and leaving the page
  function open() {
    const id = deps.managersOpen();
    deps.ui()?.send('chat:sidebar', false); // the sidebar folds away: the page has the whole conversation
    return id;
  }
  // Back (the button, Ctrl+Shift+L, the toolbar's Back, Alt+Left): to the tab looked at last, before the page, and the page closes;
  // with no such tab, this tab becomes the new-tab page (closing the only tab would close the window).
  function back() {
    const to = pick();
    const pages = chatTabs();
    if (to != null) { deps.switchTab(to); for (const t of pages) deps.requestCloseTab(t.id); }
    else { if (pages.length) deps.goHome(pages[0].id); for (const t of pages.slice(1)) deps.requestCloseTab(t.id); }
    deps.ui()?.send('chat:sidebar', true);
  }
  // Home (the header button, Alt+Home): this tab turns into the new-tab page, in place, as leaving Settings does. A reply still
  // running goes on in the background: the chat is main's, the page was only a view of it.
  function home(tabId) {
    if (tabId == null || !chatTabs().some((t) => t.id === tabId)) return false;
    deps.goHome(tabId);
    deps.ui()?.send('chat:sidebar', true);
    return true;
  }

  // The new-tab page's Ask AI (the way back from Home): this tab turns into the chat page, in place (inNewTab: a new tab
  // instead). What was typed in the new-tab box goes to the page: asked in a new chat when `send` is set (Enter in Ask AI),
  // otherwise it waits in the composer as a draft and is never sent. Pictures (checked, from newtab-ai:ask) ride with it and join that first message.
  function fromHome(tabId, { draft = '', images = [], inNewTab = false, send = false } = {}) {
    const id = inNewTab ? deps.openTab(CHAT_URL, { managerPage: 'chat' }).id : deps.goChat(tabId);
    const text = String(draft || '').slice(0, 20000);
    const pictures = Array.isArray(images) ? images.slice(0, 10) : []; // (main already checked them: newtab-ai:ask cleans what the page sent)
    if (id != null && (text.trim() || pictures.length)) drafts.set(id, { text, send: Boolean(send), images: pictures });
    else if (id != null) drafts.set(id, { text: '', send: false, images: [], fresh: true }); // plain Ask AI: the page opens on a new chat, not the last one (an empty open chat is reused)
    deps.ui()?.send('chat:sidebar', false); // as open() does: the page has the whole conversation
    return id;
  }

  // Scheduling from the page (deps.routines() is the background runner). The page is untrusted: only a chat page may ask, never from a
  // private window, and every argument is checked here. Both answer { ... } and never throw.
  function registerRoutines(ipcMain) {
    const allowed = (event) => isChatSender(event) && !deps.isPrivateSender(event) && Boolean(deps.routines?.());
    ipcMain.handle('chat:routine-preview', (event, req) => {
      const none = { parsed: null, next: [] };
      if (!allowed(event) || !req || typeof req !== 'object') return none;
      try {
        const text = typeof req.text === 'string' ? req.text.slice(0, ROUTINE_LIMITS.prompt + ROUTINE_LIMITS.when) : '';
        const parsed = text.trim() ? routineHelpers.parseScheduleText(text) : null;
        const schedule = parsed ? parsed.schedule : routineHelpers.pickSchedule(req.schedule);
        const out = schedule ? deps.routines().routinePreview({ schedule }) : null;
        return { parsed, next: out?.ok ? out.next : [], error: out && !out.ok ? String(out.error || '') : '' };
      } catch { return none; }
    });
    ipcMain.handle('chat:routine-create', (event, spec) => {
      if (!allowed(event)) return { ok: false, error: 'Not available here.' };
      const bad = routineHelpers.checkSpec(spec, ROUTINE_LIMITS);
      if (bad) return { ok: false, error: bad };
      try {
        const made = deps.routines().saveRoutine({ title: spec.title.trim(), prompt: spec.prompt.trim(), schedule: routineHelpers.pickSchedule(spec.schedule), enabled: spec.enabled !== false, confirmed: true });
        return { ok: true, id: made.id };
      } catch (err) { return { ok: false, error: String(err?.message || err) }; }
    });
  }

  function register() {
    const { ipcMain } = deps;
    // A private window's UI has no chat calls at all; this also refuses one that found its way here.
    ipcMain.on('chat:open-page', (event) => { if (!deps.isPrivateSender(event)) open(); });
    ipcMain.handle('chatpage:state', (event) => {
      deps.followPage?.(event);
      const tab = chatTabs().find((t) => t.view.webContents === event.sender);
      const carried = tab ? drafts.get(tab.id) : null;
      if (tab) drafts.delete(tab.id);
      return { view: deps.chatView(), run: runs.get(), target: targetInfo(), name: deps.userName?.() || '', draft: carried?.text || '', send: Boolean(carried?.send), fresh: Boolean(carried?.fresh), images: (carried?.images || []).map((i) => ({ type: i.type, name: i.name, data: i.data })) };
    });
    ipcMain.on('chatpage:back', () => back());
    ipcMain.on('chatpage:home', (event) => { if (isChatSender(event)) home(chatTabs().find((t) => t.view.webContents === event.sender)?.id); });
    registerRoutines(ipcMain);
    ipcMain.on('chatpage:link', (_e, url) => { if (/^https?:\/\//i.test(String(url))) deps.openTab(String(url)); });
  }

  return { register, isChatSender, allows, broadcast, emit, beginRun, endRun, runTarget, runFromPage, retarget, pushTarget, open, back, home, fromHome, pick, chatTabs, everyChatTab, surfaces, runs };
}

module.exports = { create, pickTargetTab, createRunTracker, isChatUrl, isCanvasFrameUrl, displayUrl, parseChatInput, guardTab, guardOthers, CHAT_URL, PRELOAD, CHAT_IPC, SPARE_FLAG, SPARE_IPC };
