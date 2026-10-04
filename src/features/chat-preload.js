// Preload for the lumen://chat tab only (features/chat-page.js). main.js gives it to that one tab,
// it exposes the chat calls and nothing else (no generic privileged IPC), and main checks every
// call again: it must come from the top frame of a chat tab showing renderer/chat-page.html.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/renderer\/chat-page\.html$/.test(location.pathname)) {
  const on = (channel) => (callback) => ipcRenderer.on(channel, (_e, payload) => callback(payload));

  contextBridge.exposeInMainWorld('lumenI18n', ipcRenderer.sendSync('ui:strings'));
  window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add(`platform-${process.platform}`));

  // The same shape the sidebar's window.assistant has, cut down to what a conversation needs.
  contextBridge.exposeInMainWorld('assistant', {
    ask: (text, runId, images, tabIds) => ipcRenderer.send('agent:ask', text, runId, images, tabIds),
    askTabs: () => ipcRenderer.invoke('tabs:ask-list'), // the "@" picker's tabs
    stop: () => ipcRenderer.send('agent:stop'),
    resync: () => Promise.resolve(null), // (the chat page has no tab of its own to follow)
    reset: () => ipcRenderer.send('agent:reset'),
    rewind: (expected) => ipcRenderer.invoke('agent:rewind', expected),
    // Pictures the AI made (renderer/gen-images.js): the picture as a data URL, Save image, Copy image, and a web picture the user clicked.
    images: {
      data: (id) => ipcRenderer.invoke('images:data', id),
      save: (id) => ipcRenderer.invoke('images:save', id),
      copy: (id) => ipcRenderer.invoke('images:copy', id),
      remote: (url) => ipcRenderer.invoke('images:remote', url),
    },
    chats: {
      list: () => ipcRenderer.invoke('chats:list'),
      open: (id) => ipcRenderer.invoke('chats:open', id),
      showTab: (id) => ipcRenderer.invoke('chats:show-tab', id),
      share: (id) => ipcRenderer.invoke('chats:share', id),
      stopChat: (id) => ipcRenderer.invoke('chats:stop', id),
      rename: (id, title) => ipcRenderer.invoke('chats:rename', id, title),
      remove: (id) => ipcRenderer.invoke('chats:delete', id),
      exportChat: (id) => ipcRenderer.invoke('chats:export', id),
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
    undoRun: (runId) => ipcRenderer.invoke('agent:undo', runId),
    closeAiTabs: (opts) => ipcRenderer.invoke('agent:ai-tabs-close', opts), // [ai manners]
    undoCloseAiTabs: (token) => ipcRenderer.invoke('agent:ai-tabs-undo', token),
    autoAllow: (on) => ipcRenderer.invoke('agent:auto-allow', on),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setModel: (id) => ipcRenderer.invoke('settings:set-model', id),
    onModelsUpdated: on('models-updated'), // the model was picked elsewhere (sidebar, Settings, another window): the page's picker follows at once
    openRouterModels: () => ipcRenderer.invoke('openrouter:models'),
    // Page only
    state: () => ipcRenderer.invoke('chatpage:state'),
    backToSidebar: () => ipcRenderer.send('chatpage:back'),
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
    onChanged: on('skills:changed'),
  });
  contextBridge.exposeInMainWorld('lumenExtras', {
    usage: (refresh, cached) => ipcRenderer.invoke('usage:get', { refresh: Boolean(refresh), cached: Boolean(cached) }),
    openUsage: () => ipcRenderer.send('settings-page:open', 'usage'),
  });
}
