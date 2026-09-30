// Minimal, safe markdown -> HTML for assistant replies. All input is HTML-escaped first.
// Math ($…$, \(…\), $$…$$, \[…\], \begin{align}…) is typeset as MathML by Temml (renderer/vendor/temml.min.js),
// which Chromium draws natively; without Temml (tests, a load failure) the formula shows as its source.
(function () {
  // ---------- math ----------
  // Math is lifted out of the raw text before anything else (so markdown never reads its * _ | [ as formatting)
  // and put back, typeset, at the end. A formula is held as a private-use token:  n .
  const TOKEN = /(\d+)/g;
  const ENVS = 'equation|align|gather|multline|alignat|flalign|eqnarray|cases|matrix|pmatrix|bmatrix';
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Temml (168 KB) loads the first time a reply has math, not at start-up; formulas drawn before it arrives show
  // their source for that moment and are then typeset in place.
  const here = typeof document !== 'undefined' ? document.currentScript?.src : '';
  let loading = false;
  function loadTemml() {
    if (loading || typeof document === 'undefined' || !here) return;
    loading = true;
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('vendor/temml.css', here).href });
    const js = Object.assign(document.createElement('script'), { src: new URL('vendor/temml.min.js', here).href, async: true });
    js.onload = () => {
      for (const el of document.querySelectorAll('.math-src[data-tex]')) {
        const html = typeset(el.dataset.tex, el.dataset.display === '1');
        if (!/class="math-src/.test(html)) el.outerHTML = html;
      }
    };
    js.onerror = () => { loading = false; }; // tried again with the next formula
    document.head.append(css, js);
  }
  function typeset(tex, display) {
    const temml = (typeof window !== 'undefined' && window.temml) || globalThis.temml;
    if (!temml) loadTemml();
    if (temml) {
      try {
        const html = temml.renderToString(tex, { displayMode: display, throwOnError: true, annotate: true, trust: false, maxSize: 20, maxExpand: 500 });
        return display ? `<div class="math-block" role="math">${html}</div>` : html;
      } catch { /* not LaTeX it can read: its source, below */ }
    }
    const src = escapeHtml(display ? tex.trim() : tex);
    const data = temml ? '' : ` data-tex="${escapeHtml(tex)}" data-display="${display ? 1 : 0}"`; // to be typeset once Temml is here
    return display ? `<pre class="math-src"${data}>${src}</pre>` : `<code class="math-src"${data}>${src}</code>`;
  }
  // A lone $ is a formula only when it reads like one (Pandoc's rule): "$x$" and "$\alpha + 1$" are; "$5 and $10",
  // "costs $5-$10" and "$ 5" are money. Its content is on one line.
  function dollarEnd(s, i) {
    if (/\s/.test(s[i + 1] || ' ') || s[i + 1] === '$') return -1;
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j];
      if (c === '\n') return -1;
      if (c === '\\') { j++; continue; }
      if (c === '$') return !/\s/.test(s[j - 1]) && !/\d/.test(s[j + 1] || '') ? j : -1;
    }
    return -1;
  }
  // Lifts the math out of `source`: returns the text with tokens in its place, and the formulas. Code (fenced and
  // `inline`) is left alone. A display formula on lines of its own becomes a line of its own, drawn as a block.
  function liftMath(source) {
    const maths = [];
    let out = '';
    let i = 0;
    let fenced = false;
    const put = (tex, display) => { maths.push({ tex, display }); return `${maths.length - 1}`; };
    const lineStart = (k) => k === 0 || source[k - 1] === '\n';
    while (i < source.length) {
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
      if (c === '\\' && source[i + 1] === '$') { out += '$'; i += 2; continue; } // \$ is a dollar sign
      let m = null;
      if (source.startsWith('$$', i)) {
        const e = source.indexOf('$$', i + 2);
        if (e > i + 2) m = { tex: source.slice(i + 2, e), end: e + 2, display: true };
      } else if (source.startsWith('\\[', i)) {
        const e = source.indexOf('\\]', i + 2);
        if (e > i + 2) m = { tex: source.slice(i + 2, e), end: e + 2, display: true };
      } else if (source.startsWith('\\(', i)) {
        const e = source.indexOf('\\)', i + 2);
        if (e > i + 2 && !source.slice(i, e).includes('\n\n')) m = { tex: source.slice(i + 2, e), end: e + 2, display: false };
      } else if (source.startsWith('\\begin{', i)) {
        const env = source.slice(i).match(new RegExp(`^\\\\begin\\{((?:${ENVS})\\*?)\\}`));
        const endTag = env ? `\\end{${env[1]}}` : '';
        const e = env ? source.indexOf(endTag, i) : -1;
        if (e !== -1) m = { tex: source.slice(i, e + endTag.length), end: e + endTag.length, display: true };
      } else if (c === '$') {
        const e = dollarEnd(source, i);
        if (e !== -1) m = { tex: source.slice(i + 1, e), end: e + 1, display: false };
      }
      if (!m) { out += c; i++; continue; }
      if (m.display) {
        // On lines of its own: a block. Inside a sentence: drawn in the line, at display size.
        const before = out.slice(out.lastIndexOf('\n') + 1);
        const nl = source.indexOf('\n', m.end);
        const after = source.slice(m.end, nl === -1 ? source.length : nl);
        const own = !before.trim() && !after.trim();
        out += own ? `\n${put(m.tex, true)}\n` : put(m.tex, 'inline');
        i = m.end;
        continue;
      }
      out += put(m.tex, false);
      i = m.end;
    }
    return { text: out, maths };
  }
  const dropMath = (html, maths) => html.replace(TOKEN, (_t, n) => (maths[n] ? typeset(maths[n].tex, maths[n].display === true) : ''));

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
      const block = line.match(/^\s*\uE000(\d+)\uE001\s*$/);
      if (block && maths[block[1]]?.display === true) {
        flushParagraph(); closeList();
        out.push(`\uE000${block[1]}\uE001`);
        continue;
      }

      if (heading) {
        flushParagraph(); closeList();
        const level = Math.min(heading[1].length, 4);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (bullet || numbered) {
        flushParagraph();
        const type = bullet ? 'ul' : 'ol';
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

  // Is the end of `text` inside an open $$ or \[ formula (outside code)? Rough but safe: it only delays a redraw.
  function inMath(text) {
    const plain = text.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*`/g, '');
    const dollars = (plain.match(/\$\$/g) || []).length;
    return dollars % 2 === 1 || plain.lastIndexOf('\\[') > plain.lastIndexOf('\\]');
  }

  // Where a streaming reply's finished blocks end: just after the last blank line that is outside a
  // code fence. Everything before it renders the same however much text follows, so a stream only
  // has to redraw the text after it. Blocks (lists, tables, paragraphs) all end at a blank line.
  function stableLength(source) {
    let fenced = false;
    let stable = 0;
    let pos = 0;
    while (pos < source.length) {
      let end = source.indexOf('\n', pos);
      if (end === -1) break; // an unfinished last line is never stable
      const line = source.slice(pos, end);
      if (/^```/.test(line)) fenced = !fenced;
      else if (!fenced && line.trim() === '' && pos > 0 && !inMath(source.slice(0, pos))) stable = end + 1;
      pos = end + 1;
    }
    return stable;
  }

  if (typeof window !== 'undefined') {
    window.renderMarkdown = render;
    window.markdownStableLength = stableLength;
    window.markdownInMath = inMath;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { render, stableLength, liftMath, inMath };
})();
