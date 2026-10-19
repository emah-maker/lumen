// Reopen Closed Tab restores pinned state, group, place and back/forward (features/closed-tabs.js), plain Node.
const fs = require('fs');
const path = require('path');
const { snapshot, placement, trimHistory, MAX_ENTRIES } = require('../src/features/closed-tabs');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);
const entries = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://a.test/${i}`, title: `p${i}`, extra: 1 }));

// ---- snapshot
check('snapshot keeps pinned, place and history', J(snapshot({ pinned: true, index: 2, history: { entries: entries(3), index: 1 } })) === J({ pinned: true, groupId: null, index: 2, history: { entries: entries(3).map(({ url, title }) => ({ url, title })), index: 1 } }));
check('snapshot: a grouped tab is not pinned', snapshot({ pinned: true, groupId: 'g1' }).pinned === false && snapshot({ groupId: 'g1' }).groupId === 'g1');
check('snapshot: bad input is a loose tab at 0 with no history', J(snapshot()) === J({ pinned: false, groupId: null, index: 0, history: null }) && snapshot({ index: -4 }).index === 0);

// ---- history
check('trimHistory: one entry or a bad index is no history', trimHistory({ entries: entries(1), index: 0 }) === null && trimHistory({ entries: entries(3), index: 5 }) === null && trimHistory(null) === null);
{
  const t = trimHistory({ entries: entries(200), index: 120 });
  check('trimHistory: long lists are cut around the current entry', t.entries.length === MAX_ENTRIES && t.entries[t.index].url === 'https://a.test/120', J({ n: t.entries.length, i: t.index }));
  const end = trimHistory({ entries: entries(200), index: 199 });
  check('trimHistory: at the end the window stays inside the list', end.entries.length === MAX_ENTRIES && end.entries[end.index].url === 'https://a.test/199');
  const start = trimHistory({ entries: entries(200), index: 0 });
  check('trimHistory: at the start too', start.index === 0 && start.entries[0].url === 'https://a.test/0');
}

// ---- placement
const strip = (count, pinned, groups = []) => ({ count, pinned, hasGroup: (id) => groups.includes(id) });
check('no record: the end of the strip, as before', J(placement(null, strip(4, 1))) === J({ pinned: false, groupId: null, at: 4 }));
check('a loose tab goes back to its place', placement(snapshot({ index: 2 }), strip(5, 0)).at === 2);
check('a loose tab never lands among the pinned', placement(snapshot({ index: 0 }), strip(5, 2)).at === 2);
check('a place past the end is clamped', placement(snapshot({ index: 9 }), strip(3, 0)).at === 3);
{
  const p = placement(snapshot({ pinned: true, index: 1 }), strip(5, 3));
  check('a pinned tab comes back pinned at its place', p.pinned && p.at === 1);
  const q = placement(snapshot({ pinned: true, index: 4 }), strip(5, 2));
  check('a pinned tab stays inside the pinned run', q.pinned && q.at === 2, J(q));
}
check('its group comes back when it still exists', placement(snapshot({ groupId: 'g1', index: 3 }), strip(5, 0, ['g1'])).groupId === 'g1');
{
  const p = placement(snapshot({ groupId: 'g1', index: 3 }), strip(5, 0, ['g2']));
  check('a group that is gone is left behind', p.groupId === null && p.pinned === false);
}

// ---- main.js uses it for every way of reopening
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
check('Ctrl+Shift+T, the menus and tab search all reopen through reopenClosedTab', !/openTab\(closedTabs\.pop\(\)\)/.test(main) && /reopenClosedTab\(url, closedInfo\.splice\(index, 1\)\[0\]\)/.test(main) && /reopenClosedTab\(closedTabs\.pop\(\), closedInfo\.pop\(\)\)/.test(main));
check('closedInfo is kept in step with closedTabs', (main.match(/closedInfo\.(push|splice)/g) || []).length >= 4);

process.exit(failures ? 1 : 0);
