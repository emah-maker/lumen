// lumen://chat: the canvas panel. A long code block, or an HTML / SVG document, in a reply gets "Open in canvas": a resizable side
// panel with Code, Split and Preview views; the code can be edited in place (each pause is a version: Undo, Redo, Original); the
// preview has Full / Tablet / Phone widths and Reload; Copy, Download, Expand (the whole chat area) and Close. Loaded after
// chat-canvas.js (the pure part: kinds, frameDocument) and before chat-core.js, which calls chatCanvas.decorate() for each code
// block it draws. The sidebar never loads this file, so it has no canvas, and the UI bundle does not carry it.
//
// The preview is code the AI (or a web page it read) wrote, or the user's edit of it, so it is treated as hostile: it runs in an
// <iframe sandbox="allow-scripts"> with no allow-same-origin (an opaque origin: no access to this page, its preload or any IPC),
// showing canvas-frame.html, whose own Content-Security-Policy allows no network at all. The page writes the document into that
// frame by postMessage. Nothing here builds markup from the code: it is textContent and a textarea's value.
(function (root) {
  const core = root.chatCanvas;
  const main = document.querySelector('.cp-main');
  if (!main || !core) return;
  const { kindOf, previewable, frameDocument, fileName, lines } = core;
  const say = (key, fallback, vars) => { const v = root.t ? root.t(key, vars) : key; return v === key ? fallback : v; };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const btn = (label, title, cls = 'cv-btn') => el('button', { type: 'button', className: cls, textContent: label, ...(title ? { title, ariaLabel: title } : {}) });
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } } };
  const DEVICES = { full: 0, tablet: 768, phone: 390 };
  const SNAP_MS = 800; // a pause this long in typing makes a version
  const LIVE_MS = 450; // and the preview follows the edit this soon
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  let panel = null;
  let state = null; // { lang, kind, code, versions, at, view, device, editing }
  let lastOpener = null;

  function build() {
    const title = el('span', { className: 'cv-title' });
    const meta = el('span', { className: 'cv-meta' });
    const expand = btn('⤢', say('canvas.expand', 'Expand'), 'cv-btn cv-icon cv-expand');
    const close = btn('×', say('canvas.close', 'Close canvas'), 'cv-btn cv-icon cv-close');
    const head = el('div', { className: 'cv-head' }, title, meta, el('span', { className: 'cv-spacer' }), expand, close);

    const tab = (view, label) => { const b = el('button', { type: 'button', className: 'cv-tab', role: 'tab', textContent: label }); b.dataset.view = view; return b; };
    const tabCode = tab('code', say('canvas.code', 'Code'));
    const tabSplit = tab('split', say('canvas.split', 'Split'));
    const tabPreview = tab('preview', say('canvas.preview', 'Preview'));
    const tabs = el('div', { className: 'cv-tabs', role: 'tablist', ariaLabel: say('canvas.view', 'View') }, tabCode, tabSplit, tabPreview);
    const dev = (key, label) => { const b = el('button', { type: 'button', className: 'cv-seg-btn', textContent: label }); b.dataset.device = key; return b; };
    const devices = el('div', { className: 'cv-seg', role: 'group', ariaLabel: say('canvas.width', 'Preview width') }, dev('full', say('canvas.full', 'Full')), dev('tablet', say('canvas.tablet', 'Tablet')), dev('phone', say('canvas.phone', 'Phone')));
    const undo = btn(say('canvas.undo', 'Undo'), say('canvas.undoTitle', 'Back to the version before'));
    const redo = btn(say('canvas.redo', 'Redo'), say('canvas.redoTitle', 'Forward to the next version'));
    const original = btn(say('canvas.original', 'Original'), say('canvas.originalTitle', 'Back to the code from the reply'));
    const history = el('div', { className: 'cv-group cv-history' }, undo, redo, original);
    const edit = btn(say('canvas.edit', 'Edit'), say('canvas.editTitle', 'Edit the code here'));
    const reload = btn(say('canvas.reload', 'Reload'), say('canvas.reloadTitle', 'Run the page again'));
    const copy = btn(say('chat.copyCode', 'Copy'));
    const download = btn(say('canvas.download', 'Download'));
    const tools = el('div', { className: 'cv-tools' }, tabs, devices, el('span', { className: 'cv-spacer' }), history, edit, reload, copy, download);

    const codeEl = el('code');
    const codeView = el('pre', { className: 'cv-code', tabIndex: 0 }, codeEl);
    const editor = el('textarea', { className: 'cv-edit', spellcheck: false, hidden: true, ariaLabel: say('canvas.editor', 'Code editor') });
    editor.setAttribute('autocapitalize', 'off');
    editor.setAttribute('autocomplete', 'off');
    const codePane = el('div', { className: 'cv-codepane' }, codeView, editor);
    const stage = el('div', { className: 'cv-stage' });
    const previewBox = el('div', { className: 'cv-preview' }, stage);
    const body = el('div', { className: 'cv-body' }, codePane, previewBox);
    const grip = el('div', { className: 'cv-grip', role: 'separator', tabIndex: 0, ariaOrientation: 'vertical', ariaLabel: say('canvas.resize', 'Resize canvas') });
    const aside = el('aside', { id: 'canvas', className: 'cv', hidden: true, ariaLabel: say('canvas.label', 'Canvas') }, grip, head, tools, body);
    main.append(aside);

    const setWidth = (px) => {
      const w = Math.max(320, Math.min(px, Math.max(320, main.clientWidth - 360)));
      aside.style.width = `${w}px`;
      grip.setAttribute('aria-valuenow', String(Math.round(w)));
      store.set('lumen.canvasWidth', String(Math.round(w)));
    };
    const saved = Number(store.get('lumen.canvasWidth')) || 0;
    aside.style.width = `${saved >= 320 ? saved : 560}px`;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      aside.classList.add('resizing');
      const move = (ev) => setWidth(main.getBoundingClientRect().right - ev.clientX);
      const up = () => { aside.classList.remove('resizing'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setWidth(aside.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 40 : -40));
    });

    for (const b of [tabCode, tabSplit, tabPreview]) b.addEventListener('click', () => { show(b.dataset.view); store.set('lumen.canvasView', b.dataset.view); });
    devices.addEventListener('click', (e) => { const b = e.target.closest('.cv-seg-btn'); if (b) { state.device = b.dataset.device; store.set('lumen.canvasDevice', state.device); paintDevice(); } });
    undo.addEventListener('click', () => step(-1));
    redo.addEventListener('click', () => step(1));
    original.addEventListener('click', () => { snapshot(); if (state.code !== state.versions[0]) { record(state.versions[0]); setCode(state.versions[0]); } });
    edit.addEventListener('click', () => setEditing(!state.editing));
    reload.addEventListener('click', () => drawPreview());
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(state.code); copy.textContent = say('chat.copied', 'Copied'); } catch { copy.textContent = say('chat.copyFailed', 'Copy failed'); }
      setTimeout(() => { copy.textContent = say('chat.copyCode', 'Copy'); }, 1400);
    });
    download.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([state.code], { type: 'text/plain;charset=utf-8' }));
      const a = el('a', { href: url, download: fileName(state.lang, state.kind) });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
    expand.addEventListener('click', () => { const on = aside.classList.toggle('cv-wide'); expand.setAttribute('aria-pressed', String(on)); expand.title = on ? say('canvas.shrink', 'Back to the side') : say('canvas.expand', 'Expand'); });
    close.addEventListener('click', () => closePanel());

    let snapTimer = 0;
    let liveTimer = 0;
    editor.addEventListener('input', () => {
      state.code = editor.value;
      paintMeta();
      clearTimeout(snapTimer); snapTimer = setTimeout(snapshot, SNAP_MS);
      clearTimeout(liveTimer); if (state.view !== 'code') liveTimer = setTimeout(drawPreview, LIVE_MS);
    });
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); clearTimeout(liveTimer); snapshot(); if (state.view !== 'code') drawPreview(); return; }
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input')); }
    });
    aside.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (aside.classList.contains('cv-wide')) expand.click(); else closePanel(true); } });
    panel = { aside, title, meta, tabs, tabCode, tabSplit, tabPreview, devices, history, undo, redo, original, edit, reload, codeEl, codeView, editor, body, previewBox, stage, expand, cancel: () => { clearTimeout(snapTimer); clearTimeout(liveTimer); } };
    return panel;
  }

  // ---- versions: the reply's code is the first; each pause in typing adds one (anything after the current one is dropped, as in an editor)
  function record(code) {
    state.versions = state.versions.slice(0, state.at + 1);
    state.versions.push(code);
    if (state.versions.length > 50) state.versions.splice(1, 1); // the original always stays
    state.at = state.versions.length - 1;
  }
  function snapshot() { if (state && state.code !== state.versions[state.at]) record(state.code); paintMeta(); }
  function step(by) {
    snapshot();
    const to = Math.max(0, Math.min(state.versions.length - 1, state.at + by));
    if (to === state.at) return;
    state.at = to;
    setCode(state.versions[to]);
  }
  function setCode(code) {
    state.code = code;
    if (panel.editor.value !== code) panel.editor.value = code;
    paintCode();
    paintMeta();
    if (state.view !== 'code') drawPreview();
  }

  function paintCode() {
    panel.codeEl.textContent = state.code;
    panel.codeEl.removeAttribute('data-hl');
    try { root.highlightCode?.(panel.codeEl, state.kind === 'code' ? state.lang : 'html'); } catch { /* plain text is fine */ }
  }
  function paintMeta() {
    const n = lines(state.code);
    const parts = [say('canvas.lines', `${n} lines`, { n }), sizeText(new Blob([state.code]).size)];
    if (state.versions.length > 1) parts.push(say('canvas.version', `version ${state.at + 1} of ${state.versions.length}`, { at: state.at + 1, of: state.versions.length }));
    panel.meta.textContent = parts.join(' · ');
    panel.undo.disabled = state.at === 0 && state.code === state.versions[0];
    panel.redo.disabled = state.at >= state.versions.length - 1;
    panel.original.disabled = state.code === state.versions[0];
    panel.history.hidden = state.versions.length < 2 && !state.editing;
  }
  function paintDevice() {
    const w = DEVICES[state.device] || 0;
    panel.stage.style.width = w ? `${w}px` : '';
    panel.previewBox.dataset.device = w ? state.device : 'full';
    for (const b of panel.devices.querySelectorAll('.cv-seg-btn')) { const on = b.dataset.device === state.device; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
  }
  function setEditing(on) {
    state.editing = on;
    if (on) panel.editor.value = state.code; else { snapshot(); paintCode(); }
    panel.codeView.hidden = on;
    panel.editor.hidden = !on;
    panel.edit.textContent = on ? say('canvas.done', 'Done') : say('canvas.edit', 'Edit');
    panel.edit.setAttribute('aria-pressed', String(on));
    paintMeta();
    if (on) panel.editor.focus();
  }

  function show(view) {
    const can = previewable(state.kind);
    const v = can ? view : 'code';
    state.view = v;
    panel.body.dataset.view = v;
    panel.codeView.parentElement.hidden = v === 'preview';
    panel.previewBox.hidden = v === 'code';
    panel.devices.hidden = v === 'code';
    panel.reload.hidden = v === 'code';
    if (v === 'split' && !state.editing) setEditing(true); // the code beside the page is for changing it
    for (const b of [panel.tabCode, panel.tabSplit, panel.tabPreview]) { const on = b.dataset.view === v; b.setAttribute('aria-selected', String(on)); b.classList.toggle('active', on); }
    if (v === 'code') panel.stage.replaceChildren(); else drawPreview(); // leaving the preview ends the page's scripts
  }
  function drawPreview() {
    if (!state || state.view === 'code') return;
    const frame = el('iframe', { className: 'cv-frame', title: say('canvas.previewTitle', 'Preview') });
    // allow-scripts only: no allow-same-origin (so an opaque origin, cut off from this page and its preload), no popups, forms,
    // top navigation, downloads or modals. allow="" refuses camera, microphone, location and the rest.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const { kind, code } = state;
    const math = root.pageMath?.ready(code); // [page math] Temml, when the page has formulas
    frame.addEventListener('load', async () => {
      await math;
      const html = frameDocument(kind, code, { accent: core.accent() });
      try { frame.contentWindow.postMessage({ lumenCanvas: html }, '*'); } catch { /* frame gone */ }
    });
    frame.src = 'canvas-frame.html';
    panel.stage.replaceChildren(frame);
  }

  function open({ lang, code, opener, quiet = false }) { // quiet: opened for the user (a file the AI made), so focus stays in the message box
    panel ||= build();
    panel.cancel();
    delete panel.aside.dataset.mode;
    lastOpener = opener || null;
    const kind = kindOf(lang, code);
    const text = String(code || '');
    state = { lang: String(lang || ''), kind, code: text, versions: [text], at: 0, view: 'code', device: DEVICES[store.get('lumen.canvasDevice')] !== undefined ? store.get('lumen.canvasDevice') : 'full', editing: false };
    panel.title.textContent = kind === 'html' ? 'HTML' : kind === 'svg' ? 'SVG' : (state.lang || say('chat.code', 'Code'));
    panel.editor.value = text;
    setEditing(false);
    paintCode();
    paintMeta();
    paintDevice();
    panel.tabs.hidden = !previewable(kind);
    panel.aside.hidden = false;
    document.body.classList.add('canvas-open');
    const pref = store.get('lumen.canvasView');
    show(previewable(kind) ? (pref === 'split' || pref === 'code' ? pref : 'preview') : 'code');
    if (!quiet) panel.aside.querySelector('.cv-tab.active, .cv-btn')?.focus();
  }
  // A picture instead of code: the first page of a Word, Excel or PowerPoint file (a card's "Open in canvas", renderer/ai-files.js). The picture is a
  // data: PNG main drew; nothing here is the file's own markup.
  function openImage({ title, src, opener }) {
    if (typeof src !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) return;
    panel ||= build();
    panel.cancel();
    lastOpener = opener || null;
    state = { lang: '', kind: 'image', code: '', versions: [''], at: 0, view: 'preview', device: 'full', editing: false };
    panel.title.textContent = String(title || '');
    panel.meta.textContent = '';
    panel.body.dataset.view = 'preview';
    panel.codeView.parentElement.hidden = true;
    panel.previewBox.hidden = false;
    panel.stage.style.width = '';
    panel.stage.replaceChildren(el('img', { className: 'cv-image', src, alt: String(title || ''), decoding: 'async' }));
    panel.aside.dataset.mode = 'image';
    panel.aside.hidden = false;
    document.body.classList.add('canvas-open');
    panel.aside.querySelector('.cv-close')?.focus();
  }
  function closePanel(restoreFocus) {
    if (!panel) return;
    panel.cancel();
    delete panel.aside.dataset.mode;
    panel.aside.hidden = true;
    panel.aside.classList.remove('cv-wide');
    panel.stage.replaceChildren();
    document.body.classList.remove('canvas-open');
    if (restoreFocus && lastOpener?.isConnected) lastOpener.focus();
  }

  // Called by chat-core.js for each code block: `head` is its header row, `copyBtn` the Copy button in it.
  function decorate(pre, head, copyBtn) {
    const code = pre.querySelector('code')?.textContent ?? pre.textContent;
    if (!core.worthOpening(pre.dataset.lang, code)) return;
    const b = el('button', { type: 'button', className: 'code-copy code-canvas', textContent: say('canvas.open', 'Open in canvas') });
    b.addEventListener('click', () => open({ lang: pre.dataset.lang, code: pre.querySelector('code')?.textContent ?? pre.textContent, opener: b }));
    copyBtn.before(b);
  }
  root.chatCanvas = { ...core, decorate, open, openImage, close: closePanel };
})(window);
