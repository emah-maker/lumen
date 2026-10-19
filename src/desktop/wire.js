// [desktop apps] Puts the pieces together for the real app (main.js loads this on first use, never at startup): the settings, the helper
// process, the banner, the key checks, the global Stop shortcut and the app icon. Tests build their own from the parts.
'use strict';

function wire({ electron, readSettings, writeSettings, stopRun, hidden = false, live = null }) {
  const { createDesktop } = require('./index');
  const { createDesktopSettings } = require('./settings');
  const { createBanner } = require('./banner');
  const settings = createDesktopSettings({ readSettings, writeSettings });
  let controller = null;

  const banner = createBanner({
    electron,
    hidden,
    onAction: (what) => { if (what === 'stop') controller?.stop('banner'); else if (what === 'resume') controller?.resume(); },
  });
  const accel = new Set();
  const shortcut = {
    register(key, fn) { if (hidden) { accel.add(key); return; } if (electron.globalShortcut.register(key, fn)) accel.add(key); },
    unregister(key) { if (accel.delete(key) && !hidden) electron.globalShortcut.unregister(key); },
    registered: () => [...accel],
  };
  const icon = async (exe) => {
    if (!exe || hidden) return null;
    try { const img = await electron.app.getFileIcon(exe, { size: 'normal' }); return img.isEmpty() ? null : img.toDataURL(); } catch { return null; }
  };

  // live: { visible(), light() } turns on the card's live picture (live.js); the display scale is read here, when it is needed.
  const liveDeps = live ? { ...live, dpr: () => { try { return electron.screen?.getPrimaryDisplay?.().scaleFactor || 1; } catch { return 1; } } } : null;
  // macOS: the permission checks (they never prompt), pictures resized in-process, and the button that opens a System Settings pane.
  const mac = process.platform === 'darwin' ? {
    access: {
      accessibility: () => { try { return electron.systemPreferences.isTrustedAccessibilityClient(false); } catch { return null; } },
      screen: () => { try { return electron.systemPreferences.getMediaAccessStatus('screen') === 'granted'; } catch { return null; } },
    },
    resize: (buf, w, q) => { const img = electron.nativeImage.createFromBuffer(buf); const size = img.getSize(); return (size.width > w ? img.resize({ width: Math.round(w), quality: 'good' }) : img).toJPEG(Math.round(q) || 60).toString('base64'); },
    openSettings: (url) => (/^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_[A-Za-z]+$/.test(url) ? electron.shell.openExternal(url) : null),
  } : {};
  const exe = require('./platforms').backendFor(process.platform)?.lumenExe(process.execPath) || process.execPath;
  controller = createDesktop({ settings, banner, shortcut, icon, stopRun, live: liveDeps, lumen: { pid: process.pid, exe }, ...mac });
  controller.banner = banner;
  controller.shortcut = shortcut;
  return { controller, settings };
}

module.exports = { wire };
