const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

// Before any page script runs: tells main this view has the UI's preload, so main.js's backstop
// holds it to renderer/index.html (it can only make the view more restricted).
ipcRenderer.sendSync('ui-preload:loaded');

// The UI's strings in the system's language (features/i18n.js; renderer/i18n.js looks them up).
// Asked only from renderer/index.html: the window's first about:blank runs this preload too, and
// main's gate (rightly) refuses it there.
const isUiPage = location.protocol === 'file:' && /\/renderer\/index\.html$/.test(location.pathname);
contextBridge.exposeInMainWorld('lumenI18n', (isUiPage && ipcRenderer.sendSync('ui:strings')) || { locale: 'en', strings: {} });

// Defines <browser-action-list>, the row of extension buttons in the toolbar.
injectBrowserAction();

const on = (channel) => (callback) => ipcRenderer.on(channel, (_e, payload) => callback(payload));

// `platform-darwin` / `platform-win32` on <html>: macOS has traffic lights on the left, Windows
// has window controls on the right.
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add(`platform-${process.platform}`));

contextBridge.exposeInMainWorld('browser', {
  setContentBounds: (bounds) => ipcRenderer.send('content-bounds', bounds),
  setContentBoundsAck: (bounds) => ipcRenderer.invoke('content-bounds:ack', bounds), // resolves once the page view has its new size
  freezeView: (size) => ipcRenderer.invoke('view:freeze', size),
  thawView: () => ipcRenderer.send('view:thaw'),
  freezeShown: () => ipcRenderer.send('view:frozen'), // the snapshot is on screen: main may hide the live page under it
  freezeAlive: () => ipcRenderer.send('view:freeze-alive'),
  setChatFull: (on) => ipcRenderer.send('chat:full', on),
  warmView: () => ipcRenderer.invoke('view:warm'),
  newTab: (url) => ipcRenderer.send('tab:new', url),
  // Dropped files: the page can't see paths, so they're resolved here (webUtils) and main.js opens them.
  openFiles: (files) => ipcRenderer.send('files:open', [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  closeTab: (id) => ipcRenderer.send('tab:close', id),
  switchTab: (id, byUser) => ipcRenderer.send('tab:switch', id, performance.timeOrigin + performance.now(), byUser === true), // (the click's own time: Settings > Advanced > Record tab-switch timings)
  switchStripDrawn: (id, at) => ipcRenderer.send('tab:switch-strip', id, at), // the strip drew this tab active (only while recording)
  tabHover: (id, on) => ipcRenderer.send('tab:hover', id, on), // the pointer rests on / leaves a tab: main wakes a sleeping one ahead of the click
  tabDown: (id) => ipcRenderer.send('tab:down', id), // the button went down on a tab (the click follows)
  moveTab: (id, toIndex, done) => ipcRenderer.send('tab:move', id, toIndex, Boolean(done)), // done: the strip is waiting to show the tab in its slot
  moveTabs: (ids, beforeId, groupId, join) => ipcRenderer.send('tab:move-block', ids, beforeId, groupId, join), // several tabs (a selection, a group) as one block
  // A tab dragged out of the strip: main.js moves it into a window that follows the cursor.
  dragTabPrep: (id) => ipcRenderer.send('tab:dragprep', id), // a tab is heading out of the strip: a tear-off may follow
  onTabDragDone: on('tab:dragdone'), // a dropped tab has been placed: show it again if it stayed here
  dragTabStart: (id, grab) => ipcRenderer.send('tab:dragstart', id, grab),
  dragTabEnd: () => ipcRenderer.send('tab:dragend'), // the button came up
  dragTabCancel: () => ipcRenderer.send('tab:dragcancel'), // Escape
  onTabArriving: on('tab:arriving'), // { ids }: tabs about to land here stay invisible until the chip that carries them arrives
  onTabLanded: on('tab:landed'), // the chip has landed: they show
  onTabDropAt: on('tab:dropat'), // { beforeId } while a dragged window hovers this strip, null when it leaves
  onTabDragAbort: on('tab:dragabort'), // main gave up on a drag whose release never came
  onTabArrived: on('tab:arrived'),
  onTabMovedHere: on('tab:moved-here'), // tabs moved into this window from the tab menu: { ids, title } // this new window was just given dragged tabs ({ count }): announced
  dragTabMove: () => ipcRenderer.send('tab:dragmove'), // the pointer moved during a drag main.js drives
  setTabSelection: (ids) => ipcRenderer.send('tab:selection', ids), // the strip's multi-selection: drags and the tab menu act on all of it
  hideAiTabs: (on) => ipcRenderer.invoke('tabs:hide-ai', on), // [ai manners] no argument: just read it
  hideAiTabsMenu: (at) => ipcRenderer.send('tabs:hide-ai-menu', at), // right-click on the toggle: hide or close the AI's tabs
  stripMenu: (at) => ipcRenderer.send('tabs:strip-menu', at), // right-click on the empty strip or the side list: tab layout
  sideTabs: (o) => ipcRenderer.invoke('tabs:side', o), // the side list's saved width and fold: { width?, collapsed? }
  tabMenu: (id, point) => ipcRenderer.send('tab:context-menu', id, point),
  navMenu: (direction, point) => ipcRenderer.send('nav:history-menu', direction, point), // right-click on Back / Forward: the pages behind / ahead
  addressMenu: (point, hasSelection) => ipcRenderer.send('address:menu', point, hasSelection), // right-click in the address bar: Cut / Copy / Paste, Paste and Go
  groupMenu: (id, point) => ipcRenderer.send('group:context-menu', id, point),
  toggleGroup: (id) => ipcRenderer.send('group:toggle', id),
  renameGroup: (id, name) => ipcRenderer.send('group:rename', id, name),
  onRenameGroup: on('group:rename-start'),
  organizeTabs: () => ipcRenderer.send('tabs:organize'),
  onOrganizing: on('tabs:organizing'),
  onOrganizeNote: on('tabs:organize-note'),
  onGpuCalm: on('gpu:calm'), // [gpu health] true while the GPU recovers from a reset
  onGpuNote: on('gpu:software-note'), // drawing fell to software after a reset: offer a restart
  onGpuLost: on('gpu:lost'), // the GPU process died: a page snapshot on screen is put away
  gpuRestart: (safe) => ipcRenderer.send('gpu:restart', safe === true),
  undoAiClose: (token) => ipcRenderer.invoke('tabs:undo-ai-close', token), // [ai manners]
  openChatNote: (token) => ipcRenderer.invoke('chat:open-note', token), // the strip's toast about a chat that finished on another tab
  phoneWifi: () => ipcRenderer.send('phone:wifi-open'), // [phone wifi] the composer's + menu: Receive from phone (Wi-Fi)
  phoneNoteAction: (token) => ipcRenderer.invoke('phone:note-action', token), // [phone files] the toast about a file from the phone: Attach to chat / Show in Finder
  undoOrganize:() => ipcRenderer.send('tabs:undo-organize'),
  toggleBookmark: () => ipcRenderer.send('bookmark:toggle'),
  toggleReader: () => ipcRenderer.send('page:reader'),
  translateAct: (action, arg) => ipcRenderer.send('translate:act', action, arg), // the translate infobar and button (features/translate.js)
  passwordsAct: (action) => ipcRenderer.send('passwords:act', action), // [passwords] the save bar and the key button: no password ever passes here
  resetZoom: () => ipcRenderer.send('zoom:reset'),
  onDownloads: on('downloads'),
  openDownloadsMenu: (point) => ipcRenderer.send('downloads:menu', point),
  warmDownloads: () => ipcRenderer.send('downloads:warm'), // the pointer or the keyboard reached the button: the panel's page loads ahead of the click
  go: (text) => ipcRenderer.send('nav:go', text),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  find: (text, options) => ipcRenderer.send('find:start', text, options),
  stopFind: (close) => ipcRenderer.send('find:stop', Boolean(close)),
  onFindResult: on('find:result'),
  onOpenFind: on('find:open'),
  onTabs: on('tabs'),
  onSplit: on('split:layout'), // [split view] where the divider between two pages goes (null: none)
  setSplitRatio: (ratio) => ipcRenderer.send('split:ratio', ratio),
  closeSplit: () => ipcRenderer.send('split:close'),
  onFocusAddress: on('focus-address'),
  onToggleSidebar: on('toggle-sidebar'),
  onNewSidebarChat: on('new-sidebar-chat'),
  onAskSelection: on('ask-selection'),
  onAttachImage: on('attach-image'), // a screenshot for the sidebar composer (features/screenshot.js)
  onAskFromHome: on('ask-from-home'),
  onWindowFocus: on('window-focus'),
  onWindowFullscreen: on('window-fullscreen'), // the window entered or left full screen (the strip drops its caption reserve)
  onAgentsPending: on('agents:pending'), // how many outside-agent approvals wait in agent windows (toolbar badge)
  focusPendingAgent: () => ipcRenderer.send('agents:focus-pending'),
  onAgentWindow: on('agent-window'), // this window belongs to an outside agent (or no longer does: null)
  openAppMenu: (point) => ipcRenderer.send('app-menu', point),
  openPageInfo: (point) => ipcRenderer.send('page-info:open', point), // the lock next to the address (features/page-info.js)
  openActionsOverflow: (point, items) => ipcRenderer.send('actions:overflow', point, items), // the extension icons that don't fit the toolbar
  onActionsOverflowPick: on('actions:overflow-pick'),
  suggest: (query) => ipcRenderer.invoke('suggest:query', query),
  showSuggestions: (rect, payload) => ipcRenderer.send('suggest:show', rect, payload),
  hideSuggestions: () => ipcRenderer.send('suggest:hide'),
  addressTouched: () => ipcRenderer.send('address:touched'),
  prepareSettings: () => ipcRenderer.send('prepare-settings'), // [settings intent] the menu button was pressed: Settings starts loading
  onSuggestionPicked: on('suggest:picked'),
  // Tab search (Ctrl+Shift+A) and the tab strip's speaker button (features/tab-tools.js)
  toggleMute: (id) => ipcRenderer.send('tab:mute', id),
  toggleAiOffTab: (id) => ipcRenderer.send('tab:ai-off', id), // [ai off-tab]
  closedTabs: () => ipcRenderer.invoke('tabsearch:closed'),
  reopenClosed: (index, url) => ipcRenderer.invoke('tabsearch:reopen', index, url),
  onOpenTabSearch: on('tabsearch:open'),
  onOpenFilesPicker: on('files:picker'),
  onOpenCommandBar: on('cmdbar:open'), // Ctrl+K (renderer/command-bar.js, features/command-bar.js)
  commandData: () => ipcRenderer.invoke('cmdbar:data'),
  commandRun: (id) => ipcRenderer.invoke('cmdbar:run', id),
});

// [settings] lumen://settings: open it, and the UI preferences it controls (compact tabs, …).
contextBridge.exposeInMainWorld('lumenPrefs', {
  openSettingsPage: (section) => ipcRenderer.send('settings-page:open', section),
  get: () => ipcRenderer.invoke('prefs:ui'),
  onChange: on('prefs:ui'),
  syncExtensionPins: () => ipcRenderer.invoke('ext:pins-sync'), // [extensions] new extension buttons get their first pin choice (renderer/extensions-bar.js)
  setExtensionOrder: (ids) => ipcRenderer.invoke('ext:pins-order', ids), // ...and a drag in the toolbar is saved
});

// The toolbar's update prompt (renderer/updates.js, features/updates.js).
contextBridge.exposeInMainWorld('lumenUpdates', {
  state: () => ipcRenderer.invoke('settings:updates-state'),
  apply: () => ipcRenderer.invoke('settings:updates-apply'),
  dismiss: () => ipcRenderer.invoke('settings:updates-dismiss'),
  onState: on('updates:state'),
});

// Only what the browser UI itself uses. Keys, MCP, automation and import are set in lumen://settings
// (settings-preload.js); the tests still reach a few of those calls through here. main.js adds
// this switch only in test mode, which a packaged build never is (test-mode.js).
const testOnly = process.argv.includes('--lumen-test-mode') ? {
  mcpInfo: () => ipcRenderer.invoke('mcp:info'),
  setMcpEnabled: (on) => ipcRenderer.invoke('mcp:set-enabled', on),
  automationInfo: () => ipcRenderer.invoke('automation:info'),
  setAutomation: (options) => ipcRenderer.invoke('automation:set', options),
  setAutoGroup: (on) => ipcRenderer.invoke('settings:set-auto-group', on),
  setProviderKey: (provider, key) => ipcRenderer.invoke('settings:set-provider-key', provider, key),
} : {};
contextBridge.exposeInMainWorld('assistant', {
  ask: (text, runId, images, tabIds, files, screen, opts) => ipcRenderer.send('agent:ask', text, runId, images, tabIds, files, screen, opts), // screen: 'on' | 'off' (the camera button), else the words decide; opts: [plan mode] { plan } or { approvedPlan }
  dropScreen: (id) => ipcRenderer.invoke('agent:screen-drop', id), // the screenshot chip's x
  // Files attached to a message (renderer/chat-core.js): kept by main until it is sent, named to the AI by ref only; and the
  // "Choose file…" card's picker. See features/upload-files.js.
  uploads: {
    stash: (file) => ipcRenderer.invoke('uploads:stash', file),
    discard: (ref) => ipcRenderer.send('uploads:discard', ref),
    thumb: (ref) => ipcRenderer.invoke('uploads:thumb', ref), // a Word, Excel or PowerPoint file's first page, for its chip
    choose: (approvalId) => ipcRenderer.invoke('agent:upload-choose', approvalId),
  },
  askTabs: () => ipcRenderer.invoke('tabs:ask-list'), // the "@" picker's tabs (renderer/tabs-ask.js)
  stop: (chatId) => ipcRenderer.send('agent:stop', chatId), // the chat the view shows: Stop never reaches another chat's run
  sidebarTarget: (o) => ipcRenderer.invoke('chat:sidebar-target', o && o.liveOnly === true ? { liveOnly: true } : undefined), // the sidebar is about to open: the chat on this tab that works, waits for an OK or finished unread ({ id, reason, view }), or null
  resync: () => ipcRenderer.invoke('chat:resync'), // the chat this window's front tab shows, with its own run state
  prewarm: (text) => ipcRenderer.send('agent:prewarm', typeof text === 'string' ? text.slice(0, 2000) : ''), // the composer was focused / typed in: Claude Code's process starts ahead of the message
  reset: () => ipcRenderer.send('agent:reset'),
  rewind: (expected) => ipcRenderer.invoke('agent:rewind', expected), // Retry / Regenerate: the last exchange taken back
  rewindUser: (ordinal, expected) => ipcRenderer.invoke('agent:rewind-user', ordinal, expected), // Regenerate / Edit of any message, kept as a version
  switchVersion: (at, target) => ipcRenderer.invoke('agent:version', at, target), // the version switch
  feedback: (ordinal, value) => ipcRenderer.invoke('agent:feedback', ordinal, value), // thumbs up / down under a reply
  btw: (id, text) => ipcRenderer.invoke('agent:btw', id, text), // /btw: a side question answered beside the running task (features/btw-side.js); streamed through onBtw
  btwCancel: (id) => ipcRenderer.send('agent:btw-cancel', id),
  onBtw: on('agent:btw-event'),
  autocomplete: (prefix) => ipcRenderer.invoke('agent:autocomplete', typeof prefix === 'string' ? prefix.slice(-2000) : ''), // [autocomplete] a guess at the rest of the message being typed (renderer/chat-autocomplete.js)
  autocompleteCancel: () => ipcRenderer.send('agent:autocomplete-cancel'),
  // The chat history list (renderer/chats.js)
  // Pictures the AI made (renderer/gen-images.js): the picture as a data URL, Save image, Copy image, and a web picture the user clicked.
  images: {
    data: (id) => ipcRenderer.invoke('images:data', id),
    save: (id) => ipcRenderer.invoke('images:save', id),
    copy: (id) => ipcRenderer.invoke('images:copy', id),
    remote: (url) => ipcRenderer.invoke('images:remote', url),
    openTab: (dataUrl) => ipcRenderer.invoke('images:open-tab', dataUrl), // the chat picture viewer's "Open in a tab"
  },
  // Files the AI made (renderer/ai-files.js): the file card's preview, and Open in a tab / the system app / Show in folder. By card id only.
  files: {
    preview: (id) => ipcRenderer.invoke('aifiles:preview', id),
    open: (id, how, opts) => ipcRenderer.invoke('aifiles:open', id, how, opts),
  },
  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    currentProject: () => ipcRenderer.invoke('chats:current-project'), // [projects] the open chat's project, and how many projects there are
    saveProject: (project) => ipcRenderer.invoke('chats:project-save', project), // [projects] the sidebar's project picker and editor (same calls as lumen://chat)
    removeProject: (id) => ipcRenderer.invoke('chats:project-delete', id),
    restoreProject: (id) => ipcRenderer.invoke('chats:project-undo', id),
    moveToProject: (ids, projectId) => ipcRenderer.invoke('chats:project-move', ids, projectId),
    restoreProjects: (moves) => ipcRenderer.invoke('chats:project-restore', moves),
    newInProject: (projectId) => ipcRenderer.invoke('chats:new-in-project', projectId),
    pickProjectFolder: () => ipcRenderer.invoke('chats:project-pick-folder'),
    projectFolder: (id, action, arg) => ipcRenderer.invoke('chats:project-folder', id, action, arg),
    open: (id) => ipcRenderer.invoke('chats:open', id), // also "Move chat to this tab"
    showTab: (id) => ipcRenderer.invoke('chats:show-tab', id), // "Open chat in its tab"
    share: (id) => ipcRenderer.invoke('chats:share', id), // "Also show in this tab" (the chat stays in the tabs it was in)
    runNow: () => ipcRenderer.invoke('chats:run-now'), // "Run now" on the open chat that waits for a slot
    stopChat: (id) => ipcRenderer.invoke('chats:stop', id), // "Stop waiting" (or stop) any chat, not only the open one
    rename: (id, title) => ipcRenderer.invoke('chats:rename', id, title),
    remove: (id) => ipcRenderer.invoke('chats:delete', id), // hides the chat for a few seconds (undoRemove), then erases it
    undoRemove: (id) => ipcRenderer.invoke('chats:undo-delete', id),
    pin: (id, on) => ipcRenderer.invoke('chats:pin', id, on),
    archive: (id, on) => ipcRenderer.invoke('chats:archive', id, on),
    search: (query) => ipcRenderer.invoke('chats:search', query), // chats whose title or messages match: [{ id, snippet }]
    exportChat: (id) => ipcRenderer.invoke('chats:export', id),
    closeTabs: (id) => ipcRenderer.invoke('chats:close-tabs', id), // [ai manners] "Close this chat's tabs"
    workFolder: (action, arg, confirmed) => ipcRenderer.invoke('chats:work-folder', action, arg, confirmed), // [work folder] the open chat's folder: get / pick / set / clear / open
    onUsage: on('chats:usage'),
    onContext: on('chats:context'), // [context] how full the open chat's context window is (features/chat-usage.js contextView)
    onChanged: on('chats:changed'), // a chat started or stopped running, needs an OK, or finished unseen
  },
  // [memory] Saved memory (ai/memory.js): the chat's "Remembered" row (Undo / Forget) and /memory.
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    undo: (token) => ipcRenderer.invoke('memory:undo', token),
    forget: (id) => ipcRenderer.invoke('memory:forget', id),
  },
  // Quick notes (renderer/notes.js; features/notes-hub.js): one call for everything the panel and the "Add to notes" buttons do.
  notes: {
    act: (op, arg) => ipcRenderer.invoke('notes:act', op, arg),
    onChanged: on('notes:changed'),
  },
  // The Research board (renderer/research.js; ai/research-board.js): the open chat's sources, notes and pinned quotes.
  research: {
    get: () => ipcRenderer.invoke('research:get'),
    addPage: () => ipcRenderer.invoke('research:add-page'), // "Add this page": metadata of the tab in front
    update: (n, patch) => ipcRenderer.invoke('research:update', n, patch), // { starred, note, title }
    remove: (n) => ipcRenderer.invoke('research:remove', n),
    pin: (n, text, page) => ipcRenderer.invoke('research:pin', n, text, page),
    pinSelection: (n) => ipcRenderer.invoke('research:pin-selection', n), // the text selected in the tab in front
    unpin: (n, q) => ipcRenderer.invoke('research:unpin', n, q),
    cite: (n, style) => ipcRenderer.invoke('research:cite', n, style), // n null: the whole bibliography; copies to the clipboard
    open: (url) => ipcRenderer.invoke('research:open', url), // a URL the board holds, in a new tab
    onChanged: on('research:changed'),
  },
  offers: { get: () => ipcRenderer.invoke('offers:get'), act: (action, arg) => ipcRenderer.invoke('offers:act', action, arg) }, // the "New in Lumen" card (renderer/offer-card.js)
  dictation: { status: () => ipcRenderer.invoke('dictation:status'), transcribe: (bytes, format) => ipcRenderer.invoke('dictation:transcribe', bytes, format) }, // [dictation] voice input (renderer/dictation.js): which provider, and the recording's text
  // Meeting helper (renderer/meeting.js; features/meeting.js): live prompting, context, stealth overlay, live listener.
  meeting: {
    getState: () => ipcRenderer.invoke('meeting:state'),
    getContext: () => ipcRenderer.invoke('meeting:context-get'),
    saveContext: (ctx) => ipcRenderer.invoke('meeting:context-save', ctx),
    prompt: (text, opts) => ipcRenderer.invoke('meeting:prompt', text, opts),
    startLive: () => ipcRenderer.invoke('meeting:live-start'),
    stopLive: () => ipcRenderer.invoke('meeting:live-stop'),
    sendTranscript: (text, speaker) => ipcRenderer.invoke('meeting:transcript-chunk', text, speaker),
    setStealth: (on) => ipcRenderer.invoke('meeting:stealth', on),
    summarize: (text) => ipcRenderer.invoke('meeting:summarize', text),
    saveToChat: (payload) => ipcRenderer.invoke('meeting:save-chat', payload),
    onToggle: on('meeting:toggle'),
    onEvent: on('meeting:event'),
  },
  // The sidebar working on its own: whether it is open, the mark on its button, a notification clicked
  sidebarState: (open) => ipcRenderer.send('chat:sidebar-state', open),
  setSidebarOpen: (tabId, open) => ipcRenderer.invoke('sidebar:set', tabId ?? null, Boolean(open)), // [sidebar per tab] the sidebar is open or closed on this tab
  onAttention: on('agent:attention'), // { state: 'approval' | 'unread' | null, approvals, unread }
  onOpenChat: on('agent:open-chat'), // { id }: show the sidebar on that chat
  // Background tasks (renderer/tasks.js, features/background-runner.js)
  tasks: {
    state: () => ipcRenderer.invoke('tasks:state'),
    preview: (spec) => ipcRenderer.invoke('tasks:preview', spec),
    create: (spec) => ipcRenderer.invoke('tasks:create', spec),
    get: (id) => ipcRenderer.invoke('tasks:get', id),
    run: (id, opts) => ipcRenderer.invoke('tasks:run', id, opts),
    edit: (id, patch, opts) => ipcRenderer.invoke('tasks:edit', id, patch, opts),
    stop: (id) => ipcRenderer.invoke('tasks:stop', id),
    remove: (id) => ipcRenderer.invoke('tasks:delete', id),
    approve: (id, approvalId, choice) => ipcRenderer.invoke('tasks:approve', id, approvalId, choice),
    schedule: (id, schedule) => ipcRenderer.invoke('tasks:schedule', id, schedule),
    enable: (id, on) => ipcRenderer.invoke('tasks:enable', id, on),
    openPage: (id) => ipcRenderer.invoke('tasks:open-page', id),
    settings: (patch) => ipcRenderer.invoke('tasks:settings', patch),
    saveRoutine: (spec) => ipcRenderer.invoke('routines:save', spec), // routines (renderer/routines.js)
    routinePreview: (spec) => ipcRenderer.invoke('routines:preview', spec),
    routineWebhookKey: (id) => ipcRenderer.invoke('routines:webhook-key', id), // a new key for a routine's web link, shown once

    onState: on('tasks:state'),
    onToast: on('tasks:toast'),
    onOpen: on('tasks:open'),
    onPropose: on('tasks:propose'),
    openFull: () => ipcRenderer.send('mission:open'), // lumen://tasks
  },
  onEvent: on('agent:event'),
  // AI agents over MCP
  onMcpEvent: on('mcp:event'),
  stopMcp: () => ipcRenderer.send('mcp:stop'),
  // Other apps using Lumen (external-apps.js): pills and prompt; mcp:external-<state|answer> / -<stop|takeover|resume>
  externalApps: { on: on('external:state'), state: () => ipcRenderer.invoke('mcp:external-state'), answer: (id, d) => ipcRenderer.invoke('mcp:external-answer', id, d), connectClaudeCode: () => ipcRenderer.invoke('mcp:external-connect', 'claude-code'), send: (m, id) => ipcRenderer.send(`mcp:external-${m}`, id) },
  focus: { state: () => ipcRenderer.invoke('focus:state'), start: (minutes) => ipcRenderer.invoke('focus:start', minutes), menu: (point) => ipcRenderer.send('focus:menu', point), onState: on('focus:changed') }, // Focus mode (features/focus.js): the toolbar button
  onHistory: on('agent:history'),
  // The chat as a full page (lumen://chat, features/chat-page.js): open it, and hear about the other view
  openFullPage: (projectId, focus) => ipcRenderer.send('chat:open-page', projectId, focus), // a project's id: the page opens on that project's own page
  onRunStart: on('chat:run-start'), // a turn started in the chat page
  onSync: on('chat:sync'), // the chat page switched chats, started a new one or deleted this one
  onAgentTarget: on('agent:target'), // the tab the running task works in ({ id, title, host, front }), or null
  showAgentTarget: () => ipcRenderer.send('agent:show-target'),
  tabChips: { info: (keys, snaps) => ipcRenderer.invoke('chips:info', keys, snaps), watch: (keys) => ipcRenderer.invoke('chips:watch', keys), open: (request) => ipcRenderer.invoke('chips:open', request), onUpdate: on('chips:update') }, // [tab chips] a tab the chat names, as a chip
  openPreview: (target) => ipcRenderer.invoke('agent:open-preview', target), // [activity cards] the tab a Browser card shows (or its page again)
  thumbsVisible: (visible) => ipcRenderer.send('agent:thumbs-visible', Boolean(visible)), // a Browser card is on screen: its thumbnail may refresh
  onSidebar: on('chat:sidebar'), // fold the sidebar away (the page opened) or bring it back (the page closed)
  approve: (approvalId, ok) => ipcRenderer.send('agent:approve', approvalId, ok),
  sendUndo: (id) => ipcRenderer.send('agent:send-undo', id), // Gmail send: Undo within the 10 seconds
  sendStop: () => ipcRenderer.send('agent:send-stop'), // Gmail send: Stop "sending without asking in this chat"
  desktopOpen: (id) => ipcRenderer.invoke('desktop:open', id), desktopControl: (what) => ipcRenderer.send('desktop:control', what), // [desktop apps] the Computer card's Open / Resume / Stop
  undoRun: (runId) => ipcRenderer.invoke('agent:undo', runId), // [ai controls]
  undoEdits: (runId) => ipcRenderer.invoke('agent:undo-edits', runId), // [content guard]
  annotate: (action) => ipcRenderer.invoke('agent:annotate', action), // [annotate] 'show' | 'clear': the last drawing the AI made on the tab
  closeAiTabs: (opts) => ipcRenderer.invoke('agent:ai-tabs-close', opts), // [ai manners] { runId } | { chatId }: close the tabs the AI opened
  undoCloseAiTabs: (token) => ipcRenderer.invoke('agent:ai-tabs-undo', token),
  autoAllow: (on) => ipcRenderer.invoke('agent:auto-allow', on), // no argument: just read it
  permissionMode: (mode) => ipcRenderer.invoke('agent:permission-mode', mode), // [bypass permissions] 'ask' | 'auto' | 'bypass'; no argument: just read it
  helpers: (mode) => ipcRenderer.invoke('agent:helpers', mode), // [subagents] 'off' | 'auto' | 'on'; no argument: just read it
  preferFractions: (on) => ipcRenderer.invoke('agent:prefer-fractions', on), // [prefer fractions] /fractions: true | false; no argument: just read it
  stopHelper: (key) => ipcRenderer.invoke('agent:helper-stop', key), // [acting helpers] a helper card's Stop
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setModel: (id) => ipcRenderer.invoke('settings:set-model', id),
  setEffort: (level) => ipcRenderer.invoke('settings:set-effort', level), // the open chat's own reasoning effort ('' = Auto)
  useGrokBuild: () => ipcRenderer.invoke('settings:use-grok-build'), // the setup card
  useCodex: () => ipcRenderer.invoke('settings:use-codex'), // the setup card (Codex, once found)
  useAntigravity: () => ipcRenderer.invoke('settings:use-antigravity'), // the setup card (Antigravity replaces Gemini CLI)
  openRouterModels: () => ipcRenderer.invoke('openrouter:models'),
  openRouterSignIn: () => ipcRenderer.invoke('openrouter:sign-in'),
  cancelOpenRouterSignIn: () => ipcRenderer.invoke('openrouter:cancel'),
  onSearchEngine: on('search-engine'),
  onModelsUpdated: on('models-updated'),
  // The first-run welcome (features/setup.js): its state, import without a dialog, the default browser.
  setup: {
    state: () => ipcRenderer.invoke('settings:setup-state'),
    done: () => ipcRenderer.invoke('settings:setup-done'),
    importFrom: (id) => ipcRenderer.invoke('import:quiet', id),
    makeDefault: () => ipcRenderer.invoke('settings:make-default'),
    isDefault: () => ipcRenderer.invoke('settings:default-browser'),
    onWelcome: on('setup:welcome'),
  },
  ...testOnly,
});

