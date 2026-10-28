// Sites with a half-built dark mode get the light page in a dark theme (features/site-light.js).
const assert = require('assert');
const { LIGHT_SITES, isLightSite, schemeFor, watcher } = require('../../src/features/site-light');

assert.ok(LIGHT_SITES.includes('glassdoor.com'));
assert.strictEqual(isLightSite('https://www.glassdoor.com/Reviews/index.htm'), true, 'www. is the site');
assert.strictEqual(isLightSite('https://glassdoor.com/'), true);
assert.strictEqual(isLightSite('https://www.glassdoor.co.uk/Job/index.htm'), true, 'a country site too');
assert.strictEqual(isLightSite('https://notglassdoor.com/'), false, 'a name that only ends the same is not the site');
assert.strictEqual(isLightSite('https://glassdoor.com.evil.example/'), false);
assert.strictEqual(isLightSite('https://example.com/?u=glassdoor.com'), false, 'the address, not its query');
assert.strictEqual(isLightSite('not a url'), false);
assert.strictEqual(isLightSite(''), false);

assert.strictEqual(schemeFor('https://www.glassdoor.com/', true), 'light', 'dark theme: told light');
assert.strictEqual(schemeFor('https://www.glassdoor.com/', false), '', 'light theme: nothing to change');
assert.strictEqual(schemeFor('https://example.com/', true), '', 'every other site follows the theme');

(async () => {
  const sent = [];
  let dark = true;
  const update = watcher(async (method, params) => { sent.push([method, params]); }, () => dark);
  assert.strictEqual(await update('https://example.com/'), false, 'a site that follows the theme: no command');
  assert.strictEqual(await update('https://www.glassdoor.com/'), true);
  assert.deepStrictEqual(sent.pop(), ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }]);
  assert.strictEqual(await update('https://www.glassdoor.com/Reviews'), false, 'still on the site: nothing sent again');
  assert.strictEqual(await update('https://example.com/'), true, 'leaving it clears the override');
  assert.deepStrictEqual(sent.pop(), ['Emulation.setEmulatedMedia', { features: [] }]);
  await update('https://www.glassdoor.com/');
  dark = false;
  assert.strictEqual(await update('https://www.glassdoor.com/'), true, 'the theme turned light: the override goes');
  assert.deepStrictEqual(sent.pop(), ['Emulation.setEmulatedMedia', { features: [] }]);
  const failing = watcher(async () => { throw new Error('detached'); }, () => true);
  assert.strictEqual(await failing('https://www.glassdoor.com/'), false, 'a debugger that is gone is not an error');
  console.log('site-light-units: ok');
})().catch((e) => { console.error(e); process.exit(1); });
