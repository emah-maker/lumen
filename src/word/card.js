// [word] What the chat's one live activity card shows while the AI works in Word: the document's name, what is being done, and a preview that follows it.
//   - Word's own window, live: the same schedule and rules as the desktop card's picture (desktop/live.js: about 8 a second while it changes, a quarter of that
//     while still, a slower pace in Light graphics, nothing while the card is off screen, a call is running, or the window is hidden or minimized); the picture
//     is made inside the Word helper (host.ps1 "frame": PrintWindow of Word's own main window, never another program's), and is held in memory only until shown;
//   - when Word's window cannot be shown (hidden, minimized, the file route without Word, or a plain run with no live picture), a page preview instead: the
//     paragraphs around the last change, drawn by the chat as a small page, updated after every change;
//   - at the end, a last picture (or page) and "completed".
// The events are the desktop card's own ({ type: 'desktop_card', surface: 'app', ... }) with word: true, so the chat draws them with the same card.
// Plain functions with injected deps (test/word-units.js drives it with a fake helper and a fake clock). Loaded with the word tool, never at startup.
'use strict';

const { createLive, widthFor } = require('../desktop/live');

const IDLE_END_MS = 60e3;

// The lines of a read (markdown-ish) as page lines: [{ k: 'h1'|'h2'|'h3'|'p'|'li'|'tr', t, hl }]
function pageLines(lines, from, count) {
  return lines.map((raw, i) => {
    const line = String(raw);
    let k = 'p'; let t = line;
    const h = /^(#{1,6}) (.*)$/.exec(line);
    if (h) { k = `h${Math.min(h[1].length, 3)}`; t = h[2]; } else if (/^\s*(?:-|•) /.test(line)) { k = 'li'; t = line.replace(/^\s*(?:-|•) /, ''); } else if (/^\| /.test(line)) { k = 'tr'; t = line.replace(/^\| /, '').replace(/ \|$/, '').split(' | ').join('  │  '); }
    return { k, t: t.length > 220 ? `${t.slice(0, 219)}…` : t, hl: i >= from && i < from + count };
  });
}

// What changed between two reads of a file: the page around it, the changed lines marked.
function pageAround(before, after, { context = 3, max = 12 } = {}) {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  let b = before.length; let a = after.length;
  while (b > i && a > i && before[b - 1] === after[a - 1]) { b--; a--; }
  const start = Math.max(0, i - context);
  const end = Math.min(after.length, Math.max(a, i + 1) + context);
  const slice = after.slice(start, Math.min(end, start + max));
  return pageLines(slice, i - start, Math.max(1, a - i));
}

// deps: host { frame, peek, show } (com.js), live { visible(), light(), dpr() } | null (no live picture), now, setTimeout, clearTimeout, hooks
function createWordCard(deps = {}) {
  const now = deps.now || Date.now;
  const later = deps.setTimeout || setTimeout;
  const unlater = deps.clearTimeout || clearTimeout;
  const sessions = new Map(); // run key -> session
  const cards = new Map(); // card id -> session (what "Show in Word" may bring forward)
  let seq = 0;
  let inflight = 0;

  const keyOf = (ctx) => ctx.signal || ctx;
  const emitFor = (s, status, extra = {}) => {
    try { s.emit({ type: 'desktop_card', surface: 'app', word: true, id: s.id, app: 'Word', doc: s.doc?.name || '', title: s.doc?.name || '', status, task: s.label, thumbnail: s.thumb || null, page: s.page || null, ...extra }); } catch { /* a closed view */ }
    deps.hooks?.onEvent?.({ id: s.id, status, doc: s.doc?.name, task: s.label, thumb: Boolean(s.thumb), page: Boolean(s.page), ...extra });
  };

  function startLive(s) {
    if (!deps.live || !deps.host?.frame || s.live) return;
    s.live = createLive({
      now, setTimeout: later, clearTimeout: unlater,
      visible: () => deps.live.visible(), light: () => deps.live.light?.(), dpr: () => deps.live.dpr?.(),
      canRun: () => inflight === 0 && !s.ended,
      target: () => ({ hwnd: 0, pid: 0 }), allowed: () => !s.ended, approved: () => null, approve() {}, judge: () => true,
      frame: async (a) => { const r = await deps.host.frame({ w: a.w, q: a.q, reset: a.reset }); if (r?.skip) s.skipAt = now(); return r; }, // (a skipped look: the window is hidden or minimized, so the page preview takes over)
      onFrame: (image) => { s.thumb = `data:image/jpeg;base64,${image}`; s.lastFrameAt = now(); s.page = null; emitFor(s, 'working', { frame: true, page: null }); },
      onEnd: () => { s.live = null; },
    });
    s.live.start();
  }

  function touch(s) {
    s.lastCall = now();
    unlater(s.idle);
    s.idle = later(() => finish(s.key, 'completed'), IDLE_END_MS);
    s.idle?.unref?.();
  }

  // An action on `doc` starts (or moves) the card. com: Word itself is being driven (a live picture is possible).
  function use(ctx, doc, label, { com = true } = {}) {
    if (!ctx?.emit) return null;
    const key = keyOf(ctx);
    let s = sessions.get(key);
    if (!s) {
      s = { id: `word-${++seq}`, key, emit: ctx.emit, doc, label, thumb: null, page: null, live: null, ended: false, lastFrameAt: 0 };
      sessions.set(key, s);
      cards.set(s.id, s);
      while (cards.size > 40) cards.delete(cards.keys().next().value);
      if (ctx.signal?.addEventListener) { const onAbort = () => finish(key, 'stopped'); if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true }); }
    }
    const moved = s.doc && doc && s.doc.key !== doc.key;
    s.doc = doc || s.doc;
    s.label = label || s.label;
    if (moved) { s.thumb = null; s.page = null; }
    touch(s);
    if (com) { startLive(s); s.live?.kick({ fresh: Boolean(moved) }); } else if (s.live) { s.live.stop(); s.live = null; s.thumb = null; }
    s.com = com;
    emitFor(s, 'working');
    return s;
  }

  // A change was made: the page around it, unless Word's own window is being shown right now.
  async function changed(ctx, doc, { lines = null } = {}) {
    const s = sessions.get(keyOf(ctx));
    if (!s || s.ended) return;
    touch(s);
    try {
      const livePicture = s.com && s.thumb && now() - s.lastFrameAt < 3000 && s.lastFrameAt > (s.skipAt || 0);
      if (lines) s.page = { doc: doc?.name || s.doc?.name || '', lines };
      else if (s.com && deps.host?.peek && !livePicture) {
        const p = await deps.host.peek({ doc: doc?.path || doc?.name || s.doc?.name });
        if (Array.isArray(p.lines)) s.page = { doc: p.doc || s.doc?.name || '', lines: p.lines.map((l) => ({ k: String(l.k || 'p'), t: String(l.t ?? ''), hl: l.hl === true })) };
      }
      if (s.page && !livePicture) s.thumb = null; // (a stale picture never covers a newer page)
      s.live?.kick();
    } catch { /* the page preview is a courtesy */ }
    emitFor(s, 'working');
  }

  async function finish(key, status = 'completed') {
    const s = sessions.get(key);
    if (!s || s.ended) return false;
    s.ended = true;
    sessions.delete(key);
    unlater(s.idle);
    s.live?.stop();
    s.live = null;
    try { // the last picture of Word as it ended up (when its window can be shown), else the page
      if (status === 'completed' && s.com && deps.live && deps.host?.frame && deps.live.visible()) {
        const r = await deps.host.frame({ w: widthFor(deps.live.dpr?.(), deps.live.light?.()), q: 50, reset: true });
        if (r?.image) { s.thumb = `data:image/jpeg;base64,${r.image}`; s.page = null; }
      }
    } catch { /* the last picture is a courtesy */ }
    emitFor(s, status);
    return true;
  }

  return {
    use, changed,
    finishRun: (signal) => finish(signal, 'completed'),
    finishAll: () => Promise.all([...sessions.keys()].map((k) => finish(k, 'completed'))),
    busy: (on) => { inflight = Math.max(0, inflight + (on ? 1 : -1)); },
    // "Show in Word": the document the card is about, brought forward at the place it was changed.
    async open(id) { const s = cards.get(id); if (!s?.doc || !deps.host?.show) return false; try { await deps.host.show({ doc: s.doc.path || s.doc.name }); return true; } catch { return false; } },
    stats: () => ({ sessions: sessions.size, cards: cards.size }),
    destroy() { for (const s of sessions.values()) { s.ended = true; s.live?.stop(); unlater(s.idle); } sessions.clear(); },
  };
}

module.exports = { createWordCard, pageLines, pageAround, IDLE_END_MS };
