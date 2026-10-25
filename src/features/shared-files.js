// "Allow always for this file": the files on this computer the user let the sidebar's AI see (a screenshot and the text of the
// file in the tab, and read_pdf for a PDF) without being asked again. The card is the only way in: agent.js screenAskFile,
// when the user's own message points at the file in front of them. Removed in Settings → AI and agents. Stored as settings.json
// aiSharedFiles: the files' own file:// addresses (no query, no fragment), newest last, at most MAX.
// "Turn off AI for local files" (features/ai-sites.js) still wins over everything here.
const MAX = 200;

// The address a file is remembered under, or '' for anything that is not a file:// address.
function keyOf(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'file:') return '';
    u.hash = '';
    u.search = '';
    return u.href.length <= 2000 ? u.href : '';
  } catch { return ''; }
}

const nameOf = (key) => {
  try { return decodeURIComponent(new URL(key).pathname.split('/').filter(Boolean).pop() || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) || key; } catch { return key; }
};

// settings.json aiSharedFiles -> valid addresses, no duplicates, at most MAX. A damaged file reads as an empty list.
function clean(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const key = typeof item === 'string' ? keyOf(item) : '';
    if (key) seen.add(key);
  }
  return [...seen].slice(-MAX);
}

function createSharedFiles({ readSettings, writeSettings }) {
  const keys = () => clean(readSettings().aiSharedFiles);
  const has = (url) => { const key = keyOf(url); return Boolean(key) && keys().includes(key); };
  const save = (next) => { writeSettings({ ...readSettings(), aiSharedFiles: next }); return next; };
  const add = (url) => {
    const key = keyOf(url);
    if (!key) return keys();
    return save([...keys().filter((k) => k !== key), key].slice(-MAX));
  };
  const remove = (url) => save(keys().filter((k) => k !== keyOf(url)));
  const clear = () => save([]);
  const list = () => keys().map((url) => ({ url, name: nameOf(url) }));
  // settings:* channels answer the browser UI and the Settings tab only (main.js IPC gate); page content and the AI's tools can't reach them.
  function register(ipcMain) {
    ipcMain.handle('settings:shared-files', () => list());
    ipcMain.handle('settings:remove-shared-file', (_e, url) => { remove(String(url ?? '')); return list(); });
    ipcMain.handle('settings:clear-shared-files', () => { clear(); return list(); });
  }
  return { has, add, remove, clear, list, register };
}

module.exports = { createSharedFiles, keyOf, nameOf, clean, MAX };
