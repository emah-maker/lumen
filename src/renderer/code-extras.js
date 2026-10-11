// Extras for code blocks in replies (chat-core.js decorateCode calls window.codeExtras.decorate for each new block):
//  - a Wrap button (long lines wrap instead of scrolling sideways; the choice is remembered),
//  - a ```mermaid block drawn as a diagram, with a Source/Diagram switch. Mermaid (renderer/vendor/mermaid.min.js, 3.5 MB)
//    loads the first time a reply has such a block, never at start-up. Any failure (not loaded, bad syntax, too slow, too
//    big) leaves the plain code block as it was. securityLevel is 'strict' (labels sanitised, no click handlers), and the
//    SVG is scrubbed again here before it goes into the page.
(() => {
  const here = typeof document !== 'undefined' ? document.currentScript?.src : '';
  const MAX_SOURCE = 20000;
  const TIMEOUT_MS = 8000;
  const WRAP_KEY = 'lumen.codeWrap';

  // ---------- the SVG that goes in the page ----------
  // Drops scripts, foreign objects' event handlers, javascript: links and external loads from an SVG string. Returns '' if
  // it is not an SVG at all.
  function cleanSvg(svg, doc = document) {
    const tpl = doc.createElement('template');
    tpl.innerHTML = String(svg || '');
    const root = tpl.content.firstElementChild;
    if (!root || root.localName !== 'svg') return '';
    for (const el of [...root.querySelectorAll('script, iframe, object, embed, link, meta, base, img')]) el.remove();
    for (const style of root.querySelectorAll('style')) style.textContent = style.textContent.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?\s*(?!#)[^)]*\)/gi, 'none');
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        else if ((name === 'href' || name === 'xlink:href' || name === 'src') && !value.startsWith('#')) el.removeAttribute(attr.name);
      }
    }
    return root.outerHTML;
  }

  // ---------- mermaid ----------
  const cache = new Map(); // theme|source -> svg (a finished reply redraws its blocks: the diagram comes back at once)
  let loading = null; // Promise of window.mermaid
  let queue = Promise.resolve(); // mermaid.render is one at a time

  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (typeof document === 'undefined' || !here) { reject(new Error('no page')); return; }
      const js = Object.assign(document.createElement('script'), { src: new URL('vendor/mermaid.min.js', here).href, async: true });
      js.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('mermaid missing')));
      js.onerror = () => reject(new Error('mermaid did not load'));
      document.head.append(js);
    }).catch((e) => { loading = null; throw e; }); // (tried again with the next block)
    return loading;
  }

  const isDark = () => {
    const theme = document.documentElement.dataset.theme;
    return theme === 'dark' || (theme !== 'light' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  };

  let initedFor = null;
  async function draw(source) {
    const dark = isDark();
    const key = `${dark ? 'd' : 'l'}|${source}`;
    if (cache.has(key)) return cache.get(key);
    const mermaid = await loadMermaid();
    const job = queue.then(async () => {
      if (initedFor !== dark) {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'inherit', flowchart: { htmlLabels: false }, deterministicIds: true });
        initedFor = dark;
      }
      const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
      try {
        const out = await Promise.race([mermaid.render(id, source), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);
        return out.svg;
      } finally {
        // a failed render leaves its error drawing in the page body
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
    });
    queue = job.catch(() => {});
    const svg = cleanSvg(await job);
    if (!svg) throw new Error('not an svg');
    cache.set(key, svg);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return svg;
  }

  function diagram(box, pre, source) {
    if (source.trim() === '' || source.length > MAX_SOURCE || box.dataset.diagram) return;
    box.dataset.diagram = 'pending';
    draw(source).then((svg) => {
      if (!box.isConnected) return;
      const view = Object.assign(document.createElement('div'), { className: 'mermaid-view' });
      view.innerHTML = svg;
      pre.before(view);
      box.classList.add('mermaid-ok');
      box.dataset.diagram = 'done';
      const head = box.querySelector('.code-head');
      const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'code-copy code-source', textContent: window.t?.('chat.showSource') || 'Source' });
      toggle.addEventListener('click', () => {
        const showing = box.classList.toggle('show-source');
        toggle.textContent = showing ? (window.t?.('chat.showDiagram') || 'Diagram') : (window.t?.('chat.showSource') || 'Source');
      });
      head?.insertBefore(toggle, head.querySelector('.code-copy'));
    }).catch((e) => { box.dataset.diagram = 'failed'; }); // the code block stays as it is
  }

  // ---------- wrap ----------
  const wrapped = () => { try { return localStorage.getItem(WRAP_KEY) === '1'; } catch { return false; } };
  const remember = (on) => { try { localStorage.setItem(WRAP_KEY, on ? '1' : '0'); } catch { /* (no storage: per block only) */ } };
  function wrapButton(box, head) {
    const label = () => (box.classList.contains('wrap') ? (window.t?.('chat.noWrap') || 'No wrap') : (window.t?.('chat.wrap') || 'Wrap'));
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'code-copy code-wrap', textContent: '' });
    box.classList.toggle('wrap', wrapped());
    b.textContent = label();
    b.setAttribute('aria-pressed', String(box.classList.contains('wrap')));
    b.addEventListener('click', () => {
      const on = box.classList.toggle('wrap');
      remember(on);
      b.textContent = label();
      b.setAttribute('aria-pressed', String(on));
    });
    head.insertBefore(b, head.querySelector('.code-copy'));
  }

  // `finished`: the block is complete (not the last, still-streaming one), so a diagram can be drawn.
  function decorate(box, pre, { finished = true } = {}) {
    const head = box.querySelector('.code-head');
    if (head && pre.dataset.lang !== 'mermaid') wrapButton(box, head);
    if (pre.dataset.lang === 'mermaid' && finished) diagram(box, pre, pre.querySelector('code')?.textContent ?? '');
  }

  // A table of five or more columns gets a Fit / Scroll switch: scroll keeps each column readable (the table
  // is as wide as its text, which scrolls sideways); fit squeezes it into the width of the reply.
  function decorateTables(root) {
    for (const wrap of root?.querySelectorAll?.('.table-wrap:not(.fit-ready)') || []) {
      wrap.classList.add('fit-ready');
      if (wrap.querySelectorAll('thead th').length < 5) continue;
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'table-fit', textContent: window.t?.('chat.tableFit') || 'Fit to width' });
      b.addEventListener('click', () => {
        const on = wrap.classList.toggle('fit');
        b.textContent = on ? (window.t?.('chat.tableScroll') || 'Scroll') : (window.t?.('chat.tableFit') || 'Fit to width');
      });
      wrap.before(b);
    }
  }

  window.codeExtras = { decorate, decorateTables, cleanSvg, draw, _reset() { cache.clear(); loading = null; initedFor = null; queue = Promise.resolve(); } };
})();
