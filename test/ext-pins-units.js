// The toolbar's extension buttons (pins), the parts that need no window: which extensions start pinned, pin and unpin, order, where each one
// shows in each of the three modes, the puzzle button's dot, the settings' validation, and that it is wired through (strings, channels,
// settings row, bundles). The window itself is test/hide-extensions.js.
const fs = require('fs');
const path = require('path');
const core = require('../src/renderer/ext-pins-core');
const backend = require('../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const id = (n) => String.fromCharCode(97 + (n % 16)).repeat(31) + String.fromCharCode(97 + Math.floor(n / 16) % 16); // 32 letters a-p
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(id);
const J = (v) => JSON.stringify(v);

// ---- migration: what was installed before pins existed starts pinned, whatever the count
const old = core.reconcile(core.clean(null), [A, B, C, D, E]);
check('migration: every extension installed before pins existed starts pinned, in its current order', J(old.order) === J([A, B, C, D, E]) && old.migrated === false, J(old));
const done = core.reconcile(core.clean(null), [A, B, C, D, E], true);
check('migration: once the installed ones have loaded the state is marked migrated, and keeps the five pinned', done.migrated === true && J(done.order) === J([A, B, C, D, E]), J(done));
check('migration: an extension installed after it follows the three-pinned rule (goes to the menu)', J(core.reconcile(done, [A, B, C, D, E, id(6)]).order) === J([A, B, C, D, E]) && core.reconcile(done, [A, B, C, D, E, id(6)]).seen.length === 6);
check('migration: with a few installed before, a later one still starts pinned while fewer than three are', J(core.reconcile(core.reconcile(core.clean(null), [A], true), [A, B, C, D]).order) === J([A, B, C]));
check('migration: a fresh install (nothing installed yet) is migrated, and the first extensions then start pinned', core.reconcile(core.clean(null), [], true).migrated === true);
check('migration: a state saved without the mark, and one with junk for it, are not migrated', core.clean({ order: [A] }).migrated === false && core.clean({ migrated: 'yes' }).migrated === false);
check('migration: moving and pinning keep the mark', core.move(done, B, A).migrated === true && core.nudge(done, B, 1).migrated === true && core.setPinned(done, B, false).migrated === true);

// ---- defaults: a new extension (installed after the migration) starts pinned while fewer than three are
const M = core.clean({ migrated: true });
let s = core.reconcile(M, [A, B]);
check('defaults: the first extensions start pinned', J(s.order) === J([A, B]) && J(s.seen) === J([A, B]), J(s));
s = core.reconcile(s, [A, B, C, D, E]);
check('defaults: three pinned, then new ones start in the menu', J(s.order) === J([A, B, C]) && s.seen.length === 5, J(s));
check('defaults: reconciling again changes nothing', J(core.reconcile(s, [A, B, C, D, E])) === J(s));
check('defaults: an unpinned extension stays unpinned when a pinned one is gone', J(core.reconcile(core.setPinned(s, A, false), [B, C, D, E]).order) === J([B, C]));
s = core.setPinned(core.reconcile(M, [A, B, C]), A, false);
check('defaults: a slot freed by unpinning is not refilled by an extension seen before', J(core.reconcile(s, [A, B, C]).order) === J([B, C]));
check('defaults: a new extension takes the freed slot', J(core.reconcile(s, [A, B, C, D]).order) === J([B, C, D]));
check('defaults: an extension still loading (not installed yet) keeps its pin and place', J(core.reconcile({ order: [A, B], seen: [A, B] }, [B]).order) === J([A, B]));
check('defaults: nothing at all is an empty, valid state', J(core.clean(undefined)) === '{"order":[],"seen":[],"migrated":false}' && J(core.clean('x')) === '{"order":[],"seen":[],"migrated":false}');
check('defaults: junk ids are dropped, duplicates collapse, pinned ids are always seen', J(core.clean({ order: [A, A, 'nope', 5, B], seen: ['x'] })) === J({ order: [A, B], seen: [A, B], migrated: false }), J(core.clean({ order: [A, A, 'nope', B] })));
check('defaults: the list is capped', core.clean({ order: Array.from({ length: 500 }, (_, i) => id(i)) }).order.length <= 200);

// ---- pin, unpin, order
s = core.reconcile(M, [A, B, C, D]);
check('pin: a newly pinned extension goes to the end of the row', J(core.setPinned(s, D, true).order) === J([A, B, C, D]));
check('pin: unpinning removes it but remembers it was seen', J(core.setPinned(s, B, false)) === J({ order: [A, C], seen: [A, B, C, D], migrated: true }), J(core.setPinned(s, B, false)));
check('pin: pinning twice keeps one', core.setPinned(core.setPinned(s, D, true), D, true).order.filter((x) => x === D).length === 1);
check('pin: a bad id changes nothing', J(core.setPinned(s, 'zzz', true)) === J(s));
check('order: move before another', J(core.move(s, C, A).order) === J([C, A, B]));
check('order: move to the end', J(core.move(s, A, null).order) === J([B, C, A]) && J(core.move(s, A, D).order) === J([B, C, A]));
check('order: moving an unpinned one does nothing', J(core.move(s, D, A)) === J(s));
check('order: Alt+Right / Alt+Left move one step, and stop at the ends', J(core.nudge(s, A, 1).order) === J([B, A, C]) && J(core.nudge(s, C, -1).order) === J([A, C, B]) && J(core.nudge(s, A, -1)) === J(s) && J(core.nudge(s, C, 1)) === J(s));

// ---- where each shows
const L = (mode, st = s, have = [A, B, C, D]) => core.layout(st, mode, have);
check('mode pinned: the pinned ones in the toolbar, the others in the menu, the puzzle button always there', J(L('pinned')) === J({ toolbar: [A, B, C], menu: [D], puzzle: 'always', mode: 'pinned' }), J(L('pinned')));
check('mode pinned: the toolbar follows the pinned order', J(L('pinned', core.move(s, C, A)).toolbar) === J([C, A, B]));
check('mode all: everything is in the toolbar, pinned first; the puzzle button only if there is no room', J(L('all')) === J({ toolbar: [A, B, C, D], menu: [], puzzle: 'overflow', mode: 'all' }) && J(L('all', core.setPinned(s, A, false)).toolbar) === J([B, C, A, D]));
check('mode none: no toolbar buttons and no puzzle button; the extensions are still listed for the menus', J(L('none')) === J({ toolbar: [], menu: [A, B, C, D], puzzle: 'never', mode: 'none' }), J(L('none')));
check('layout: no extension with a button means no puzzle button in any mode', ['pinned', 'all', 'none'].every((m) => L(m, s, []).puzzle === 'never'));
check('layout: an unknown mode is the default one', J(L('sideways')) === J(L('pinned')) && core.cleanMode(undefined) === 'pinned');
check('layout: a pin for an extension that is not installed is skipped', J(L('pinned', { order: [E, A], seen: [E, A] }).toolbar) === J([A]));

// ---- the puzzle button's dot
const lay = L('pinned');
check('dot: an extension in the menu with a badge', core.needsAttention(lay, [D]) === true);
check('dot: a badge on a pinned one is already visible: no dot', core.needsAttention(lay, [A]) === false);
check('dot: no badge, no dot', core.needsAttention(lay, []) === false);
check('dot: with no puzzle button (Hide all) there is no dot', core.needsAttention(L('none'), [D]) === false);

// ---- settings
check('settings: the mode takes the three choices only', ['pinned', 'all', 'none'].every((m) => backend.validate('extensionsToolbar', m) === m) && backend.validate('extensionsToolbar', 'some') === null && backend.validate('extensionsToolbar', true) === null);
check('settings: the defaults are Only the ones I pin and nothing pinned', backend.DEFAULTS.extensionsToolbar === 'pinned' && J(backend.DEFAULTS.extensionPins) === '{"order":[],"seen":[],"migrated":false}');
for (const sample of [{ order: [A, B], seen: [C] }, { order: [A, A, 'x'], seen: 'y' }, { order: [B], migrated: true }, {}, { order: Array.from({ length: 300 }, (_, i) => id(i)), seen: [] }]) {
  check(`settings: the saved pins are checked as the rules check them (${J(sample).slice(0, 40)})`, J(backend.validate('extensionPins', sample)) === J(core.clean(sample)));
}
check('settings: pins that are not an object are refused', backend.validate('extensionPins', 'a') === null && backend.validate('extensionPins', null) === null);

// ---- wiring
const en = JSON.parse(read('src/locales/en.json'));
for (const key of ['extension.pinToToolbar', 'extension.showInToolbar', 'extension.manage', 'toolbar.extensionsAttention', 'toolbar.moreExtensions']) check(`strings: ${key}`, typeof en[key] === 'string' && en[key].length > 0);
const main = read('src/main.js');
const preload = read('src/preload/preload.js');
const backendSrc = read('src/settings/settings-backend.js');
check('channels: the toolbar\'s two calls are UI-only', /'ext:pins-sync', 'ext:pins-order'/.test(main) && preload.includes("'ext:pins-sync'") && preload.includes("'ext:pins-order'"));
check('migration: main.js tells the backend when the installed extensions have loaded', /settingsBackend.extensionsLoaded()/.test(main) && backendSrc.includes('extensionsLoaded'));
check('startup: the pin rules load when a pin changes, not at startup', !/^const .*require\('\.\.\/renderer\/ext-pins-core'\)/m.test(backendSrc) && backendSrc.includes("() => require('../renderer/ext-pins-core')"));
check('settings page: the mode row and the per-extension switches', read('src/renderer/settings.js').includes("select('extensionsToolbar'") && read('src/renderer/settings.js').includes('Show in toolbar'));
check('bundles: the toolbar script is in the UI bundle, the preload bundle stays small', read('src/renderer/ui.bundle.js').includes('extPinsCore') && read('src/renderer/ui.bundle.js').includes('drop-before') && fs.statSync(path.join(__dirname, '..', 'src/preload/preload.bundle.js')).size <= 40 * 1024);
check('the toolbar button is named Extensions', /id="actions-overflow"[^>]*aria-label="Extensions"/.test(read('src/renderer/index.src.html')));

process.exit(failures ? 1 : 0);
