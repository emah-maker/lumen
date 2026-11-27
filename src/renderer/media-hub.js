/* global freezePage, thawPage */
// Media controls (features/media-hub.js): the toolbar's media button, shown while a tab plays sound or is paused mid-way, and its
// pop-up. Each row is one tab: the page's artwork and title (its Media Session metadata, else the tab's own), previous / play-pause / next
// when the page has them, mute (the same as the speaker on the tab), and a click on the title goes to the tab. The newest to start
// playing is on top; that is also the tab the keyboard's media keys control. Keys: ↑/↓ move between rows, Esc closes.
// The bridge is window.browser.mediaList / mediaAct / onMediaList (preload.js).
const mediaHub = (() => {
  const button = document.getElementById('media-btn');
  if (!button || !window.browser?.mediaAct) return null;
  const tr = (key, english, vars) => { const s = window.t?.(key, vars); return s && s !== key ? s : english.replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? ''); };
  const ICON = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="solid" d="M5 3.2v9.6L12.6 8z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect class="solid" x="4" y="3" width="2.8" height="10" rx="0.8"/><rect class="solid" x="9.2" y="3" width="2.8" height="10" rx="0.8"/></svg>',
    prev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="solid" d="M12.5 3.5v9L6 8z"/><path d="M4 3.5v9"/></svg>',
    next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="solid" d="M3.5 3.5v9L10 8z"/><path d="M12 3.5v9"/></svg>',
    speaker: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="solid" d="M3 6h2.5L9 3v10L5.5 10H3z"/><path class="wave" d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/><path class="cross" d="M11 6l4 4M15 6l-4 4"/></svg>',
    note: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 12V3.5l7-1.5V10.5"/><circle class="solid" cx="4.5" cy="12" r="1.8"/><circle class="solid" cx="11.5" cy="10.5" r="1.8"/></svg>',
  };
  let items = [];
  let panel = null;
  let list = null;
  let focusKey = null; // [row id, control] kept across a redraw

  const isOpen = () => Boolean(panel && !panel.hidden);

  function drawButton() {
    const show = items.length > 0;
    button.hidden = !show;
    button.classList.toggle('playing', items.some((x) => x.playing && !x.muted));
    const name = tr('media.button', 'Media controls');
    const first = items[0];
    const now = first ? (first.playing ? tr('media.button.playing', '{title} is playing', { title: first.title }) : tr('media.button.paused', '{title} is paused', { title: first.title })) : '';
    button.title = now ? `${name}: ${now}` : name;
    button.setAttribute('aria-label', name);
    if (!show && isOpen()) close();
  }

  function control(cls, icon, label, onClick, extra = {}) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: `media-ctl ${cls}`, innerHTML: icon, title: label });
    b.setAttribute('aria-label', label);
    if (extra.pressed !== undefined) b.setAttribute('aria-pressed', String(extra.pressed));
    b.dataset.ctl = cls.split(' ')[0];
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function row(item) {
    const li = Object.assign(document.createElement('li'), { className: `media-row${item.playing ? ' playing' : ''}${item.muted ? ' muted' : ''}` });
    li.dataset.id = String(item.id);
    const art = Object.assign(document.createElement('span'), { className: 'media-art' });
    const src = item.artwork || item.favicon;
    if (src) {
      const img = Object.assign(document.createElement('img'), { alt: '', src, referrerPolicy: 'no-referrer', decoding: 'async' });
      img.classList.toggle('icon', !item.artwork);
      img.addEventListener('error', () => { art.innerHTML = ICON.note; }, { once: true });
      art.append(img);
    } else art.innerHTML = ICON.note;
    const go = Object.assign(document.createElement('button'), { type: 'button', className: 'media-go' });
    go.dataset.ctl = 'go';
    const title = Object.assign(document.createElement('span'), { className: 'media-title', textContent: item.title || item.pageTitle });
    const sub = item.artist || (item.title !== item.pageTitle ? item.pageTitle : '');
    go.append(title);
    if (sub) go.append(Object.assign(document.createElement('span'), { className: 'media-sub', textContent: sub }));
    const goLabel = tr('media.goToTab', 'Go to tab: {title}', { title: item.pageTitle || item.title });
    go.title = goLabel;
    go.setAttribute('aria-label', [goLabel, item.title !== item.pageTitle ? item.title : '', item.artist, item.playing ? tr('media.state.playing', 'playing') : tr('media.state.paused', 'paused')].filter(Boolean).join(', '));
    go.addEventListener('click', () => { window.browser.mediaAct(item.id, 'show'); close(); });
    const ctls = Object.assign(document.createElement('span'), { className: 'media-ctls' });
    const name = item.title || item.pageTitle;
    if (item.canPrev) ctls.append(control('prev', ICON.prev, tr('media.previous', 'Previous track'), () => window.browser.mediaAct(item.id, 'previoustrack')));
    if (item.canPlay) ctls.append(control('playpause', item.playing ? ICON.pause : ICON.play, item.playing ? tr('media.pause', 'Pause {title}', { title: name }) : tr('media.play', 'Play {title}', { title: name }), () => window.browser.mediaAct(item.id, item.playing ? 'pause' : 'play')));
    if (item.canNext) ctls.append(control('next', ICON.next, tr('media.next', 'Next track'), () => window.browser.mediaAct(item.id, 'nexttrack')));
    const muteLabel = item.muted ? tr('menu.unmuteTab', 'Unmute tab') : tr('menu.muteTab', 'Mute tab');
    ctls.append(control(`mute${item.muted ? ' muted' : ''}`, ICON.speaker, muteLabel, () => window.browser.mediaAct(item.id, 'mute'), { pressed: item.muted }));
    li.append(art, go, ctls);
    return li;
  }

  function render() {
    if (!isOpen()) return;
    const had = document.activeElement && panel.contains(document.activeElement) ? document.activeElement : null;
    if (had) focusKey = [had.closest('.media-row')?.dataset.id, had.dataset.ctl];
    list.replaceChildren(...items.map(row));
    if (!items.length) list.append(Object.assign(document.createElement('li'), { className: 'media-empty', textContent: tr('media.empty', 'Nothing is playing') }));
    if (had && focusKey) {
      const r = list.querySelector(`.media-row[data-id="${CSS.escape(focusKey[0] || '')}"]`) || list.querySelector('.media-row');
      const ctl = r?.querySelector(`[data-ctl="${focusKey[1]}"]`) || r?.querySelector('.media-go');
      (ctl || panel).focus();
    }
  }

  function build() {
    panel = Object.assign(document.createElement('div'), { id: 'media-panel', className: 'media-panel', hidden: true });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', tr('media.label', 'Playing in your tabs'));
    panel.tabIndex = -1;
    const head = Object.assign(document.createElement('div'), { className: 'media-head', textContent: tr('media.label', 'Playing in your tabs') });
    head.id = 'media-panel-head';
    list = Object.assign(document.createElement('ul'), { className: 'media-list' });
    list.setAttribute('aria-labelledby', head.id);
    panel.append(head, list);
    document.body.append(panel);
    panel.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', (e) => { if (isOpen() && !panel.contains(e.target) && !e.target.closest('#media-btn')) close(); }, true);
    window.addEventListener('blur', () => { if (isOpen()) close(); });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); button.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...list.querySelectorAll('.media-row')];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement?.closest('.media-row'));
    const next = rows[(at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length] || rows[0];
    const ctl = document.activeElement?.dataset.ctl;
    (next.querySelector(`[data-ctl="${ctl}"]`) || next.querySelector('.media-go')).focus();
  }

  function place() {
    const r = button.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
    panel.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }

  async function open() {
    if (!panel) build();
    if (isOpen()) return;
    items = await window.browser.mediaList().catch(() => items);
    panel.hidden = false;
    place();
    button.setAttribute('aria-expanded', 'true');
    if (typeof freezePage === 'function') freezePage(); // app.js: the page shows as a still image so the pop-up can sit over it
    focusKey = null;
    render();
    (list.querySelector('[data-ctl="playpause"]') || list.querySelector('.media-go') || panel).focus();
  }

  function close() {
    if (!isOpen()) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (typeof thawPage === 'function') thawPage();
  }

  window.browser.onMediaList((next) => { items = Array.isArray(next) ? next : []; drawButton(); render(); });
  window.browser.mediaList().then((next) => { items = Array.isArray(next) ? next : []; drawButton(); }).catch(() => {});
  button.addEventListener('click', () => (isOpen() ? close() : open()));
  return { open, close, isOpen, items: () => items };
})();
