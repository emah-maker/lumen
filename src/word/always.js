// [word] "Always allow changes to this document" / "Always allow reading this document": the saved Word documents (by full path, as src/word
// keys them) the AI changes (kind 'edit', which covers reading too) or reads (kind 'read') without a card, in every chat, even after it read
// content from elsewhere. Saving still asks every time. Added only from the cards (src/word/index.js); removed in Settings → AI → Privacy.
// The settings:* channels answer the Settings page only (main.js PRIVILEGED_IPC). settings.json aiWordAlways: [{ key, name, added, kind }]
// (an entry without a kind is an edit one: the first version kept only those).
'use strict';

const MAX = 200;

function clean(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const e of value) {
    if (!e || typeof e.key !== 'string' || !e.key.trim() || e.key.length > 2048 || seen.has(e.key)) continue;
    seen.add(e.key);
    out.push({ key: e.key, name: String(e.name || '').slice(0, 260), added: Number.isFinite(e.added) ? e.added : 0, kind: e.kind === 'read' ? 'read' : 'edit' });
    if (out.length >= MAX) break;
  }
  return out;
}

function createWordAlways({ readSettings, writeSettings, now = () => Date.now() }) {
  const list = () => clean(readSettings().aiWordAlways);
  const save = (next) => { writeSettings({ ...readSettings(), aiWordAlways: clean(next) }); return list(); };
  const api = {
    list,
    // (reading-only never narrows a document already allowed to be changed)
    add: (key, name, kind = 'edit') => {
      const had = list().find((e) => e.key === String(key));
      const next = kind === 'read' && had?.kind !== 'edit' ? 'read' : 'edit';
      return save([...list().filter((e) => e.key !== String(key)), { key: String(key), name: String(name || ''), added: now(), kind: next }].slice(-MAX));
    },
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
