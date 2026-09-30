// New-tab system cards and Edit layout, pure logic (run from test/widget-units.js, or on its own with
// `node test/widget-edit-units.js`): the page's own sections as cards in the widget list (reserved ids,
// checked, docked until moved, migrated from lists that never had them), the browser-side actions
// (layout with a dock list, hide / show a section, remove with Undo, reset, create), the undo plan, snap
// guides, the picker, the removed-widget holder, and the page files' rules (textContent only, CSP
// untouched, every string in locales/en.json). No Electron, no network, no window.
const fs = require('fs');
const path = require('path');
const WL = require('../features/widget-layout');
const WS = require('../features/widget-system');
const WE = require('../features/widget-edit');
const { createTrash } = require('../features/widget-trash');
const { createWidgets, cleanList, cleanWidget, CONNECTORS, MAX_WIDGETS: CAP } = require('../features/widgets');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

module.exports = async function widgetEditUnits(check) {
  const it = (id, type, x, y, w, h, extra) => ({ id, type, x, y, w, h, ...extra });
  const enc = WL.encode;
  const noOverlap = (items) => items.every((a, i) => items.every((b, j) => i === j || !WL.overlap(a, b)));
  const todo = (id, extra) => ({ id, type: 'todoist', ...extra });

  // ---- reserved ids and checking ----
  check('system cards: five reserved ids, each with a type the browser can name', WS.IDS.length === 5 && WS.IDS.every((id) => /^w[0-9a-z]{4,20}$/.test(id) && WS.typeOf(id).startsWith('sys-')), WS.IDS.join());
  check('system cards: their ids fit the do=layout URL (WL.decode), snap included', WL.decode(enc(WS.IDS.map((id, i) => it(id, WS.typeOf(id), i, 0, 2, 2)))).length === 5, '');
  check('system cards: a real widget id can never be one (they are made from the clock, not "sys")', !/^wsys/.test(`w${Date.now().toString(36)}abcd`), '');
  check('system cards: clean() keeps a checked rect and drops anything else', WS.clean({ id: 'wsysfavs', x: 1, y: 2, w: 4, h: 3, snap: 'tl' }).snap === 'tl'
    && WS.clean({ id: 'wsysfavs', x: 'a', y: 2, w: 4, h: 3 }) === null && WS.clean({ id: 'wsysfavs' }) === null && WS.clean({ id: 'wnope1', x: 0, y: 0, w: 3, h: 3 }) === null && WS.clean(null) === null, '');
  const big = WS.clean({ id: 'wsyssearch', x: 99, y: 999, w: 1, h: 99, type: 'evil' });
  check('system cards: numbers are clamped into the grid and the type comes from the id, not the entry', big.x === 9 && big.y === 200 && big.w === 3 && big.h === 20 && big.type === 'sys-search', JSON.stringify(big));
  check('system cards: cleanAll() dedupes and drops what does not check out', WS.cleanAll([it('wsysfavs', 'x', 0, 0, 3, 3), it('wsysfavs', 'x', 5, 5, 3, 3), it('wnope1', 'x', 0, 0, 3, 3), { id: 'wsysfreq' }]).map((c) => c.id).join() === 'wsysfavs', '');
  check('system cards: capReal() limits widgets and never counts system cards', WS.capReal([todo('wa0001'), todo('wa0002'), it('wsysfavs', 'sys-favorites', 0, 0, 2, 2), todo('wa0003')], 2).map((w) => w.id).join() === 'wa0001,wa0002,wsysfavs', '');
  check('system cards: visible() follows the Settings toggles (a missing one counts as on; the search box has none)', WS.visible('wsysfavs', {}) && !WS.visible('wsysfavs', { newTabFavorites: false }) && WS.visible('wsyssearch', { newTabFavorites: false }) && !WS.visible('wsyshead', { newTabHeader: false }) && !WS.visible('wnope1', {}), '');
  check('system cards: they are limited like other cards (the search box is at least 3 wide)', WL.limitsOf('sys-search').minW === 3 && WL.limitsOf('sys-favorites').minW === 2, JSON.stringify(WL.limitsOf('sys-search')));

  // ---- the stored list ----
  const old = [
    { id: 'wweat01', type: 'weather', place: 'Boston', lat: 42.36, lon: -71.06, units: 'f', span: 3 },
    { id: 'wtodo01', type: 'todoist', span: 6 },
  ];
  const oldClean = cleanList(old);
  check('migration: a list from before system cards loads unchanged (no system entries appear, nothing moves)', oldClean.length === 2 && oldClean.every((w) => !WS.isSystem(w)) && JSON.stringify(cleanList(oldClean)) === JSON.stringify(oldClean), JSON.stringify(oldClean.map((w) => [w.id, w.x, w.y, w.w, w.h])));
  const mixed = cleanList([...oldClean, it('wsysfavs', 'sys-favorites', 0, 9, 5, 4), { id: 'wsysfreq', type: 'sys-frequent' }, it('wsyspriv', 'sys-privacy', 'a', 0, 2, 2)]);
  check('system cards: they live in the same list, checked; entries without a rect (docked) or with garbage are dropped', mixed.length === 3 && mixed.filter(WS.isSystem).map((w) => w.id).join() === 'wsysfavs', JSON.stringify(mixed.map((w) => w.id)));
  check('system cards: no span or height is written for them (an older Lumen ignores the entry entirely)', !('span' in mixed.find(WS.isSystem)) && CONNECTORS['sys-favorites'] === undefined && cleanWidget(it('wsysfavs', 'sys-favorites', 0, 0, 2, 2)) !== null, '');
  check('system cards: an older Lumen (which only knows connector types) drops them and keeps the widgets', mixed.filter((w) => CONNECTORS[w.type]).length === 2, '');
  const many = cleanList([...Array.from({ length: 30 }, (_, i) => ({ id: `wm${String(i).padStart(4, '0')}`, type: 'todoist' })), ...WS.IDS.map((id, i) => it(id, WS.typeOf(id), i * 2, 30, 2, 2))]);
  check('system cards: the widget limit counts widgets only', many.filter((w) => !WS.isSystem(w)).length === CAP && many.filter(WS.isSystem).length === 5, `${many.length}`);
  check('system cards: widgets and system cards never overlap once stored', noOverlap(cleanList([todo('wa0001', { x: 0, y: 0, w: 6, h: 5 }), it('wsysfavs', 'sys-favorites', 2, 1, 6, 4)])), '');

  // ---- what the browser does with the page's actions ----
  let settings = { homeWidgets: cleanList([todo('wtodo01', { x: 0, y: 0, w: 6, h: 5 }), { id: 'wweat01', type: 'weather', place: 'Boston', lat: 42.36, lon: -71.06, units: 'f', x: 6, y: 0, w: 4, h: 3 }]) };
  const secrets = { todoist: 'x'.repeat(30) };
  let updates = 0;
  const w = createWidgets({
    readSettings: () => settings, writeSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); }, fetch: async () => { throw new Error('offline'); },
    getSecret: (n) => secrets[n] || null, setSecret: (n, v) => { if (v) secrets[n] = v; else delete secrets[n]; }, endpoints: () => ({}), onUpdate: () => { updates++; }, trashMs: 60000,
  });
  const parse = (query) => w.actionFrom(`file:///newtab.html?${query}#x`);
  const sysStored = () => (settings.homeWidgets || []).filter(WS.isSystem);
  check('page: forPage() has no system entries until one is moved (nothing changes for someone who never edits)', w.forPage().every((p) => !p.system) && sysStored().length === 0, '');

  let a = parse('widget=wsysfavs&do=layout&l=wsysfavs:9,0,3,4');
  check('page: do=layout accepts a system card id', a && !a.invalid && a.items[0].id === 'wsysfavs' && Array.isArray(a.dock) && a.dock.length === 0, JSON.stringify(a));
  a = parse('widget=wsysfavs&do=layout&l=wsysfavs:9,0,3,4&d=wsysfreq,wnope1,wsyspriv');
  check('page: the dock list keeps only system ids', a.dock.join() === 'wsysfreq,wsyspriv', JSON.stringify(a.dock));
  await w.act(parse('widget=wsysfavs&do=layout&l=wsysfavs:9,0,3,4'));
  const fav = sysStored()[0];
  check('page: moving a section stores its rect as a free card', fav && fav.id === 'wsysfavs' && fav.w === 3 && fav.h === 4 && fav.type === 'sys-favorites', JSON.stringify(sysStored()));
  check('page: forPage() now carries it, marked as a system card, after the widgets', w.forPage().at(-1).system === true && w.forPage().at(-1).id === 'wsysfavs' && w.forPage().at(-1).layout.w === 3, JSON.stringify(w.forPage().map((p) => p.id)));
  check('page: list() and Settings state still show the widgets only', w.list().length === 2 && w.state().widgets.length === 2, '');
  check('page: saving a widget keeps the system cards (and they never overlap it)', await (async () => { await w.act(parse('widget=wtodo01&do=layout&l=wtodo01:0,0,4,3')); return sysStored().length === 1 && noOverlap(w.list().concat(sysStored())); })(), JSON.stringify(settings.homeWidgets.map((x) => x.id)));
  await w.act(parse(`widget=wsysfavs&do=layout&l=${enc([it('wtodo01', 'todoist', 0, 0, 4, 3, {})])}&d=wsysfavs`));
  check('page: a dock list sends a section back to the centre column (its entry goes)', sysStored().length === 0, JSON.stringify(sysStored()));
  await w.act(parse('widget=wsysfavs&do=layout&l=wsysfavs:9,0,3,4&d=wsysfavs'));
  check('page: a card in both lists is docked', sysStored().length === 0, '');
  await w.act(parse('widget=wsysfavs&do=layout&l=wsysfavs:9,0,3,4'));
  check('page: a layout of only unchanged cards changes nothing', (await w.act(parse('widget=wsysfavs&do=layout&l=wsysfavs:9,0,3,4'))) === false, '');

  updates = 0;
  await w.act(parse('widget=wsysfavs&do=remove'));
  check('page: removing a section hides it (its Settings toggle) and keeps its place', settings.newTabFavorites === false && sysStored().length === 1 && updates > 0, JSON.stringify([settings.newTabFavorites, sysStored().length]));
  await w.act(parse('widget=wsysfavs&do=restore'));
  check('page: restore shows a hidden section again', settings.newTabFavorites === true, '');
  check('page: the search box has no toggle and cannot be hidden', (await w.act(parse('widget=wsyssearch&do=remove'))) === false && settings.newTabSearch === undefined, '');
  check('page: a system card has no other actions (refresh, configure, size)', (await w.act(parse('widget=wsysfavs&do=configure'))) === false, '');

  // Removing a widget keeps it (and its token) for Undo.
  const before = JSON.stringify(w.list().find((x) => x.id === 'wtodo01'));
  await w.act(parse('widget=wtodo01&do=remove'));
  check('page: removing a widget removes it (and the token nobody else uses)', !w.list().some((x) => x.id === 'wtodo01') && !secrets.todoist, '');
  check('page: restore brings it back exactly, and its token', (await w.act(parse('widget=wtodo01&do=restore'))) === true && JSON.stringify(w.list().find((x) => x.id === 'wtodo01')) === before && Boolean(secrets.todoist), JSON.stringify(w.list().map((x) => x.id)));
  check('page: a second restore does nothing', (await w.act(parse('widget=wtodo01&do=restore'))) === false, '');
  check('page: restore of an id that was never removed does nothing', (await w.act(parse('widget=wnever1&do=restore'))) === false, '');

  // Reset, create.
  await w.act(parse('widget=wsysfreq&do=layout&l=wsysfreq:0,9,4,3'));
  await w.act(parse('widget=wreset&do=reset'));
  check('page: reset puts every section back in the centre column and packs the widgets', sysStored().length === 0 && w.list().every((x) => x.x !== undefined), JSON.stringify(settings.homeWidgets.map((x) => x.id)));
  check('page: do=create needs a kind that exists', parse('widget=wcreate&do=create&type=nope').invalid === true && parse('widget=wcreate&do=create').invalid === true && parse('widget=wcreate&do=create&type=weather').type === 'weather', '');
  let configured = 0;
  const w2 = createWidgets({ readSettings: () => settings, writeSettings: (s) => { settings = s; }, fetch: async () => { throw new Error('offline'); }, getSecret: () => null, setSecret: () => {}, endpoints: () => ({}), onConfigure: () => { configured++; } });
  await w2.act({ id: 'wcreate', do: 'create', type: 'calendar' });
  const st = w2.state();
  check('page: create opens Settings for a new widget of that kind, once', configured === 1 && st.create === 'calendar' && st.edit === null && w2.state().create === null, JSON.stringify([configured, st.create]));
  check('page: the gear still opens a widget by id', await (async () => { await w2.act({ id: 'wtodo01', do: 'configure' }); const s2 = w2.state(); return s2.edit === 'wtodo01' && s2.create === null; })(), '');
  check('page: the URL grammar refuses a bad action or id', parse('widget=wtodo01&do=explode').invalid === true && parse('widget=BAD&do=restore').invalid === true && parse('nothing=1') === null, '');

  // ---- removed widgets ----
  let clock = 1000;
  const trash = createTrash({ now: () => clock, ttl: 100, max: 2 });
  trash.hold({ id: 'wa0001', widget: { id: 'wa0001' } });
  check('trash: a held widget can be taken once', trash.take('wa0001')?.widget.id === 'wa0001' && trash.take('wa0001') === null, '');
  trash.hold({ id: 'wa0001', widget: {} });
  clock += 101;
  check('trash: it is gone after its time', trash.take('wa0001') === null && trash.size === 0, '');
  trash.hold({ id: 'wa0001', widget: {} }); trash.hold({ id: 'wa0002', widget: {} }); trash.hold({ id: 'wa0003', widget: {} });
  check('trash: only the last few are kept', !trash.has('wa0001') && trash.has('wa0002') && trash.has('wa0003') && trash.hold({}) === false, '');

  // ---- from a box to cells ----
  const m = WL.metrics(1280);
  const box = { left: m.pad + 2 * m.pitchX, top: m.top + 1 * m.pitchY, width: 8 * m.cw + 7 * WL.GAP, height: 3 * WL.ROW + 2 * WL.GAP };
  check('system cards: a docked section\'s box becomes the cells it covers, exactly', JSON.stringify(WS.cellsFromBox('wsysfavs', box, m)) === JSON.stringify({ x: 2, y: 1, w: 8, h: 3 }) && WS.cellsFromBox('wsysfavs', box, WL.metrics(500)) === null && WS.cellsFromBox('wnope1', box, m) === null, JSON.stringify(WS.cellsFromBox('wsysfavs', box, m)));
  check('system cards: an odd box is clamped, never refused', WS.cellsFromBox('wsyshead', { left: -50, top: -20, width: 30, height: 10 }, m).x === 0, '');

  // ---- the layout engine treats them like widgets ----
  const ob = { x: 3, y: 0, w: 6, h: 10 };
  const list = [it('wsyshead', 'sys-header', 3, 1, 6, 3), it('wsyssearch', 'sys-search', 3, 4, 6, 2), it('wsysfavs', 'sys-favorites', 3, 6, 6, 4), it('wtodo01', 'todoist', 0, 0, 3, 3)];
  let r = WL.move(list, 'wsysfavs', { x: 0, y: 3 }, { packed: true });
  check('system cards: dragging one moves it and pushes others, like a widget', r.find((c) => c.id === 'wsysfavs').x === 0 && noOverlap(r), enc(r));
  r = WL.resize(list, 'wsyssearch', { x: 3, y: 4, w: 1, h: 2 }, { packed: false });
  check('system cards: the search box cannot be made narrower than three cells', r.find((c) => c.id === 'wsyssearch').w === 3, enc(r));
  r = WL.snapMove(list, 'wsysfavs', { snap: 'left' }, { obstacle: null, rows: 12, packed: false });
  check('system cards: snapping works for them too', noOverlap(r), enc(r));
  void ob;
  // The clock and the search bar never push other cards: they go only into free space.
  const around = [it('wsyshead', 'sys-header', 0, 0, 4, 3), it('wtodo01', 'todoist', 4, 0, 4, 3), it('wweather', 'weather', 8, 0, 4, 3), it('wcal001', 'calendar', 0, 3, 4, 3)];
  const still = (a, b, ids) => ids.every((id) => enc([a.find((c) => c.id === id)]) === enc([b.find((c) => c.id === id)]));
  r = WL.move(around, 'wsyshead', { x: 4, y: 0 }, { packed: true });
  check('clock card: dropped onto another card it slides to the nearest free spot; nothing else moves', still(around, r, ['wtodo01', 'wweather', 'wcal001']) && noOverlap(r), enc(r));
  r = WL.resize(around, 'wsyshead', { x: 0, y: 0, w: 8, h: 3 }, { packed: true });
  check('clock card: grown into a card it stops at that card; nothing else moves', r.find((c) => c.id === 'wsyshead').w === 4 && still(around, r, ['wtodo01', 'wweather', 'wcal001']) && noOverlap(r), enc(r));
  r = WL.resize(around, 'wsyshead', { x: 0, y: 0, w: 4, h: 3 + 3 }, { packed: false });
  check('clock card: grown down into the card below it stays its size; nothing else moves', r.find((c) => c.id === 'wsyshead').h === 3 && still(around, r, ['wcal001']), enc(r));
  r = WL.move([...around.slice(1), it('wsyssearch', 'sys-search', 0, 7, 6, 2)], 'wsyssearch', { x: 2, y: 7 }, { packed: true });
  check('search card: moved into free space it goes exactly there', r.find((c) => c.id === 'wsyssearch').x === 2 && r.find((c) => c.id === 'wsyssearch').y === 7, enc(r));

  // ---- undo ----
  const H = WE.createHistory(3);
  for (let i = 0; i < 5; i++) H.push({ i });
  check('undo stack: newest first out, oldest dropped past the limit', H.size === 3 && H.pop().i === 4 && H.peek().i === 3 && H.pop() && H.pop() && H.pop() === null, '');
  const isSys = WS.isSystemId;
  const prev = [it('wtodo01', 'todoist', 0, 0, 4, 3), it('wsysfavs', 'sys-favorites', 4, 0, 4, 3)];
  const cur = [it('wtodo01', 'todoist', 6, 0, 4, 3), it('wsysfavs', 'sys-favorites', 4, 3, 4, 3)];
  let plan = WE.undoPlan(prev, cur, { isSystem: isSys });
  check('undo plan: only the cards that differ are sent', plan.items.length === 2 && plan.dock.length === 0, JSON.stringify(plan));
  plan = WE.undoPlan(prev, cur, { isSystem: isSys, pristine: new Set(['wsysfavs']), touched: new Set(['wsysfavs']) });
  check('undo plan: a section that was untouched goes back to the centre column, not to a stored rect', plan.items.map((c) => c.id).join() === 'wtodo01' && plan.dock.join() === 'wsysfavs', JSON.stringify(plan));
  plan = WE.undoPlan([prev[1]], [cur[1]], { isSystem: isSys, pristine: new Set(['wsysfavs']), touched: new Set(['wsysfavs']) });
  check('undo plan: with nothing else to send a dock-only undo still has a card to carry it', plan.items.length === 1 && plan.dock.join() === 'wsysfavs', JSON.stringify(plan));
  check('undo plan: nothing changed, nothing to do; a removed widget is not sent', WE.undoPlan(prev, prev, { isSystem: isSys }) === null && WE.undoPlan([it('wgone01', 'todoist', 0, 0, 3, 3)], [], { isSystem: isSys }) === null, '');
  check('undo plan: garbage in, null out', WE.undoPlan(null, cur) === null && WE.undoPlan(prev, 'x') === null, '');

  // ---- snap guides ----
  const gs = WE.guides({ x: 3, y: 0, w: 4, h: 3 }, [it('a', 't', 3, 3, 4, 2), it('b', 't', 7, 0, 2, 5), { x: 0, y: 1, w: 1, h: 1 }]);
  check('guides: shared left/right edges and shared top/bottom lines are found, with the stretch to draw',
    gs.some((g) => g.axis === 'x' && g.at === 3 && g.from === 0 && g.to === 5) && gs.some((g) => g.axis === 'x' && g.at === 7) && gs.some((g) => g.axis === 'y' && g.at === 3) && gs.some((g) => g.axis === 'y' && g.at === 0), JSON.stringify(gs));
  check('guides: none when nothing lines up, and never more than asked for', WE.guides({ x: 0, y: 0, w: 2, h: 2 }, [{ x: 5, y: 5, w: 3, h: 3 }]).length === 0 && WE.guides({ x: 0, y: 0, w: 2, h: 2 }, Array.from({ length: 20 }, (_, i) => ({ x: 0, y: i * 2, w: 2, h: 2 })), 4).length === 4, '');

  // ---- the picker ----
  check('picker: every connector kind has its own name and line, each listed once', Object.keys(CONNECTORS).every((t) => WE.TYPE_INFO[t] && WE.STRINGS[WE.TYPE_INFO[t][0]] && WE.STRINGS[WE.TYPE_INFO[t][1]]) && new Set(WE.pickerEntries({ types: Object.keys(CONNECTORS) }).map((e) => e.type)).size === Object.keys(CONNECTORS).length, Object.keys(CONNECTORS).filter((t) => !WE.TYPE_INFO[t]).join());
  const pe = WE.pickerEntries({ types: ['weather', 'bogus'], hidden: [{ id: 'wsysfavs', label: 'Favorites' }] });
  check('picker: sections that were hidden first, then every kind; unknown kinds get a name and a generic line', pe[0].kind === 'section' && pe[0].id === 'wsysfavs' && pe[1].label === 'Weather' && pe[2].label === 'Bogus' && pe[2].hint === WE.STRINGS['newtab.edit.type.other.hint'], JSON.stringify(pe));
  check('picker: a translation table wins over English', WE.pickerEntries({ types: ['weather'], table: { 'newtab.edit.type.weather': 'Wetter' } })[0].label === 'Wetter' && WE.text('newtab.edit.undone', { what: 'x' }) === 'Undone: x' && WE.text('nope.key') === 'nope.key', '');

  // ---- the clock's size and the search bar's width ----
  const SB = require('../settings-backend');
  check('size: defaults are medium and 640 px', SB.DEFAULTS.newTabClockSize === 'm' && SB.DEFAULTS.newTabSearchWidth === 640 && WS.CLOCK_DEFAULT === 'm' && WS.SEARCH_DEFAULT === 640, '');
  check('size: clock steps are s/m/l/xl at 64/88/120/160 px; anything else is refused', WS.CLOCK_STEPS.join() === 's,m,l,xl' && WS.CLOCK_STEPS.map((k) => WS.CLOCK_PX[k]).join() === '64,88,120,160' && WS.cleanClockSize('xl') === 'xl' && WS.cleanClockSize('xxl') === null && WS.cleanClockSize(3) === null && WS.cleanClockSize(undefined) === null, '');
  check('size: the search width is rounded and clamped to 480-960, junk is refused', WS.cleanSearchWidth(100) === 480 && WS.cleanSearchWidth(5000) === 960 && WS.cleanSearchWidth('700') === 700 && WS.cleanSearchWidth(600.6) === 601 && WS.cleanSearchWidth('x') === null && WS.cleanSearchWidth(null) === null && WS.cleanSearchWidth('') === null && WS.cleanSearchWidth(true) === null && WS.cleanSearchWidth(NaN) === null, '');
  check('size: a dragged clock height snaps to the nearest step', WS.clockStepFromPx(10) === 's' && WS.clockStepFromPx(70) === 's' && WS.clockStepFromPx(80) === 'm' && WS.clockStepFromPx(103) === 'm' && WS.clockStepFromPx(105) === 'l' && WS.clockStepFromPx(139) === 'l' && WS.clockStepFromPx(141) === 'xl' && WS.clockStepFromPx(999) === 'xl' && WS.clockStepFromPx(NaN) === 'm', '');
  check('size: keyboard steps stop at both ends', WS.stepClock('m', 1) === 'l' && WS.stepClock('xl', 1) === 'xl' && WS.stepClock('s', -1) === 's' && WS.stepClock('m', -5) === 's' && WS.stepClock('bogus', 1) === 'l', '');
  check('size: a dragged search width snaps to 8 px and stays inside 480-960', WS.snapSearchWidth(643) === 640 && WS.snapSearchWidth(645) === 648 && WS.snapSearchWidth(100) === 480 && WS.snapSearchWidth(2000) === 960 && WS.snapSearchWidth(NaN) === 640 && WS.snapSearchWidth(803) % 8 === 0, '');
  const gridPx = { pitch: 100, pad: 40, width: 1000 }; // edges on x = 40 + k * 100 -> widths 1000 - 2 * (40 + k * 100) = 920, 720, 520
  check('size: near a grid line the width snaps onto it (edges on the columns), else to 8 px', WS.snapSearchWidth(716, gridPx) === 720 && WS.snapSearchWidth(922, gridPx) === 920 && WS.snapSearchWidth(660, gridPx) === 664 && WS.snapSearchWidth(600, { pitch: 0, pad: 0, width: 0 }) === 600, [716, 922, 660].map((n) => WS.snapSearchWidth(n, gridPx)).join());
  check('size: do=look accepts a clock step or a width and nothing else', parse('widget=wlook&do=look&k=clock&v=l').value === 'l' && parse('widget=wlook&do=look&k=clock&v=l').key === 'newTabClockSize'
    && parse('widget=wlook&do=look&k=search&v=720').value === 720 && parse('widget=wlook&do=look&k=search&v=100').value === 480 && parse('widget=wlook&do=look&k=search&v=99999').invalid === true
    && parse('widget=wlook&do=look&k=clock&v=huge').invalid === true && parse('widget=wlook&do=look&k=theme&v=dark').invalid === true && parse('widget=wlook&do=look').invalid === true, '');
  await w.act(parse('widget=wlook&do=look&k=clock&v=xl'));
  await w.act(parse('widget=wlook&do=look&k=search&v=800'));
  check('size: do=look is saved to the two settings', settings.newTabClockSize === 'xl' && settings.newTabSearchWidth === 800, JSON.stringify([settings.newTabClockSize, settings.newTabSearchWidth]));
  await w.act(parse('widget=wreset&do=reset'));
  check('size: Reset layout puts the clock and the search bar back to the defaults', settings.newTabClockSize === 'm' && settings.newTabSearchWidth === 640, JSON.stringify([settings.newTabClockSize, settings.newTabSearchWidth]));
  const pageSrc = read('renderer/newtab.html');
  check('size: the page reads --clock-size and --search-w on <main>, centred, the clock never scrolls', /main \{[^}]*--clock-size: 88px;[^}]*--search-w: 640px;[^}]*width: min\(var\(--search-w\), 88vw\); margin: 0 auto/.test(pageSrc) && /\.clock \{[^}]*font-size: var\(--clock-size\);[^}]*white-space: nowrap; overflow: visible/.test(pageSrc), '');

  // ---- the page's files ----
  const en = JSON.parse(read('locales/en.json'));
  const missing = Object.entries(WE.STRINGS).filter(([k, v]) => en[k] !== v).map(([k]) => k);
  check('locales: every page string is in en.json with the same English', missing.length === 0, missing.join(', '));
  const html = read('renderer/newtab.html');
  check('page: the CSP is untouched', html.includes(`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data: file:; frame-src https:; form-action https:"`), '');
  const order = ['widget-layout.js', 'widget-stacks.js', 'widget-system.js', 'widget-edit.js', 'newtab-system.js', 'newtab-widgets.js', 'newtab-widgets-grid.js', 'newtab-stacks.js', 'newtab-edit.js', 'newtab.js'].map((f) => html.indexOf(`/${f}"`) >= 0 ? html.indexOf(`/${f}"`) : html.indexOf(`"${f}"`));
  check('page: the scripts load in dependency order, all from the app (no other origin)', order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])) && !/<script[^>]+src="https?:/.test(html), order.join());
  for (const f of ['renderer/newtab-edit.js', 'renderer/newtab-system.js', 'renderer/newtab-stacks.js']) {
    const src = read(f);
    check(`page: ${f} builds everything with DOM calls and textContent (no markup strings, no eval, no network)`, !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket/.test(src), '');
  }
  const gridSrc = read('renderer/newtab-widgets-grid.js');
  check('page: the grid keeps its calm mode and reduced-motion rules, and the edit UI has its own', /body\.calm/.test(read('renderer/newtab.html')) && /prefers-reduced-motion: no-preference\) \{ body:not\(\.calm\)/.test(read('renderer/newtab-edit.js')) && /aria-live|widgetAnnounce/.test(gridSrc), '');
  check('page: keyboard moving and resizing, snapping and undo are wired (arrows, Shift, Ctrl+Alt, Ctrl+Z)', /ArrowLeft/.test(gridSrc) && /e\.shiftKey/.test(gridSrc) && /e\.ctrlKey && e\.altKey/.test(gridSrc) && /key\.toLowerCase\(\) === 'z'/.test(gridSrc), '');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
