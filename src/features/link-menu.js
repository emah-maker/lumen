// ---------- the page's right-click menu: links, images and the page itself ----------
//
// The items Chrome, Safari and Edge put on a link and an image, beyond Open in New Tab and Copy:
//   link:  Open Link in New Window, Open Link in Private Window, Save Link As…
//   image: Save Image As…, Copy Image Address
// "Save … As" always asks where to save, whatever Settings → Downloads says: the download is marked
// here (by its address, for 30 seconds) and features/downloads.js asks for that one download.
// main.js's showContextMenu adds these next to its own items; nothing here touches a window.

const isWebUrl = (url) => /^https?:\/\//i.test(url || '');
// data: images are saved too (Save Image As… on a generated picture); never javascript: or file:.
const isSavable = (url) => isWebUrl(url) || /^data:image\//i.test(url || '') || /^blob:https?:\/\//i.test(url || '');

// deps: { t, openInNewWindow(url), openInPrivateWindow(url)?, saveAs(url), copy(text) }
// -> { open: [Open Link in New Window, … in Private Window], save: [Save Link As…] } (empty lists off a web link).
function linkItems(p, deps) {
  if (!p || !isWebUrl(p.linkURL)) return { open: [], save: [] };
  const open = [{ label: deps.t('menu.openLinkNewWindow'), click: () => deps.openInNewWindow(p.linkURL) }];
  if (deps.openInPrivateWindow) open.push({ label: deps.t('menu.openLinkPrivateWindow'), click: () => deps.openInPrivateWindow(p.linkURL) });
  return { open, save: [{ label: deps.t('menu.saveLinkAs'), click: () => deps.saveAs(p.linkURL) }] };
}

// -> { save: [Save Image As…], copy: [Copy Image Address] } (empty lists off an image).
function imageItems(p, deps) {
  const none = { save: [], copy: [] };
  if (!p || p.mediaType !== 'image' || !p.srcURL) return none;
  return {
    save: isSavable(p.srcURL) ? [{ label: deps.t('menu.saveImageAs'), click: () => deps.saveAs(p.srcURL) }] : [],
    copy: isWebUrl(p.srcURL) ? [{ label: deps.t('menu.copyImageAddress'), click: () => deps.copy(p.srcURL) }] : [],
  };
}

// One-shot "ask where to save" marks, by address. `now` is for the tests.
function createSaveAsMarks({ ttl = 30000, now = () => Date.now() } = {}) {
  const marks = new Map(); // url -> expiry
  const prune = () => { const at = now(); for (const [url, until] of marks) if (until <= at) marks.delete(url); };
  return {
    mark(url) { prune(); if (url) marks.set(String(url), now() + ttl); },
    // True once for a marked address (any of the download's URL chain), then forgotten.
    take(urls) {
      prune();
      for (const url of [].concat(urls || [])) {
        if (marks.has(url)) { marks.delete(url); return true; }
      }
      return false;
    },
    size: () => { prune(); return marks.size; },
  };
}

module.exports = { linkItems, imageItems, createSaveAsMarks, isSavable };
