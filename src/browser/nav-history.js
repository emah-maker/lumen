// The list under Back / Forward (right-click, as in Chrome and Edge): the pages behind or ahead of the current one in
// a tab's session history, nearest first, so a long way back is one pick. Pure: main.js turns the result into a menu.
const MAX_ITEMS = 15; // Chrome shows up to 15 entries before "Show full history"
const MAX_LABEL = 60;

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const clip = (text, n = MAX_LABEL) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// entries: webContents.navigationHistory.getAllEntries() ({ url, title }[]); active: its getActiveIndex().
// -> [{ index, label }]: `index` is what goToIndex() takes. An entry with no title is named by its address.
function items(entries, active, direction, { limit = MAX_ITEMS } = {}) {
  if (!Array.isArray(entries) || !Number.isInteger(active) || active < 0 || active >= entries.length) return [];
  const indices = [];
  if (direction === 'back') for (let i = active - 1; i >= 0; i--) indices.push(i);
  else if (direction === 'forward') for (let i = active + 1; i < entries.length; i++) indices.push(i);
  return indices.slice(0, limit).map((index) => {
    const entry = entries[index] || {};
    const title = String(entry.title || '').trim();
    const url = String(entry.url || '');
    return { index, label: clip(title || hostOf(url) || url || '—') };
  });
}

module.exports = { items, MAX_ITEMS };
