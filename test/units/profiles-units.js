// [profiles] features/profiles.js: the list file, the --lumen-profile switch, where each profile's folder is, and that the
// Default folder is never written to. Plain node: node test/units/profiles-units.js
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../../src/features/profiles');
const guard = require('../../src/features/profile-guard');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-profiles-units-'));
const base = path.join(tmp, 'Lumen');
fs.mkdirSync(base);
fs.writeFileSync(path.join(base, 'settings.json'), '{"x":1}');
const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => { const st = fs.statSync(path.join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join('|');
const before = snapshot(base);

// ---- folders
check('the profiles folder sits next to the Default folder, not inside it', P.rootFor(base) === `${base} Profiles` && P.rootFor(`${base}\\`) === `${base} Profiles`, P.rootFor(base));
check('profile-guard counts "Lumen Profiles" as the real data (a test can never point at it)', guard.isRealProfile(path.join('C:\\AppData', 'Lumen Profiles', 'p-12345678'), guard.realProfiles({ appData: 'C:\\AppData', defaultUserData: 'C:\\AppData\\Lumen' })), '');
check('...and a test folder\'s own profiles are not', !guard.isRealProfile(path.join(tmp, 'x Profiles', 'p-1'), guard.realProfiles({ appData: 'C:\\AppData', defaultUserData: 'C:\\AppData\\Lumen' })), '');

// ---- the switch
check('argId reads --lumen-profile=<id>', P.argId(['electron', '.', '--lumen-profile=p-abcdef12']) === 'p-abcdef12', '');
check('argId: none -> null', P.argId(['electron', '.']) === null, '');

// ---- the list
const store = P.createStore({ base, deps: { randomId: (() => { let n = 0; return () => String(++n).padStart(8, '0'); })(), now: () => 1000 } });
const empty = store.list();
check('a fresh list is the Default profile alone', empty.length === 1 && empty[0].id === 'default' && empty[0].name === 'Default', JSON.stringify(empty));
check('reading the list makes no folder', !fs.existsSync(store.root), store.root);
const work = store.add({ name: '  Work\n stuff ', color: 'green', avatar: '💼' });
check('add makes an id, cleans the name and keeps colour and avatar', work.id === 'p-00000001' && work.name === 'Work stuff' && work.color === 'green' && work.avatar === '💼', JSON.stringify(work));
check('...and its folder is <root>/<id>', fs.statSync(path.join(store.root, work.id)).isDirectory() && store.dirOf(work.id) === path.join(store.root, work.id), store.dirOf(work.id));
const home = store.add({ name: '', color: 'nope', avatar: '<script>' });
check('a blank name gets "Profile N"; an unknown colour gets an unused one; an unknown avatar is the letter', home.name === 'Profile 3' && home.color === 'teal' && home.avatar === '', JSON.stringify(home));
check('the list keeps Default first', store.list().map((p) => p.id).join() === 'default,p-00000001,p-00000002', JSON.stringify(store.list()));
store.update('default', { name: 'Personal', color: 'pink', avatar: '🏠' });
check('Default can be renamed and recoloured (kept in the list file)', store.get('default').name === 'Personal' && store.get('default').color === 'pink' && store.get('default').avatar === '🏠', JSON.stringify(store.get('default')));
store.update(work.id, { name: '   ' });
check('an empty new name is ignored', store.get(work.id).name === 'Work stuff', store.get(work.id).name);
check('Default can\'t be forgotten', store.forget('default') === false && store.get('default'), '');
check('forget takes a profile off the list', store.forget(home.id) === true && !store.get(home.id), '');
check('dirOf refuses anything that is not a profile id (no ../ escape)', store.dirOf('../evil') === null && store.dirOf('p-../../x') === null, '');
fs.writeFileSync(store.file, JSON.stringify({ profiles: [{ id: '../x', name: 'bad' }, { id: 'p-00000001', name: 'A' }, { id: 'p-00000001', name: 'dup' }, null, 'x'] }));
check('a hand-edited list loses bad and duplicate entries', store.list().map((p) => p.id).join() === 'default,p-00000001' && store.get('p-00000001').name === 'A', JSON.stringify(store.list()));
check('the Default folder was never written to', snapshot(base) === before, snapshot(base));

// ---- apply()
const fakeApp = () => { let ud = base; return { getPath: () => ud, setPath: (_k, v) => { ud = v; }, get userData() { return ud; } }; };
{
  const app = fakeApp(); const env = {};
  const cur = P.apply(app, { argv: ['x'], env, test: true });
  check('no switch: the Default profile, userData unchanged', cur.id === 'default' && app.userData === base && !env.CLAUDE_BROWSER_PROFILE, JSON.stringify(cur));
}
{
  const app = fakeApp(); const env = {};
  const cur = P.apply(app, { argv: ['x', '--lumen-profile=p-00000001'], env, test: true });
  check('--lumen-profile=<id>: userData is that profile\'s folder', cur.id === 'p-00000001' && app.userData === path.join(`${base} Profiles`, 'p-00000001') && cur.base === base, JSON.stringify(cur));
  check('...and a test run\'s CLAUDE_BROWSER_PROFILE follows it', env.CLAUDE_BROWSER_PROFILE === app.userData, env.CLAUDE_BROWSER_PROFILE);
}
{
  const app = fakeApp();
  const cur = P.apply(app, { argv: ['x', '--lumen-profile=p-99999999'], env: {}, test: true });
  check('an id that is not on the list starts the Default profile', cur.id === 'default' && app.userData === base, JSON.stringify(cur));
}

// ---- launching
const spec = P.launchSpec({ id: 'p-00000001', execPath: 'electron.exe', packaged: false, appPath: 'C:\\app', env: { CLAUDE_BROWSER_PROFILE: 'C:\\x Profiles\\p-1', ELECTRON_RUN_AS_NODE: '1', KEEP: 'y' }, test: true, base: 'C:\\x' });
check('a development launch passes the app folder and the switch', spec.command === 'electron.exe' && spec.args.join(' ') === 'C:\\app --lumen-profile=p-00000001', JSON.stringify(spec.args));
check('...a test child finds the same base folder, and never runs as plain node', spec.env.CLAUDE_BROWSER_PROFILE === 'C:\\x' && !('ELECTRON_RUN_AS_NODE' in spec.env) && spec.env.KEEP === 'y', JSON.stringify(spec.env));
check('a packaged launch passes only the switch', P.launchSpec({ id: 'p-1', execPath: 'Lumen.exe', packaged: true }).args.join(' ') === '--lumen-profile=p-1', '');

// ---- is a profile running (macOS / Linux lock link)
check('lockHolderAlive: no lock -> false', P.lockHolderAlive(tmp) === false, '');
const fakeFs = (target) => ({ readlinkSync: () => target });
check('lockHolderAlive: a live pid -> true', P.lockHolderAlive('d', { fs: fakeFs('host-4242'), kill: () => true }) === true, '');
check('lockHolderAlive: a dead pid -> false', P.lockHolderAlive('d', { fs: fakeFs('host-4242'), kill: () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; } }) === false, '');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
