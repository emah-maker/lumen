/* global document, MutationObserver */
// YouTube extras for the ad blocker (features/adblock.js), on top of the lists' own YouTube rules.
//
// The lists do the real work: their scriptlets cut adPlacements/playerAds/adSlots out of the player responses
// before the player sees them (JSON.parse, fetch and XHR of /youtubei/v1/player, /next, /get_watch...). YouTube
// changes this every few weeks, and for a while after each change an ad gets through or the "ad blockers
// violate YouTube's Terms of Service" wall appears. Two things here cover that gap:
//  - hiding rules (added to the engine as user-origin CSS, so a page can't see them) for ad and sponsored
//    renderers in the feed, search, Shorts and watch page, and for the enforcement dialog;
//  - a small script, run in the page at document start like the scriptlets, that acts only while an ad is
//    actually playing (the player has `ad-showing`): it presses Skip, and otherwise mutes the ad and runs it to
//    its end. It never touches the video while the player isn't showing an ad, and never plays over a pause the
//    user made. It keeps nothing on window.

// Filter lines, merged into the engine with the sign-in exceptions (so they are tagged and rebuilt with them).
const YOUTUBE_FILTERS = [
  // Feed, search and watch-page ad renderers and sponsored cards.
  'youtube.com##ytd-ad-slot-renderer',
  'youtube.com##ytd-in-feed-ad-layout-renderer',
  'youtube.com##ytd-display-ad-renderer',
  'youtube.com##ytd-promoted-sparkles-web-renderer',
  'youtube.com##ytd-promoted-video-renderer',
  'youtube.com##ytd-banner-promo-renderer',
  'youtube.com##ytd-companion-slot-renderer',
  'youtube.com##ytd-player-legacy-desktop-watch-ads-renderer',
  'youtube.com##ytd-action-companion-ad-renderer',
  'youtube.com###masthead-ad',
  // The grid cells and sections that held them (an emptied card would leave a gap).
  'youtube.com##ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)',
  'youtube.com##ytd-rich-item-renderer:has(> #content > ytd-in-feed-ad-layout-renderer)',
  'youtube.com##ytd-rich-section-renderer:has(> #content > ytd-statement-banner-renderer)',
  // Shorts: an ad is a slot in the reel list.
  'youtube.com##ytd-reel-video-renderer:has(ytd-ad-slot-renderer)',
  // The banner that opens over the video, and the ads side panel.
  'youtube.com##.ytp-ad-overlay-container',
  'youtube-nocookie.com##.ytp-ad-overlay-container',
  'youtube.com##ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
  // The "ad blockers violate YouTube's Terms of Service" dialog and its dimming layer.
  'youtube.com##ytd-enforcement-message-view-model',
  'youtube.com##tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)',
  'youtube.com##ytd-app:has(ytd-enforcement-message-view-model) tp-yt-iron-overlay-backdrop',
];

// Hosts the script runs on: YouTube and its embeds (an embedded player shows the same ads).
const YOUTUBE_HOST = /(^|\.)youtube(-nocookie)?\.com$/;

// Runs in the page, not in Lumen: written as a function so it is checked and formatted like the rest, then sent
// as text. Self-contained (no outer variables).
function youtubeFallback() {
  try {
    const SKIP = '.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button, button.ytp-ad-skip-button-container';
    const CLOSE = '.ytp-ad-overlay-close-button';
    let held = null; // the video we muted and sped up for an ad, with what it had before
    let wallSeen = false;
    // A pause the user made (a click, a key, a tap just before it) is theirs: nothing here plays over it. Only a pause
    // that came with the enforcement dialog, with no input from the user, is undone. (Signed-in pages re-render the
    // dialog, and resuming on every appearance played the video again each time the user paused: "pause does nothing".)
    const USER_WINDOW = 1500;
    let lastInput = -Infinity;
    let lastPause = null; // { at, byUser }
    const wallShown = () => Boolean(document.querySelector('ytd-enforcement-message-view-model'));
    const noteInput = (e) => { if (e.isTrusted) lastInput = Date.now(); };
    for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) document.addEventListener(type, noteInput, true);
    const resumeIfForced = (video) => {
      if (!video || !video.paused || video.ended) return;
      if (Date.now() - lastInput < USER_WINDOW) return; // the user just clicked or pressed a key: theirs
      // (a video already paused before this script saw a pause, with no input from the user, is YouTube's doing)
      if (lastPause && (lastPause.byUser || Date.now() - lastPause.at > 5000)) return;
      video.play().catch(() => {});
    };
    // (media events don't bubble, but a capturing listener on the document still hears them)
    document.addEventListener('pause', (e) => {
      const video = e.target;
      if (!video || !video.classList || !video.classList.contains('html5-main-video')) return;
      lastPause = { at: Date.now(), byUser: Date.now() - lastInput < USER_WINDOW };
      if (!lastPause.byUser && wallShown()) resumeIfForced(video); // the dialog came first, then paused the video
    }, true);
    const restore = () => {
      if (!held) return;
      try { held.video.playbackRate = held.rate; held.video.muted = held.muted; } catch { /* the video went away */ }
      held = null;
    };
    let adTimer = null; // the quick check, only while an ad is showing
    let soon = null; // a check asked for by a change of the page, at most one every 250 ms
    let lastRun = 0;
    const tick = () => {
      lastRun = Date.now();
      try {
        const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        if (player && player.classList.contains('ad-showing')) {
          const skip = player.querySelector(SKIP);
          if (skip) skip.click();
          const close = player.querySelector(CLOSE);
          if (close) close.click();
          const video = player.querySelector('video');
          if (video && video.duration > 0 && isFinite(video.duration)) {
            if (!held) held = { video, rate: video.playbackRate, muted: video.muted };
            video.muted = true;
            video.playbackRate = 16;
            // To the last moment of the ad: the player then ends it and goes on to the video.
            if (video.currentTime < video.duration - 0.25) video.currentTime = video.duration - 0.1;
          }
          if (adTimer === null) adTimer = setInterval(tick, 300); // an ad: look often until it is over
        } else {
          restore();
          if (adTimer !== null) { clearInterval(adTimer); adTimer = null; }
        }
        // The enforcement dialog (hidden by the rules above) pauses the video behind it: play on, once per appearance.
        const wall = document.querySelector('ytd-enforcement-message-view-model');
        if (wall && !wallSeen) {
          wallSeen = true;
          resumeIfForced(document.querySelector('video.html5-main-video')); // only a pause the dialog made
          if (document.body) document.body.style.removeProperty('overflow');
          // The hidden dialog can still hold the keyboard focus (k, space and the arrows then go nowhere): back to the player.
          const dialog = wall.closest('tp-yt-paper-dialog');
          if (dialog && dialog.contains(document.activeElement) && player && typeof player.focus === 'function') player.focus();
        } else if (!wall) wallSeen = false;
      } catch { /* the page is in the middle of changing */ }
    };
    // Observer-driven: the player's class (ad-showing) and the dialog appearing are page changes, so a quiet page (or a background tab) costs
    // nothing. The 300 ms check above runs only while an ad is showing, which is when it has to be quick.
    const later = () => {
      if (soon !== null) return;
      soon = setTimeout(() => { soon = null; tick(); }, Math.max(0, 250 - (Date.now() - lastRun)));
    };
    const start = () => {
      new MutationObserver(later).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      tick();
    };
    document.addEventListener('yt-navigate-finish', later, true);
    // (run at document start, when there may be no <html> yet)
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  } catch { /* no timers yet: the page is not a normal one */ }
}

