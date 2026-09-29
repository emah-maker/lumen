// The UI preferences from lumen://settings (compact tabs, reduced motion, focus rings) and the accent
// colour, applied to the page and kept current. Shared by the browser UI and the full-page chat.
{
  const applyPrefs = (p) => {
    if (!p) return;
    const root = document.documentElement;
    root.classList.toggle('pref-compact-tabs', Boolean(p.compactTabs));
    root.classList.toggle('pref-no-bookmark-button', p.showBookmarkButton === false);
    root.classList.toggle('pref-reduce-motion', Boolean(p.reduceMotion));
    root.classList.toggle('pref-focus-rings', Boolean(p.focusRings));
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
  window.lumenPrefs?.get().then(applyPrefs).catch(() => {});
  window.lumenPrefs?.onChange(applyPrefs);
}
