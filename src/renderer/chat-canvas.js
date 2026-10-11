// lumen://chat: the canvas. A long code block, or an HTML / SVG document, in a reply gets "Open in canvas":
// a resizable side panel with Code and Preview tabs, Copy, Download and Close. Loaded after chat-core.js, which
// calls chatCanvas.decorate() for each code block it draws (the sidebar never loads this file, so it has no canvas).
//
// The preview is code the AI (or a web page it read) wrote, so it is treated as hostile: it runs in an
// <iframe sandbox="allow-scripts"> with no allow-same-origin (an opaque origin: no access to this page,
// its preload or any IPC), showing canvas-frame.html, whose own Content-Security-Policy allows no network
// at all. The page writes the document into that frame by postMessage.
(function (root) {
  const LARGE_LINES = 25; // a block this long (or longer) is worth a panel
  const LARGE_CHARS = 1200;
  const PREVIEW_MAX = 2 * 1024 * 1024;
  const EXT = { html: 'html', svg: 'svg', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', css: 'css', json: 'json', markdown: 'md', md: 'md', bash: 'sh', sh: 'sh', shell: 'sh', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', go: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', php: 'php', sql: 'sql', yaml: 'yml', yml: 'yml', xml: 'xml', jsx: 'jsx', tsx: 'tsx', swift: 'swift', kotlin: 'kt' };

  // What a block is: 'html' | 'svg' | 'code', from its fence language and what it starts with.
  function kindOf(lang, code) {
    const l = String(lang || '').trim().toLowerCase();
    const head = String(code || '').trimStart().slice(0, 300).toLowerCase();
    if (l === 'svg' || /^(<\?xml[^>]*>\s*)?<svg[\s>]/.test(head)) return 'svg';
    if (l === 'html' || l === 'htm' || /^<!doctype html|^<html[\s>]/.test(head)) return 'html';
    return 'code';
  }
  const lines = (code) => String(code || '').replace(/\n+$/, '').split('\n').length;
  // Whether a block gets the button: a whole HTML/SVG document always, other code when it is long.
  function worthOpening(lang, code) {
    const text = String(code || '');
    if (!text.trim()) return false;
    const kind = kindOf(lang, text);
    if (kind === 'svg') return /<svg[\s>]/i.test(text);
    if (kind === 'html') return /<!doctype html|<html[\s>]|<body[\s>]|<script[\s>]|<style[\s>]/i.test(text) || lines(text) >= 8;
    return lines(text) >= LARGE_LINES || text.length >= LARGE_CHARS;
  }
  const previewable = (kind) => kind === 'html' || kind === 'svg';
  // The CSP every preview document carries, put in front of the AI's markup as well as in the frame page.
  const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";
  // The document the sandboxed frame shows. An SVG is wrapped so a bare <svg> fills the panel.
  function frameDocument(kind, code) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;
    const text = String(code || '').slice(0, PREVIEW_MAX);
    if (kind === 'svg') return `<!doctype html>${meta}<meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}svg{max-width:100%;max-height:100%}</style>${text.replace(/^\s*<\?xml[^>]*>/, '')}`;
    return `${meta}${text}`;
  }
  const fileName = (lang, kind) => `canvas.${kind === 'html' ? 'html' : kind === 'svg' ? 'svg' : EXT[String(lang || '').toLowerCase()] || 'txt'}`;

  const api = { kindOf, worthOpening, previewable, frameDocument, fileName, FRAME_CSP, LARGE_LINES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  // ---- the panel (the page only)
  const main = document.querySelector('.cp-main');
  if (!main) { root.chatCanvas = { decorate() {} }; return; }
  const say = (key, fallback) => { const v = root.t ? root.t(key) : key; return v === key ? fallback : v; };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  let panel = null;
  let state = null; // { lang, kind, code, tab }

  function build() {
    const title = el('span', { className: 'cv-title' });
    const tabCode = el('button', { type: 'button', className: 'cv-tab', role: 'tab', textContent: say('canvas.code', 'Code') });
    const tabPreview = el('button', { type: 'button', className: 'cv-tab', role: 'tab', textContent: say('canvas.preview', 'Preview') });
    const tabs = el('div', { className: 'cv-tabs', role: 'tablist' }, tabCode, tabPreview);
    const copy = el('button', { type: 'button', className: 'cv-btn', textContent: say('chat.copyCode', 'Copy') });
    const download = el('button', { type: 'button', className: 'cv-btn', textContent: say('canvas.download', 'Download') });
    const close = el('button', { type: 'button', className: 'cv-btn cv-close', textContent: '×', title: say('canvas.close', 'Close canvas'), 'aria-label': say('canvas.close', 'Close canvas') });
    const head = el('div', { className: 'cv-head' }, title, tabs, el('span', { className: 'cv-spacer' }), copy, download, close);
    const codeEl = el('code');
    const codeView = el('pre', { className: 'cv-code', tabIndex: 0 }, codeEl);
    const previewBox = el('div', { className: 'cv-preview' });
    const grip = el('div', { className: 'cv-grip', role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-label': say('canvas.resize', 'Resize canvas') });
    const aside = el('aside', { id: 'canvas', className: 'cv', hidden: true, 'aria-label': say('canvas.label', 'Canvas') }, grip, head, codeView, previewBox);
    main.append(aside);

    const setWidth = (px) => {
      const w = Math.max(320, Math.min(px, Math.max(320, main.clientWidth - 360)));
      aside.style.width = `${w}px`;
      grip.setAttribute('aria-valuenow', String(Math.round(w)));
      try { localStorage.setItem('lumen.canvasWidth', String(Math.round(w))); } catch { /* storage blocked */ }
    };
    let saved = 0;
    try { saved = Number(localStorage.getItem('lumen.canvasWidth')) || 0; } catch { /* storage blocked */ }
    aside.style.width = `${saved >= 320 ? saved : 520}px`;
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

    tabCode.addEventListener('click', () => show('code'));
    tabPreview.addEventListener('click', () => show('preview'));
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
    close.addEventListener('click', () => closePanel());
    aside.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(true); } });
    return { aside, title, tabCode, tabPreview, tabs, codeEl, codeView, previewBox };
  }

  let lastOpener = null;
  function show(tab) {
    state.tab = tab;
    const isPreview = tab === 'preview' && previewable(state.kind);
    panel.codeView.hidden = isPreview;
    panel.previewBox.hidden = !isPreview;
    for (const [btn, on] of [[panel.tabCode, !isPreview], [panel.tabPreview, isPreview]]) { btn.setAttribute('aria-selected', String(on)); btn.classList.toggle('active', on); }
    if (isPreview) drawPreview(); else panel.previewBox.replaceChildren(); // leaving Preview ends the page's scripts
  }
  function drawPreview() {
    const frame = el('iframe', { className: 'cv-frame', title: say('canvas.previewTitle', 'Preview') });
    // allow-scripts only: no allow-same-origin (so an opaque origin, cut off from this page and its preload), no popups, forms,
    // top navigation, downloads or modals. allow="" refuses camera, microphone, location and the rest.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const html = frameDocument(state.kind, state.code);
    frame.addEventListener('load', () => { try { frame.contentWindow.postMessage({ lumenCanvas: html }, '*'); } catch { /* frame gone */ } });
    frame.src = 'canvas-frame.html';
    panel.previewBox.replaceChildren(frame);
  }
  function open({ lang, code, opener }) {
    panel ||= build();
    lastOpener = opener || null;
    const kind = kindOf(lang, code);
    state = { lang: String(lang || ''), kind, code: String(code || ''), tab: 'code' };
    panel.title.textContent = kind === 'html' ? 'HTML' : kind === 'svg' ? 'SVG' : (state.lang || say('chat.code', 'Code'));
    panel.codeEl.textContent = state.code;
    panel.codeEl.removeAttribute('data-hl');
    try { root.highlightCode?.(panel.codeEl, kind === 'code' ? state.lang : 'html'); } catch { /* plain text is fine */ }
    panel.tabs.hidden = !previewable(kind);
    panel.aside.hidden = false;
    document.body.classList.add('canvas-open');
    show(previewable(kind) ? 'preview' : 'code');
    panel.aside.querySelector('.cv-tab.active, .cv-btn')?.focus();
  }
  function closePanel(restoreFocus) {
    if (!panel) return;
    panel.aside.hidden = true;
    panel.previewBox.replaceChildren();
    document.body.classList.remove('canvas-open');
    if (restoreFocus && lastOpener?.isConnected) lastOpener.focus();
  }

  // Called by chat-core.js for each code block: `head` is its header row, `copyBtn` the Copy button in it.
  function decorate(pre, head, copyBtn) {
    const code = pre.querySelector('code')?.textContent ?? pre.textContent;
    if (!worthOpening(pre.dataset.lang, code)) return;
    const b = el('button', { type: 'button', className: 'code-copy code-canvas', textContent: say('canvas.open', 'Open in canvas') });
    b.addEventListener('click', () => open({ lang: pre.dataset.lang, code: pre.querySelector('code')?.textContent ?? pre.textContent, opener: b }));
    copyBtn.before(b);
  }
  root.chatCanvas = { decorate, open, close: closePanel };
})(typeof window !== 'undefined' ? window : globalThis);
