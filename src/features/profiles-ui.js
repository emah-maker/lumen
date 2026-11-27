// [profiles] The profile menu (⋯ menu → Profiles, and the toolbar's profile button), the Add / Edit editor window and Delete.
// The data side is features/profiles.js; docs/profiles.md has the design. Wired from main.js:
//   deps: { app, ipcMain, Menu, nativeImage, makeWindow(opts) (a BrowserWindow: off screen in a hidden test run),
//           t(key, vars), confirm({ message, detail, okLabel }) -> Promise<bool>, notice({ message, detail }),
//           openNewWindow(), sendAllUis(channel, payload), isUi(event) (the browser UI's own top-level page),
//           pageReady(webContents) (the accent colour on Lumen's own pages), parentWindow(), test,
//           spawn (child_process.spawn), trash(dir) -> Promise (shell.trashItem), editorPaths: { html, preload } }
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles');

function createProfilesUi(deps) {
  const cur = profiles.current() || { id: profiles.DEFAULT_ID, base: deps.app.getPath('userData'), root: profiles.rootFor(deps.app.getPath('userData')), dir: deps.app.getPath('userData') };
  const store = profiles.createStore({ base: cur.base, root: cur.root });
  const t = deps.t;
  const launches = []; // (tests) every profile this process asked to open: { id, command, args }
  const test = { dryRun: false, launches, lastNotice: null };

  const label = (p) => `${p.avatar || profiles.initial(p.name)}  ${p.name}`;
  const self = () => store.get(cur.id) || { id: cur.id, name: 'Default', color: 'blue', avatar: '' };

  // What the toolbar button shows: { id, name, color (hex), avatar, initial, count }.
  function info() {
    let list = [];
    try { list = store.list(); } catch { /* unreadable: this profile alone */ }
    const p = list.find((x) => x.id === cur.id) || self();
    return { id: p.id, name: p.name, color: profiles.colorHex(p.color), avatar: p.avatar, initial: profiles.initial(p.name), count: Math.max(1, list.length) };
  }
  const changed = () => deps.sendAllUis('profile:changed', info());

  // A 16 px dot in the profile's colour for the menu (a native menu can't draw CSS).
  const dots = new Map();
  function dot(hex) {
    if (!deps.nativeImage) return undefined;
    if (dots.has(hex)) return dots.get(hex);
    const size = 16;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const buf = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        const a = Math.max(0, Math.min(1, 6.5 - d)); // a 13 px circle, its edge smoothed over one pixel
        const o = (y * size + x) * 4;
        buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = Math.round(a * 255); // (BGRA)
      }
    }
    let img;
    try { img = deps.nativeImage.createFromBitmap(buf, { width: size, height: size }); } catch { img = undefined; }
    dots.set(hex, img);
    return img;
  }

  // The menu's rows: every profile (this window's checked), then Add, Edit and Delete.
  function menuItems() {
    let list;
    try { list = store.list(); } catch { list = [self()]; }
    const others = list.filter((p) => p.id !== cur.id && p.id !== profiles.DEFAULT_ID);
    return [
      ...list.map((p) => ({ label: label(p), type: 'checkbox', checked: p.id === cur.id, icon: dot(profiles.colorHex(p.color)), click: () => open(p.id) })),
      { type: 'separator' },
      { label: t('profiles.add'), click: () => openEditor(null) },
      { label: t('profiles.edit'), click: () => openEditor(cur.id) },
      { label: t('profiles.delete'), enabled: others.length > 0, submenu: others.length ? others.map((p) => ({ label: label(p), click: () => { remove(p.id).catch(() => {}); } })) : [{ label: t('profiles.delete.none'), enabled: false }] },
    ];
  }

  function popup({ x, y, window }) {
    deps.Menu.buildFromTemplate(menuItems()).popup({ window, x: Math.round(x), y: Math.round(y) });
  }

  // Opens profile `id` in its own window: this profile gets a new window here; another starts (or, already running, brings
  // forward) its own Lumen.
  function open(id) {
    if (id === cur.id) { deps.openNewWindow(); return { here: true }; }
    if (!store.get(id)) return { error: 'missing' };
    const spec = profiles.launchSpec({ id, packaged: deps.app.isPackaged, appPath: deps.app.getAppPath(), test: deps.test, base: cur.base });
    launches.push({ id, command: spec.command, args: spec.args });
    if (test.dryRun) return { spec };
    try {
      const child = deps.spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', env: spec.env, cwd: require('os').homedir(), windowsHide: false });
      child.on?.('error', () => {});
      child.unref?.();
    } catch (err) { return { error: err?.message || String(err) }; }
    return { spec };
  }

  // Add (id null) or edit one profile; the new profile opens once it is made.
  function save(id, fields) {
    if (id) { const p = store.update(id, fields); changed(); return p; }
    const p = store.add(fields);
    watch();
    changed();
    open(p.id);
    return p;
  }

  // Delete: never Default or this window's own profile; asks first; refuses a profile that is running; its folder goes to the
  // Recycle Bin (a test run removes it).
  async function remove(id, { confirmed = false } = {}) {
    const p = store.get(id);
    if (!p || id === profiles.DEFAULT_ID || id === cur.id) return { error: 'not-allowed' };
    if (!confirmed && !(await deps.confirm({ message: t('profiles.delete.confirm', { name: p.name }), detail: t('profiles.delete.detail'), okLabel: t('profiles.delete.ok') }))) return { cancelled: true };
    const dir = store.dirOf(id);
    const busy = () => { const n = { message: t('profiles.delete.busy', { name: p.name }), detail: t('profiles.delete.busyDetail') }; test.lastNotice = n; deps.notice(n); return { error: 'busy' }; };
    if (fs.existsSync(dir)) {
      if (profiles.lockHolderAlive(dir)) return busy();
      // A folder with a running browser in it can't be renamed on Windows: that is the check there, and it takes the folder out of
      // the list's way in one step.
      const gone = path.join(cur.root, `${id}.deleted-${Date.now()}`);
      try { fs.renameSync(dir, gone); } catch { return busy(); }
      store.forget(id);
      try { if (deps.test) fs.rmSync(gone, { recursive: true, force: true }); else await deps.trash(gone); } catch { try { fs.rmSync(gone, { recursive: true, force: true }); } catch { /* left in Lumen Profiles */ } }
    } else store.forget(id);
    changed();
    return { removed: true };
  }

  // ---------- the editor ----------
  let editor = null; // { win, id }
  function openEditor(id) {
    if (editor && !editor.win.isDestroyed()) { editor.win.close(); editor = null; }
    const win = deps.makeWindow({
      width: 440, height: 520, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, show: false,
      parent: deps.parentWindow() || undefined, modal: false, autoHideMenuBar: true, title: t(id ? 'profiles.edit.title' : 'profiles.add.title'),
      backgroundColor: require('electron').nativeTheme?.shouldUseDarkColors ? '#2c2c2e' : '#ffffff',
      webPreferences: { preload: deps.editorPaths.preload, sandbox: true, contextIsolation: true, spellcheck: false },
    });
    win.setMenu?.(null);
    editor = { win, id };
    const ownUrl = require('url').pathToFileURL(deps.editorPaths.html).href;
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('dom-ready', () => deps.pageReady?.(win.webContents));
    win.once('ready-to-show', () => { if (!win.isDestroyed() && !win.isVisible()) win.show(); });
    win.on('closed', () => { if (editor?.win === win) editor = null; });
    win.loadURL(ownUrl).catch(() => {});
    return win;
  }
  const fromEditor = (event) => editor && !editor.win.isDestroyed() && event.sender === editor.win.webContents;
  function editorState() {
    const p = editor?.id ? store.get(editor.id) : null;
    const strings = {};
    for (const k of ['add.title', 'edit.title', 'name', 'name.placeholder', 'color', 'avatar', 'avatar.letter', 'cancel', 'save', 'create', 'preview', 'color.blue', 'color.teal', 'color.green', 'color.yellow', 'color.orange', 'color.red', 'color.pink', 'color.purple', 'color.gray']) strings[k] = t(`profiles.${k}`);
    let used = [];
    try { used = store.list().map((x) => x.color); } catch { /* none */ }
    const fresh = profiles.COLORS.find((c) => !used.includes(c.id))?.id || 'blue';
    return {
      mode: p ? 'edit' : 'add',
      profile: p ? { name: p.name, color: p.color, avatar: p.avatar } : { name: '', color: fresh, avatar: '' },
      colors: profiles.COLORS, avatars: profiles.AVATARS, maxName: profiles.MAX_NAME, strings,
    };
  }

  deps.ipcMain.handle('profile:info', (event) => (deps.isUi(event) ? info() : null));
  deps.ipcMain.on('profile:menu', (event, point) => { if (deps.isUi(event)) popup({ ...(point || {}), window: deps.parentWindow() }); });
  deps.ipcMain.handle('profile-editor:init', (event) => (fromEditor(event) ? editorState() : null));
  deps.ipcMain.handle('profile-editor:save', (event, fields) => {
    if (!fromEditor(event)) return null;
    const f = fields && typeof fields === 'object' ? fields : {};
    const id = editor.id;
    const win = editor.win;
    let out;
    try { out = save(id, { name: f.name, color: f.color, avatar: f.avatar }); } catch (err) { return { error: err?.message || String(err) }; }
    setImmediate(() => { if (!win.isDestroyed()) win.close(); });
    return { ok: true, id: out?.id };
  });
  deps.ipcMain.on('profile-editor:cancel', (event) => { if (fromEditor(event)) editor.win.close(); });

  // Another profile's window changed the list (a rename, a new profile): this one's button follows.
  let watcher = null;
  let soon = null;
  function watch() {
    if (watcher) return;
    try {
      fs.mkdirSync(cur.root, { recursive: true });
      watcher = fs.watch(cur.root, (_ev, name) => {
        if (name && !String(name).startsWith('profiles.json')) return;
        clearTimeout(soon); soon = setTimeout(changed, 150);
      });
      watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; });
      watcher.unref?.();
    } catch { watcher = null; }
  }
  // (Only once there is a list: a Lumen with one profile never makes the Lumen Profiles folder just by running.)
  if (fs.existsSync(cur.root)) watch();
  return {
    current: cur, store, info, menuItems, popup, open, openEditor, remove, save,
    editor: () => editor?.win || null,
    test,
  };
}

module.exports = { createProfilesUi };
