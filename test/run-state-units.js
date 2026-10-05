// reconcileAction (renderer/run-state.js): a stale Stop (the run ended while the sidebar was hidden) must be synced away.
const assert = require('assert');
const { reconcileAction } = require('../src/renderer/run-state');
assert.strictEqual(reconcileAction(null, 'a', true), 'keep');
assert.strictEqual(reconcileAction({}, 'a', true), 'keep');
assert.strictEqual(reconcileAction({ id: 'a', live: true }, 'a', true), 'keep');
assert.strictEqual(reconcileAction({ id: 'a', live: false }, 'a', false), 'keep');
assert.strictEqual(reconcileAction({ id: 'a', live: false }, 'a', true), 'sync', 'stale Stop: the run ended unseen');
assert.strictEqual(reconcileAction({ id: 'a', live: true }, 'a', false), 'sync', 'a run began unseen');
assert.strictEqual(reconcileAction({ id: 'b', live: true }, 'a', true), 'sync', 'another chat');
assert.strictEqual(reconcileAction({ id: 'a', live: false }, null, false), 'adopt');
assert.strictEqual(reconcileAction({ id: 'a', live: false }, null, true), 'sync');
console.log('run-state units passed');
