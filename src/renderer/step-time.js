// How long a step of the AI's work took, as the short text shown at the end of its row in the chat ("2.4s", "1m 05s").
// Under a second shows nothing: most clicks and reads are that fast, and a "0.2s" on every row would only be noise.
// Plain script in the UI; test/sidebar-ux2-units.js loads it with require().
(function (root) {
  function format(ms) {
    if (!Number.isFinite(ms) || ms < 1000) return '';
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    const rest = Math.round(s - m * 60);
    return rest === 60 ? `${m + 1}m 00s` : `${m}m ${String(rest).padStart(2, '0')}s`;
  }
  const api = { format };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.stepTime = api;
})(this);