// Skills (features/skills.js): the composer's "/" menu. Running one is a normal chat message; managing
// them is in lumen://settings (settings-preload.js).
contextBridge.exposeInMainWorld('skillsApi', {
  menu: () => ipcRenderer.invoke('skills:menu'),
  context: (options) => ipcRenderer.invoke('skills:context', options),
  prepare: (request) => ipcRenderer.invoke('skills:prepare', request),
  draftFromChat: () => ipcRenderer.invoke('skills:draft-from-chat'),
  offerSave: (token) => ipcRenderer.invoke('skills:offer-save', token), // the cards under a reply (Settings → Skills → "Offer to save and improve skills")
  offerUpdate: (token) => ipcRenderer.invoke('skills:offer-update', token),
  onChanged: on('skills:changed'),
  onRun: on('skill:run'), // "Run skill" on selected text in a page's right-click menu
});

contextBridge.exposeInMainWorld('lumenFiles', {
  ...Object.fromEntries('list pin unpin remove clear show find relocate search attach scan restore thumb'.split(' ').map((o) => [o, (a, b) => ipcRenderer.invoke(`files:${o}`, a, b)])),
  open: (a) => ipcRenderer.invoke('files:open-entry', a), on: (n, cb) => on('files:' + n)(cb),
});
// Macros (features/macros-runtime.js): the "/macro" command, the progress toast and the questions a run asks. Making and editing
// them is in lumen://settings (settings-preload.js).
contextBridge.exposeInMainWorld('macrosApi', {
  menu: () => ipcRenderer.invoke('macros:menu'),
  run: (request) => ipcRenderer.invoke('macros:run', request),
  stop: (runId) => ipcRenderer.invoke('macros:stop', runId),
  resume: (runId) => ipcRenderer.invoke('macros:resume', runId),
  edit: (id) => ipcRenderer.invoke('macros:edit', id),
  stopRecording: (opts) => ipcRenderer.invoke('macros:record-stop', opts),
  onChanged: on('macros:changed'),
  onProgress: on('macros:progress'),
  onVars: on('macros:vars'),
  onRecording: on('macros:recording'),
  onSidebar: on('macros:sidebar'),
});

// ---- [claude code engine] + [page context]
contextBridge.exposeInMainWorld('lumenExtras', {
  getPageContext: () => ipcRenderer.invoke('pagecontext:get'),
  setPageContext: (on) => ipcRenderer.invoke('pagecontext:set', on),
  // { installed, signedIn: true|false|'unknown', accountType: 'subscription'|'apiKey'|null, detail }
  claudeCodeStatus: (refresh) => ipcRenderer.invoke('claudecode:status', refresh),
  // [ai controls] sites where the user turned AI off (features/ai-sites.js)
  aiSiteState: (url) => ipcRenderer.invoke('settings:ai-site-state', url), // { site, off }
  setAiSite: (site, off) => ipcRenderer.invoke('settings:set-ai-site', site, off),
  // [usage] the plan's limits and Lumen's share (features/usage.js)
  usage: (refresh, cached) => ipcRenderer.invoke('usage:get', { refresh: Boolean(refresh), cached: Boolean(cached) }),
  openUsage: () => ipcRenderer.send('settings-page:open', 'usage'),
});
// ---- [/claude code engine] + [/page context]
