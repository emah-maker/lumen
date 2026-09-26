// Renders the browsing history passed in the URL hash as JSON: [{ url, title, last }].
let entries = [];
try {
  entries = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '[]').filter((e) => /^https?:/.test(e.url));
} catch {
  entries = [];
}

const list = document.getElementById('list');
const query = document.getElementById('q');
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const dayLabel = (d) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};

function render() {
  const q = query.value.trim().toLowerCase();
  const shown = entries.filter((e) => !q || (e.title || '').toLowerCase().includes(q) || e.url.toLowerCase().includes(q));
  list.replaceChildren();
  if (!shown.length) {
    list.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: q ? 'No matches.' : 'No history yet.' }));
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
    const a = document.createElement('a');
    a.href = e.url;
    const time = Object.assign(document.createElement('span'), { className: 'time', textContent: new Date(e.last).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) });
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: e.title || host(e.url) });
    const where = Object.assign(document.createElement('span'), { className: 'host', textContent: host(e.url) });
    a.append(time, title, where);
    section.append(a);
  }
}

query.addEventListener('input', render);
render();
query.focus();
