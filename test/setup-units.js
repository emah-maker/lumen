// First run and default browser (features/setup.js): who sees the welcome, how it ends, and reading Windows' choice.
const assert = require('assert');
const { create, progIdIs, PROG_ID } = require('../src/features/setup');

function make({ fresh, settings = {} }) {
  let s = { ...settings };
  const setup = create({
    app: { isDefaultProtocolClient: () => false },
    shell: { openExternal: async () => {} },
    readSettings: () => ({ ...s }),
    writeSettings: (next) => { s = { ...next }; },
    importer: { detectBrowsers: () => [{ id: 'chrome', label: 'Chrome' }] },
    importBrowser: (id) => { if (id !== 'chrome') throw new Error('No such browser'); return { label: 'Chrome', bookmarks: 1, history: 2 }; },
    freshInstall: () => fresh,
  });
  return { setup, get: () => s };
}

(async () => {
  // A fresh install sees the welcome, and again after a quit halfway, until it's done.
  const a = make({ fresh: true });
  assert.strictEqual(a.setup.welcomePending(), true);
  assert.strictEqual(a.get().welcome, 'pending');
  assert.strictEqual(a.setup.welcomePending(), true, 'still pending on the next launch');
  a.setup.welcomeDone();
  assert.strictEqual(a.get().welcome, 'done');
  assert.strictEqual(a.setup.welcomePending(), false);

  // Someone who already used Lumen never sees it.
  const b = make({ fresh: false, settings: { model: 'x' } });
  assert.strictEqual(b.setup.welcomePending(), false);
  assert.strictEqual(b.get().welcome, undefined, 'nothing written for existing users');

  // Import answers the page (no dialog), failures included.
  assert.deepStrictEqual(await a.setup.importFrom('chrome'), { ok: true, label: 'Chrome', bookmarks: 1, history: 2 });
  assert.deepStrictEqual(await a.setup.importFrom('nope'), { ok: false, error: 'No such browser' });

  // Windows' answer to `reg query … /v ProgId`.
  const out = (id) => `\r\nHKEY_CURRENT_USER\\Software\\...\\UserChoice\r\n    ProgId    REG_SZ    ${id}\r\n\r\n`;
  assert.strictEqual(progIdIs(out(PROG_ID), PROG_ID), true);
  assert.strictEqual(progIdIs(out('ChromeHTML'), PROG_ID), false);
  assert.strictEqual(progIdIs(out(`${PROG_ID}Old`), PROG_ID), false, 'the whole value, not a prefix');
  assert.strictEqual(progIdIs(null, PROG_ID), false);

  // The default-browser registration on Windows, against a fake registry (CI runs on Linux; nothing real is written).
  const cp = require('child_process');
  const realExecFile = cp.execFile;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realExecPath = process.execPath;
  const registry = new Map(); // 'KEY|name' -> data ('' name: the default value)
  const ran = [];
  cp.execFile = (file, args, opts, cb) => {
    ran.push([file, ...args]);
    if (file !== 'reg') { cb(null, ''); return {}; }
    const name = args.includes('/v') ? args[args.indexOf('/v') + 1] : '';
    if (args[0] === 'add') { registry.set(`${args[1]}|${name}`, args[args.indexOf('/d') + 1]); cb(null, 'The operation completed successfully.'); return {}; }
    const data = registry.get(`${args[1]}|${name}`);
    if (data === undefined) cb(new Error('ERROR: The system was unable to find the specified registry key or value.'), '');
    else cb(null, `\r\n${args[1]}\r\n    (Default)    REG_SZ    ${data}\r\n\r\n`);
    return {};
  };
  const client = 'HKCU\\Software\\Clients\\StartMenuInternet\\Lumen\\shell\\open\\command|';
  const progId = `HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command|`;
  const lumenExe = 'C:\\Users\\someone\\AppData\\Local\\Programs\\Lumen\\Lumen.exe';
  const packaged = (isPackaged) => create({ app: { isPackaged }, shell: { openExternal: async () => {} }, readSettings: () => ({}), writeSettings: () => {}, importer: {}, importBrowser: () => {}, freshInstall: () => false });
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    // node.exe (a script or test) is never made the program Windows sends links to.
    process.execPath = 'C:\\Program Files\\nodejs\\node.exe';
    assert.strictEqual((await packaged(true).makeDefault()).ok, false, 'node.exe refused');
    assert.strictEqual(registry.size, 0, 'nothing registered for node.exe');

    process.execPath = lumenExe;
    // Never registered: startup creates nothing.
    assert.strictEqual(await packaged(true).repairRegistration(), false);
    assert.strictEqual(registry.size, 0, 'a registration the user never made is not created');

    // Left pointing at node.exe (what a test run once wrote): rewritten to this Lumen.exe, and Explorer told.
    registry.set(client, '"C:\\Program Files\\nodejs\\node.exe"');
    registry.set(progId, '"C:\\Program Files\\nodejs\\node.exe" "%1"');
    assert.strictEqual(await packaged(true).repairRegistration(), true);
    assert.strictEqual(registry.get(client), `"${lumenExe}"`);
    assert.strictEqual(registry.get(progId), `"${lumenExe}" "%1"`);
    assert.ok(/icon\.ico$/.test(registry.get('HKCU\\Software\\Clients\\StartMenuInternet\\Lumen\\DefaultIcon|')), 'the icon is Lumen\'s .ico');
    assert.ok(ran.some((a) => a[0] === 'powershell.exe' && /SHChangeNotify/.test(a[a.length - 1])), 'icons redrawn');

    // Already right: nothing written.
    const writes = ran.filter((a) => a[1] === 'add').length;
    assert.strictEqual(await packaged(true).repairRegistration(), false);
    assert.strictEqual(ran.filter((a) => a[1] === 'add').length, writes, 'no writes when it is already this exe');

    // A dev run (not packaged) never touches it.
    registry.set(client, '"C:\\Old\\Lumen.exe"');
    assert.strictEqual(await packaged(false).repairRegistration(), false);
    assert.strictEqual(registry.get(client), '"C:\\Old\\Lumen.exe"');
  } finally {
    cp.execFile = realExecFile;
    Object.defineProperty(process, 'platform', realPlatform);
    process.execPath = realExecPath;
  }

  console.log('setup units: all passed');
})().catch((err) => { console.error(err); process.exit(1); });
