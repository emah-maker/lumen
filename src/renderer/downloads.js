// The Downloads page: every download Lumen remembers (features/downloads.js keeps the latest 1000; the page
// shows 100 at a time), with open, show in folder, pause, resume, cancel, retry and remove (with Undo).
const api = window.lumenDownloads;
let entries = [];
const PAGE = 100; // rows shown before "Show more"
let shownLimit = PAGE;

const $ = (id) => document.getElementById(id);
const list = $('list');
const query = $('q');
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};
const size = (n) => {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
};

// When a finished download ended: a time today, a date before (as the toolbar's panel shows it).
const when = (time) => {
  if (!time) return '';
  const d = new Date(time);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

// The wording is locales/en.json (dlpage.*), through window.t (i18n.js).
const t = window.t || ((key) => key);

function statusOf(d) {
  if (d.state === 'completed') return d.exists ? size(d.total || d.received) : t('dlpage.deleted');
  if (d.state === 'cancelled') return t('dlpage.canceled');
  if (d.state === 'interrupted') return t('dlpage.failed');
  if (d.awaitingOk) return t('dlpage.awaitingOk');
  const progress = d.total ? t('dlpage.of', { got: size(d.received), all: size(d.total) }) : size(d.received);
  return d.paused ? (progress ? t('dlpage.pausedWith', { progress }) : t('dlpage.paused')) : progress || t('dlpage.starting');
}

function button(d, action, label = t(`dlpage.action.${action}`)) {
  const b = el('button', { type: 'button', textContent: label });
  b.dataset.action = action;
  b.setAttribute('aria-label', t('dlpage.action.label', { action: label, name: d.name }));
  b.onclick = async () => {
    const removed = action === 'remove' && (await api.act(d.id, action));
    if (action !== 'remove') await api.act(d.id, action);
    if (removed) {
      const name = d.name;
      window.managersToast?.({
        text: t('dlpage.removed', { name }), undoLabel: t('dlpage.undo'),
        onUndo: async () => { if (await api.act(d.id, 'restore')) await load(); },
      });
    }
    await load();
  };
  return b;
}

function row(d) {
  const actions = [];
  if (d.state === 'completed') {
    if (d.exists) actions.push(button(d, 'open'), button(d, 'show'));
    actions.push(button(d, 'remove'));
  } else if (d.state === 'progressing') {
    if (!d.awaitingOk) actions.push(d.paused ? button(d, 'resume') : button(d, 'pause'));
    actions.push(button(d, 'cancel'));
  } else {
    actions.push(button(d, 'retry', d.canResume ? t('dlpage.action.resume') : t('dlpage.action.retry')), button(d, 'remove'));
  }
  const failed = d.state === 'interrupted' || (d.state === 'completed' && !d.exists);
  const main = el('div', { className: 'main' },
    el('span', { className: 'title', textContent: d.name }),
    el('span', { className: `detail${failed ? ' state-failed' : ''}`, textContent: [statusOf(d), host(d.url), d.state === 'progressing' ? '' : when(d.endedAt)].filter(Boolean).join(' · ') }));
  const r = el('div', { className: 'row' }, main, el('div', { className: `actions${d.state === 'progressing' ? ' always' : ''}` }, ...actions));
  r.dataset.id = String(d.id);
  r.dataset.state = d.state;
  const wrap = el('div', {}, r);
  if (d.state === 'progressing' && d.total) {
    const fill = el('div');
    fill.style.width = `${Math.min(100, Math.round((d.received / d.total) * 100))}%`;
    wrap.append(el('div', { className: 'bar' }, fill));
  }
  return wrap;
}

function render() {
  const q = query.value.trim().toLowerCase();
  const shown = entries.filter((d) => !q || d.name.toLowerCase().includes(q) || String(d.url || '').toLowerCase().includes(q));
  // Keep focus on the same button across re-renders (progress updates re-render often).
  const active = document.activeElement;
  const keep = active?.dataset?.action ? { id: active.closest('.row')?.dataset.id, action: active.dataset.action } : null;
  list.replaceChildren();
  if (!shown.length) {
    list.append(el('p', { className: 'empty', textContent: q ? t('dlpage.noMatch') : t('dlpage.none') }));
    return;
  }
  list.append(el('section', {}, ...shown.slice(0, shownLimit).map(row)));
  if (shown.length > shownLimit) {
    list.append(el('button', { type: 'button', className: 'more', textContent: t('dlpage.showMore', { count: shown.length - shownLimit }), onclick: () => { shownLimit += PAGE; render(); } }));
  }
  if (keep) list.querySelector(`.row[data-id="${keep.id}"] [data-action="${keep.action}"]`)?.focus();
}

let pending = null;
async function load() {
  try { entries = (await api?.list()) || []; } catch { entries = []; }
  render();
}
// Progress arrives many times a second: refresh at most every 250 ms.
api?.onChange(() => { if (!pending) pending = setTimeout(() => { pending = null; load(); }, 250); });
$('folder').onclick = () => api.openFolder();
query.addEventListener('input', () => { shownLimit = PAGE; render(); });
query.focus();
load();
