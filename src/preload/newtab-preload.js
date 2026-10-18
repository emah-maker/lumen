// The new-tab page's way to hand its Ask AI question (text and pictures) to the browser: window.lumenNewtab. Registered session-wide as a
// 'frame' preload (main.js), the same idiom as error-preload.js, so it does nothing on any page but renderer/newtab.html's top frame;
// main answers only that page too (the newtab-ai:* calls check the sender's own address). Nothing travels in the page's URL.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/renderer\/newtab\.html$/.test(location.pathname) && window.top === window) {
  contextBridge.exposeInMainWorld('lumenNewtab', {
    // { text, images: [{ type, data: ArrayBuffer, name? }], inNewTab } -> true when the chat opened
    askAi: (o) => ipcRenderer.invoke('newtab-ai:ask', o),
    // The OS picker for pictures (main opens it) -> { images: [{ name, type, data }], problems: [{ code, name }] }
    pickImages: () => ipcRenderer.invoke('newtab-ai:pick'),
    // Music-reactive home screen (Settings): which tab's sound to analyse -> { key, id } | { key: null }; main answers only while the setting is on
    musicSource: (have) => ipcRenderer.invoke('newtab-music:source', have),
  });
}
