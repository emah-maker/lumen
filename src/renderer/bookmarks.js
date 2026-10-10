// The Bookmarks page: list, search, add, edit, remove, import and export (features/managers.js,
// through managers-preload.js). Bookmarks are [{ url, title, folder }]; folder '' is the top level.
// The wording is locales/en.json (bookmarksPage.*), through window.t (i18n.js).
const t = window.t || ((key) => key);
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
  const title = el('input', { name: 'title', value: entry?.title || '', placeholder: t('bookmarksPage.field.title'), autocomplete: 'off' });
  const url = el('input', { name: 'url', value: entry?.url || '', placeholder: 'https://example.com', autocomplete: 'off', required: true });
  const folder = el('input', { name: 'folder', value: entry?.folder || '', placeholder: t('bookmarksPage.folderNone'), autocomplete: 'off' });
  folder.setAttribute('list', 'folders');
  const error = el('span', { className: 'error', role: 'alert' });
  const cancel = el('button', { type: 'button', textContent: t('bookmarksPage.cancel'), onclick: close });
  const f = el('form', { className: 'edit' },
    el('label', { className: 'wide' }, t('bookmarksPage.field.title'), title),
    el('label', {}, t('bookmarksPage.field.address'), url),
    el('label', {}, t('bookmarksPage.field.folder'), folder),
    el('div', { className: 'buttons' }, error, cancel, el('button', { type: 'submit', className: 'primary', textContent: entry ? t('bookmarksPage.save') : t('bookmarksPage.addButton') })));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const result = entry
      ? await api.update({ url: entry.url, newUrl: url.value, title: title.value, folder: folder.value })
      : await api.add({ url: url.value, title: title.value, folder: folder.value });
    if (!result?.ok) { error.textContent = result?.error || t('bookmarksPage.saveError'); return; }
    say(entry ? t('bookmarksPage.saved') : t('bookmarksPage.added'));
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
  const edit = el('button', { type: 'button', className: 'edit-button', textContent: t('bookmarksPage.edit'), onclick: () => { editing = b.url; render(); } });
  edit.setAttribute('aria-label', t('bookmarksPage.editNamed', { name: b.title || host(b.url) }));
  const del = el('button', { type: 'button', textContent: t('bookmarksPage.remove') });
  del.setAttribute('aria-label', t('bookmarksPage.removeNamed', { name: b.title || host(b.url) }));
  del.onclick = async () => {
    if (!(await api.remove(b.url))) return;
    say(t('bookmarksPage.removed', { name: b.title || host(b.url) }));
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
    list.append(el('p', { className: 'empty', textContent: q ? t('bookmarksPage.noMatch') : t('bookmarksPage.none') })); // (i18n.js writes Ctrl+D as ⌘D on a Mac)
    return;
  }
  const folders = [''].concat([...new Set(shown.map((b) => b.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  for (const folder of folders) {
    const items = shown.filter((b) => b.folder === folder);
    if (!items.length) continue;
    // (no "Bookmarks" heading under the page's own title when nothing is in a folder)
    list.append(el('section', {}, ...(folder || folders.length > 1 ? [el('h2', { textContent: folder || t('bookmarksPage.topLevel') })] : []), ...items.map(row)));
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
  if (r?.ok) say(t(r.count === 1 ? 'bookmarksPage.exported.one' : 'bookmarksPage.exported.other', { count: r.count }));
};
$('import').onclick = async () => {
  const r = await api.importFile();
  if (r?.error) say(r.error);
  else if (r?.ok) { say(t(r.added === 1 ? 'bookmarksPage.imported.one' : 'bookmarksPage.imported.other', { count: r.added })); await load(); }
};
query.addEventListener('input', render);
api?.onChange(() => { if (editing === null) load(); });
query.focus();
load();
