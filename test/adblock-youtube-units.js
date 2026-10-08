// YouTube ad blocking, pure Node (no window, no network): where the filter lists come from (features/adblock-lists.js:
// newest revision of each list, the dated uBlock files by year, failing safe), the extra YouTube hiding rules and
// the fallback script (features/adblock-youtube.js), and that the engine picks the right rules for YouTube hosts.
const vm = require('vm');
const { FiltersEngine } = require('@ghostery/adblocker');
const { parse } = require('tldts-experimental');
const L = require('../src/features/adblock-lists');
const Y = require('../src/features/adblock-youtube');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

// A fake CDN: lists by name with revisions (oldest first); `missing` names answer 404, `broken` names answer 500.
function fakeCdn({ revisions = {}, missing = [], broken = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const m = url.match(/resources\/([^/]+)\/(metadata\.json|([0-9a-f]+)\/list\.txt)$/);
    const res = (status, body) => ({ status, ok: status < 400, json: async () => JSON.parse(body), text: async () => body });
    if (!m) return res(404, '');
    const [, name, tail, rev] = m;
    if (missing.includes(name)) return res(404, '');
    if (broken.includes(name)) return res(500, '');
    const revs = revisions[name] || ['aa01', 'bb02'];
    if (tail === 'metadata.json') return res(200, JSON.stringify({ name, revisions: revs }));
    if (name === 'ublock-resources-json') return res(200, JSON.stringify({ scriptlets: [], redirects: [] }));
    return res(200, `! ${name} @ ${rev}\nexample-${name}.test##.ad-${rev}\n`);
  };
  return { fetchImpl, calls };
}

