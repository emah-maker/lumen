// Reader mode (features/page-tools.js): the main process calls lumenRender once with the article
// Readability pulled out of the page. That HTML comes from the web, so it's parsed inertly and
// only plain content survives: no scripts, frames, forms, styles or event handlers, and links and
// images only with http(s) addresses (data: images too). The page's CSP backs this up.
const DROP = new Set(['SCRIPT', 'NOSCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'TEMPLATE', 'SLOT', 'PORTAL', 'DIALOG']);
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'poster', 'cite', 'longdesc']);
const KEEP_ATTRS = new Set(['href', 'src', 'srcset', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'lang', 'dir', 'datetime', 'poster', 'controls', 'start', 'reversed', 'type']);

const webUrl = (value) => /^https?:\/\//i.test(value.trim());
const safeUrl = (name, value, tag) => {
  if (name === 'srcset') return value.split(',').every((part) => webUrl(part.trim().split(/\s+/)[0] || ''));
  if (name === 'src' && tag === 'IMG' && /^data:image\/(png|gif|jpe?g|webp|avif);/i.test(value.trim())) return true;
  return webUrl(value);
};

function clean(root) {
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected) continue;
    const tag = el.tagName.toUpperCase();
    if (DROP.has(tag) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') { el.remove(); continue; }
    for (const { name } of [...el.attributes]) {
      const lower = name.toLowerCase();
      const value = el.getAttribute(name);
      if (!KEEP_ATTRS.has(lower) || (URL_ATTRS.has(lower) && !safeUrl(lower, value, tag))) el.removeAttribute(name);
    }
    if (tag === 'A' && el.hasAttribute('href')) el.setAttribute('rel', 'noreferrer');
  }
  return root;
}

window.lumenRender = (data) => {
  document.title = data.title || 'Reader';
  if (data.lang) document.documentElement.lang = data.lang;
  let site = data.siteName || '';
  try { site = site || new URL(data.url).hostname.replace(/^www\./, ''); } catch {}
  document.getElementById('site').textContent = site;
  document.getElementById('title').textContent = data.title || '';
  document.getElementById('byline').textContent = data.byline || '';
  const article = document.getElementById('article');
  if (data.dir === 'rtl' || data.dir === 'ltr') article.dir = data.dir;
  const parsed = new DOMParser().parseFromString(`<body>${data.content || ''}</body>`, 'text/html');
  article.replaceChildren(...clean(parsed.body).childNodes);
  document.body.dataset.ready = 'true';
};
