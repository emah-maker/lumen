// The Spotify card's Library tab, like Spotify's: Liked Songs first, then all the playlists (read a page at a time as the list scrolls), Albums and Artists behind filter
// chips, a filter box; a row opens in the card (a header with the cover, name, owner and song count, Play and Shuffle, then the songs, paged in as the list scrolls; a song
// plays inside its list; hover or focus shows Add to queue); Back (the button, Esc or Backspace) returns to the list at the same scroll. Loaded the first time the Library
// is shown (renderer/newtab-music.js drawLibraryV2), never with the page. The data is main's (features/spotify-library.js: the `lib2` field), the words are main's too
// (`libText`, locales/en.json spotify.library.*), the colours are the page's theme tokens.
'use strict';

(() => {
  const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
  const CHIPS = [['playlists', 'chipPlaylists'], ['albums', 'chipAlbums'], ['artists', 'chipArtists']];
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.7 4.5 6.3 4.5c2 0 3.5 1 4.5 2.6l1.2 1.7 1.2-1.7c1-1.6 2.5-2.6 4.5-2.6 3.6 0 5.4 3.9 3.9 7.3C19.5 16.4 12 21 12 21z"/></svg>';
  const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
  const CSS = `
    .lv-bar { position: sticky; top: 0; z-index: 2; display: flex; flex-direction: column; gap: 6px; padding: 2px 2px 6px; background: var(--card); }
    .lv-filter { box-sizing: border-box; width: 100%; height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--field); color: var(--text); font: inherit; font-size: 12px; }
    .lv-filter:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .lv-chips { display: flex; gap: 6px; }
    .lv-chip { appearance: none; margin: 0; padding: 3px 10px; border: 0; border-radius: 999px; background: var(--field); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
    .lv-chip:hover { background: var(--hover); }
    .lv-chip[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); }
    .lv-chip:focus-visible, .lv-row:focus-visible, .lv-btn:focus-visible, .lv-back:focus-visible, .lv-play:focus-visible, .lv-q:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .lv-list { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; }
    .lv-row { appearance: none; display: flex; align-items: center; gap: 8px; width: 100%; margin: 0; padding: 4px 6px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .lv-row:hover { background: var(--hover); }
    .lv-cover { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 4px; object-fit: cover; background: var(--field); color: var(--text); }
    .lv-row[data-kind="artist"] .lv-cover { border-radius: 50%; }
    .lv-heart { background: linear-gradient(135deg, var(--accent), var(--accent-deep)); color: var(--on-accent); }
    .lv-heart svg { width: 18px; height: 18px; fill: currentColor; }
    .lv-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
    .lv-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lv-sub { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lv-note { margin: 6px 4px; font-size: 12px; color: var(--muted); }
    .lv-head { display: flex; align-items: center; gap: 10px; padding: 2px 2px 8px; }
    .lv-head .lv-cover { width: 72px; height: 72px; border-radius: 6px; }
    .lv-head .lv-heart svg { width: 32px; height: 32px; }
    .lv-name { margin: 0; font-size: 16px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .lv-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .lv-actions { display: flex; gap: 6px; margin-top: 6px; }
    .lv-back { appearance: none; margin: 0 0 4px; padding: 2px 8px; border: 0; border-radius: 6px; background: var(--field); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; align-self: flex-start; }
    .lv-back:hover, .lv-btn:hover { background: var(--hover); }
    .lv-btn { appearance: none; margin: 0; padding: 4px 12px; border: 0; border-radius: 999px; background: var(--field); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
    .lv-btn.primary { background: var(--accent); color: var(--on-accent); }
    .lv-h { margin: 8px 4px 4px; font-size: 13px; font-weight: 700; }
    .lv-track { position: relative; display: flex; align-items: center; border-radius: 8px; }
    .lv-track:hover, .lv-track:focus-within { background: var(--hover); }
    .lv-track .lv-row { flex: 1 1 auto; min-width: 0; padding-right: 64px; }
    .lv-track:hover .lv-row, .lv-track:focus-within .lv-row { background: transparent; }
    .lv-num { flex: none; width: 26px; text-align: right; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .lv-track .lv-cover { width: 28px; height: 28px; }
    .lv-dur { flex: none; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .lv-acts { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: none; gap: 4px; align-items: center; }
    .lv-track:hover .lv-acts, .lv-track:focus-within .lv-acts { display: flex; }
    .lv-track:hover .lv-dur, .lv-track:focus-within .lv-dur { visibility: hidden; }
    .lv-play { appearance: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: grid; place-items: center; cursor: pointer; }
    .lv-play svg { width: 10px; height: 10px; fill: currentColor; }
    .lv-q { appearance: none; margin: 0; padding: 2px 6px; border: 0; border-radius: 6px; background: var(--card); color: var(--text); font: inherit; font-size: 11px; cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
    .lv-track.current .lv-title { color: var(--accent-text); }
    .lv-more { height: 24px; }
  `;
  const fmt = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function installCss() {
    if (document.getElementById('lv-css')) return;
    const s = document.createElement('style');
    s.id = 'lv-css';
    s.textContent = CSS;
    document.head.append(s);
  }
  const say = (d, key, vars) => {
    const raw = d.libText && typeof d.libText[key] === 'string' ? d.libText[key] : '';
    return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : raw;
  };
  const clean = (list, thumbOk, kindOk) => (Array.isArray(list) ? list : []).filter((i) => i && typeof i.id === 'string' && SAFE_ID.test(i.id) && typeof i.title === 'string' && i.title && kindOk(i.kind)).map((i) => ({
    id: i.id, kind: i.kind, title: i.title.slice(0, 120), sub: typeof i.sub === 'string' ? i.sub.slice(0, 120) : '', album: typeof i.album === 'string' ? i.album.slice(0, 120) : '',
    count: Number.isInteger(i.count) ? i.count : null, ms: Number.isFinite(i.ms) ? i.ms : 0, pos: Number.isInteger(i.pos) ? i.pos : -1, thumb: thumbOk(i.thumb) ? i.thumb : '' }));

  // h: { panel, d, ui, act, el, thumbOk }
  function draw(h) {
    installCss();
    const { panel, d, ui, act, el, thumbOk } = h;
    const S = (ui.lv ||= { view: 'list', chip: 'playlists', filter: '', open: null, stack: [], listScroll: 0, restore: false, asked: new Set(), moreAsked: {}, focusKey: '' });
    const lib = d.lib2 && typeof d.lib2 === 'object' ? d.lib2 : { lists: {}, detail: null, likedTotal: null };
    // ---- the frame, built once: the bar (filter, chips) and the body ----
    if (!panel._lv) {
      const bar = el('div', 'lv-bar');
      const input = el('input', 'lv-filter');
      input.type = 'search';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.addEventListener('input', () => { S.filter = input.value.slice(0, 60); S.restore = false; panel._lv.redraw(); });
      const chips = el('div', 'lv-chips');
      chips.setAttribute('role', 'group');
      bar.append(input, chips);
      const body = el('div', 'lv-body');
      panel.replaceChildren(bar, body);
      panel._lv = { bar, input, chips, body, redraw: () => {}, io: null };
      panel.addEventListener('scroll', () => { if (S.view === 'list') S.listScroll = panel.scrollTop; else if (S.stack.length || S.view === 'detail') S.detailScroll = panel.scrollTop; }, { passive: true });
      panel.addEventListener('keydown', (e) => {
        if (S.view !== 'detail' || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === 'Escape' || (e.key === 'Backspace' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName))) { e.preventDefault(); e.stopPropagation(); panel._lv.back(); }
      });
    }
    const F = panel._lv;
    const redraw = () => draw(h);
    F.redraw = redraw;
    F.back = () => back(); // (rows and buttons are drawn only when the list changes, and the key handler is set once: they go through F, which always holds the latest draw's functions)
    F.open = (item) => open(item);
    F.input.setAttribute('aria-label', say(d, 'filterLabel'));
    F.input.placeholder = say(d, 'filter');
    if (F.input.value !== S.filter) F.input.value = S.filter;
    F.chips.setAttribute('aria-label', say(d, 'chips'));
    F.bar.hidden = S.view === 'detail';

    const render = (signature, build) => {
      if (F.body._sig === signature) return false;
      F.body._sig = signature;
      const top = panel.scrollTop;
      if (F.io) { F.io.disconnect(); F.io = null; }
      F.body.replaceChildren();
      build(F.body);
      panel.scrollTop = S.restore ? S.listScroll : top;
      if (S.restore) S.restore = false;
      return true;
    };
    // pictures: the rows on screen without one are asked for together (a dozen at a time)
    const watch = (rows) => {
      const todo = [...rows].filter(([, id]) => !S.asked.has(id));
      if (!todo.length) return;
      const byRow = new Map(todo);
      let batch = [];
      let timer = null;
      const flush = () => { timer = null; const ids = [...new Set(batch)].filter((x) => !S.asked.has(x)).slice(0, 12); batch = []; if (!ids.length) return; for (const x of ids) S.asked.add(x); act('ethumb', { arg: ids.join(',') }); };
      F.io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting && byRow.has(e.target)) { batch.push(byRow.get(e.target)); F.io.unobserve(e.target); }
        if (batch.length && !timer) timer = setTimeout(flush, 120);
      }, { root: panel, rootMargin: '100px 0px' });
      for (const [row] of todo) F.io.observe(row);
    };
    const note = (box, message, button, onClick) => {
      const p = el('p', 'lv-note', message);
      p.setAttribute('role', 'status');
      box.append(p);
      if (button) { const b = el('button', 'lv-btn', button); b.type = 'button'; b.addEventListener('click', onClick); box.append(b); }
    };

    function back() {
      const prev = S.stack.pop();
      if (prev) { S.open = prev.open; S.view = 'detail'; S.restore = false; act('edetail', { kind: prev.open.kind, arg: prev.open.id }); } else { S.view = 'list'; S.open = null; S.restore = true; }
      F.body._sig = null;
      draw(h);
      const key = S.focusKey && F.body.querySelector(`[data-key="${S.focusKey}"]`);
      if (key && S.view === 'list') key.focus({ preventScroll: true });
    }
    function open(item) {
      if (S.view === 'list') S.listScroll = panel.scrollTop; else S.stack.push({ open: S.open });
      S.focusKey = `${item.kind}:${item.id}`;
      S.open = { kind: item.kind, id: item.id, title: item.title, sub: item.sub, count: item.count, thumb: item.thumb };
      S.view = 'detail';
      F.body._sig = null;
      act('edetail', { kind: item.kind, arg: item.id });
      draw(h);
      panel.scrollTop = 0;
      F.body.querySelector('.lv-back')?.focus({ preventScroll: true });
    }
    const coverOf = (item, big) => {
      if (item.kind === 'liked') { const c = el('span', `lv-cover lv-heart`); c.innerHTML = HEART; c.setAttribute('aria-hidden', 'true'); return c; }
      if (item.thumb) { const i = document.createElement('img'); i.className = 'lv-cover'; i.alt = ''; i.decoding = 'async'; i.src = item.thumb; return i; }
      void big;
      return el('span', 'lv-cover none');
    };

    // ---- the list view ----
    if (S.view === 'list') {
      F.chips.replaceChildren(...CHIPS.map(([k, label]) => {
        const b = el('button', 'lv-chip', say(d, label));
        b.type = 'button';
        b.setAttribute('aria-pressed', String(S.chip === k));
        b.addEventListener('click', () => { S.chip = k; S.listScroll = 0; S.restore = false; F.body._sig = null; if (!lib.lists[k]) act('elib', { arg: k }); draw(h); });
        return b;
      }));
      const list = lib.lists[S.chip] || { items: [], done: false, loading: false, ok: true, why: '' };
      const q = S.filter.trim().toLowerCase();
      let items = clean(list.items, thumbOk, (k) => ['playlist', 'album', 'artist'].includes(k));
      const likedRow = S.chip === 'playlists' ? { id: 'liked', kind: 'liked', title: say(d, 'liked'), sub: lib.likedTotal === null || lib.likedTotal === undefined ? '' : say(d, 'likedSub', { n: lib.likedTotal }), count: lib.likedTotal, thumb: '' } : null;
      if (q) items = items.filter((i) => i.title.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q));
      const showLiked = likedRow && (!q || likedRow.title.toLowerCase().includes(q));
      const rowsList = showLiked ? [likedRow, ...items] : items;
      const withPic = items.filter((i) => i.thumb).length;
      const state = !lib.lists.playlists && !d.lib2 ? 'wait' : list.ok === false ? `err:${list.why}` : 'rows';
      render([S.view, S.chip, q, state, rowsList.map((i) => i.id).join(), withPic, list.done, list.loading, lib.likedTotal, say(d, 'liked')], (box) => {
        if (state === 'wait') { note(box, say(d, 'loading')); return; }
        if (state.startsWith('err:')) {
          if (state === 'err:scope') note(box, say(d, 'scope'), say(d, 'reconnectButton'), () => act('reconnect'));
          else note(box, say(d, 'failed'), say(d, 'retry'), () => act('elib', { arg: S.chip, force: '1' }));
          return;
        }
        if (!rowsList.length && list.done) { note(box, q ? say(d, 'noMatch') : say(d, 'empty')); return; }
        const ul = el('ul', 'lv-list');
        ul.setAttribute('aria-label', say(d, S.chip === 'albums' ? 'chipAlbums' : S.chip === 'artists' ? 'chipArtists' : 'chipPlaylists'));
        const pics = [];
        for (const it of rowsList) {
          const li = el('li');
          const b = el('button', 'lv-row');
          b.type = 'button';
          b.dataset.kind = it.kind;
          b.dataset.key = `${it.kind}:${it.id}`;
          b.setAttribute('aria-label', say(d, 'open', { title: it.title }));
          b.append(coverOf(it));
          const t = el('span', 'lv-text');
          t.append(el('span', 'lv-title', it.title));
          const sub = it.kind === 'liked' ? it.sub : [it.sub, it.kind === 'playlist' && it.count !== null ? say(d, 'songs', { n: it.count }) : ''].filter(Boolean).join(' · ');
          if (sub) t.append(el('span', 'lv-sub', sub));
          b.append(t);
          b.addEventListener('click', () => F.open(it));
          li.append(b);
          ul.append(li);
          if (it.kind !== 'liked' && !it.thumb) pics.push([b, it.id]);
        }
        box.append(ul);
        if (!list.done) { note(box, say(d, 'loadingMore')); }
        watch(pics);
      });
      // more pages: as the end of the list scrolls into view, and at once while a filter is waiting for rows that are not read yet
      if (!list.done && !list.loading && list.ok !== false) {
        const have = list.items.length;
        const ask = () => { if (S.moreAsked[S.chip] === have) return; S.moreAsked[S.chip] = have; act('elib', { arg: S.chip, more: '1' }); };
        if (q) ask();
        else { F.io2?.disconnect(); const end = F.body.lastElementChild; if (end && typeof IntersectionObserver === 'function') { F.io2 = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) ask(); }, { root: panel, rootMargin: '0px 0px 240px 0px' }); F.io2.observe(end); } else ask(); }
      }
      return;
    }

    // ---- the opened list ----
    F.io2?.disconnect();
    const o = S.open;
    const det = lib.detail && o && lib.detail.kind === o.kind && lib.detail.id === o.id ? lib.detail : null;
    const kindOk = () => true;
    const rows = det ? clean(det.items, thumbOk, kindOk) : [];
    const sections = det && det.sections ? { top: clean(det.sections.top, thumbOk, kindOk), albums: clean(det.sections.albums, thumbOk, kindOk), topOk: det.sections.topOk === true } : null;
    const title = o ? (o.kind === 'liked' ? say(d, 'liked') : o.title || (det && det.title) || '') : '';
    const total = det && Number.isInteger(det.total) ? det.total : o && Number.isInteger(o.count) ? o.count : null;
    const metaParts = [o && o.kind === 'playlist' && (det?.sub || o.sub) ? say(d, 'by', { title: det?.sub || o.sub }) : '', o && o.kind === 'album' ? (det?.sub || o.sub) : '', total !== null && o && o.kind !== 'artist' ? say(d, 'songs', { n: total }) : '', o && o.kind === 'artist' ? say(d, 'artist') : ''].filter(Boolean);
    const state = !det ? 'wait' : det.ok === false ? `err:${det.why}` : 'rows';
    render(['detail', o && o.kind, o && o.id, state, rows.map((r) => `${r.pos}${r.thumb ? 1 : 0}`).join(), sections ? [sections.top.length, sections.albums.length, sections.topOk, sections.top.map((r) => r.thumb ? 1 : 0).join(), sections.albums.map((r) => r.thumb ? 1 : 0).join()] : 0, det && det.done, det && det.loading, title, total, S.stack.length, det && det.truncated], (box) => {
      const back_ = el('button', 'lv-back', `‹ ${say(d, 'back')}`);
      back_.type = 'button';
      back_.setAttribute('aria-label', say(d, 'backLabel'));
      back_.addEventListener('click', () => F.back());
      box.append(back_);
      const head = el('div', 'lv-head');
      head.append(coverOf({ kind: o.kind, thumb: o.thumb }, true));
      const text = el('div', 'lv-text');
      const hn = el('h3', 'lv-name', title);
      text.append(hn);
      if (metaParts.length) text.append(el('div', 'lv-meta', metaParts.join(' · ')));
      const acts = el('div', 'lv-actions');
      for (const [label, key, shuffle] of [['play', 'playLabel', false], ['shuffle', 'shuffleLabel', true]]) {
        const b = el('button', `lv-btn${shuffle ? '' : ' primary'}`, say(d, label));
        b.type = 'button';
        b.setAttribute('aria-label', say(d, key, { title }));
        b.addEventListener('click', () => act('eplay', shuffle ? { kind: o.kind, arg: o.id, shuffle: '1' } : { kind: o.kind, arg: o.id }));
        acts.append(b);
      }
      text.append(acts);
      head.append(text);
      box.append(head);
      if (state === 'wait') { note(box, say(d, 'loading')); return; }
      if (state.startsWith('err:')) {
        if (state === 'err:scope') note(box, say(d, 'scope'), say(d, 'reconnectButton'), () => act('reconnect'));
        else note(box, say(d, 'failed'), say(d, 'retry'), () => act('edetail', { kind: o.kind, arg: o.id, force: '1' }));
        return;
      }
      const pics = [];
      const trackRow = (ul, it, index, context) => {
        const li = el('li', 'lv-track');
        const b = el('button', 'lv-row');
        b.type = 'button';
        b.setAttribute('aria-label', say(d, 'trackPlay', { title: it.title, list: title }));
        b.append(el('span', 'lv-num', String(index + 1)));
        b.append(coverOf(it));
        const t = el('span', 'lv-text');
        t.append(el('span', 'lv-title', it.title));
        const sub = [it.sub, context === 'album' ? '' : it.album].filter(Boolean).join(' · ');
        if (sub) t.append(el('span', 'lv-sub', sub));
        b.append(t);
        if (it.ms > 0) b.append(el('span', 'lv-dur', fmt(it.ms)));
        b.addEventListener('click', () => (context === 'artist-top' ? act('playitem', { kind: 'song', arg: it.id }) : act('eplay', { kind: o.kind, arg: o.id, pos: String(it.pos), with: it.id })));
        li.append(b);
        const a = el('span', 'lv-acts');
        const p = el('button', 'lv-play');
        p.type = 'button';
        p.innerHTML = PLAY;
        p.setAttribute('aria-label', say(d, 'playLabel', { title: it.title }));
        p.addEventListener('click', () => b.click());
        const q = el('button', 'lv-q', say(d, 'queue'));
        q.type = 'button';
        q.setAttribute('aria-label', say(d, 'queue') && say(d, 'trackQueue', { title: it.title }));
        q.addEventListener('click', (e) => { e.stopPropagation(); act('playlater', { kind: 'song', arg: it.id }); });
        a.append(p, q);
        li.append(a);
        ul.append(li);
        if (!it.thumb) pics.push([b, it.id]);
      };
      if (sections) { // an artist
        if (sections.topOk && sections.top.length) {
          box.append(el('h4', 'lv-h', say(d, 'topSongs')));
          const ul = el('ol', 'lv-list');
          sections.top.forEach((it, i) => trackRow(ul, it, i, 'artist-top'));
          box.append(ul);
        } else if (!sections.topOk) note(box, say(d, 'noTop'));
        if (sections.albums.length) {
          box.append(el('h4', 'lv-h', say(d, 'albums')));
          const ul = el('ul', 'lv-list');
          for (const it of sections.albums) {
            const li = el('li');
            const b = el('button', 'lv-row');
            b.type = 'button';
            b.dataset.kind = 'album';
            b.setAttribute('aria-label', say(d, 'open', { title: it.title }));
            b.append(coverOf(it));
            const t = el('span', 'lv-text');
            t.append(el('span', 'lv-title', it.title), el('span', 'lv-sub', it.sub));
            b.append(t);
            b.addEventListener('click', () => F.open(it));
            li.append(b);
            ul.append(li);
            if (!it.thumb) pics.push([b, it.id]);
          }
          box.append(ul);
        }
        watch(pics);
        return;
      }
      if (!rows.length) { note(box, say(d, 'empty')); return; }
      const ul = el('ol', 'lv-list');
      ul.setAttribute('aria-label', title);
      rows.forEach((it, i) => trackRow(ul, it, i, o.kind));
      box.append(ul);
      if (det.truncated) note(box, say(d, 'truncated', { n: rows.length }));
      else if (!det.done) note(box, say(d, 'loadingMore'));
      watch(pics);
    });
    // the next page of songs, when the end of the list is in view
    if (det && det.ok !== false && !det.done && !det.loading && !sections) {
      const have = det.items.length;
      F.io2?.disconnect();
      const end = F.body.lastElementChild;
      const ask = () => { const k = `${o.kind}:${o.id}`; if (S.moreAsked[k] === have) return; S.moreAsked[k] = have; act('edetail', { kind: o.kind, arg: o.id, more: '1' }); };
      if (end && typeof IntersectionObserver === 'function') { F.io2 = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) ask(); }, { root: panel, rootMargin: '0px 0px 300px 0px' }); F.io2.observe(end); } else ask();
    }
  }

  window.MusicLibrary = { draw };
})();
