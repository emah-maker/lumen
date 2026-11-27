'use strict';
// The bookmarks bar, main-process side: what every window's bar shows, its folder and overflow menus and its right-click menu
// (native menus: nested folders open as submenus, with the system's keyboard handling and screen-reader names), and the
// changes the bar makes (drag to reorder, a link or tab dropped on it, Edit, Delete, New folder). The model is bookmark-bar.js;
// the bar itself is renderer/bookmarks-bar.js.
//
// deps: {
//   ipcMain, Menu, nativeImage, dialog,
//   isUiSender(event)                optional: the sender is a window's own browser UI (main.js gates these channels already)
//   read() -> { list, layout }       the bookmarks and settings.bookmarkLayout
//   write({ list, layout })          saves both (one settings write)
//   changed()                        after a write: the star, the Bookmarks page, every bar
//   mode() / setMode(mode)           Settings → Appearance → Show bookmarks bar
//   icon(url) -> data: URL or ''     a site's cached favicon
//   open(url, how, event)            how: 'here' | 'tab' | 'background' | 'window'
//   openManager()                    the Bookmarks page
//   windowOf(event)                  the BrowserWindow a menu pops up in
//   broadcast(channel, payload)      every window's browser UI
//   gen() -> number                  bumped by every settings write (sendTabs pushes the bar only when it moved)
//   t(key, vars)
// }
const BB = require('./bookmark-bar');

