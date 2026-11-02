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
