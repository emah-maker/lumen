// Minimal, safe markdown -> HTML for assistant replies. All input is HTML-escaped first.
// Math ($…$, \(…\), $$…$$, \[…\], \begin{align}…, \ce{…}) is typeset as MathML by Temml (renderer/vendor/temml.min.js,
// with mhchem for chemistry), which Chromium draws natively; without Temml (tests, a load failure) the formula shows
// as its source. Copying keeps each formula's LaTeX ($…$), from a selection or the copy button (markdownPlainText).
(function () {
  // ---------- math ----------
  // Math is lifted out of the raw text before anything else (so markdown never reads its * _ | [ as formatting)
  // and put back, typeset, at the end. A formula is held as a private-use token:  n .
  const TOKEN = /(\d+)/g;
  const ENVS = 'equation|align|aligned|alignat|alignedat|gather|gathered|multline|split|flalign|eqnarray|cases|dcases|rcases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|array|subarray|CD';
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const CHEM = /\\(ce|pu)\b/;
  // siunitx and physics commands models often use, as plain LaTeX Temml knows.
  const MACROS = {
    '\\si': '\\mathrm{#1}', '\\unit': '\\mathrm{#1}', '\\SI': '#1\\,\\mathrm{#2}', '\\qty': '#1\\,\\mathrm{#2}', '\\num': '#1', '\\ang': '#1^\\circ',
    '\\dv': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}', '\\pdv': '\\frac{\\partial #1}{\\partial #2}', '\\abs': '\\left|#1\\right|', '\\norm': '\\left\\lVert#1\\right\\rVert',
    '\\vb': '\\mathbf{#1}', '\\vu': '\\hat{\\mathbf{#1}}', '\\grad': '\\nabla', '\\curl': '\\nabla\\times', '\\divergence': '\\nabla\\cdot', '\\mathds': '\\mathbb{#1}', '\\bra': '\\langle #1\\rvert', '\\ket': '\\lvert #1\\rangle', '\\braket': '\\langle #1\\rangle',
    // siunitx units (inside \si, \SI, \qty, \unit): prefixes, units, and \per, \squared, \cubed
    '\\per': '/', '\\squared': '^2', '\\cubed': '^3', '\\percent': '\\%', '\\degree': '^\\circ', '\\celsius': '^\\circ\\mathrm{C}', '\\degreeCelsius': '^\\circ\\mathrm{C}', '\\ohm': '\\Omega',
    '\\kilo': 'k', '\\mega': 'M', '\\giga': 'G', '\\tera': 'T', '\\centi': 'c', '\\milli': 'm', '\\micro': '\\mu{}', '\\nano': 'n', '\\pico': 'p',
    '\\meter': 'm', '\\metre': 'm', '\\second': 's', '\\gram': 'g', '\\ampere': 'A', '\\kelvin': 'K', '\\mole': 'mol', '\\candela': 'cd', '\\hertz': 'Hz', '\\newton': 'N',
    '\\pascal': 'Pa', '\\joule': 'J', '\\watt': 'W', '\\coulomb': 'C', '\\volt': 'V', '\\farad': 'F', '\\tesla': 'T', '\\liter': 'L', '\\litre': 'L', '\\hour': 'h', '\\minute': 'min', '\\electronvolt': 'eV',
  };
  // Before typesetting: \num{3e8} and \SI{3e8}{…} as 3×10⁸, and \dv[2]{y}{x} (an optional argument Temml macros can't take).
  const prepare = (tex) => tex
    .replace(/\\(num|SI|qty)\{\s*([+-]?[\d.]+)[eE]([+-]?\d+)\s*\}/g, (_m, c, a, b) => `\\${c}{${a}\\times10^{${Number(b)}}}`)
    .replace(/\\(p?)dv\[(\w+)\]\{([^{}]*)\}\{([^{}]*)\}/g, (_m, p, n, a, b) => (p ? `\\frac{\\partial^{${n}} ${a}}{\\partial ${b}^{${n}}}` : `\\frac{\\mathrm{d}^{${n}} ${a}}{\\mathrm{d} ${b}^{${n}}}`));
  // Temml (168 KB) loads the first time a reply has math, not at start-up (and mhchem, 35 KB, the first time one has
  // chemistry); formulas drawn before it arrives show their source for that moment and are then typeset in place.
  const here = typeof document !== 'undefined' ? document.currentScript?.src : '';
  const loads = {};
  function load(name, file, after) {
    if (loads[name] || typeof document === 'undefined' || !here) return;
    loads[name] = 'loading';
    const js = Object.assign(document.createElement('script'), { src: new URL(file, here).href, async: true });
    js.onload = () => { loads[name] = 'ready'; after?.(); upgrade(); };
    js.onerror = () => { loads[name] = null; }; // tried again with the next formula
    document.head.append(js);
  }
  function upgrade() {
    for (const el of document.querySelectorAll('.math-src[data-tex]')) {
      const html = typeset(el.dataset.tex, el.dataset.display === '1' ? true : el.dataset.display === 'i' ? 'inline' : false);
      if (!/class="math-src[^"]*" data-tex/.test(html)) el.outerHTML = html;
    }
  }
  function loadTemml(chem) {
    if (typeof document === 'undefined' || !here) return;
    if (!loads.css) { loads.css = 'ready'; document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('vendor/temml.css', here).href })); }
    load('temml', 'vendor/temml.min.js', () => { if (chem) load('mhchem', 'vendor/mhchem.min.js'); });
    if (chem && window.temml) load('mhchem', 'vendor/mhchem.min.js');
  }
  // display: true (a block), 'inline' (a display formula written inside a sentence: in the line, at display size),
  // false (inline).
  const done = new Map(); // tex|display -> html (the stream redraws its tail every frame)
  function typeset(tex, display) {
    const hit = done.get(`${display}|${tex}`);
    if (hit) return hit;
    const html = typesetNow(tex, display);
    if (!/data-tex=/.test(html)) { done.set(`${display}|${tex}`, html); if (done.size > 400) done.delete(done.keys().next().value); }
    return html;
  }
  function typesetNow(tex, display) {
    const temml = (typeof window !== 'undefined' && window.temml) || globalThis.temml;
    const chem = CHEM.test(tex);
    const ready = temml && (!chem || loads.mhchem === 'ready' || globalThis.temmlChem);
    if (!ready) loadTemml(chem);
    if (ready) {
      try {
        const env = /^\s*\\begin\{/.test(tex);
        const clean = prepare(tex.replace(/\\label\{[^}]*\}/g, ''));
        const src = display === 'inline' && !env ? `\\displaystyle ${clean}` : clean;
        const html = temml.renderToString(src, { displayMode: display === true || env, throwOnError: true, annotate: true, trust: false, maxSize: 20, maxExpand: 500, macros: { ...MACROS } });
        if (display === true) return `<div class="math-block">${html}</div>`;
        // A long formula in a line (or a display one written inside a sentence) gets its own sideways scroll: MathML
        // doesn't wrap, and a narrow sidebar bubble must not.
        return display === 'inline' || env || tex.length > 40 || /\\(hspace|kern|hskip|quad)/.test(tex) ? `<span class="math-inline">${html}</span>` : html;
      } catch { /* not LaTeX it can read: its source, below */ }
    }
    const block = display === true;
    const shown = escapeHtml(block ? tex.trim() : tex);
    // Waiting for Temml (or mhchem): marked, to be typeset in place once it is here. A formula it can't read stays source.
    const data = ready ? '' : ` data-tex="${escapeHtml(tex)}" data-display="${block ? 1 : display === 'inline' ? 'i' : 0}"`;
    return block ? `<pre class="math-src"${data}>${shown}</pre>` : `<code class="math-src"${data}>${shown}</code>`;
  }
  // A lone $ is a formula only when it reads like one (Pandoc's rule): "$x$" and "$\alpha + 1$" are; "$5 and $10",
  // "costs $5-$10" and "$ 5" are money. Its content is on one line.
  function dollarEnd(s, i) {
    // It opens on something a formula starts with (a letter, digit, \, {, (, [, |, a sign): "($)" is a price tier.
    if (!/[A-Za-z0-9\\{([|+\-_^]/.test(s[i + 1] || '')) return -1;
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j];
      if (c === '\n') return -1;
      if (c === '\\') { j++; continue; }
      // Not right before a digit ("$5-$10") or another $; before a letter only for a sub- or superscript ("H$_2$O"),
      // since "PATH=$PATH:$HOME" is shell text.
      if (c === '$') {
        const body = s.slice(i + 1, j);
        const mathy = /[_^]/.test(s[i + 1]) || /\\[A-Za-z]/.test(body) || /^[A-Za-z]$/.test(body); // "$n$th", "5 $\mu$m", "$\times$2"
        const next = s[j + 1] || '';
        return !/\s/.test(s[j - 1]) && next !== '$' && (!/[A-Za-z0-9]/.test(next) || mathy) ? j : -1;
      }
    }
    return -1;
  }
  // The text after a lone $ on the last, unfinished line: could it still become a formula? Money ("$5 and", "$1,200.")
  // and shell variables ("$HOME ") can't, and are shown as they come.
  function writingFormula(rest) {
    if (!rest || /^\s/.test(rest)) return false;
    if (/^\d/.test(rest)) {
      if (/^\d[\d.,]*[kKmMbB]?(\/[a-z]*|\+|-)?([\s,.;:)!?]|$)/.test(rest)) return false;
      if (/^\d[\d.,]*[kKmMbB]?\s*[-–—]\s*\$?(\d|$)/.test(rest)) return false; // a price range: "$5-$10", "$10-15", "$3k–$5k" // money: "$5 ", "$1.2M in", "$20/month", "$5k-"
      return /^\d[\d.,]*[A-Za-z\\^_+\-*=(]/.test(rest); // "$2x+…" holds
    }
    if (/^[a-z]{3,}\s/.test(rest)) return false; // "$name and": a variable in prose, not a formula
    if (/^\{[A-Z_][A-Z0-9_]*\}?/.test(rest)) return false; // "${VAR}": shell
    if (/^[A-Z][A-Z0-9_]+(\s|[:/;]|$)/.test(rest) && !/^[A-Z]$/.test(rest)) return /^[A-Z][A-Z0-9_]+$/.test(rest) && rest.length < 3; // "$HOME " is shell
    return /^[A-Za-z\\([|_^{-]/.test(rest);
  }
  const texLike = (t) => /[A-Za-z0-9\\]/.test(t); // "$$ – $$", "( $$ )": not a formula
  // The end of a $$ formula starting at i, or -1. On lines of its own it may span lines (never a blank one); written
  // inside a line, it closes on that line and starts right after the $$, so price tiers ("($$)", "$$ to $$$$") stay
  // text. A $$ … $$ that is the whole line may have spaces inside.
  function displayDollarEnd(s, i, atLineStart) {
    const lineEnd = s.indexOf('\n', i) === -1 ? s.length : s.indexOf('\n', i);
    const e = s.indexOf('$$', i + 2);
    if (e === -1) return -1;
    const tex = s.slice(i + 2, e);
    if (!texLike(tex)) return -1;
    if (e < lineEnd) {
      const wholeLine = atLineStart && !s.slice(e + 2, lineEnd).trim();
      return wholeLine || !/^\s/.test(tex) ? e : -1;
    }
    const opener = s.slice(i + 2, lineEnd);
    return atLineStart && !opener.trim() && !/\n\s*\n/.test(tex) ? e : -1;
  }
  const URL_START = /^https?:\/\//;
  // Scans `source` for math. Returns the text with tokens in its place, the formulas, and `open`: where a formula
  // starts that has not closed yet (a reply still streaming), or -1. Code (fenced and `inline`) and web addresses
  // are left alone. A display formula on a line of its own stays on that line (with its indent: inside a list item,
  // it belongs to that item).
  function liftMath(source) {
    source = source.replace(/[\uE000\uE001]/g, '');
    const maths = [];
    let out = '';
    let i = 0;
    let fenced = false;
    let open = -1;
    const put = (tex, display) => { maths.push({ tex, display }); return `${maths.length - 1}`; };
    const lineStart = (k) => k === 0 || source[k - 1] === '\n';
    const onlySpaceBefore = (k) => { const b = source.lastIndexOf('\n', k - 1) + 1; return !source.slice(b, k).trim(); };
    while (i < source.length) {
      // A ```math (or latex, tex) fence is a display formula, as GitHub and several models write one.
      if (!fenced && lineStart(i) && /^```(math|latex|tex)[ \t]*(\n|$)/.test(source.slice(i, i + 12))) {
        const bodyAt = source.indexOf('\n', i) + 1;
        const close = bodyAt > 0 ? source.indexOf('\n```', bodyAt - 1) : -1;
        if (close !== -1) {
          const tex = source.slice(bodyAt, close);
          const after = source.indexOf('\n', close + 4);
          if (texLike(tex)) { out += put(tex, true); i = after === -1 ? source.length : after; continue; }
        } else if (open === -1) open = i;
      }
      if (lineStart(i) && source.startsWith('```', i)) fenced = !fenced;
      if (fenced || (lineStart(i) && source.startsWith('```', i))) {
        const nl = source.indexOf('\n', i);
        const end = nl === -1 ? source.length : nl + 1;
        out += source.slice(i, end);
        i = end;
        continue;
      }
      const c = source[i];
      if (c === '`') { // inline code: up to the matching run of backticks on this line
        const run = source.slice(i).match(/^`+/)[0];
        const close = source.indexOf(run, i + run.length);
        const nl = source.indexOf('\n', i);
        if (close !== -1 && (nl === -1 || close < nl)) { out += source.slice(i, close + run.length); i = close + run.length; continue; }
        out += run; i += run.length; continue;
      }
      // A web address (bare, or a link's target) is never math: "…?$select=a&$top=5" keeps its dollars.
      if ((c === 'h') && URL_START.test(source.slice(i, i + 8)) && (i === 0 || /[\s(<[]/.test(source[i - 1]))) {
        const m = source.slice(i).match(/^\S+/)[0];
        out += m; i += m.length; continue;
      }
      if (c === '\\' && source[i + 1] === '$') { out += '$'; i += 2; continue; } // \$ is a dollar sign
      let m = null;
      if (source.startsWith('$$', i)) {
        const e = displayDollarEnd(source, i, onlySpaceBefore(i));
        if (e !== -1) m = { tex: source.slice(i + 2, e), end: e + 2, display: true };
        else if (open === -1 && onlySpaceBefore(i) && source.indexOf('$$', i + 2) === -1 && !/\n\s*\n/.test(source.slice(i)) && !source.slice(i + 2, (source.indexOf('\n', i) + 1 || source.length + 1) - 1).trim()) open = i;
        if (!m) { out += '$$'; i += 2; continue; }
      } else if (source.startsWith('\\[', i)) {
        const e = source.indexOf('\\]', i + 2);
        const tex = e === -1 ? '' : source.slice(i + 2, e);
        // "\[1\]": a citation in escaped brackets, not math.
        if (e !== -1 && /^[\d\s,–-]+$/.test(tex)) { out += `[${tex}]`; i = e + 2; continue; }
        if (e > i + 2 && !/\n\s*\n/.test(tex)) m = { tex, end: e + 2, display: true };
        else if (e === -1 && open === -1 && source.length - i < 300) open = i;
      } else if (source.startsWith('\\(', i)) {
        const e = source.indexOf('\\)', i + 2);
        if (e > i + 2 && !source.slice(i, e).includes('\n\n')) m = { tex: source.slice(i + 2, e), end: e + 2, display: false };
        else if (e === -1 && open === -1 && source.length - i < 300) open = i;
      } else if (source.startsWith('\\begin{', i)) {
        const env = source.slice(i).match(new RegExp(`^\\\\begin\\{((?:${ENVS})\\*?)\\}`));
        const endTag = env ? `\\end{${env[1]}}` : '';
        const e = env ? source.indexOf(endTag, i) : -1;
        if (e !== -1) m = { tex: source.slice(i, e + endTag.length), end: e + endTag.length, display: true };
        else if (env && open === -1) open = i;
      } else if (c === '$') {
        const e = dollarEnd(source, i);
        if (e !== -1) m = { tex: source.slice(i + 1, e), end: e + 1, display: false };
        // Still being written: a $ that opens like a formula (not money: "$5") on the last, unfinished line.
        else if (open === -1 && source.indexOf('\n', i) === -1 && writingFormula(source.slice(i + 1))) open = i;
      }
      if (!m) { out += c; i++; continue; }
      if (m.display) {
        // On a line of its own: a block (its indent kept). Inside a sentence: in the line, at display size.
        const nl = source.indexOf('\n', m.end);
        const own = onlySpaceBefore(i) && !source.slice(m.end, nl === -1 ? source.length : nl).trim();
        out += put(m.tex, own ? true : 'inline');
        i = m.end;
        continue;
      }
      out += put(m.tex, false);
      i = m.end;
    }
    if (open === -1) {
      const tail = source.match(/\\(?:b(?:e(?:g(?:in?)?)?)?)?(?:\{[A-Za-z*]*)?$/);
      if (tail && !fenced) open = tail.index;
    }
    return { text: out, maths, open };
  }
  const dropMath = (html, maths) => html.replace(TOKEN, (_t, n) => (maths[n] ? typeset(maths[n].tex, maths[n].display) : ''));
  // Where a streaming reply's unfinished formula starts (or -1): the text from there waits until it closes.
  const openMath = (source) => liftMath(String(source || '')).open;

  // Copying a selection that has formulas in it: the plain text gets each formula's LaTeX ($…$, $$…$$ for a block),
  // not the flattened glyphs ("E=mc2"). The HTML copy keeps the MathML.
  function plainOf(node) {
    const copy = node.cloneNode(true);
    for (const el of copy.querySelectorAll?.('.reply-copy, .reply-model') || []) el.remove();
    for (const math of copy.querySelectorAll?.('math') || []) {
      const raw = math.querySelector('annotation')?.textContent;
      if (raw == null) continue;
      const tex = raw.replace(/^\s*\\displaystyle\s*/, '').trim();
      const block = math.getAttribute('display') === 'block';
      math.replaceWith(document.createTextNode(block ? `\n$$${tex}$$\n` : `$${tex}$`));
    }
    // innerText needs layout: measured off screen at the node's own width.
    const box = document.createElement('div');
    Object.assign(box.style, { position: 'fixed', left: '-10000px', top: '0', width: `${node.clientWidth || 400}px`, whiteSpace: 'normal' });
    box.append(copy);
    document.body.append(box);
    const text = box.innerText;
    box.remove();
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('copy', (e) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !e.clipboardData) return;
      const range = sel.getRangeAt(0);
      const mathOf = (n) => (n instanceof Element ? n : n.parentElement)?.closest('math');
      const a = mathOf(range.startContainer);
      const b = mathOf(range.endContainer);
      if (a) range.setStartBefore(a); // a selection that starts or ends inside a formula takes all of it
      if (b) range.setEndAfter(b);
      const frag = range.cloneContents();
      if (!frag.querySelector('annotation')) return;
      const holder = document.createElement('div');
      holder.append(frag);
      e.clipboardData.setData('text/html', holder.innerHTML);
      e.clipboardData.setData('text/plain', plainOf(holder));
      e.preventDefault();
    });
  }

  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const emphasis = (s) => s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

  // Reads a URL starting at `start` in escaped text. Parentheses are kept when balanced, so
  // https://en.wikipedia.org/wiki/Safari_(web_browser) stays whole. Returns '' if there is no URL.
  function scanUrl(s, start, bracketed) {
    if (!/^https?:\/\//.test(s.slice(start, start + 8))) return '';
    let depth = 0;
    let j = start;
    while (j < s.length) {
      const c = s[j];
      if (/\s/.test(c) || s.startsWith('&lt;', j) || s.startsWith('&gt;', j) || s.startsWith('&quot;', j)) break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    let url = s.slice(start, j);
    // A bare URL at the end of a sentence shouldn't swallow the punctuation.
    if (!bracketed) url = url.replace(/[.,;:!?'*]+$/, '');
    return /^https?:\/\/[^\s]+$/.test(url) && url.length > 8 ? url : '';
  }

  const link = (href, label) => `<a href="${href}">${label}</a>`;

  // Links and emphasis for text outside code spans.
  function formatText(s) {
    let out = '';
    let plain = '';
    const flush = () => { out += emphasis(plain); plain = ''; };
    let i = 0;
    while (i < s.length) {
      if (s[i] === '[') {
        const close = s.indexOf('](', i);
        const label = close > i ? s.slice(i + 1, close) : '';
        if (label && !label.includes('[') && !label.includes(']')) {
          const url = scanUrl(s, close + 2, true);
          if (url && s[close + 2 + url.length] === ')') {
            flush();
            out += link(url, emphasis(label));
            i = close + 3 + url.length;
            continue;
          }
        }
      }
      if ((s.startsWith('http://', i) || s.startsWith('https://', i)) && (i === 0 || /[\s(>[]/.test(s[i - 1]))) {
        const url = scanUrl(s, i, false);
        if (url) {
          flush();
          out += link(url, url);
          i += url.length;
          continue;
        }
      }
      plain += s[i];
      i++;
    }
    flush();
    return out;
  }

  function inline(text) {
    return text.split(/(`[^`]+`)/).map((part, i) => (i % 2 ? `<code>${part.slice(1, -1)}</code>` : formatText(part))).join('');
  }

  // ---------- tables (GitHub style) ----------

  const isSeparator = (line) => line.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  // A body row looks like the header: it starts with | when the header does, and otherwise has the
  // header's number of cells. A sentence after the table that happens to contain a | stays text.
  const isTableRow = (line, header) => {
    if (!line.includes('|')) return false;
    if (/^\s*\|/.test(header)) return /^\s*\|/.test(line);
    return cells(line).length === cells(header).length;
  };

  function table(header, separator, rows) {
    const align = cells(separator).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
    const cell = (tag, text, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(text)}</${tag}>`;
    const head = `<tr>${cells(header).map((c, i) => cell('th', c, i)).join('')}</tr>`;
    const body = rows.map((r) => `<tr>${cells(r).map((c, i) => cell('td', c, i)).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function render(source) {
    const { text, maths } = liftMath(String(source ?? ''));
    return dropMath(renderText(text, maths), maths);
  }

  function renderText(source, maths) {
    const lines = escape(source).split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol'
    let paragraph = [];
    let code = null;

    const flushParagraph = () => {
      if (paragraph.length) out.push(`<p>${inline(paragraph.join('<br>'))}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };

    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      if (code !== null) {
        if (/^```/.test(line)) {
          out.push(`<pre><code>${code.join('\n')}</code></pre>`);
          code = null;
        } else code.push(line);
        continue;
      }
      if (/^```/.test(line)) { flushParagraph(); closeList(); code = []; continue; }

      if (line.includes('|') && n + 1 < lines.length && isSeparator(lines[n + 1])) {
        flushParagraph(); closeList();
        const rows = [];
        let k = n + 2;
        while (k < lines.length && lines[k].trim() !== '' && isTableRow(lines[k], line)) rows.push(lines[k++]);
        out.push(table(line, lines[n + 1], rows));
        n = k - 1;
        continue;
      }

      // Levels 4 to 6 show as the smallest heading (h4) rather than as raw "####".
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);

      // A display formula on a line of its own is a block of its own.
      const block = line.match(/^(\s*)\uE000(\d+)\uE001\s*$/);
      if (block && maths[block[2]]?.display === true) {
        const token = `\uE000${block[2]}\uE001`;
        // Indented under a list item: part of that item (the list goes on after it).
        const last = out.length - 1;
        if (list && block[1] && /<\/li>$/.test(out[last] || '')) { flushParagraph(); out[last] = out[last].replace(/<\/li>$/, `${token}</li>`); continue; }
        // The same after a blank line (which closed the list): the list opens again around it.
        if (!list && block[1] && !paragraph.length && /^<\/(ol|ul)>$/.test(out[last] || '') && /<\/li>$/.test(out[last - 1] || '')) {
          list = out[last].slice(2, 4);
          out.pop();
          out[last - 1] = out[last - 1].replace(/<\/li>$/, `${token}</li>`);
          continue;
        }
        flushParagraph(); closeList();
        out.push(token);
        continue;
      }

      if (heading) {
        flushParagraph(); closeList();
        const level = Math.min(heading[1].length, 4);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (bullet || numbered) {
        flushParagraph();
        const type = bullet ? 'ul' : 'ol';
        // The same kind of list again after only blank lines (or a formula it held): one list, not two.
        if (!list && out[out.length - 1] === `</${type}>`) { out.pop(); list = type; }
        if (list !== type) {
          closeList();
          // A numbered list split by a paragraph or code block keeps counting (3., 4., …) instead of restarting at 1.
          const start = numbered ? Number(numbered[1]) : 1;
          out.push(type === 'ol' && start !== 1 ? `<ol start="${start}">` : `<${type}>`);
          list = type;
        }
        out.push(`<li>${inline(bullet ? bullet[1] : numbered[2])}</li>`);
      } else if (line.trim() === '') {
        flushParagraph(); closeList();
      } else {
        closeList();
        paragraph.push(line);
      }
    }
    if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
    flushParagraph(); closeList();
    return out.join('');
  }

  // Is the end of `text` inside a formula that has not closed ($$, \[, \begin{…})? It only delays a redraw.
  const inMath = (text) => openMath(text) !== -1;

  // Where a streaming reply's finished blocks end: just after the last blank line that is outside a code fence and
  // outside a formula. Everything before it renders the same however much text follows, so a stream only has to
  // redraw the text after it. Blocks (lists, tables, paragraphs) all end at a blank line. One pass over the text.
  function stableLength(source) {
    let fenced = false;
    let dollars = 0; // $$ seen outside code (odd: inside a display formula)
    let brackets = 0; // \[ minus \]
    let envs = 0; // \begin minus \end
    let stable = 0;
    let pos = 0;
    while (pos < source.length) {
      const end = source.indexOf('\n', pos);
      if (end === -1) break; // an unfinished last line is never stable
      const line = source.slice(pos, end);
      if (/^```/.test(line)) fenced = !fenced;
      else if (!fenced) {
        const plain = line.replace(/`[^`]*`/g, '').replace(/\\\$/g, '');
        if (/^\s*\$\$|\$\$\s*$/.test(plain)) dollars += (plain.match(/\$\$/g) || []).length; // "($$)" mid-line is a price tier
        if (/^\s*\\\[|\\\]\s*$/.test(plain)) brackets += (plain.match(/\\\[/g) || []).length - (plain.match(/\\\]/g) || []).length; // (a \[ mid-line is a path or a citation)
        envs += (plain.match(/\\begin\{/g) || []).length - (plain.match(/\\end\{/g) || []).length;
        if (line.trim() === '' && pos > 0 && dollars % 2 === 0 && brackets <= 0 && envs <= 0) stable = end + 1;
      }
      pos = end + 1;
    }
    return stable;
  }

  if (typeof window !== 'undefined') {
    window.renderMarkdown = render;
    window.markdownStableLength = stableLength;
    window.markdownInMath = inMath;
    window.markdownOpenMath = openMath;
    window.markdownPlainText = plainOf;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { render, stableLength, liftMath, inMath, openMath };
})();
