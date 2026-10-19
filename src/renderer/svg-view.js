// Inline SVG in the chat: a ```svg block (or ```xml / ```html holding one <svg>, or a raw <svg> in the text, which markdown.js lifts into a
// ```svg block) is drawn as a picture, with a Code toggle for the source, Copy (the code), PNG (save it) and click-to-enlarge.
// It is not in the startup bundle: code-extras.js loads this file on the first SVG block (the way it loads Mermaid), so test/perf-budget.js's
// UI ceiling is untouched.
//
// The SVG comes from a model, and a model's reply can carry text a web page put there, so it is never trusted:
//   1. sanitize() reads the markup with its own tokenizer and WRITES A NEW SVG from an allowlist of elements and attributes (it never
//      copies the input through): no script, foreignObject, iframe, animation, external image, on* handler, javascript: or data: URL,
//      external url() or @import; <use> and every reference point only at a local #id. Size, element and depth caps apply.
//   2. The result is shown as <img src="data:image/svg+xml,…">, never inlined in the page: an SVG drawn as an image cannot run a script
//      or load anything, whatever the sanitizer missed. (A data: URL, so the chat page's CSP needs no blob: source.)
// sanitize() is pure string work, so test/svg-view-units.js runs it in Node.
(() => {
  const MAX_BYTES = 200 * 1024;
  const MAX_ELEMENTS = 3000;
  const MAX_USE = 100;
  const MAX_DEPTH = 48;
  const MAX_STYLE = 20000;

  const ELEMENTS = {};
  for (const name of ['svg', 'g', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'text', 'tspan', 'textPath', 'defs', 'marker', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc', 'use', 'clipPath', 'mask', 'pattern', 'symbol', 'style', 'image',
    'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feMerge', 'feMergeNode', 'feFlood', 'feComposite', 'feDropShadow']) ELEMENTS[name.toLowerCase()] = name;
  // An element dropped together with everything inside it (anything else that is not allowed loses its tag but keeps its children).
  const DROP_WITH_CONTENT = new Set(['script', 'foreignobject', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'animate', 'animatetransform', 'animatemotion', 'animatecolor', 'set', 'handler', 'listener', 'audio', 'video', 'canvas', 'noscript', 'template', 'textarea', 'html', 'head', 'math']);
  const TEXTY = new Set(['text', 'tspan', 'textPath', 'title', 'desc']);
  const ATTRIBUTES = {};
  for (const name of ['id', 'class', 'style', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'width', 'height', 'd', 'points', 'transform', 'viewBox', 'preserveAspectRatio', 'version',
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'stroke-miterlimit', 'fill-opacity', 'fill-rule', 'clip-rule', 'opacity', 'color', 'display', 'visibility', 'overflow', 'vector-effect', 'paint-order', 'pathLength', 'shape-rendering', 'text-rendering',
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'letter-spacing', 'word-spacing', 'text-decoration', 'writing-mode', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'startOffset', 'xml:space',
    'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'marker-start', 'marker-mid', 'marker-end', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
    'patternUnits', 'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'mask-type', 'clip-path', 'mask', 'filter', 'filterUnits', 'primitiveUnits', 'href', 'xlink:href',
    'in', 'in2', 'result', 'mode', 'type', 'values', 'stdDeviation', 'flood-color', 'flood-opacity', 'operator', 'k1', 'k2', 'k3', 'k4', 'color-interpolation-filters', 'role', 'aria-label', 'aria-hidden', 'aria-labelledby', 'aria-describedby', 'lang']) ATTRIBUTES[name.toLowerCase()] = name;

  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', deg: '°', times: '×', minus: '−', middot: '·', plusmn: '±', micro: 'µ', tau: 'τ', sigma: 'σ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', omega: 'ω', Omega: 'Ω', Delta: 'Δ', rarr: '→', larr: '←', harr: '↔', uarr: '↑', darr: '↓', hellip: '…', ndash: '–', mdash: '—', le: '≤', ge: '≥', ne: '≠', infin: '∞', radic: '√', sum: '∑' };
  const decode = (s) => s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,8}));/g, (all, dec, hex, name) => {
    if (name) return NAMED[name] ?? all;
    const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 32 && code !== 9 && code !== 10 && code !== 13)) return '';
    return String.fromCodePoint(code);
  });
  // (what is written out: XML-valid, whatever came in; an entity that is not known stays as literal text)
  const escape = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // CSS that may be written out: no @import, no escapes, no scripting hooks, and every url() a local #id.
  function safeCss(css) {
    const text = String(css);
    if (/@import|@namespace|\\|expression\s*\(|javascript:|vbscript:|behavior|binding|<|-moz-|image-set|src\s*\(/i.test(text)) return null;
    const bare = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const urls = bare.match(/url\s*\([^)]*\)?/gi) || [];
    for (const u of urls) if (!/^url\(\s*(['"]?)#[\w.:-]+\1\s*\)$/i.test(u)) return null;
    if (/@(?!media|keyframes|supports)\w/i.test(bare)) return null;
    return bare;
  }
  // An attribute value that may be written out, or null.
  function safeValue(name, value, tag) {
    const flat = value.replace(/[\s\u0000- ]+/g, '').toLowerCase();
    if (/javascript:|vbscript:|livescript:|@import|expression\(/.test(flat)) return null;
    if (name === 'href' || name === 'xlink:href') {
      if (/^#[\w.:-]+$/.test(value.trim())) return value.trim();
      if (tag === 'image' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.trim()) && value.length < 150000) return value.trim();
      return null;
    }
    if (name === 'style') return safeCss(value);
    if (/url\s*\(/i.test(value)) {
      const urls = value.match(/url\s*\([^)]*\)?/gi) || [];
      for (const u of urls) if (!/^url\(\s*(['"]?)#[\w.:-]+\1\s*\)$/i.test(u)) return null;
    }
    if (/^data:/.test(flat) || flat.includes('data:text') || flat.includes('data:image/svg')) return null;
    return value;
  }

  const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<\/?[A-Za-z][^\s/>]*(?:"[^"]*"|'[^']*'|[^>"'])*>|[^<]+|</g;
  const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

  const num = (v) => { const m = /^\s*([+-]?\d*\.?\d+(?:e[+-]?\d+)?)(?:px)?\s*$/i.exec(v || ''); return m ? parseFloat(m[1]) : null; };

  // sanitize(source) -> { svg, width, height, title } | null (not one complete, small-enough <svg>).
  function sanitize(source) {
    const src = String(source ?? '');
    if (!src.trim() || src.length > MAX_BYTES) return null;
    const out = [];
    const stack = []; // { name, kept }
    let skip = null; // { name, depth }: inside an element that goes with its content
    let started = false;
    let finished = false;
    let elements = 0;
    let uses = 0;
    let rootInfo = null;
    let title = '';
    let m;
    TOKEN.lastIndex = 0;
    const textOk = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kept) return TEXTY.has(stack[i].name); return false; };

    while (!finished && (m = TOKEN.exec(src))) {
      const tok = m[0];
      if (tok[0] !== '<' || tok === '<' || tok.startsWith('<![CDATA[')) {
        if (!started || skip) continue;
        if (textOk()) {
          const t = tok.startsWith('<![CDATA[') ? m[1] : decode(tok);
          out.push(escape(t));
          if (stack.some((e) => e.kept && e.name === 'title') && !title) title = t.trim().slice(0, 200);
        }
        continue;
      }
      if (tok[1] === '!' || tok[1] === '?') continue; // comments, doctype, <?xml?>
      const closing = tok[1] === '/';
      const inner = tok.slice(closing ? 2 : 1, tok.endsWith('/>') ? -2 : -1);
      const nameMatch = /^[^\s/>]+/.exec(inner);
      const raw = nameMatch[0];
      const lower = raw.toLowerCase();
      if (skip) {
        if (lower === skip.name) {
          if (closing) { if (--skip.depth === 0) skip = null; } else if (!tok.endsWith('/>')) skip.depth++;
        }
        continue;
      }
      if (closing) {
        if (!started) continue;
        let at = stack.length - 1;
        while (at >= 0 && stack[at].lower !== lower) at--;
        if (at < 0) continue;
        while (stack.length > at) {
          const e = stack.pop();
          if (e.kept) out.push(`</${e.name}>`);
          if (e.root) { finished = true; break; }
        }
        continue;
      }
      const selfClosing = tok.endsWith('/>');
      if (!started && lower !== 'svg') continue;
      if (DROP_WITH_CONTENT.has(lower)) { if (!selfClosing) skip = { name: lower, depth: 1 }; continue; }
      const name = ELEMENTS[lower];
      // attributes
      const attrs = [];
      const rest = inner.slice(raw.length);
      ATTR.lastIndex = 0;
      let a;
      while ((a = ATTR.exec(rest))) {
        const key = ATTRIBUTES[a[1].toLowerCase()];
        if (!key) continue;
        const value = safeValue(key.toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''), lower);
        if (value === null) continue;
        if (!attrs.some((x) => x[0] === key)) attrs.push([key, value]);
      }
      if (!name || (lower === 'image' && !attrs.some((x) => x[0].endsWith('href')))) {
        // unknown element: its tag goes, its children stay; an <image> with no safe picture goes whole
        if (lower === 'image') { if (!selfClosing) skip = { name: lower, depth: 1 }; continue; }
        if (!selfClosing) stack.push({ name: raw, lower, kept: false });
        continue;
      }
      if (lower === 'style') {
        // <style>: kept only when its whole text is safe CSS
        let end = TOKEN.lastIndex;
        let css = '';
        if (!selfClosing) {
          const close = /<\/style\s*>/i.exec(src.slice(end));
          if (!close) return null;
          css = src.slice(end, end + close.index);
          TOKEN.lastIndex = end + close.index + close[0].length;
          end = TOKEN.lastIndex;
          const cleaned = css.length > MAX_STYLE ? null : safeCss(decode(css.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')));
          if (cleaned !== null && started) out.push(`<style>${escape(cleaned)}</style>`);
        }
        continue;
      }
      if (++elements > MAX_ELEMENTS) return null;
      if (lower === 'use' && ++uses > MAX_USE) return null;
      if (stack.length >= MAX_DEPTH) return null;
      if (lower === 'use' && !attrs.some((x) => x[0].endsWith('href'))) { if (!selfClosing) skip = { name: lower, depth: 1 }; continue; }
      if (lower === 'svg' && !started) {
        started = true;
        const get = (k) => attrs.find((x) => x[0] === k)?.[1];
        const vb = /^\s*([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)\s*$/i.exec(get('viewBox') || '');
        const vw = vb ? parseFloat(vb[3]) : null;
        const vh = vb ? parseFloat(vb[4]) : null;
        let w = num(get('width'));
        let h = num(get('height'));
        if (!(w > 0)) w = null;
        if (!(h > 0)) h = null;
        const ratio = vw > 0 && vh > 0 ? vw / vh : null;
        if (w && !h) h = ratio ? w / ratio : w * 0.75;
        else if (h && !w) w = ratio ? h * ratio : h / 0.75;
        else if (!w && !h) { w = ratio ? Math.min(vw, 800) : 300; h = ratio ? w / ratio : 150; }
        w = Math.min(Math.max(Math.round(w * 100) / 100, 1), 4000);
        h = Math.min(Math.max(Math.round(h * 100) / 100, 1), 4000);
        rootInfo = { width: w, height: h };
        const kept = attrs.filter(([k]) => !['width', 'height', 'xmlns', 'version', 'id', 'class'].includes(k));
        out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}"${kept.map(([k, v]) => ` ${k}="${escape(v)}"`).join('')}${selfClosing ? '/>' : '>'}`);
        if (selfClosing) finished = true; else stack.push({ name, lower, kept: true, root: true });
        continue;
      }
      if (!started) continue;
      out.push(`<${name}${attrs.map(([k, v]) => ` ${k}="${escape(v)}"`).join('')}${selfClosing ? '/>' : '>'}`);
      if (!selfClosing) stack.push({ name, lower, kept: true });
    }
    if (!finished || !rootInfo) return null;
    return { svg: out.join(''), width: rootInfo.width, height: rootInfo.height, title };
  }

  const api = { sanitize, MAX_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ---------------- in the page ----------------
  const tr = (key, fallback) => window.t?.(key) || fallback;
  const dataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const cache = new Map(); // source -> sanitize() result + url (a streaming reply redraws its tail every frame: no re-parse)
  const SVG_START = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>\s*)?<svg[\s>]/i;
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);

  function prepared(source) {
    if (cache.has(source)) return cache.get(source);
    const clean = sanitize(source);
    const entry = clean ? { ...clean, url: dataUrl(clean.svg) } : null;
    cache.set(source, entry);
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    return entry;
  }

  // The SVG as a PNG data URL (white behind it, as on the panel), at `scale` x its size, within 4096 px.
  function rasterize(entry, scale = 2) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const k = Math.min(scale, 4096 / Math.max(entry.width, entry.height));
          const canvas = el('canvas', { width: Math.max(1, Math.round(entry.width * k)), height: Math.max(1, Math.round(entry.height * k)) });
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('svg did not load'));
      img.src = entry.url;
    });
  }

  // Is this <pre> a lone SVG? (```svg always; ```xml, ```html or no language when the code starts with <svg.)
  function isSvgBlock(lang, text) {
    const l = String(lang || '').toLowerCase();
    if (l === 'svg') return true;
    return (l === '' || l === 'xml' || l === 'html') && SVG_START.test(text);
  }

  // `finished`: the reply is not streaming (or this block is not its last); a block whose </svg> has arrived is drawn either way.
  function decorate(box, pre) {
    const text = pre.querySelector('code')?.textContent ?? '';
    if (box.dataset.svg || !isSvgBlock(pre.dataset.lang, text)) return false;
    if (!/<\/svg\s*>\s*$/i.test(text)) { box.dataset.svg = 'pending'; return true; } // (still arriving: the code shows)
    const entry = prepared(text);
    if (!entry) { box.dataset.svg = 'failed'; return true; } // (not a safe SVG: the code stays as it is)
    box.dataset.svg = 'done';
    const view = el('div', { className: 'svg-view' });
    const open = el('button', { type: 'button', className: 'svg-pic' });
    const label = entry.title || tr('chat.svgAlt', 'Diagram');
    open.setAttribute('aria-label', `${label} - ${tr('chat.svgEnlarge', 'enlarge')}`);
    const img = el('img', { src: entry.url, alt: label, draggable: false });
    img.setAttribute('width', String(entry.width));
    img.setAttribute('height', String(entry.height));
    open.append(img);
    open.addEventListener('click', async () => {
      try {
        const png = await rasterize(entry, Math.min(4, Math.max(1, 1600 / entry.width)));
        if (window.genImages?.enlarge) window.genImages.enlarge({ id: '', alt: label }, png, open);
      } catch { /* (it stays small) */ }
    });
    view.append(open);
    pre.before(view);
    box.classList.add('svg-ok');
    const head = box.querySelector('.code-head');
    const toggle = el('button', { type: 'button', className: 'code-copy code-source svg-code-toggle', textContent: tr('chat.showCode', 'Code') });
    toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', () => {
      const showing = box.classList.toggle('show-source');
      toggle.textContent = showing ? tr('chat.showPicture', 'Picture') : tr('chat.showCode', 'Code');
      toggle.setAttribute('aria-pressed', String(showing));
    });
    const save = el('button', { type: 'button', className: 'code-copy svg-save', textContent: tr('chat.svgSavePng', 'PNG') });
    save.title = tr('chat.svgSavePngTip', 'Save as a PNG picture');
    save.addEventListener('click', async () => {
      try {
        const png = await rasterize(entry, Math.min(4, Math.max(2, 1600 / entry.width)));
        const a = el('a', { href: png, download: 'lumen-diagram.png' });
        box.append(a);
        a.click();
        a.remove();
      } catch { save.textContent = tr('chat.copyFailed', 'Failed'); setTimeout(() => { save.textContent = tr('chat.svgSavePng', 'PNG'); }, 1400); }
    });
    head?.insertBefore(save, head.querySelector('.code-copy'));
    head?.insertBefore(toggle, save);
    return true;
  }

  window.svgView = { ...api, decorate, isSvgBlock, rasterize, prepared, _reset() { cache.clear(); } };
})();
