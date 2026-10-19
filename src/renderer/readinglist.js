// The Reading list page: pages saved with Save for later (features/reading-list.js, through features/managers.js and
// managers-preload.js). Entries are [{ url, title, host, savedAt, read, icon }], newest first. Opening one marks it read.
// The wording is locales/en.json (readingPage.*), through window.t (i18n.js).
const t = window.t || ((key) => key);
const api = window.lumenReadingList;
let entries = [];
let filter = 'unread'; // 'unread' | 'all'

const $ = (id) => document.getElementById(id);
const list = $('list');
const query = $('q');
const status = $('status');
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
const say = (text) => { status.textContent = text; };
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

async function load() {
  try { entries = (await api?.list()) || []; } catch { entries = []; }
  $('mark-all').disabled = !entries.some((e) => !e.read);
  render();
}

function icon(e) {
  if (e.icon) return el('img', { className: 'site-icon', src: e.icon, alt: '', width: 16, height: 16 });
  return el('span', { className: 'site-icon letter', textContent: (e.host || '?').charAt(0).toUpperCase(), 'aria-hidden': 'true' });
}

function row(e) {
  const a = el('a', { href: e.url, title: e.url },
    icon(e),
    el('span', { className: 'title', textContent: e.title || e.host }),
    el('span', { className: 'host', textContent: `${e.host} · ${t('readingPage.savedOn', { date: day(e.savedAt) })}` }));
  // Opens in a new tab and marks the page read, so the list stays where it is.
  a.onclick = (ev) => { ev.preventDefault(); api.open(e.url); };
  a.onauxclick = (ev) => { if (ev.button === 1) { ev.preventDefault(); api.open(e.url); } };
  const name = e.title || e.host;
  const toggle = el('button', { type: 'button', textContent: e.read ? t('readingPage.markUnread') : t('readingPage.markRead') });
  toggle.setAttribute('aria-label', t(e.read ? 'readingPage.markUnreadNamed' : 'readingPage.markReadNamed', { name }));
  toggle.onclick = async () => { await api.mark(e.url, !e.read); await load(); };
  const del = el('button', { type: 'button', textContent: t('readingPage.remove') });
  del.setAttribute('aria-label', t('readingPage.removeNamed', { name }));
  del.onclick = async () => {
    if (!(await api.remove(e.url))) return;
    const note = t('readingPage.removed', { name });
    if (!window.managersToast) say(note);
    window.managersToast?.({
      text: note, undoLabel: t('readingPage.undo'),
      onUndo: async () => { if (await api.restore({ url: e.url, title: e.title, savedAt: e.savedAt, readAt: e.read ? e.savedAt : 0 })) { say(t('readingPage.restored', { name })); await load(); } },
    });
    await load();
    query.focus();
  };
  const r = el('div', { className: e.read ? 'row read' : 'row unread' }, a, el('div', { className: 'actions' }, toggle, del));
  r.dataset.url = e.url;
  return r;
}

function render() {
  const q = query.value.trim().toLowerCase();
  const shown = entries.filter((e) => (filter === 'all' || !e.read) && (!q || e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)));
  $('show-unread').setAttribute('aria-pressed', String(filter === 'unread'));
  $('show-all').setAttribute('aria-pressed', String(filter === 'all'));
  list.replaceChildren();
  if (!shown.length) {
    const none = q ? t('readingPage.noMatch') : !entries.length ? t('readingPage.none') : t('readingPage.caughtUp');
    list.append(el('p', { className: 'empty', textContent: none })); // (i18n.js writes Ctrl+Shift+Y as ⌘⇧Y on a Mac)
    return;
  }
  list.append(el('section', {}, ...shown.map(row)));
}

$('show-unread').onclick = () => { filter = 'unread'; render(); };
$('show-all').onclick = () => { filter = 'all'; render(); };
$('mark-all').onclick = async () => {
  const n = await api.markAllRead();
  if (n) say(t(n === 1 ? 'readingPage.markedAll.one' : 'readingPage.markedAll.other', { count: n }));
  await load();
};
query.addEventListener('input', render);
api?.onChange(() => load());
query.focus();
load();
