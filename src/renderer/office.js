// The Word and Excel viewer (features/office-viewer.js): the main process calls lumenOffice once with a file parsed by features/office-doc.js:
// plain JSON (see its header). Everything is drawn with createElement / textContent and style properties, never HTML; a picture is used only if it
// is a data:image/ URL of a type Chromium shows (the page's CSP allows nothing else either); a link is shown, not followed (nothing here navigates).
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const COLOR = /^#[0-9a-f]{6}$/i;
  if (/[?&]thumb=1(?:&|$)/.test(location.search)) document.documentElement.classList.add('thumb');

  // ---- Word
  function runNode(run) {
    if (run.img !== undefined) {
      if (typeof run.img !== 'string' || !IMAGE.test(run.img)) return document.createTextNode('');
      const img = el('img');
      img.src = run.img;
      img.alt = String(run.alt || '');
      if (run.w > 0) img.style.width = `${Math.min(Number(run.w) || 0, 2000)}px`;
      img.decoding = 'async';
      return img;
    }
    const span = el('span', run.href ? 'link' : '', String(run.text ?? ''));
    if (run.href) span.title = String(run.href);
    if (run.b) span.style.fontWeight = '700';
    if (run.i) span.style.fontStyle = 'italic';
    const deco = [run.u ? 'underline' : '', run.s ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco) span.style.textDecoration = deco;
    if (COLOR.test(run.color || '')) span.style.color = run.color;
    if (run.sup || run.sub) { const t = el(run.sup ? 'sup' : 'sub'); t.append(span); return t; }
    return span;
  }
  const STYLES = new Set(['p', 'title', 'subtitle', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const ALIGNS = new Set(['center', 'right', 'justify']);
  function blockNode(block, depth = 0) {
    if (block.t === 'hr') return el('hr');
    if (block.t === 'table') {
      const table = el('table');
      const body = el('tbody');
      for (const row of Array.isArray(block.rows) ? block.rows : []) {
        const tr = el('tr');
        for (const cell of row) {
          const td = el('td');
          if (cell.span > 1) td.colSpan = Math.min(Number(cell.span) || 1, 30);
          if (COLOR.test(cell.bg || '')) td.style.background = cell.bg;
          for (const b of Array.isArray(cell.blocks) ? cell.blocks : []) if (depth < 4) td.append(blockNode(b, depth + 1));
          tr.append(td);
        }
        body.append(tr);
      }
      table.append(body);
      return table;
    }
    const style = STYLES.has(block.style) ? block.style : 'p';
    const p = el('p', `${style}${block.empty ? ' empty' : ''}${ALIGNS.has(block.align) ? ` ${block.align}` : ''}${block.list ? ' li' : ''}`);
    if (block.list) {
      const level = Math.max(0, Math.min(8, Number(block.list.level) || 0));
      p.style.marginLeft = `${1.8 + level * 1.6}em`;
      p.append(el('span', 'mark', String(block.list.marker || '•')));
    }
    for (const run of Array.isArray(block.runs) ? block.runs : []) p.append(runNode(run));
    return p;
  }
  function showDocx(data) {
    const main = $('doc');
    main.className = 'docx';
    const paper = el('article', 'paper');
    paper.setAttribute('aria-label', String(data.name || 'Document'));
    for (const block of Array.isArray(data.blocks) ? data.blocks : []) paper.append(blockNode(block));
    main.replaceChildren(paper);
    if (data.truncated) $('note').textContent = 'This document is long: only the first part is shown.';
  }

  // ---- Excel
  const letters = (i) => { let s = ''; let n = i + 1; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
  let book = null;
  function sheetTable(sheet, styles) {
    const cols = Math.max(Number(sheet.cols) || 0, 1);
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const covered = new Set();
    const spans = new Map();
    for (const m of Array.isArray(sheet.merges) ? sheet.merges : []) {
      const [r1, c1, r2, c2] = m.map(Number);
      spans.set(`${r1},${c1}`, [r2 - r1 + 1, c2 - c1 + 1]);
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${r},${c}`);
    }
    const table = el('table', 'grid');
    const colgroup = el('colgroup');
    const first = el('col');
    first.style.width = '44px';
    colgroup.append(first);
    for (let c = 0; c < cols; c++) { const col = el('col'); col.style.width = `${Number(sheet.colW?.[c]) || 72}px`; colgroup.append(col); }
    table.append(colgroup);
    const head = el('tr');
    head.append(el('th', 'corner row'));
    for (let c = 0; c < cols; c++) head.append(el('th', '', letters(c)));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const tbody = el('tbody');
    const count = Math.max(rows.length, 1);
    for (let r = 0; r < count; r++) {
      const tr = el('tr');
      tr.append(el('th', 'row', String(r + 1)));
      const row = rows[r] || [];
      for (let c = 0; c < cols; c++) {
        if (covered.has(`${r},${c}`)) continue;
        const cell = row[c];
        const td = el('td');
        const span = spans.get(`${r},${c}`);
        if (span) { td.rowSpan = span[0]; td.colSpan = span[1]; }
        if (cell && typeof cell === 'object') {
          td.textContent = String(cell.v ?? '');
          if (cell.n) td.classList.add('num');
          const st = Number.isInteger(cell.s) ? styles[cell.s] : null;
          if (st) {
            if (st.b) td.style.fontWeight = '700';
            if (st.i) td.style.fontStyle = 'italic';
            if (COLOR.test(st.color || '')) td.style.color = st.color;
            if (COLOR.test(st.bg || '')) td.style.background = st.bg;
            if (['left', 'center', 'right'].includes(st.align)) td.style.textAlign = st.align;
            if (st.wrap) td.classList.add('wrap');
          }
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }
  function showSheet(i) {
    if (!book) return;
    const at = Math.max(0, Math.min(book.sheets.length - 1, i));
    const sheet = book.sheets[at];
    $('doc').replaceChildren(sheetTable(sheet, Array.isArray(book.styles) ? book.styles : []));
    if (typeof $('doc').scrollTo === 'function') $('doc').scrollTo(0, 0);
    [...$('sheets').children].forEach((b, k) => b.setAttribute('aria-selected', String(k === at)));
    $('note').textContent = sheet.truncated ? `This sheet is large: only the first ${Number(sheet.rows.length)} rows and ${Number(sheet.cols)} columns are shown.` : '';
  }
  function showXlsx(data) {
    book = { sheets: Array.isArray(data.sheets) ? data.sheets : [], styles: data.styles };
    $('doc').className = 'xlsx';
    const tabs = $('sheets');
    tabs.replaceChildren();
    book.sheets.forEach((s, i) => {
      const b = el('button', '', String(s.name || `Sheet ${i + 1}`));
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => showSheet(i));
      tabs.append(b);
    });
    tabs.hidden = book.sheets.length < 2;
    tabs.setAttribute('role', 'tablist');
    document.documentElement.style.setProperty('--tabs', tabs.hidden ? '0px' : '36px');
    showSheet(0);
  }

  function showMessage(title, detail) {
    const box = el('div', 'message');
    box.append(el('strong', '', title), document.createTextNode(detail || ''));
    $('doc').className = '';
    $('doc').replaceChildren(box);
  }

  window.lumenOffice = (data) => {
    if (!data || typeof data !== 'object') return;
    const name = String(data.name || 'Document');
    document.title = name;
    $('name').textContent = name;
    $('kind').textContent = data.kind === 'xlsx' ? 'Excel workbook, read-only' : 'Word document, read-only';
    document.documentElement.style.setProperty('--hdr', `${$('name').parentElement.offsetHeight || 45}px`);
    if (data.error) { showMessage('This file can’t be shown', String(data.error)); document.body.dataset.ready = 'error'; return; }
    if (data.kind === 'xlsx') showXlsx(data); else showDocx(data);
    // (the pictures: ready once every one has loaded, so a thumbnail never catches a half-drawn page)
    const imgs = [...document.images];
    Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); })))).then(() => { document.body.dataset.ready = 'true'; });
  };
})();
