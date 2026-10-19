// File tabs in a saved session (main.js sessionEntry / restoreTabsFrom / closeTab).
//
// A tab that shows a file is not at the file's address: a PDF is in Lumen's viewer (lumen-pdf://app/viewer.html?u=<file>) and a deck is in
// the slide viewer (<install folder>/renderer/slides.html?u=<file>), which moves with every update. The session therefore saves the FILE's
// own address (features/file-tabs.js addressOf) and restoring loads that address, which routes it to the viewer again.
//
//   savedUrl(url)        what the session keeps for a tab at `url`: its file's address, or '' when the tab is no file tab
//   localPath(url)       the path on disk of a file: address ('' for any other address)
//   missingUrl(errorUrl, url)   the "moved or deleted" page for a file that is not there
//   missingTarget(url)   the file address a "moved or deleted" page is about ('' when `url` is no such page)

const { fileURLToPath } = require('url');
const fileTabs = require('./file-tabs');

const KIND = 'missingfile';

function savedUrl(url) {
  return fileTabs.addressOf(url) || '';
}

function localPath(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'file:' ? fileURLToPath(`${u.protocol}//${u.host}${u.pathname}`) : '';
  } catch { return ''; }
}

// A file: address of a file the user opened (not one of Lumen's own pages): the ones worth checking for existence.
const isUserFile = (url) => /^file:/i.test(String(url)) && Boolean(fileTabs.addressOf(url));

function missingUrl(errorUrl, url) {
  return `${errorUrl}?${new URLSearchParams({ url: String(url), kind: KIND })}`;
}

function missingTarget(url, errorUrl) {
  try {
    const u = new URL(String(url));
    if (!String(url).startsWith(errorUrl) || u.searchParams.get('kind') !== KIND) return '';
    const target = u.searchParams.get('url') || '';
    return isUserFile(target) ? target : '';
  } catch { return ''; }
}

// `existsSync` is passed in so this stays testable.
function loadTarget(url, errorUrl, existsSync) {
  if (!isUserFile(url)) return url;
  const file = localPath(url);
  return file && !existsSync(file) ? missingUrl(errorUrl, url) : url;
}

module.exports = { KIND, savedUrl, localPath, isUserFile, missingUrl, missingTarget, loadTarget };
