// The UI preferences from lumen://settings (compact tabs, reduced motion, focus rings), applied to the page and kept current. Shared by the browser UI and the full-page chat.
{
  // The strip's hands-off cue says "Hands-off" in words in a wide window (styles.css), where a hover tip would only repeat it; icon-only, it keeps the tip.
  const wide = matchMedia('(min-width: 1100px)');
  const cueTitle = () => {
    const cue = document.getElementById('hands-off-strip');
    if (!cue) return;
    if (!cue.dataset.tip) cue.dataset.tip = cue.title;
    if (wide.matches) cue.removeAttribute('title'); else cue.title = cue.dataset.tip;
  };
  wide.addEventListener('change', cueTitle);
  const applyPrefs = (p) => {
    if (!p) return;
    const root = document.documentElement;
    root.classList.toggle('pref-compact-tabs', Boolean(p.compactTabs));
    if ('tabLayout' in p) { window.lumenSideTabs = { tabLayout: p.tabLayout, sideTabsWidth: p.sideTabsWidth, sideTabsCollapsed: p.sideTabsCollapsed }; document.dispatchEvent(new Event('lumen:side-tabs')); } // [side tabs] Tab layout: renderer/side-tabs.js moves the list
    root.classList.toggle('pref-no-bookmark-button', p.showBookmarkButton === false);
    root.classList.toggle('pref-no-ai-off-button', p.showAiOffButton === false);
    root.classList.toggle('pref-reduce-motion', Boolean(p.reduceMotion || p.lite)); // Performance mode (features/performance.js) also stops motion
    root.classList.toggle('pref-lite', Boolean(p.lite));
    root.classList.toggle('pref-gfx-light', Boolean(p.lightGfx)); // Settings > System > Graphics: Light (or Automatic on an integrated GPU): no backdrop blur (settings-backend.js [igpu])
    root.classList.toggle('pref-gfx-soft', Boolean(p.softwareGfx)); // software drawing (no GPU): Light plus no blur anywhere, short transitions, no page snapshot (settings-backend.js [igpu], prefs.css)
    if ('softwareGfx' in p) window.lumenSoftwareGfx = Boolean(p.softwareGfx); // app.js: the sidebar moves without a snapshot
    root.classList.toggle('pref-no-sleep-dim', p.sleepDim === false); // [tabs] Settings > Tabs > Page unloading: no dimmed icon on unloaded tabs
    root.classList.toggle('pref-focus-rings', Boolean(p.focusRings));
    const badge = document.getElementById('hands-off'); // [ai manners] the composer says the AI is not allowed to act on the user's tabs
    if (badge) badge.hidden = !p.handsOff;
    const stripCue = document.getElementById('hands-off-strip'); // ...and the tab strip does too, whether or not a chat is open
    if (stripCue) { stripCue.hidden = !p.handsOff; cueTitle(); }
    const hide = p.hideAiTabs === true; // [ai manners] the strip leaves out the tabs the AI opened (app.js renderTabsNow)
    if (Boolean(window.lumenHideAiTabs) !== hide) { window.lumenHideAiTabs = hide; document.dispatchEvent(new Event('lumen:hide-ai-tabs')); }
    if (p.permissionMode) window.dispatchEvent(new CustomEvent('lumen:permission-mode', { detail: p.permissionMode })); // [bypass permissions] the sidebar's bolt menu and badge follow Settings → AI
    if ('helpers' in p) window.dispatchEvent(new CustomEvent('lumen:helpers', { detail: p.helpers !== false })); // [subagents] the sidebar's Helpers button follows Settings → AI
    if ('planModeDefault' in p && window.lumenPlanModeDefault !== (p.planModeDefault === true)) { window.lumenPlanModeDefault = p.planModeDefault === true; window.dispatchEvent(new Event('lumen:plan-default')); } // [plan mode] the composer's Plan chip in a new chat
    if ('preferFractions' in p) window.lumenPreferFractions = p.preferFractions === true; // [prefer fractions] markdown.js stacks a plain 3/4 in answers
    if ('sidebarNewChat' in p) window.lumenSidebarNewChat = p.sidebarNewChat !== false; // [sidebar new chat] app.js: the AI button opens on a new chat
    if ('switchTiming' in p) window.lumenSwitchTiming = p.switchTiming === true; // [diagnostics] app.js reports when the strip drew a switch
  };
  // [look] The accent colour is not applied here: main.js injects its sheet into every page of Lumen's own, this one included (features/accent-css.js).
  for (const id of ['hands-off', 'hands-off-strip']) document.getElementById(id)?.addEventListener('click', () => window.lumenPrefs?.openSettingsPage('hands-off')); // (the one open Settings tab is reused, and the switch is focused)
  window.lumenPrefs?.get().then(applyPrefs).catch(() => {});
  window.lumenPrefs?.onChange(applyPrefs);
}
