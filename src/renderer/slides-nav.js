// The slide viewer's numbering, kept apart from the page so plain Node can test it (test/units/slides-nav-units.js).
// Loaded by slides.html before slides.js (window.lumenSlidesNav); also a CommonJS module.
(function (root) {
  // What the slide-number box holds -> a slide number from 1 to count (out-of-range numbers are clamped), or null when it is not a number.
  function parseSlideNumber(text, count) {
    const m = /^\s*(\d+)\s*(?:\/.*)?$/.exec(String(text == null ? '' : text));
    if (!m || !(count >= 1)) return null;
    return Math.max(1, Math.min(Math.floor(count), parseInt(m[1], 10)));
  }
  // The slide a fragment names ("#slide=7", possibly among other parameters) as an index from 0 (not clamped), or null.
  function slideFromHash(hash) {
    try {
      const v = new URLSearchParams(String(hash || '').replace(/^#/, '')).get('slide');
      return v && /^\d{1,7}$/.test(v) && Number(v) >= 1 ? Number(v) - 1 : null;
    } catch { return null; }
  }
  // The slide a viewer address asks for: its own fragment, else the one on the deck's address (?u=file:///deck.pptx#slide=7). Index from 0, or null.
  function slideFromUrl(href) {
    try {
      const u = new URL(href);
      const own = slideFromHash(u.hash);
      if (own !== null) return own;
      return slideFromHash(new URL(u.searchParams.get('u') || '').hash);
    } catch { return null; }
  }
  // The address with the fragment naming slide `index` (from 0); slide 1 is the default, so it leaves no fragment. Other fragment parameters stay.
  function withSlide(href, index) {
    const u = new URL(href);
    const params = new URLSearchParams(u.hash.replace(/^#/, ''));
    if (index > 0) params.set('slide', String(Math.floor(index) + 1)); else params.delete('slide');
    const hash = params.toString();
    u.hash = hash;
    return u.href;
  }
  // The slide to go to for a key, from `current` among `count`, or null when the key is not a navigation key.
  function slideForKey(key, current, count, shift) {
    const last = count - 1;
    let to = null;
    if (key === 'PageDown' || key === 'ArrowDown' || key === 'ArrowRight' || (key === ' ' && !shift)) to = current + 1;
    else if (key === 'PageUp' || key === 'ArrowUp' || key === 'ArrowLeft' || (key === ' ' && shift)) to = current - 1;
    else if (key === 'Home') to = 0;
    else if (key === 'End') to = last;
    return to === null ? null : Math.max(0, Math.min(last, to));
  }
  const api = { parseSlideNumber, slideFromHash, slideFromUrl, withSlide, slideForKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.lumenSlidesNav = api;
})(typeof window !== 'undefined' ? window : this);
