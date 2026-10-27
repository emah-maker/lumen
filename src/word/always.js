// [word] "Always allow changes to this document": the saved Word documents (by full path, as src/word keys them) whose edits the AI makes
// without a card, in every chat, even after it read content from elsewhere. Saving still asks every time. Added only from the edit card
// (src/word/index.js); removed in Settings → AI → Privacy. The settings:* channels answer the Settings page only (main.js PRIVILEGED_IPC).
// settings.json aiWordAlways: [{ key, name, added }].
'use strict';

const MAX = 200;

function clean(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const e of value) {
    if (!e || typeof e.key !== 'string' || !e.key.trim() || e.key.length > 2048 || seen.has(e.key)) continue;
    seen.add(e.key);
    out.push({ key: e.key, name: String(e.name || '').slice(0, 260), added: Number.isFinite(e.added) ? e.added : 0 });
    if (out.length >= MAX) break;
  }
  return out;
}

function createWordAlways({ readSettings, writeSettings, now = () => Date.now() }) {
  const list = () => clean(readSettings().aiWordAlways);
  const save = (next) => { writeSettings({ ...readSettings(), aiWordAlways: clean(next) }); return list(); };
  const api = {
    list,
    add: (key, name) => save([...list().filter((e) => e.key !== key), { key: String(key), name: String(name || ''), added: now() }].slice(-MAX)),
    remove: (key) => save(list().filter((e) => e.key !== String(key))),
    clear: () => save([]),
    register(ipcMain) {
      ipcMain.handle('settings:word-always', () => list());
      ipcMain.handle('settings:remove-word-always', (_e, key) => api.remove(String(key ?? '')));
      ipcMain.handle('settings:clear-word-always', () => api.clear());
    },
  };
  return api;
}

module.exports = { MAX, clean, createWordAlways };
