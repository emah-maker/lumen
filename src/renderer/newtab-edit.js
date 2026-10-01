// [widgets] Edit layout on the new-tab page: the toggle you can see (bottom right), and while it is on
// a toolbar (Add widget, Undo, Reset layout, Done), an "Add widget" tile on the grid and its picker, snap
// guides while a card is dragged, and an Undo toast after a removal. The moving itself (pointer, arrow
// keys, resize handles, aria-live announcements) is newtab-widgets-grid.js; the plain logic (undo stack,
// guides, picker entries, the words) is features/widget-edit.js, which the tests cover.
// Everything is drawn with textContent and DOM calls; nothing comes from the network. The words come
// from window.lumenI18n when the page was given a table, else English (locales/en.json newtab.edit.*).
(() => {
  const WE = window.WidgetEdit;
  const WS = window.WidgetSystem;
  const WL = window.WidgetLayout;
  const grid = () => window.widgetGrid;
  const strings = window.lumenI18n?.strings;
  const T = (key, vars) => WE.text(key, vars, strings);
  const say = (message) => window.widgetAnnounce?.(message);
  const MAX_WIDGETS = 24; // features/widgets.js
  const REMOVE_UNDO_MS = 25000; // how long the browser keeps a removed widget (features/widget-trash.js is 30 s)

  const CSS = `
    /* [widgets] Edit layout (newtab-edit.js). Sections that became cards look like the sections they were. */
    body .w-card.sys.sys { background: none; box-shadow: none; padding: 0; border-radius: 12px; -webkit-backdrop-filter: none; backdrop-filter: none; }
    .w-card.sys header, .w-card.sys form { margin: 0; animation: none; }
    .w-card.sys .w-body { overflow-x: hidden; overflow-y: auto; padding: 2px; margin: -2px; }
    .w-card.sys .w-head h2 { font-size: 13px; }
    .w-card.sys-bare .w-head { position: absolute; top: 0; left: 0; margin: 0; min-height: 0; z-index: 3; }
    .w-card.sys-bare .w-head h2 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    @container card (max-width: 340px) { .sys .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } .sys .frequent { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @container card (max-width: 220px) { .sys .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .sys .frequent { grid-template-columns: minmax(0, 1fr); } }
    body.w-editing .w-card.sys-bare .w-grip { opacity: 1; }

    #w-extras { position: absolute; top: 0; left: 0; width: 100%; height: 0; z-index: 1; pointer-events: none; }
    .w-guide { position: absolute; left: 0; top: 0; background: var(--accent); opacity: 0.6; pointer-events: none; border-radius: 1px; }
    .w-add-tile { position: absolute; left: 0; top: 0; box-sizing: border-box; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 10px;
      appearance: none; margin: 0; border: 2px dashed color-mix(in srgb, var(--accent) 60%, transparent); border-radius: 16px; background: color-mix(in srgb, var(--accent) 6%, transparent);
      color: var(--text); font: 600 13px/1.3 system-ui, sans-serif; text-align: center; cursor: default; outline: none; pointer-events: auto; }
    .w-add-tile[hidden] { display: none !important; }
    body.w-editing .w-add-tile { display: flex; }
    body.w-dragging .w-add-tile { opacity: 0; pointer-events: none; }
    .w-add-tile:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .w-add-tile:focus-visible { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
    .w-add-tile .w-plus { font-size: 24px; line-height: 1; font-weight: 300; color: var(--accent); }
    .w-add-tile small { max-width: 30ch; color: var(--muted); font: 400 12px/1.4 system-ui, sans-serif; }

    .w-dock { position: fixed; right: 16px; bottom: 16px; z-index: 20; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: min(560px, calc(100vw - 32px)); text-shadow: none; }
    .w-dock[hidden] { display: none; }
    .w-dock-row { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; }
    .w-dock.editing .w-dock-row { padding: 6px; border-radius: 16px; background: var(--bg); box-shadow: 0 0 0 1px var(--border), 0 8px 28px var(--shadow); -webkit-backdrop-filter: blur(24px) saturate(1.5); backdrop-filter: blur(24px) saturate(1.5); }
    .w-dock-hint, .w-firstrun { margin: 0; padding: 6px 12px; border-radius: 12px; background: var(--bg); color: var(--muted); font-size: 12px; line-height: 1.4; box-shadow: 0 0 0 1px var(--border), 0 6px 20px var(--shadow); -webkit-backdrop-filter: blur(24px) saturate(1.5); backdrop-filter: blur(24px) saturate(1.5); }
    .w-dock-hint[hidden], .w-firstrun[hidden] { display: none; }
    .w-firstrun { display: flex; align-items: center; gap: 8px; }
    .w-tb { appearance: none; position: static; display: inline-flex; align-items: center; gap: 6px; margin: 0; padding: 6px 13px; border: 0; border-radius: 999px; background: var(--card); color: var(--text);
      font: 500 12.5px/18px system-ui, sans-serif; cursor: default; outline: none; box-shadow: 0 0 0 1px var(--border); transition: background-color 150ms ease-out; }
    .w-dock.editing .w-tb { background: var(--field); box-shadow: none; }
    .w-tb[hidden] { display: none; }
    .w-tb:hover:not(:disabled) { background: var(--hover); }
    .w-tb:disabled { opacity: 0.45; }
    .w-tb:focus-visible { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
    .w-tb svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .w-tb.w-tb-add { color: var(--accent); }
    body.on-media .w-tb.w-tb-add { color: var(--text); }
    body.calm .w-tb, body.calm .w-add-tile { transition: none; }
    @media (prefers-reduced-motion: reduce) { .w-tb, .w-add-tile { transition: none; } }
    .w-tb.w-edit-btn[aria-pressed="true"] { background: var(--accent); color: var(--on-accent); }
    .w-x { appearance: none; margin: 0; padding: 0 4px; border: 0; background: transparent; color: var(--muted); font: 500 16px/1 system-ui, sans-serif; cursor: default; outline: none; border-radius: 6px; }
    .w-x:focus-visible { box-shadow: 0 0 0 2px var(--accent); }

    .w-picker { position: fixed; right: 16px; bottom: 74px; z-index: 30; width: min(320px, calc(100vw - 32px)); max-height: min(70vh, 480px); overflow-y: auto; box-sizing: border-box; padding: 6px; border-radius: 16px;
      background: var(--bg); color: var(--text); box-shadow: 0 0 0 1px var(--border), 0 14px 40px var(--shadow); -webkit-backdrop-filter: blur(24px) saturate(1.5); backdrop-filter: blur(24px) saturate(1.5); text-shadow: none; }
    .w-picker h2 { margin: 0; padding: 8px 10px 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
    .w-pick { appearance: none; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; margin: 0; padding: 8px 10px; border: 0; border-radius: 10px; background: transparent; color: var(--text); text-align: left; cursor: default; outline: none; }
    .w-pick:hover { background: var(--hover); }
    .w-pick:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
    .w-pick b { font: 600 13px/1.3 system-ui, sans-serif; }
    .w-pick span { color: var(--muted); font: 400 11.5px/1.35 system-ui, sans-serif; }
    .w-picker p { margin: 0; padding: 8px 10px; color: var(--muted); font-size: 12px; }

    .w-toast { position: fixed; left: 50%; bottom: 76px; z-index: 25; display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px); padding: 6px 8px 6px 14px; border-radius: 12px; transform: translateX(-50%);
      background: var(--text); color: var(--bg); font-size: 12.5px; box-shadow: 0 8px 24px var(--shadow); text-shadow: none; }
    body.on-media .w-toast { background: rgba(255, 255, 255, 0.92); color: #1d1d1f; }
    .w-toast .w-tb { background: rgba(128, 128, 128, 0.28); color: inherit; box-shadow: none; padding: 3px 12px; }
    @keyframes w-pop { from { opacity: 0; translate: 0 6px; } }
    @media (prefers-reduced-motion: no-preference) { body:not(.calm) .w-picker, body:not(.calm) .w-toast, body:not(.calm) .w-dock-hint { animation: w-pop 160ms ease-out; } }
    body.w-stacked .w-add-tile, body.w-stacked .w-guide { display: none; }

    /* the clock's corner and the search bar's edges (resize handles while editing) */
    #w-sizers { position: absolute; top: 0; left: 0; width: 100%; height: 0; z-index: 2; pointer-events: none; }
    #w-sizers[hidden] { display: none; }
    .w-sz-frame.w-sz-smaller::after { content: attr(data-tag); position: absolute; left: 50%; top: calc(100% + 8px); transform: translateX(-50%); white-space: nowrap; font-size: 11px; line-height: 1; padding: 5px 9px; border-radius: 999px; color: var(--text); background: color-mix(in srgb, var(--bg, #fff) 88%, transparent); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 0 0 0.5px rgba(0,0,0,.08); pointer-events: none; }
    .w-sz-frame.w-sz-clock.w-sz-smaller::after { top: auto; bottom: calc(100% + 8px); }
    .w-sz-frame.w-sz-clock.w-sz-tag-side::after { bottom: auto; top: 50%; left: calc(100% + 28px); transform: translateY(-50%); } /* the clock's above it: below are the date and greeting */
    .w-sz-frame { position: absolute; left: 0; top: 0; box-sizing: border-box; border: 1.5px dashed color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 12px; pointer-events: none; }
    .w-sz-grip { position: absolute; left: 0; top: 0; box-sizing: border-box; background: var(--accent); box-shadow: 0 0 0 2px var(--bg); pointer-events: auto; touch-action: none; outline: none; }
    .w-sz-grip::after { content: ""; position: absolute; inset: -10px; }
    /* A clock or search-bar size that would run into a card: the grip nudges once and keeps a tint while it is held at
       the limit (cleared by the next size that fits); the cards in the way are outlined for a moment. */
    .w-sz-grip.w-sz-blocked { animation: w-sz-nudge 280ms ease-out; background: color-mix(in srgb, var(--accent) 45%, #d70015); }
    @keyframes w-sz-nudge { 30% { translate: 3px 0; } 60% { translate: -2px 0; } }
    body .w-card.w-blocking, body.w-editing .w-card.w-blocking { outline: 2px dashed color-mix(in srgb, #d70015 70%, transparent) !important; outline-offset: 4px !important; }
    .w-sz-note.above { transform: translate(-50%, -100%); }
    .w-sz-note { position: absolute; z-index: 3; transform: translateX(-50%); max-width: 260px; padding: 6px 10px; border-radius: 10px; background: color-mix(in srgb, var(--bg, #fff) 90%, transparent); -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4); color: var(--text);
      box-shadow: 0 0 0 0.5px var(--border), 0 8px 24px -8px rgba(0, 0, 0, 0.35); font: 500 12px/1.35 system-ui, sans-serif; text-align: center; opacity: 0; pointer-events: none; transition: opacity 160ms ease-out; }
    .w-sz-note.show { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { .w-sz-grip.w-sz-blocked { animation: none; } }
    body.calm .w-sz-grip.w-sz-blocked { animation: none; }
    .w-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .w-sz-grip:focus-visible { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
    .w-sz-corner { width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 999px; cursor: nwse-resize; }
    .w-sz-edge { width: 8px; height: 36px; margin: -18px 0 0 -4px; border-radius: 999px; cursor: ew-resize; }
    .w-sz-hidden { display: none; }
  `;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  // Small line icons, built with DOM calls (no markup strings).
  const NS = 'http://www.w3.org/2000/svg';
  function icon(...paths) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 12 12');
    s.setAttribute('aria-hidden', 'true');
    for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
    return s;
  }
  function tb(cls, label, svg, title) {
    const b = el('button', `w-tb ${cls}`);
    b.type = 'button';
    if (svg) b.append(svg);
    b.append(el('span', null, label));
    if (title) b.title = title;
    return b;
  }
  const setLabel = (b, label) => { b.querySelector('span').textContent = label; };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window: it just shows again */ } },
  };
  const realCount = () => document.querySelectorAll('#widgets .w-card:not(.sys)').length;

  let editing = false;
  let stacked = false;
  const history = WE.createHistory(20);

  // ---- the dock: toggle, and the toolbar while editing ----
  const dock = el('div', 'w-dock w-ui');
  dock.setAttribute('role', 'toolbar');
  dock.setAttribute('aria-label', T('newtab.edit.bar'));
  dock.hidden = true;
  const hint = el('p', 'w-dock-hint', T('newtab.edit.hint'));
  hint.id = 'w-dock-hint';
  hint.hidden = true;
  const first = el('div', 'w-firstrun');
  first.hidden = true;
  const firstText = el('span', null, T('newtab.edit.firstRun'));
  const firstX = el('button', 'w-x', '×');
  firstX.type = 'button';
  firstX.setAttribute('aria-label', T('newtab.edit.dismiss'));
  firstX.addEventListener('click', () => { store.set('lumen.home.editHint', '1'); update(); });
  first.append(firstText, firstX);
  const row = el('div', 'w-dock-row');
  const addBtn = tb('w-tb-add', T('newtab.edit.add'), icon('M6 2v8M2 6h8'), T('newtab.edit.add.title'));
  addBtn.setAttribute('aria-haspopup', 'dialog');
  addBtn.setAttribute('aria-expanded', 'false');
  const undoBtn = tb('w-tb-undo', T('newtab.edit.undo'), icon('M3.5 4.5H8a2.5 2.5 0 0 1 0 5H4.5M5.5 2.5l-2 2 2 2'), T('newtab.edit.undo.title'));
  const resetBtn = tb('w-tb-reset', T('newtab.edit.reset'), null, T('newtab.edit.reset.title'));
  const toggle = tb('w-edit-btn', T('newtab.edit.toggle'), icon('M8.5 2.2 9.8 3.5 4.3 9H3V7.7z'), T('newtab.edit.toggle.title'));
  toggle.setAttribute('aria-pressed', 'false');
  toggle.setAttribute('aria-describedby', 'w-dock-hint');
  row.append(addBtn, undoBtn, resetBtn, toggle);
  dock.append(hint, first, row);
  document.body.append(dock);

  const extras = el('div');
  extras.id = 'w-extras';
  const tile = el('button', 'w-add-tile w-ui');
  tile.type = 'button';
  tile.hidden = true;
  tile.append(el('span', 'w-plus', '+'), el('span', null, T('newtab.edit.tile')), el('small', null, ''));
  tile.setAttribute('aria-haspopup', 'dialog');
  extras.append(tile);
  document.body.append(extras);

  function update() {
    const real = realCount();
    dock.classList.toggle('editing', editing);
    toggle.hidden = stacked;
    setLabel(toggle, T(editing ? 'newtab.edit.done' : 'newtab.edit.toggle'));
    toggle.setAttribute('aria-pressed', String(editing));
    toggle.title = T('newtab.edit.toggle.title');
    addBtn.hidden = !(editing || real === 0) || stacked;
    undoBtn.hidden = !editing;
    undoBtn.disabled = !history.some((e) => !staleEntry(e)); // only steps that would still do something
    resetBtn.hidden = !editing;
    hint.hidden = !editing;
    first.hidden = editing || real > 0 || stacked || store.get('lumen.home.editHint') === '1';
    dock.hidden = stacked; // one column: no editing, and nothing to add to
    tile.querySelector('small').textContent = real === 0 ? T('newtab.edit.tile.empty') : '';
  }

  // ---- the Add widget tile: the first free spot on the grid ----
  function placeTile() {
    const g = grid()?.geometry();
    if (!g || !g.m || g.stacked || !editing) { tile.hidden = true; return; }
    const size = realCount() === 0 ? { w: 4, h: 2 } : { w: 3, h: 2 };
    const spot = WL.firstFit(g.view, size, g.m.cols, g.o?.obstacle || null);
    const px = WL.cellToPx({ ...spot, ...size }, g.m);
    tile.hidden = false;
    tile.style.transform = `translate3d(${px.left}px, ${px.top}px, 0)`;
    tile.style.width = `${px.width}px`;
    tile.style.height = `${px.height}px`;
  }

  // ---- the picker ----
  let picker = null;
  let opener = null;
  function closePicker(refocus) {
    if (!picker) return;
    picker.remove();
    picker = null;
    addBtn.setAttribute('aria-expanded', 'false');
    tile.setAttribute('aria-expanded', 'false');
    if (refocus && opener?.isConnected) opener.focus();
    opener = null;
  }
  function openPicker(from) {
    if (picker) { closePicker(true); return; }
    opener = from;
    const sys = window.newtabSystem;
    const hidden = (sys ? sys.hidden() : []).map((id) => ({ id, label: WS.labelOf(id) }));
    const types = window.widgetTypes?.() || []; // one entry for every kind newtab-widgets.js can draw
    const entries = WE.pickerEntries({ types: realCount() >= MAX_WIDGETS ? [] : types, hidden, table: strings });
    picker = el('div', 'w-picker w-ui');
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', T('newtab.edit.picker'));
    picker.append(el('h2', null, T('newtab.edit.picker')));
    if (!entries.length) picker.append(el('p', null, T('newtab.edit.picker.none')));
    for (const entry of entries) {
      const b = el('button', 'w-pick');
      b.type = 'button';
      b.append(el('b', null, entry.label), el('span', null, entry.hint));
      b.addEventListener('click', () => {
        closePicker(false);
        if (entry.kind === 'section') {
          window.widgetAct(entry.id, 'restore');
          say(T('newtab.edit.restored', { title: entry.label }));
        } else if (window.widgetSetup?.canAdd(entry.type)) {
          window.widgetSetup.open({ type: entry.type }); // set up right here on the page (renderer/newtab-setup.js)
        } else {
          window.widgetAct('wcreate', 'create', { type: entry.type });
          say(T('newtab.edit.settingUp', { title: entry.label }));
        }
      });
      picker.append(b);
    }
    picker.addEventListener('keydown', (e) => {
      const list = [...picker.querySelectorAll('.w-pick')];
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(true); return; }
      const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
      if (go === undefined || !list.length) return;
      e.preventDefault();
      list[(go + list.length) % list.length].focus();
    });
    document.body.append(picker);
    addBtn.setAttribute('aria-expanded', 'true');
    tile.setAttribute('aria-expanded', 'true');
    picker.querySelector('.w-pick')?.focus();
  }
  document.addEventListener('pointerdown', (e) => {
    if (picker && !e.target.closest?.('.w-picker, .w-add-tile, .w-tb-add')) closePicker(false);
  }, true);
  addBtn.addEventListener('click', () => openPicker(addBtn));
  tile.addEventListener('click', () => openPicker(tile));

  // ---- undo ----
  let toast = null;
  let toastTimer = 0;
  function hideToast() { clearTimeout(toastTimer); toast?.remove(); toast = null; }
  function showToast(message) {
    hideToast();
    toast = el('div', 'w-toast w-ui');
    toast.append(el('span', null, message));
    const b = tb('w-toast-undo', T('newtab.edit.undo'), null);
    b.addEventListener('click', () => undo());
    toast.append(b);
    document.body.append(toast);
    toastTimer = setTimeout(hideToast, 8000);
  }
  // Passed over by Undo: a removal the browser let go of, and a size changed again since (in Settings, another tab).
  const staleEntry = (e) => ((e.kind === 'remove' || e.kind === 'config') && Date.now() - e.at > REMOVE_UNDO_MS) || (e.kind === 'look' && SZ()?.get()[e.key] !== e.after);
  function undo() {
    let entry = history.pop();
    // Passed over: a removal the browser let go of, and a size changed again since (in Settings, another tab).
    while (entry && staleEntry(entry)) entry = history.pop();
    hideToast();
    if (!entry) { say(T('newtab.edit.nothing')); update(); return false; }
    let ok = true;
    if (entry.kind === 'look') {
      ok = restoreLook({ [entry.key]: entry.before });
      say(T('newtab.edit.undone', { what: T('newtab.edit.what.layout', { title: entry.title }) }));
    } else if (entry.kind === 'remove') {
      window.widgetAct(entry.id, 'restore');
      say(T('newtab.edit.restored', { title: entry.title }));
    } else if (entry.kind === 'config') { // a form save on a card: the browser still holds the settings it had (do=restore on a card that is there)
      window.widgetAct(entry.id, 'restore');
      say(T('newtab.edit.undone', { what: entry.title }));
    } else {
      ok = Boolean(grid()?.undoLayout(entry));
      if (entry.look) ok = restoreLook(entry.look) || ok; // Reset layout also put the clock and the search bar back
      say(ok ? T('newtab.edit.undone', { what: entry.title ? T('newtab.edit.what.layout', { title: entry.title }) : T('newtab.edit.reset') }) : T('newtab.edit.nothing'));
    }
    update();
    return ok;
  }
  undoBtn.addEventListener('click', undo);
  resetBtn.addEventListener('click', () => {
    const entry = grid()?.snapshot(null);
    if (!entry) return;
    entry.id = entry.before[0]?.id || null;
    const now = SZ()?.get();
    if (now && (now.clock !== WS.CLOCK_DEFAULT || now.search !== WS.SEARCH_DEFAULT)) entry.look = { clock: now.clock, search: now.search };
    history.push(entry);
    if (SZ()) { SZ().take('clock', WS.CLOCK_DEFAULT); SZ().take('search', WS.SEARCH_DEFAULT); } // the browser writes them too (features/widgets.js resetLayout)
    placeSoon();
    window.newtabSystem?.untouch(WS.IDS);
    window.widgetAct('wreset', 'reset');
    say(T('newtab.edit.resetDone'));
    update();
  });
  toggle.addEventListener('click', () => grid()?.setEditing(!grid().isEditing()));

  // ---- the clock and the search bar: resize handles (the centre column stays centred) ----
  // The clock grows in steps (s m l xl): drag the corner or focus it and press Shift+arrows. The search bar changes width
  // symmetrically around the centre: drag either edge (8 px, or onto a grid line when one is close) or Shift+Left/Right.
  // A drag previews live (newtabSize.preview); on drop the value is saved (do=look) and put on the Undo stack.
  const SZ = () => window.newtabSize;
  const sizers = el('div');
  sizers.id = 'w-sizers';
  sizers.hidden = true;
  const frameClock = el('i', 'w-sz-frame w-sz-clock');
  const frameSearch = el('i', 'w-sz-frame');
  const gripClock = el('div', 'w-sz-grip w-sz-corner w-ui');
  const gripL = el('div', 'w-sz-grip w-sz-edge w-ui');
  const gripR = el('div', 'w-sz-grip w-sz-edge w-ui');
  for (const f of [frameClock, frameSearch]) f.setAttribute('aria-hidden', 'true');
  // How to use them, for screen readers too (a title alone isn't reliably read out).
  const sizeHint = el('span', 'w-sr');
  sizeHint.id = 'w-sz-hint';
  sizeHint.textContent = T('newtab.edit.sizeHint');
  for (const [g, label] of [[gripClock, 'newtab.edit.clock'], [gripL, 'newtab.edit.search'], [gripR, 'newtab.edit.search']]) {
    g.tabIndex = 0;
    g.setAttribute('role', 'slider');
    g.setAttribute('aria-label', T(label));
    g.setAttribute('aria-describedby', 'w-sz-hint');
    g.title = T(`${label}.hint`);
  }
  gripR.tabIndex = -1; // one search-width slider in the tab order (both edges set the same value)
  gripClock.setAttribute('aria-valuemin', '0');
  gripClock.setAttribute('aria-valuemax', String(WS.CLOCK_STEPS.length - 1));
  for (const g of [gripL, gripR]) { g.setAttribute('aria-valuemin', String(WS.SEARCH_MIN)); g.setAttribute('aria-valuemax', String(WS.SEARCH_MAX)); }
  sizers.append(frameClock, frameSearch, gripClock, gripL, gripR, sizeHint);
  document.body.append(sizers);

  const clockName = (k) => T(`newtab.edit.clock.${k}`);
  const clockNode = () => document.getElementById('clock');
  const searchNode = () => document.querySelector('main form');
  const docRect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height }; };
  const put = (node, x, y) => { node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`; };
  function placeSizers() {
    const on = editing && !stacked && SZ();
    sizers.hidden = !on;
    if (!on) return;
    const c = clockNode();
    const clockOn = Boolean(c) && !c.hidden && c.getClientRects().length > 0;
    for (const n of [frameClock, gripClock]) n.classList.toggle('w-sz-hidden', !clockOn);
    if (clockOn) {
      // the clock is a block as wide as the column; frame just its text
      const r = docRect(c);
      const range = document.createRange();
      range.selectNodeContents(c);
      const t = range.getBoundingClientRect();
      const w = Math.max(t.width, 40);
      const left = t.left + scrollX;
      frameClock.style.width = `${w + 8}px`;
      frameClock.style.height = `${r.height + 4}px`;
      put(frameClock, left - 4, r.top - 2);
      put(gripClock, left + w + 4, r.top - 2); // its top corner: the clock grows upward, towards the pointer
      const now = SZ().drawnClock?.() || SZ().get().clock; // what is drawn (a size that doesn't fit here is drawn smaller)
      const savedClock = SZ().get().clock;
      const tagClock = now !== savedClock && !SZ().held() ? T('newtab.edit.drawnSmaller', { size: clockName(savedClock) }) : '';
      frameClock.classList.toggle('w-sz-smaller', Boolean(tagClock));
      frameClock.classList.toggle('w-sz-tag-side', Boolean(tagClock) && r.top - 34 < 8); // no room above: beside it
      frameClock.dataset.tag = tagClock;
      gripClock.setAttribute('aria-valuenow', String(WS.CLOCK_STEPS.indexOf(now)));
      gripClock.setAttribute('aria-valuetext', tagClock ? `${clockName(now)}. ${tagClock}` : clockName(now));
    }
    const f = searchNode();
    if (f) {
      const r = docRect(f);
      frameSearch.style.width = `${r.width + 8}px`;
      frameSearch.style.height = `${r.height + 8}px`;
      put(frameSearch, r.left - 4, r.top - 4);
      put(gripL, r.left - 4, r.top + r.height / 2);
      put(gripR, r.left + r.width + 4, r.top + r.height / 2);
      const drawn = Math.round(r.width); // Automatic is announced as the width it is drawn at
      const saved = SZ().get().search;
      // Narrower than saved: the cards leave no room here, or the window is too narrow (the bar is at most 88% of it).
      const smaller = !SZ().held() && (SZ().drawnSearch() !== saved || (saved !== WS.SEARCH_DEFAULT && r.width < saved - 1));
      frameSearch.classList.toggle('w-sz-smaller', smaller);
      const tag = smaller ? T('newtab.edit.drawnNarrower', { size: saved === WS.SEARCH_DEFAULT ? T('newtab.edit.automatic') : `${saved} px` }) : '';
      frameSearch.dataset.tag = tag;
      for (const g of [gripL, gripR]) {
        g.setAttribute('aria-valuemin', String(Math.min(WS.SEARCH_MIN, drawn))); // an Automatic width can be a little under the minimum
        g.setAttribute('aria-valuemax', String(Math.max(drawn, Math.min(WS.SEARCH_MAX, Math.floor(window.innerWidth * 0.88)))));
        g.setAttribute('aria-valuenow', String(drawn));
        g.setAttribute('aria-valuetext', tag ? `${T('newtab.edit.search.sized', { width: drawn })}. ${tag}` : T('newtab.edit.search.sized', { width: drawn }));
      }
    }
  }
  let sizerFrame = 0;
  const placeSoon = () => { if (!sizerFrame) sizerFrame = requestAnimationFrame(() => { sizerFrame = 0; placeSizers(); }); };
  addEventListener('resize', placeSoon);
  if (typeof ResizeObserver === 'function') new ResizeObserver(placeSoon).observe(document.querySelector('main'));

  // Growing the clock or the search bar never moves a card: a size that would run into one isn't taken. It stops at the
  // largest size that fits (the grid-line width where the column meets the cards, when that is the edge), the grip
  // nudges once (and keeps a tint while held at the limit), the cards in the way are outlined, and it says why.
  // Shrinking always works. grid.centreFits measures the live preview against the cards' saved places.
  const fits = () => grid()?.centreFits?.() ?? true; // (measured against the smallest column: SZ().floor())
  const clockAt = (k) => WS.CLOCK_STEPS.indexOf(k);
  const bigger = (key, a, b) => (key === 'clock' ? clockAt(a) > clockAt(b) : a > b);
  const previewLook = (key, value) => { if (key === 'clock') SZ().preview(value, null); else SZ().preview(null, value); };
  // The search width as drawn: Automatic (stored as 640) fills the column's columns, so compare and step from that.
  // The width as drawn: measured (Automatic fills the column's columns, and any width is capped at 88% of the window).
  const drawnSearch = () => { const s = SZ().drawnSearch(); const w = Math.floor(searchNode()?.getBoundingClientRect().width || 0); return w && (s === WS.SEARCH_DEFAULT || w < s - 1) ? w : s; };
  const drawnOf = (key) => (key === 'clock' ? SZ().drawnClock() : drawnSearch());
  // The widths where the column's edges sit on grid lines (each even column span), in px.
  function gridLineWidths() {
    const m = grid()?.metrics?.();
    if (!m || !Number.isFinite(m.cw)) return [];
    const out = [];
    for (let s = 4; s <= 10; s += 2) out.push(Math.floor(s * m.cw + (s - 1) * (window.WidgetLayout?.GAP || 24)));
    return out;
  }
  // The largest size from `from` (which fits) towards `want` (which doesn't) that still fits, left previewed.
  function largestFit(key, from, want) {
    if (key === 'clock') {
      for (let i = clockAt(want) - 1; i > clockAt(from); i--) { previewLook(key, WS.CLOCK_STEPS[i]); if (fits()) return WS.CLOCK_STEPS[i]; }
      previewLook(key, from);
      return from;
    }
    let lo = from, hi = want;
    while (hi - lo > WS.SEARCH_STEP) {
      let mid = Math.round((lo + hi) / 2 / WS.SEARCH_STEP) * WS.SEARCH_STEP;
      if (mid === WS.SEARCH_DEFAULT) mid += WS.SEARCH_STEP; // 640 means Automatic: never a width tried or saved
      if (mid <= lo || mid >= hi) break;
      previewLook(key, mid);
      if (fits()) lo = mid; else hi = mid;
    }
    // A grid-line width between the last fit and the first miss: the column then ends exactly where the cards begin.
    for (const w of gridLineWidths().filter((x) => x > lo && x < hi && Math.abs(x - WS.SEARCH_DEFAULT) > 0.5).sort((a, b) => b - a)) {
      previewLook(key, w);
      if (fits()) { lo = w; break; }
    }
    previewLook(key, lo);
    return lo;
  }
  let blockedSaid = 0;
  // A small note beside the grip, for everyone (the live region is for screen readers).
  const note = el('div', 'w-sz-note');
  note.setAttribute('aria-hidden', 'true');
  sizers.append(note);
  let noteTimer = 0;
  function blocked(grip, key, value) {
    grip?.classList.add('w-sz-blocked');
    clearTimeout(grip?.blockTimer);
    if (grip && !document.body.classList.contains('w-dragging')) grip.blockTimer = setTimeout(() => unblock(grip), 1200); // a key press's tint fades
    const now = key === 'clock' ? T('newtab.edit.clock.sized', { size: clockName(value) }) : T('newtab.edit.search.sized', { width: value });
    const text = `${T('newtab.edit.noRoom')} ${now}.`;
    if (Date.now() - blockedSaid > 1500) { blockedSaid = Date.now(); say(text); } // one message: why it stopped, and where
    if (grip) {
      const r = grip.getBoundingClientRect();
      note.textContent = T('newtab.edit.noRoom');
      note.style.left = `${Math.round(r.left + r.width / 2 + scrollX)}px`;
      note.style.top = grip === gripClock ? `${Math.round(r.top - 10 + scrollY)}px` : `${Math.round(r.bottom + 10 + scrollY)}px`;
      note.classList.toggle('above', grip === gripClock);
      if (grip === gripClock && r.top - 10 - note.offsetHeight < 8) { // no room above: beside the grip
        note.classList.remove('above');
        note.style.left = `${Math.round(r.right + 12 + note.offsetWidth / 2 + scrollX)}px`;
        note.style.top = `${Math.round(r.top + scrollY)}px`;
      }
      note.classList.add('show');
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => note.classList.remove('show'), 2600);
    }
  }
  const unblock = (grip) => grip?.classList.remove('w-sz-blocked');
  // A wanted size -> the size it gets: itself, or (growing into a card) the largest that fits. Previewed.
  function fitted(key, from, want, grip, quiet = false) {
    previewLook(key, want);
    if (!bigger(key, want, from) || fits()) { unblock(grip); return want; }
    if (!quiet) grid()?.flashBlockers?.(); // the cards this size ran into (measured by the probe that just failed)
    const got = largestFit(key, from, want);
    if (!quiet) blocked(grip, key, got);
    return got;
  }
  // Set a clock step or search width now, save it (do=look) and, when `record`, put it on the Undo stack.
  // from: the size to compare with (the drawn width for Automatic); the stored value is what Undo puts back.
  // from: the size drawn before (a saved size may be drawn smaller here); Undo/Reset (record false) restore a saved one.
  function setLook(key, value, { record = true, from, grip = null, reset = false } = {}) {
    const stored = SZ().get()[key];
    const base = from ?? drawnOf(key);
    const auto = key === 'search' && value === WS.SEARCH_DEFAULT; // Automatic: saved as it is, drawn as the cards allow
    if (record && !auto && !reset) { SZ().floor(); value = fitted(key, base, value, grip); }
    const same = (a, b) => a === b || (key === 'search' && !auto && Math.abs(a - b) <= 1);
    if (value === stored || (record && !reset && same(value, base))) {
      SZ().restore(); // nothing changes: drawn as before, and said
      placeSoon();
      if (record && !grip?.classList.contains('w-sz-blocked')) { const now = drawnOf(key); say(key === 'clock' ? T('newtab.edit.clock.sized', { size: clockName(now) }) : T('newtab.edit.search.sized', { width: now })); } // (a blocked one has said why)
      return false;
    }
    SZ().take(key, value); // saved here now, then in the browser
    placeSoon();
    window.widgetAct('wlook', 'look', { k: key, v: String(value) });
    if (record) {
      history.push({ kind: 'look', key, before: stored, after: value, title: T(`newtab.edit.${key}`) });
      update();
    }
    const shown = drawnOf(key); // what is drawn now (a restored size may be drawn smaller here)
    if (!grip?.classList.contains('w-sz-blocked')) say(key === 'clock' ? T('newtab.edit.clock.sized', { size: clockName(shown) }) : T('newtab.edit.search.sized', { width: shown }));
    return true;
  }
  const gridInfo = () => { const m = grid()?.metrics?.() || grid()?.geometry().m; return m && Number.isFinite(m.pitchX) ? { pitch: m.pitchX, pad: m.pad, width: m.width } : null; };

  function dragSizer(grip, e, want) {
    if (e.button !== 0 || !SZ()) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const startDrawn = { clock: SZ().drawnClock(), search: drawnSearch() };
    SZ().floor();
    SZ().hold(true); // the layout holds still meanwhile (no packing), so growing back within the drag always works
    document.body.classList.add('w-dragging');
    grip.setPointerCapture?.(e.pointerId);
    let latest = null;
    let pending = null;
    let frame = 0;
    // One size a frame, however fast the pointer events come (a blocked size measures several).
    const step = () => {
      frame = 0;
      if (!pending) return;
      const ddx = pending.clientX - x0;
      const ddy = pending.clientY - y0;
      if (!latest && Math.hypot(ddx, ddy) < 3) { pending = null; return; } // a click's jitter is not a resize
      const next = want(ddx, ddy);
      pending = null;
      const from = latest ? latest.value : startDrawn[next.key];
      if (latest && next.value === latest.wanted) return;
      // Held at the limit and pulling further: still blocked, nothing to measure again.
      if (latest?.limit != null && latest.key === next.key && !bigger(next.key, latest.limit, next.value)) return;
      const got = fitted(next.key, from, next.value, grip);
      latest = { key: next.key, wanted: next.value, value: got, limit: got !== next.value && bigger(next.key, next.value, got) ? next.value : null };
      placeSoon();
    };
    const move = (ev) => { pending = ev; if (!frame) frame = requestAnimationFrame(step); };
    // The window resized mid-drag: the size being dragged is fitted to the new width (against its own smallest column),
    // once a frame, quietly (the window moving isn't the user running into a card).
    let rz = 0;
    const onResize = () => {
      if (!latest || rz) return;
      rz = requestAnimationFrame(() => {
        rz = 0;
        if (done || !latest) return;
        SZ().floor();
        latest.value = fitted(latest.key, Math.min(startDrawn[latest.key], latest.value), latest.wanted, null, true);
        latest.limit = null;
        placeSoon();
      });
    };
    addEventListener('resize', onResize);
    let done = false;
    const finish = () => {
      done = true;
      if (frame) { cancelAnimationFrame(frame); frame = 0; step(); }
      grip.removeEventListener('lostpointercapture', lost);
      removeEventListener('resize', onResize);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      removeEventListener('keydown', escape, true);
      SZ().hold(false);
      document.body.classList.remove('w-dragging');
      unblock(grip);
      grid()?.relayout?.(); // the cards, held still during the drag, settle around the new size
    };
    const cancel = () => { finish(); latest = null; SZ().restore(); placeSoon(); };
    // Escape during the drag puts the size back (and does not also leave Edit layout).
    const escape = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); } };
    const end = (ev) => {
      grip.releasePointerCapture?.(ev.pointerId);
      if (ev.type === 'pointercancel') { cancel(); return; }
      if (done) return;
      finish();
      if (!latest) { SZ().restore(); placeSoon(); return; }
      setLook(latest.key, latest.value, { from: startDrawn[latest.key], grip });
    };
    // The capture taken away (the grip hidden, a window switch): the drag ends as if released, never stuck holding.
    const lost = () => { if (!done) cancel(); }; // no release seen: nothing is saved
    grip.addEventListener('lostpointercapture', lost);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    addEventListener('keydown', escape, true);
  }
  // The clock grows upward (the search box below it stays put), so its handle is at its top corner and follows the pointer up.
  gripClock.addEventListener('pointerdown', (e) => {
    const base = WS.CLOCK_PX[SZ()?.drawnClock()];
    dragSizer(gripClock, e, (dx, dy) => ({ key: 'clock', value: WS.clockStepFromPx(base - dy + dx * 0.4) }));
  });
  for (const [grip, dir] of [[gripL, -1], [gripR, 1]]) {
    grip.addEventListener('pointerdown', (e) => {
      const base = drawnSearch();
      const cap = Math.floor(window.innerWidth * 0.88); // the bar's own limit in this window
      const top = Math.max(WS.SEARCH_MIN, Math.floor(cap / WS.SEARCH_STEP) * WS.SEARCH_STEP); // on a step, as the keys go
      const clampW = (w) => { const v = Math.min(w, top); return v === WS.SEARCH_DEFAULT ? v - WS.SEARCH_STEP : v; }; // 640 means Automatic
      dragSizer(grip, e, (dx) => ({ key: 'search', value: clampW(WS.snapSearchWidth(base + 2 * dir * dx, gridInfo())) }));
    });
  }
  // Double-click a grip, or press Delete or Backspace on it: back to the default (Medium clock, Automatic width).
  gripClock.addEventListener('dblclick', () => setLook('clock', WS.CLOCK_DEFAULT, { grip: gripClock, reset: true }));
  for (const g of [gripL, gripR]) g.addEventListener('dblclick', () => setLook('search', WS.SEARCH_DEFAULT, { grip: g, reset: true }));
  for (const g of [gripClock, gripL, gripR]) {
    g.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      e.preventDefault();
      e.stopPropagation();
      if (g === gripClock) setLook('clock', WS.CLOCK_DEFAULT, { grip: g, reset: true }); else setLook('search', WS.SEARCH_DEFAULT, { grip: g, reset: true });
    });
  }
  // Keyboard: the arrows step (Shift works too, as before), PageUp/PageDown take bigger steps, Home/End go to the ends.
  const plainKey = (e) => !e.ctrlKey && !e.altKey && !e.metaKey;
  gripClock.addEventListener('keydown', (e) => {
    if (!plainKey(e)) return;
    const cur = SZ().drawnClock(); // stepped from what is drawn
    const i = clockAt(cur);
    const to = { ArrowUp: i + 1, ArrowRight: i + 1, PageUp: i + 1, ArrowDown: i - 1, ArrowLeft: i - 1, PageDown: i - 1, Home: 0, End: WS.CLOCK_STEPS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const next = WS.CLOCK_STEPS[Math.max(0, Math.min(WS.CLOCK_STEPS.length - 1, to))];
    if (next === cur) say(T('newtab.edit.clock.sized', { size: clockName(cur) }));
    else setLook('clock', next, { grip: gripClock, from: cur });
  });
  for (const grip of [gripL, gripR]) {
    grip.addEventListener('keydown', (e) => {
      if (!plainKey(e)) return;
      const cur = drawnSearch(); // Automatic is stepped from the width it is drawn at
      const step = 2 * WS.SEARCH_STEP;
      const cap = Math.max(WS.SEARCH_MIN, Math.min(WS.SEARCH_MAX, Math.floor(window.innerWidth * 0.88))); // the widest it is drawn in this window
      let to = { ArrowRight: cur + step, ArrowUp: cur + step, ArrowLeft: cur - step, ArrowDown: cur - step, PageUp: cur + 4 * step, PageDown: cur - 4 * step, Home: WS.SEARCH_MIN, End: cap }[e.key];
      if (to === undefined) return;
      to = Math.min(to, cap);
      e.preventDefault();
      e.stopPropagation();
      let next = WS.cleanSearchWidth(Math.round(to / WS.SEARCH_STEP) * WS.SEARCH_STEP);
      if (next > cap) next = Math.floor(cap / WS.SEARCH_STEP) * WS.SEARCH_STEP; // rounded down, never past what this window draws
      if (next === WS.SEARCH_DEFAULT) next += to > cur && next + WS.SEARCH_STEP <= cap ? WS.SEARCH_STEP : -WS.SEARCH_STEP; // 640 is kept for "Automatic"
      if (next === cur) say(T('newtab.edit.search.sized', { width: cur }));
      else setLook('search', next, { grip, from: cur });
    });
  }
  // Undo / Reset: put a clock size or width back and save it.
  function restoreLook(look) {
    let did = false;
    if (look.clock && look.clock !== SZ().get().clock) did = setLook('clock', look.clock, { record: false }) || did;
    if (look.search && look.search !== SZ().get().search) did = setLook('search', look.search, { record: false }) || did;
    return did;
  }

  // ---- snap guides ----
  const lines = [];
  function drawGuides(list, m) {
    while (lines.length < list.length) { const g = el('i', 'w-guide'); g.setAttribute('aria-hidden', 'true'); extras.append(g); lines.push(g); }
    lines.forEach((g, i) => {
      const d = list[i];
      g.hidden = !d;
      if (!d) return;
      const h = WL.GAP / 2;
      if (d.axis === 'x') {
        g.style.transform = `translate3d(${m.pad + d.at * m.pitchX - h - 1}px, ${m.top + d.from * m.pitchY - h}px, 0)`;
        g.style.width = '2px';
        g.style.height = `${(d.to - d.from) * m.pitchY}px`;
      } else {
        g.style.transform = `translate3d(${m.pad + d.from * m.pitchX - h}px, ${m.top + d.at * m.pitchY - h - 1}px, 0)`;
        g.style.width = `${(d.to - d.from) * m.pitchX}px`;
        g.style.height = '2px';
      }
    });
  }

  window.widgetEditUI = {
    recordLayout(entry) { history.push(entry); update(); },
    removed(info) {
      history.push({ kind: 'remove', ...info });
      showToast(T(info.system ? 'newtab.edit.hidden' : 'newtab.edit.removed', { title: info.title }));
      update();
      setTimeout(update, REMOVE_UNDO_MS + 50); // once the browser lets go of it, Undo stops offering it
    },
    // A card's form was saved: the same Undo toast as a removal; Undo puts its earlier settings back.
    configChanged(info) {
      history.push({ kind: 'config', id: info.id, title: info.title, at: Date.now() });
      showToast(info.message);
      update();
      setTimeout(update, REMOVE_UNDO_MS + 50);
    },
    guides(item, list, obstacle, m) {
      if (!item || !m) return;
      const others = list.filter((i) => i.id !== item.id);
      if (obstacle) others.push(obstacle);
      drawGuides(WE.guides(item, others, 6), m);
    },
    clearGuides() { drawGuides([], grid()?.geometry().m || {}); },
    editingChanged(on) {
      editing = on;
      if (!on) { history.clear(); closePicker(false); hideToast(); }
      update();
      placeTile();
      placeSoon();
    },
    undo,
  };

  document.addEventListener('w-mode', (e) => {
    editing = Boolean(e.detail?.editing);
    stacked = Boolean(e.detail?.stacked);
    update();
    placeTile();
    placeSoon();
  });
  grid()?.onLayout(() => { update(); placeTile(); placeSoon(); });
  update();
})();
