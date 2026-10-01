// The Downloads page: every download Lumen remembers this session (features/downloads.js keeps the
// latest 50), with open, show in folder, pause, resume, cancel, retry and remove.
const api = window.lumenDownloads;
let entries = [];

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

function statusOf(d) {
  if (d.state === 'completed') return d.exists ? size(d.total || d.received) : 'Deleted';
  if (d.state === 'cancelled') return 'Canceled';
  if (d.state === 'interrupted') return 'Failed';
  if (d.awaitingOk) return 'Waiting for your OK';
  const progress = d.total ? `${size(d.received)} of ${size(d.total)}` : size(d.received);
  return d.paused ? `Paused${progress ? ` · ${progress}` : ''}` : progress || 'Starting…';
}

function button(d, action, label) {
  const b = el('button', { type: 'button', textContent: label });
  b.dataset.action = action;
  b.setAttribute('aria-label', `${label} ${d.name}`);
  b.onclick = async () => { await api.act(d.id, action); await load(); };
  return b;
}

function row(d) {
  const actions = [];
  if (d.state === 'completed') {
    if (d.exists) actions.push(button(d, 'open', 'Open'), button(d, 'show', 'Show in folder'));
    actions.push(button(d, 'remove', 'Remove'));
  } else if (d.state === 'progressing') {
    if (!d.awaitingOk) actions.push(d.paused ? button(d, 'resume', 'Resume') : button(d, 'pause', 'Pause'));
    actions.push(button(d, 'cancel', 'Cancel'));
  } else {
    actions.push(button(d, 'retry', d.canResume ? 'Resume' : 'Retry'), button(d, 'remove', 'Remove'));
  }
  const failed = d.state === 'interrupted' || (d.state === 'completed' && !d.exists);
  const main = el('div', { className: 'main' },
    el('span', { className: 'title', textContent: d.name }),
    el('span', { className: `detail${failed ? ' state-failed' : ''}`, textContent: [statusOf(d), host(d.url)].filter(Boolean).join(' · ') }));
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
    list.append(el('p', { className: 'empty', textContent: q ? 'No matches.' : 'No downloads yet.' }));
    return;
  }
  list.append(el('section', {}, ...shown.map(row)));
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
query.addEventListener('input', render);
query.focus();
load();
