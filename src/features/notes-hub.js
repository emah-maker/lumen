// Quick notes: what the panel and the "Add to notes" buttons ask main to do (one IPC channel, notes:act), kept out of main.js. The notepad
// itself is ai/notes.js. Loaded the first time a note is used, never at startup.
//
//   act(op, arg)  list { query } | get { id } | new { text } | save { id, text, base } | delete { id } | undo { token } | select { id }
//                 | add { text } | add-selection { text, title, url } | add-image { id, alt } | add-svg { svg, title } | image { name }
//   Every answer is { ok, ... }. After a change the other views are told (push), so the panel redraws.
//
// deps: { store, push(), imageBytes(id) -> { buffer, mime } | null }
const notes = require('../ai/notes');

const MAX_SVG = 200 * 1024;
const MAX_SELECTION = 20000;

function create(deps) {
  const { store } = deps;
  const undos = new Map(); // token -> removed note
  let seq = 0;
  const changed = () => { try { deps.push?.(); } catch { /* a closing window */ } };
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const added = (r) => ({ ok: true, id: r.note.id, title: r.note.title, created: r.created });

  // A page's text as a quotation with where it came from. Only an http(s) address is linked.
  function quote(text, title, url) {
    const body = notes.clean(text, MAX_SELECTION).trim().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
    const label = str(title, 120).replace(/[[\]\n]/g, ' ').trim();
    const link = /^https?:\/\/\S+$/i.test(str(url, 2000)) ? str(url, 2000).replace(/[()\s]/g, (c) => ({ '(': '%28', ')': '%29' }[c] || '%20')) : '';
    const from = link ? `[${label || link}](${link})` : label;
    return from ? `${body}\n>\n> from ${from}` : body;
  }

  function act(op, arg = {}) {
    sweepOnce();
    const a = arg && typeof arg === 'object' ? arg : {};
    try {
      switch (op) {
        case 'list': return { ok: true, notes: store.list(str(a.query, 200)), current: store.current()?.id || null };
        case 'get': { const n = store.get(str(a.id, 16)); return n ? { ok: true, note: n } : { ok: false, reason: 'gone' }; }
        case 'new': { const n = store.create(str(a.text, notes.MAX_TEXT)); changed(); return { ok: true, note: n }; }
        case 'save': {
          const r = store.update(str(a.id, 16), str(a.text, notes.MAX_TEXT), typeof a.base === 'string' ? a.base : undefined);
          if (!r) return { ok: false, reason: 'gone' };
          changed();
          return { ok: true, note: r.note, merged: r.merged };
        }
        case 'delete': {
          const gone = store.remove(str(a.id, 16));
          if (!gone) return { ok: false, reason: 'gone' };
          const token = `n${++seq}`;
          undos.set(token, gone);
          while (undos.size > 20) undos.delete(undos.keys().next().value);
          changed();
          return { ok: true, token };
        }
        case 'undo': {
          const gone = undos.get(str(a.token, 12));
          if (!gone || !store.restore(gone)) return { ok: false, reason: 'gone' };
          undos.delete(a.token);
          changed();
          return { ok: true, id: gone.id };
        }
        case 'select': return { ok: store.select(a.id === null ? null : str(a.id, 16)) };
        case 'add': { const r = store.append(null, str(a.text, notes.MAX_APPEND)); changed(); return added(r); }
        case 'add-selection': {
          if (!str(a.text, MAX_SELECTION).trim()) return { ok: false, reason: 'empty' };
          const r = store.append(null, quote(a.text, a.title, a.url));
          changed();
          return added(r);
        }
        case 'add-svg': {
          const svg = str(a.svg, MAX_SVG + 1).trim();
          if (!/^<svg[\s>]/i.test(svg) || svg.length > MAX_SVG || !/<\/svg\s*>$/i.test(svg)) return { ok: false, reason: 'bad' };
          const r = store.append(null, `\`\`\`svg\n${svg}\n\`\`\``);
          changed();
          return added(r);
        }
        case 'add-image': {
          const img = deps.imageBytes?.(str(a.id, 80));
          if (!img) return { ok: false, reason: 'gone' };
          const r = store.append(null, store.addImage(img.buffer, str(a.alt, 200)).markdown);
          changed();
          return added(r);
        }
        case 'image': {
          const img = store.image(str(a.name, 40));
          return img ? { ok: true, url: `data:${img.type};base64,${img.bytes.toString('base64')}` } : { ok: false, reason: 'gone' };
        }
        default: return { ok: false, reason: 'unknown' };
      }
    } catch (err) { return { ok: false, reason: 'error', message: String(err?.message || err) }; }
  }
  let swept = false;
  function sweepOnce() { if (swept) return; swept = true; try { store.sweep(); } catch { /* leave the files */ } }

  // The page selection menu item (main.js showContextMenu): returns the answer so the caller can say "Added".
  return { act, quote };
}

module.exports = { create };
