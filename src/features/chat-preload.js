// Preload for the lumen://chat tab only (features/chat-page.js). main.js gives it to that one tab,
// it exposes the chat calls and nothing else (no generic privileged IPC), and main checks every
// call again: it must come from the top frame of a chat tab showing renderer/chat-page.html.
const { contextBridge, ipcRenderer: electronIpc } = require('electron');

// A spare page (main.js makeSpareChat) loads in the background before any chat tab needs it, so its scripts are parsed and its
// markup laid out by the time a tab takes it. It is no tab yet, so its calls wait (main would refuse them) until main hands it to
// one ('chat:adopt'); from then on it starts exactly as a page opened fresh does.
const spare = process.argv.includes('--lumen-spare-chat'); // (features/chat-page.js SPARE_FLAG)
const adopted = spare ? new Promise((resolve) => electronIpc.once('chat:adopt', () => resolve())) : null;
const ipcRenderer = spare
  ? { on: (...args) => electronIpc.on(...args), sendSync: (...args) => electronIpc.sendSync(...args), invoke: (...args) => adopted.then(() => electronIpc.invoke(...args)), send: (...args) => { adopted.then(() => electronIpc.send(...args)); } }
  : electronIpc;

if (location.protocol === 'file:' && /\/renderer\/chat-page\.html$/.test(location.pathname)) {
  const on = (channel) => (callback) => ipcRenderer.on(channel, (_e, payload) => callback(payload));

  contextBridge.exposeInMainWorld('lumenI18n', ipcRenderer.sendSync('ui:strings'));
  window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add(`platform-${process.platform}`));

  // The same shape the sidebar's window.assistant has, cut down to what a conversation needs.
  contextBridge.exposeInMainWorld('assistant', {
    ask: (text, runId, images, tabIds, files, screen, opts) => ipcRenderer.send('agent:ask', text, runId, images, tabIds, files, screen, opts),
    dropScreen: (id) => ipcRenderer.invoke('agent:screen-drop', id),
    uploads: {
      stash: (file) => ipcRenderer.invoke('uploads:stash', file),
      discard: (ref) => ipcRenderer.send('uploads:discard', ref),
      choose: (approvalId) => ipcRenderer.invoke('agent:upload-choose', approvalId),
    },
    askTabs: () => ipcRenderer.invoke('tabs:ask-list'), // the "@" picker's tabs
    stop: () => ipcRenderer.send('agent:stop'),
    resync: () => Promise.resolve(null), // (the chat page has no tab of its own to follow)
    reset: () => ipcRenderer.send('agent:reset'),
    rewind: (expected) => ipcRenderer.invoke('agent:rewind', expected),
    rewindUser: (ordinal, expected) => ipcRenderer.invoke('agent:rewind-user', ordinal, expected),
    switchVersion: (at, target) => ipcRenderer.invoke('agent:version', at, target),
    feedback: (ordinal, value) => ipcRenderer.invoke('agent:feedback', ordinal, value),
    btw: (id, text) => ipcRenderer.invoke('agent:btw', id, text), // /btw: a side question answered beside the running task
    btwCancel: (id) => ipcRenderer.send('agent:btw-cancel', id),
    onBtw: on('agent:btw-event'),
    // Pictures the AI made (renderer/gen-images.js): the picture as a data URL, Save image, Copy image, and a web picture the user clicked.
    images: {
      data: (id) => ipcRenderer.invoke('images:data', id),
      save: (id) => ipcRenderer.invoke('images:save', id),
      copy: (id) => ipcRenderer.invoke('images:copy', id),
      remote: (url) => ipcRenderer.invoke('images:remote', url),
      openTab: (dataUrl) => ipcRenderer.invoke('images:open-tab', dataUrl), // the viewer's "Open in a tab"
    },
    // Files the AI made (renderer/ai-files.js): the file card's preview, and Open in a tab / the system app / Show in folder. By card id only.
    files: {
      preview: (id) => ipcRenderer.invoke('aifiles:preview', id),
      open: (id, how, opts) => ipcRenderer.invoke('aifiles:open', id, how, opts),
    },
    notes: { act: (op, arg) => ipcRenderer.invoke('notes:act', op, arg) }, // [notes] "Add to notes" under a reply (features/notes-hub.js)
    memory: { // [memory] the chat's "Remembered" row (Undo / Forget) and /memory (ai/memory.js)
      list: () => ipcRenderer.invoke('memory:list'),
      undo: (token) => ipcRenderer.invoke('memory:undo', token),
      forget: (id) => ipcRenderer.invoke('memory:forget', id),
    },
    chats: {
      list: () => ipcRenderer.invoke('chats:list'),
      open: (id) => ipcRenderer.invoke('chats:open', id),
      showTab: (id) => ipcRenderer.invoke('chats:show-tab', id),
      share: (id) => ipcRenderer.invoke('chats:share', id),
      stopChat: (id) => ipcRenderer.invoke('chats:stop', id),
      rename: (id, title) => ipcRenderer.invoke('chats:rename', id, title),
      remove: (id) => ipcRenderer.invoke('chats:delete', id),
      undoRemove: (id) => ipcRenderer.invoke('chats:undo-delete', id),
      pin: (id, on) => ipcRenderer.invoke('chats:pin', id, on),
      archive: (id, on) => ipcRenderer.invoke('chats:archive', id, on),
      search: (query) => ipcRenderer.invoke('chats:search', query),
      exportChat: (id, format) => ipcRenderer.invoke('chats:export', id, format),
      markdown: (id) => ipcRenderer.invoke('chats:markdown', id),
      temporary: () => ipcRenderer.invoke('chats:temporary'),
      saveProject: (project) => ipcRenderer.invoke('chats:project-save', project),
      removeProject: (id) => ipcRenderer.invoke('chats:project-delete', id),
      restoreProject: (id) => ipcRenderer.invoke('chats:project-undo', id), // [project workspace] Undo of a delete
      project: (id) => ipcRenderer.invoke('chats:project-get', id), // everything the project page shows
      projectFilesAdd: (id, files) => ipcRenderer.invoke('chats:project-files-add', id, files), // [{ name, bytes }]
      projectFileRemove: (id, fileId) => ipcRenderer.invoke('chats:project-file-remove', id, fileId),
      projectSearch: (id, query) => ipcRenderer.invoke('chats:project-search', id, query),
      projectLink: (id, change) => ipcRenderer.invoke('chats:project-link', id, change), // { add: { url, title } } | { remove: url }
      projectAddTab: (id) => ipcRenderer.invoke('chats:project-add-tab', id), // the tab the chat works with
      projectMemoryForget: (id, entryId) => ipcRenderer.invoke('chats:project-memory-forget', id, entryId),
      projectDefaults: (id, defaults) => ipcRenderer.invoke('chats:project-defaults', id, defaults),
      setProject: (id, projectId) => ipcRenderer.invoke('chats:project-set', id, projectId),
      moveToProject: (ids, projectId) => ipcRenderer.invoke('chats:project-move', ids, projectId),
      restoreProjects: (moves) => ipcRenderer.invoke('chats:project-restore', moves),
      runNow: () => ipcRenderer.invoke('chats:run-now'),
      newInProject: (projectId) => ipcRenderer.invoke('chats:new-in-project', projectId),
      pickProjectFolder: () => ipcRenderer.invoke('chats:project-pick-folder'), // [project folders] "Use an existing folder…"
      projectFolder: (id, action, arg) => ipcRenderer.invoke('chats:project-folder', id, action, arg), // open / locate / recreate / rename / work / work-clear / write-all
      workFolder: (action, arg, confirmed) => ipcRenderer.invoke('chats:work-folder', action, arg, confirmed), // [work folder] the open chat's folder: get / pick / set / clear / open
      closeTabs: (id) => ipcRenderer.invoke('chats:close-tabs', id), // [ai manners]
      onUsage: on('chats:usage'),
      onContext: on('chats:context'),
      onChanged: on('chats:changed'),
    },
    onEvent: on('agent:event'),
    onRunStart: on('chat:run-start'),
    onSync: on('chat:sync'),
    onTarget: on('chat:target'),
    approve: (approvalId, ok) => ipcRenderer.send('agent:approve', approvalId, ok),
    sendUndo: (id) => ipcRenderer.send('agent:send-undo', id), // Gmail send: Undo within the 10 seconds
    sendStop: () => ipcRenderer.send('agent:send-stop'), // Gmail send: Stop "sending without asking in this chat"
    desktopOpen: (id) => ipcRenderer.invoke('desktop:open', id), desktopControl: (what) => ipcRenderer.send('desktop:control', what), // [desktop apps]
    hideAiTabs: (on) => ipcRenderer.invoke('tabs:hide-ai', on), // [activity cards] the card's "Hide tabs the AI opened" (no argument: read it)
    tabChips: { info: (keys, snaps) => ipcRenderer.invoke('chips:info', keys, snaps), watch: (keys) => ipcRenderer.invoke('chips:watch', keys), open: (request) => ipcRenderer.invoke('chips:open', request), onUpdate: on('chips:update') }, // [tab chips] a tab the chat names, as a chip
    openPreview: (target) => ipcRenderer.invoke('agent:open-preview', target), // [activity cards] the tab a Browser card shows (or its page again)
    thumbsVisible: (visible) => ipcRenderer.send('agent:thumbs-visible', Boolean(visible)), // a Browser card is on screen: its thumbnail may refresh
    undoRun: (runId) => ipcRenderer.invoke('agent:undo', runId),
    closeAiTabs: (opts) => ipcRenderer.invoke('agent:ai-tabs-close', opts), // [ai manners]
    undoCloseAiTabs: (token) => ipcRenderer.invoke('agent:ai-tabs-undo', token),
    autoAllow: (on) => ipcRenderer.invoke('agent:auto-allow', on),
    permissionMode: (mode) => ipcRenderer.invoke('agent:permission-mode', mode), // [bypass permissions]
    helpers: (on) => ipcRenderer.invoke('agent:helpers', on), // [subagents]
    preferFractions: (on) => ipcRenderer.invoke('agent:prefer-fractions', on), // [prefer fractions] /fractions
    stopHelper: (key) => ipcRenderer.invoke('agent:helper-stop', key), // [acting helpers]
    routines: { preview: (text) => ipcRenderer.invoke('chat:routine-preview', { text }), create: (spec) => ipcRenderer.invoke('chat:routine-create', spec) }, // [routines] "Schedule this" (renderer/chat-routines.js)
    dictation: { status: () => ipcRenderer.invoke('dictation:status'), transcribe: (bytes, format) => ipcRenderer.invoke('dictation:transcribe', bytes, format) }, // [dictation] voice input (renderer/dictation.js)
    offers: { get: () => ipcRenderer.invoke('offers:get'), act: (action, arg) => ipcRenderer.invoke('offers:act', action, arg) }, // the "New in Lumen" card (renderer/offer-card.js)
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setModel: (id) => ipcRenderer.invoke('settings:set-model', id),
    setEffort: (level) => ipcRenderer.invoke('settings:set-effort', level),
    onModelsUpdated: on('models-updated'), // the model was picked elsewhere (sidebar, Settings, another window): the page's picker follows at once
    openRouterModels: () => ipcRenderer.invoke('openrouter:models'),
    // Page only
    state: () => ipcRenderer.invoke('chatpage:state'),
    backToSidebar: () => ipcRenderer.send('chatpage:back'),
    home: () => ipcRenderer.send('chatpage:home'),
    openLink: (url) => ipcRenderer.send('chatpage:link', url),
  });
  contextBridge.exposeInMainWorld('lumenPrefs', {
    openSettingsPage: (section) => ipcRenderer.send('settings-page:open', section),
    get: () => ipcRenderer.invoke('prefs:ui'),
    onChange: on('prefs:ui'),
  });
  // The "/" menu (features/skills.js); no right-click "Run skill" here: that opens the sidebar.
  contextBridge.exposeInMainWorld('skillsApi', {
    menu: () => ipcRenderer.invoke('skills:menu'),
    context: (options) => ipcRenderer.invoke('skills:context', options),
    prepare: (request) => ipcRenderer.invoke('skills:prepare', request),
    draftFromChat: () => ipcRenderer.invoke('skills:draft-from-chat'),
    offerSave: (token) => ipcRenderer.invoke('skills:offer-save', token),
    offerUpdate: (token) => ipcRenderer.invoke('skills:offer-update', token),
    onChanged: on('skills:changed'),
  });
  contextBridge.exposeInMainWorld('lumenExtras', {
    usage: (refresh, cached) => ipcRenderer.invoke('usage:get', { refresh: Boolean(refresh), cached: Boolean(cached) }),
    openUsage: () => ipcRenderer.send('settings-page:open', 'usage'),
  });
}
