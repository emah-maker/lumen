// New-tab Smart Stack, pure logic (run from test/units.js, or on its own with `node test/widget-stack-units.js`):
// the model (create, merge, remove, reorder, options, index wrap, undo arrangements), the auto-rotate
// scheduler, the smart-rotate rules, the swipe and spring math, the browser's page actions and the settings
// validation. No Electron, no network, no window.
const fs = require('fs');
const path = require('path');
const ST = require('../src/features/widget-stacks');
const SM = require('../src/features/widget-stack-motion');
const WL = require('../src/features/widget-layout');
const WE = require('../src/features/widget-edit');
const { createWidgets, cleanList } = require('../src/features/widgets');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

module.exports = async function widgetStackUnits(check) {
  const wx = (id, extra) => ({ id, type: 'weather', place: 'B', lat: 1, lon: 2, ...extra });
  const todo = (id, extra) => ({ id, type: 'todoist', ...extra });
  const byId = (list, id) => list.find((w) => w.id === id);
  const ids = (list, sid) => ST.membersOf(list, sid).join();
  const N = (n) => Array.from({ length: n }, (_, i) => todo(`wt${String(i).padStart(4, '0')}`, { x: 0, y: 0, w: 4, h: 3, stack: 'sbig0001', ...(i === 0 ? { top: true } : {}) }));

  // ---- the model: size, options, wrap ----
  check('smart stack: a stack holds 2 to 10 widgets of any kind', ST.MIN_STACK === 2 && ST.MAX_STACK === 10, `${ST.MIN_STACK}-${ST.MAX_STACK}`);
  const ten = cleanList(N(10));
  const eleven = cleanList(N(11));
  check('smart stack: ten stack, an eleventh is its own place again', ten.filter((w) => w.stack).length === 10 && eleven.filter((w) => w.stack).length === 10 && eleven.filter((w) => !w.stack).length === 1, `${ten.filter((w) => w.stack).length}/${eleven.filter((w) => w.stack).length}`);
  check('smart stack: index wraps both ways (the last is followed by the first)', ST.wrap(3, 3) === 0 && ST.wrap(-1, 3) === 2 && ST.wrap(-4, 3) === 2 && ST.wrap(7, 3) === 1 && ST.wrap(0, 0) === 0 && ST.neighbour(['a', 'b', 'c'], 'c', 1) === 'a' && ST.neighbour(['a', 'b', 'c'], 'a', -1) === 'c', '');
  check('smart stack: options are on unless stored off, and only an off is stored', ST.cleanFields({ stack: 'sabcd1' }).rotate === undefined && ST.cleanFields({ stack: 'sabcd1', rotate: false, smart: false }).rotate === false && ST.cleanFields({ stack: 'sabcd1', rotate: 'no', smart: 0 }).smart === undefined && !ST.cleanFields({ rotate: false, smart: false }).rotate, '');

  // ---- create, merge, remove ----
  const flat = cleanList([wx('wwx0001', { x: 0, y: 0, w: 4, h: 3 }), todo('wtd0001', { x: 4, y: 0, w: 4, h: 3 }), { id: 'wcd0001', type: 'countdown', cd: { date: '2030-01-01', time: '', label: 'Launch' }, x: 8, y: 0, w: 4, h: 3 }, todo('wtd0002', { x: 0, y: 4, w: 2, h: 2 })]);
  const two = ST.join(flat, 'wwx0001', 'wtd0001');
  const sid = byId(two, 'wtd0001').stack;
  check('smart stack: create: dropping one widget on another of the same size starts a stack, the dropped one shown', two && byId(two, 'wwx0001').top === true && !byId(two, 'wtd0001').top && byId(two, 'wwx0001').x === 4 && ST.STACK_RE.test(sid) && ids(two, sid) === 'wwx0001,wtd0001', JSON.stringify(two.map((w) => [w.id, w.stack, w.top])));
  const joined3 = ST.join(two, 'wcd0001', 'wtd0001');
  const three = ST.select(joined3, 'wwx0001'); // the dropped one is shown first; the tests below start with the first member shown
  check('smart stack: add a third, of another kind: it joins the same stack, shown', byId(joined3, 'wcd0001').top === true && byId(three, 'wcd0001').stack === sid && ids(three, sid) === 'wwx0001,wtd0001,wcd0001' && three.filter((w) => w.top).length === 1, ids(three, sid));
  const other = cleanList([todo('wa000001', { x: 0, y: 0, w: 4, h: 3 }), todo('wb000001', { x: 4, y: 0, w: 4, h: 3 }), todo('wc000001', { x: 8, y: 0, w: 4, h: 3 }), todo('wd000001', { x: 0, y: 4, w: 4, h: 3 })]);
  const twoAndTwo = ST.join(ST.join(other, 'wa000001', 'wb000001'), 'wc000001', 'wd000001');
  const merged = ST.join(twoAndTwo, 'wc000001', 'wa000001');
  check('smart stack: merge: a whole stack dropped on another takes all its members along', ST.canStack(twoAndTwo, 'wc000001', 'wa000001') && new Set(merged.map((w) => w.stack)).size === 1 && merged.filter((w) => w.top).length === 1, JSON.stringify(merged.map((w) => [w.id, w.stack, w.top])));
  check('smart stack: merging is refused past 10 and for different sizes; a stack never joins itself', !ST.canStack(cleanList(N(10).concat(todo('wextra01', { x: 8, y: 8, w: 4, h: 3 }))), 'wextra01', 'wt0000') && !ST.canStack(flat, 'wtd0002', 'wwx0001') && !ST.canStack(two, 'wwx0001', 'wtd0001'), '');
  const gone = ST.drop(three, 'wcd0001');
  check('smart stack: remove from 3 to 2: still a stack', ST.membersOf(cleanList(gone), sid).length === 2, '');
  const last = cleanList(ST.drop(two, 'wtd0001'));
  check('smart stack: removing the last-but-one turns the stack back into a plain widget', last.every((w) => !w.stack && !w.top && !('rotate' in w) && !('smart' in w)) && last.length === flat.length - 1, JSON.stringify(last.map((w) => [w.id, w.stack])));
  const out = cleanList(ST.leave(two, 'wwx0001', WL));
  check('smart stack: taking out the second-to-last member leaves two plain widgets, each in its own place', out.every((w) => !w.stack) && !(byId(out, 'wwx0001').x === byId(out, 'wtd0001').x && byId(out, 'wwx0001').y === byId(out, 'wtd0001').y), JSON.stringify(out.map((w) => [w.id, w.x, w.y])));
  check('smart stack: removing the shown member shows the next (wrapping), the shown index follows', byId(ST.drop(three, 'wwx0001'), 'wtd0001').top === true && byId(ST.drop(ST.select(three, 'wcd0001'), 'wcd0001'), 'wwx0001').top === true, '');

  // ---- reorder ----
  const o1 = ST.moveMember(three, 'wcd0001', -1);
  check('smart stack: reorder: move a member up one place', ids(o1, sid) === 'wwx0001,wcd0001,wtd0001' && ST.moveMember(three, 'wwx0001', -1) === null && ST.moveMember(three, 'wcd0001', 1) === null, ids(o1 || [], sid));
  const o2 = ST.reorder(three, 'wcd0001', 0);
  check('smart stack: reorder: drag to a position; to its own place is no change; out of range clamps', ids(o2, sid) === 'wcd0001,wwx0001,wtd0001' && ST.reorder(three, 'wwx0001', 0) === null && ids(ST.reorder(three, 'wwx0001', 99), sid) === 'wtd0001,wcd0001,wwx0001', '');
  check('smart stack: reordering keeps the shown member, the options and every cell', byId(o2, 'wwx0001').top === true && o2.every((w) => !w.stack || (w.x === 4 && w.y === 0)), '');
  const stored = cleanList(o2);
  check('smart stack: the order survives validation and a second pass', ids(stored, sid) === 'wcd0001,wwx0001,wtd0001' && JSON.stringify(cleanList(stored)) === JSON.stringify(stored), ids(stored, sid));

  // ---- options ----
  const noRot = ST.setOption(three, sid, 'rotate', false);
  check('smart stack: turning auto-rotate off marks every member, and back on clears it', ST.optionsOf(noRot, sid).rotate === false && ST.optionsOf(noRot, sid).smart === true && noRot.filter((w) => w.stack).every((w) => w.rotate === false) && ST.optionsOf(ST.setOption(noRot, sid, 'rotate', true), sid).rotate === true && ST.setOption(three, sid, 'rotate', true) === null && ST.setOption(three, sid, 'bogus', false) === null, '');
  const cleaned = cleanList(noRot);
  check('smart stack: an option survives validation, cycling and reordering', ST.optionsOf(cleaned, sid).rotate === false && ST.optionsOf(ST.select(cleaned, 'wcd0001'), sid).rotate === false && ST.optionsOf(ST.reorder(cleaned, 'wcd0001', 0), sid).rotate === false, '');
  const split = cleanList(three.map((w) => (w.id === 'wtd0001' ? { ...w, smart: false } : w)));
  check('smart stack: one member saying off turns it off for the stack', ST.optionsOf(split, sid).smart === false && split.filter((w) => w.stack === sid).every((w) => w.smart === false), '');
  check('smart stack: joining a stack keeps its options; a new stack has both on', ST.optionsOf(ST.join(noRot.map((w) => w), 'wtd0002', 'wwx0001') || noRot, sid).rotate === false && ST.optionsOf(two, sid).smart === true, '');
  check('smart stack: a list from before the options loads unchanged (no fields appear)', JSON.stringify(cleanList(three)) === JSON.stringify(three) && three.every((w) => !('rotate' in w) && !('smart' in w)), '');

  // ---- Undo: the arrangement from before goes back ----
  const snap = ST.snapshot(flat, ['wwx0001', 'wtd0001']);
  const back = cleanList(ST.restack(cleanList(two), snap));
  check('smart stack: undo of create: restack with the earlier arrangement puts both widgets back in their own places', back.every((w) => !w.stack) && row(byId(back, 'wwx0001')) === row(byId(flat, 'wwx0001')) && row(byId(back, 'wtd0001')) === row(byId(flat, 'wtd0001')), JSON.stringify(back.map(row)));
  const snapThree = ST.snapshot(cleanList(three), ST.membersOf(cleanList(three), sid));
  const reordered = cleanList(ST.reorder(cleanList(three), 'wcd0001', 0));
  const undone = cleanList(ST.restack(reordered, snapThree));
  check('smart stack: undo of reorder puts the order, the shown member and the options back', ids(undone, sid) === ids(cleanList(three), sid) && byId(undone, 'wwx0001').top === true, ids(undone, sid));
  const dissolved = cleanList(ST.leave(cleanList(three), 'wcd0001', WL));
  const restored = cleanList(ST.restack(dissolved, snapThree));
  check('smart stack: undo of remove-from-stack brings the member back at its place in the order', ids(restored, sid) === ids(cleanList(three), sid) && ST.membersOf(restored, sid).length === 3, ids(restored, sid));
  check('smart stack: restack ignores widgets that are not there and system cards; nothing named is null', ST.restack(flat, [{ id: 'wnope001' }]) === null && ST.restack(flat, null) === null && ST.restack(flat, []) === null, '');
  function row(w) { return [w.id, w.x, w.y, w.w, w.h].join(' '); }

  // ---- auto-rotate scheduler ----
  const base = { rotate: true, count: 3, hidden: false, hovered: false, focused: false, reduced: false, calm: false, editing: false, busy: false, now: 100000, last: 100000 };
  check('auto-rotate: advances 20 s after the last move, not before', SM.AUTO_MS >= 15000 && SM.AUTO_MS <= 30000 && SM.autoPlan(base).run && SM.autoPlan(base).wait === SM.AUTO_MS && SM.autoPlan({ ...base, now: 100000 + 12000 }).wait === SM.AUTO_MS - 12000 && SM.autoPlan({ ...base, now: 100000 + SM.AUTO_MS }).wait === 0 && SM.autoPlan({ ...base, now: 200000 }).wait === 0, JSON.stringify(SM.autoPlan(base)));
  const blockedBy = (patch) => !SM.autoPlan({ ...base, ...patch }).run;
  check('auto-rotate: pauses on hover and focus, while the page is hidden, in the editor and mid-swipe', blockedBy({ hovered: true }) && blockedBy({ focused: true }) && blockedBy({ hidden: true }) && blockedBy({ editing: true }) && blockedBy({ busy: true }), '');
  check('auto-rotate: off when the stack says so, with one widget, with Reduce motion and in Performance mode', blockedBy({ rotate: false }) && blockedBy({ count: 1 }) && blockedBy({ reduced: true }) && blockedBy({ calm: true }), '');
  check('auto-rotate: an unknown last move counts from now (a new page waits its turn)', SM.autoPlan({ ...base, last: undefined }).wait === SM.AUTO_MS, '');

  // ---- smart rotate rules ----
  const NOW = new Date(2026, 9, 1, 14, 0).getTime();
  const min = 60 * 1000;
  const cal = (start, extra) => ({ id: 'wcal0001', type: 'calendar', data: { events: [{ title: 'Standup', start, allDay: false, ...extra }] } });
  const cd = (target) => ({ id: 'wcd0001', type: 'countdown', data: { target } });
  const wea = { id: 'wwx0001', type: 'weather', data: {} };
  const pick = (items, extra) => SM.smartPick({ items, now: NOW, hour: 14, day: '2026-10-01', ...extra });
  check('smart rotate: an event starting within 30 minutes surfaces the calendar', pick([wea, cal(NOW + 20 * min)]).id === 'wcal0001' && pick([wea, cal(NOW + 20 * min)]).reason === 'event' && pick([cal(NOW + 30 * min)]).id === 'wcal0001' && pick([cal(NOW + 1 * min)]).reason === 'event' && pick([cal(NOW - 1 * min)]).reason === 'event', '');
  check('smart rotate: later than 30 minutes, long over, all-day or without a time: not yet', pick([cal(NOW + 31 * min)]) === null && pick([cal(NOW - 10 * min)]) === null && pick([cal(NOW + 5 * min, { allDay: true })]) === null && pick([cal(undefined)]) === null && pick([{ id: 'w', type: 'calendar', data: null }]) === null, '');
  check('smart rotate: a countdown within a day surfaces it; further out or past does not', pick([cd(NOW + 23 * 60 * min)]).reason === 'countdown' && pick([cd(NOW + 25 * 60 * min)]) === null && pick([cd(NOW - 1)]) === null && pick([cd(NOW + 60 * min), cd(NOW + 5 * 60 * min)]).key.endsWith(String(NOW + 60 * min)), '');
  check('smart rotate: the weather in the morning (05:00 to 09:59) only', pick([wea], { hour: 7 }).reason === 'morning' && pick([wea], { hour: 5 }).reason === 'morning' && pick([wea], { hour: 9 }).reason === 'morning' && pick([wea], { hour: 10 }) === null && pick([wea], { hour: 4 }) === null && pick([], { hour: 7 }) === null, '');
  check('smart rotate: priority is event, then countdown, then the morning weather', pick([wea, cd(NOW + 60 * min), cal(NOW + 10 * min)], { hour: 7 }).reason === 'event' && pick([wea, cd(NOW + 60 * min)], { hour: 7 }).reason === 'countdown' && pick([wea], { hour: 7 }).reason === 'morning', '');
  check('smart rotate: deterministic (same input, same answer) and it names this moment', JSON.stringify(pick([cal(NOW + 5 * min)])) === JSON.stringify(pick([cal(NOW + 5 * min)])) && pick([cal(NOW + 5 * min)]).key !== pick([cal(NOW + 6 * min)]).key && pick([wea], { hour: 7 }).key !== pick([wea], { hour: 7, day: '2026-10-02' }).key, '');
  check('smart rotate: junk input is no pick', SM.smartPick(null) === null && SM.smartPick({ items: 'x', now: NOW }) === null && SM.smartPick({ items: [null, {}], now: NOW, hour: 7 }) === null && SM.smartPick({ items: [wea], now: NaN, hour: 7 }) === null, '');
  const p1 = pick([cal(NOW + 5 * min)]);
  check('smart rotate: acts once per moment, and not while the stack is held', SM.smartAction(p1, { top: 'wwx0001', seen: '', paused: false }).move && !SM.smartAction(p1, { top: 'wwx0001', seen: p1.key, paused: false }).move && !SM.smartAction(p1, { top: 'wwx0001', seen: '', paused: true }).move && !SM.smartAction(p1, { top: 'wcal0001', seen: '', paused: false }).move && SM.smartAction(p1, { top: 'wcal0001', seen: '', paused: false }).mark && !SM.smartAction(null, { top: 'x', seen: '', paused: false }).move, '');

  // ---- the swipe and the spring ----
  check('motion: Apple\'s projection (v / 1000 * d / (1 - d))', Math.abs(SM.project(1000) - 499) < 0.5 && SM.project(0) === 0 && SM.project(-1000) < 0, String(SM.project(1000)));
  check('motion: a release past half way lands on the next card, short of it goes back, a flick carries it', SM.settleTarget(0.6, 0) === 1 && SM.settleTarget(0.3, 0) === 0 && SM.settleTarget(-0.6, 0) === -1 && SM.settleTarget(0.1, 600) === 1 && SM.settleTarget(0.4, -600) === -1 && SM.settleTarget(0.4, -100) === 0 && SM.settleTarget(0, 0) === 0, '');
  let s = { x: 0, v: 0 };
  let t = 0;
  let peak = 0;
  while (t < 3 && !SM.settled(s, 1)) { s = SM.springStep(s, 1, 1 / 60, { response: 0.34, damping: 1 }); peak = Math.max(peak, s.x); t += 1 / 60; }
  check('motion: a critically damped spring arrives without overshoot, in well under a second', SM.settled(s, 1) && peak <= 1.001 && t < 1, `${t.toFixed(2)}s peak ${peak.toFixed(3)}`);
  let b = { x: 0, v: 0 };
  let over = 0;
  for (let i = 0; i < 180; i++) { b = SM.springStep(b, 1, 1 / 60, { response: 0.34, damping: 0.6 }); over = Math.max(over, b.x); }
  check('motion: a lower damping ratio overshoots a little and still settles', over > 1.02 && over < 1.3 && Math.abs(b.x - 1) < 0.01, over.toFixed(3));
  const fast = SM.springStep({ x: 0.3, v: 0 }, 1, 5, { response: 0.34, damping: 1 });
  check('motion: a long frame can not blow the spring up; an interrupted spring starts from where it is', Number.isFinite(fast.x) && fast.x <= 1.01 && SM.springStep({ x: 0.4, v: 2 }, 0, 1 / 60).x < 0.5 + 0.1, '');
  check('motion: wheel units (pixels, lines, pages) and the release velocity from recent samples', SM.wheelPx({ deltaY: 100, deltaMode: 0 }) === 100 && SM.wheelPx({ deltaY: 3, deltaMode: 1 }) === 48 && SM.wheelPx({ deltaY: 1, deltaMode: 2 }, 300) === 300 && Math.abs(SM.velocityOf([{ t: 0, d: 0 }, { t: 50, d: 50 }, { t: 100, d: 50 }], 100) - 1000) < 1 && SM.velocityOf([{ t: 0, d: 5 }], 10) === 0 && SM.velocityOf([{ t: 0, d: 0 }, { t: 10, d: 90 }], 1000) === 0, '');

  // ---- the browser: page actions, validation, persistence ----
  let settings = { homeWidgets: cleanList([wx('wwx0001', { x: 0, y: 0, w: 4, h: 3 }), todo('wtd0001', { x: 4, y: 0, w: 4, h: 3 }), todo('wtd0002', { x: 8, y: 0, w: 4, h: 3 }), wx('wwx0002', { x: 0, y: 4, w: 4, h: 3 })]) };
  const w = createWidgets({ readSettings: () => settings, writeSettings: (v) => { settings = JSON.parse(JSON.stringify(v)); }, fetch: async () => { throw new Error('offline'); }, getSecret: () => null, setSecret: () => {}, endpoints: () => ({}), onUpdate: () => {}, now: () => Date.UTC(2026, 9, 1, 14) });
  const parse = (q) => w.actionFrom(`file:///newtab.html?${q}#x`);
  const now = () => settings.homeWidgets;
  const enc = (e) => encodeURIComponent(JSON.stringify(e));
  check('page action: restack parses, with its fields checked', parse(`widget=wwx0001&do=restack&s=${enc([{ id: 'wwx0001', x: 0, y: 0, w: 4, h: 3, stack: 'sabcd1', top: true, rotate: false, evil: 1 }])}`).entries[0].rotate === false && !('evil' in parse(`widget=wwx0001&do=restack&s=${enc([{ id: 'wwx0001', evil: 1 }])}`).entries[0]), '');
  check('page action: restack refuses bad json, bad ids, an empty or oversized list and a missing payload', parse('widget=wwx0001&do=restack').invalid && parse('widget=wwx0001&do=restack&s=nope').invalid && parse(`widget=wwx0001&do=restack&s=${enc([{ id: '../x' }])}`).invalid && parse(`widget=wwx0001&do=restack&s=${enc([])}`).invalid && parse(`widget=wwx0001&do=restack&s=${enc(Array.from({ length: 30 }, () => ({ id: 'wwx0001' })))}`).invalid && parse(`widget=wwx0001&do=restack&s=${enc({ id: 'wwx0001' })}`).invalid, '');
  await w.act(parse('widget=wwx0001&do=stack&onto=wtd0001'));
  await w.act(parse('widget=wtd0002&do=stack&onto=wtd0001'));
  const stackId = byId(now(), 'wtd0001').stack;
  check('persistence: three widgets of two kinds in one stack, one shown, same cells', stackId && ST.membersOf(now(), stackId).length === 3 && now().filter((x) => x.top).length === 1 && new Set(now().filter((x) => x.stack === stackId).map((x) => `${x.x},${x.y}`)).size === 1, JSON.stringify(now().map((x) => [x.id, x.stack, x.top])));
  await w.act(parse('widget=wtd0002&do=cycle'));
  check('persistence: the visible card is stored', byId(now(), 'wtd0002').top === true && now().filter((x) => x.top && x.stack === stackId).length === 1, '');
  const members = ST.membersOf(now(), stackId);
  const entries = ST.snapshot(now(), [members[2], members[0], members[1]]).map((e) => ({ ...e, rotate: false }));
  const nextOrder = [members[2], members[0], members[1]].join();
  await w.act(parse(`widget=${members[2]}&do=restack&s=${enc(entries)}`));
  check('persistence: restack from the panel stores the order and the option, validated in main', ST.membersOf(now(), stackId).join() === nextOrder && ST.optionsOf(now(), stackId).rotate === false && ST.optionsOf(now(), stackId).smart === true, `${ST.membersOf(now(), stackId).join()} vs ${nextOrder}`);
  const bogus = [{ id: members[0], x: 0, y: 0, w: 4, h: 3, stack: 'bad id!' }, { id: 'wnope0001', stack: stackId }];
  await w.act(parse(`widget=${members[0]}&do=restack&s=${enc(bogus)}`));
  check('persistence: a bad stack id in a restack makes a plain widget; an unknown widget is ignored; the rest stays valid', !byId(now(), members[0]).stack && ST.membersOf(now(), stackId).length === 2 && now().filter((x) => x.stack === stackId && x.top).length === 1, JSON.stringify(now().map((x) => [x.id, x.stack, x.top])));
  const quiet = console.error;
  console.error = () => {};
  try {
    const page = w.forPage();
    const any = page.find((x) => x.stack);
    check('persistence: the page gets the stack id, its order, the shown member and the options', any && any.sid === stackId && Array.isArray(any.stack) && any.stack.length === 2 && any.rotate === false && any.smart === undefined, JSON.stringify(any && { sid: any.sid, stack: any.stack, rotate: any.rotate }));
    await new Promise((r) => setTimeout(r, 20));
  } finally { console.error = quiet; }
  const inStack = ST.membersOf(now(), stackId);
  await w.act(parse(`widget=${inStack[0]}&do=unstack`));
  check('persistence: taking the last-but-one out leaves two plain widgets (no stack fields left)', now().every((x) => !x.stack && !x.top && !('rotate' in x)), JSON.stringify(now().map((x) => [x.id, x.stack])));
  const oddSettings = cleanList([...N(4).map((x) => ({ ...x, rotate: false })), todo('wplain01', { x: 4, y: 0, w: 4, h: 3, rotate: false, smart: false })]);
  check('settings: stack options on a widget that is in no stack are dropped; on a stack they are kept', !('rotate' in byId(oddSettings, 'wplain01')) && oddSettings.filter((x) => x.stack).every((x) => x.rotate === false), '');

  // ---- round 2: the slide, the end of the stack, the starter stack ----
  let minCover = 9;
  for (let k = 0; k <= 1.0001; k += 0.02) minCover = Math.min(minCover, SM.coverage(k, 190));
  check('smart stack slide: the frame is never empty (coverage stays at or above 0.6 all the way)', minCover >= 0.6, String(minCover));
  const r2mid = SM.slide(0.5, 1, 200);
  check('smart stack slide: next goes up and out while the other comes up from below, edge to edge', r2mid.out.ty === -99 && r2mid.in.ty === 99 && SM.slide(0, 1, 200).out.ty === 0 && SM.slide(1, 1, 200).in.ty === 0 && SM.slide(1, 1, 200).out.ty === -198, JSON.stringify(r2mid));
  check('smart stack slide: previous mirrors it (down and out, in from above)', SM.slide(0.5, -1, 200).out.ty === 99 && SM.slide(0.5, -1, 200).in.ty === -99, '');
  check('smart stack slide: each card is clipped to the frame (the cut is where the other begins), and a card at rest is not clipped', r2mid.out.clip[0] > 90 && r2mid.out.clip[1] === 0 && r2mid.in.clip[1] > 90 && r2mid.in.clip[0] === 0 && SM.slide(0, 1, 200).out.clip.every((c) => c === 0), JSON.stringify(r2mid));
  check('smart stack slide: opacity overlaps and never drops below the floor; the outgoing card recedes a little', SM.slide(0.5, 1, 200).out.opacity >= SM.HOLD && SM.slide(1, 1, 200).out.opacity >= SM.HOLD && SM.slide(0, 1, 200).in.opacity >= SM.HOLD && SM.slide(1, 1, 200).out.scale < 1 && SM.slide(1, 1, 200).in.scale === 1, '');
  check('smart stack slide: Reduce motion crossfades with no movement', (() => { const f = SM.slide(0.5, 1, 200, true); return f.out.ty === 0 && f.in.ty === 0 && f.out.scale === 1 && f.out.opacity === 0.5 && f.in.opacity === 0.75 && SM.coverage(0.5, 200, true) >= 0.6; })(), '');
  check('smart stack end: the first card going back, or the last going forward, is an end', SM.atEnd(2, 3, 1) && SM.atEnd(0, 3, -1) && !SM.atEnd(1, 3, 1) && !SM.atEnd(1, 3, -1) && !SM.atEnd(0, 3, 1) && !SM.atEnd(0, 1, 1), '');
  check('smart stack end: the rubber band follows the hand at a fraction, grows with the pull and never reaches a card', SM.elastic(0.4) > 0 && SM.elastic(0.4) < 0.4 * 0.6 && SM.elastic(0.9) > SM.elastic(0.4) && SM.elastic(1) < 0.4 && SM.elastic(-0.5) === -SM.elastic(0.5) && SM.resist(0.5, false) === 0.5 && SM.resist(0.5, true) === SM.elastic(0.5), '');
  check('smart stack end: the elastic curve inverts (to take over a card in flight)', Math.abs(SM.unelastic(SM.elastic(0.6)) - 0.6) < 1e-9 && Math.abs(SM.unelastic(SM.elastic(-0.2)) + 0.2) < 1e-9 && Number.isFinite(SM.unelastic(0.9)), '');
  check('smart stack end: wrapping at an end needs a firmer pull (0.8 of a card) or a flick, elsewhere half a card', SM.settleTarget(0.6, 0, 120, true) === 0 && SM.settleTarget(0.85, 0, 120, true) === 1 && SM.settleTarget(0.6, 0, 120, false) === 1 && SM.settleTarget(0.1, 3000, 120, true) === 1 && SM.settleTarget(-0.6, 0, 120, true) === 0 && SM.settleTarget(-0.85, 0, 120, true) === -1, '');
  const r2kinds = ST.starterKinds(Date.UTC(2026, 9, 1, 12));
  check('smart stack starter: weather, a countdown to the next New Year and a note, no account or network', r2kinds.map((k) => k.type).join() === 'weather,countdown,notes' && r2kinds[0].wx.places.length === 1 && r2kinds[1].cd.date === '2027-01-01' && ST.starterKinds(Date.UTC(2026, 11, 31, 12))[1].cd.date === '2027-01-01', JSON.stringify(r2kinds));
  const r2made = r2kinds.map((k, i) => ({ id: `wst${i}0001`, ...k }));
  const r2exist = [{ id: 'wnote0001', type: 'notes', note: { text: '' }, x: 0, y: 0, w: 3, h: 3 }];
  const r2started = ST.starter(r2exist, r2made, WL, null);
  const sMembers = r2started.list.filter((w) => w.stack);
  check('smart stack starter: three widgets in one stack, the first shown, all at one free place of 3 by 3', sMembers.length === 3 && new Set(sMembers.map((w) => w.stack)).size === 1 && sMembers.filter((w) => w.top).map((w) => w.id).join() === 'wst00001' && new Set(sMembers.map((w) => `${w.x},${w.y},${w.w},${w.h}`)).size === 1 && sMembers[0].w === 3 && sMembers[0].h === 3 && !(sMembers[0].x === 0 && sMembers[0].y === 0) && r2started.id === 'wst00001', JSON.stringify(sMembers.map((w) => [w.id, w.x, w.y, w.w, w.h])));
  check('smart stack starter: refuses duplicates, a single widget and a full page', ST.starter(r2exist, [r2made[0]], WL, null) === null && ST.starter([{ id: 'wst00001', type: 'notes' }], r2made, WL, null) === null && ST.canStarter(r2exist, 24) && !ST.canStarter(Array.from({ length: 22 }, (_, i) => ({ id: `w${i}`, type: 'notes' })), 24), '');
  check('smart stack starter: the page action is allowed and the page files wire it (picker entry, panel opens when it lands)', /smartstack/.test(read('src/features/widgets.js')) && /smartstack/.test(read('src/renderer/newtab-edit.js')) && /expectNew/.test(read('src/renderer/newtab-edit.js')) && /openNew/.test(read('src/renderer/newtab-stacks.js')), '');
  const r2hubs = { size: { w: 300, h: 400 }, view: { w: 1000, h: 800 } };
  const r2own = { left: 100, top: 100, right: 420, bottom: 290 };
  const boxOf = (p) => ({ left: p.left, top: p.top, right: p.left + 300, bottom: p.top + 400 });
  const r2p1 = WE.placePanel({ ...r2hubs, own: r2own });
  check('edit panel placement: beside the stack (right first), top aligned, never over it', r2p1.side === 'right' && r2p1.left === 432 && r2p1.top === 100, JSON.stringify(r2p1));
  const r2p2 = WE.placePanel({ ...r2hubs, own: { left: 640, top: 100, right: 960, bottom: 290 } });
  check('edit panel placement: no room on the right, it goes left', r2p2.side === 'left' && r2p2.left === 328, JSON.stringify(r2p2));
  const r2wide = { left: 20, top: 100, right: 980, bottom: 290 };
  const r2p3 = WE.placePanel({ ...r2hubs, own: r2wide });
  check('edit panel placement: a stack as r2wide as the window, it goes below, not over it', WE.overlapArea(boxOf(r2p3), r2wide) === 0, JSON.stringify(r2p3));
  const r2neighbor = { left: 430, top: 90, right: 760, bottom: 420 };
  const r2p4 = WE.placePanel({ ...r2hubs, own: r2own, others: [r2neighbor] });
  check('edit panel placement: it takes the side that covers the fewest other cards', r2p4.side !== 'right' && WE.overlapArea(boxOf(r2p4), r2neighbor) === 0, JSON.stringify(r2p4));
  const r2lift = WE.placePanel({ size: { w: 300, h: 400 }, view: { w: 1000, h: 800 }, own: { left: 100, top: 380, right: 420, bottom: 570 }, avoid: [{ left: 300, top: 640, right: 984, bottom: 790 }], others: [{ left: 20, top: 200, right: 90, bottom: 700 }] });
  check('edit panel placement: the toolbar in the way, the panel lifts clear above it instead of covering a neighbor', r2lift.side === 'right' && r2lift.top + 400 <= 640, JSON.stringify(r2lift));
  const r2dock = { left: 560, top: 700, right: 984, bottom: 784 };
  const panelR = { left: 300, top: 400, right: 600, bottom: 780 };
  const toastBox = (t) => ({ left: t.left, top: t.top, right: t.left + 420, bottom: t.top + 40 });
  const r2t1 = WE.placeToast({ size: { w: 420, h: 40 }, view: { w: 1000, h: 800 }, obstacles: [r2dock], base: r2dock.top - 10 });
  check('toast placement: centered above the toolbar, clear of it', r2t1.left === 290 && r2t1.top === r2dock.top - 10 - 40 && WE.overlapArea(toastBox(r2t1), r2dock) === 0, JSON.stringify(r2t1));
  const r2t2 = WE.placeToast({ size: { w: 420, h: 40 }, view: { w: 1000, h: 800 }, obstacles: [r2dock, panelR], base: r2dock.top - 10 });
  check('toast placement: it never lands on the toolbar or the Edit stack panel', WE.overlapArea(toastBox(r2t2), r2dock) === 0 && WE.overlapArea(toastBox(r2t2), panelR) === 0 && r2t2.top >= 16, JSON.stringify(r2t2));
  check('picker: Smart Stack is offered first and only when asked', WE.pickerEntries({ types: ['weather'], hidden: [{ id: 'sys-x', label: 'X' }], stack: true })[0].kind === 'stack' && !WE.pickerEntries({ types: ['weather'], stack: false }).some((e) => e.kind === 'stack') && WE.pickerEntries({ types: [], stack: true }).length === 1, '');

  // ---- round 3: stacking is forgiving (sizes), the starter has something to rotate, smart rotate shows only when it can act, the slide is flush ----
  const rA = { id: 'wa000001', type: 'todoist', x: 0, y: 0, w: 4, h: 3 };
  const rB = { id: 'wb000001', type: 'notes', note: { text: '' }, x: 4, y: 0, w: 3, h: 3 };
  const rC = { id: 'wc000001', type: 'countdown', cd: { date: '2030-01-01', time: '', label: 'L' }, x: 7, y: 0, w: 2, h: 2 };
  const rMuse = { id: 'wm000001', type: 'muse', x: 0, y: 6, w: 4, h: 4 };
  const rList = [rA, rB, rC];
  check('stack sizes: different sizes cannot stack without the layout module (the old rule), any can with it', !ST.canStack(rList, 'wb000001', 'wa000001') && ST.canStack(rList, 'wb000001', 'wa000001', WL) && ST.stackBlock(rList, 'wb000001', 'wa000001') === 'size' && ST.stackBlock(rList, 'wb000001', 'wa000001', WL) === '', '');
  check('stack sizes: system cards, itself and the same stack are refused with a reason', ST.stackBlock([...rList, { id: 'sys-clock', type: 'sys-clock' }], 'sys-clock', 'wa000001', WL) === 'system' && ST.stackBlock(rList, 'wa000001', 'wa000001', WL) === 'missing', '');
  const rJ = ST.join(rList, 'wb000001', 'wa000001', WL);
  const rbJ = byId(rJ, 'wb000001');
  check('stack sizes: a widget of another size that joins adopts the stack size and remembers its own', rbJ.w === 4 && rbJ.h === 3 && rbJ.x === 0 && rbJ.y === 0 && rbJ.was.w === 3 && rbJ.was.h === 3 && byId(rJ, 'wa000001').was === undefined && rbJ.stack === byId(rJ, 'wa000001').stack, JSON.stringify(rbJ));
  const rJ3 = ST.join(rJ, 'wc000001', 'wa000001', WL);
  check('stack sizes: a smaller third widget adopts it too; the stack stays 4 by 3 and every member has the same cells', ['wa000001', 'wb000001', 'wc000001'].every((id) => byId(rJ3, id).w === 4 && byId(rJ3, id).h === 3 && byId(rJ3, id).x === 0) && byId(rJ3, 'wc000001').was.w === 2, '');
  const rStored = cleanList(rJ3);
  check('stack sizes: the stored list keeps the sizes, the remembered ones and one place for the stack', rStored.filter((w) => w.stack).every((w) => w.w === 4 && w.h === 3) && byId(rStored, 'wb000001').was.w === 3 && byId(rStored, 'wc000001').was.h === 2, JSON.stringify(rStored.map((w) => [w.id, w.w, w.h, w.was])));
  const rLeft = ST.leave(rStored, 'wb000001', WL);
  check('stack sizes: leaving restores the size it had, and forgets it', byId(rLeft, 'wb000001').w === 3 && byId(rLeft, 'wb000001').h === 3 && byId(rLeft, 'wb000001').was === undefined && !byId(rLeft, 'wb000001').stack && byId(rLeft, 'wa000001').w === 4, JSON.stringify(byId(rLeft, 'wb000001')));
  const rNoWas = cleanList(ST.leave(cleanList([{ ...rA, stack: 'sabcd1', top: true }, { ...rA, id: 'wz000001', type: 'notes', note: { text: '' }, stack: 'sabcd1' }, rC]), 'wz000001', WL));
  check('stack sizes: a member with no remembered size keeps the stack size when it leaves', byId(rNoWas, 'wz000001').w === 4 && byId(rNoWas, 'wz000001').h === 3, '');
  const rDrop = cleanList(ST.drop(rStored, 'wa000001').filter((w) => w.id !== 'wc000001'));
  check('stack sizes: when a stack falls to one widget it gets its own size back', !byId(rDrop, 'wb000001').stack && byId(rDrop, 'wb000001').w === 3 && byId(rDrop, 'wb000001').was === undefined, JSON.stringify(byId(rDrop, 'wb000001')));
  // a kind that cannot render at the stack's size: the whole stack goes to the nearest size everyone supports
  const rSmall = cleanList([{ ...rA, w: 2, h: 2 }, { ...rB, x: 4, y: 0, w: 2, h: 2 }, { ...rMuse, x: 0, y: 4 }]);
  const rMuseJoin = ST.join(rSmall, 'wm000001', 'wa000001', WL);
  const rMuseStored = cleanList(rMuseJoin);
  check('stack sizes: a kind that needs more (Muse is at least 3 by 3) raises the whole stack to the nearest size all support', ST.stackSize(rSmall, ['wa000001', 'wm000001'], { w: 2, h: 2 }, WL).w === 3 && ST.stackSize(rSmall, ['wa000001', 'wm000001'], { w: 2, h: 2 }, WL).h === 3 && rMuseStored.filter((w) => w.stack).length === 2 && rMuseStored.filter((w) => w.stack).every((w) => w.w === 3 && w.h === 3), JSON.stringify(rMuseStored.map((w) => [w.id, w.w, w.h, w.stack, w.was])));
  check('stack sizes: the members that grew remember their size, so they can leave at it', byId(rMuseStored, 'wa000001').was.w === 2 && byId(rMuseStored, 'wm000001').was.w === 4 && byId(rMuseStored, 'wm000001').was.h === 4, '');
  check('stack sizes: a full stack still says full', ST.stackBlock(cleanList(N(10)).concat([rA]), 'wa000001', 'wt0000', WL) === 'full', '');
  // Undo: the arrangement from before (what the page sends, do=restack) puts sizes back
  const rBefore = ST.snapshot(rList, ['wa000001', 'wb000001', 'wc000001']);
  const rUndone = cleanList(ST.restack(rStored, rBefore));
  check('stack sizes: Undo of the stacking puts every size, place and stack field back', rUndone.every((w) => !w.stack && !w.was) && byId(rUndone, 'wb000001').w === 3 && byId(rUndone, 'wb000001').x === 4 && byId(rUndone, 'wc000001').w === 2 && byId(rUndone, 'wa000001').w === 4, JSON.stringify(rUndone.map((w) => [w.id, w.x, w.y, w.w, w.h, w.stack])));
  const rLeaveBefore = ST.snapshot(rStored, ['wa000001', 'wb000001', 'wc000001']);
  const rRejoined = cleanList(ST.restack(rLeft, rLeaveBefore));
  check('stack sizes: Undo of leaving puts the stack back with the remembered sizes', byId(rRejoined, 'wb000001').stack === byId(rStored, 'wb000001').stack && byId(rRejoined, 'wb000001').w === 4 && byId(rRejoined, 'wb000001').was.w === 3, JSON.stringify(rLeaveBefore));
  check('stack sizes: the remembered size is checked (garbage is dropped)', ST.cleanFields({ stack: 'sabcd1', was: { w: 'x', h: 3 } }).was === undefined && ST.cleanFields({ stack: 'sabcd1', was: { w: 1, h: 3 } }).was === undefined && ST.cleanFields({ stack: 'sabcd1', was: { w: 3, h: 4 } }).was.h === 4 && ST.cleanFields({ was: { w: 3, h: 4 } }).was === undefined, '');

  // the starter: weather first (the user's own place when there is one), a countdown, notes
  const rDef = ST.starterKinds(Date.UTC(2026, 9, 1, 12), ST.starterWeather([], []));
  check('starter weather: no place anywhere gives the built-in default (no lookup), in Fahrenheit', rDef[0].type === 'weather' && rDef[0].wx.places[0].name === ST.DEFAULT_PLACE.name && Number.isFinite(rDef[0].wx.places[0].lat) && rDef[0].wx.units === 'f', JSON.stringify(rDef[0]));
  const rOwnW = ST.starterWeather([{ id: 'wo000001', type: 'weather', wx: { units: 'c', places: [{ name: 'Oslo', lat: 59.9, lon: 10.7 }, { name: 'Rome', lat: 41.9, lon: 12.5 }] } }], [{ name: 'Paris', lat: 48.8, lon: 2.3 }]);
  check('starter weather: an existing weather widget\'s place and units win', rOwnW.places.length === 1 && rOwnW.places[0].name === 'Oslo' && rOwnW.units === 'c', JSON.stringify(rOwnW));
  const rSavedW = ST.starterWeather([todo('wt000001')], [{ name: 'Paris', lat: 48.8, lon: 2.3 }]);
  check('starter weather: else the first place saved in Settings', rSavedW.places[0].name === 'Paris' && rSavedW.units === 'f', JSON.stringify(rSavedW));
  const rHere = ST.starterWeather([{ id: 'wo000001', type: 'weather', wx: { units: 'f', places: [{ here: true, name: 'My location' }] } }], []);
  check('starter weather: a "My location" widget carries over (it asks nothing new)', rHere.places[0].here === true, '');
  check('starter: the stack has a member smart rotate can act on (weather, countdown)', ST.canSmart(r2kinds.map((k) => k.type)) && ST.canSmart(['weather']), '');
  check('smart rotate visibility: weather, calendar or a countdown make it available; timer, notes, todo and the like do not', ST.canSmart(['notes', 'calendar']) && ST.canSmart(['countdown', 'timer']) && !ST.canSmart(['notes', 'timer', 'todoist']) && !ST.canSmart([]) && !ST.canSmart(undefined) && ST.SMART_TYPES.join() === 'weather,calendar,countdown', '');
  check('smart rotate: the starter\'s weather is what the morning shows (and nothing at 15:00)', SM.smartPick({ items: r2kinds.map((k, i) => ({ id: 'wst' + i, type: k.type, data: k.type === 'countdown' ? { target: Date.UTC(2027, 0, 1) } : {} })), now: Date.UTC(2026, 9, 1, 12), hour: 7, day: '2026-10-01' }).id === 'wst0' && SM.smartPick({ items: r2kinds.map((k, i) => ({ id: 'wst' + i, type: k.type, data: {} })), now: Date.UTC(2026, 9, 1, 12), hour: 15, day: '2026-10-01' }) === null, '');
  // flush slide
  let rGap = 0;
  for (const sign of [1, -1]) {
    for (let k = 0; k <= 1.0001; k += 0.01) {
      const f = SM.slide(Math.min(k, 1), sign, 240);
      const edge = (c) => [120 + c.ty - (c.scale * 240) / 2, 120 + c.ty + (c.scale * 240) / 2];
      const o = edge(f.out);
      const n = edge(f.in);
      rGap = Math.max(rGap, sign > 0 ? Math.abs(o[1] - n[0]) : Math.abs(n[1] - o[0]));
    }
  }
  check('smart stack slide: flush all the way, no gap between the outgoing and the incoming card', rGap < 1e-6, String(rGap));
  check('smart stack slide: the outgoing card recedes 2% at most', SM.slide(1, 1, 200).out.scale >= 0.98 && SM.slide(0.5, 1, 200).out.scale >= 0.98, String(SM.slide(1, 1, 200).out.scale));

  // the page files
  const r3src = read('src/renderer/newtab-stacks.js');
  const r3html = read('src/renderer/newtab.html');
  check('stack page: the card header\'s button is a "…" (opens Edit stack…), a right-click on the card opens the same menu as the rail', /ICON_MORE/.test(r3src) && /b\.append\(icon\(ICON_MORE\)\)/.test(r3src) && /card\.addEventListener\('contextmenu'/.test(r3src) && /function onCardMenu/.test(r3src), '');
  check('stack page: the panel shows Smart rotate only when a member can use it, else a hint', /ST\.canSmart\(/.test(r3src) && /newtab\.stack\.smart\.none/.test(r3src), '');
  check('stack page: the first-use pulse and peek (12%) run once per new stack, not with Reduce motion or Performance mode, and a swipe takes over', /const PEEK = 0\.12/.test(r3src) && /function playIntro/.test(r3src) && /introduced\.has/.test(r3src) && /reduced\(\) \|\| calm\(\)/.test(r3src) && /rail-intro/.test(r3html) && /prefers-reduced-motion: no-preference\) \{ body:not\(\.calm\) \.w-card\.rail-intro/.test(r3html), '');
  check('stack page: the drop and the panel use the layout module (any size stacks)', /ST\.canStack\(pageList\(\), id, onto, window\.WidgetLayout\)/.test(r3src) && !/it\.w !== me\.w/.test(read('src/renderer/newtab-widgets-grid.js')) && /ST\.join\(widgets, action\.id, action\.onto, WL\)/.test(read('src/features/widgets.js')), '');

  // ---- the page files ----
  const src = read('src/renderer/newtab-stacks.js');
  const html = read('src/renderer/newtab.html');
  const en = JSON.parse(read('src/locales/en.json'));
  const missing = Object.entries(WE.STRINGS).filter(([k, v]) => k.startsWith('newtab.stack.') && en[k] !== v).map(([k]) => k);
  check('smart stack page: every stack string is in en.json with the same English', missing.length === 0 && Object.keys(WE.STRINGS).filter((k) => k.startsWith('newtab.stack.')).length >= 30, missing.join());
  check('smart stack page: the stack is a group with a role description, a live region and labelled dot buttons', /setAttribute\('role', 'group'\)/.test(src) && /aria-roledescription/.test(src) && /aria-live/.test(src) && /w-stack-dot/.test(src) && /newtab\.stack\.dot/.test(src) && /aria-current/.test(src), '');
  check('smart stack page: keyboard (Up, Down, PageUp, PageDown, Home, End), wheel and touch are wired', /ArrowUp/.test(src) && /PageDown/.test(src) && /Home/.test(src) && /addEventListener\('wheel'/.test(src) && /pointerType === 'mouse'/.test(src), '');
  check('smart stack page: Reduce motion (crossfade, no auto-rotate), Performance mode and the hidden page are honored', /prefers-reduced-motion: reduce/.test(src) && /calm\(\)/.test(src) && /document\.hidden/.test(src) && /visibilitychange/.test(src), '');
  const drawSrc = src.slice(src.indexOf('function draw()'), src.indexOf('function stop()'));
  check('smart stack page: the card in flight moves with translate and opacity only, no layout properties', /style\.translate/.test(drawSrc) && /style\.opacity/.test(drawSrc) && !/style\.(top|left|right|bottom|width|height|margin|padding)/.test(drawSrc) && !/getBoundingClientRect|offsetHeight|offsetWidth/.test(drawSrc), '');
  check('smart stack page: only the shown card and its neighbors are drawn (content-visibility on the rest)', /w-under:not\(\.w-near\):not\(\.w-peek\) \{ content-visibility: hidden/.test(html) && /w-near/.test(src), '');
  check('smart stack page: Undo covers create, remove and reorder (the toast, kind stack)', /stackChanged/.test(src) && /stackChanged/.test(read('src/renderer/newtab-edit.js')) && /kind === 'stack'/.test(read('src/renderer/newtab-edit.js')) && /'restack'/.test(src), '');
  check('smart stack page: the new script loads before the page script that uses it', html.indexOf('widget-stack-motion.js') > 0 && html.indexOf('widget-stack-motion.js') < html.indexOf('src="newtab-stacks.js"') && !/<script[^>]+src="https?:/.test(html), '');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
