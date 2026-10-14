// lumen://settings: the first script. It asks main for what the first page needs (preferences, strings, the AI state, ...) at once, so the
// answers arrive while the other scripts are still loading. settings.js calls window.settingsEarly(window.lumenSettings), which returns the
// same API with those first calls answered from here. An answer is only reused in the first moment (and never after the first click or key),
// so a setting changed on the page is always read afresh.
(() => {
  const start = performance.now();
  const TTL = 1500;
  let live = true;
  const early = new Map();
  const stop = () => { live = false; early.clear(); };
  for (const type of ['pointerdown', 'keydown', 'change']) addEventListener(type, stop, { capture: true, once: true });
  const prefetch = (key, fn) => { try { const p = Promise.resolve(fn()); p.catch(() => {}); early.set(key, p); } catch { /* not there on this build */ } };
  window.settingsEarly = (S) => {
    if (!S) return S;
    const fresh = (key) => live && performance.now() - start < TTL && early.get(key);
    const via = (key, fn) => (...args) => fresh(key) || fn(...args);
    return {
      ...S,
      get: via('get', S.get),
      strings: S.strings ? via('strings', S.strings) : S.strings,
      downloads: via('downloads', S.downloads),
      ai: {
        ...S.ai,
        get: via('ai.get', S.ai.get),
        mcpInfo: via('ai.mcpInfo', S.ai.mcpInfo),
        automationInfo: via('ai.automationInfo', S.ai.automationInfo),
        isDefaultBrowser: S.ai.isDefaultBrowser ? (...args) => (args[0]?.cached && fresh('ai.isDefaultBrowser')) || S.ai.isDefaultBrowser(...args) : S.ai.isDefaultBrowser,
      },
    };
  };
  const S = window.lumenSettings;
  if (!S) return;
  prefetch('get', () => S.get());
  if (S.strings) prefetch('strings', () => S.strings());
  prefetch('downloads', () => S.downloads());
  if (S.ai) {
    prefetch('ai.get', () => S.ai.get());
    prefetch('ai.mcpInfo', () => S.ai.mcpInfo());
    prefetch('ai.automationInfo', () => S.ai.automationInfo());
    if (S.ai.isDefaultBrowser) prefetch('ai.isDefaultBrowser', () => S.ai.isDefaultBrowser({ cached: true }));
  }
})();
