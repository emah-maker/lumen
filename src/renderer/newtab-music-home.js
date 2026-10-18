// The Spotify card's Home tab: shelves like open.spotify.com's Home (quick picks under a greeting, jump back in, made for you, recently played, top songs and
// artists, new releases, your playlists, albums and followed artists), drawn from what main read through the Web API (features/spotify-api-card.js, the `home` field).
// Loaded the first time the Home tab is opened (renderer/newtab-music.js drawHome), never with the page. A shelf is asked for when it scrolls into view (an
// IntersectionObserver on the tab's panel); a tile plays when pressed, shows a play button on hover or focus, and a song has an "add to the queue" button.
// The words come from main (locales/en.json, spotify.home.*) in `d.homeText`; the colours are the page's theme tokens.
'use strict';

(() => {
  const SHELF_ORDER = ['quick', 'jump', 'made', 'recent', 'toptracks', 'topartists', 'new', 'playlists', 'albums', 'artists'];
  const ASK_AGAIN_MS = 60e3;
  const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
  const KINDS = ['song', 'album', 'playlist', 'artist'];
  const CSS = `
    .hm { display: flex; flex-direction: column; gap: 14px; padding: 2px 0 8px; }
    .hm-greet { margin: 0; font-size: 18px; font-weight: 700; }
    .hm-head { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; }
    .hm-head h3 { flex: 1 1 auto; margin: 0; font-size: 14px; font-weight: 700; }
    .hm-scroll { appearance: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; background: var(--field); color: var(--text); font: inherit; font-size: 13px; line-height: 1; cursor: pointer; }
    .hm-scroll:hover { background: var(--hover); }
    .hm-scroll:focus-visible, .hm-main:focus-visible, .hm-queue:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .hm-row { display: flex; gap: 10px; margin: 0; padding: 0 0 6px; list-style: none; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scrollbar-width: thin; }
    .hm-tile { position: relative; flex: none; width: 112px; scroll-snap-align: start; }
    .hm-main { appearance: none; display: flex; flex-direction: column; gap: 4px; width: 100%; margin: 0; padding: 4px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .hm-main:hover { background: var(--hover); }
    .hm-cover { display: block; width: 104px; height: 104px; border-radius: 6px; object-fit: cover; background: var(--field); }
    .hm-tile[data-kind="artist"] .hm-cover { border-radius: 50%; }
    .hm-title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hm-sub { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 14px; }
    .hm-play { position: absolute; right: 12px; top: 74px; width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: grid; place-items: center; opacity: 0; transform: translateY(4px); pointer-events: none; transition: opacity 0.12s, transform 0.12s; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
    .hm-play svg { width: 12px; height: 12px; fill: currentColor; }
    .hm-tile:hover .hm-play, .hm-tile:focus-within .hm-play { opacity: 1; transform: none; }
    .hm-queue { appearance: none; position: absolute; left: 8px; top: 8px; margin: 0; padding: 2px 6px; border: 0; border-radius: 6px; background: var(--card); color: var(--text); font: inherit; font-size: 11px; cursor: pointer; opacity: 0; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); }
    .hm-tile:hover .hm-queue, .hm-tile:focus-within .hm-queue { opacity: 1; }
    .hm-queue:hover { background: var(--hover); }
    .hm-quick { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; margin: 0; padding: 0; list-style: none; }
    .hm-quick .hm-tile { width: auto; }
    .hm-quick .hm-main { flex-direction: row; align-items: center; gap: 8px; padding: 0; background: var(--field); overflow: hidden; }
    .hm-quick .hm-cover { width: 44px; height: 44px; border-radius: 6px 0 0 6px; flex: none; }
    .hm-quick .hm-title { flex: 1 1 auto; min-width: 0; padding-right: 8px; }
    .hm-quick .hm-sub { display: none; }
    .hm-quick .hm-play { top: 8px; right: 6px; width: 26px; height: 26px; }
    .hm-quick .hm-queue { display: none; }
    .hm-skel .hm-cover, .hm-skel .hm-title { background: var(--field); color: transparent; border-radius: 6px; }
    .hm-note { margin: 0; font-size: 12px; color: var(--muted); }
    .hm-banner { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-radius: 8px; background: var(--field); font-size: 12px; }
    @media (prefers-reduced-motion: reduce) { .hm-play { transition: none; } }
  `;
  const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';

  function installCss() {
    if (document.getElementById('hm-css')) return;
    const s = document.createElement('style');
    s.id = 'hm-css';
    s.textContent = CSS;
    document.head.append(s);
  }
  const say = (d, key, vars) => {
    const raw = d.homeText && typeof d.homeText[key] === 'string' ? d.homeText[key] : '';
    return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : raw;
  };
  const greetingKey = (hour) => (hour < 12 ? 'greetingMorning' : hour < 18 ? 'greetingAfternoon' : 'greetingEvening');
  const clean = (list, thumbOk) => (Array.isArray(list) ? list : []).filter((i) => i && typeof i.id === 'string' && SAFE_ID.test(i.id) && KINDS.includes(i.kind) && typeof i.title === 'string' && i.title).map((i) => ({ id: i.id, kind: i.kind, title: i.title.slice(0, 120), sub: typeof i.sub === 'string' ? i.sub.slice(0, 120) : '', thumb: thumbOk(i.thumb) ? i.thumb : '' }));

  // h: { panel, d, ui, act, el, thumbOk, fill, sig }
  function draw(h) {
    installCss();
    const { panel, d, ui, act, el, thumbOk } = h;
    const shelves = d.home && d.home.shelves && typeof d.home.shelves === 'object' ? d.home.shelves : {};
    const asked = (ui.homeAsked ||= {});
    const scroll = (ui.homeScroll ||= {});
    const hour = new Date().getHours();
    const state = SHELF_ORDER.map((k) => { const s = shelves[k]; return s ? [k, s.ok !== false, s.why || '', s.pending === true, (s.items || []).map((i) => `${i.id}${thumbOk(i.thumb) ? 1 : 0}`).join()] : [k]; });
    const needsScope = SHELF_ORDER.some((k) => shelves[k] && shelves[k].ok === false && shelves[k].why === 'scope');
    const connect = Boolean(d.home && d.home.connect); // (Play as Lumen without the account connected: Home has nothing to read it with)
    const sign = d.signIn && typeof d.signIn === 'object' ? { state: String(d.signIn.state || ''), message: typeof d.signIn.message === 'string' ? d.signIn.message.slice(0, 300) : '' } : null;
    const changed = h.fill(panel, h.sig([state, needsScope, connect, sign, greetingKey(hour), d.homeText && d.homeText.tab]), (box) => {
      const root = el('div', 'hm');
      root.append(el('h2', 'hm-greet', say(d, greetingKey(hour))));
      if (needsScope || connect || sign) {
        // One bar: what is wrong and one button that starts Spotify's sign-in right here (the card asks main for do=reconnect; no detour through Settings).
        const b = el('div', 'hm-banner');
        b.setAttribute('role', 'status');
        const waiting = sign && sign.state === 'waiting';
        b.append(el('span', '', sign && sign.message ? sign.message : connect ? say(d, 'connectText') : say(d, 'reconnect')));
        const btn = el('button', 'w-btn primary', connect ? say(d, 'connectButton') : say(d, 'reconnectButton'));
        btn.type = 'button';
        btn.disabled = Boolean(waiting);
        btn.addEventListener('click', () => act('reconnect'));
        b.append(btn);
        if (sign && sign.state === 'allowlist') { // (Lumen's own app only lets 25 listed accounts in: the steps for the user's own app are in the card's editor)
          const own = el('button', 'w-btn', say(d, 'ownApp'));
          own.type = 'button';
          own.addEventListener('click', () => act('configure'));
          b.append(own);
        }
        root.append(b);
      }
      if (connect) { box.append(root); return; }
      for (const key of SHELF_ORDER) {
        const s = shelves[key];
        const items = clean(s && s.items, thumbOk);
        if (s && s.ok === false) continue; // (a shelf Spotify does not give this account, or gave an error: left out, not faked; a missing scope is the banner above)
        if (s && !s.pending && !items.length) continue; // (answered with nothing: no empty shelf)
        const sec = el('section', key === 'quick' ? 'hm-sec hm-sec-quick' : 'hm-sec');
        sec.dataset.shelf = key;
        const title = say(d, key);
        const loading = !s || (s.pending && !items.length);
        if (key !== 'quick') {
          const head = el('div', 'hm-head');
          head.append(el('h3', '', title));
          if (!loading) {
            for (const [dir, glyph, label] of [[-1, '‹', 'scrollLeft'], [1, '›', 'scrollRight']]) {
              const b = el('button', 'hm-scroll', glyph);
              b.type = 'button';
              b.setAttribute('aria-label', say(d, label, { title }));
              b.addEventListener('click', () => { const row = sec.querySelector('.hm-row'); if (row) row.scrollBy({ left: dir * Math.max(120, row.clientWidth * 0.8), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
              head.append(b);
            }
          }
          sec.append(head);
        }
        const list = el('ul', key === 'quick' ? 'hm-quick' : 'hm-row');
        list.setAttribute('aria-label', title);
        if (loading) {
          list.classList.add('hm-skel');
          list.setAttribute('aria-busy', 'true');
          for (let i = 0; i < (key === 'quick' ? 6 : 5); i++) { const li = el('li', 'hm-tile'); const m = el('div', 'hm-main'); m.append(el('span', 'hm-cover'), el('span', 'hm-title', '·')); li.append(m); list.append(li); }
        } else {
          for (const it of items) {
            const li = el('li', 'hm-tile');
            li.dataset.kind = it.kind;
            li.dataset.id = it.id;
            const main = el('button', 'hm-main');
            main.type = 'button';
            main.setAttribute('aria-label', say(d, 'play', { title: it.title }));
            if (it.thumb) { const img = document.createElement('img'); img.className = 'hm-cover'; img.alt = ''; img.loading = 'eager'; img.decoding = 'async'; img.src = it.thumb; main.append(img); } else main.append(el('span', 'hm-cover none'));
            main.append(el('span', 'hm-title', it.title));
            if (key !== 'quick') main.append(el('span', 'hm-sub', it.sub));
            main.addEventListener('click', () => act('playitem', { kind: it.kind, arg: it.id }));
            li.append(main);
            const play = el('span', 'hm-play');
            play.innerHTML = PLAY_ICON; // (a fixed icon; nothing from the data)
            play.setAttribute('aria-hidden', 'true');
            li.append(play);
            if (it.kind === 'song') {
              const q = el('button', 'hm-queue', say(d, 'queueShort'));
              q.type = 'button';
              q.setAttribute('aria-label', say(d, 'queue', { title: it.title }));
              q.addEventListener('click', (e) => { e.stopPropagation(); act('playlater', { kind: 'song', arg: it.id }); });
              li.append(q);
            }
            list.append(li);
          }
          list.addEventListener('scroll', () => { scroll[key] = list.scrollLeft; }, { passive: true });
        }
        sec.append(list);
        root.append(sec);
      }
      box.append(root);
      for (const [k, x] of Object.entries(scroll)) { const row = box.querySelector(`[data-shelf="${k}"] .hm-row`); if (row && x) row.scrollLeft = x; }
    });
    // The shelves are asked for as they come into view (not all ten at once): the ones at the top at once, the rest when scrolled to.
    const ask = (key) => {
      const s = shelves[key];
      const fresh = Date.now() - (asked[key] || 0) > (s ? ASK_AGAIN_MS : 3000); // (a shelf main has no data for — a new sign-in reset the card — is asked for again at once)
      if (!fresh || (s && s.pending)) return;
      asked[key] = Date.now();
      act('ehome', { arg: key });
    };
    // Which shelves are in view, kept by the observer; one that is in view and still has nothing (its ask was too soon after a sign-in reset the card, or was lost) is
    // asked for again a few seconds later.
    const visible = (panel._visible ||= new Set());
    panel._latest = { shelves, ask };
    const recheck = () => {
      if (panel._retry || !panel.isConnected) return;
      panel._retry = setTimeout(() => {
        panel._retry = null;
        if (!panel.isConnected) return;
        const now = panel._latest;
        let again = false;
        for (const k of visible) { const s = now.shelves[k]; if (!s && !(d.home && d.home.connect)) { now.ask(k); again = true; } }
        if (again) recheck();
      }, 3200);
    };
    if (changed || !panel._io) {
      if (panel._io) panel._io.disconnect();
      visible.clear();
      const sections = [...panel.querySelectorAll('[data-shelf]')];
      if (typeof IntersectionObserver !== 'function') { for (const s of sections.slice(0, 3)) ask(s.dataset.shelf); return; }
      panel._io = new IntersectionObserver((entries) => { for (const e of entries) { const k = e.target.dataset.shelf; if (e.isIntersecting) { visible.add(k); panel._latest.ask(k); } else visible.delete(k); } recheck(); }, { root: panel, rootMargin: '0px 0px 300px 0px' });
      for (const s of sections) panel._io.observe(s);
    }
  }

  window.MusicHome = { draw, SHELF_ORDER };
})();
