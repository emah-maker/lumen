// Settings → Home: the live preview of the new-tab page. It shows what the page will look like with everything chosen now: the background (a
// gradient, a solid, or your picture), the accent (also Match wallpaper), the animated effect drawn live at a small scale (the page's own effects,
// renderer/newtab-effects.js), the clock (style, size, card, shadow), the greeting (font, your name), the search box's width, the widget cards'
// glass, and the light or dark theme. Pointing at a background tile (or an effect) swaps only that, keeping all the rest.
//
// The text mode (white text over a dark background, dark text over a light one) is not decided here: features/backgrounds.js (modeOf, toneOf) is the
// one rule, used by the page too. The looks (renderer/settings-preview.css) mirror renderer/newtab.html.
//
// Cost: nothing is built or drawn while the preview is not on screen (IntersectionObserver); the effect's script is loaded the first time an
// effect is on; its loop asks for no frame while the preview is offscreen or the window is hidden, and Reduce motion / Performance mode draw one still frame.
(() => {
  'use strict';
  const STAGE = { w: 1100, h: 440 }; // a page-sized stage, scaled into the box
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  let effectsScript = null; // the effects' script, loaded once, when an effect is first shown
  const withEffects = (then) => {
    if (window.createEffectPreview) { then(); return; }
    if (effectsScript) { effectsScript.addEventListener('load', then, { once: true }); return; }
    effectsScript = el('script');
    effectsScript.src = 'newtab-effects.js';
    effectsScript.addEventListener('load', then, { once: true });
    document.head.append(effectsScript);
  };

  // opts.state(): Settings' state (prefs, clock styles, performance); opts.picture(): the background picture as { url (data:), colors } or null.
  function create(opts) {
    const BG = window.Backgrounds; const TC = window.ThemeColors; const CS = window.ClockStyles;
    const box = el('div', 'bg-preview ntp tone-plain');
    box.id = 'bg-preview';
    box.setAttribute('aria-hidden', 'true');
    const bg = el('div', 'ntp-bg'); const scrim = el('div', 'ntp-scrim'); scrim.hidden = true;
    const canvas = el('canvas', 'ntp-fx'); canvas.hidden = true;
    const stage = el('div', 'ntp-stage');
    const clockH = el('span', 'ntp-h'); const clockSep = el('span', 'ntp-sep'); const clockM = el('span', 'ntp-m'); const clockS = el('span', 'ntp-s');
    const clock = el('p', 'ntp-clock'); clock.append(clockH, clockSep, clockM, clockS);
    const date = el('p', 'ntp-date'); const hello = el('div', 'ntp-hello');
    const clockCard = el('div', 'ntp-clock-card'); clockCard.append(clock, date);
    const head = el('div', 'ntp-head'); head.append(clockCard, hello);
    const search = el('div', 'ntp-search'); search.append(el('span', 'q', 'Search Google'), (() => { const m = el('div', 'ntp-mode'); m.append(el('span', 'on', 'Search'), el('span', '', 'Ask AI')); return m; })());
    const col = el('div', 'ntp-col'); col.append(head, search);
    const cards = el('div', 'ntp-cards');
    for (const [title, body] of [['Weather', '18°'], ['Notes', null], ['Tasks', null]]) {
      const c = el('div', 'ntp-card'); c.append(el('b', '', title));
      if (body) c.append(el('em', '', body)); else c.append(el('i', 'hi'), el('i'));
      cards.append(c);
    }
    stage.append(col, cards);
    box.append(bg, scrim, canvas, stage);

    let hovered = null; // { background } or { effect } while the pointer or keyboard is on a tile
    let liveName = null; // what is typed in the name field, before it is saved
    let pic = { v: -1, data: null }; // the background picture, fetched when first needed (and again when it changes)
    let fx = null;
    let dirty = true; let onScreen = false; let queued = false;

    const prefsOf = () => opts.state()?.prefs || {};
    const lookOf = () => {
      const p = prefsOf();
      let id = hovered?.background || (p.newTabShuffle === true ? BG.dailyPick() : p.newTabBackground);
      if (id === 'image' && !p.newTabImage) id = 'plain'; // (a picture that is gone is Plain, as on the page)
      if (!BG.byId(id)) id = 'plain';
      return { p, id, effect: hovered?.effect || p.newTabEffect || 'none' };
    };
    const picture = () => { // fetched once per picture
      const v = prefsOf().newTabImage || 0;
      if (pic.v !== v) { pic = { v, data: null }; if (v) Promise.resolve(opts.picture()).then((d) => { if (pic.v === v) { pic.data = d; schedule(); } }).catch(() => {}); }
      return pic.data;
    };

    function render() {
      dirty = false;
      const { p, id, effect } = lookOf();
      const tone = BG.toneOf(id); // 'plain', 'dark' or 'light': the same call the new-tab page makes
      const image = id === 'image' ? picture() : null;
      const mode = BG.modeOf(id, dark.matches);
      box.className = `bg-preview ntp tone-${tone}${effect !== 'none' ? ' has-fx' : ''}`;
      box.dataset.tone = tone; box.dataset.bg = id; box.dataset.effect = effect;
      // background
      const item = BG.byId(id);
      bg.className = `ntp-bg bg-${id}`;
      bg.style.background = image ? `#000 url("${image.url}") center / cover no-repeat` : item?.art || '';
      scrim.hidden = id !== 'image';
      // accent, in the shade the page is drawn in (features/theme-colors.js)
      const seed = id === 'image' ? image?.colors?.[0] || null : item?.seed || null;
      const accent = TC.accentOf(p.accentColor, seed)[mode];
      const tokens = TC.tokensFor(accent, mode);
      for (const [k, v] of Object.entries(TC.varsOf(tokens))) box.style.setProperty(k, v);
      // clock, greeting, search, cards
      const cs = CS.clean({ style: p.newTabClockStyle, hours: p.newTabClockHours, seconds: p.newTabClockSeconds, date: p.newTabClockDate, card: p.newTabClockCard, shadow: p.newTabClockShadow, greeting: p.newTabGreetingFont });
      box.dataset.clockStyle = cs.style; box.dataset.clockCard = cs.card; box.dataset.clockShadow = cs.shadow ? '1' : '0';
      box.dataset.greetingFont = CS.greetingFontFor(cs.greeting, cs.style);
      box.dataset.glass = ['frosted', 'clear'].includes(p.newTabWidgetGlass) ? p.newTabWidgetGlass : 'solid';
      stage.style.setProperty('--clock-size', `${opts.state()?.clockPx?.[p.newTabClockSize] || 88}px`);
      stage.style.setProperty('--search-w', `${Math.min(1000, Math.max(480, Number(p.newTabSearchWidth) || 640))}px`); // (the page's own range; 640 is Automatic)
      const now = new Date();
      const t = CS.clockParts(now, { hours: cs.hours, seconds: cs.seconds });
      clockH.textContent = cs.style === 'bold' && /^\d$/.test(t.h) ? `0${t.h}` : t.h; clockSep.textContent = t.sep; clockM.textContent = t.m; clockS.textContent = t.s ? `${t.ssep}${t.s}` : '';
      clock.hidden = p.newTabClock === false;
      date.hidden = !cs.date;
      clockCard.hidden = clock.hidden && date.hidden;
      date.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      const name = (liveName ?? p.newTabName ?? '').trim().slice(0, 40);
      hello.textContent = name ? `${CS.greetingFor(now)}, ${name}` : CS.greetingFor(now);
      // the animated effect, on its own small canvas
      applyEffect(p, effect, tokens.accent);
      fit();
    }

    function applyEffect(p, effect, accent) {
      canvas.hidden = effect === 'none';
      if (effect === 'none' && !fx) return;
      withEffects(() => {
        if (!window.createEffectPreview) return;
        fx ||= window.createEffectPreview(canvas, { stageW: STAGE.w, stageH: STAGE.h });
        const moving = !p.reduceMotion && !opts.state()?.performance?.active && !reduced.matches; // Reduce motion and Performance mode: one still frame, as on the page
        fx.set({ name: effect, color: p.newTabEffectColor, amount: p.newTabEffectAmount, speed: p.newTabEffectSpeed, size: p.newTabEffectSize, text: getComputedStyle(box).color, accent, animate: moving });
      });
    }

    function fit() { const w = box.clientWidth; if (w > 0) box.style.setProperty('--k', String(w / STAGE.w)); }
    const schedule = () => { // coalesce a burst of changes into one draw, and draw nothing while it cannot be seen
      dirty = true;
      if (!onScreen || queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (onScreen && dirty) render(); });
    };

    if (typeof IntersectionObserver === 'function') new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1].isIntersecting; if (onScreen && dirty) render(); }).observe(box);
    else { onScreen = true; }
    if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(box);
    window.addEventListener('lumen-pref', (e) => { if (e.detail?.key === 'newTabName') liveName = null; schedule(); });
    document.addEventListener('input', (e) => { if (e.target?.id === 'pref-newTabName') { liveName = e.target.value; schedule(); } });
    dark.addEventListener('change', schedule);
    reduced.addEventListener('change', schedule);

    const api = {
      el: box,
      refresh: schedule, // after the state was replaced (a picture picked or removed, shuffle changed)
      hover(over) { hovered = over || null; schedule(); }, // { background } or { effect }: just that, the rest as chosen
      // For tests: what is drawn now.
      info: () => ({ background: box.dataset.bg, tone: box.dataset.tone, effect: box.dataset.effect, glass: box.dataset.glass, clockStyle: box.dataset.clockStyle, greetingFont: box.dataset.greetingFont, accent: getComputedStyle(box).getPropertyValue('--accent').trim(), fx: fx?.info() || null }),
    };
    window.NewTabPreview.last = api; // (the tests read what is drawn: info())
    return api;
  }

  window.NewTabPreview = { create, last: null };
})();
