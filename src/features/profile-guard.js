// Which profile folder (Electron's userData) a run may use. The installed Lumen keeps the real one (%APPDATA%\Lumen: settings,
// history, saved chats, keys). A test run (CLAUDE_BROWSER_TEST) or an unpackaged development run (`electron .`) must never
// open it: a second process on the same profile quits at once ("another instance holds the lock"), and anything that runs
// while it quits (saving or clearing chats, migrations, sweeps) acts on the running Lumen's files.
//
//   - test run: CLAUDE_BROWSER_PROFILE, or a new temp folder when it is unset or names a real profile
//   - development run: its own folder, `Lumen-dev` next to the real one (LUMEN_DEV_REAL_PROFILE=1 opts back in, for the person
//     who really wants to run the checkout on their own data, with the installed Lumen closed)
//   - packaged Lumen: untouched
const path = require('path');

const norm = (p) => {
  const r = path.resolve(String(p || '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
};

// The folders that belong to the installed app (and to its old name).
function realProfiles({ appData, defaultUserData }) {
  return [path.join(appData, 'Lumen'), path.join(appData, 'Claude Browser'), defaultUserData].filter(Boolean).map(norm);
}

// `dir` is a real profile, or inside one.
function isRealProfile(dir, roots) {
  const d = norm(dir);
  return roots.some((r) => d === r || d.startsWith(r + path.sep));
}

// What to set userData to: { dir, reason } or null (leave it alone).
function chooseProfile({ packaged, test, env, appData, defaultUserData, tmpdir, mkdtemp }) {
  if (packaged) return null;
  const roots = realProfiles({ appData, defaultUserData });
  if (test) {
    const wanted = env.CLAUDE_BROWSER_PROFILE;
    if (wanted && !isRealProfile(wanted, roots)) return { dir: wanted, reason: 'test profile' };
    return { dir: mkdtemp(path.join(tmpdir, 'claude-browser-test-')), reason: wanted ? 'CLAUDE_BROWSER_PROFILE named the real profile' : 'no CLAUDE_BROWSER_PROFILE' };
  }
  if (env.LUMEN_DEV_REAL_PROFILE === '1') return null;
  return { dir: path.join(appData, 'Lumen-dev'), reason: 'development run' };
}

// Called first thing in the main process, before anything reads userData.
function apply(app, { test, env = process.env, fs = require('fs'), os = require('os') } = {}) {
  const choice = chooseProfile({
    packaged: app.isPackaged,
    test,
    env,
    appData: app.getPath('appData'),
    defaultUserData: app.getPath('userData'),
    tmpdir: os.tmpdir(),
    mkdtemp: (prefix) => fs.mkdtempSync(prefix),
  });
  if (!choice) return null;
  if (choice.reason !== 'test profile' && choice.reason !== 'no CLAUDE_BROWSER_PROFILE') console.error(`[lumen] ${choice.reason}: using ${choice.dir}, not the installed Lumen's profile`);
  try { fs.mkdirSync(choice.dir, { recursive: true }); } catch { /* Electron makes it */ }
  app.setPath('userData', choice.dir);
  if (test) env.CLAUDE_BROWSER_PROFILE = choice.dir; // (the rest of the app, and the processes it starts, read the variable too)
  return choice.dir;
}

module.exports = { apply, chooseProfile, isRealProfile, realProfiles };
