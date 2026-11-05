// The Bookmarks, Reading list and Downloads pages' bridge (features/managers.js), and lumen://tasks's (renderer/mission.html) and lumen://automations's (renderer/automations.html; main.js answers both). Only a tab opened as one of
// those pages gets this preload, and only that page's own document sees the API; main checks the
// sender again before answering.
const { contextBridge, ipcRenderer } = require('electron');

const page = location.protocol === 'file:' ? (/\/renderer\/(bookmarks|readinglist|downloads|mission|automations)\.html$/.exec(location.pathname) || [])[1] : null;
const onChange = (channel) => (fn) => { if (typeof fn === 'function') ipcRenderer.on(channel, () => fn()); };

if (page) contextBridge.exposeInMainWorld('lumenI18n', ipcRenderer.sendSync('pages:strings') || { locale: 'en', strings: {} }); // renderer/i18n.js
if (page === 'bookmarks') {
  contextBridge.exposeInMainWorld('lumenBookmarks', {
    list: () => ipcRenderer.invoke('bookmarks:list'),
    add: (b) => ipcRenderer.invoke('bookmarks:add', b),
    update: (b) => ipcRenderer.invoke('bookmarks:update', b),
    remove: (url) => ipcRenderer.invoke('bookmarks:remove', url),
    restore: (b) => ipcRenderer.invoke('bookmarks:restore', b), // Undo of a removal
    open: (url) => ipcRenderer.invoke('bookmarks:open', url),
    exportFile: () => ipcRenderer.invoke('bookmarks:export'),
    importFile: () => ipcRenderer.invoke('bookmarks:import'),
    onChange: onChange('bookmarks:changed'),
  });
} else if (page === 'readinglist') {
  contextBridge.exposeInMainWorld('lumenReadingList', {
    list: () => ipcRenderer.invoke('readinglist:list'),
    open: (url) => ipcRenderer.invoke('readinglist:open', url), // marks it read
    remove: (url) => ipcRenderer.invoke('readinglist:remove', url),
    restore: (item) => ipcRenderer.invoke('readinglist:restore', item), // Undo of a removal
    mark: (url, read) => ipcRenderer.invoke('readinglist:mark', url, read),
    markAllRead: () => ipcRenderer.invoke('readinglist:markall'),
    onChange: onChange('readinglist:changed'),
  });
} else if (page === 'downloads') {
  contextBridge.exposeInMainWorld('lumenDownloads', {
    list: () => ipcRenderer.invoke('downloads:list'),
    act: (id, action) => ipcRenderer.invoke('downloads:act', id, action),
    openFolder: () => ipcRenderer.invoke('downloads:folder'),
    onChange: onChange('downloads:changed'),
  });
} else if (page === 'mission') {
  // lumen://tasks: what the AI is doing (features/mission-control.js). act() takes { op, kind, id, approvalId, choice, on }:
  // answer a card, Stop, Go to, or a routine on / off, through the same paths as the sidebar and the Tasks panel.
  contextBridge.exposeInMainWorld('lumenMission', {
    state: () => ipcRenderer.invoke('mission:state'),
    act: (req) => ipcRenderer.invoke('mission:act', req),
    onChange: onChange('mission:changed'),
  });
} else if (page === 'automations') {
  // lumen://automations: automations, their runs and the profile (features/automations-runtime.js; main.js answers each call).
  const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
  contextBridge.exposeInMainWorld('lumenAutomations', {
    state: call('automations:state'), save: call('automations:save'), remove: call('automations:delete'), run: call('automations:run'),
    runAct: call('automations:run-act'), item: call('automations:item'), describe: call('automations:describe'),
    recordStart: call('automations:record-start'), recordStop: call('automations:record-stop'),
    saveProfile: call('automations:profile-save'), removeProfile: call('automations:profile-delete'), pickFile: call('automations:pick-file'),
    exportCsv: call('automations:export'), clearLog: call('automations:clear-log'),
    onChange: onChange('automations:changed'),
  });
}
