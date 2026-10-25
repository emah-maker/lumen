// features/window-close.js: when a window's last tab closing takes the window with it, and the diagnostics breadcrumb.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lastTabClosesWindow, createLog } = require('../../src/features/window-close');

assert.strictEqual(lastTabClosesWindow({ closing: true }), true, 'Ctrl+W / the strip on the last tab closes the window');
assert.strictEqual(lastTabClosesWindow({ user: true }), true, 'a direct user close of a dead or sleeping tab does too');
assert.strictEqual(lastTabClosesWindow({}), false, 'a page that closed itself, or code, leaves a fresh tab');
assert.strictEqual(lastTabClosesWindow({ closing: true, aiClosing: true }), false, 'the AI closing the last tab never closes the window');
assert.strictEqual(lastTabClosesWindow({ user: true, aiClosing: true }), true, 'a user close is still the user\'s');
assert.strictEqual(lastTabClosesWindow({ closing: true, aiClosing: true, agent: true }), true, 'an agent window goes with its last tab');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winclose-'));
createLog({ dir: () => dir, version: '9.9.9' })({ event: 'window-closed', reason: 'user-closed-last-tab' });
setTimeout(() => {
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'window-events.jsonl'), 'utf8').trim());
  assert.strictEqual(line.reason, 'user-closed-last-tab');
  assert.strictEqual(line.v, '9.9.9');
  assert.ok(line.t);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('window-close units passed');
}, 300);
