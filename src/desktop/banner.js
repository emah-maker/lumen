// [desktop apps] The "The AI is using Word · Stop" banner: a small always-on-top window near the top of the screen while the AI operates another
// app. Frameless, see-through, never focused, and click-through except over its own buttons (so it never gets in the way of the app below).
// Created on first use, hidden between runs. In a test run (LUMEN_TEST_BACKGROUND) it is never shown on screen; a test presses its buttons
// through press().
'use strict';

const path = require('path');

const WIDTH = 420;
const HEIGHT = 44;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html, body { margin: 0; background: transparent; overflow: hidden; font: 13px/1 "Segoe UI", system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
  #bar { box-sizing: border-box; display: flex; align-items: center; gap: 10px; height: 36px; margin: 4px; padding: 0 6px 0 14px; border-radius: 18px; color: #fff; background: rgba(28, 28, 32, .94); box-shadow: 0 2px 10px rgba(0, 0, 0, .35); border: 1px solid rgba(255, 255, 255, .14); }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; flex: none; animation: pulse 1.4s ease-in-out infinite; }
  .paused #dot { background: #fbbf24; animation: none; }
  #text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { font: inherit; color: #fff; border: 0; border-radius: 14px; padding: 6px 12px; cursor: pointer; background: rgba(255, 255, 255, .16); }
  button:hover { background: rgba(255, 255, 255, .28); }
  button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
  #stop { background: #dc2626; }
  #stop:hover { background: #ef4444; }
  #resume { display: none; background: #2563eb; }
  .paused #resume { display: inline-block; }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { #dot { animation: none; } }
</style></head><body>
<div id="bar" role="status" aria-live="polite"><span id="dot"></span><span id="text"></span><button id="resume" type="button">Resume</button><button id="stop" type="button">Stop</button></div>
<script>
  const api = window.desktopBanner;
  const bar = document.getElementById('bar');
  const text = document.getElementById('text');
  const over = (on) => api.hover(on);
  for (const el of document.querySelectorAll('button')) { el.addEventListener('mouseenter', () => over(true)); el.addEventListener('mouseleave', () => over(false)); }
  document.getElementById('stop').addEventListener('click', () => api.action('stop'));
  document.getElementById('resume').addEventListener('click', () => api.action('resume'));
  api.onState((s) => { text.textContent = s.text; bar.classList.toggle('paused', Boolean(s.paused)); });
</script></body></html>`;

// deps: electron ({ BrowserWindow, screen, ipcMain }), preload (path), hidden (never show: test runs), onAction(name: 'stop' | 'resume').
function createBanner(deps) {
  const { BrowserWindow, screen, ipcMain } = deps.electron;
  const hidden = deps.hidden === true;
  const preload = deps.preload || path.join(__dirname, 'banner-preload.js');
  let win = null;
  let loaded = null;
  let state = { visible: false, text: '', paused: false, app: '' };
  let listener = null;

  function listen() {
    if (listener) return;
    listener = (event, what) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return; // only the banner's own page
      if (what === 'stop' || what === 'resume') deps.onAction?.(what);
    };
    ipcMain.on('desktop-banner:action', listener);
    ipcMain.on('desktop-banner:hover', (event, on) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
      win.setIgnoreMouseEvents(!on, { forward: true });
    });
  }

  function ensure() {
    if (win && !win.isDestroyed()) return loaded;
    listen();
    win = new BrowserWindow({
      width: WIDTH, height: HEIGHT, show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'Lumen: the AI is using an app',
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.on('closed', () => { win = null; loaded = null; });
    loaded = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`).catch(() => {});
    return loaded;
  }

  function place() {
    try {
      const area = screen.getPrimaryDisplay().workArea;
      win.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: area.y + 6, width: WIDTH, height: HEIGHT }, false);
    } catch { /* the window keeps where it is */ }
  }

  const push = () => { if (win && !win.isDestroyed()) win.webContents.send('desktop-banner:state', { text: state.text, paused: state.paused }); };

  return {
    async show(app, { paused = false } = {}) {
      state = { visible: true, app, paused, text: paused ? `You took over ${app}. Resume?` : `The AI is using ${app}` };
      if (hidden) return;
      await ensure();
      place();
      push();
      if (!win.isVisible()) win.showInactive();
    },
    async update({ app = state.app, paused = state.paused } = {}) {
      state = { ...state, app, paused, text: paused ? `You took over ${app}. Resume?` : `The AI is using ${app}` };
      if (hidden) return;
      push();
    },
    hide() {
      state = { ...state, visible: false };
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    },
    // A test presses a button of the banner (the window itself is never shown in a test run).
    press(what) { if (state.visible && (what === 'stop' || what === 'resume')) deps.onAction?.(what); },
    state: () => ({ ...state }),
    visible: () => state.visible,
    destroy() { try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* gone */ } win = null; loaded = null; },
  };
}

module.exports = { createBanner, HTML, WIDTH, HEIGHT, esc };
