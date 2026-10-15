// features/newtab-images.js: the rules for pictures in the new-tab Ask AI box (what is accepted, the limits, what main keeps of a call).
const assert = require('assert');
const R = require('../src/features/newtab-images');

assert.strictEqual(R.MAX_IMAGES, 10);
assert.strictEqual(R.MAX_BYTES, 25 * 1024 * 1024);

// The type: from the MIME type, else (some systems give a dropped photo none) from the name; a stated non-picture type is not rescued by its name.
assert.strictEqual(R.typeOf({ type: 'image/png', name: 'a' }), 'image/png');
assert.strictEqual(R.typeOf({ type: '', name: 'Photo.JPG' }), 'image/jpeg');
assert.strictEqual(R.typeOf({ type: 'text/plain', name: 'a.png' }), '');
assert.strictEqual(R.typeOf({ type: 'image/heic', name: 'a.heic' }), '', 'HEIC is refused here as in the chat');
assert.strictEqual(R.typeOf({ type: '', name: 'notes.txt' }), '');

// plan: takes pictures up to the limit and says what it left out.
const pic = (name, size = 100, type = 'image/png') => ({ name, type, size });
let p = R.plan(0, [pic('a.png'), pic('b.png', 0), pic('c.txt', 10, 'text/plain'), pic('d.png', R.MAX_BYTES + 1)]);
assert.deepStrictEqual(p.take.map((t) => t.file.name), ['a.png']);
assert.deepStrictEqual(p.problems.map((x) => x.code), ['empty', 'notImage', 'big']);
p = R.plan(8, [pic('a.png'), pic('b.png'), pic('c.png'), pic('d.png')]);
assert.strictEqual(p.take.length, 2);
assert.deepStrictEqual(p.problems, [{ code: 'limit', name: '2' }]);
assert.strictEqual(R.plan(10, [pic('a.png')]).take.length, 0);

// clean: main keeps only well-formed pictures, at most ten, as Buffers.
const bytes = (n) => new Uint8Array(n).fill(7);
const cleaned = R.clean([
  { type: 'image/png', data: bytes(4).buffer, name: 'a.png' },
  { type: 'image/jpeg', data: bytes(3), name: 5 },
  { type: 'text/html', data: bytes(3) }, { type: 'image/png', data: bytes(0) }, { type: 'image/png', data: 'str' }, null, { type: 'image/gif' },
]);
assert.strictEqual(cleaned.length, 2);
assert.ok(Buffer.isBuffer(cleaned[0].data) && cleaned[0].data.length === 4 && cleaned[0].name === 'a.png');
assert.strictEqual(cleaned[1].name, '');
assert.strictEqual(R.clean(Array.from({ length: 15 }, () => ({ type: 'image/png', data: bytes(2) }))).length, 10);
assert.deepStrictEqual(R.clean('nope'), []);

console.log('PASS  newtab-images-units');
