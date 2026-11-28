// The test/e2e suites that are deliberately NOT in SUITES (scripts/test/test-all.js), each with why. Every other test/e2e/*.js file must be
// in SUITES: test/units/release-tooling-units.js fails when a file is in neither list (so a new suite can't silently miss the release), in
// both, or named here without a file. Files starting with `_` are helpers, not suites, and need no entry. Run one by hand, hidden:
//   LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 CLAUDE_BROWSER_PROFILE=<temp dir> node scripts/test/e2e-lock.js run -- node test/e2e/<name>.js
const MANUAL_SUITES = {
  // Real websites (need the network, and the sites change under them).
  agentic: 'agent tasks on real sites (wikipedia.org, httpbin.org)',
  'apple-music-engine-real': 'the Apple Music engine against the real music.apple.com',
  'spotify-engine-real': 'the Spotify engine against the real open.spotify.com, signed out',
  drm: 'Widevine: the CDM downloads on a fresh profile and plays real protected media',
  measure: 'token and tool-call costs of four real browsing tasks (a measurement, prints numbers)',
  'translate-local-real': 'downloads a real Bergamot language pack from Mozilla and translates with it',
  'translate-seam-real': 'downloads real Bergamot packs and writes a measurement report (docs/translate-seam-measurement.md)',
  'live-reading': 'opt-in (LUMEN_LIVE=1): the reading, page-debug and video tools on real sites',
  'live-reddit': 'opt-in (LUMEN_LIVE=1): the Reddit readers against reddit.com, which rate-limits signed-out reads',
  'live-atitesting': 'opt-in (LUMEN_LIVE=1): ATI Testing\'s sign-in page loads in Lumen',
  // The user's own accounts, sign-ins or paid plans.
  'live-spotify': 'opt-in (LUMEN_LIVE_SPOTIFY=1): a real signed-in Spotify account; the first run opens a visible sign-in window',
  claudecode: 'sends a real message through the user\'s signed-in `claude` CLI (uses their plan)',
  grokgate: 'runs the real signed-in `grok` CLI (uses the user\'s Grok sign-in and costs a few cents)',
  cli: 'downloads and installs the real Anthropic `ant` CLI from its official release',
  // Settings-open timing (a 150 ms budget from the first screen), machine-load sensitive: the user ruled 2026-10-21 that Settings open speed
  // does not block a release (settings-open-perf, files-perf and mcp-perf were left out the same way from 0.5.61).
  'settings-search-speed': 'Settings search within 150 ms of the first screen: a timing budget releases do not wait on; run it on a quiet machine',
};

module.exports = { MANUAL_SUITES };
