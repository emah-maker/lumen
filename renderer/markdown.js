// Minimal, safe markdown -> HTML for assistant replies. All input is HTML-escaped first.
(function () {
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

  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line) || (line.includes('|') && !/^\s*$/.test(line));
  const isSeparator = (line) => line.includes('-') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function table(header, separator, rows) {
    const align = cells(separator).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
    const cell = (tag, text, i) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(text)}</${tag}>`;
    const head = `<tr>${cells(header).map((c, i) => cell('th', c, i)).join('')}</tr>`;
    const body = rows.map((r) => `<tr>${cells(r).map((c, i) => cell('td', c, i)).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function render(source) {
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
        while (k < lines.length && lines[k].trim() !== '' && isTableRow(lines[k])) rows.push(lines[k++]);
        out.push(table(line, lines[n + 1], rows));
        n = k - 1;
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);

      if (heading) {
        flushParagraph(); closeList();
        out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      } else if (bullet || numbered) {
        flushParagraph();
        const type = bullet ? 'ul' : 'ol';
        if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
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

  window.renderMarkdown = render;
})();
