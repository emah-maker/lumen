// Renders the browsing history, fetched from the browser (history-preload.js): [{ url, title, last }].
// The wording is locales/en.json (historyPage.*), through window.t (i18n.js).
const t = window.t || ((key) => key);
let entries = [];

const list = document.getElementById('list');
const query = document.getElementById('q');
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const dayLabel = (d) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return t('historyPage.today');
  if (diff === 1) return t('historyPage.yesterday');
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};

async function remove(entry, row) {
  const next = row.nextElementSibling || row.previousElementSibling;
  if (!(await window.lumenHistory?.remove(entry.url))) return;
  entries = entries.filter((e) => e !== entry);
  const section = row.parentElement;
  row.remove();
  if (!section.querySelector('.row')) section.remove();
  if (!entries.length) render();
  // Keyboard users keep their place: focus moves to the neighbouring row's remove button.
  (next?.isConnected ? next.querySelector('.remove') : null)?.focus();
}

function render() {
  const q = query.value.trim().toLowerCase();
  const shown = entries.filter((e) => !q || (e.title || '').toLowerCase().includes(q) || e.url.toLowerCase().includes(q));
  list.replaceChildren();
  if (!shown.length) {
    list.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: q ? t('historyPage.noMatch') : t('historyPage.none') }));
    return;
  }
  let section = null;
  let current = '';
  for (const e of shown) {
    const label = dayLabel(e.last);
    if (label !== current) {
      current = label;
      section = document.createElement('section');
      section.append(Object.assign(document.createElement('h2'), { textContent: label }));
      list.append(section);
    }
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    const a = document.createElement('a');
    a.href = e.url;
    const time = Object.assign(document.createElement('span'), { className: 'time', textContent: new Date(e.last).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) });
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: e.title || host(e.url) });
    const where = Object.assign(document.createElement('span'), { className: 'host', textContent: host(e.url) });
    a.append(time, title, where);
    const del = Object.assign(document.createElement('button'), { className: 'remove', type: 'button', title: t('historyPage.remove') });
    del.setAttribute('aria-label', t('historyPage.removeNamed', { name: e.title || host(e.url) }));
    del.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8"/></svg>';
    del.onclick = () => remove(e, row);
    row.append(a, del);
    section.append(row);
  }
}

document.getElementById('clear').addEventListener('click', () => window.lumenHistory?.manage());
query.addEventListener('input', render);
query.focus();
(async () => {
  try {
    entries = ((await window.lumenHistory?.list()) || []).filter((e) => /^https?:/.test(e.url));
  } catch {
    entries = [];
  }
  render();
})();
