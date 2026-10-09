// The toolbar's "<AI> is using this tab" pill: when it shows, and what it says. It is about the tab in front, so it shows only
// while the running task works in that tab. A task left in another tab (the user switched away) shows nothing here; the
// sidebar's "Working in: <tab>" line says where it is. `target` is { front } from main (agent:target), or null when main
// has not said (the first moments of a run), which counts as the tab in front. An outside agent's pill (MCP, `mcpActive`)
// is not about a tab of this window and is left alone. Loaded by index.src.html (before chat-core.js), required by
// test/agent-pill-units.js.
(function (root) {
  function pillState({ running, target, mcpActive } = {}) {
    const away = Boolean(running && target && !target.front);
    return { away, textKey: away ? 'agent.usingOther' : 'agent.usingTab', visible: Boolean(mcpActive || (running && !away)) };
  }
  const api = { pillState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.agentPill = api;
})(typeof window !== 'undefined' ? window : globalThis);
