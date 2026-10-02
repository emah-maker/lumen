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
  async function doCopy(pic, host) {
    const ok = await Promise.resolve().then(() => api().copy(pic.id)).catch(() => false);
    say(host, ok ? tr('genimg.copied') : tr('genimg.copyFailed'));
  }

  // ---- enlarge: a layer over the chat (the sidebar's or the page's own)
  function enlarge(pic, url, opener) {
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

  // pic: { id, alt }
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
      open.onclick = () => enlarge(pic, url, open);
      open.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(pic, fig, e.clientX, e.clientY); });
      const bar = el('div', { className: 'gen-img-bar' }, button(tr('genimg.save'), () => doSave(pic, fig)), button(tr('genimg.copy'), () => doCopy(pic, fig)));
      fig.replaceChildren(open, bar);
    };
    const start = () => load(pic.id).then((url) => (url ? show(url) : fail()));
    start();
    return fig;
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
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      const pic = { id: '', alt: img.alt };
      const open = () => enlarge(pic, img.src, img);
      img.addEventListener('click', open);
      img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    }
  }

  window.genImages = { figure, decorate, load };
})();
