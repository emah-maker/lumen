// Site fixes under the ad blocker (features/adblock-lists.js SITE_FIXES): Paramount+ loads its Tealium tag (utag.js, which brings
// Adobe's alloy) only once OneTrust's consent check answers, and the lists block onetrust.com and stub utag.js, so the video
// player threw "alloy is not defined" and never showed. Let through on paramountplus.com only; ads stay blocked there and the
// same requests stay blocked on other sites. The blocking rules are the ones the current lists matched.
const assert = require('assert');
const { FiltersEngine, Request } = require('@ghostery/adblocker');
const { SITE_FIXES } = require('../../src/features/adblock-lists');

const LIST_RULES = [
  '||onetrust.com^$3p',
  '||geolocation.onetrust.com^$3p',
  '||tags.tiqcdn.com^$3p',
  '||tags.tiqcdn.com^$script,redirect-rule=noopjs,3p,domain=paramountplus.com',
  '||securepubads.g.doubleclick.net/tag/js/gpt.js$script',
  '||nr-data.net^$3p',
];
const PAGE = 'https://www.paramountplus.com/shows/video/4B0oh2vigLG5YiRMpnQUPRatzAift5bF/';
const blocked = (engine, type, url, sourceUrl = PAGE) => {
  const r = engine.match(Request.fromRawDetails({ type, url, sourceUrl }));
  return Boolean((r.match || r.redirect) && !r.exception);
};
const PLAYER_NEEDS = [
  ['xmlhttprequest', 'https://consent-api.onetrust.com/v2/preferences'],
  ['xmlhttprequest', 'https://geolocation.onetrust.com/cookieconsentpub/v1/geo/location'],
  ['script', 'https://tags.tiqcdn.com/utag/cbsi/pplus/prod/utag.js'],
  ['script', 'https://tags.tiqcdn.com/utag/cbsi/pplus/prod/utag.123.js'],
];

const before = FiltersEngine.parse(LIST_RULES.join('\n'));
for (const [type, url] of PLAYER_NEEDS) assert.ok(blocked(before, type, url), `the lists alone block it (the broken player): ${url}`);

const engine = FiltersEngine.parse([...LIST_RULES, ...SITE_FIXES].join('\n'));
for (const [type, url] of PLAYER_NEEDS) assert.ok(!blocked(engine, type, url), `Paramount+ loads it: ${url}`);

assert.ok(blocked(engine, 'script', 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'), 'ads stay blocked on Paramount+');
assert.ok(blocked(engine, 'xmlhttprequest', 'https://bam.nr-data.net/1/NRJS-x'), 'and other trackers');
assert.ok(blocked(engine, 'script', 'https://tags.tiqcdn.com/utag/other/site/prod/utag.js'), "another company's Tealium tag stays blocked");
for (const [type, url] of PLAYER_NEEDS) assert.ok(blocked(engine, type, url, 'https://news.example/'), `still blocked on other sites: ${url}`);

console.log('adblock-site-fixes-units: ok');