const MAX_MENU_TITLE = 60;
const webUrl = (u) => {
  try {
    const raw = String(u ?? '').trim();
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
};
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const short = (s) => (s.length > MAX_MENU_TITLE ? `${s.slice(0, MAX_MENU_TITLE - 1)}…` : s);
// A menu label: & would underline the next letter on Windows.
const label = (s) => short(String(s || '')).replace(/&/g, '&&');

function createBookmarkBarMain(deps) {
  const t = deps.t || ((k) => k);
  let lastKey = '';
  const rects = new WeakMap(); // a window's UI -> where its bar is on screen (null while hidden)

  const state = () => {
    const { list, layout } = deps.read();
    return { mode: BB.cleanMode(deps.mode()), items: BB.tree(list, layout, { icon: deps.icon }) };
  };
  // Every bar again, when the bookmarks, their layout, the mode or an icon changed.
  function push(force = false) {
    const s = state();
    const key = JSON.stringify(s);
    if (!force && key === lastKey) return;
    lastKey = key;
    deps.broadcast('bookmarks-bar:state', s);
  }
  let soon = null;
  // A site's icon arrived (main.js cacheFavicon): one push for a burst of them.
  const pushSoon = () => { if (soon) return; soon = setTimeout(() => { soon = null; push(); }, 250); soon.unref?.(); };
  let lastGen = -1;
  // From sendTabs (every bookmark change ends in one): cheap unless a settings write happened since.
  const pushIfChanged = () => { const g = deps.gen(); if (g === lastGen) return; lastGen = g; push(); };

  function commit(r) {
    if (!r?.ok) return r;
    deps.write({ list: r.list, layout: r.layout });
    deps.changed();
    push();
    return r;
  }
  const apply = (fn) => { const { list, layout } = deps.read(); return commit(fn(list, layout)); };

  // ---- menus ----
  const iconOf = (url) => {
    const data = deps.icon(url);
    if (!data || !deps.nativeImage) return undefined;
    try { const img = deps.nativeImage.createFromDataURL(data); return img.isEmpty() ? undefined : img.resize({ width: 16, height: 16 }); } catch { return undefined; }
  };
  const openAll = (urls, e) => { for (const u of urls) deps.open(u, 'background', e); };
  // A folder's items as menu items; a folder inside it is a submenu, as deep as they go.
  function itemsOf(children, e, path, depth = 0) {
    const out = children.map((c) => (c.type === 'link'
      ? { label: label(c.title || host(c.url) || c.url), icon: iconOf(c.url), click: () => deps.open(c.url, 'here', e) }
      : { label: label(c.name), submenu: depth > 20 ? [] : itemsOf(c.children, e, c.path, depth + 1) }));
    if (!out.length) out.push({ label: t('bookmarksBar.empty'), enabled: false });
    if (path !== null) {
      const { list, layout } = deps.read();
      const urls = BB.linksIn(list, layout, path);
      if (urls.length) out.push({ type: 'separator' }, { label: t('bookmarksBar.openAll', { count: urls.length }), click: () => openAll(urls, e) });
    }
    return out;
  }
  const popup = (template, e, at) => {
    const win = deps.windowOf(e);
    const menu = deps.Menu.buildFromTemplate(template);
    const done = new Promise((resolve) => menu.once('menu-will-close', () => resolve()));
    menu.popup({ ...(win ? { window: win } : {}), ...(at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: Math.round(at.x), y: Math.round(at.y) } : {}) });
    return done;
  };
  const find = (items, path) => {
    for (const c of items) {
      if (c.type !== 'folder') continue;
      if (c.path === path) return c;
      if (path.startsWith(c.path + '/')) return find(c.children, path);
    }
    return null;
  };

  // A folder chip's menu. Resolves when it closes (the chip stays pressed until then).
  function folderTemplate(e, path) {
    const folder = find(state().items, BB.cleanPath(path));
    return folder ? itemsOf(folder.children, e, folder.path) : null;
  }
  function folderMenu(e, { path, at } = {}) {
    const template = folderTemplate(e, path);
    return template ? popup(template, e, at).then(() => true) : Promise.resolve(false);
  }
  // » : the chips that didn't fit, from `from` on.
  const overflowTemplate = (e, from) => itemsOf(state().items.slice(Math.max(0, Number(from) || 0)), e, null);
  const overflowMenu = (e, { from, at } = {}) => popup(overflowTemplate(e, from), e, at).then(() => true);

  // Right-click on a chip (target) or on the bar's empty part (no target). `parent` and `index` say where New folder goes.
  function contextTemplate(e, { target, parent = '', index } = {}) {
    const ask = (payload) => e.sender.send('bookmarks-bar:edit', payload);
    const items = [];
    if (target?.type === 'link' && webUrl(target.url)) {
      const url = target.url;
      items.push(
        { label: t('bookmarksBar.menu.openNewTab'), click: () => deps.open(url, 'tab', e) },
        { label: t('bookmarksBar.menu.openNewWindow'), click: () => deps.open(url, 'window', e) },
        { type: 'separator' },
        { label: t('bookmarksBar.menu.edit'), click: () => { const { list } = deps.read(); const b = list.find((x) => x.url === url); if (b) ask({ type: 'link', url, title: b.title || '', folder: BB.cleanPath(b.folder) }); } },
        { label: t('bookmarksBar.menu.delete'), click: () => apply((list, layout) => BB.removeLink(list, layout, url)) },
      );
    } else if (target?.type === 'folder') {
      const path = BB.cleanPath(target.path);
      const { list, layout } = deps.read();
      const urls = BB.linksIn(list, layout, path);
      items.push(
        { label: t('bookmarksBar.openAll', { count: urls.length }), enabled: urls.length > 0, click: () => openAll(urls, e) },
        { type: 'separator' },
        { label: t('bookmarksBar.menu.rename'), click: () => ask({ type: 'folder', path, name: BB.nameOf(path) }) },
        { label: t('bookmarksBar.menu.delete'), click: () => removeFolderAsked(e, path) },
      );
    }
    if (items.length) items.push({ type: 'separator' });
    items.push(
      { label: t('bookmarksBar.menu.newFolder'), click: () => ask({ type: 'new-folder', parent: BB.cleanPath(parent), index: Number.isInteger(index) ? index : undefined }) },
      { label: t('bookmarksBar.menu.manager'), click: () => deps.openManager() },
      { type: 'separator' },
      { label: t('bookmarksBar.menu.show'), type: 'checkbox', checked: BB.cleanMode(deps.mode()) === 'always', click: () => toggle() },
    );
    return items;
  }
  const contextMenu = (e, o = {}) => popup(contextTemplate(e, o), e, o.at).then(() => true);

  // A folder with bookmarks in it asks first (there is no Undo on the bar); an empty one just goes.
  async function removeFolderAsked(e, path) {
    const { list, layout } = deps.read();
    const n = BB.linksIn(list, layout, path).length;
    if (n > 0 && deps.dialog) {
      const win = deps.windowOf(e);
      const opts = { type: 'warning', buttons: [t('bookmarksBar.delete.confirm'), t('bookmarksBar.edit.cancel')], defaultId: 1, cancelId: 1, noLink: true, message: t('bookmarksBar.delete.title', { name: BB.nameOf(path) }), detail: t(n === 1 ? 'bookmarksBar.delete.one' : 'bookmarksBar.delete.other', { count: n }) };
      const { response } = await (win ? deps.dialog.showMessageBox(win, opts) : deps.dialog.showMessageBox(opts));
      if (response !== 0) return false;
    }
    return Boolean(apply((l, lay) => BB.removeFolder(l, lay, path))?.ok);
  }

  // ---- changes from the bar ----
  function save(p = {}) {
    if (p.type === 'link') {
      const href = webUrl(p.newUrl ?? p.url);
      if (!href) return { ok: false, error: t('bookmarksBar.edit.badUrl') };
      const r = apply((list, layout) => BB.updateLink(list, layout, { url: p.url, newUrl: href, title: String(p.title ?? '').trim() || host(href) || href, folder: p.folder === undefined ? undefined : BB.cleanPath(p.folder) }));
      return r?.ok ? { ok: true } : { ok: false, error: t(r?.error === 'duplicate' ? 'bookmarksBar.edit.duplicate' : 'bookmarksBar.edit.gone') };
    }
    if (p.type === 'folder') {
      const r = apply((list, layout) => BB.renameFolder(list, layout, p.path, p.name));
      return r?.ok ? { ok: true, path: r.path } : { ok: false, error: t('bookmarksBar.edit.gone') };
    }
    if (p.type === 'new-folder') {
      const r = apply((list, layout) => BB.newFolder(list, layout, { parent: p.parent, name: p.name || t('bookmarksBar.newFolderName'), index: Number.isInteger(p.index) ? p.index : undefined }));
      return r?.ok ? { ok: true, path: r.path } : { ok: false };
    }
    return { ok: false };
  }
  const moveItem = ({ key, to, index } = {}) => Boolean(apply((list, layout) => BB.move(list, layout, { key, to: BB.cleanPath(to), index: Number.isInteger(index) ? index : undefined }))?.ok);
  // A link or a tab dropped on the bar (or on a folder chip).
  function drop({ url, title, to, index } = {}) {
    const href = webUrl(url);
    if (!href || !/^https?:/i.test(String(url).trim())) return false;
    return Boolean(apply((list, layout) => BB.addLink(list, layout, { url: href, title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 500) || host(href), folder: BB.cleanPath(to), index: Number.isInteger(index) ? index : undefined }))?.ok);
  }
  // Ctrl+Shift+B, the menus' Show bookmarks bar.
  function toggle() {
    const next = BB.toggled(deps.mode());
    deps.setMode(next);
    return next;
  }

  function register() {
    const { ipcMain } = deps;
    // (main.js already answers these only from a window's own UI: UI_ONLY_IPC. isUiSender is an extra check a test can stub.)
    const isUi = deps.isUiSender || (() => true);
    const gate = (fn, fallback) => (e, ...a) => (isUi(e) ? fn(e, ...a) : fallback);
    ipcMain.handle('bookmarks-bar:get', gate(() => state(), null));
    ipcMain.handle('bookmarks-bar:folder-menu', gate((e, o) => folderMenu(e, o), false));
    ipcMain.handle('bookmarks-bar:overflow-menu', gate((e, o) => overflowMenu(e, o), false));
    ipcMain.handle('bookmarks-bar:context-menu', gate((e, o) => contextMenu(e, o), false));
    ipcMain.handle('bookmarks-bar:save', gate((_e, p) => save(p), { ok: false }));
    ipcMain.handle('bookmarks-bar:move', gate((_e, o) => moveItem(o), false));
    ipcMain.handle('bookmarks-bar:drop', gate((_e, o) => drop(o), false));
    ipcMain.on('bookmarks-bar:open', gate((e, url, how) => { const href = webUrl(url); if (href && /^https?:/i.test(String(url))) deps.open(href, ['here', 'tab', 'background', 'window'].includes(how) ? how : 'here', e); }));
    ipcMain.on('bookmarks-bar:toggle', gate(() => toggle()));
    ipcMain.on('bookmarks-bar:rect', gate((e, r) => {
      const ok = r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
      rects.set(e.sender, ok ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
    }));
  }

  return { folderTemplate, overflowTemplate, contextTemplate, register, rectFor: (wc) => rects.get(wc) || null, state, push, pushSoon, pushIfChanged, toggle, save, move: moveItem, drop, removeFolder: (path) => apply((l, lay) => BB.removeFolder(l, lay, path)) };
}

module.exports = { createBookmarkBarMain, webUrl };
