// [uBlock mode] Settings → Privacy and security → Ad blocker (src/features/ublock-mode.js): the switch's order (never no blocker, never both), its failures, and that
// the main session is left with no webRequest listener of any kind. Plain Node (a fake session and fake installer).
const U = require('../../src/features/ublock-mode');
const SB = require('../../src/settings/settings-backend');
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail ?? ''}`}`); if (!ok) failures++; };

// A session.extensions and the deps switchTo() is given, recording the order things happen in.
function world({ installed = false, installFails = false, uninstallFails = false } = {}) {
  const log = [];
  let settings = { adblock: true, adBlocker: installed ? 'ublock' : 'lumen' };
  const loaded = new Set(installed ? [U.UBOL_ID] : []);
  const deps = {
    extensions: { getExtension: (id) => (loaded.has(id) ? { id } : null) },
    install: async (id) => { log.push(`install ${id === U.UBOL_ID ? 'ubol' : id}`); if (installFails) throw new Error('offline'); loaded.add(id); return { id }; },
    uninstall: async (id) => { log.push('uninstall'); if (uninstallFails) throw new Error('busy'); loaded.delete(id); },
    startWorker: async () => { log.push('worker'); },
    pin: async () => { log.push('pin'); },
    readSettings: () => settings,
    writeSettings: (s) => { settings = s; log.push(`write ${s.adBlocker}`); },
    applyHooks: () => { log.push(`hooks ${settings.adBlocker}`); },
    reloadPages: () => { log.push('reload'); },
  };
  return { deps, log, loaded, settings: () => settings };
}

(async () => {
  check('the extension is uBlock Origin Lite on the Chrome Web Store', U.UBOL_ID === 'ddkjiahejlhfcafbddmgiahcphecmpfh');
  check('modeOf: only "ublock" is uBlock mode; anything else (old profiles have no key) is Lumen\'s blocker',
    U.modeOf({ adBlocker: 'ublock' }) === 'ublock' && U.modeOf({}) === 'lumen' && U.modeOf(null) === 'lumen' && U.modeOf({ adBlocker: 'x' }) === 'lumen');
  check('settings: the default is Lumen\'s blocker', SB.DEFAULTS.adBlocker === 'lumen');

  {
    const w = world();
    await U.switchTo('ublock', w.deps);
    check('to uBlock: installed, worker started and button pinned before Lumen steps aside', w.log.join(',') === 'install ubol,worker,pin,write ublock,hooks ublock,reload', w.log.join(','));
    check('to uBlock: the setting is saved', w.settings().adBlocker === 'ublock');
  }
  {
    const w = world({ installed: true });
    w.deps.writeSettings({ ...w.settings(), adBlocker: 'lumen' }); w.log.length = 0; // (installed earlier, e.g. from its store page)
    await U.switchTo('ublock', w.deps);
    check('to uBlock when it is already there: not downloaded again', !w.log.some((l) => l.startsWith('install')) && w.settings().adBlocker === 'ublock', w.log.join(','));
  }
  {
    const w = world({ installFails: true });
    let err = null;
    try { await U.switchTo('ublock', w.deps); } catch (e) { err = e; }
    check('install fails: an error that says so, and nothing switched (Lumen\'s blocker keeps running)', err && /Couldn.t install uBlock Origin Lite: offline/.test(err.message) && w.settings().adBlocker === 'lumen' && !w.log.some((l) => l.startsWith('hooks')), `${err?.message} ${w.log.join(',')}`);
  }
  {
    const w = world({ installed: true });
    await U.switchTo('lumen', w.deps);
    check('back to Lumen: its hooks come back first, then the extension is removed', w.log.join(',') === 'write lumen,hooks lumen,uninstall,reload', w.log.join(','));
    check('back to Lumen: uBlock Origin Lite is gone', !w.loaded.has(U.UBOL_ID));
  }
  {
    const w = world({ installed: true, uninstallFails: true });
    const errors = []; const was = console.error; console.error = (...a) => errors.push(a.join(' '));
    try { await U.switchTo('lumen', w.deps); } finally { console.error = was; }
    check('a removal that fails still leaves Lumen\'s blocker on (logged, not thrown)', w.settings().adBlocker === 'lumen' && errors.some((e) => /removal failed/.test(e)) && w.log.includes('reload'), w.log.join(','));
  }
  {
    let err = null;
    try { await U.switchTo('adguard', world().deps); } catch (e) { err = e; }
    check('an unknown mode is refused', err && /Invalid value/.test(err.message));
  }
  {
    // Electron turns extension rules off while a session has a listener for ANY webRequest event: every one is cleared.
    const cleared = [];
    const ses = { webRequest: Object.fromEntries(U.EVENTS.map((e) => [e, (v) => { if (v === null) cleared.push(e); }])) };
    U.clearListeners(ses);
    check('clearListeners: all eight webRequest events lose their listener', cleared.length === 8 && ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onSendHeaders', 'onCompleted', 'onErrorOccurred'].every((e) => cleared.includes(e)), cleared.join());
    let threw = false;
    try { U.clearListeners({ webRequest: { onBeforeRequest() { throw new Error('destroyed'); } } }); } catch { threw = true; }
    check('clearListeners: a session that is gone does not throw', !threw);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll uBlock mode checks passed.');
  process.exit(failures ? 1 : 0);
})();
