// features/window-order.js: where an AI-made window comes up (behind the user's window, or minimized) and the options that keep it unowned.
const assert = require('assert');
const { behindPlan, independent } = require('../src/features/window-order');

const win = (o = {}) => ({ isDestroyed: () => Boolean(o.destroyed), isMinimized: () => Boolean(o.minimized) });
const self = win();

assert.strictEqual(behindPlan({ front: win(), self }), 'raise-front', 'the user is in a Lumen window: it goes back on top');
assert.strictEqual(behindPlan({ front: null, self }), 'minimize', 'the user is in another app: wait in the taskbar');
assert.strictEqual(behindPlan({ front: undefined, self }), 'minimize');
assert.strictEqual(behindPlan({ front: self, self }), 'minimize', 'the new window itself is focused: nothing to put in front of it');
assert.strictEqual(behindPlan({ front: win({ destroyed: true }), self }), 'minimize');
assert.strictEqual(behindPlan({ front: win({ minimized: true }), self }), 'minimize', 'a minimized front window would not cover anything');
assert.strictEqual(behindPlan(), 'minimize');

const o = independent({ width: 500, parent: { id: 1 }, modal: true, webPreferences: { sandbox: true } });
assert.deepStrictEqual(o, { width: 500, webPreferences: { sandbox: true } }, 'parent and modal are dropped, the rest kept');
assert.deepStrictEqual(independent({}), {});
assert.strictEqual(independent(undefined), undefined);
assert.strictEqual(independent(null), null);
const src = { parent: 1 };
independent(src);
assert.strictEqual(src.parent, 1, 'the caller\'s object is not changed');

console.log('window-order-units: ok');
