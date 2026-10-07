// The UI preferences from lumen://settings (compact tabs, reduced motion, focus rings) and the accent
// colour, applied to the page and kept current. Shared by the browser UI and the full-page chat.
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
    root.classList.toggle('pref-no-bookmark-button', p.showBookmarkButton === false);
    root.classList.toggle('pref-reduce-motion', Boolean(p.reduceMotion || p.lite)); // Performance mode (features/performance.js) also stops motion
    root.classList.toggle('pref-lite', Boolean(p.lite));
    root.classList.toggle('pref-focus-rings', Boolean(p.focusRings));
    const badge = document.getElementById('hands-off'); // [ai manners] the composer says the AI is not allowed to act on the user's tabs
    if (badge) badge.hidden = !p.handsOff;
    const stripCue = document.getElementById('hands-off-strip'); // ...and the tab strip does too, whether or not a chat is open
    if (stripCue) { stripCue.hidden = !p.handsOff; cueTitle(); }
    const hide = p.hideAiTabs === true; // [ai manners] the strip leaves out the tabs the AI opened (app.js renderTabsNow)
    if (Boolean(window.lumenHideAiTabs) !== hide) { window.lumenHideAiTabs = hide; document.dispatchEvent(new Event('lumen:hide-ai-tabs')); }
    if (p.permissionMode) window.dispatchEvent(new CustomEvent('lumen:permission-mode', { detail: p.permissionMode })); // [bypass permissions] the sidebar's bolt menu and badge follow Settings → AI
    if ('helpers' in p) window.dispatchEvent(new CustomEvent('lumen:helpers', { detail: p.helpers !== false })); // [subagents] the sidebar's Helpers button follows Settings → AI
    accent = p.accent || null;
    applyAccent();
  };
  // [look] The accent color (Settings → Appearance), in the shades styles.css uses; it follows
  // light and dark mode.
  let accent = null;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const mix = (n, to, t) => Math.round(n + (to - n) * t);
  function applyAccent() {
    const style = document.documentElement.style;
    const hex = accent && (dark.matches ? accent.dark : accent.light);
    if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) { for (const v of ['--accent', '--accent-rgb', '--accent-bright', '--accent-deep', '--accent-soft']) style.removeProperty(v); return; }
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
    style.setProperty('--accent', hex);
    style.setProperty('--accent-rgb', `${r} ${g} ${b}`);
    style.setProperty('--accent-bright', `rgb(${mix(r, 255, 0.25)} ${mix(g, 255, 0.25)} ${mix(b, 255, 0.25)})`);
    style.setProperty('--accent-deep', `rgb(${mix(r, 0, 0.18)} ${mix(g, 0, 0.18)} ${mix(b, 0, 0.18)})`);
    style.setProperty('--accent-soft', `rgb(${r} ${g} ${b} / ${dark.matches ? 0.2 : 0.14})`);
  }
  dark.addEventListener('change', applyAccent);
  for (const id of ['hands-off', 'hands-off-strip']) document.getElementById(id)?.addEventListener('click', () => window.lumenPrefs?.openSettingsPage('hands-off')); // (the one open Settings tab is reused, and the switch is focused)
  window.lumenPrefs?.get().then(applyPrefs).catch(() => {});
  window.lumenPrefs?.onChange(applyPrefs);
}
