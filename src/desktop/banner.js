// [desktop apps] The "The AI is using Word · Stop" banner: a small always-on-top window near the top of the screen while the AI operates another
// app. Frameless, see-through, never focused, and click-through except over the bar itself (so it never gets in the way of the app below).
// It can be dragged anywhere by its text, and made small (the "–" button) into a pill with just the dot, the app's name and Stop; a click on
// the pill makes it full size again. Where it was put and how big it is are kept until Lumen quits, so the next run shows it the same way.
// Created on first use, hidden between runs. In a test run (LUMEN_TEST_BACKGROUND) it is never shown on screen; a test presses its buttons
// through press().
'use strict';

const path = require('path');

const WIDTH = 480;
const SMALL_WIDTH = 270;
const HEIGHT = 44;
const DRAG_PX = 4; // a press on the pill that moves less than this is a click (make it full size), not a drag

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html, body { margin: 0; background: transparent; overflow: hidden; font: 13px/1 "Segoe UI", system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
  #bar { box-sizing: border-box; display: flex; align-items: center; gap: 10px; height: 36px; margin: 4px; padding: 0 6px 0 14px; border-radius: 18px; color: #fff; background: rgba(28, 28, 32, .94); box-shadow: 0 2px 10px rgba(0, 0, 0, .35); border: 1px solid rgba(255, 255, 255, .14); cursor: grab; }
  #bar.dragging { cursor: grabbing; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; flex: none; animation: pulse 1.4s ease-in-out infinite; }
  .paused #dot { background: #fbbf24; animation: none; }
  #text, #name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #name { display: none; }
  button { font: inherit; color: #fff; border: 0; border-radius: 14px; padding: 6px 12px; cursor: pointer; background: rgba(255, 255, 255, .16); flex: none; }
  button:hover { background: rgba(255, 255, 255, .28); }
  button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
  #stop { background: #dc2626; }
  #stop:hover { background: #ef4444; }
  #resume { display: none; background: #2563eb; }
  .paused #resume { display: inline-block; }
  #small { padding: 6px 9px; }
  .small { gap: 8px; padding-left: 12px; }
  .small #text, .small #small { display: none; }
  .small #name { display: block; }
  .small button { padding: 6px 10px; }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { #dot { animation: none; } }
</style></head><body>
<div id="bar" role="status" aria-live="polite" title="Drag to move"><span id="dot"></span><span id="text"></span><span id="name"></span><button id="resume" type="button">Resume</button><button id="stop" type="button">Stop</button><button id="small" type="button" title="Make smaller" aria-label="Make smaller">&#8211;</button></div>
<script>
  const api = window.desktopBanner;
  const bar = document.getElementById('bar');
  const text = document.getElementById('text');
  const name = document.getElementById('name');
  let drag = null;
  let inside = false;
  bar.addEventListener('mouseenter', () => { inside = true; api.hover(true); });
  bar.addEventListener('mouseleave', () => { inside = false; if (!drag) api.hover(false); });
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag = { x: e.screenX, y: e.screenY, moved: false };
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    api.drag('start', e.screenX, e.screenY);
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.screenX - drag.x) + Math.abs(e.screenY - drag.y) >= ${DRAG_PX}) drag.moved = true;
    if (drag.moved) api.drag('move', e.screenX, e.screenY);
  });
  const end = (e) => {
    if (!drag) return;
    const was = drag; drag = null;
    bar.classList.remove('dragging');
    api.drag('end', e.screenX, e.screenY);
    if (!was.moved && bar.classList.contains('small')) api.size(false); // a click on the pill: full size again
    if (!inside) api.hover(false);
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  document.getElementById('stop').addEventListener('click', () => api.action('stop'));
  document.getElementById('resume').addEventListener('click', () => api.action('resume'));
  document.getElementById('small').addEventListener('click', () => api.size(true));
  api.onState((s) => {
    text.textContent = s.text; name.textContent = s.app;
    bar.classList.toggle('paused', Boolean(s.paused)); bar.classList.toggle('small', Boolean(s.small));
    bar.title = s.small ? 'Click to make bigger, drag to move' : 'Drag to move';
  });
</script></body></html>`;

// deps: electron ({ BrowserWindow, screen, ipcMain }), preload (path), hidden (never show: test runs), onAction(name: 'stop' | 'resume').
function createBanner(deps) {
  const { BrowserWindow, screen, ipcMain } = deps.electron;
  const hidden = deps.hidden === true;
  const preload = deps.preload || path.join(__dirname, 'banner-preload.js');
  let win = null;
  let loaded = null;
  let state = { visible: false, text: '', paused: false, app: '', small: false };
  let spot = null; // { x, y }: where the person dragged it (kept until Lumen quits); null: top middle of the main screen
  let grab = null; // a drag in progress: where the pointer and the window started
  let listener = null;

  const own = (event) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents); // only the banner's own page
  const width = () => (state.small ? SMALL_WIDTH : WIDTH);

  // Keeps the bar on a screen: inside the work area of the screen nearest to where it would go.
  function clamp(x, y, w = width()) {
    let area = null;
    try { area = screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: Math.round(y + HEIGHT / 2) }).workArea; } catch { /* below */ }
    if (!area) { try { area = screen.getPrimaryDisplay().workArea; } catch { return { x: Math.round(x), y: Math.round(y) }; } }
    return {
      x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - w)),
      y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - HEIGHT)),
    };
  }

  function listen() {
    if (listener) return;
    listener = (event, what) => {
      if (!own(event)) return;
      if (what === 'stop' || what === 'resume') deps.onAction?.(what);
    };
    ipcMain.on('desktop-banner:action', listener);
    ipcMain.on('desktop-banner:hover', (event, on) => {
      if (!own(event)) return;
      win.setIgnoreMouseEvents(!on, { forward: true });
    });
    ipcMain.on('desktop-banner:drag', (event, phase, x, y) => {
      if (!own(event) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      if (phase === 'start') { const [wx, wy] = win.getPosition(); grab = { x, y, wx, wy }; return; }
      if (!grab) return;
      const at = { x: grab.wx + (x - grab.x), y: grab.wy + (y - grab.y) };
      if (phase === 'move') { win.setPosition(Math.round(at.x), Math.round(at.y), false); return; }
      if (phase === 'end') {
        const g = grab;
        grab = null;
        const [wx, wy] = win.getPosition();
        if (wx === g.wx && wy === g.wy) return; // (a click, not a drag: it stays where it is)
        spot = clamp(wx, wy);
        win.setPosition(spot.x, spot.y, false);
      }
    });
    ipcMain.on('desktop-banner:size', (event, small) => { if (own(event)) resize(Boolean(small)); });
  }

  function ensure() {
    if (win && !win.isDestroyed()) return loaded;
    listen();
    win = new BrowserWindow({
      width: width(), height: HEIGHT, show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'Lumen: the AI is using an app',
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    BANNERS.add(win.webContents); // [ipc gate] main.js lets only these pages send desktop-banner:* (isBanner)
    win.on('closed', () => { win = null; loaded = null; grab = null; });
    loaded = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`).catch(() => {});
    return loaded;
  }

  // Where it goes: where the person left it (still on a screen), or the top middle of the main screen.
  function where() {
    if (spot) return clamp(spot.x, spot.y);
    try {
      const area = screen.getPrimaryDisplay().workArea;
      return { x: Math.round(area.x + (area.width - width()) / 2), y: area.y + 6 };
    } catch { return null; }
  }

  function place() {
    const at = where();
    if (!at) return;
    try { win.setBounds({ x: at.x, y: at.y, width: width(), height: HEIGHT }, false); } catch { /* the window keeps where it is */ }
  }

  const push = () => { if (win && !win.isDestroyed()) win.webContents.send('desktop-banner:state', { text: state.text, paused: state.paused, app: state.app, small: state.small }); };
  const words = (app, paused) => (paused ? `You took over ${app}. Resume?` : `The AI is using ${app}`);

  // Small <-> full size. The bar keeps its middle where it was (so the pill opens up around itself), then is kept on the screen.
  function resize(small) {
    if (state.small === small) return;
    const before = width();
    state = { ...state, small };
    if (hidden || !win || win.isDestroyed()) return;
    let at = null;
    try { const [x, y] = win.getPosition(); at = clamp(x + (before - width()) / 2, y); } catch { /* place() below */ }
    if (at) { if (spot) spot = at; try { win.setBounds({ x: at.x, y: at.y, width: width(), height: HEIGHT }, false); } catch { /* gone */ } } else place();
    push();
  }

  return {
    async show(app, { paused = false } = {}) {
      state = { ...state, visible: true, app, paused, text: words(app, paused) };
      if (hidden) return;
      await ensure();
      if (!win.isVisible()) place(); // (a run going on keeps the bar where it is)
      push();
      if (!win.isVisible()) win.showInactive();
    },
    async update({ app = state.app, paused = state.paused } = {}) {
      state = { ...state, app, paused, text: words(app, paused) };
      if (hidden) return;
      push();
    },
    hide() {
      state = { ...state, visible: false };
      grab = null;
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    },
    // A test presses a button of the banner (the window itself is never shown in a test run).
    press(what) {
      if (!state.visible) return;
      if (what === 'stop' || what === 'resume') deps.onAction?.(what);
      else if (what === 'small' || what === 'big') resize(what === 'small');
    },
    state: () => ({ ...state, spot: spot ? { ...spot } : null }),
    visible: () => state.visible,
    destroy() { try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* gone */ } win = null; loaded = null; },
  };
}

const BANNERS = new WeakSet(); // every banner page's webContents
const isBanner = (wc) => Boolean(wc) && BANNERS.has(wc);

module.exports = { createBanner, isBanner, HTML, WIDTH, SMALL_WIDTH, HEIGHT, DRAG_PX, esc };
