// Tab layout: Side, the parts that need no window: the saved width and fold, where a dragged tab would land in the list (rows and pinned
// tiles), which group it joins, the settings' validation, and that the layout is wired through (settings row, docs row, strings, UI
// channels, bundle, the setting reaching every window).
const fs = require('fs');
const path = require('path');
const core = require('../../src/renderer/side-tabs-core');
const backend = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

// ---- width and settings
check('width: kept between the minimum and the maximum', core.clampWidth(10) === core.MIN && core.clampWidth(9999) === core.MAX && core.clampWidth(300) === 300);
check('width: a rounded whole number; nonsense is the default', core.clampWidth(240.6) === 241 && core.clampWidth('abc') === core.DEFAULT && core.clampWidth(undefined) === core.DEFAULT);
check('prefs: Top is the default (no settings at all, or top)', !core.fromPrefs(null).on && !core.fromPrefs({}).on && !core.fromPrefs({ tabLayout: 'top' }).on);
check('prefs: Side with its width and fold', JSON.stringify(core.fromPrefs({ tabLayout: 'side', sideTabsWidth: 300, sideTabsCollapsed: true })) === '{"on":true,"width":300,"collapsed":true}');
check('prefs: anything but side is top; a fold must be exactly true', !core.fromPrefs({ tabLayout: 'left' }).on && core.fromPrefs({ tabLayout: 'side', sideTabsCollapsed: 'yes' }).collapsed === false);
check('settings: tabLayout accepts top and side only', backend.validate('tabLayout', 'side') === 'side' && backend.validate('tabLayout', 'top') === 'top' && backend.validate('tabLayout', 'left') === null && backend.validate('tabLayout', 1) === null);
check('settings: the width is clamped to the same range as the list', backend.validate('sideTabsWidth', 1000) === core.MAX && backend.validate('sideTabsWidth', 5) === core.MIN && backend.validate('sideTabsWidth', '280') === 280 && backend.validate('sideTabsWidth', 'x') === null);
check('settings: the fold is a boolean', backend.validate('sideTabsCollapsed', true) === true && backend.validate('sideTabsCollapsed', 'true') === null);
check('settings: defaults are Top, 240, not folded', backend.DEFAULTS.tabLayout === 'top' && backend.DEFAULTS.sideTabsWidth === 240 && backend.DEFAULTS.sideTabsCollapsed === false);
check('settings: the saved default width is the list\'s default', backend.DEFAULTS.sideTabsWidth === core.DEFAULT && backend.DEFAULTS.sideTabsWidth >= core.MIN && backend.DEFAULTS.sideTabsWidth <= core.MAX);

// ---- where a drop lands
const row = (id, top, extra = {}) => ({ id, outside: false, r: { left: 8, right: 248, top, bottom: top + 30 }, ...extra });
const tile = (id, left, top = 0) => ({ id, outside: false, r: { left, right: left + 36, top, bottom: top + 32 } });
const rows = [row(1, 0), row(2, 32), row(3, 64), row(4, 96)];
check('drop: above the middle of a row lands before it', core.dropBefore(rows, 100, 40, 240).id === 2);
check('drop: below the middle of a row lands after it (before the next)', core.dropBefore(rows, 100, 55, 240).id === 3);
check('drop: above the first row is before the first', core.dropBefore(rows, 100, -20, 240).id === 1);
check('drop: below the last row is the end (null)', core.dropBefore(rows, 100, 200, 240) === null);
check('drop: in the gap between two rows lands before the lower', core.dropBefore(rows, 100, 31, 240).id === 2);
check('drop: the sideways position does not matter on full rows', core.dropBefore(rows, 5, 40, 240).id === 2 && core.dropBefore(rows, 900, 40, 240).id === 2);
const tiles = [tile(1, 8), tile(2, 46), tile(3, 84), tile(4, 8, 34)];
check('pinned tiles: left of a tile\'s middle lands before it', core.dropBefore(tiles, 50, 10, 240).id === 2);
check('pinned tiles: right of the middle lands before the next tile', core.dropBefore(tiles, 75, 10, 240).id === 3);
check('pinned tiles: past the end of a row lands before the first tile of the next row', core.dropBefore(tiles, 200, 10, 240).id === 4);
check('pinned tiles: past the last tile is the end', core.dropBefore(tiles, 40, 60, 240) === null);
check('drop: nothing to drop before is the end', core.dropBefore([], 10, 10, 240) === null);
// a label stands for its group's first tab and is outside the group
const mixed = [row(1, 0), row(2, 32, { outside: true }), row(2, 64), row(3, 96)];
check('drop: on a group\'s label lands before the group, outside it', (() => { const h = core.dropBefore(mixed, 100, 40, 240); return h.id === 2 && h.outside === true; })());
check('drop: right under the label lands inside the group', (() => { const h = core.dropBefore(mixed, 100, 70, 240); return h.id === 3 || (h.id === 2 && h.outside === false); })());

