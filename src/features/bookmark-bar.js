'use strict';
// The bookmarks bar's model, plain functions (no Electron): main.js keeps the data, renderer/bookmarks-bar.js draws it.
//
// Bookmarks stay what they were, [{ url, title, folder }] in settings.json, so the Bookmarks page, sync, import and export keep
// working. A folder is now a path: "Work/Projects" is the folder Projects inside Work ('' is the bar itself). Two things the
// list can't say live beside it in `bookmarkLayout`:
//   folders: ['Work', 'Work/Projects']: folders made on the bar, kept while they are still empty;
//   order:   { '': ['f:Work', 'u:https://a.example/'], 'Work': [...] }: the order of a folder's chips, links ('u:' + url) and
//            folders ('f:' + name) mixed. A child that isn't listed (a bookmark added on the Bookmarks page) comes after the
//            listed ones, links first in the list's order, then folders.
// Every change returns a new { list, layout }; nothing is changed in place.

const BAR_HEIGHT = 32; // px: the bar's height (renderer/bookmarks-bar.css --bookmarks-bar-h; main.js insets the new-tab page by it)
const MODES = ['newtab', 'always', 'never'];
const SEP = '/';
const MAX_NAME = 120;

// A folder name the user typed: one level (a slash would make it two), no runs of spaces.
const cleanName = (name) => String(name ?? '').replace(/\//g, '∕').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
// A path from anywhere (a bookmark's folder, an IPC message): "a / b/" -> "a/b".
const cleanPath = (p) => String(p ?? '').split(SEP).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(SEP);
const parentOf = (p) => (p.includes(SEP) ? p.slice(0, p.lastIndexOf(SEP)) : '');
const nameOf = (p) => p.slice(p.lastIndexOf(SEP) + 1);
const join = (parent, name) => (parent ? `${parent}${SEP}${name}` : name);
const within = (p, root) => p === root || p.startsWith(root + SEP);
const linkKey = (url) => `u:${url}`;
const folderKey = (name) => `f:${name}`;

function cleanLayout(layout) {
  const l = layout && typeof layout === 'object' ? layout : {};
  const folders = [...new Set((Array.isArray(l.folders) ? l.folders : []).filter((p) => typeof p === 'string').map(cleanPath).filter(Boolean))];
  const order = {};
  if (l.order && typeof l.order === 'object') {
    for (const [k, v] of Object.entries(l.order)) if (Array.isArray(v)) order[cleanPath(k)] = [...new Set(v.filter((x) => typeof x === 'string' && /^[uf]:/.test(x)))];
  }
  return { folders, order };
}
const cleanList = (list) => (Array.isArray(list) ? list.filter((b) => b && typeof b.url === 'string' && b.url) : []);
const folderOf = (b) => cleanPath(b.folder);

// Every folder there is: made on the bar, or named by a bookmark (and each folder above it).
function allFolders(list, layout) {
  const out = new Set();
  const add = (p) => { for (let q = cleanPath(p); q; q = parentOf(q)) out.add(q); };
  for (const p of cleanLayout(layout).folders) add(p);
  for (const b of cleanList(list)) add(b.folder);
  return out;
}

// A folder's children in bar order: [{ type: 'link', key, url, title } | { type: 'folder', key, path, name }].
function childrenOf(list, layout, path = '') {
  const at = cleanPath(path);
  const l = cleanLayout(layout);
  const links = cleanList(list).filter((b) => folderOf(b) === at).map((b) => ({ type: 'link', key: linkKey(b.url), url: b.url, title: b.title || '' }));
  const folders = [...allFolders(list, l)].filter((p) => parentOf(p) === at).map((p) => ({ type: 'folder', key: folderKey(nameOf(p)), path: p, name: nameOf(p) }));
  const all = [...links, ...folders];
  const byKey = new Map(all.map((c) => [c.key, c]));
  const listed = (l.order[at] || []).filter((k) => byKey.has(k));
  const seen = new Set(listed);
  return [...listed.map((k) => byKey.get(k)), ...all.filter((c) => !seen.has(c.key))];
}

// The whole bar for the UI: folders carry their children. `icon(url)` gives a link its favicon (a data: URL) or ''.
function tree(list, layout, { icon = () => '' } = {}, path = '', depth = 0) {
  return childrenOf(list, layout, path).map((c) => (c.type === 'link'
    ? { type: 'link', url: c.url, title: c.title, icon: icon(c.url) || '' }
    : { type: 'folder', path: c.path, name: c.name, children: depth > 24 ? [] : tree(list, layout, { icon }, c.path, depth + 1) }));
}

// The folder's order written out in full, with `key` placed at `index` (counted among the other children).
function placed(list, layout, path, key, index) {
  const keys = childrenOf(list, layout, path).map((c) => c.key).filter((k) => k !== key);
  const i = Number.isInteger(index) ? Math.max(0, Math.min(keys.length, index)) : keys.length;
  keys.splice(i, 0, key);
  return { ...layout, order: { ...layout.order, [path]: keys } };
}
const dropKey = (layout, path, key) => (layout.order[path] ? { ...layout, order: { ...layout.order, [path]: layout.order[path].filter((k) => k !== key) } } : layout);

// A name not taken in `parent` (folders only): "New folder", "New folder (2)" ...
function freeName(list, layout, parent, name) {
  const taken = new Set([...allFolders(list, layout)].filter((p) => parentOf(p) === parent).map(nameOf));
  let out = name;
  for (let n = 2; taken.has(out); n++) out = `${name} (${n})`;
  return out;
}

// Adds a bookmark, or moves it when the address is bookmarked already (an address is bookmarked once: the star, Ctrl+D and the
// Bookmarks page all go by it).
function addLink(list0, layout0, { url, title = '', folder = '', index } = {}) {
  const list = cleanList(list0).slice();
  let layout = cleanLayout(layout0);
  if (typeof url !== 'string' || !url) return { list, layout, ok: false };
  const at = cleanPath(folder);
  const i = list.findIndex((b) => b.url === url);
  if (i >= 0) {
    const was = folderOf(list[i]);
    layout = dropKey(layout, was, linkKey(url));
    list[i] = { ...list[i], ...(at ? { folder: at } : {}), ...(title && !list[i].title ? { title } : {}) };
    if (!at) delete list[i].folder;
  } else {
    list.push({ url, title: String(title || '').slice(0, 500), ...(at ? { folder: at } : {}) });
  }
  layout = placed(list, layout, at, linkKey(url), index);
  return { list, layout, ok: true, added: i < 0 };
}

function updateLink(list0, layout0, { url, newUrl, title, folder } = {}) {
  const list = cleanList(list0).slice();
  let layout = cleanLayout(layout0);
  const i = list.findIndex((b) => b.url === url);
  if (i < 0) return { list, layout, ok: false, error: 'missing' };
  const target = typeof newUrl === 'string' && newUrl ? newUrl : url;
  if (target !== url && list.some((b) => b.url === target)) return { list, layout, ok: false, error: 'duplicate' };
  const was = folderOf(list[i]);
  const at = folder === undefined ? was : cleanPath(folder);
  const next = { ...list[i], url: target, title: title === undefined ? list[i].title : String(title).slice(0, 500) };
  if (at) next.folder = at; else delete next.folder;
  list[i] = next;
  if (at === was) {
    const keys = (layout.order[was] || []).map((k) => (k === linkKey(url) ? linkKey(target) : k));
    layout = { ...layout, order: { ...layout.order, [was]: keys } };
  } else {
    layout = dropKey(layout, was, linkKey(url));
    layout = placed(list, layout, at, linkKey(target));
  }
  return { list, layout, ok: true };
}

function removeLink(list0, layout0, url) {
  const list = cleanList(list0).filter((b) => b.url !== url);
  let layout = cleanLayout(layout0);
  const gone = cleanList(list0).find((b) => b.url === url);
  if (gone) layout = dropKey(layout, folderOf(gone), linkKey(url));
  return { list, layout, ok: Boolean(gone) };
}

function newFolder(list0, layout0, { parent = '', name, index } = {}) {
  const list = cleanList(list0);
  let layout = cleanLayout(layout0);
  const at = cleanPath(parent);
  const base = cleanName(name) || 'New folder';
  const n = freeName(list, layout, at, base);
  const path = join(at, n);
  layout = { ...layout, folders: [...layout.folders, path] };
  layout = placed(list, layout, at, folderKey(n), index);
  return { list, layout, ok: true, path };
}

// Moves the folder `path` (and all it holds) to `to/newName`. A name taken there gets " (2)".
function relocateFolder(list0, layout0, path, to, name, index) {
  let list = cleanList(list0);
  let layout = cleanLayout(layout0);
  const from = cleanPath(path);
  const dest = cleanPath(to);
  if (!from || !allFolders(list, layout).has(from)) return { list, layout, ok: false, error: 'missing' };
  if (within(dest, from)) return { list, layout, ok: false, error: 'into-itself' };
  const oldIndex = childrenOf(list, layout, parentOf(from)).findIndex((c) => c.key === folderKey(nameOf(from)));
  const wanted = cleanName(name) || nameOf(from);
  const sameSpot = dest === parentOf(from) && wanted === nameOf(from);
  // (the folder itself doesn't count against its own name when it stays in the same parent)
  const others = { ...layout, folders: layout.folders.filter((p) => !within(p, from)) };
  const listOthers = list.filter((b) => !within(folderOf(b), from));
  const n = sameSpot ? wanted : freeName(listOthers, others, dest, wanted);
  const target = join(dest, n);
  const re = (p) => (within(p, from) ? target + p.slice(from.length) : p);
  list = list.map((b) => { const f = folderOf(b); return within(f, from) ? { ...b, folder: re(f) } : b; });
  const order = {};
  for (const [k, v] of Object.entries(layout.order)) order[re(k)] = v;
  const parentWas = parentOf(from);
  order[parentWas] = (order[parentWas] || []).filter((k) => k !== folderKey(nameOf(from)));
  layout = { folders: [...new Set(layout.folders.map(re).concat(target))], order };
  layout = placed(list, layout, dest, folderKey(n), dest === parentWas && index === undefined ? oldIndex : index); // (a rename keeps its place)
  return { list, layout, ok: true, path: target };
}

const renameFolder = (list, layout, path, name) => {
  const p = cleanPath(path);
  return relocateFolder(list, layout, p, parentOf(p), name);
};

// A folder and everything in it. Returns what went too, so the bar can offer Undo.
function removeFolder(list0, layout0, path) {
  const from = cleanPath(path);
  const list = cleanList(list0);
  let layout = cleanLayout(layout0);
  if (!from) return { list, layout, ok: false };
  const removed = list.filter((b) => within(folderOf(b), from));
  const order = {};
  for (const [k, v] of Object.entries(layout.order)) if (!within(k, from)) order[k] = v;
  const parent = parentOf(from);
  if (order[parent]) order[parent] = order[parent].filter((k) => k !== folderKey(nameOf(from)));
  layout = { folders: layout.folders.filter((p) => !within(p, from)), order };
  return { list: list.filter((b) => !within(folderOf(b), from)), layout, ok: true, removed };
}

// One drag on the bar: `key` ('u:' + url or 'f:' + folder path) goes to folder `to` at `index` (among the others there).
function move(list, layout, { key, to = '', index } = {}) {
  if (typeof key !== 'string') return { list: cleanList(list), layout: cleanLayout(layout), ok: false };
  if (key.startsWith('u:')) {
    const url = key.slice(2);
    if (!cleanList(list).some((b) => b.url === url)) return { list: cleanList(list), layout: cleanLayout(layout), ok: false };
    return addLink(list, layout, { url, folder: to, index });
  }
  if (key.startsWith('f:')) {
    const path = cleanPath(key.slice(2));
    return relocateFolder(list, layout, path, to, nameOf(path), Number.isInteger(index) ? index : undefined);
  }
  return { list: cleanList(list), layout: cleanLayout(layout), ok: false };
}

// The links in a folder and all its folders, in bar order (Open all).
function linksIn(list, layout, path) {
  const out = [];
  const walk = (p, depth) => {
    for (const c of childrenOf(list, layout, p)) {
      if (c.type === 'link') out.push(c.url);
      else if (depth < 24) walk(c.path, depth + 1);
    }
  };
  walk(cleanPath(path), 0);
  return out;
}

// Whether the bar shows for a tab: 'always'; on the new-tab page only ('newtab', the default, as in Chrome); 'never'.
const cleanMode = (m) => (MODES.includes(m) ? m : 'newtab');
const shownFor = (mode, { newTab } = {}) => { const m = cleanMode(mode); return m === 'always' || (m === 'newtab' && Boolean(newTab)); };
// Ctrl+Shift+B: always <-> only on the new-tab page (Chrome's toggle). From 'never' it shows it always.
const toggled = (mode) => (cleanMode(mode) === 'always' ? 'newtab' : 'always');
// How far the new-tab page's view sits below the page area: in 'newtab' mode the bar is drawn over the top of the page area
// (only the new-tab page leaves room for it), so no other page is ever resized by it. In 'always' mode the bar is part of the
// toolbar and the page area itself starts below it.
const newTabInset = (mode) => (cleanMode(mode) === 'newtab' ? BAR_HEIGHT : 0);

module.exports = {
  BAR_HEIGHT, MODES, SEP, cleanName, cleanPath, cleanLayout, parentOf, nameOf, allFolders, childrenOf, tree,
  addLink, updateLink, removeLink, newFolder, renameFolder, removeFolder, relocateFolder, move, linksIn,
  cleanMode, shownFor, toggled, newTabInset, linkKey, folderKey,
};