(async () => {
  // ---- Lists
  check('lists: Ghostery\'s snapshot set ended at 2024, so the dated uBlock files from 2025 on are asked for', L.optionalLists().includes('ublock-filters-2025') && L.optionalLists().includes('ublock-filters-2026'), L.optionalLists());
  check('lists: the core set has uBlock\'s filters, quick-fixes and unbreak, and EasyList', ['ublock-filters', 'ublock-quick-fixes', 'ublock-unbreak', 'easylist'].every((n) => L.CORE.includes(n)), L.CORE);

  const cdn = fakeCdn({ revisions: { 'ublock-quick-fixes': ['a1', 'a2', 'a3'] }, missing: ['ublock-filters-2028', 'ublock-filters-2029', 'ublock-filters-2030'] });
  const src = await L.fetchSources(cdn.fetchImpl);
  check('lists: the newest revision of a list is the one fetched', src.lists.some((t) => t.includes('ublock-quick-fixes @ a3')) && !src.lists.some((t) => t.includes('@ a1')), src.lists.map((t) => t.split('\n')[0]));
  check('lists: dated files that exist are included, ones that don\'t yet exist are skipped', src.lists.some((t) => t.includes('ublock-filters-2026 @')) && !src.lists.some((t) => t.includes('ublock-filters-2028')), src.lists.length);
  check('lists: every core list is in, and the resources come with them', src.lists.length >= L.CORE.length + 2 && typeof src.resources === 'string', src.lists.length);

  const missingCore = fakeCdn({ missing: ['ublock-quick-fixes'] });
  check('lists: a missing core list fails the whole fetch (the caller falls back), rather than build with a gap', await L.fetchSources(missingCore.fetchImpl).then(() => false, () => true), 'resolved');
  const brokenOptional = fakeCdn({ broken: ['ublock-filters-2027'] });
  const withBroken = await L.fetchSources(brokenOptional.fetchImpl).catch((e) => e);
  check('lists: an optional dated file that errors is skipped, not fatal', Array.isArray(withBroken.lists), withBroken);
  const noResources = fakeCdn({ missing: ['ublock-resources-json'] });
  check('lists: missing scriptlet resources also fail the fetch', await L.fetchSources(noResources.fetchImpl).then(() => false, () => true), 'resolved');

  const engine = await L.buildEngine(FiltersEngine, cdn.fetchImpl);
  const css = engine.getCosmeticsFilters({ url: 'https://example-ublock-filters.test/', hostname: 'example-ublock-filters.test', domain: 'example-ublock-filters.test', getBaseRules: false, getInjectionRules: false, getExtendedRules: false, getRulesFromHostname: true, getRulesFromDOM: false }).styles;
  check('lists: the engine built from them holds the fetched rules', css.includes('.ad-bb02'), css);

  // ---- YouTube hiding rules
  const yt = FiltersEngine.parse(Y.YOUTUBE_FILTERS.join('\n'), {});
  const stylesFor = (url) => {
    const { hostname, domain } = parse(url);
    return yt.getCosmeticsFilters({ url, hostname, domain, getBaseRules: false, getInjectionRules: false, getExtendedRules: true, getRulesFromHostname: true, getRulesFromDOM: false });
  };
  const home = stylesFor('https://www.youtube.com/');
  const all = `${home.styles}\n${(home.extended || []).map((e) => e.selector || '').join('\n')}`;
  check('youtube rules: every line is accepted as a cosmetic rule', Y.YOUTUBE_FILTERS.every((l) => /^youtube(-nocookie)?\.com##\S/.test(l)) && home.styles.length > 200, home.styles.length);
  for (const sel of ['ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', 'ytd-display-ad-renderer', 'ytd-promoted-sparkles-web-renderer', 'ytd-banner-promo-renderer', 'ytd-enforcement-message-view-model', '#masthead-ad', '.ytp-ad-overlay-container', 'ytd-reel-video-renderer:has(ytd-ad-slot-renderer)']) {
    check(`youtube rules: ${sel} is hidden`, all.includes(sel), 'missing');
  }
  check('youtube rules: they apply on m.youtube.com, and an embed gets the on-video banner rule', stylesFor('https://m.youtube.com/').styles.includes('ytd-ad-slot-renderer') && stylesFor('https://www.youtube-nocookie.com/embed/x').styles.includes('.ytp-ad-overlay-container'), stylesFor('https://www.youtube-nocookie.com/embed/x').styles.slice(0, 80));
  check('youtube rules: nothing is hidden on other sites', stylesFor('https://example.com/').styles === '' && stylesFor('https://notyoutube.com/').styles === '', stylesFor('https://notyoutube.com/').styles.slice(0, 80));
  check('youtube rules: the player and the sign-in surfaces are not hidden', !/#player-ads|#movie_player|\.video-ads|credential_picker|accounts\.google/.test(Y.YOUTUBE_FILTERS.join('\n')), 'a protected surface is in the rules');

  // ---- Which pages get the fallback script
  const base = ['x'];
  const yes = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com'];
  const no = ['example.com', 'notyoutube.com', 'youtube.com.evil.org', 'youtube.co', 'accounts.google.com', ''];
  check('fallback: added on YouTube hosts and embeds', yes.every((h) => Y.withFallback(base, h).length === 2 && Y.withFallback(base, h)[1] === Y.FALLBACK_SCRIPT), 'a host missed');
  check('fallback: not added anywhere else (look-alike hosts included)', no.every((h) => Y.withFallback(base, h) === base), no.filter((h) => Y.withFallback(base, h).length !== 1));

  // ---- The fallback script, run against a stand-in page
  function page({ adShowing, hasSkip = false, duration = 20, wall = false, muted = false, rate = 1 }) {
    const log = { clicks: [], played: 0, timers: [], timeouts: [], observers: [], cleared: 0 };
    const video = { duration, currentTime: 0, playbackRate: rate, muted, paused: wall, ended: false, play() { log.played++; this.paused = false; return Promise.resolve(); } };
    const skipButton = { click() { log.clicks.push('skip'); } };
    const classes = new Set(adShowing ? ['html5-video-player', 'ad-showing'] : ['html5-video-player']);
    const player = {
      classList: { contains: (c) => classes.has(c) },
      querySelector: (sel) => (/video/.test(sel) && !/skip/.test(sel) ? video : /skip/.test(sel) ? (hasSkip ? skipButton : null) : null),
    };
    const state = { wall };
    const document = {
      body: { style: { removeProperty() {} } },
      documentElement: {},
      addEventListener() {},
      getElementById: (id) => (id === 'movie_player' ? player : null),
      querySelector: (sel) => (sel === 'ytd-enforcement-message-view-model' ? (state.wall ? {} : null) : sel === 'video.html5-main-video' ? video : player),
    };
    class FakeObserver { constructor(fn) { log.observers.push(fn); } observe() {} }
    const ctx = vm.createContext({ document, MutationObserver: FakeObserver, setInterval: (fn) => { log.timers.push(fn); return log.timers.length; }, clearInterval: (id) => { log.timers[id - 1] = null; log.cleared++; }, setTimeout: (fn) => { log.timeouts.push(fn); return log.timeouts.length; }, isFinite });
    vm.runInContext(Y.FALLBACK_SCRIPT, ctx);
    return { log, video, classes, state, tick: () => { log.observers.forEach((f) => f()); log.timeouts.splice(0).forEach((f) => f()); log.timers.forEach((f) => f && f()); }, live: () => log.timers.filter(Boolean).length };
  }
  const idle = page({ adShowing: false });
  idle.tick(); idle.tick();
  check('fallback script: watches the page with an observer, starts no timer and leaves the page alone when no ad is showing', idle.log.timers.length === 0 && idle.log.observers.length === 1 && idle.video.playbackRate === 1 && idle.video.muted === false && idle.video.currentTime === 0 && !idle.log.clicks.length, JSON.stringify(idle.video));
  const ad = page({ adShowing: true, hasSkip: true });
  ad.tick();
  check('fallback script: during an ad it presses Skip, mutes, speeds up and runs the ad to its end', ad.log.clicks.includes('skip') && ad.video.muted === true && ad.video.playbackRate === 16 && ad.video.currentTime > 19, JSON.stringify([ad.log.clicks, ad.video]));
  check('fallback script: the quick 300 ms timer runs only while an ad is showing', ad.live() === 1, ad.live());
  ad.classes.delete('ad-showing');
  ad.video.duration = 600; ad.tick();
  check('fallback script: and is cleared when the ad is over', ad.live() === 0 && ad.log.cleared === 1, ad.live());
  check('fallback script: when the ad is over, the video\'s own speed and sound are put back and its position is left alone', ad.video.playbackRate === 1 && ad.video.muted === false && ad.video.currentTime < 25, JSON.stringify(ad.video));
  const loud = page({ adShowing: true, muted: true, rate: 1.5 });
  loud.tick(); loud.classes.delete('ad-showing'); loud.tick();
  check('fallback script: a video the viewer had muted or sped up stays that way afterwards', loud.video.muted === true && loud.video.playbackRate === 1.5, JSON.stringify(loud.video));
  const loading = page({ adShowing: true, duration: NaN });
  loading.tick();
  check('fallback script: an ad that has not loaded yet (no duration) is not touched', loading.video.playbackRate === 1 && loading.video.currentTime === 0, JSON.stringify(loading.video));
  const walled = page({ adShowing: false, wall: true });
  walled.tick(); walled.tick();
  check('fallback script: behind the enforcement dialog the paused video is resumed, once', walled.log.played === 1, walled.log.played);

  // ---- Scriptlets that patch JSON.stringify (YouTube has six edit-inbound-object ones), run one after another.
  // The text below has the shape of the list's scriptlet (names as minified there): its own safeSelf() snapshots
  // JSON.stringify when it first runs, and the edit deep-copies the argument through that snapshot before testing
  // a JSONPath. Run in order, each snapshot was the previous scriptlet's proxy, and a stringify cost 2^n copies.
  const editScriptlet = (tag) => 'if (typeof scriptletGlobals === \'undefined\') { var scriptletGlobals = {}; };'
    + 'function editInboundObjectFn(t=false,e="",r="",n=""){if(e==="")return;const i=safeSelf();const f={apply:(x)=>(x.attestationRequest?Object.assign(x,{edited:' + JSON.stringify(tag) + '}):void 0)};'
    + 'const u=t=>0;const s=t=>{let e;try{e=i.JSON_parse(i.JSON_stringify(t))}catch{}if(typeof e!=="object"||e===null)return;const r=f.apply(e);if(r===void 0)return;return r};'
    + 'JSON.stringify=new Proxy(JSON.stringify,{apply(fn,self,args){const o=s(args[0]);if(o)args[0]=o;return Reflect.apply(fn,self,args)}})};'
    + 'function safeSelf(){if(safeSelf.safe)return safeSelf.safe;const e=globalThis;const t={JSON_parse:Function.prototype.call.bind(e.JSON.parse,e.JSON),JSON_stringify:Function.prototype.call.bind(e.JSON.stringify,e.JSON)};safeSelf.safe=t;if(scriptletGlobals.bcSecret===void 0)return t;return t}'
    + ';(function trustedEditInboundObject(t="",n="",d=""){editInboundObjectFn(true,t,n,d)})(...[`JSON.stringify`,`0`,`[?.attestationRequest][?.x]`]);';
  // Runs the scriptlets the way the preload does (a function scope each, one scriptletGlobals for all), then stringifies once.
  function stringifyAfter(codes, payload, { shared }) {
    const counter = { native: 0 };
    const sandbox = { Reflect, Proxy, Object, Array, Function, console, JSON: { parse: JSON.parse, stringify: (...a) => { counter.native++; return JSON.stringify(...a); } } };
    const ctx = vm.createContext(sandbox);
    const globals = {};
    ctx.__globals = globals;
    for (const code of codes) vm.runInContext(shared ? `(function(scriptletGlobals){\n${code}\n})(__globals)` : `(function(){\n${code}\n})()`, ctx);
    counter.native = 0;
    ctx.__payload = payload;
    const out = vm.runInContext('JSON.stringify(__payload)', ctx);
    return { calls: counter.native, out };
  }
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(editScriptlet);
  const plain = { videoId: 'x', big: [1, 2, 3] };
  const before = stringifyAfter(six, plain, { shared: false });
  check('scriptlets: left as they come, each one\'s snapshot of JSON.stringify is the previous one\'s proxy and a call costs 2^n copies', before.calls >= 32, before.calls);
  const shareOnly = stringifyAfter(six.map(Y.shareSafeSelf), plain, { shared: true });
  check('scriptlets: with one shared safeSelf each scriptlet copies the argument once (linear, not 2^n)', shareOnly.calls === 7, shareOnly.calls);
  const prepared = stringifyAfter(six.map(Y.prepareScriptlet), plain, { shared: true });
  check('scriptlets: an object that can\'t match the path is passed on without a copy (one stringify in all)', prepared.calls === 1 && JSON.parse(prepared.out).big.length === 3, `${prepared.calls} ${prepared.out}`);
  const hit = stringifyAfter(six.map(Y.prepareScriptlet), { attestationRequest: {}, x: 1 }, { shared: true });
  check('scriptlets: an object with the property is still copied and edited by the path', typeof JSON.parse(hit.out).edited === 'string' && hit.calls <= 13, `${hit.calls} ${hit.out}`);
  const inArray = stringifyAfter(six.map(Y.prepareScriptlet), [{ attestationRequest: {} }], { shared: true });
  check('scriptlets: arrays are never skipped (the path looks at their elements)', inArray.calls > 1, inArray.calls);
  const odd = 'function something(){ return 1 }';
  check('scriptlets: text that does not have the expected shape is left exactly as it was', Y.prepareScriptlet(odd) === odd && Y.prepareScriptlet(editScriptlet('z').replace('safeSelf.safe=t;', '')) !== null && Y.shareSafeSelf(7) === 7, 'changed');
  check('scriptlets: the same scriptlet text is only handed to a page once', Y.dedupe(['a', 'b', 'a', 'c', 'b']).join('') === 'abc', Y.dedupe(['a', 'b', 'a']));

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
