// Google in a dark theme, dark from the first frame. Google renders its theme on the server from a
// client hint (see settings-backend.js) and switches some pages in script, so a page can paint
// white first. On a Google page in a dark theme this paints the canvas dark before anything
// arrives, and once the page has its own styles decides: already dark, drop the canvas color;
// still light (the hint was ignored), invert it, before the first paint where the timing allows.
if (window === window.top && /^www\.google\.[a-z.]+$/i.test(location.hostname) && matchMedia('(prefers-color-scheme: dark)').matches) {
  const CANVAS = '#202124';
  const style = document.createElement('style');
  style.textContent = `html{background:${CANVAS} !important;color-scheme:dark}`;
  const invert = document.createElement('style');
  invert.textContent = 'html{filter:invert(1) hue-rotate(180deg) !important}img,picture,video,canvas,svg image{filter:invert(1) hue-rotate(180deg) !important}';

  // Luminance of the first opaque background (body, then html); no solid background shows the canvas.
  const luminance = () => {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (m && (m[3] === undefined || +m[3] > 0.5)) return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255;
    }
    return 0;
  };
  const settle = () => {
    style.remove();
    if (luminance() > 0.6) document.documentElement.append(invert);
    else invert.remove();
  };

  const attach = () => {
    if (!document.documentElement) return false;
    document.documentElement.append(style);
    return true;
  };
  if (!attach()) {
    const watch = new MutationObserver(() => { if (attach()) watch.disconnect(); });
    watch.observe(document, { childList: true });
  }
  // The page's own styles are in by DOMContentLoaded; recheck once it has finished loading in case
  // a script changed the theme after that.
  document.addEventListener('DOMContentLoaded', settle, { once: true });
  addEventListener('load', () => { style.remove(); invert.remove(); if (luminance() > 0.6) document.documentElement.append(invert); }, { once: true });
}
