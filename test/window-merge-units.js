// Merging windows (src/browser/window-merge.js) and the tab strip's multi-selection rules
// (src/renderer/tab-selection.js): pure planning, no Electron. Run from test/units.js, or alone with node.
const wm = require('../src/browser/window-merge');
const sel = require('../src/renderer/tab-selection');

module.exports = function windowMergeUnits(check) {
  const tab = (id, extra = {}) => ({ id, ...extra });
  const group = (id, name, extra = {}) => ({ id, name, color: 'blue', ...extra });
  // Three normal windows (ids 1-3), a private one (9) and the spare drag window (8).
  const make = () => [
    { id: 1, activeId: 12, tabs: [tab(10, { pinned: true }), tab(11), tab(12), tab(13)], groups: [] },
    { id: 2, activeId: 22, tabs: [tab(20, { pinned: true }), tab(21, { groupId: 7 }), tab(22, { groupId: 7 }), tab(23, { sleeping: true }), tab(24)], groups: [group(7, 'Research', { color: 'green', userNamed: true, collapsed: true })] },
    { id: 3, activeId: 33, tabs: [tab(30, { pinned: true }), tab(31, { pinned: true }), tab(32, { groupId: 5 }), tab(33), tab(34, { closing: true })], groups: [group(5, 'Shop', { colorLocked: true })] },
    { id: 9, private: true, activeId: 90, tabs: [tab(90), tab(91)], groups: [] },
    { id: 8, spare: true, activeId: null, tabs: [], groups: [] },
  ];

  // Applies a plan's moves the way main.js does (adoptTab's clamping), to see the strip it makes.
  const simulate = (windows, plan) => {
    const target = windows.find((w) => w.id === plan.targetId);
    const strip = target.tabs.filter((t) => !t.closing).map((t) => ({ id: t.id, pinned: Boolean(t.pinned) }));
    const info = new Map(windows.flatMap((w) => w.tabs.map((t) => [t.id, t])));
    for (const s of plan.sources) {
      for (const m of s.moves) {
        const t = info.get(m.id);
        const pinned = strip.filter((x) => x.pinned).length;
        const want = Number.isInteger(m.index) ? m.index : strip.length;
        const at = t.pinned ? Math.max(0, Math.min(want, pinned)) : Math.max(pinned, Math.min(want, strip.length));
        strip.splice(at, 0, { id: m.id, pinned: Boolean(t.pinned) });
      }
    }
    return strip.map((x) => x.id);
  };

  // ---- which windows take part
  check('merge: only normal windows are eligible (private, spare and still-restoring ones are not)',
    wm.eligibleWindows([...make(), { id: 4, busy: true, tabs: [tab(40)] }]).map((w) => w.id).join() === '1,2,3', '');
  check('merge: the window the command was given in is the target', wm.pickTarget(make(), { currentId: 2, focusedId: 3 }) === 2, '');
  check('merge: without a current window the focused one is the target', wm.pickTarget(make(), { currentId: 99, focusedId: 3 }) === 3, '');
  check('merge: failing both, the first window is the target', wm.pickTarget(make(), {}) === 1, '');
  check('merge: a private window as the current one is never the target', wm.pickTarget(make(), { currentId: 9 }) === 1, '');
  check('merge: one normal window beside a private one has nothing to merge', wm.pickTarget([make()[0], make()[3]], { currentId: 1 }) === null, '');
  check('merge into: lists the other normal windows in window order, never private or spare ones',
    wm.mergeIntoChoices(make(), 2).map((w) => w.id).join() === '1,3' && wm.mergeIntoChoices(make(), 9).length === 0, '');

  // ---- the plan
  {
    const windows = make();
    const plan = wm.planMerge(windows, 1);
    check('merge: every other normal window is a source, in window order; private and spare are not', plan.sources.map((s) => s.id).join() === '2,3', JSON.stringify(plan.sources.map((s) => s.id)));
    check('merge: the totals are windows and live tabs (closing ones are not counted)', plan.windowCount === 2 && plan.tabCount === 9, `${plan.windowCount} ${plan.tabCount}`);
    check('merge: no private tab is in any move', !plan.sources.some((s) => s.moves.some((m) => m.id === 90 || m.id === 91)), '');
    check('merge: a closing tab is not moved', !plan.sources.some((s) => s.moves.some((m) => m.id === 34)), '');
    const strip = simulate(windows, plan);
    check('merge: tabs append window by window, in strip order; pinned ones join the pinned run', strip.join() === '10,20,30,31,11,12,13,21,22,23,24,32,33', strip.join());
    check('merge: the target keeps its own active tab', plan.targetActiveId === 12, String(plan.targetActiveId));
    const second = plan.sources[0];
    check('merge: a source\'s active tab moves last (releasing it earlier would wake a neighbour)', second.moves[second.moves.length - 1].id === 22 && plan.sources[1].moves[plan.sources[1].moves.length - 1].id === 33, JSON.stringify(second.moves));
    check('merge: groups keep name, colour and collapsed state, with their members', JSON.stringify(second.groups) === JSON.stringify([{ ids: [21, 22], group: { name: 'Research', color: 'green', userNamed: true, colorLocked: false, collapsed: true } }]), JSON.stringify(second.groups));
    check('merge: another window\'s group keeps its locked colour', plan.sources[1].groups[0].group.colorLocked === true && plan.sources[1].groups[0].ids.join() === '32', JSON.stringify(plan.sources[1].groups));
    check('merge: pinned tabs are not put in groups', plan.sources.every((s) => s.groups.every((g) => g.ids.every((id) => ![10, 20, 30, 31].includes(id)))), '');
    check('merge: a sleeping tab is recorded as sleeping (Undo wakes nothing)', second.tabs.find((t) => t.id === 23).sleeping === true && second.tabs.find((t) => t.id === 21).sleeping === false, '');
  }
  {
    // The active tab out of order: an active tab in the middle of the pinned run and in the middle of the others.
    const windows = [
      { id: 1, activeId: 1, tabs: [tab(2, { pinned: true }), tab(1)], groups: [] },
      { id: 2, activeId: 52, tabs: [tab(50, { pinned: true }), tab(51, { pinned: true }), tab(52, { pinned: true }), tab(53), tab(54), tab(55)], groups: [] },
      { id: 3, activeId: 62, tabs: [tab(60), tab(61), tab(62), tab(63)], groups: [] },
    ];
    const plan = wm.planMerge(windows, 1);
    const strip = simulate(windows, plan);
    check('merge: an active pinned tab in the middle ends up in its place', strip.join() === '2,50,51,52,1,53,54,55,60,61,62,63', strip.join());
  }
  {
    const windows = make();
    const plan = wm.planMerge(windows, 1, { sourceIds: [3] });
    check('merge into: only the named window is merged', plan.sources.length === 1 && plan.sources[0].id === 3 && simulate(windows, plan).join() === '10,30,31,11,12,13,32,33', simulate(windows, plan).join());
    check('merge: a private window cannot be the target nor a named source',
      wm.planMerge(make(), 9) === null && wm.planMerge(make(), 1, { sourceIds: [9] }) === null, '');
    check('merge: nothing to do alone', wm.planMerge([make()[0]], 1) === null && wm.planMerge(make(), 99) === null, '');
    check('merge: a window with no tabs is skipped', wm.planMerge([make()[0], { id: 5, activeId: null, tabs: [], groups: [] }], 1) === null, '');
  }

  // ---- undo
  {
    const plan = wm.planMerge(make(), 1);
    const entries = plan.sources.map((s) => ({ ...s, bounds: { x: 10 * s.id, y: 0, width: 800, height: 600 } }));
    const live = [10, 11, 12, 13, 20, 21, 22, 23, 24, 30, 31, 32, 33];
    const back = wm.undoPlan(entries, live);
    check('undo: one window per merged window, in order, with its old bounds', back.length === 2 && back[0].id === 2 && back[0].bounds.x === 20 && back[1].bounds.x === 30, JSON.stringify(back.map((w) => w.id)));
    check('undo: tabs, pinned tabs and groups come back as they were', back[0].ids.join() === '20,21,22,23,24' && back[0].pinnedIds.join() === '20' && back[0].groups[0].ids.join() === '21,22' && back[0].groups[0].group.name === 'Research', JSON.stringify(back[0]));
    check('undo: the tab shown is the one that was active', back[0].lead === 22 && back[1].lead === 33, `${back[0].lead} ${back[1].lead}`);
    const partial = wm.undoPlan(entries, [10, 11, 12, 13, 20, 21, 23, 30]);
    check('undo: tabs closed since are left out of their windows and groups', partial[0].ids.join() === '20,21,23' && partial[0].groups[0].ids.join() === '21' && partial[1].ids.join() === '30', JSON.stringify(partial));
    check('undo: if the active tab is gone the first tab that is not asleep leads (nothing wakes)', partial[0].lead === 20 && wm.undoPlan([{ ...entries[0], tabs: [{ id: 23, sleeping: true }, { id: 24 }], activeId: 22 }], [23, 24, 1])[0].lead === 24, String(partial[0].lead));
    check('undo: a window whose tabs are all gone is skipped', wm.undoPlan(entries, [10, 11, 12, 13, 30, 31]).length === 1, '');
    const tight = wm.undoPlan(entries, [20, 21, 22, 23, 24, 30, 31, 32, 33]);
    check('undo: the window merged into always keeps a tab', tight.reduce((n, w) => n + w.ids.length, 0) <= 8 && tight.length >= 1, JSON.stringify(tight.map((w) => w.ids)));
  }

  // ---- the tab strip's selection (Chrome's rules)
  {
    const order = [1, 2, 3, 4, 5, 6];
    const click = (o) => sel.selectionAfterClick({ order, selected: [], anchorId: null, activeId: 2, id: 2, ...o });
    check('selection: shift+click selects the run from the active tab', JSON.stringify(click({ id: 5, shift: true }).selection) === '[2,3,4,5]' && click({ id: 5, shift: true }).activate === 5, '');
    check('selection: shift+click backwards selects the same run in strip order', JSON.stringify(click({ id: 1, shift: true }).selection) === '[1,2]', '');
    check('selection: the anchor is the tab last clicked, not the active one', JSON.stringify(click({ id: 6, shift: true, anchorId: 4 }).selection) === '[4,5,6]', '');
    check('selection: a missing anchor falls back to the active tab', JSON.stringify(click({ id: 3, shift: true, anchorId: 99 }).selection) === '[2,3]', '');
    check('selection: shift+click on a tab outside the strip keeps the selection', JSON.stringify(click({ id: 99, shift: true, selected: [1, 2] }).selection) === '[1,2]', '');
    check('selection: ctrl+click starts from the active tab and adds', JSON.stringify(click({ id: 4, toggle: true }).selection) === '[2,4]', '');
    check('selection: ctrl+click on a selected tab takes it out, and does not switch tabs', (() => { const r = click({ id: 4, toggle: true, selected: [2, 4, 5] }); return JSON.stringify(r.selection) === '[2,5]' && r.activate === null; })(), '');
    check('selection: the last selected tab stays selected', click({ id: 2, toggle: true, selected: [] }).activate === null && JSON.stringify(click({ id: 2, toggle: true, selected: [] }).selection) === '[]', '');
    check('selection: taking the active tab out hands over to the next selected one', (() => { const r = click({ id: 2, toggle: true, selected: [2, 4, 5] }); return JSON.stringify(r.selection) === '[4,5]' && r.activate === 4 && r.anchor === 4; })(), '');
    check('selection: with no later one it hands over to the one before', (() => { const r = click({ id: 5, toggle: true, selected: [2, 5], activeId: 5 }); return r.activate === 2 && JSON.stringify(r.selection) === '[2]'; })(), '');
    check('selection: a plain click ends the selection', (() => { const r = click({ id: 3, selected: [1, 2, 3] }); return r.selection.length === 0 && r.activate === 3 && r.anchor === 3; })(), '');
  }
};

if (require.main === module) {
  let failures = 0;
  module.exports((label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); });
  process.exit(failures ? 1 : 0);
}
