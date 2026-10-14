// The quick file picker (Ctrl+Shift+F, or File > Find files): fuzzy search over the files and folders Lumen knows (pinned, recently opened,
// and what is inside pinned folders). Enter opens, Ctrl+Enter shows it in its folder, Alt+Enter attaches it to the sidebar chat, Esc closes.
// It sits in the middle of the window over the page (shown as a still picture while it is open, like tab search), never waits on the disk:
// the search runs in main (features/files.js) and is asked 60 ms after the last key; an answer that arrives after a newer question is
// dropped, and at most 30 rows are drawn. With nothing typed it lists the pinned and recent files. Names are only set with textContent.
// Main side: features/files.js; the keys: main.js openFilesPicker, features/page-first-keys.js.

const filesPicker = (() => {
  const MAX_ROWS = 30;
  const DEBOUNCE_MS = 60;
  const MAC = /Mac/i.test(navigator.platform || '');
  const tr = (key, english) => { const v = window.t?.(key); return v && v !== key ? v : english; };
  let panel = null;
  let input = null;
  let list = null;
  let rows = []; // [{ entry, group, ranges }] in the order drawn
  let selected = 0;
  let asked = 0; // the newest question's number
  let timer = 0;

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
  const GROUPS = [['pinned', 'Pinned', 'filesPicker.pinned'], ['recent', 'Recent', 'filesPicker.recent'], ['indexed', 'In pinned folders', 'filesPicker.indexed']];

  function build() {
    panel = Object.assign(document.createElement('div'), { id: 'files-picker', className: 'files-picker', hidden: true });
    const scrim = Object.assign(document.createElement('div'), { className: 'files-picker-scrim' });
    scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
    const box = Object.assign(document.createElement('div'), { className: 'files-picker-box' });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', tr('filesPicker.label', 'Find files'));
    input = Object.assign(document.createElement('input'), { id: 'files-picker-input', type: 'search', placeholder: tr('filesPicker.placeholder', 'Find a pinned or recent file'), autocomplete: 'off', spellcheck: false });
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'files-picker-results');
    input.setAttribute('aria-label', tr('filesPicker.label', 'Find files'));
    list = Object.assign(document.createElement('ul'), { id: 'files-picker-results', className: 'files-picker-results' });
    list.setAttribute('role', 'listbox');
    const mod = MAC ? '⌘' : 'Ctrl';
    const foot = Object.assign(document.createElement('div'), { className: 'files-picker-foot' });
    for (const [keys, label] of [['↵', tr('filesPicker.hintOpen', 'Open')], [`${mod} ↵`, tr('filesPicker.hintShow', 'Show in folder')], ['Alt ↵', tr('filesPicker.hintAttach', 'Attach to chat')], ['Esc', tr('filesPicker.hintClose', 'Close')]]) {
      const hint = document.createElement('span');
      hint.append(Object.assign(document.createElement('kbd'), { textContent: keys }), ` ${label}`);
      foot.append(hint);
    }
    box.append(input, list, foot);
    panel.append(scrim, box);
    document.body.append(panel);
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => query(input.value), DEBOUNCE_MS); });
    input.addEventListener('keydown', onKey);
    list.addEventListener('pointerdown', (e) => e.preventDefault()); // the focus stays in the box
    window.addEventListener('blur', () => { if (isOpen()) close(); });
  }

  const name = (e, ranges) => {
    const span = Object.assign(document.createElement('span'), { className: 'files-picker-name' });
    if (!ranges.size) { span.textContent = e.name; return span; }
    let run = '';
    let marked = false;
    const flush = () => { if (!run) return; span.append(marked ? Object.assign(document.createElement('mark'), { textContent: run }) : document.createTextNode(run)); run = ''; };
    for (let i = 0; i < e.name.length; i++) {
      const m = ranges.has(i);
      if (m !== marked) { flush(); marked = m; }
      run += e.name[i];
    }
    flush();
    return span;
  };

  function row(item, i) {
    const e = item.entry;
    const li = document.createElement('li');
    li.className = `files-picker-item${i === selected ? ' selected' : ''}${e.missing ? ' missing' : ''}`;
    li.id = `files-picker-item-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === selected));
    li.dataset.kind = e.kind;
    const ext = extOf(e);
    const badge = Object.assign(document.createElement('span'), { className: `files-picker-badge${e.kind === 'folder' ? ' folder' : ''}`, textContent: ext || '' });
    badge.setAttribute('aria-hidden', 'true');
    if (e.kind === 'folder') badge.innerHTML = '<svg viewBox="0 0 16 16"><path d="M1.8 4.6a1.2 1.2 0 0 1 1.2-1.2h2.9l1.4 1.6h5.7a1.2 1.2 0 0 1 1.2 1.2v5.6a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2z"/></svg>';
    const text = Object.assign(document.createElement('span'), { className: 'files-picker-text' });
    const where = Object.assign(document.createElement('span'), { className: 'files-picker-where', textContent: e.missing ? tr('filesPicker.missing', 'moved or deleted') : folderOf(e.path) });
    text.append(name(e, item.ranges), where);
    li.append(badge, text);
    if (e.pinned) li.append(Object.assign(document.createElement('span'), { className: 'files-picker-pin', title: tr('filesPicker.pinned', 'Pinned') }));
    li.title = e.path;
    li.onmousemove = () => { if (selected !== i) select(i); };
    li.onclick = () => activate(item, {});
    return li;
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
  }

  function render(entries, q, emptyText) {
    if (!isOpen()) return;
    const items = entries.slice(0, 100).map(clean).filter(Boolean).map((entry) => ({ entry, group: groupOf(entry), ranges: q ? matchRanges(q, entry.name) : new Set() }));
    rows = [];
    for (const [id] of GROUPS) rows.push(...items.filter((it) => it.group === id));
    rows = rows.slice(0, MAX_ROWS);
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    const frag = document.createDocumentFragment();
    let section = null;
    rows.forEach((item, i) => {
      if (item.group !== section) {
        section = item.group;
        const g = GROUPS.find((x) => x[0] === section);
        const header = Object.assign(document.createElement('li'), { className: 'files-picker-section', textContent: tr(g[2], g[1]) });
        header.setAttribute('role', 'presentation');
        frag.append(header);
      }
      frag.append(row(item, i));
    });
    if (!rows.length) frag.append(Object.assign(document.createElement('li'), { className: 'files-picker-empty', textContent: emptyText }));
    list.replaceChildren(frag);
    const current = document.getElementById(`files-picker-item-${selected}`);
    if (current) input.setAttribute('aria-activedescendant', current.id); else input.removeAttribute('aria-activedescendant');
    list.scrollTop = 0;
  }

  // Ask main (nothing typed: the pinned and recent lists, which are cheap; else its fuzzy search). Only the newest answer is drawn.
  async function query(q) {
    const mine = ++asked;
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
        render(Array.isArray(found) ? found : [], q, tr('filesPicker.empty', 'No matching files'));
      }
    } catch {
      if (mine === asked) render([], q, tr('filesPicker.empty', 'No matching files'));
    }
  }

  function onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) select((selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows[selected]) activate(rows[selected], { show: e.ctrlKey || e.metaKey, attach: e.altKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function activate(item, how) {
    const id = item.entry.id;
    close();
    const files = bridge();
    if (how.attach) {
      Promise.resolve(files.attach(id)).then((ok) => { if (ok !== false) window.showSidebarFor?.(); }).catch(() => {}); // the sidebar comes to the front with the file on it
    } else if (how.show) files.show(id);
    else files.open(id);
  }

  async function open() {
    if (!panel) build();
    if (isOpen()) { input.select(); return; }
    panel.hidden = false;
    freezePage(); // app.js: the page shows as a still image so the picker can sit over it
    input.value = '';
    selected = 0;
    rows = [];
    list.replaceChildren();
    input.focus();
    query('');
  }

  function close() {
    if (!isOpen()) return;
    clearTimeout(timer);
    asked++; // an answer still on its way is not drawn
    panel.hidden = true;
    thawPage();
  }

  window.browser.onOpenFilesPicker?.(open);
  window.lumenFiles?.onChanged(() => { if (isOpen()) query(input.value); }); // a file opened or moved meanwhile
  return { open, close, isOpen };
})();
