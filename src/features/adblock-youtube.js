/* global document */
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
//    its end. It never touches the video while the player isn't showing an ad. It keeps nothing on window.

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
    const restore = () => {
      if (!held) return;
      try { held.video.playbackRate = held.rate; held.video.muted = held.muted; } catch { /* the video went away */ }
      held = null;
    };
    const tick = () => {
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
        } else restore();
        // The enforcement dialog (hidden by the rules above) pauses the video behind it: play on, once per appearance.
        const wall = document.querySelector('ytd-enforcement-message-view-model');
        if (wall && !wallSeen) {
          wallSeen = true;
          const video = document.querySelector('video.html5-main-video');
          if (video && video.paused && !video.ended) video.play().catch(() => {});
          if (document.body) document.body.style.removeProperty('overflow');
        } else if (!wall) wallSeen = false;
      } catch { /* the page is in the middle of changing */ }
    };
    // Quick enough to catch an ad in its first second, cheap when nothing is showing (one lookup).
    setInterval(tick, 300);
  } catch { /* no timers yet: the page is not a normal one */ }
}

const FALLBACK_SCRIPT = `(${youtubeFallback.toString()})();`;

// The scriptlet list for a page: the engine's, plus the fallback on YouTube hosts.
function withFallback(scripts, hostname) {
  return YOUTUBE_HOST.test(hostname || '') ? [...scripts, FALLBACK_SCRIPT] : scripts;
}

module.exports = { YOUTUBE_FILTERS, YOUTUBE_HOST, FALLBACK_SCRIPT, withFallback };
