// The quick file picker (Ctrl+Shift+F, or File > Open a recent file): fuzzy search over the files and folders Lumen knows (pinned, recently opened,
// and what is inside pinned folders). Enter opens, Ctrl+Enter shows it in its folder, Alt+Enter attaches it to the sidebar chat, Esc closes.
// It sits in the middle of the window over the page (shown as a still picture while it is open, like tab search), never waits on the disk:
// the search runs in main (features/files.js) and is asked 60 ms after the last key; an answer that arrives after a newer question is
// dropped, and at most 30 rows are drawn. With nothing typed it lists the pinned and recent files. Names are only set with textContent.
// A typed query with no match offers one row, "Search Documents, Desktop and Downloads" (Enter or a click): main's bounded scan of those folders
// (files.js scan, in the index worker), shown as "Searching…" and then under "Found on this computer".
// A Word, Excel or PowerPoint file under the selection shows its first page in a card beside the picker (main draws it, features/office-thumb.js: asked
// 180 ms after the selection settles, kept per file). The rows themselves never wait for it.
// Main side: features/files.js; the keys: main.js openFilesPicker, features/page-first-keys.js.

const filesPicker = (() => {
  const MAX_ROWS = 30;
  const DEBOUNCE_MS = 60;
  const MAC = /Mac/i.test(navigator.platform || '');
  const tr = (key, english) => { const v = window.t?.(key); return v && v !== key ? v : english; };
  let panel = null;
  let input = null;
  let list = null;
  let rows = []; // [{ entry, group, ranges }] in the order drawn (or one { action: 'scan' } row: the offer to search the disk)
  let selected = 0;
  let asked = 0; // the newest question's number
  let timer = 0;
  let previewEl = null; // the first-page card of the selected Office file
  let previewTimer = 0;
  const previews = new Map(); // id -> data: URL | null (asked once)
  let scanShown = false; // the disk search's answer is on screen: a change in the list (the hit being noted as opened) must not replace it

  const isOpen = () => Boolean(panel && !panel.hidden);
  const bridge = () => window.lumenFiles;

  // Which letters of `name` the query matched, for the highlight: each word as a piece of the name, else its letters in order.
  function matchRanges(query, name) {
    const lower = name.toLowerCase();
    const hit = new Set();
    for (const word of query.toLowerCase().split(/[\s_\-.,]+/).filter(Boolean).slice(0, 8)) {
      const at = lower.indexOf(word);
      if (at >= 0) { for (let i = 0; i < word.length; i++) hit.add(at + i); continue; }
      const found = [];
      let from = 0;
      for (const ch of word) { const i = lower.indexOf(ch, from); if (i < 0) { found.length = 0; break; } found.push(i); from = i + 1; }
      for (const i of found) hit.add(i);
    }
    return hit;
  }
  const folderOf = (path) => {
    const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
    parts.pop();
    return parts.slice(-3).join(' › ');
  };
  const extOf = (e) => (e.kind === 'folder' ? '' : (/\.([A-Za-z0-9]{1,5})$/.exec(e.name || '')?.[1] || '').toUpperCase());
  const clean = (e) => (e && typeof e === 'object' && typeof e.id === 'string' && typeof e.name === 'string'
    ? { id: e.id, name: e.name.slice(0, 260), path: typeof e.path === 'string' ? e.path.slice(0, 1000) : '', kind: e.kind === 'folder' ? 'folder' : 'file', pinned: e.pinned === true, missing: e.missing === true, openedAt: Number.isFinite(e.openedAt) ? e.openedAt : 0 }
    : null);
  // Pinned first, then what was opened lately, then what is only inside a pinned folder; the order inside a group is the ranking.
  const groupOf = (e) => (e.pinned ? 'pinned' : e.openedAt > 0 ? 'recent' : 'indexed');
  const GROUPS = [['pinned', 'Pinned', 'filesPicker.pinned'], ['recent', 'Recent', 'filesPicker.recent'], ['indexed', 'In pinned folders', 'filesPicker.indexed'], ['found', 'Found on this computer', 'filesPicker.found']];

  function build() {
    panel = Object.assign(document.createElement('div'), { id: 'files-picker', className: 'files-picker', hidden: true });
    const scrim = Object.assign(document.createElement('div'), { className: 'files-picker-scrim' });
    scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
    const box = Object.assign(document.createElement('div'), { className: 'files-picker-box' });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', tr('filesPicker.label', 'Open a recent file'));
    input = Object.assign(document.createElement('input'), { id: 'files-picker-input', type: 'search', placeholder: tr('filesPicker.placeholder', 'Find a pinned or recent file'), autocomplete: 'off', spellcheck: false });
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'files-picker-results');
    input.setAttribute('aria-label', tr('filesPicker.label', 'Open a recent file'));
    list = Object.assign(document.createElement('ul'), { id: 'files-picker-results', className: 'files-picker-results' });
    list.setAttribute('role', 'listbox');
    const mod = MAC ? '⌘' : 'Ctrl';
    const foot = Object.assign(document.createElement('div'), { className: 'files-picker-foot' });
    // The Enter key is drawn, not typed as "↵": that glyph is in none of the UI's fonts, and the first layout that met it paid ~22 ms for the
    // system's font fallback search (a dropped frame the first time the picker opened).
    const ENTER = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M10 2.5v3.2a1 1 0 0 1-1 1H3M5 4 3 6.7 5 9.4"/></svg>';
    for (const [mods, label] of [['', tr('filesPicker.hintOpen', 'Open')], [mod, tr('filesPicker.hintShow', 'Show in folder')], ['Alt', tr('filesPicker.hintAttach', 'Attach to chat')], ['Esc', tr('filesPicker.hintClose', 'Close')]]) {
      const hint = document.createElement('span');
      const kbd = Object.assign(document.createElement('kbd'), { textContent: mods === 'Esc' ? 'Esc' : mods ? `${mods} ` : '' });
      if (mods !== 'Esc') kbd.insertAdjacentHTML('beforeend', ENTER);
      hint.append(kbd, ` ${label}`);
      foot.append(hint);
    }
    previewEl = Object.assign(document.createElement('div'), { className: 'files-picker-preview', hidden: true });
    previewEl.setAttribute('aria-hidden', 'true'); // (a picture of what the selected row already names)
    box.append(input, list, foot, previewEl);
    panel.append(scrim, box);
    document.body.append(panel);
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => query(input.value), DEBOUNCE_MS); });
    input.addEventListener('keydown', onKey);
    list.addEventListener('pointerdown', (e) => e.preventDefault()); // the focus stays in the box
    const rowOf = (e) => { const li = e.target.closest?.('.files-picker-item'); return li ? Number(li.dataset.i) : -1; };
    list.addEventListener('mousemove', (e) => { const i = rowOf(e); if (i >= 0 && i !== selected) select(i); });
    list.addEventListener('click', (e) => { const i = rowOf(e); if (rows[i]) activate(rows[i], {}); });
    window.addEventListener('blur', () => { if (isOpen()) close(); });
  }

  // The name with its matched letters in <mark>s, set into the row's own name span.
  const setName = (span, e, ranges) => {
    if (!ranges.size) { span.textContent = e.name; return; }
    const frag = document.createDocumentFragment();
    let run = '';
    let marked = false;
    const flush = () => { if (!run) return; frag.append(marked ? Object.assign(document.createElement('mark'), { textContent: run }) : document.createTextNode(run)); run = ''; };
    for (let i = 0; i < e.name.length; i++) {
      const m = ranges.has(i);
      if (m !== marked) { flush(); marked = m; }
      run += e.name[i];
    }
    flush();
    span.append(frag);
  };

  // A row is cloned from one template (constant markup; names and folders are only set with textContent): a clone costs a fraction of
  // making and wiring seven elements by hand, 30 times an answer. The hover and the click are one listener on the list (build).
  const FOLDER_ICON = '<svg viewBox="0 0 16 16"><path d="M1.8 4.6a1.2 1.2 0 0 1 1.2-1.2h2.9l1.4 1.6h5.7a1.2 1.2 0 0 1 1.2 1.2v5.6a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2z"/></svg>';
  let template = null;
  function actionRow(item, i) {
    const li = Object.assign(document.createElement('li'), { className: `files-picker-item files-picker-action${i === selected ? ' selected' : ''}`, id: `files-picker-item-${i}`, textContent: item.text });
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === selected));
    li.dataset.i = String(i);
    return li;
  }
  function row(item, i) {
    if (item.action) return actionRow(item, i);
    if (!template) {
      template = document.createElement('li');
      template.setAttribute('role', 'option');
      template.innerHTML = '<span class="files-picker-badge" aria-hidden="true"></span><span class="files-picker-text"><span class="files-picker-name"></span><span class="files-picker-where"></span></span>';
    }
    const e = item.entry;
    const li = template.cloneNode(true);
    li.className = `files-picker-item${i === selected ? ' selected' : ''}${e.missing ? ' missing' : ''}`;
    li.id = `files-picker-item-${i}`;
    li.setAttribute('aria-selected', String(i === selected));
    li.dataset.kind = e.kind;
    li.dataset.i = String(i);
    const [badge, text] = li.children;
    if (e.kind === 'folder') { badge.className = 'files-picker-badge folder'; badge.innerHTML = FOLDER_ICON; } else badge.textContent = extOf(e);
    setName(text.firstChild, e, item.ranges);
    text.lastChild.textContent = e.missing ? tr('filesPicker.missing', 'moved or deleted') : folderOf(e.path);
    if (e.pinned) li.append(Object.assign(document.createElement('span'), { className: 'files-picker-pin', title: tr('filesPicker.pinned', 'Pinned') }));
    li.title = e.path;
    return li;
  }

  const OFFICE = /\.(?:docx|xlsx|pptx)$/i;
  const PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
  function showPreview(url) {
    if (!previewEl) return;
    if (!url) { previewEl.hidden = true; return; }
    const img = Object.assign(document.createElement('img'), { src: url, alt: '', decoding: 'async' });
    previewEl.replaceChildren(img);
    previewEl.hidden = false;
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    const e = rows[selected]?.entry;
    const files = bridge();
    if (!e || e.kind === 'folder' || e.missing || !OFFICE.test(e.name) || typeof files?.thumb !== 'function') { showPreview(null); return; }
    if (previews.has(e.id)) { showPreview(previews.get(e.id)); return; }
    showPreview(null);
    previewTimer = setTimeout(async () => {
      let url = null;
      try { const r = await files.thumb(e.id); url = r && typeof r.dataUrl === 'string' && PNG.test(r.dataUrl) ? r.dataUrl : null; } catch { url = null; }
      previews.set(e.id, url);
      if (isOpen() && rows[selected]?.entry?.id === e.id) showPreview(url);
    }, 180);
  }

  function select(i) {
    const was = document.getElementById(`files-picker-item-${selected}`);
    was?.classList.remove('selected');
    was?.setAttribute('aria-selected', 'false');
    selected = i;
    const now = document.getElementById(`files-picker-item-${i}`);
    now?.classList.add('selected');
    now?.setAttribute('aria-selected', 'true');
    if (now) { input.setAttribute('aria-activedescendant', now.id); now.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
    schedulePreview();
  }

  // opts: { found: the entries came from the disk scan, offer: show the "Search Documents…" row when nothing matched, status: a line under the rows }
  function render(entries, q, emptyText, opts = {}) {
    if (!isOpen()) return;
    const t0 = performance.now();
    const items = entries.slice(0, 100).map(clean).filter(Boolean).map((entry) => ({ entry, group: opts.found ? 'found' : groupOf(entry), ranges: q ? matchRanges(q, entry.name) : new Set() }));
    rows = [];
    for (const [id] of GROUPS) rows.push(...items.filter((it) => it.group === id));
    rows = rows.slice(0, MAX_ROWS);
    const offer = !rows.length && opts.offer;
    if (offer) rows = [{ action: 'scan', text: emptyText }];
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    const frag = document.createDocumentFragment();
    let section = null;
    rows.forEach((item, i) => {
      if (item.group && item.group !== section) { // (the offer to search the disk has no group, so no heading)
        section = item.group;
        const g = GROUPS.find((x) => x[0] === section);
        const header = Object.assign(document.createElement('li'), { className: 'files-picker-section', textContent: tr(g[2], g[1]) });
        header.setAttribute('role', 'presentation');
        frag.append(header);
      }
      frag.append(row(item, i));
    });
    if (!rows.length || opts.status) frag.append(Object.assign(document.createElement('li'), { className: 'files-picker-empty', textContent: opts.status || emptyText }));
    list.scrollTop = 0; // (before the swap: the layout is clean now, so this reads nothing stale; after it, it would force a layout in the middle of the draw)
    list.replaceChildren(frag);
    const current = document.getElementById(`files-picker-item-${selected}`);
    if (current) input.setAttribute('aria-activedescendant', current.id); else input.removeAttribute('aria-activedescendant');
    schedulePreview();
    window.__filesPerf?.push(['picker-draw', performance.now() - t0]); // (a test makes the array: the draw's own time per answer)
  }

  // Ask main (nothing typed: the pinned and recent lists, which are cheap; else its fuzzy search). Only the newest answer is drawn.
  async function query(q) {
    const mine = ++asked;
    scanShown = false;
    const files = bridge();
    if (!files) { render([], '', tr('filesPicker.none', 'Files are not available.')); return; }
    try {
      if (!q.trim()) {
        const d = await files.list();
        if (mine !== asked) return;
        render([...(d?.pinned || []), ...(d?.recent || [])], '', tr('filesPicker.none', 'Pin a folder or open a file and it shows up here.'));
      } else {
        const found = await files.search(q);
        if (mine !== asked) return;
        const list = Array.isArray(found) ? found : [];
        if (list.length || typeof files.scan !== 'function') render(list, q, tr('filesPicker.empty', 'No matching files'));
        else render([], q, tr('filesPicker.scan', 'No match in your pinned and recent files. Search Documents, Desktop and Downloads'), { offer: true });
      }
    } catch {
      if (mine === asked) render([], q, tr('filesPicker.empty', 'No matching files'));
    }
  }

  // "Search Documents, Desktop and Downloads": one bounded walk in main's index worker; a newer question or a close drops the answer.
  async function scan() {
    const q = input.value.trim();
    const files = bridge();
    if (!q || typeof files?.scan !== 'function') return;
    const mine = ++asked;
    scanShown = true; // (from now: the search, then its answer)
    render([], q, '', { status: tr('filesPicker.searching', 'Searching Documents, Desktop and Downloads…') });
    let found = [];
    try { found = await files.scan(q); } catch { /* shown as nothing found */ }
    if (mine !== asked) return;
    selected = 0;
    scanShown = true;
    render(Array.isArray(found) ? found : [], q, tr('filesPicker.scanNone', 'Nothing found in Documents, Desktop or Downloads'), { found: true });
  }

  function onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) select((selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Enter' && !isImeEnter(e)) {
      e.preventDefault();
      if (rows[selected]) activate(rows[selected], { show: e.ctrlKey || e.metaKey, attach: e.altKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function activate(item, how) {
    if (item.action === 'scan') { scan(); return; }
    const id = item.entry.id;
    close();
    const files = bridge();
    if (how.attach) {
      Promise.resolve(files.attach(id)).catch(() => {}); // (main sends the bytes to the composer and the sidebar comes to the front: app.js lumenFiles.onAttach)
    } else if (how.show) files.show(id);
    else files.open(id);
  }

  async function open() {
    const t0 = performance.now();
    if (!panel) build();
    if (isOpen()) { input.select(); return; }
    freezePage(); // app.js: the page shows as a still image so the picker can sit over it. It reads the viewport's size, so it goes before the panel is shown: the read finds the layout clean (after the panel's first show it forced a 25 ms layout)
    panel.hidden = false;
    input.value = '';
    selected = 0;
    rows = [];
    list.replaceChildren();
    input.focus();
    window.__filesPerf?.push(['picker-show', performance.now() - t0]); // (a test makes the array: what opening costs before the first frame)
    query('');
  }

  function close() {
    if (!isOpen()) return;
    clearTimeout(timer);
    clearTimeout(previewTimer);
    asked++; // an answer still on its way is not drawn
    panel.hidden = true;
    thawPage();
  }

  // (opened by app.js's stub, which loads this file the first time Ctrl+Shift+F asks, or in an idle moment after start)
  window.lumenFiles?.on('changed', () => { if (isOpen() && !scanShown) query(input.value); }); // a file opened or moved meanwhile
  return { open, close, isOpen };
})();
window.filesPicker = filesPicker; // (app.js's stub opens it)
