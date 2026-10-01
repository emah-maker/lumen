// Pure unit test for features/overlay-order.js: which floating views get re-added.
const assert = require('assert');
const { overlaysToRaise } = require('../src/features/overlay-order');

const [ui, tab1, tab2, sp, sug, dl, tool] = ['ui', 'tab1', 'tab2', 'sp', 'sug', 'dl', 'tool'];
const order = [sp, sug, dl, tool];

// In order, above every tab: nothing to do.
assert.deepStrictEqual(overlaysToRaise([ui, tab1, tab2, sp, sug, dl, tool], [tab1, tab2], order), []);
// No overlays showing.
assert.deepStrictEqual(overlaysToRaise([ui, tab1], [tab1], []), []);
// A new tab lands on top: every overlay is re-added, in the fixed order.
assert.deepStrictEqual(overlaysToRaise([ui, tab1, sp, sug, dl, tool, tab2], [tab1, tab2], order), order);
// Only one is below the tab: still all of them (suggestions/downloads must not swap).
assert.deepStrictEqual(overlaysToRaise([ui, sug, tab1, dl], [tab1], [sug, dl]), [sug, dl]);
// Above the tab but out of order among themselves.
assert.deepStrictEqual(overlaysToRaise([ui, tab1, dl, sug], [tab1], [sug, dl]), [sug, dl]);
// A subset (visible ones only) keeps its order.
assert.deepStrictEqual(overlaysToRaise([ui, sug, tab1], [tab1], [sug, tool]), [sug, tool]);
console.log('overlay-order units OK');
