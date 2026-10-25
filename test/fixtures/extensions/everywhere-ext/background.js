// Listeners on every request, as most blockers and password managers register. (Lumen's own request hooks keep Electron from ever
// calling chrome.webRequest listeners, so they cost nothing to run; the test shows registering them costs a page load nothing either.)
chrome.webRequest.onBeforeRequest.addListener(() => {}, { urls: ['<all_urls>'] });
chrome.webRequest.onHeadersReceived.addListener(() => {}, { urls: ['<all_urls>'] });
chrome.webRequest.onCompleted.addListener(() => {}, { urls: ['<all_urls>'] });
