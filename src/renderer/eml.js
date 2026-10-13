// The email viewer page (features/eml-viewer.js). The main process calls window.lumenEml(data) with the parsed email (plain JSON).
// The email is untrusted: headers and the attachment list are drawn with textContent; the body is sanitized (allowlist of tags and
// attributes, no scripts, forms, frames, no remote or javascript: addresses) and shown in an iframe whose sandbox lacks allow-scripts,
// under its own CSP. Remote pictures stay out until "Load remote images"; links open in a new tab; attachments are never run.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const host = window.lumenEmlHost || null;

  const TAGS = new Set('a abbr acronym address b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strike strong style sub summary sup table tbody td tfoot th thead tr tt u ul var wbr'.split(' '));
  const DROP = new Set('script noscript template iframe frame frameset object embed applet svg math audio video source track canvas link meta base title head form select textarea option optgroup button input datalist dialog portal'.split(' ')); // dropped with their content
  const ATTRS = new Set('abbr align alt bgcolor border cellpadding cellspacing class color colspan dir face height href hspace lang nowrap rowspan size span src style title valign vspace width background'.split(' '));
  const IMG_DATA = /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i;
  const MAIL_CSP = (remote) => `default-src 'none'; style-src 'unsafe-inline'; img-src data:${remote ? ' http: https:' : ''}; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'`;

  // The style attribute / sheet: no script hooks, no @import, no remote url() unless remote pictures are on.
  function cleanCss(css, remote, state) {
    let s = String(css).replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;?/gi, '').replace(/expression\s*\(|javascript:|-moz-binding|behavior\s*:/gi, '');
    s = s.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (m, q, u) => {
      if (/^data:image\//i.test(u.trim())) return m;
      if (/^https?:/i.test(u.trim())) { state.remote++; return remote ? m : 'none'; }
      return 'none';
    });
    return s;
  }

  // The body as safe HTML text for the iframe's srcdoc. state.remote counts the remote pictures met (loaded or held back).
  function sanitize(html, images, remote, state) {
    const doc = new DOMParser().parseFromString(String(html), 'text/html'); // inert: nothing runs, nothing loads
    const clean = (parent) => {
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === 3) continue;
        if (node.nodeType !== 1) { node.remove(); continue; }
        const tag = node.localName;
        if (DROP.has(tag)) { node.remove(); continue; }
        if (!TAGS.has(tag)) { clean(node); while (node.firstChild) parent.insertBefore(node.firstChild, node); node.remove(); continue; } // an unknown tag: its content stays
        if (tag === 'style') { node.textContent = cleanCss(node.textContent, remote, state); continue; }
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          if (!ATTRS.has(name) || name.startsWith('on')) { node.removeAttribute(attr.name); continue; }
          const value = attr.value;
          if (name === 'style') node.setAttribute('style', cleanCss(value, remote, state));
          else if (name === 'href') {
            if (tag === 'a' && /^https?:\/\//i.test(value.trim())) node.setAttribute('href', value.trim()); else node.removeAttribute('href');
          } else if (name === 'src' || name === 'background') {
            if (name === 'background' && tag !== 'td' && tag !== 'table' && tag !== 'tr' && tag !== 'th') { node.removeAttribute(attr.name); continue; }
            if (name === 'src' && tag !== 'img') { node.removeAttribute(attr.name); continue; }
            const v = value.trim();
            const cid = /^cid:(.*)$/i.exec(v);
            if (cid && Object.prototype.hasOwnProperty.call(images, cid[1].replace(/^<|>$/g, ''))) node.setAttribute(name, images[cid[1].replace(/^<|>$/g, '')]);
            else if (IMG_DATA.test(v)) node.setAttribute(name, v);
            else if (/^https?:\/\//i.test(v)) { state.remote++; if (remote) node.setAttribute(name, v); else node.removeAttribute(name); }
            else node.removeAttribute(name);
          }
        }
        if (tag === 'a') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer nofollow'); if (node.hasAttribute('href')) node.setAttribute('title', node.getAttribute('href')); }
        if (tag === 'img') { node.setAttribute('referrerpolicy', 'no-referrer'); node.setAttribute('loading', 'eager'); node.removeAttribute('srcset'); }
        clean(node);
      }
    };
    clean(doc.body);
    return doc.body.innerHTML;
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const SHEET = 'body{margin:0;padding:16px;font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;color:#1d1d1f;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#0062cc}pre.plain{white-space:pre-wrap;font:inherit;margin:0}table{max-width:100%}blockquote{margin:0 0 0 8px;padding-left:12px;border-left:3px solid #d2d2d7}';
  const srcdoc = (inner, remote) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_CSP(remote)}"><meta name="referrer" content="no-referrer"><style>${SHEET}</style></head><body>${inner}</body></html>`;

  function bytesText(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

  function save(a) {
    if (!host) return;
    host.bytes(a.index).then((buf) => {
      if (!buf) return;
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' })); // never typed as something the browser would render or run
      const link = el('a'); link.href = url; link.download = a.name; link.rel = 'noopener';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }).catch(() => {});
  }

  function show(data) {
    document.title = data.error ? data.name || 'Email' : data.subject || '(no subject)';
    $('name').textContent = data.name || '';
    if (data.error) {
      for (const id of ['head', 'remote', 'attachments', 'body']) $(id).hidden = true;
      const m = $('message'); m.hidden = false; m.textContent = '';
      m.append(el('strong', '', 'This email could not be opened'), document.createTextNode(data.error));
      return;
    }
    $('message').hidden = true;
    $('body').hidden = false;
    $('head').hidden = false;
    $('subject').textContent = data.subject || '(no subject)';
    const fields = $('fields'); fields.textContent = '';
    const row = (label, value) => { if (!value || (Array.isArray(value) && !value.length)) return; fields.append(el('dt', '', label), el('dd', '', Array.isArray(value) ? value.join(', ') : value)); };
    let when = data.date;
    try { const d = new Date(data.date); if (!Number.isNaN(d.getTime())) when = d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }); } catch { /* keep the raw text */ }
    row('From', data.from); row('To', data.to); row('Cc', data.cc); row('Date', when);

    const list = $('att-list'); list.textContent = '';
    const atts = data.attachments || [];
    $('attachments').hidden = !atts.length;
    $('att-title').textContent = `Attachments (${atts.length})`;
    for (const a of atts) {
      const li = el('li');
      li.append(el('span', 'att-name', a.name), el('span', 'att-size', bytesText(a.size)));
      const saveBtn = el('button', '', 'Save'); saveBtn.type = 'button'; saveBtn.dataset.action = 'save'; saveBtn.addEventListener('click', () => save(a));
      const openBtn = el('button', '', 'Open'); openBtn.type = 'button'; openBtn.dataset.action = 'open';
      openBtn.disabled = !a.openable; openBtn.title = a.openable ? 'Open in a new tab' : 'This type of file is never opened from here; save it instead';
      openBtn.addEventListener('click', () => { if (host && a.openable) host.open(a.index); });
      li.append(openBtn, saveBtn);
      list.append(li);
    }

    let remote = false;
    const draw = () => {
      const state = { remote: 0 };
      const inner = data.html ? sanitize(data.html, data.images || {}, remote, state) : `<pre class="plain">${esc(data.text || '(no text in this email)')}</pre>`;
      // A fresh iframe each time: setting srcdoc on one already in the page is a navigation that lands in Back/Forward history (and cuts off Forward).
      const frame = document.createElement('iframe');
      frame.id = 'frame'; frame.title = 'Message body';
      frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox'); // no allow-scripts, no allow-same-origin, no allow-forms
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.srcdoc = srcdoc(inner, remote);
      $('body').replaceChildren(frame);
      $('remote').hidden = !(state.remote && !remote);
      $('remote-text').textContent = `Remote images are blocked (${state.remote}). Senders can use them to see that you opened the email.`;
    };
    $('load-remote').onclick = () => { remote = true; draw(); };
    draw();
  }

  window.lumenEml = show;
})();
