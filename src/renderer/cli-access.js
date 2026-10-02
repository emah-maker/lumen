// Settings > AI > "full access to this computer": one setting per command-line AI, plus the master switch that sets
// them together. Plain functions (no DOM, no Electron), shared by settings.js and the unit tests.
// Each key is a boolean, off by default (settings/settings-backend.js DEFAULTS):
//   claudeCodeFullAccess   ai/claude-code.js   ARGS_FULL
//   grokBuildFullAccess    ai/grok-build.js    ARGS_FULL
//   antigravityFullAccess  ai/antigravity.js   FULL_FLAGS
(() => {
  const CLI_ACCESS = [
    { key: 'claudeCodeFullAccess', name: 'Claude Code' },
    { key: 'grokBuildFullAccess', name: 'Grok Build' },
    { key: 'antigravityFullAccess', name: 'Antigravity' },
  ];
  const KEYS = CLI_ACCESS.map((c) => c.key);

  // 'on' (every CLI has full access), 'off' (none does) or 'mixed' (the master switch shows its indeterminate state).
  function masterState(prefs) {
    const on = KEYS.filter((k) => prefs?.[k] === true).length;
    return on === 0 ? 'off' : on === KEYS.length ? 'on' : 'mixed';
  }
  // What clicking the master switch sets: only 'off' turns everything on. 'on' clears all, and so does 'mixed'
  // (the cautious reading of a click on a half-set switch: nothing is granted that the user did not just ask for).
  const masterNext = (state) => state === 'off';
  // The settings the master switch writes: every CLI set to `value`.
  const masterValues = (value) => Object.fromEntries(KEYS.map((k) => [k, Boolean(value)]));

  const api = { CLI_ACCESS, KEYS, masterState, masterNext, masterValues };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.cliAccess = api;
})();
