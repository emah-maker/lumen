// The new-tab page's bridge to the Files widget (features/files.js). Registered session-wide as a 'frame' preload (main.js), the same
// idiom as error-preload.js, so it does nothing on any page but renderer/newtab.html's top frame; main answers only that page too
// (the newtab-files:* calls check the sender's own address). The page gets ids from list() and hands them back; it never names a path
// to open (pin's { path } is for the widget's own picker, which opens a dialog in main and returns the choice).
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/renderer\/newtab\.html$/.test(location.pathname) && window.top === window) {
  const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
  contextBridge.exposeInMainWorld('lumenFiles', {
    list: call('newtab-files:list'),
    pin: call('newtab-files:pin'),
    unpin: call('newtab-files:unpin'),
    remove: call('newtab-files:remove'),
    clear: call('newtab-files:clear'),
    open: call('newtab-files:open'),
    show: call('newtab-files:show'),
    find: call('newtab-files:find'),
    relocate: call('newtab-files:relocate'),
    search: call('newtab-files:search'),
    attach: call('newtab-files:attach'),
    onChanged: (cb) => { if (typeof cb === 'function') ipcRenderer.on('newtab-files:changed', () => cb()); },
  });
}
