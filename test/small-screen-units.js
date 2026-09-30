// Plain Node checks for the ⋯ menu's small-screen layout (features/app-menu-layout.js): which
// sections fold into submenus as the space below the button shrinks, that every command stays
// reachable, and where the menu is anchored. Run from test/units.js.
const L = require('../src/features/app-menu-layout');

module.exports = function smallScreenUnits(check) {
  // A menu shaped like main.js showAppMenu's, with made-up commands.
  const item = (label, accelerator) => ({ label, ...(accelerator ? { accelerator } : {}) });
  const n = (prefix, count) => Array.from({ length: count }, (_, i) => item(`${prefix} ${i + 1}`, i % 2 ? 'CmdOrCtrl+Shift+X' : ''));
  const chunk = (items, id, order) => ({ items, fold: id ? { id, label: `[${id}]`, order } : null });
  const groups = () => [
    [chunk(n('core', 2)), chunk(n('tabs', 3), 'tabs', 4), chunk(n('ai', 5), 'ai', 5)],
    [chunk([item('Find', 'CmdOrCtrl+F')]), chunk(n('zoom', 4), 'zoom', 3), chunk(n('page', 7), 'page', 2)],
    [chunk([{ label: 'Bookmarks', submenu: [item('b')] }, { label: 'History', submenu: [item('h')] }])],
    [chunk(n('more', 5), 'more', 1), chunk([item('Settings', 'CmdOrCtrl+,')])],
    [chunk([item('Developer Tools', 'F12')], 'more', 1)],
  ];
  const leaves = (template) => template.flatMap((i) => (i.submenu ? [i.label, ...leaves(i.submenu)] : i.type === 'separator' ? [] : [i.label]));
  const commands = (template) => leaves(template).filter((l) => !/^\[/.test(l)).sort();
  const everything = commands(L.toTemplate(groups()));

  const tall = L.fold(groups(), 2000);
  check('app menu: a tall window keeps the menu flat', tall.folded.length === 0 && !tall.template.some((i) => /^\[/.test(i.label || '')), JSON.stringify(tall.folded));
  check('app menu: the flat menu has a separator between groups and none doubled or at the ends',
    tall.template.filter((i) => i.type === 'separator').length === 4 && tall.template[0].type !== 'separator' && tall.template.at(-1).type !== 'separator'
      && !tall.template.some((i, k) => i.type === 'separator' && tall.template[k + 1]?.type === 'separator'));

  // 1280x720 at 150%: 480 DIPs tall, less a 48px taskbar and ~80px of tab strip and toolbar.
  const short = L.fold(groups(), L.availableBelow({ anchorY: 80, windowBottom: 432, workAreaBottom: 432 }));
  check('app menu: on a 1280x720 screen at 150% it fits below the button', L.estimateHeight(short.template) <= 348, `${L.estimateHeight(short.template)} ${JSON.stringify(short.folded)}`);
  check('app menu: least-used sections fold first (More Tools, then the page commands)', short.folded[0] === 'more' && short.folded[1] === 'page', JSON.stringify(short.folded));
  check('app menu: folding keeps every command reachable', JSON.stringify(commands(short.template)) === JSON.stringify(everything), JSON.stringify(commands(short.template)));
  const more = short.template.find((i) => i.label === '[more]');
  check('app menu: chunks of one id merge into one submenu, separated, where the first one was',
    more && more.submenu.length === 7 && more.submenu[5].type === 'separator' && more.submenu[6].label === 'Developer Tools'
      && short.template.indexOf(more) < short.template.findIndex((i) => i.label === 'Settings'), JSON.stringify(more));
  check('app menu: a folded group left empty leaves no stray separator', short.template.at(-1).type !== 'separator'
    && !short.template.some((i, k) => i.type === 'separator' && short.template[k + 1]?.type === 'separator'));
  check('app menu: accelerator labels survive folding', short.template.find((i) => i.label === '[page]')?.submenu.some((i) => i.accelerator === 'CmdOrCtrl+Shift+X'));

  const tiny = L.fold(groups(), 120);
  check('app menu: with no room, everything foldable folds (and it still opens)', tiny.folded.length === 5 && tiny.template.length > 0, JSON.stringify(tiny.folded));
  check('app menu: fully folded, still every command', JSON.stringify(commands(tiny.template)) === JSON.stringify(everything));
  check('app menu: an unknown space (NaN) folds nothing', L.fold(groups(), NaN).folded.length === 0);
  const single = L.toTemplate([[chunk([item('Only')], 'x', 1)]], new Set(['x']));
  check('app menu: a folded section of one command stays a plain row', single.length === 1 && single[0].label === 'Only' && !single[0].submenu, JSON.stringify(single));
  check('app menu: empty sections (e.g. background tasks off) disappear', L.toTemplate([[chunk([])], [chunk([item('a')])]]).length === 1);

  // Width and anchor.
  const w = L.estimateWidth([item('Make Lumen Your Default Browser…'), item('New Tab', 'CmdOrCtrl+Shift+N'), { label: 'Bookmarks', submenu: [] }]);
  check('app menu: width estimate grows with the longest label and accelerator', w > L.estimateWidth([item('New Tab')]) && w > 300 && w < 600, String(w));
  check('app menu: a right-side button right-aligns the menu to it', L.anchorX({ left: 1380, right: 1410, contentWidth: 1440, menuWidth: 300 }) === 1110);
  check('app menu: the menu never starts left of the window', L.anchorX({ left: 700, right: 730, contentWidth: 800, menuWidth: 900 }) === 0);
  check('app menu: nor runs past its right edge', L.anchorX({ left: 100, right: 130, contentWidth: 800, menuWidth: 300 }) === 100
    && L.anchorX({ left: 600, right: 790, contentWidth: 800, menuWidth: 100 }) === 690);
  check('app menu: a button on the left (right-to-left layout) opens from its left edge', L.anchorX({ left: 8, right: 38, contentWidth: 800, menuWidth: 300 }) === 8);
  const en = require('../src/locales/en.json');
  check('app menu: the submenu names are in locales/en.json', ['menu.moreTools', 'menu.thisPage', 'menu.zoom', 'menu.tabsAndFiles', 'menu.aiAndTasks'].every((k) => typeof en[k] === 'string' && en[k]));
  check('app menu: the space below is bounded by the window and by the work area',
    L.availableBelow({ anchorY: 100, windowBottom: 600, workAreaBottom: 1040 }) === 496 && L.availableBelow({ anchorY: 100, windowBottom: 1200, workAreaBottom: 1040 }) === 936);
};
