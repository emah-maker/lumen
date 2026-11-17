// [managed storage] preload/extensions-mv2-preload.js: Electron answered chrome.storage.managed with the extension's local storage, and
// uBlock Origin saves what it gets under `cachedManagedStorage` at every start, so its storage doubled each launch until a ~1 GB value
// ran Lumen out of memory a minute after every start (2026-11-17). The preload runs here in a vm with a fake MV2 background page.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload', 'extensions-mv2-preload.js'), 'utf8');

// A page like Electron 44 gives an MV2 extension: managed.get hands back the local area's contents.
function page({ manifestVersion = 2, contextIsolated = false, url = 'chrome-extension://abc/background.html' } = {}) {
  const store = { cachedManagedStorage: { big: 'x'.repeat(1000) }, selectedFilterLists: ['easylist'] };
  const removed = [];
  const area = (data) => ({
    get: (keys, cb) => { const v = { ...data }; if (typeof cb === 'function') { cb(v); return undefined; } return Promise.resolve(v); },
    set: (items) => { Object.assign(data, items); return Promise.resolve(); },
    remove: (key) => { removed.push(key); delete data[key]; return Promise.resolve(); },
  });
  const ev = { addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false };
  const local = area(store);
  const chrome = {
    runtime: { id: 'abc', getManifest: () => ({ manifest_version: manifestVersion }), onMessage: ev, onConnect: ev },
    tabs: { removeCSS() {}, onRemoved: ev },
    storage: { local, sync: local, managed: area(store), onChanged: ev },
  };
  const ctx = { chrome, process: { contextIsolated }, location: { href: url }, console, setTimeout, Promise, require };
  ctx.globalThis = ctx;
  vm.runInNewContext(SRC, ctx);
  return { ctx, store, removed, local };
}

(async () => {
  const { ctx, store, removed, local } = page();
  const api = ctx.chrome;
  check('managed.get (promise) is empty', JSON.stringify(await api.storage.managed.get()) === '{}');
  const viaCallback = await new Promise((resolve) => api.storage.managed.get(null, resolve));
  check('managed.get (callback) is empty', JSON.stringify(viaCallback) === '{}', JSON.stringify(viaCallback));
  check('browser gives the same storage', ctx.browser.storage.managed === api.storage.managed);
  check('local storage is untouched', api.storage.local === local && (await api.storage.local.get()).selectedFilterLists[0] === 'easylist');
  check('sync and onChanged still there', api.storage.sync === local && typeof api.storage.onChanged.addListener === 'function');
  check('a copy left from before is dropped', removed.includes('cachedManagedStorage') && !('cachedManagedStorage' in store), JSON.stringify(removed));
  let rejected = false;
  try { await api.storage.managed.set({ a: 1 }); } catch { rejected = true; }
  check('managed is read-only', rejected);

  // uBlock Origin's own steps (vapi-background.js adminStorage), start after start: the cached copy must not grow.
  const ublockStart = async () => {
    const managedNow = await api.storage.managed.get();
    await api.storage.local.set({ cachedManagedStorage: managedNow || {} });
    return JSON.stringify(await api.storage.local.get()).length;
  };
  const sizes = [];
  for (let i = 0; i < 6; i++) sizes.push(await ublockStart());
  check('uBlock restarts keep its storage the same size', sizes.every((s) => s === sizes[0]), sizes.join(','));

  // Left alone: MV3 pages (context isolation) and ordinary web pages.
  const mv3 = page({ contextIsolated: true });
  check('MV3 (context-isolated) page untouched', !mv3.removed.length);
  const web = page({ url: 'https://example.com/' });
  check('a web page untouched', !web.removed.length);

  console.log(failures ? `\n${failures} failed` : '\nall mv2-managed-storage checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
