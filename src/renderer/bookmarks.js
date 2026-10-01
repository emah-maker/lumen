// The Bookmarks page: list, search, add, edit, remove, import and export (features/managers.js,
// through managers-preload.js). Bookmarks are [{ url, title, folder }]; folder '' is the top level.
const api = window.lumenBookmarks;
let entries = [];
let editing = null; // the url being edited, or '' while adding a new one

const $ = (id) => document.getElementById(id);
const list = $('list');
const query = $('q');
const status = $('status');
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
const say = (text) => { status.textContent = text; };

async function load() {
  try { entries = (await api?.list()) || []; } catch { entries = []; }
  $('folders').replaceChildren(...[...new Set(entries.map((b) => b.folder).filter(Boolean))].map((f) => el('option', { value: f })));
  render();
}

// The add/edit form. `entry` is the bookmark being edited, or null to add a new one.
function form(entry) {
  const title = el('input', { name: 'title', value: entry?.title || '', placeholder: 'Title', autocomplete: 'off' });
  const url = el('input', { name: 'url', value: entry?.url || '', placeholder: 'https://example.com', autocomplete: 'off', required: true });
  const folder = el('input', { name: 'folder', value: entry?.folder || '', placeholder: 'None', autocomplete: 'off' });
  folder.setAttribute('list', 'folders');
  const error = el('span', { className: 'error', role: 'alert' });
  const cancel = el('button', { type: 'button', textContent: 'Cancel', onclick: close });
  const f = el('form', { className: 'edit' },
    el('label', { className: 'wide' }, 'Title', title),
    el('label', {}, 'Address', url),
    el('label', {}, 'Folder', folder),
    el('div', { className: 'buttons' }, error, cancel, el('button', { type: 'submit', className: 'primary', textContent: entry ? 'Save' : 'Add' })));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const result = entry
      ? await api.update({ url: entry.url, newUrl: url.value, title: title.value, folder: folder.value })
      : await api.add({ url: url.value, title: title.value, folder: folder.value });
    if (!result?.ok) { error.textContent = result?.error || 'Could not save.'; return; }
    say(entry ? 'Bookmark saved.' : 'Bookmark added.');
    close();
    await load();
  };
  f.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  return { node: f, focus: () => (entry ? title : url).focus() };
}

function close() {
  const returnTo = editing;
  editing = null;
  $('form-slot').replaceChildren();
  render();
  if (returnTo) list.querySelector(`[data-url="${CSS.escape(returnTo)}"] .edit-button`)?.focus();
  else if (returnTo === '') $('add').focus();
}

function row(b) {
  if (editing === b.url) {
    const f = form(b);
    queueMicrotask(f.focus);
    return f.node;
  }
  const a = el('a', { href: b.url, title: b.url },
    el('span', { className: 'title', textContent: b.title || host(b.url) }),
    el('span', { className: 'host', textContent: host(b.url) }));
  // Opens in a new tab, so the Bookmarks page stays where it is.
  a.onclick = (e) => { e.preventDefault(); api.open(b.url); };
  a.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); api.open(b.url); } };
  const edit = el('button', { type: 'button', className: 'edit-button', textContent: 'Edit', onclick: () => { editing = b.url; render(); } });
  edit.setAttribute('aria-label', `Edit ${b.title || host(b.url)}`);
  const del = el('button', { type: 'button', textContent: 'Remove' });
  del.setAttribute('aria-label', `Remove ${b.title || host(b.url)}`);
  del.onclick = async () => {
    if (!(await api.remove(b.url))) return;
    say(`Removed “${b.title || host(b.url)}”.`);
    await load();
    query.focus();
  };
  const r = el('div', { className: 'row' }, a, el('div', { className: 'actions' }, edit, del));
  r.dataset.url = b.url;
  return r;
}

function render() {
  const q = query.value.trim().toLowerCase();
  const shown = entries.filter((b) => !q || b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || b.folder.toLowerCase().includes(q));
  list.replaceChildren();
  if (!shown.length) {
    list.append(el('p', { className: 'empty', textContent: q ? 'No matches.' : `No bookmarks yet. Press ${navigator.platform.startsWith('Mac') ? '⌘D' : 'Ctrl+D'} on a page to bookmark it.` }));
    return;
  }
  const folders = [''].concat([...new Set(shown.map((b) => b.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  for (const folder of folders) {
    const items = shown.filter((b) => b.folder === folder);
    if (!items.length) continue;
    list.append(el('section', {}, el('h2', { textContent: folder || 'Bookmarks' }), ...items.map(row)));
  }
}

$('add').onclick = () => {
  editing = '';
  const f = form(null);
  $('form-slot').replaceChildren(f.node);
  f.focus();
};
$('export').onclick = async () => {
  const r = await api.exportFile();
  if (r?.ok) say(`Exported ${r.count} bookmark${r.count === 1 ? '' : 's'}.`);
};
$('import').onclick = async () => {
  const r = await api.importFile();
  if (r?.error) say(r.error);
  else if (r?.ok) { say(`Imported ${r.added} new bookmark${r.added === 1 ? '' : 's'}.`); await load(); }
};
query.addEventListener('input', render);
api?.onChange(() => { if (editing === null) load(); });
query.focus();
load();
