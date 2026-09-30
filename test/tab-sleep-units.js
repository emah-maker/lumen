// Pure unit test for features/tab-sleep.js: sleep eligibility, the page check, wake plan, wake bounds.
const assert = require('assert');
const { keepReason, pageBusyScript, pageBusy, wakePlan, wakeBounds } = require('../src/features/tab-sleep');

const ok = { alive: true, webPage: true };
assert.strictEqual(keepReason(ok), null);
assert.strictEqual(keepReason(null), 'dead');
assert.strictEqual(keepReason({ ...ok, alive: false }), 'dead');
for (const [k, v, why] of [['sleeping', true, 'sleeping'], ['active', true, 'active'], ['settings', true, 'settings'], ['closing', true, 'closing'], ['unloadAsked', true, 'closing'], ['openPopups', 1, 'popups'],
  ['agentUsing', true, 'ai'], ['aiLock', true, 'ai'], ['loading', true, 'loading'], ['audible', true, 'audio'], ['fullscreen', true, 'fullscreen'], ['devTools', true, 'devtools'], ['capturing', true, 'capturing']]) {
  assert.strictEqual(keepReason({ ...ok, [k]: v }), why, k);
}
assert.strictEqual(keepReason({ alive: true, webPage: false }), 'internal');
assert.strictEqual(keepReason({ ...ok, openPopups: 0 }), null);

// The page answer: only an empty string lets the tab sleep (throw/timeout/non-string = keep).
assert.strictEqual(pageBusy(''), false);
for (const a of ['input', 'streaming', 'changing', undefined, null, true, 0]) assert.strictEqual(pageBusy(a), true);
const script = pageBusyScript(900);
assert.ok(script.includes('900') && script.includes('streaming') && script.includes('aria-busy'));
new Function(`return ${script}`); // parses

// Wake plan
const e = (url) => ({ url, title: '', pageState: 'x' });
const err = (u) => u.startsWith('lumen://error');
const good = { entries: [e('https://meta.ai/'), e('https://meta.ai/c/1')], index: 1 };
let p = wakePlan({ sleepUrl: 'https://meta.ai/c/1', history: good, isError: err });
assert.deepStrictEqual(p.restore, good);
assert.strictEqual(p.url, 'https://meta.ai/c/1');
// No history (session-restored tab) -> plain load.
assert.strictEqual(wakePlan({ sleepUrl: 'https://a.com/', history: null }).restore, null);
assert.strictEqual(wakePlan({ sleepUrl: 'https://a.com/', history: { entries: [], index: 0 } }).restore, null);
// Index out of range / entry without url -> plain load.
assert.strictEqual(wakePlan({ sleepUrl: 'https://a.com/', history: { entries: [e('https://a.com/')], index: 3 } }).restore, null);
assert.strictEqual(wakePlan({ sleepUrl: 'https://a.com/', history: { entries: [{}], index: 0 } }).restore, null);
// Slept on an error page: its active entry is the error page, so load the failed address instead.
p = wakePlan({ sleepUrl: 'https://down.test/', history: { entries: [e('https://a.com/'), e('lumen://error?url=x')], index: 1 }, isError: err });
assert.strictEqual(p.restore, null);
assert.strictEqual(p.url, 'https://down.test/');
// Active entry differs from the address -> plain load. Hash and trailing slash don't count.
assert.strictEqual(wakePlan({ sleepUrl: 'https://a.com/x', history: { entries: [e('https://a.com/y')], index: 0 } }).restore, null);
assert.ok(wakePlan({ sleepUrl: 'https://a.com/x#top', history: { entries: [e('https://a.com/x/')], index: 0 } }).restore);
assert.strictEqual(wakePlan({ sleepUrl: 'about:blank', history: { entries: [e('about:blank')], index: 0 } }).restore, null);
// An error entry behind the current one is dropped and the index follows.
p = wakePlan({ sleepUrl: 'https://a.com/', history: { entries: [e('lumen://error?x'), e('https://b.com/'), e('https://a.com/')], index: 2 }, isError: err });
assert.deepStrictEqual(p.restore.entries.map((x) => x.url), ['https://b.com/', 'https://a.com/']);
assert.strictEqual(p.restore.index, 1);
// Nothing at all: the new-tab fallback.
assert.strictEqual(wakePlan({ fallbackUrl: 'lumen://newtab' }).url, 'lumen://newtab');

// Bounds
assert.deepStrictEqual(wakeBounds({ x: 10, y: 80, width: 900, height: 700 }), { x: 10, y: 80, width: 900, height: 700 });
assert.deepStrictEqual(wakeBounds({ x: 0, y: 0, width: 0, height: 0 }), { x: 0, y: 0, width: 800, height: 600 });
assert.deepStrictEqual(wakeBounds(undefined), { x: 0, y: 0, width: 800, height: 600 });
assert.deepStrictEqual(wakeBounds({ x: 10, y: 80, width: 900, height: 700 }, { fullscreen: true, full: { width: 1920, height: 1080 } }), { x: 0, y: 0, width: 1920, height: 1080 });
console.log('tab-sleep units OK');
