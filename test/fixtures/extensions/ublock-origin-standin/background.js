// uBlock Origin's vapi.js: `browser` when the page has one, then browserAction straight away (it stopped here in Electron 44 without Lumen's preload).
if (self.browser instanceof Object) self.chrome = self.browser; else self.browser = self.chrome;
browser.browserAction.setBadgeText({ text: '' });
browser.browserAction.onClicked.addListener(() => {});
self.seen = [];
browser.webRequest.onBeforeRequest.addListener((d) => {
  if (!/\/standin-ad\.js/.test(d.url)) return undefined;
  self.seen.push(d.tabId);
  return { cancel: d.tabId >= 0 };
}, { urls: ['<all_urls>'] }, ['blocking']);
// uBlock Origin's element hiding (vapi-background.js userCSS): each frame's rules go back to that frame with tabs.insertCSS (asking for user sheets), and
// come out again with tabs.removeCSS.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.css !== 'string' || !sender.tab) return;
  const details = { code: msg.css, frameId: sender.frameId, matchAboutBlank: true, cssOrigin: 'user' };
  if (msg.remove) chrome.tabs.removeCSS(sender.tab.id, details);
  else chrome.tabs.insertCSS(sender.tab.id, { ...details, runAt: 'document_start' });
});
