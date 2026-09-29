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
  const MAX_WIDGETS = 12; // features/widgets.js
  const REMOVE_UNDO_MS = 25000; // how long the browser keeps a removed widget (features/widget-trash.js is 30 s)

  const CSS = `
    /* [widgets] Edit layout (newtab-edit.js). Sections that became cards look like the sections they were. */
    body .w-card.sys.sys { background: none; box-shadow: none; padding: 0; border-radius: 12px; -webkit-backdrop-filter: none; backdrop-filter: none; }
    .w-card.sys header, .w-card.sys form { margin: 0; animation: none; }
    .w-card.sys .w-body { overflow-x: hidden; overflow-y: auto; padding: 2px; margin: -2px; }
    .w-card.sys .w-head h2 { font-size: 13px; }
    .w-card.sys-bare .w-head { position: absolute; top: 0; left: 0; margin: 0; min-height: 0; z-index: 3; }
    .w-card.sys-bare .w-head h2 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .w-card.sys-header .clock { font-size: clamp(36px, 20cqw, 88px); }
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
    undoBtn.disabled = history.size === 0;
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
  function undo() {
    let entry = history.pop();
    while (entry && entry.kind === 'remove' && Date.now() - entry.at > REMOVE_UNDO_MS) entry = history.pop(); // the browser let go of it
    hideToast();
    if (!entry) { say(T('newtab.edit.nothing')); update(); return false; }
    let ok = true;
    if (entry.kind === 'remove') {
      window.widgetAct(entry.id, 'restore');
      say(T('newtab.edit.restored', { title: entry.title }));
    } else {
      ok = Boolean(grid()?.undoLayout(entry));
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
    history.push(entry);
    window.newtabSystem?.untouch(WS.IDS);
    window.widgetAct('wreset', 'reset');
    say(T('newtab.edit.resetDone'));
    update();
  });
  toggle.addEventListener('click', () => grid()?.setEditing(!grid().isEditing()));

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
    },
    undo,
  };

  document.addEventListener('w-mode', (e) => {
    editing = Boolean(e.detail?.editing);
    stacked = Boolean(e.detail?.stacked);
    update();
    placeTile();
  });
  grid()?.onLayout(() => { update(); placeTile(); });
  update();
})();
