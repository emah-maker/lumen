// "Are you a person?" checks run under the ad blocker (features/adblock-lists.js HUMAN_CHECK_EXCEPTIONS): the privacy lists'
// rules that blocked PerimeterX's collector and a site's own init.js (Skyscanner's Press & Hold asked again forever) and
// DataDome are overridden, and ordinary trackers stay blocked. The blocking rules are the ones the current lists matched.
const assert = require('assert');
const { FiltersEngine, Request } = require('@ghostery/adblocker');
const { HUMAN_CHECK_EXCEPTIONS } = require('../../src/features/adblock-lists');

const LIST_RULES = [
  '||client.perimeterx.net^',
  '/(?:\\/_\\/api\\/v2\\/analytics\\/\\?)|(?:\\/analytics_v2\\.js)|(?:\\/api\\/v2\\/collector)/',
  '||skyscanner.*/rf8vapwa/init.js',
  '||datadome.co^$3p',
  '||google-analytics.com^',
  '||doubleclick.net^',
  '/analytics_v2.js',
];
const PAGE = 'https://www.skyscanner.com/sttc/px/captcha-v2/index.html';
const blocked = (engine, type, url, sourceUrl = PAGE) => {
  const r = engine.match(Request.fromRawDetails({ type, url, sourceUrl }));
  return Boolean(r.match && !r.exception);
};

const before = FiltersEngine.parse(LIST_RULES.join('\n'));
assert.ok(blocked(before, 'xmlhttprequest', 'https://collector-pxrf8vapwa.px-cloud.net/api/v2/collector'), 'the lists alone block the collector (the loop)');
assert.ok(blocked(before, 'script', 'https://www.skyscanner.com/rf8vapwA/init.js'), "and the site's own init.js");

const engine = FiltersEngine.parse([...LIST_RULES, ...HUMAN_CHECK_EXCEPTIONS].join('\n'));
const allowed = [
  ['script', 'https://client.perimeterx.net/PXrf8vapwA/main.min.js'],
  ['script', 'https://client.px-cloud.net/PXrf8vapwA/main.min.js'],
  ['xmlhttprequest', 'https://collector-pxrf8vapwa.px-cloud.net/api/v2/collector'],
  ['xmlhttprequest', 'https://collector-pxrf8vapwa.perimeterx.net/api/v2/collector'],
  ['script', 'https://www.skyscanner.com/rf8vapwA/init.js'],
  ['xmlhttprequest', 'https://www.skyscanner.com/rf8vapwA/xhr/api/v2/collector'],
  ['script', 'https://js.datadome.co/tags.js'],
  ['xmlhttprequest', 'https://api-js.datadome.co/js/'],
  ['script', 'https://ct.captcha-delivery.com/c.js'],
];
for (const [type, url] of allowed) assert.ok(!blocked(engine, type, url), `the human check loads: ${url}`);

const stillBlocked = [
  ['script', 'https://www.google-analytics.com/analytics.js'],
  ['script', 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'],
  ['script', 'https://example.com/static/analytics_v2.js'],
  ['xmlhttprequest', 'https://tracker.example/api/v2/collector'], // (another site's collector on a third-party host: no 8-character app-id path)
];
for (const [type, url] of stillBlocked) assert.ok(blocked(engine, type, url, 'https://news.example/'), `still blocked: ${url}`);

console.log('adblock-human-check-units: ok');
