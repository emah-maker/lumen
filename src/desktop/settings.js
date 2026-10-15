// [desktop apps] The settings side: the master switch, the terminals switch and the list of apps the AI may always use. Added to the list only
// from the approval card ("Always"); removed here from Settings > AI > "Apps the AI can use". The settings:* channels answer the Settings page
// only (main.js PRIVILEGED_IPC); nothing a page or the AI's tools can reach.
'use strict';

const policy = require('./policy');

function createDesktopSettings({ readSettings, writeSettings, now = () => Date.now() }) {
  const list = () => policy.clean(readSettings().aiDesktopApps);
  const save = (next) => { writeSettings({ ...readSettings(), aiDesktopApps: policy.clean(next) }); return list(); };
  const api = {
    master: () => readSettings().aiDesktopControl === true,
    terminals: () => readSettings().aiDesktopTerminals === true,
    setMaster: (on) => { writeSettings({ ...readSettings(), aiDesktopControl: on === true }); },
    allowed: () => list(),
    allow(app, name) {
      const key = policy.procKey(app);
      if (policy.blockedReason({ proc: key, title: 'x' }, { terminals: api.terminals() })) return list(); // never listed
      return save([...list().filter((a) => a.app !== key), { app: key, name: name || policy.friendlyName(key), added: now() }]);
    },
    remove: (app) => save(list().filter((a) => a.app !== policy.procKey(app))),
    clear: () => save([]),
    register(ipcMain) {
      ipcMain.handle('settings:desktop-apps', () => list());
      ipcMain.handle('settings:remove-desktop-app', (_e, app) => api.remove(String(app ?? '')));
      ipcMain.handle('settings:clear-desktop-apps', () => api.clear());
    },
  };
  return api;
}

module.exports = { createDesktopSettings };
