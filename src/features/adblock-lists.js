// Where the ad blocker's filter lists come from (used by features/adblock.js and adblock-worker.js).
//
// @ghostery/adblocker's own "prebuilt" lists are snapshots in its source repository, refreshed by a bot
// that can stall (it stopped in mid-August 2026 while uBlock's lists kept moving; YouTube changes weekly),
// and its list set ends at filters-2024 (uBlock rotates old rules into a new dated file each year, so
// every newer rule, YouTube's included, was missing). Ghostery's CDN carries the same lists, current to
// the day, with a revision history per list; the newest revision is used here, with the dated files
// picked up by year, and the scriptlet/redirect resources from the same place.
const CDN = 'https://cdn.ghostery.com/adblocker/resources';
// A test run (never a packaged Lumen: test-mode.isTest is false there) can point the lists at a stand-in server on this machine,
// LUMEN_TEST_ADBLOCK_CDN=http://127.0.0.1:<port>, so a first start's list build needs no real network.
function cdn() {
  const stand = process.env.LUMEN_TEST_ADBLOCK_CDN;
  return stand && /^http:\/\/127\.0\.0\.1:\d+$/.test(stand) && require('../test-mode').isTest() ? stand : CDN;
}

// Ghostery's "full" set (ads, tracking, annoyances/cookies) by CDN name.
const CORE = [
  'easylist', 'plowe-0', 'ublock-badware',
  'ublock-filters-2020', 'ublock-filters-2021', 'ublock-filters-2022', 'ublock-filters-2023', 'ublock-filters-2024',
  'ublock-filters', 'ublock-quick-fixes', 'ublock-abuse', 'ublock-unbreak',
  'easyprivacy', 'ublock-privacy', 'easylist-cookie', 'ublock-annoyances-others', 'ublock-annoyances-cookies',
];
// uBlock starts a new dated file each January; one that doesn't exist yet is skipped.
const FIRST_OPTIONAL_YEAR = 2025;
const LAST_OPTIONAL_YEAR = 2030;
const RESOURCES = 'ublock-resources-json';
// Written beside the saved engine: which source built it. An engine from the older snapshot lists is replaced
// at the first refresh, however recent the file is.
const SOURCE = 'ghostery-cdn-1';

function optionalLists() {
  const out = [];
  for (let year = FIRST_OPTIONAL_YEAR; year <= LAST_OPTIONAL_YEAR; year++) out.push(`ublock-filters-${year}`);
  return out;
}

async function get(fetchImpl, url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return res;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }
  throw last;
}

// The newest revision's text of one list (or of the resources), null if the list doesn't exist.
async function latest(fetchImpl, name) {
  const meta = await get(fetchImpl, `${cdn()}/${name}/metadata.json`);
  if (!meta) return null;
  const { revisions } = await meta.json();
  const revision = revisions?.[revisions.length - 1];
  if (!revision) return null;
  const res = await get(fetchImpl, `${cdn()}/${name}/${revision}/list.txt`);
  return res ? res.text() : null;
}

// { lists: string[], resources: string }. A core list that can't be fetched fails the whole thing: the caller
// falls back to the library's own prebuilt lists rather than run with a gap in the middle of the set.
async function fetchSources(fetchImpl = fetch) {
  const [core, optional, resources] = await Promise.all([
    Promise.all(CORE.map((name) => latest(fetchImpl, name).then((text) => {
      if (text === null) throw new Error(`list ${name} is missing`);
      return text;
    }))),
    Promise.all(optionalLists().map((name) => latest(fetchImpl, name).catch(() => null))),
    latest(fetchImpl, RESOURCES),
  ]);
  if (!resources) throw new Error('resources are missing');
  return { lists: [...core, ...optional.filter(Boolean)], resources };
}

// A new engine of class `Engine` (FiltersEngine or ElectronBlocker) from the current lists.
async function buildEngine(Engine, fetchImpl = fetch) {
  const { lists, resources } = await fetchSources(fetchImpl);
  const engine = Engine.parse(lists.join('\n'), {});
  engine.updateResources(resources, `${resources.length}`);
  return engine;
}

// The same, falling back to the library's snapshot lists (stale, but better than none) when the CDN can't be reached.
// Returns { engine, source }: `source` is SOURCE for current lists, 'fallback' otherwise.
async function buildEngineOrFallback(Engine, fetchImpl = fetch) {
  try {
    return { engine: await buildEngine(Engine, fetchImpl), source: SOURCE };
  } catch (err) {
    console.error('[lumen] ad-block lists (Ghostery CDN):', err?.message || err);
    return { engine: await Engine.fromPrebuiltFull(fetchImpl), source: 'fallback' };
  }
}

// "Are you a person?" checks (PerimeterX's Press & Hold, DataDome) must be able to run: the privacy lists block their scripts
// and the endpoint the result is sent to (PerimeterX's .../api/v2/collector, a site's own /<app id>/init.js), so a person who
// held the button was never let through and the page asked again, forever (Skyscanner). Added to every engine (features/adblock.js
// ENGINE_PATCH). The first-party rule covers PerimeterX's own path shape only: an 8-character app id, then init.js, xhr/ or captcha/.
const HUMAN_CHECK_EXCEPTIONS = [
  '@@||px-cloud.net^',
  '@@||perimeterx.net^',
  '@@||px-cdn.net^',
  '@@||pxchk.net^',
  '@@||datadome.co^',
  '@@||captcha-delivery.com^',
  '@@/^https?:\\/\\/[^/]+\\/[A-Za-z0-9]{8}\\/(?:init\\.js|xhr\\/|captcha\\/)/$script,xhr,1p',
];

// Sites whose player waits on scripts the privacy lists block, let through on that site only (features/adblock.js ENGINE_PATCH).
// Paramount+: the page loads its Tealium tag (utag.js, which brings Adobe's alloy) only once OneTrust's consent check answers;
// the lists block onetrust.com and stub utag.js, so alloy was never defined and the video player threw before it showed.
const SITE_FIXES = [
  '@@||onetrust.com^$domain=paramountplus.com',
  '@@||tags.tiqcdn.com/utag/cbsi/$script,domain=paramountplus.com',
];

module.exports = { CDN, CORE, SOURCE, HUMAN_CHECK_EXCEPTIONS, SITE_FIXES, optionalLists, fetchSources, buildEngine, buildEngineOrFallback };
