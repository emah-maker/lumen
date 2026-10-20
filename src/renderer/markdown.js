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
    // It opens on something a formula starts with (a letter, digit, \, {, (, [, |, a sign, or a relation that carries an
    // equation on: "Work $= 2\pi N\tau$"): "($)" is a price tier.
    if (!/[A-Za-z0-9\\{([|+\-_^=<>]/.test(s[i + 1] || '')) return -1;
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
      if (/^\d[\d.,]*([kKmMbBtT](n|N)?|MM|mn|bn|tn)?(s|ish|pp|USD)?(\/[a-z]*|\+\/?[a-z]*|-)?([\s,.;:)!?*\]~'"_]|$)/.test(rest)) return false; // (and "**$20**", "[$5]")
      if (/^\d[\d.,]*[kKmMbB]?\s*[-–—]\s*\$?(\d|$)/.test(rest)) return false; // a price range: "$5-$10", "$10-15", "$3k–$5k" // money: "$5 ", "$1.2M in", "$20/month", "$5k-"
      return /^\d[\d.,]*[A-Za-z\\^_+\-*=(]/.test(rest); // "$2x+…" holds
    }
    if (/^[a-z]{3,}\s/.test(rest)) return false; // "$name and": a variable in prose, not a formula
    if (/^\{[A-Za-z_][A-Za-z0-9_]*\}?/.test(rest)) return false; // "${VAR}", "${var}": shell, a template
    if (/^[a-z]+:[A-Za-z]/.test(rest) || /^_(\s|$)/.test(rest)) return false; // "$env:PATH", "$_"
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
      // "so $$ x^2 \; $$ here": spaces inside are fine when it is plainly TeX (a command, a sub- or superscript), not a price tier.
      return wholeLine || !/^\s/.test(tex) || /\\[A-Za-z]|[_^]/.test(tex) ? e : -1;
    }
    if (!atLineStart || /\n\s*\n/.test(tex)) return -1;
    if (!s.slice(i + 2, lineEnd).trim()) return e;
    // "$$a = b \\" on the opening line, the rest and the closing $$ on the lines after: it closes at the end of a line.
    const closeEnd = s.indexOf('\n', e) === -1 ? s.length : s.indexOf('\n', e);
    return !s.slice(e + 2, closeEnd).trim() ? e : -1;
  }
  // A formula cut off before its closing delimiter (a reply that was interrupted, or ended inside one): what is there is
  // closed so it can still be typeset, rather than shown as raw "$$…". A dangling backslash is dropped, open braces closed.
  function closePartial(tex) {
    let t = String(tex).replace(/\s+$/, '');
    const slashes = /\\*$/.exec(t)[0].length;
    if (slashes % 2) t = t.slice(0, -1);
    let depth = 0;
    for (let k = 0; k < t.length; k++) { if (t[k] === '\\') k++; else if (t[k] === '{') depth++; else if (t[k] === '}' && depth > 0) depth--; }
    return t + '}'.repeat(depth);
  }
  // Where an unclosed display formula that starts at i stops: the next blank line, or the end of the text.
  const partialEnd = (s, i) => { const b = s.slice(i).search(/\n[ \t]*\n/); return b === -1 ? s.length : i + b; };
  const URL_START = /^https?:\/\//;
  // Scans `source` for math. Returns the text with tokens in its place, the formulas, and `open`: where a formula
  // starts that has not closed yet (a reply still streaming), or -1. Code (fenced and `inline`) and web addresses
  // are left alone. A display formula on a line of its own stays on that line (with its indent: inside a list item,
  // it belongs to that item).
  function liftMath(source, { closeOpen = false } = {}) {
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
        else if (onlySpaceBefore(i) && source.indexOf('$$', i + 2) === -1) {
          const stop = partialEnd(source, i);
          const tex = source.slice(i + 2, stop);
          // Still being written (or cut off): a streaming reply waits for it; a finished one shows what there is of it.
          if (texLike(tex) && closeOpen) m = { tex: closePartial(tex), end: stop, display: true };
          else if (open === -1 && !closeOpen && stop === source.length && (texLike(tex) || !tex.trim())) open = i;
        }
        if (!m) { out += '$$'; i += 2; continue; }
      } else if (source.startsWith('\\[', i)) {
        const e = source.indexOf('\\]', i + 2);
        const tex = e === -1 ? '' : source.slice(i + 2, e);
        // "\[1\]": a citation in escaped brackets, not math.
        if (e !== -1 && /^[\d\s,–-]+$/.test(tex)) { out += `[${tex}]`; i = e + 2; continue; }
        if (e > i + 2 && !/\n\s*\n/.test(tex)) m = { tex, end: e + 2, display: true };
        else if (e === -1 && closeOpen && onlySpaceBefore(i) && texLike(source.slice(i + 2, partialEnd(source, i)))) { const stop = partialEnd(source, i); m = { tex: closePartial(source.slice(i + 2, stop)), end: stop, display: true }; }
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

  // Sub/superscripts. Rendered: exactly <sub> <sup> (no attributes, balanced, any case) written as text, H~2~O and x^2^.
  // Everything else stays escaped. `s` is already HTML-escaped, so a tag arrives as &lt;sub&gt;; the innermost pair is
  // swapped for the real element first, so nesting works and an unbalanced tag is never touched.
  const SCRIPT_PAIR = /&lt;(sub|sup)&gt;((?:(?!&lt;\/?(?:sub|sup)&gt;)[^])*?)&lt;\/\1&gt;/i;
  function scripts(s) {
    if (!/[~^]|&lt;su[bp]/i.test(s)) return s;
    let out = s;
    for (let guard = 0; guard < 50; guard++) {
      const next = out.replace(SCRIPT_PAIR, (_m, tag, body) => `<${tag.toLowerCase()}>${body}</${tag.toLowerCase()}>`);
      if (next === out) break;
      out = next;
    }
    return out
      .replace(/(?<=[A-Za-z0-9)\]])(?<!~)~([A-Za-z0-9+,()-]{1,12})~(?!~)/g, '<sub>$1</sub>')
      .replace(/(?<=[A-Za-z0-9)\]])(?<!\^)\^([A-Za-z0-9+-]{1,8})\^(?!\^)/g, '<sup>$1</sup>');
  }

  // The same marks as clean plain text (copy, export, notifications): <sub>x</sub> and H~x~ become _x, <sup>x</sup> and x^x^
  // become ^x; more than one character goes in parentheses (σ_(xy)). Code and formulas are left as written.
  const KEEP = /(```[\s\S]*?(?:```|$)|`[^`\n]+`|\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/;
  function plainScripts(text) {
    const src = String(text ?? '');
    if (!/[~^]|<su[bp]/i.test(src)) return src;
    const group = (mark, body) => (body.length > 1 ? `${mark}(${body})` : `${mark}${body}`);
    return src.split(KEEP).map((part, i) => {
      if (i % 2) return part;
      let out = part;
      const pair = /<(sub|sup)>((?:(?!<\/?(?:sub|sup)>)[^])*?)<\/\1>/i;
      for (let guard = 0; guard < 50; guard++) {
        const next = out.replace(pair, (_m, tag, body) => group(tag.toLowerCase() === 'sub' ? '_' : '^', body));
        if (next === out) break;
        out = next;
      }
      return out
        .replace(/(?<=[A-Za-z0-9)\]])(?<!~)~([A-Za-z0-9+,()-]{1,12})~(?!~)/g, (_m, b) => group('_', b))
        .replace(/(?<=[A-Za-z0-9)\]])(?<!\^)\^([A-Za-z0-9+-]{1,8})\^(?!\^)/g, (_m, b) => group('^', b));
    }).join('');
  }

  // ~~strike~~, ***both***, **bold**, *italic*, __bold__, _italic_; they nest (**bold *and italic* text**). Strong is
  // taken first so an italic inside it is found by the pass after. A star next to a space ("2 * 3 * 4") is not a mark;
  // an underscore inside a word (snake_case) is not one either.
  const emphasis = (s) => scripts(s.replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, '<del>$1</del>'))
    .replace(/\*\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, '$1<em>$2</em>');

  // Parsing state of the render in progress (render is synchronous): the reference links and footnotes the text defines.
  let CTX = null; // { refs: id -> url, notes: { id -> text }, used: [id, ...] (footnotes in the order first cited) }
  const refKey = (id) => id.trim().replace(/\s+/g, ' ').toLowerCase();
  // Held pieces of finished HTML (code spans, links, pictures) while emphasis runs over the text around them, so
  // "**a [link](u) and `code`**" is one bold run. A held piece is a private-use token.
  const HELD = /(\d+)/g;

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

  // The picture in ![alt](…) starting at `start` in escaped text: a data URL of a PNG, JPEG, GIF or WebP is drawn (the only
  // picture markdown ever puts in an <img>); an https address becomes a placeholder the chat shows a "Show picture" button for
  // (renderer/gen-images.js: web pictures load only when asked); anything else is not a picture here. { length, html(alt) } | null.
  const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const LOCAL_START = /^(?:&lt;)?(?:file:\/\/|[A-Za-z]:[\\/]|\/|~[\\/])/;
  const LOCAL_IMAGE = /^(?:&lt;[^\n]+\.(?:png|jpe?g|gif|webp)&gt;|[^\n<>]+\.(?:png|jpe?g|gif|webp))$/i;
  function imageAt(s, start) {
    if (s.startsWith('data:image/', start)) {
      const end = s.indexOf(')', start);
      const raw = end > start ? s.slice(start, end) : '';
      return raw.length <= 11000000 && DATA_IMAGE.test(raw) ? { length: raw.length, html: (alt) => `<img class="md-img" src="${raw}" alt="${alt}">` } : null;
    }
    // A picture on this computer (C:\...\cat.png, /home/me/cat.png, file:///...): never loaded here. When the AI made it, main shows
    // it under the reply (features/gen-images.js findLocalImages); the markdown itself reads as its alt text, not as raw syntax.
    if (LOCAL_START.test(s.slice(start, start + 12))) {
      const end = s.indexOf(')', start);
      const raw = end > start ? s.slice(start, end) : '';
      if (raw.length <= 1000 && !raw.includes('\n') && LOCAL_IMAGE.test(raw)) {
        const name = raw.replace(/^&lt;|&gt;$/g, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        return { length: raw.length, html: (alt) => `<span class="md-img-local">${alt || name}</span>` };
      }
      return null;
    }
    if (!s.startsWith('https://', start)) return null;
    const url = scanUrl(s, start, true);
    return url && s[start + url.length] === ')' ? { length: url.length, html: (alt) => `<span class="md-img-remote" data-src="${url}" data-alt="${alt}"></span>` } : null;
  }

  // Backslash escapes: \* \_ \[ \ … show the character itself. An escaped & < > " arrives as \&amp; …
  const ESCAPED = /\\(&(?:amp|lt|gt|quot);|[\\`*_{}[\]()#+\-.!|~^$])/g;

  // A footnote marker: a number, with the note's text as its tooltip; the notes themselves are listed after the reply.
  function footnoteMark(id) {
    if (!CTX || !(id in CTX.notes)) return '';
    if (!CTX.used.includes(id)) CTX.used.push(id);
    const n = CTX.used.indexOf(id) + 1;
    return `<sup class="fn-ref" data-fn="${n}" title="${CTX.notes[id].slice(0, 200)}">${n}</sup>`;
  }
  // [text][id], [id][] and [id] (a numbered citation like [1]) with a definition in the reply: a link.
  function refLink(s, i, hold) {
    if (!CTX) return null;
    const close = s.indexOf(']', i + 1);
    if (close < 0) return null;
    const label = s.slice(i + 1, close);
    if (!label || label.includes('[') || label.length > 300) return null;
    if (label[0] === '^') {
      const html = footnoteMark(refKey(label.slice(1)));
      return html ? { end: close + 1, html: hold(html) } : null;
    }
    if (s[close + 1] === '(') return null;
    let id = label;
    let end = close + 1;
    let text = label;
    if (s[close + 1] === '[') {
      const close2 = s.indexOf(']', close + 2);
      const second = close2 < 0 ? null : s.slice(close + 2, close2);
      // "[1][2]" is two citations side by side, not the text "1" linked to reference 2
      if (second !== null && !second.includes('[') && !(/^\d+$/.test(label) && /^\d+$/.test(second))) { id = second || label; end = close2 + 1; }
    }
    const url = CTX.refs[refKey(id)];
    if (!url) return null;
    const cite = /^\d{1,3}$/.test(text) && end === close + 1;
    if (cite) text = `[${text}]`;
    return { end, html: hold(`<a${cite ? ' class="md-cite"' : ''} href="${url}">${cite ? text : emphasis(text)}</a>`) };
  }

  // Links and emphasis for text outside code spans. `hold` sets finished HTML aside (a token stands in for it).
  function formatText(s, hold) {
    s = s.replace(ESCAPED, (_m, c) => hold(c));
    let plain = '';
    let i = 0;
    while (i < s.length) {
      if (s[i] === '!' && s[i + 1] === '[') {
        const close = s.indexOf('](', i + 2);
        const alt = close > i ? s.slice(i + 2, close) : '';
        if (close > i && !alt.includes('[') && !alt.includes(']') && alt.length <= 300) {
          const image = imageAt(s, close + 2);
          if (image) {
            plain += hold(image.html(alt));
            i = close + 3 + image.length;
            continue;
          }
        }
      }
      if (s[i] === '[') {
        const close = s.indexOf('](', i);
        const label = close > i ? s.slice(i + 1, close) : '';
        // [[3]](url) is a numbered citation: the label keeps its brackets (/research answers); any other nested bracket is not a link
        if (label && (/^\[\d{1,3}\]$/.test(label) || (!label.includes('[') && !label.includes(']')))) {
          const url = scanUrl(s, close + 2, true);
          if (url && s[close + 2 + url.length] === ')') {
            plain += hold(link(url, emphasis(label)));
            i = close + 3 + url.length;
            continue;
          }
        }
        const ref = refLink(s, i, hold);
        if (ref) { plain += ref.html; i = ref.end; continue; }
      }
      if ((s.startsWith('http://', i) || s.startsWith('https://', i)) && (i === 0 || /[\s(>[]/.test(s[i - 1]))) {
        const url = scanUrl(s, i, false);
        if (url) {
          plain += hold(link(url, url));
          i += url.length;
          continue;
        }
      }
      plain += s[i];
      i++;
    }
    return emphasis(plain);
  }

  function inline(text) {
    const held = [];
    const hold = (html) => { held.push(html); return `${held.length - 1}`; };
    const src = text.replace(/[]/g, '').replace(/`([^`]+)`/g, (_m, code) => hold(`<code>${code}</code>`));
    let out = formatText(src, hold);
    for (let pass = 0; pass < 4 && held.length && out.includes(''); pass++) out = out.replace(HELD, (_t, n) => held[n] ?? '');
    return out;
  }

  // ---------- tables (GitHub style) ----------

  const isSeparator = (line) => line.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
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
    const { text, maths } = liftMath(liftRawSvg(String(source ?? '')), { closeOpen: true });
    return dropMath(renderText(text, maths), maths);
  }

  // A raw <svg …>…</svg> a model wrote in its reply (outside code) becomes a ```svg block of its own, so it takes the same road as a
  // fenced one: drawn as a picture once it is complete, shown as code while it streams. Only an <svg> with attributes counts (prose
  // that says "the <svg> element" is left alone), and one that has not closed yet counts only when it starts its line.
  const svgScan = (line, depth) => {
    const tok = /<svg\s+[\w:-]+\s*=|<\/svg\s*>/gi;
    let open = -1;
    let close = -1;
    let m;
    while ((m = tok.exec(line))) {
      if (m[0][1] === '/') { if (depth > 0 && --depth === 0) { close = m.index + m[0].length; break; } continue; }
      if (depth > 0) { depth++; continue; }
      const before = line.slice(0, m.index);
      if ((before.split('`').length - 1) % 2 === 0 && (!before.trim() || /<\/svg\s*>/i.test(line.slice(m.index)))) { depth = 1; open = m.index; }
    }
    return { depth, open, close };
  };
  function liftRawSvg(source) {
    if (!/<svg\s/i.test(source)) return source;
    const out = [];
    let fenced = false;
    let depth = 0;
    for (const line of source.split('\n')) {
      if (depth === 0 && /^```/.test(line)) { fenced = !fenced; out.push(line); continue; }
      if (fenced) { out.push(line); continue; }
      let rest = line;
      for (;;) {
        const r = svgScan(rest, depth);
        if (depth === 0) {
          if (r.open === -1) { out.push(rest); break; }
          const before = rest.slice(0, r.open);
          if (before.trim()) out.push(before);
          out.push('```svg', r.close === -1 ? rest.slice(r.open) : rest.slice(r.open, r.close));
        } else out.push(r.close === -1 ? rest : rest.slice(0, r.close));
        depth = r.depth;
        if (r.close === -1) break;
        out.push('```');
        rest = rest.slice(r.close);
        if (!rest.trim()) break;
      }
    }
    return out.join('\n');
  }

  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
  const QUOTE = /^\s{0,3}&gt;\s?(.*)$/;
  const FOOTNOTE_DEF = /^\s{0,3}\[\^([^\]\s]+)\]:\s*(.*)$/;
  const REF_DEF = /^\s{0,3}\[([^\]^][^\]]*)\]:\s*(?:&lt;)?(https?:\/\/\S+?)(?:&gt;)?(?:\s+(?:&quot;.*?&quot;|'.*?'|\(.*?\)))?\s*$/;
  const expandTabs = (line) => line.replace(/^[ \t]+/, (w) => w.replace(/\t/g, '    '));
  const indentOf = (line) => line.length - line.trimStart().length;

  // [1]: https://… (reference links, which also back [1] citations) and [^1]: … (footnotes) are read out of the text
  // (outside code fences) and removed from it; the rest renders with them in CTX.
  function takeDefinitions(lines) {
    const refs = {};
    const notes = {};
    const keep = [];
    let fenced = false;
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      if (/^```/.test(line)) { fenced = !fenced; keep.push(line); continue; }
      if (fenced) { keep.push(line); continue; }
      const note = line.match(FOOTNOTE_DEF);
      if (note) {
        const body = [note[2]];
        while (n + 1 < lines.length && /^\s+\S/.test(lines[n + 1])) body.push(lines[++n].trim());
        notes[refKey(note[1])] = body.join(' ');
        continue;
      }
      const def = line.match(REF_DEF);
      const url = def ? scanUrl(def[2], 0, true) : '';
      if (def && url) { refs[refKey(def[1])] ??= url; continue; }
      keep.push(line);
    }
    return { refs, notes, lines: keep };
  }

  function renderText(source, maths) {
    const outer = CTX;
    const defs = takeDefinitions(escape(source).split('\n'));
    CTX = { refs: defs.refs, notes: defs.notes, used: [] };
    try {
      let html = blocks(defs.lines, maths);
      if (CTX.used.length) html += `<section class="footnotes"><ol>${CTX.used.map((id) => `<li>${inline(CTX.notes[id])}</li>`).join('')}</ol></section>`;
      return html;
    } finally { CTX = outer; }
  }

  // The list starting at lines[n] (an item line): nested lists, an item's own paragraphs and code, task boxes.
  // Returns { html, next } (next: the first line after the list).
  function listAt(lines, n, maths) {
    const first = expandTabs(lines[n]).match(ITEM);
    const base = first[1].length;
    const type = /\d/.test(first[2][0]) ? 'ol' : 'ul';
    const items = [];
    let k = n;
    let cur = null;
    while (k < lines.length) {
      const line = expandTabs(lines[k]);
      if (line.trim() === '') {
        let j = k + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const nextLine = j < lines.length ? expandTabs(lines[j]) : '';
        const nm = nextLine.match(ITEM);
        // after blank lines the list goes on with an item of this level or with an indented part of the item
        if (!cur || j >= lines.length || !(nm ? (indentOf(nextLine) > base || (indentOf(nextLine) === base && (/\d/.test(nm[2][0]) ? 'ol' : 'ul') === type)) : indentOf(nextLine) >= cur.offset)) break;
        for (let b = k; b < j; b++) cur.body.push('');
        k = j;
        continue;
      }
      const m = line.match(ITEM);
      if (m && !HR.test(line) && indentOf(line) >= base && (!cur || indentOf(line) < cur.offset)) {
        if ((/\d/.test(m[2][0]) ? 'ol' : 'ul') !== type) break; // another kind of list starts here
        cur = { offset: m[1].length + m[2].length + (m[3].length > 4 ? 1 : m[3].length), first: m[4], body: [] };
        items.push(cur);
        k++;
        continue;
      }
      if (!cur || indentOf(line) < cur.offset) break; // a line outside the item ends the list
      cur.body.push(line.slice(Math.min(cur.offset, indentOf(line))));
      k++;
    }
    const li = (item) => {
      let head = item.first;
      let cls = '';
      let box = '';
      const task = head.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) { head = task[2]; cls = ' class="task"'; box = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `; }
      let inner = blocks([head, ...item.body], maths);
      // an item with one paragraph (the rest nested lists, code) is not wrapped in <p>
      if (!/<\/p>[^]*<p>/.test(inner)) inner = inner.replace(/^<p>(.*?)<\/p>/, '$1');
      return `<li${cls}>${box}${inner}</li>`;
    };
    const start = type === 'ol' ? Number(first[2].slice(0, -1)) : 1;
    return { html: `<${type}${type === 'ol' && start !== 1 ? ` start="${start}"` : ''}>${items.map(li).join('')}</${type}>`, next: k };
  }

  function blocks(lines, maths) {
    const out = [];
    let paragraph = [];
    let code = null;
    let codeLang = '';

    const flushParagraph = () => {
      if (paragraph.length) out.push(`<p>${inline(paragraph.join('<br>'))}</p>`);
      paragraph = [];
    };

    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      if (code !== null) {
        if (/^```/.test(line)) {
          out.push(`<pre${codeLang ? ` data-lang="${codeLang}"` : ''}><code>${code.join('\n')}</code></pre>`);
          code = null;
        } else code.push(line);
        continue;
      }
      if (/^```/.test(line)) { flushParagraph(); code = []; codeLang = (line.slice(3).trim().split(/\s/)[0] || '').replace(/[^\w+#.-]/g, '').slice(0, 20); continue; }

      if (line.includes('|') && n + 1 < lines.length && isSeparator(lines[n + 1])) {
        flushParagraph();
        const rows = [];
        let k = n + 2;
        while (k < lines.length && lines[k].trim() !== '' && isTableRow(lines[k], line)) rows.push(lines[k++]);
        out.push(table(line, lines[n + 1], rows));
        n = k - 1;
        continue;
      }

      // A display formula on a line of its own is a block of its own.
      const block = line.match(/^(\s*)(\d+)\s*$/);
      if (block && maths[block[2]]?.display === true) {
        flushParagraph();
        out.push(`${block[2]}`);
        continue;
      }

      // A block quote: its lines (without the >) are read as blocks of their own, so quotes hold lists, code and quotes.
      if (QUOTE.test(line)) {
        flushParagraph();
        const inner = [];
        let k = n;
        while (k < lines.length && QUOTE.test(lines[k])) inner.push(lines[k++].match(QUOTE)[1]);
        out.push(`<blockquote>${blocks(inner, maths)}</blockquote>`);
        n = k - 1;
        continue;
      }

      if (HR.test(line)) { flushParagraph(); out.push('<hr>'); continue; }

      // Levels 4 to 6 show as the smallest heading (h4) rather than as raw "####".
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        const level = Math.min(heading[1].length, 4);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (ITEM.test(expandTabs(line))) {
        flushParagraph();
        const list = listAt(lines, n, maths);
        out.push(list.html);
        n = list.next - 1;
      } else if (line.trim() === '') {
        flushParagraph();
      } else {
        paragraph.push(line);
      }
    }
    if (code !== null) out.push(`<pre${codeLang ? ` data-lang="${codeLang}"` : ''}><code>${code.join('\n')}</code></pre>`);
    flushParagraph();
    return out.join('');
  }

  // Is the end of `text` inside a formula that has not closed ($$, \[, \begin{…})? It only delays a redraw.
  const inMath = (text) => openMath(text) !== -1;

  // Where a streaming reply's finished blocks end: just after the last blank line that is outside a code fence and
  // outside a formula. Everything before it renders the same however much text follows, so a stream only has to
  // redraw the text after it. Blocks (lists, tables, paragraphs) all end at a blank line. One pass over the text.
  // `memo` (an object the caller keeps for one growing text) makes a stream's passes resume where the last one
  // stopped instead of rescanning from the start: a reply is only ever appended to, and lines before the last
  // newline never change. A text that is not an extension of the remembered one starts over.
  function stableLength(source, memo) {
    let st = memo && memo.pos > 0 && memo.pos <= source.length && source.charCodeAt(memo.pos - 1) === 10 && memo.head === source.slice(0, 64) ? memo : null;
    let fenced = st ? st.fenced : false;
    let dollars = st ? st.dollars : 0; // $$ seen outside code (odd: inside a display formula)
    let brackets = st ? st.brackets : 0; // \[ minus \]
    let envs = st ? st.envs : 0; // \begin minus \end
    let svg = st ? st.svg || 0 : 0; // inside a raw <svg> (liftRawSvg): its blank lines are not block ends
    let stable = st ? st.stable : 0;
    let pos = st ? st.pos : 0;
    while (pos < source.length) {
      const end = source.indexOf('\n', pos);
      if (end === -1) break; // an unfinished last line is never stable
      const line = source.slice(pos, end);
      if (svg === 0 && /^```/.test(line)) fenced = !fenced;
      else if (!fenced) {
        if (/<\/?svg/i.test(line)) for (let rest = line; ;) { const r = svgScan(rest, svg); svg = r.depth; if (r.close === -1) break; rest = rest.slice(r.close); }
        const plain = line.replace(/`[^`]*`/g, '').replace(/\\\$/g, '');
        if (/^\s*\$\$|\$\$\s*$/.test(plain)) dollars += (plain.match(/\$\$/g) || []).length; // "($$)" mid-line is a price tier
        if (/^\s*\\\[|\\\]\s*$/.test(plain)) brackets += (plain.match(/\\\[/g) || []).length - (plain.match(/\\\]/g) || []).length; // (a \[ mid-line is a path or a citation)
        envs += (plain.match(/\\begin\{/g) || []).length - (plain.match(/\\end\{/g) || []).length;
        if (line.trim() === '' && pos > 0 && svg === 0 && dollars % 2 === 0 && brackets <= 0 && envs <= 0) stable = end + 1;
      }
      pos = end + 1;
    }
    if (memo) Object.assign(memo, { pos, fenced, dollars, brackets, envs, svg, stable, head: source.slice(0, 64) });
    return stable;
  }

  if (typeof window !== 'undefined') {
    window.renderMarkdown = render;
    window.markdownStableLength = stableLength;
    window.markdownInMath = inMath;
    window.markdownOpenMath = openMath;
    window.markdownPlainText = plainOf;
    window.markdownPlainScripts = plainScripts;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { render, stableLength, liftRawSvg, liftMath, inMath, openMath, plainScripts };
})();