// ---- which group it joins
const tabs = [{ id: 1 }, { id: 2, groupId: 7 }, { id: 3, groupId: 7 }, { id: 4 }];
check('join: between a group\'s tabs it joins the group', core.joinGroup({ id: 3, outside: false }, tabs) === 7);
check('join: before a loose tab it joins no group', core.joinGroup({ id: 4, outside: false }, tabs) === null && core.joinGroup({ id: 1, outside: false }, tabs) === null);
check('join: before a group\'s label, or at the end, it joins no group', core.joinGroup({ id: 2, outside: true }, tabs) === null && core.joinGroup(null, tabs) === null);

// ---- no change when let go in place
const all = [row(1, 0), row(2, 32), row(3, 64), row(4, 96)];
check('home: the place after the tab it is dragging', core.homeBefore(all, [2]).id === 3);
check('home: the end when it is the last', core.homeBefore(all, [4]) === null);
check('home: after a whole run (a selection or a group)', core.homeBefore(all, [2, 3]).id === 4);
check('home: a run spread over the list is after the last of it', core.homeBefore(all, [1, 3]).id === 4);
check('home: nothing moving', core.homeBefore(all, []).id === 1);

// ---- wired through
const html = read('src/renderer/index.src.html');
check('markup: the column, its list, head, collapse button and resize edge exist', ['id="side-tabs"', 'id="side-tabs-list"', 'id="side-head"', 'id="side-collapse"', 'id="side-resize"'].every((s) => html.includes(s)));
check('markup: the column is hidden until the setting turns it on', /id="side-tabs"[^>]*\shidden/.test(html));
check('markup: the column comes before the page area in the row', html.indexOf('id="side-tabs"') < html.indexOf('id="viewport"') && html.indexOf('id="side-tabs"') > html.indexOf('<main class="body">'));
check('markup: scripts load after app.js (and the core before it)', (() => { const a = html.indexOf('src="app.js"'); const c = html.indexOf('src="side-tabs-core.js"'); const s = html.indexOf('src="side-tabs.js"'); return a < c && c < s; })());
check('markup: the stylesheet is listed', html.includes('href="side-tabs.css"'));
const bundleJs = read('src/renderer/ui.bundle.js');
check('bundle: the side list is in ui.bundle.js and its stylesheet in ui.bundle.css (rebuild with scripts/build/bundle-renderer.js)', bundleJs.includes('sideTabsCore') && bundleJs.includes('window.sideTabs') && read('src/renderer/ui.bundle.css').includes('.side-tabs'));
const prefs = read('src/renderer/ui-prefs.js');
check('ui prefs: the setting reaches the list through an event', prefs.includes("'tabLayout' in p") && prefs.includes('lumen:side-tabs') && read('src/renderer/side-tabs.js').includes('lumen:side-tabs'));
const be = read('src/settings/settings-backend.js');
check('settings: the three keys go to every window (prefs:ui) and are saved', /tabLayout: p\.tabLayout, sideTabsWidth: p\.sideTabsWidth, sideTabsCollapsed: p\.sideTabsCollapsed/.test(be) && /\['compactTabs', 'tabLayout', 'sideTabsWidth', 'sideTabsCollapsed'/.test(be));
check('settings page: Tab layout is a row (Top / Side) with the icons-only switch', /select\('tabLayout'/.test(read('src/renderer/settings.js')) && /toggle\('sideTabsCollapsed'/.test(read('src/renderer/settings.js')));
const doc = read('docs/settings.md');
check('docs: a row each in docs/settings.md', ['`tabLayout`', '`sideTabsCollapsed`', '`sideTabsWidth`'].every((k) => doc.includes(k)));
const en = JSON.parse(read('src/locales/en.json'));
check('strings: the menu, the button and the list\'s names', ['tabs.layout.menu.side', 'tabs.layout.menu.icons', 'tabs.side.collapse', 'tabs.side.expand', 'tabs.side.label', 'tabs.side.resize'].every((k) => typeof en[k] === 'string' && en[k]));
const main = read('src/main.js');
const preload = read('src/preload/preload.js');
check('main: the strip menu and the side list\'s save are UI-only channels, sent by the preload', /'tabs:strip-menu', 'tabs:side'/.test(main) && preload.includes("'tabs:strip-menu'") && preload.includes("'tabs:side'"));
check('main: the strip menu has the layout switch, and icons only while the list is on', /label: t\('tabs\.layout\.menu\.side'\)/.test(main) && /label: t\('tabs\.layout\.menu\.icons'\)/.test(main));
check('main: a side list is not a strip another window\'s tab can be dropped on', main.includes("document.body.classList.contains('side-layout')"));
const app = read('src/renderer/app.js');
check('app: the drag, hand-off, arrow keys and hover card know the side list', app.includes('window.sideTabs.move(e)') && app.includes('window.sideTabs.end(drag, escaped)') && app.includes('ArrowDown: 1, ArrowUp: -1') && /function hoverTab\(el\) \{\s*\n\s*if \(sideTabsOn\(\)\) return;/.test(app));
check('the preload bundle carries the two new calls', read('src/preload/preload.bundle.js').includes('tabs:strip-menu') && read('src/preload/preload.bundle.js').includes('tabs:side'));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