const FALLBACK_SCRIPT = `(${youtubeFallback.toString()})();`;

// The scriptlet list for a page: the engine's, plus the fallback on YouTube hosts.
function withFallback(scripts, hostname) {
  return YOUTUBE_HOST.test(hostname || '') ? [...scripts, FALLBACK_SCRIPT] : scripts;
}

// Each scriptlet carries its own copy of safeSelf(), which snapshots JSON.stringify, fetch... when it first runs. Run
// one after another, the second scriptlet that patches JSON.stringify snapshots the first one's proxy, the third the
// second's, and so on: each of YouTube's six edit-inbound-object scriptlets then deep-clones its argument through
// all the earlier ones (JSON.parse(JSON.stringify(x)) inside the proxies), 2^5 clones for every JSON.stringify call
// the page makes. uBlock runs them with one shared safeSelf, whose snapshot is taken before any patch; this makes
// the copies do the same by way of the scriptletGlobals object the preload hands to all of them. A scriptlet whose
// text doesn't have the expected shape (a future list format) is left as it was.
const SAFE_HEAD = /function safeSelf\(\)\{if\(safeSelf\.safe\)return safeSelf\.safe;/;
const SAFE_TAIL = /safeSelf\.safe=(\w+);/;
function shareSafeSelf(code) {
  if (typeof code !== 'string' || !SAFE_HEAD.test(code) || !SAFE_TAIL.test(code)) return code;
  return code
    .replace(SAFE_HEAD, (head) => `${head}if(scriptletGlobals.safe)return safeSelf.safe=scriptletGlobals.safe;`)
    .replace(SAFE_TAIL, (_all, name) => `safeSelf.safe=scriptletGlobals.safe=${name};`);
}

// edit-inbound-object (six of them patch JSON.stringify on YouTube) deep-copies every argument through
// JSON.parse(JSON.stringify(x)) before it asks whether its JSONPath matches anything; YouTube stringifies
// big objects all the time. A path that starts with [?.name] can only match an object that has that property
// (or an array, whose elements it then looks at), so anything else is left alone without the copy. A function
// whose text doesn't have the expected shape is left as it was.
const EDIT_PARAMS = /function editInboundObjectFn\(\w+=false,\w+="",\w+="",(\w+)=""\)\{/;
const EDIT_CLONE = /const (\w+)=(\w+)=>\{let (\w+);try\{\3=(\w+)\.JSON_parse\(\4\.JSON_stringify\(\2\)\)\}catch\{\}/;
function skipUselessClones(code) {
  const params = typeof code === 'string' && EDIT_PARAMS.exec(code);
  if (!params || !EDIT_CLONE.test(code)) return code;
  return code.replace(EDIT_CLONE, (_all, fn, arg, copy, self) => `const lumenKey=(m=>m?m[1]:null)(/^\\[\\?\\.([A-Za-z_$][\\w$]*)\\]/.exec(${params[1]}));`
    + `const ${fn}=${arg}=>{if(typeof ${arg}!=="object"||${arg}===null||(lumenKey!==null&&Array.isArray(${arg})===false&&typeof ${arg}.toJSON!=="function"&&(lumenKey in ${arg})===false))return;`
    + `let ${copy};try{${copy}=${self}.JSON_parse(${self}.JSON_stringify(${arg}))}catch{}`);
}

// What every scriptlet goes through before it is handed to a page.
const prepareScriptlet = (code) => skipUselessClones(shareSafeSelf(code));

// The lists carry some scriptlets twice (the same rule in two lists): a second identical copy only wraps fetch,
// XHR or JSON.parse once more, so each page runs every distinct text once.
const dedupe = (scripts) => [...new Set(scripts)];

module.exports = { dedupe, prepareScriptlet, shareSafeSelf, skipUselessClones, YOUTUBE_FILTERS, YOUTUBE_HOST, FALLBACK_SCRIPT, withFallback };
