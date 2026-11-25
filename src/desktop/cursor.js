// [desktop apps] The AI's cursor over another app's window: the same colored arrow with a name and the same click ring the AI's cursors
// draw in web pages (ai/page-scripts.js agentCursor; colors from features/agent-tags.js), so the person can see where the AI is pointing
// in Word or SolidWorks too. It is drawn in Lumen's own window over the app, never with the system pointer:
//   - a frameless, transparent, always-on-top window the size of the app's window, never focusable, not in the taskbar, and click-through
//     (setIgnoreMouseEvents(true) with no forwarding, so Windows gives every click and the hit tests in winapi.js / the helper to the app below);
//   - placed in fractions of the app's window (fx, fy), so it stays on the same spot when the window moves or changes size (follow());
//   - it fades out after CURSOR_IDLE_MS without a new point, like the page cursor. Created on first use, hidden between runs; a test run
//     (LUMEN_TEST_BACKGROUND) never creates it and reads state() instead.
'use strict';

const CURSOR_IDLE_MS = 8000; // (the page cursor's CURSOR_IDLE_MS)
const LEAD = { color: '#0a84ff', label: 'AI' }; // the lead agent: the blue of its click ring in pages (agent-tags.js); helpers bring their own tag
const KINDS = new Set(['point', 'click', 'double', 'drag', 'scroll']);

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; pointer-events: none; -webkit-user-select: none; user-select: none; }
  .c { position: absolute; left: 0; top: 0; opacity: 0; transition: left .35s cubic-bezier(.2,.8,.2,1), top .35s cubic-bezier(.2,.8,.2,1), opacity .4s; font: 600 11px/1.3 "Segoe UI", system-ui, sans-serif; }
  .c svg { display: block; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
  .c span { position: absolute; left: 14px; top: 16px; padding: 2px 7px; border-radius: 9px; color: #fff; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
  .r { position: absolute; width: 28px; height: 28px; margin: -14px 0 0 -14px; border: 2px solid; border-radius: 50%; box-sizing: border-box; transition: opacity .5s .3s; }
  @media (prefers-reduced-motion: reduce) { .c, .r { transition: none; } }
</style></head><body>
<div class="c" id="c"><svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1v17l4.6-4.3 3.1 7 3-1.3-3-6.9H15z" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><span></span></div>
<script>
  const c = document.getElementById('c');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let fade = 0; let seq = 0; let timers = [];
  const pct = (f) => (Math.min(1, Math.max(0, Number(f) || 0)) * 100) + '%';
  const at = (p) => { c.style.left = pct(p.fx); c.style.top = pct(p.fy); };
  function ring(p, color, n) { // the click ring of the page cursor, in this cursor's color
    for (let i = 0; i < n; i++) timers.push(setTimeout(() => {
      const r = document.createElement('div');
      r.className = 'r'; r.style.left = pct(p.fx); r.style.top = pct(p.fy); r.style.borderColor = color; r.style.boxShadow = '0 0 0 4px ' + color + '47';
      document.body.appendChild(r);
      if (!still) requestAnimationFrame(() => requestAnimationFrame(() => { r.style.opacity = '0'; }));
      setTimeout(() => r.remove(), still ? 600 : 900);
    }, i * 160));
  }
  window.__lumenCursor = (s) => {
    if (s.seq === seq) return; seq = s.seq;
    for (const t of timers) clearTimeout(t); timers = [];
    if (!s.visible) { c.style.opacity = '0'; return; }
    c.querySelector('path').setAttribute('fill', s.color);
    const tag = c.querySelector('span'); tag.textContent = s.label; tag.style.background = s.color;
    at(s.from || s);
    c.style.opacity = '1';
    const move = still ? 0 : 360; // (the arrow glides to the point first, then the ring shows where it pressed)
    if (s.from) timers.push(setTimeout(() => at(s), move));
    if (s.kind === 'click' || s.kind === 'double') timers.push(setTimeout(() => ring(s, s.color, s.kind === 'double' ? 2 : 1), move));
    if (s.kind === 'drag') ring(s.from || s, s.color, 1);
    clearTimeout(fade);
    fade = setTimeout(() => { c.style.opacity = '0'; }, ${CURSOR_IDLE_MS});
  };
</script></body></html>`;

const isColor = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ''));
const frac = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const sameRect = (a, b) => Boolean(a && b) && a.length === 4 && b.length === 4 && a.every((v, i) => v === b[i]);
const okRect = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1];

// deps: electron ({ BrowserWindow, screen }), hidden (never create the window: test runs).
function createCursor(deps) {
  const { BrowserWindow, screen } = deps.electron || {};
  const hidden = deps.hidden === true;
  let win = null;
  let loaded = null;
  let seq = 0;
  // rect: the app window in screen pixels [left, top, right, bottom] (GetWindowRect); fx, fy: the point in fractions of it.
  let state = { visible: false, shown: false, rect: null, fx: 0, fy: 0, from: null, kind: 'point', color: LEAD.color, label: LEAD.label, seq: 0 };

  // Screen pixels -> Electron's DIPs (Windows: a window on a 150% screen is 2/3 as many DIPs; macOS has DIPs already).
  function bounds(rect) {
    const px = { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] };
    try { if (typeof screen?.screenToDipRect === 'function') return screen.screenToDipRect(null, px); } catch { /* as is */ }
    return px;
  }

  function ensure() {
    if (win && !win.isDestroyed()) return loaded;
    win = new BrowserWindow({
      width: 100, height: 100, show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'Lumen: the AI\'s pointer',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true); // (no { forward }: the app below gets every click, and the window is not hit at all)
    win.on('closed', () => { win = null; loaded = null; });
    loaded = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`).catch(() => {});
    return loaded;
  }

  const page = () => ({ visible: state.visible && state.shown, fx: state.fx, fy: state.fy, from: state.from, kind: state.kind, color: state.color, label: state.label, seq: state.seq });
  const push = () => { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(`window.__lumenCursor && window.__lumenCursor(${JSON.stringify(page())})`).catch(() => {}); };
  function place() {
    if (!win || win.isDestroyed() || !state.rect) return;
    try { win.setBounds(bounds(state.rect), false); } catch { /* it stays where it was */ }
  }
  function reveal(on) {
    if (hidden || !win || win.isDestroyed()) return;
    if (on && !win.isVisible()) win.showInactive();
    else if (!on && win.isVisible()) win.hide();
  }

  return {
    // The AI points at (fx, fy) of the window at `rect`; kind: point | click | double | drag (from -> to) | scroll. tag: { color, label } of a helper, else the lead's.
    async show({ rect, fx, fy, from = null, kind = 'point', tag = null } = {}) {
      if (!okRect(rect)) return false;
      state = {
        ...state, visible: true, shown: true, rect: rect.slice(), fx: frac(fx), fy: frac(fy),
        from: from ? { fx: frac(from.fx), fy: frac(from.fy) } : null, kind: KINDS.has(kind) ? kind : 'point',
        color: isColor(tag?.color) ? tag.color : LEAD.color, label: String(tag?.label || LEAD.label).slice(0, 40), seq: ++seq,
      };
      if (hidden) return true;
      await ensure();
      place();
      push();
      reveal(true);
      return true;
    },
    // The app's window moved or changed size (rect), or is covered at the point / minimized (shown false): the cursor goes with it, or out of sight.
    follow(rect, shown = true) {
      if (!state.visible) return;
      const moved = okRect(rect) && !sameRect(rect, state.rect);
      if (moved) state = { ...state, rect: rect.slice() };
      const want = Boolean(shown) && okRect(rect);
      if (want !== state.shown) state = { ...state, shown: want, from: null, kind: 'point', seq: ++seq };
      if (hidden) return;
      if (moved) place();
      if (want) push();
      reveal(want);
    },
    hide() {
      if (!state.visible) return;
      state = { ...state, visible: false, shown: false, from: null, seq: ++seq };
      if (hidden) return;
      push();
      reveal(false);
    },
    // Where the point is on the screen now (screen pixels), for the "is the app what is under it" check.
    point() { const r = state.rect; return state.visible && r ? { x: Math.round(r[0] + state.fx * (r[2] - r[0])), y: Math.round(r[1] + state.fy * (r[3] - r[1])) } : null; },
    visible: () => state.visible,
    state: () => ({ ...state, rect: state.rect ? state.rect.slice() : null }),
    destroy() { try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* gone */ } win = null; loaded = null; },
  };
}

module.exports = { createCursor, HTML, LEAD, CURSOR_IDLE_MS };
