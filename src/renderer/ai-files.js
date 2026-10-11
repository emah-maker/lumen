// Files the AI made (main: features/ai-files.js), drawn in the reply as a card:
//   window.aiFiles.card(file, { live })   file: { id, name, dir, path, ext, kind, size, trusted, previewable, canTab, canSystem } (a card main sent)
//   window.aiFiles.autoOpen(file, card)    the reply's main file, opened for the user: a page or SVG in the canvas (full-page chat), a PDF in a new background tab
//
// The card shows the icon, name and folder with Open, Show in folder and Copy path. A page or SVG the AI wrote gets a live preview (inline in
// the sidebar, "Open in canvas" on the full-page chat); a picture gets a thumbnail; a PDF opens in Lumen's viewer. Lumen is the browser, so the
// AI never needs to say "open it in a browser".
//
// The preview is the AI's own code, so it is treated as hostile: it runs in <iframe sandbox="allow-scripts"> (an opaque origin: no way into this
// page, its preload or any IPC) showing canvas-frame.html, whose Content-Security-Policy allows no network (see chat-canvas.js). The page and the
// picture come from main by the card's id, only for a file the AI wrote in this chat; a file a reply merely named gets no preview, and Open
// asks first. Nothing here builds markup from the file's name or text: it is all textContent.
(() => {
  const tr = (key, vars) => window.t(key, vars);
  const api = () => window.assistant?.files;
  const IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const button = (label, onclick, className = 'ai-file-btn') => { const b = el('button', { type: 'button', className, textContent: label }); b.onclick = onclick; return b; };
  const canvasOpen = () => typeof window.chatCanvas?.open === 'function'; // only the full-page chat has a canvas

  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  function say(host, text, sticky = false) {
    const status = host.querySelector(':scope > .ai-file-status');
    if (!status) return;
    clearTimeout(status.timer);
    status.textContent = text;
    if (text && !sticky) status.timer = setTimeout(() => { status.textContent = ''; }, 4000);
  }
  const preview = (file) => Promise.resolve().then(() => api().preview(file.id)).catch(() => null);

  // The sandboxed live preview of a page or SVG, written into the frame by postMessage (as the canvas does).
  function liveFrame(file, text) {
    const frame = el('iframe', { className: 'ai-file-frame', title: tr('aifile.previewOf', { name: file.name }) });
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const html = window.chatCanvas.frameDocument(file.kind, text);
    frame.addEventListener('load', () => { try { frame.contentWindow.postMessage({ lumenCanvas: html }, '*'); } catch { /* frame gone */ } });
    frame.src = 'canvas-frame.html';
    return frame;
  }

  async function openIn(file, host, how) {
    const go = async (confirmed) => {
      const r = await Promise.resolve().then(() => api().open(file.id, how, confirmed ? { confirmed: true } : undefined)).catch(() => null);
      if (r?.ok) { say(host, how === 'tab' || how === 'background' ? tr('aifile.openedTab') : ''); return; }
      if (r?.reason === 'confirm') { askFirst(file, host, () => go(true)); return; }
      say(host, tr(r?.reason === 'gone' ? 'aifile.gone' : r?.reason === 'blocked' ? 'aifile.blocked' : 'aifile.failed'));
    };
    return go(false);
  }
  // A file the AI did not make in this chat: the user says yes once, here, before it opens.
  function askFirst(file, host, then) {
    host.querySelector(':scope > .ai-file-ask')?.remove();
    const row = el('div', { className: 'ai-file-ask', role: 'alert' }, el('span', { textContent: tr('aifile.askOpen', { name: file.name }) }));
    row.append(button(tr('aifile.askYes'), () => { row.remove(); then(); }), button(tr('aifile.askNo'), () => row.remove()));
    host.querySelector(':scope > .ai-file-bar').after(row);
    row.querySelector('button').focus();
  }

  function card(file, { live = false } = {}) {
    const host = el('div', { className: `ai-file ai-file-${file.kind}${file.trusted ? '' : ' ai-file-named'}` });
    host.dataset.id = file.id;
    const icon = el('span', { className: 'ai-file-icon', textContent: (file.ext || 'file').slice(0, 4).toUpperCase(), 'aria-hidden': 'true' });
    const meta = el('span', { className: 'ai-file-meta' }, el('span', { className: 'ai-file-name', textContent: file.name, title: file.path }), el('span', { className: 'ai-file-dir', textContent: `${file.dir} · ${sizeText(file.size || 0)}`, title: file.dir }));
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', tr('aifile.label', { name: file.name }));
    const body = el('div', { className: 'ai-file-body' });
    const bar = el('div', { className: 'ai-file-bar' });
    const status = el('div', { className: 'ai-file-status' });
    status.setAttribute('role', 'status');
    host.append(el('div', { className: 'ai-file-head' }, icon, meta), body, bar, status);

    const viewable = file.kind === 'html' || file.kind === 'svg';
    // Buttons: the file's own way first.
    if (viewable && file.previewable && canvasOpen()) bar.append(button(tr('aifile.openCanvas'), async () => {
      const got = await preview(file);
      if (got?.text) window.chatCanvas.open({ lang: file.kind, code: got.text, opener: host.querySelector('.ai-file-btn') });
      else say(host, tr('aifile.gone'));
    }, 'ai-file-btn ai-file-primary'));
    if (file.canTab) bar.append(button(viewable ? tr('aifile.openTab') : tr('aifile.open'), () => openIn(file, host, 'tab'), `ai-file-btn${bar.children.length ? '' : ' ai-file-primary'}`));
    else if (file.canSystem) bar.append(button(tr('aifile.openApp'), () => openIn(file, host, 'system'), 'ai-file-btn ai-file-primary'));
    if (file.canTab && file.canSystem && !viewable && file.kind !== 'image' && file.kind !== 'pdf') bar.append(button(tr('aifile.openApp'), () => openIn(file, host, 'system')));
    bar.append(button(tr('aifile.reveal'), () => openIn(file, host, 'reveal')));
    bar.append(button(tr('aifile.copyPath'), async () => {
      let ok = true;
      try { await navigator.clipboard.writeText(file.path); } catch { ok = false; }
      say(host, tr(ok ? 'aifile.copied' : 'aifile.copyFailed'));
    }));

    // The preview: a trusted page or SVG (live in the sidebar, behind a button elsewhere), a trusted picture (a thumbnail, loaded when seen).
    if (file.trusted && file.previewable && viewable && !canvasOpen()) {
      const show = async () => {
        const got = await preview(file);
        if (!got?.text) { body.replaceChildren(el('div', { className: 'ai-file-note', textContent: tr('aifile.gone') })); return; }
        body.replaceChildren(liveFrame(file, got.text));
      };
      if (live) show();
      else {
        const b = button(tr('aifile.showPreview'), () => { b.remove(); show(); });
        body.append(b);
      }
    } else if (file.trusted && file.previewable && file.kind === 'image') {
      const load = async () => {
        const got = await preview(file);
        if (got?.dataUrl && IMAGE.test(got.dataUrl)) body.replaceChildren(el('img', { className: 'ai-file-thumb', src: got.dataUrl, alt: file.name, decoding: 'async' }));
      };
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); } });
        io.observe(host);
      } else load();
    }
    return host;
  }

  // The reply's main file, opened for the user. Returns 'canvas' | 'tab' | '' for what it did.
  async function autoOpen(file, host) {
    if (!file?.trusted) return '';
    if (file.kind === 'html' || file.kind === 'svg') {
      if (!canvasOpen() || !file.previewable) return ''; // the sidebar already shows the live preview inside the card
      const got = await preview(file);
      if (!got?.text) return '';
      window.chatCanvas.open({ lang: file.kind, code: got.text, opener: null, quiet: true });
      if (host) say(host, tr('aifile.inCanvas'), true);
      return 'canvas';
    }
    if (file.kind === 'pdf') {
      const r = await Promise.resolve().then(() => api().open(file.id, 'background', { auto: true })).catch(() => null);
      if (r?.ok && host) say(host, tr('aifile.openedTab'), true);
      return r?.ok ? 'tab' : '';
    }
    return '';
  }

  window.aiFiles = { card, autoOpen };
})();
