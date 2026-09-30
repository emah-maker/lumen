// First run and the things a new user sets up (the sidebar's welcome, renderer/chat-core.js): whether this is a
// fresh install, importing from another browser without a native dialog, and becoming the default browser.
//
// Default browser on Windows: Windows 10 and 11 only offer a browser in Default apps when it is registered as
// one (a StartMenuInternet client with Capabilities and a ProgID), per user, as Chrome's per-user install does.
// Setting the http/https protocol handler alone (app.setAsDefaultProtocolClient) is ignored for browsers, and
// app.isDefaultProtocolClient reads that handler back, not the user's choice: it said "default" after one click
// even when the user never picked Lumen. The user's real choice is the UserChoice ProgId.
const path = require('path');
const { execFile } = require('child_process');

const PROG_ID = 'LumenHTML';
const CLIENT_KEY = 'Software\\Clients\\StartMenuInternet\\Lumen';

function reg(args) {
  return new Promise((resolve) => execFile('reg', args, { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout))));
}

// `freshInstall()`: no settings file existed when this launch first read settings.
// `reg query … /v ProgId` output -> whether it names this ProgID.
const progIdIs = (out, progId) => Boolean(out && new RegExp(`ProgId\\s+REG_SZ\\s+${progId}\\s*$`, 'm').test(out));

function create({ app, shell, readSettings, writeSettings, importer, importBrowser, freshInstall }) {
  // The welcome shows on a fresh install until it's finished or skipped (a quit halfway shows it again).
  function welcomePending() {
    const s = readSettings();
    if (s.welcome === undefined && freshInstall()) { writeSettings({ ...s, welcome: 'pending' }); return true; }
    return s.welcome === 'pending';
  }
  function welcomeDone() {
    const s = readSettings();
    if (s.welcome !== 'done') writeSettings({ ...s, welcome: 'done' });
  }

  const launchCommand = () => {
    const exe = process.execPath;
    return process.defaultApp ? `"${exe}" "${path.resolve(process.argv[1] || '.')}"` : `"${exe}"`;
  };
  async function registerOnWindows() {
    const exe = process.execPath;
    const icon = `${exe},0`;
    const open = `${launchCommand()} "%1"`;
    const values = [
      [`HKCU\\Software\\Classes\\${PROG_ID}`, null, 'Lumen HTML Document'],
      [`HKCU\\Software\\Classes\\${PROG_ID}\\DefaultIcon`, null, icon],
      [`HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, null, open],
      [`HKCU\\${CLIENT_KEY}`, null, 'Lumen'],
      [`HKCU\\${CLIENT_KEY}\\DefaultIcon`, null, icon],
      [`HKCU\\${CLIENT_KEY}\\shell\\open\\command`, null, launchCommand()],
      [`HKCU\\${CLIENT_KEY}\\Capabilities`, 'ApplicationName', 'Lumen'],
      [`HKCU\\${CLIENT_KEY}\\Capabilities`, 'ApplicationDescription', 'Lumen, a browser with an AI sidebar'],
      [`HKCU\\${CLIENT_KEY}\\Capabilities`, 'ApplicationIcon', icon],
      [`HKCU\\${CLIENT_KEY}\\Capabilities\\URLAssociations`, 'http', PROG_ID],
      [`HKCU\\${CLIENT_KEY}\\Capabilities\\URLAssociations`, 'https', PROG_ID],
      [`HKCU\\${CLIENT_KEY}\\Capabilities\\FileAssociations`, '.htm', PROG_ID],
      [`HKCU\\${CLIENT_KEY}\\Capabilities\\FileAssociations`, '.html', PROG_ID],
      ['HKCU\\Software\\RegisteredApplications', 'Lumen', `${CLIENT_KEY}\\Capabilities`],
    ];
    for (const [key, name, data] of values) {
      if ((await reg(['add', key, ...(name ? ['/v', name] : ['/ve']), '/t', 'REG_SZ', '/d', data, '/f'])) === null) return false;
    }
    return true;
  }

  let lastDefault = null; // the last answer, for the synchronous app menu
  async function isDefault() {
    if (process.platform === 'win32') {
      // (Newer Windows 11 builds keep the choice under UserChoiceLatest, older ones under UserChoice.)
      const base = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https';
      const outs = await Promise.all(['UserChoiceLatest', 'UserChoice'].map((k) => reg(['query', `${base}\\${k}`, '/v', 'ProgId'])));
      lastDefault = progIdIs(outs.find(Boolean), PROG_ID);
    } else {
      lastDefault = app.isDefaultProtocolClient('https');
    }
    return lastDefault;
  }
  // The user's choice either way: Windows opens its Default apps page on Lumen (it asks there), macOS asks by itself.
  async function makeDefault() {
    if (process.platform === 'win32') {
      const ok = await registerOnWindows();
      await shell.openExternal(ok ? 'ms-settings:defaultapps?registeredAppUser=Lumen' : 'ms-settings:defaultapps').catch(() => {});
      return { ok, opened: 'windows-settings' };
    }
    const args = process.defaultApp ? [process.execPath, [path.resolve(process.argv[1] || '.')]] : [];
    for (const scheme of ['http', 'https']) app.setAsDefaultProtocolClient(scheme, ...args);
    // (macOS confirms in its own dialog: the answer comes a moment later, so it's waited for before judging.)
    for (let i = 0; i < 10; i++) {
      if (await isDefault()) return { ok: true, isDefault: true };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: true, isDefault: false, opened: process.platform === 'darwin' ? 'system-prompt' : undefined };
  }

  // Import for the welcome and Settings: the result comes back to the page (no native dialog).
  async function importFrom(id) {
    await new Promise((r) => setImmediate(r)); // (the button's "Importing…" is drawn first)
    try {
      const result = importBrowser(id);
      return { ok: true, label: result.label, bookmarks: result.bookmarks, history: result.history };
    } catch (err) {
      const locked = /locked|busy|EBUSY|EPERM|SQLITE_BUSY/i.test(String(err?.message || ''));
      return { ok: false, error: locked ? 'that browser is still open. Close it, then try again.' : err.message };
    }
  }

  async function state() {
    return { welcome: welcomePending(), browsers: importer.detectBrowsers(), isDefault: await isDefault(), platform: process.platform, devBuild: Boolean(process.defaultApp) };
  }

  return { welcomePending, welcomeDone, isDefault, lastDefault: () => lastDefault, makeDefault, importFrom, state };
}

module.exports = { create, PROG_ID, progIdIs };
