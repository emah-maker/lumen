// Per-tab address-bar drafts (src/renderer/omnibox-draft.js): pure logic, no Electron. Run from test/units.js, or alone with node.
const assert = require('assert');
const { createDraftStore } = require('../src/renderer/omnibox-draft');

const s = createDraftStore();
// Typed text is kept per tab, with selection and focus.
assert.strictEqual(s.save(1, { value: 'hello wor', start: 2, end: 5, focused: true }, 'example.com'), true);
assert.deepStrictEqual(s.get(1), { text: 'hello wor', start: 2, end: 5, focused: true });
assert.strictEqual(s.get(2), null, 'a tab without a draft shows its URL');
// Tabs do not share drafts.
s.save(2, { value: 'other', start: 5, end: 5, focused: false }, 'b.com');
assert.strictEqual(s.get(1).text, 'hello wor');
assert.strictEqual(s.get(2).focused, false);
// Returned drafts are copies.
s.get(1).text = 'x';
assert.strictEqual(s.get(1).text, 'hello wor');
// Text equal to the tab's shown URL is not a draft (and removes an older one).
assert.strictEqual(s.save(1, { value: 'example.com', start: 0, end: 0, focused: true }, 'example.com'), false);
assert.strictEqual(s.has(1), false);
// Selection is clamped; a missing one goes to the end.
s.save(3, { value: 'abc', start: -4, end: 99, focused: false }, '');
assert.deepStrictEqual(s.get(3), { text: 'abc', start: 0, end: 3, focused: false });
s.save(3, { value: 'abcd', focused: false }, '');
assert.deepStrictEqual([s.get(3).start, s.get(3).end], [4, 4]);
// An empty field is a draft when the tab shows a URL (the user cleared it).
assert.strictEqual(s.save(4, { value: '', start: 0, end: 0, focused: true }, 'a.com'), true);
// Bad input is ignored.
assert.strictEqual(s.save(null, { value: 'x' }, ''), false);
assert.strictEqual(s.save(5, null, ''), false);
// clear and prune (closed tabs).
s.clear(2);
assert.strictEqual(s.has(2), false);
s.prune([4]);
assert.deepStrictEqual([s.has(3), s.has(4), s.size], [false, true, 1]);
console.log('omnibox-draft-units: ok');
