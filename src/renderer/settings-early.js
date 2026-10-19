// lumen://settings: the first script. It asks main for what the first page needs (preferences, strings, the AI state, ...) at once, so the
// answers arrive while the other scripts are still loading. settings.js calls window.settingsEarly(window.lumenSettings), which returns the
// same API with those first calls answered from here. An answer is only reused in the first moment (and never after the first click or key),
// so a setting changed on the page is always read afresh.
(() => {
  const start = performance.now();
  const TTL = 1500;
  const REMEMBER = 'lumen.settings.category'; // (the key settings.js keeps the last page in: see REMEMBER there)
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
        searchEngines: S.ai.searchEngines ? via('ai.searchEngines', S.ai.searchEngines) : S.ai.searchEngines,
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
    if (S.ai.searchEngines) prefetch('ai.searchEngines', () => S.ai.searchEngines()); // (asked first and small: General's Search engine row needs only this, so the page does not wait for the larger ai.get behind it)
    // The AI state is the largest answer (about 20 ms of the browser's main thread) and only the AI pages, Tabs and Advanced read it: a page that opens on
    // General, Appearance, Home, Privacy or Updates (by link, or as the last page shown) does not ask for it, so nothing waits behind it and the main thread stays free.
    const hash = location.hash.slice(1);
    let last = ''; try { last = localStorage.getItem(REMEMBER) || ''; } catch { /* no storage */ }
    const NO_AI = new Set(['general', 'appearance', 'home', 'privacy', 'updates', 'default-browser', 'startup', 'languages', 'language', 'engine', 'search', 'downloads', 'files', 'focus', 'accessibility', 'theme', 'newtab', 'new-tab', 'about', 'cookies', 'security', 'passwords', 'permissions', 'extensions']);
    if (!NO_AI.has(hash || last || 'general')) prefetch('ai.get', () => S.ai.get());
    S.ai.onModelsUpdated?.(stop); // the model changed elsewhere (the sidebar) in this first moment: the answer fetched at load is stale, and the page's own refresh must read afresh
    if (S.ai.isDefaultBrowser) prefetch('ai.isDefaultBrowser', () => S.ai.isDefaultBrowser({ cached: true }));
  }
})();
