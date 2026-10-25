// [a11y mode] How much of Chromium's accessibility support Lumen keeps on (Settings > Appearance > Accessibility > Screen reader support).
//
// Why: any program that reads windows through the OS accessibility API (on Windows: 1Password's desktop app, Phone Link, text and
// clipboard tools; on a Mac: window managers, Grammarly) makes Chromium switch accessibility on for the whole app, and from then on
// every page keeps a full accessibility tree, with a box for each run of text. On a big page (Canvas, a web mail, a dashboard) each focus
// change, sidebar open or close and window switch rebuilt it: the page's main thread was busy for seconds, and the main process, which
// receives the tree, stopped answering ("Lumen is not responding"). Measured on a 50,000-element page (test/e2e/a11y-mode.js): 1.5 to 1.8 s
// of main-process stall per change with the full set, 5 ms with web pages left out.
//
// Modes:
//   auto (default): accessibility switched on by another program is cut down to Lumen's own window controls (`nativeAPIs`: the OS can
//                   still name the window, its buttons and menus) unless a screen reader is running (Windows: the system's screen
//                   reader flag, or Narrator, NVDA, JAWS, ZoomText, Dolphin; a Mac: VoiceOver). A screen reader found later
//                   (checked on window focus, at most every 30 s) gets the full set back.
//   on:   the full set whenever accessibility is asked for (a screen reader Lumen does not recognise).
//   off:  nothing, whoever asks (pages never build a tree).
// Lumen's AI reads pages through the DevTools protocol, which builds its own tree on demand: no mode changes what the AI sees.

const MODES = ['auto', 'on', 'off'];
const LIGHT = ['nativeAPIs'];
const RECHECK_MS = 30e3;

// What to set, from the mode, whether accessibility is now on, and whether a screen reader runs: an array of features, or null (leave it).
function decide({ mode, enabled, screenReader }) {
  if (!enabled) return null; // nothing asked for it: nothing to cut down
  if (mode === 'off') return [];
  if (mode === 'on' || screenReader) return 'full';
  return LIGHT;
}

const SCREEN_READERS_WIN = ['Narrator', 'nvda', 'jfw', 'zt', 'ZoomText', 'Dolphin', 'snova', 'SuperNova', 'WindowEyes', 'fsreader'];
// Windows: SPI_GETSCREENREADER (0x46), the flag screen readers set, and their processes, in one hidden PowerShell (never on the main thread).
const WIN_PROBE = [
  "$sig = '[DllImport(\"user32.dll\")] public static extern bool SystemParametersInfo(uint a, uint b, ref bool c, uint d);'",
  '$t = Add-Type -MemberDefinition $sig -Name SPI -Namespace LumenA11y -PassThru',
  '$on = $false; [void]$t::SystemParametersInfo(0x46, 0, [ref]$on, 0)',
  `$p = @(Get-Process -Name ${SCREEN_READERS_WIN.map((n) => `'${n}'`).join(',')} -ErrorAction SilentlyContinue).Count`,
  "if ($on -or $p -gt 0) { 'yes' } else { 'no' }",
].join('; ');

function probeScreenReader({ platform = process.platform, execFile = require('../ai/cli-utils').execFile } = {}) {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? null : /yes|^1/.test(String(out).trim())); // null: could not tell
    try {
      if (platform === 'win32') execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PROBE], { timeout: 8000, windowsHide: true }, done);
      else if (platform === 'darwin') execFile('/usr/bin/defaults', ['read', 'com.apple.universalaccess', 'voiceOverOnOffKey'], { timeout: 4000, windowsHide: true }, done);
      else resolve(null);
    } catch { resolve(null); }
  });
}

// deps: { app, mode: () => 'auto'|'on'|'off', probe?: () => Promise<boolean|null>, now?: () => ms, log?: (msg) => void }
function create(deps) {
  const now = deps.now || Date.now;
  const probe = deps.probe || (() => probeScreenReader());
  let applying = false; // our own change fires accessibility-support-changed too
  let lightened = false; // cut down by auto: a screen reader found later gets the full set
  let checkedAt = 0;
  let seq = 0;
  let probed = null; // { at, result }: a program that keeps asking (Chromium turns accessibility back on at its next request) is answered from this for 30 s
  let logged = false;
  const state = { last: null, screenReader: null };

  const set = (features) => {
    applying = true;
    try {
      if (features === 'full') deps.app.setAccessibilitySupportEnabled(true);
      else deps.app.setAccessibilitySupportFeatures(features);
    } catch { /* an Electron without the API, or a platform without it */ } finally { applying = false; }
    state.last = features;
  };
  const enabledNow = () => { try { return deps.app.isAccessibilitySupportEnabled(); } catch { return false; } };

  async function sync({ enabled = enabledNow() } = {}) {
    const mode = MODES.includes(deps.mode()) ? deps.mode() : 'auto';
    const mine = ++seq;
    let screenReader = false;
    if (enabled && mode === 'auto') {
      if (probed && now() - probed.at < RECHECK_MS) screenReader = probed.result;
      else {
        checkedAt = now();
        screenReader = await probe().catch(() => null);
        probed = { at: checkedAt, result: screenReader };
        if (mine !== seq) return state.last; // a newer change decided meanwhile
      }
      if (screenReader === null) screenReader = false; // (could not tell: a page that stalls is worse than a missing tree, and "on" is one setting away)
    }
    state.screenReader = screenReader;
    const features = decide({ mode, enabled, screenReader });
    lightened = mode === 'auto' && Array.isArray(features) && features.length > 0;
    if (features) {
      set(features);
      if (deps.log && features !== 'full' && !logged && (logged = true)) deps.log(`[lumen] accessibility asked for by another program; kept to ${features.length ? features.join(', ') : 'nothing'} (Settings → Appearance → Accessibility > Screen reader support)`);
    }
    return features;
  }

  const onChanged = (_e, enabled) => { if (!applying && enabled) sync({ enabled: true }); };
  // A screen reader started after the cut: checked again on window focus, not more often than every 30 s.
  const onFocus = () => { if (lightened && now() - checkedAt >= RECHECK_MS) { probed = null; sync({ enabled: true }); } };
  // The setting changed: on/off apply at once; back to auto looks again (accessibility is "on" while cut down, so it is re-decided).
  const settingChanged = () => { probed = null; return sync({ enabled: enabledNow() || lightened || state.last !== null }); };

  deps.app.on('accessibility-support-changed', onChanged);
  return { sync, onFocus, settingChanged, state, isLightened: () => lightened };
}

module.exports = { MODES, LIGHT, RECHECK_MS, decide, probeScreenReader, create, WIN_PROBE };
