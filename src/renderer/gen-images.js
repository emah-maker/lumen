// Pictures in the chat that the AI made or returned (main saves them: features/gen-images.js), drawn in the reply:
//   window.genImages.figure({ id, alt })  a <figure>: a "loading" line, then the picture (fit to the bubble) with Save and
//                                         Copy; click (or Enter) to enlarge; right-click for the same actions; an error
//                                         line with Try again when it can't be loaded
//   window.genImages.decorate(root)       turns ![alt](https://…) the markdown renderer left as placeholders into a
//                                         "Show picture" button: web pictures load only when the user asks (the address
//                                         could carry a tracker or a leak), through main: https, no cookies, a real image
// Only data URLs of PNG, JPEG, GIF or WebP that main sends are ever put in an <img>; nothing here builds markup from
// text, and no remote address is ever an <img> source. (The page's CSP is the second wall.)
(() => {
  const tr = (key, vars) => window.t(key, vars);
  const OK = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const api = () => window.assistant?.images;
  const cache = new Map(); // id -> Promise<data URL | null>

  function load(id) {
    let p = cache.get(id);
    if (!p) {
      p = Promise.resolve().then(() => api().data(id)).then((url) => (typeof url === 'string' && OK.test(url) ? url : null)).catch(() => null);
      cache.set(id, p);
      p.then((url) => { if (!url) cache.delete(id); }); // a failure is tried again next time
    }
    return p;
  }

  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
  };
  const button = (label, onclick, className = 'gen-img-btn') => {
    const b = el('button', { type: 'button', className, textContent: label });
    b.onclick = onclick;
    return b;
  };

  // A passing line under a picture ("Saved", "Couldn't copy"), read out politely.
  function say(host, text) {
    let status = host.querySelector(':scope > .gen-img-status');
    if (!status) { status = el('div', { className: 'gen-img-status' }); status.setAttribute('role', 'status'); host.append(status); }
    clearTimeout(status.timer);
    status.textContent = text;
    status.timer = setTimeout(() => { status.textContent = ''; }, 2600);
  }

  async function doSave(pic, host) {
    const r = await Promise.resolve().then(() => api().save(pic.id)).catch(() => null);
    if (r?.ok) say(host, tr('genimg.saved'));
    else if (r?.reason !== 'canceled') say(host, tr('genimg.saveFailed'));
  }
  async function doNote(pic, host) {
    const r = await Promise.resolve().then(() => window.assistant.notes.act('add-image', { id: pic.id, alt: pic.alt })).catch(() => null);
    say(host, tr(r?.ok ? 'notes.added' : 'notes.addFailed'));
  }
  async function doCopy(pic, host) {
    const ok = await Promise.resolve().then(() => api().copy(pic.id)).catch(() => false);
    say(host, ok ? tr('genimg.copied') : tr('genimg.copyFailed'));
  }

  // ---- enlarge: the viewer (chat-image-viewer.js: zoom, pan, step through the chat's pictures, Save / Copy / Open in a tab).
  // Its code and styles load on the first click, as the Meeting helper's do (meeting-loader.js); if they can't, the plain layer below opens.
  let viewerLoading = null;
  const loadViewer = () => {
    if (window.chatImageViewer) return Promise.resolve();
    return viewerLoading || (viewerLoading = new Promise((resolve, reject) => {
      const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'chat-image-viewer.css' });
      document.head.appendChild(css);
      const script = Object.assign(document.createElement('script'), { src: 'chat-image-viewer.js' });
      script.onload = resolve;
      script.onerror = () => { viewerLoading = null; script.remove(); css.remove(); reject(new Error('chat-image-viewer.js did not load')); };
      document.body.appendChild(script);
    }));
  };
  // Every picture in this conversation, in order: the AI's (and web pictures shown on request), Markdown data pictures, and ones the user sent.
  const PICS = '.gen-img-open, img.md-img-ready, .msg-images img';
  function galleryAround(opener, pic, url) {
    const scope = (opener?.closest?.('.messages')) || document.querySelector('[data-chat-root] .messages') || document;
    const items = [];
    let index = -1;
    for (const node of scope.querySelectorAll(PICS)) {
      const im = node.tagName === 'IMG' ? node : node.querySelector('img');
      const src = im?.currentSrc || im?.src || '';
      if (!OK.test(src)) continue;
      if (node === opener) index = items.length;
      items.push({ url: src, alt: im.alt || '', id: node.closest('.gen-img')?.dataset.id || '' });
    }
    if (index < 0) { items.push({ url, alt: pic.alt || '', id: pic.id || '' }); index = items.length - 1; }
    return { items, index };
  }
  function enlarge(pic, url, opener) {
    const { items, index } = galleryAround(opener, pic, url);
    loadViewer().then(() => { if (!window.chatImageViewer.open({ items, index, opener })) enlargeBasic(pic, url, opener); }).catch(() => enlargeBasic(pic, url, opener));
  }
  // A picture the user sent: click (or Enter) to open it too.
  function zoomable(img) {
    if (!img || img.dataset.zoomable) return;
    img.dataset.zoomable = '1';
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.title = tr('imgview.hint');
    const open = () => enlarge({ id: '', alt: img.alt }, img.src, img);
    img.addEventListener('click', open);
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }

  // A picture opened in a chat belongs to that chat: leaving it (clearChatView) closes the viewer, or the plain layer, over it.
  function closeAll() {
    window.chatImageViewer?.closeAll?.();
    for (const box of document.querySelectorAll('.gen-lightbox')) box.querySelector('.gen-lightbox-close')?.click();
  }

  function enlargeBasic(pic, url, opener) {
    const root = document.querySelector('[data-chat-root]') || document.body;
    const box = el('div', { className: 'gen-lightbox' });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', pic.alt || tr('genimg.alt'));
    const img = el('img', { src: url, alt: pic.alt || tr('genimg.alt') });
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); opener?.focus?.(); };
    const closeBtn = button(tr('genimg.close'), close, 'gen-img-btn gen-lightbox-close');
    const bar = el('div', { className: 'gen-lightbox-bar' }, ...(pic.id ? [button(tr('genimg.save'), () => doSave(pic, box)), button(tr('genimg.copy'), () => doCopy(pic, box))] : []), closeBtn);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const stops = [...box.querySelectorAll('button')];
      const at = stops.indexOf(document.activeElement);
      e.preventDefault();
      stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
    };
    box.addEventListener('click', (e) => { if (e.target === box) close(); });
    box.append(img, bar);
    root.append(box);
    document.addEventListener('keydown', onKey, true);
    closeBtn.focus();
  }

  // ---- right-click: the same actions as the buttons
  function menu(pic, host, x, y) {
    document.querySelector('.gen-menu')?.remove();
    const m = el('div', { className: 'gen-menu' });
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', tr('genimg.menu'));
    const done = () => { m.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); };
    const item = (label, fn) => {
      const b = el('button', { type: 'button', className: 'gen-menu-item', textContent: label });
      b.setAttribute('role', 'menuitem');
      b.onclick = () => { done(); fn(); };
      return b;
    };
    const away = (e) => { if (!m.contains(e.target)) done(); };
    const key = (e) => {
      const items = [...m.querySelectorAll('button')];
      const at = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); done(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
      else if (e.key === 'Tab') done();
    };
    m.append(item(tr('genimg.saveImage'), () => doSave(pic, host)), item(tr('genimg.copyImage'), () => doCopy(pic, host)));
    const root = document.querySelector('[data-chat-root]') || document.body;
    root.append(m);
    const box = root.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(x - box.left, box.width - m.offsetWidth - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(y - box.top, box.height - m.offsetHeight - 4))}px`;
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    m.querySelector('button').focus();
  }

  // pic: { id, alt, credit? }
  function figure(pic) {
    const fig = el('figure', { className: 'gen-img' });
    fig.dataset.id = pic.id;
    fig.setAttribute('aria-busy', 'true');
    const wait = el('div', { className: 'gen-img-wait', textContent: tr('genimg.loading') });
    wait.setAttribute('role', 'status');
    fig.append(wait);

    const fail = () => {
      fig.removeAttribute('aria-busy');
      const note = el('div', { className: 'gen-img-error' }, el('span', { textContent: tr('genimg.error') }), button(tr('genimg.retry'), () => { fig.replaceChildren(wait); fig.setAttribute('aria-busy', 'true'); start(); }));
      note.setAttribute('role', 'alert');
      fig.replaceChildren(note);
    };
    const show = (url) => {
      fig.removeAttribute('aria-busy');
      const img = el('img', { alt: pic.alt || tr('genimg.alt'), decoding: 'async' });
      img.onerror = fail;
      img.src = url;
      const open = el('button', { type: 'button', className: 'gen-img-open' }, img);
      open.setAttribute('aria-label', `${tr('genimg.enlarge')}: ${pic.alt || tr('genimg.alt')}`);
      open.dataset.hint = tr('imgview.hint');
      open.onclick = () => enlarge(pic, url, open);
      open.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(pic, fig, e.clientX, e.clientY); });
      const bar = el('div', { className: 'gen-img-bar' }, button(tr('genimg.save'), () => doSave(pic, fig)), button(tr('genimg.copy'), () => doCopy(pic, fig)), ...(window.assistant?.notes && pic.id ? [button(tr('notes.add'), () => doNote(pic, fig))] : []));
      // [image card] Open full size, and for a picture a provider made (its alt is the prompt): Try again, Variation, Edit, which put the ask in the message box
      const prompt = madeByProvider(pic) ? String(pic.alt || '').trim() : '';
      const acts = el('div', { className: 'gen-img-acts' }, button(tr('genimg.open'), () => enlarge(pic, url, open)), ...(prompt && window.chatAskText ? [
        button(tr('genimg.retry'), () => window.chatAskText(tr('genimg.againAsk', { prompt }), { send: true })),
        button(tr('genimg.variation'), () => window.chatAskText(tr('genimg.variationAsk', { prompt }), { send: true })),
        button(tr('genimg.edit'), () => window.chatAskText(tr('genimg.editAsk', { prompt: prompt.slice(0, 80) }))),
      ] : []));
      // [image routing] which provider made it (the user's own keys or plan, so it is always said)
      // a picture taken from a file the AI made: its file name
      const caption = pic.caption ? [el('div', { className: 'gen-img-credit gen-img-caption', textContent: String(pic.caption).slice(0, 120) })] : [];
      const said = prompt ? [el('div', { className: 'gen-img-prompt', textContent: prompt, title: prompt })] : [];
      fig.replaceChildren(open, el('div', { className: 'gen-img-foot' }, bar, acts), ...said, ...(pic.credit ? [el('div', { className: 'gen-img-credit', textContent: tr('genimg.madeWith', { name: String(pic.credit).slice(0, 80) }) })] : []), ...caption);
    };
    const start = () => load(pic.id).then((url) => (url ? show(url) : fail()));
    start();
    return fig;
  }

  // A picture an image provider made from a prompt (not one found on the web, drawn from SVG or marked on a screenshot by Lumen).
  const madeByProvider = (pic) => Boolean(pic.credit) && !/^(From |Lumen\b|Drawn by Lumen)/.test(String(pic.credit));

  // ---- [image card] the picture being made: main's status events carry { state, provider, prompt, message } (agent.js generateImageTool).
  // making: a card with who is making it and the seconds so far; done: "Almost there" until the picture takes its place (chat-core.js);
  // failed: what went wrong, with Try again. -> the card, which chat-core keeps on the turn
  function progress(card, image, place) {
    if (!image || typeof image !== 'object') return card;
    if (card?.classList.contains('gen-img-failed')) card = null; // a new try gets a new card
    if (!card) {
      if (image.state !== 'making' && image.state !== 'failed') return null;
      const line = el('div', { className: 'gen-img-wait-line' });
      const secs = el('span', { className: 'gen-img-secs' });
      const box = el('div', { className: 'gen-img-wait gen-img-making' }, line, secs);
      box.setAttribute('role', 'status');
      const fig = el('figure', { className: 'gen-img gen-img-pending' }, box);
      fig.setAttribute('aria-busy', 'true');
      const made = el('div', { className: 'msg assistant gen-pics' }, fig);
      const t0 = Date.now();
      const tick = setInterval(() => { if (!made.isConnected) { clearInterval(tick); return; } const n = Math.round((Date.now() - t0) / 1000); if (n >= 3) secs.textContent = tr('genimg.seconds', { n }); }, 1000); // (stops once the picture takes its place)
      made.stop = () => clearInterval(tick);
      place(made);
      card = made;
    }
    const fig = card.querySelector('.gen-img');
    const line = card.querySelector('.gen-img-wait-line');
    const prompt = String(image.prompt || card.dataset.prompt || '').slice(0, 300);
    if (prompt) card.dataset.prompt = prompt;
    if (image.state === 'making' && line) line.textContent = tr(image.edit ? 'genimg.editing' : 'genimg.making', { name: String(image.provider || '').slice(0, 60) || 'AI' });
    else if (image.state === 'done' && line) line.textContent = tr('genimg.finishing');
    else if (image.state === 'failed') {
      card.stop?.();
      card.classList.add('gen-img-failed');
      fig.removeAttribute('aria-busy');
      const note = el('div', { className: 'gen-img-error gen-img-error-card' }, el('strong', { textContent: tr('genimg.failedTitle') }), ...(image.message ? [el('span', { className: 'gen-img-error-why', textContent: String(image.message).slice(0, 400) })] : []));
      if (prompt && window.chatAskText) note.append(el('div', { className: 'gen-img-bar' }, button(tr('genimg.retry'), () => window.chatAskText(tr('genimg.againAsk', { prompt }), { send: true }))));
      note.setAttribute('role', 'alert');
      fig.replaceChildren(note);
    }
    return card;
  }

  // ---- web pictures a reply points at: shown only when asked for
  function remote(span) {
    const src = span.dataset.src || '';
    let host = '';
    try { const u = new URL(src); if (u.protocol === 'https:') host = u.hostname; } catch { /* below */ }
    if (!host) return;
    const alt = (span.dataset.alt || '').slice(0, 300);
    const wrap = el('span', { className: 'gen-img-remote' });
    const b = button(tr('genimg.remote', { host }), async () => {
      b.disabled = true;
      const got = await Promise.resolve().then(() => api().remote(src)).catch(() => null);
      if (got?.id) { const fig = figure({ id: got.id, alt }); wrap.replaceWith(fig); } else { b.disabled = false; say(wrap, tr('genimg.remoteFail')); }
    }, 'gen-img-btn gen-img-show');
    b.title = tr('genimg.remoteWhy');
    wrap.append(b);
    if (alt) wrap.append(el('span', { className: 'gen-img-remote-alt', textContent: alt }));
    span.replaceWith(wrap);
  }

  // The markdown renderer leaves `span.md-img-remote` for web pictures, and `img.md-img` for data URLs it checked.
  function decorate(root) {
    if (!root?.querySelectorAll || !api()) return;
    for (const span of root.querySelectorAll('span.md-img-remote[data-src]')) remote(span);
    for (const img of root.querySelectorAll('img.md-img:not(.md-img-ready)')) {
      img.classList.add('md-img-ready');
      if (!OK.test(img.getAttribute('src') || '')) { img.replaceWith(document.createTextNode(img.alt || '')); continue; }
      zoomable(img);
    }
  }

  window.genImages = { figure, decorate, load, zoomable, enlarge, closeAll, progress, madeByProvider };
})();
