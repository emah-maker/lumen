// File-type icons on Windows (features/instance.js fixAssociationIcons, features/setup.js registrationIcon).
// Lumen.exe is Electron's untouched binary (Smart App Control trusts it; an exe edited with rcedit is blocked, see
// scripts/build.js), so its own icon resource is Electron's atom. Everything that shows Lumen's icon in Explorer
// (PDF/HTML/SVG file icons, Default apps) must therefore name the shipped assets/icon.ico, never `Lumen.exe,0`.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const instance = require('../src/features/instance');
const ICO = path.join(root, 'src', 'assets', 'icon.ico');
const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\Lumen\\Lumen.exe';

// The shipped icon is a real multi-size .ico (what Explorer needs at every zoom level).
const ico = fs.readFileSync(ICO);
assert.strictEqual(ico.readUInt16LE(0), 0);
assert.strictEqual(ico.readUInt16LE(2), 1, 'an icon file');
const sizes = [];
for (let i = 0; i < ico.readUInt16LE(4); i++) sizes.push(ico[6 + i * 16] || 256);
for (const want of [16, 24, 32, 48, 64, 128, 256]) assert.ok(sizes.includes(want), `icon.ico has a ${want}px image (has ${sizes})`);
assert.strictEqual(instance.appIcon(), ICO, 'appIcon() is the shipped assets/icon.ico');

// The exe stays untouched, so the fix cannot be an icon resource: the build must keep skipping rcedit.
assert.strictEqual(pkg.build.win.signAndEditExecutable, false, 'signAndEditExecutable stays false (Smart App Control)');

// Every file type the installer registers is covered, plus Lumen's own ProgID.
const names = pkg.build.fileAssociations.map((a) => a.name);
for (const n of names) assert.ok(instance.ASSOCIATION_PROG_IDS.includes(n), `ProgID "${n}" is fixed up at startup`);
assert.ok(instance.ASSOCIATION_PROG_IDS.includes(require('../src/features/setup').PROG_ID));

// A fake `reg`: query reads the map, add writes it.
function fakeReg(initial) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const key = args[1].toLowerCase();
    if (args[0] === 'query') {
      for (const [k, v] of store) if (k.toLowerCase() === key) return `\r\n${args[1]}\r\n    (Default)    REG_SZ    ${v}\r\n\r\n`;
      return null;
    }
    store.set(args[1], args[args.indexOf('/d') + 1]);
    return 'The operation completed successfully.';
  };
  return { run, store, calls };
}
const C = 'HKCU\\Software\\Classes\\';
const open = (exe) => `"${exe}" "%1"`;

(async () => {
  // Installer's registration: DefaultIcon is Lumen.exe,0 (Electron's atom). Ours gets rewritten, a foreign one does not.
  const reg = fakeReg({
    [`${C}PDF Document\\shell\\open\\command`]: open(EXE),
    [`${C}PDF Document\\DefaultIcon`]: `${EXE},0`,
    [`${C}HTML Document\\shell\\open\\command`]: open(EXE),
    [`${C}HTML Document\\DefaultIcon`]: `${EXE},0`,
    [`${C}SVG Image\\shell\\open\\command`]: open('C:\\Program Files\\Other\\other.exe'),
    [`${C}SVG Image\\DefaultIcon`]: 'C:\\Program Files\\Other\\other.exe,0',
  });
  let changed = await instance.fixAssociationIcons(EXE, ICO, reg.run);
  assert.deepStrictEqual(changed.sort(), ['HTML Document', 'PDF Document']);
  assert.strictEqual(reg.store.get(`${C}PDF Document\\DefaultIcon`), ICO);
  assert.strictEqual(reg.store.get(`${C}HTML Document\\DefaultIcon`), ICO);
  assert.strictEqual(reg.store.get(`${C}SVG Image\\DefaultIcon`), 'C:\\Program Files\\Other\\other.exe,0', "another app's icon is left alone");
  assert.ok(!reg.store.has(`${C}LumenHTML\\DefaultIcon`), 'a ProgID that does not exist is not created');

  // Second run: nothing to do, nothing written (so no icon-cache notification either).
  const writes = () => reg.calls.filter((c) => c[0] === 'add').length;
  const before = writes();
  changed = await instance.fixAssociationIcons(EXE, ICO, reg.run);
  assert.deepStrictEqual(changed, []);
  assert.strictEqual(writes(), before);

  // A failed write is not reported as changed.
  const failing = fakeReg({ [`${C}PDF Document\\shell\\open\\command`]: open(EXE) });
  assert.deepStrictEqual(await instance.fixAssociationIcons(EXE, ICO, async (a) => (a[0] === 'add' ? null : failing.run(a))), []);

  // The icon-cache refresh is SHChangeNotify(SHCNE_ASSOCCHANGED = 0x08000000), run through PowerShell.
  let ran = null;
  instance.notifyAssociationsChanged((file, args) => { ran = { file, script: args[args.length - 1] }; });
  assert.strictEqual(ran.file, 'powershell.exe');
  assert.ok(/SHChangeNotify\(0x08000000,/.test(ran.script) && /shell32\.dll/.test(ran.script));

  // setup.js: every DefaultIcon / ApplicationIcon it writes is the shipped .ico, not Lumen.exe,0.
  const cp = require('child_process');
  const writesSeen = [];
  const realExecFile = cp.execFile;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realExecPath = process.execPath;
  Object.defineProperty(process, 'platform', { value: 'win32' }); // (CI runs on Linux)
  process.execPath = 'C:\\Users\\someone\\AppData\\Local\\Programs\\Lumen\\Lumen.exe'; // (setup.js never registers node.exe)
  cp.execFile = (file, args, opts, cb) => { writesSeen.push(args); cb(null, ''); };
  try {
    delete require.cache[require.resolve('../src/features/setup')]; // (its execFile is bound at load)
    const { create } = require('../src/features/setup');
    const setup = create({ app: {}, shell: { openExternal: async () => {} }, readSettings: () => ({}), writeSettings: () => {}, importer: {}, importBrowser: () => {}, freshInstall: () => false });
    const result = await setup.makeDefault();
    assert.strictEqual(result.ok, true);
  } finally { cp.execFile = realExecFile; Object.defineProperty(process, 'platform', realPlatform); process.execPath = realExecPath; }
  const icons = writesSeen.filter((a) => a[0] === 'add' && /DefaultIcon$/.test(a[1]) || (a[0] === 'add' && a.includes('ApplicationIcon')));
  assert.strictEqual(icons.length, 3, 'LumenHTML DefaultIcon, the client DefaultIcon, and Capabilities ApplicationIcon');
  for (const a of icons) {
    const value = a[a.indexOf('/d') + 1];
    assert.strictEqual(path.basename(value), 'icon.ico', `${a[1]} names icon.ico, not the exe (${value})`);
    assert.ok(fs.existsSync(value), `${value} exists`);
    assert.ok(!/\.exe/i.test(value));
  }
  console.log('assoc-icons-units: ok');
})().catch((e) => { console.error(e); process.exit(1); });
