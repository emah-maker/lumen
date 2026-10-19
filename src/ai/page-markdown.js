// A small HTML parser and an HTML -> markdown converter, for read_urls: the article Readability extracts
// (src/vendor/readability, run in the page's isolated world) comes back as an HTML string, and a model reads
// headings, lists, links and code far more cheaply as markdown than as text with all the structure flattened.
// No DOM exists in the main process, so the parser builds DOM-like nodes (tagName, getAttribute, childNodes,
// children, parentElement, textContent, className, id): the converter and the outline walk (page-outline.js)
// only use that much, so tests can run them on plain HTML strings. It reads well-formed markup (Readability
// serializes its output) and copes with what real pages do wrong (unclosed li/p/td, stray end tags), nothing more.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
// An opening tag that ends an unclosed element of the same group (<li>a<li>b, <p>a<p>b, <td>a<td>b).
const AUTO_CLOSE = { li: ['li'], p: ['p'], td: ['td', 'th'], th: ['td', 'th'], tr: ['tr', 'td', 'th'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option'] };
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', laquo: '«', raquo: '»', rsaquo: '›', lsaquo: '‹', middot: '·', bull: '•', rarr: '→', larr: '←', times: '×', trade: '™', reg: '®' };

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

class Node {
  constructor(tag, attrs = {}, parent = null) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.childNodes = [];
    this.parentElement = parent;
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  get id() { return this.attrs.id || ''; }
  get className() { return this.attrs.class || ''; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join(''); }
}
const textNode = (value) => ({ nodeType: 3, nodeValue: value });

// HTML string -> a root Node (tagName "#ROOT") holding the parsed tree.
function parseHtml(html) {
  const root = new Node('#root');
  let cur = root;
  const src = String(html || '');
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s/>]*)\s*>|<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0;
  let m;
  const addText = (t) => { if (t) cur.childNodes.push(textNode(decode(t))); };
  while ((m = tag.exec(src))) {
    addText(src.slice(last, m.index));
    last = tag.lastIndex;
    if (m[1]) { // end tag: close up to the nearest open element of that name (a stray one is ignored)
      const name = m[1].toUpperCase();
      for (let n = cur; n && n !== root; n = n.parentElement) if (n.tagName === name) { cur = n.parentElement; break; }
      continue;
    }
    if (!m[2]) continue; // comment, doctype, CDATA
    const name = m[2].toLowerCase();
    const closes = AUTO_CLOSE[name];
    if (closes) {
      for (let n = cur; n && n !== root; n = n.parentElement) { // an unclosed sibling of the same group ends here
        if (closes.includes(n.tagName.toLowerCase())) { cur = n.parentElement; break; }
        if (/^(UL|OL|TABLE|DL|SELECT|DIV|SECTION)$/.test(n.tagName)) break;
      }
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1].toLowerCase()] ??= decode(a[2] ?? a[3] ?? a[4] ?? '');
    const node = new Node(name, attrs, cur);
    cur.childNodes.push(node);
    if (VOID.has(name) || /\/\s*$/.test(m[3])) continue;
    if (RAW.has(name)) { // its text is code, never markup: skip to the end tag
      const end = new RegExp(`</${name}\\s*>`, 'ig');
      end.lastIndex = last;
      const e = end.exec(src);
      const stop = e ? e.index : src.length;
      if (stop > last) node.childNodes.push(textNode(src.slice(last, stop)));
      tag.lastIndex = last = e ? e.index + e[0].length : src.length;
      continue;
    }
    cur = node;
  }
  addText(src.slice(last));
  return root;
}

// ---------------------------------------------------------------- markdown

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'button', 'input', 'select', 'textarea', 'form', 'canvas', 'audio', 'video', 'object', 'embed', 'head', 'title', 'meta', 'link', 'img', 'picture', 'source']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'address', 'center', 'fieldset', 'body', 'html', 'tbody', 'thead', 'tfoot']);

const collapse = (s) => s.replace(/\s+/g, ' ');
const tagOf = (n) => n.tagName.toLowerCase();

function absolute(href, base) {
  const h = String(href || '').trim();
  if (!h || h[0] === '#' || /^(javascript|data|mailto|tel):/i.test(h)) return '';
  try { return new URL(h, base || undefined).href; } catch { return base ? '' : h; }
}

// Inline content of an element as one line of markdown (br stays a newline).
function inline(node, ctx) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { out += collapse(c.nodeValue); continue; }
    const t = tagOf(c);
    if (SKIP.has(t)) continue;
    if (t === 'br') { out += '\n'; continue; }
    if (t === 'code') { const text = collapse(c.textContent).trim(); out += text ? `\`${text.replace(/`/g, "'")}\`` : ''; continue; }
    const inner = inline(c, ctx);
    const text = inner.trim();
    const pad = BLOCK.has(t) || /^(h[1-6]|li|tr|td|th)$/.test(t) ? ' ' : '';
    if (!text) { out += inner || pad; continue; }
    const lead = /^\s/.test(inner) ? ' ' : '';
    const trail = /\s$/.test(inner) ? ' ' : '';
    if (t === 'a') {
      const href = absolute(c.getAttribute('href'), ctx.base);
      out += href ? `${lead}[${text.replace(/\s*\n\s*/g, ' ').replace(/[[\]]/g, '')}](${href})${trail}` : inner;
    } else if (t === 'strong' || t === 'b') out += `${lead}**${text}**${trail}`;
    else if (t === 'em' || t === 'i') out += `${lead}*${text}*${trail}`;
    else out += pad ? `${pad}${text}${pad}` : inner;
  }
  return out;
}

const cell = (node, ctx) => inline(node, ctx).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

function table(node, ctx) {
  const rows = [];
  const walk = (n) => {
    for (const c of n.children) {
      const t = tagOf(c);
      if (t === 'tr') rows.push(c.children.filter((x) => /^t[dh]$/.test(tagOf(x))).map((x) => cell(x, ctx)));
      else if (/^(thead|tbody|tfoot)$/.test(t)) walk(c);
    }
  };
  walk(node);
  const kept = rows.filter((r) => r.some(Boolean)).slice(0, 80);
  const width = Math.max(0, ...kept.map((r) => r.length));
  if (!kept.length || !width) return '';
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
  const body = kept.map(line);
  body.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
  return body.join('\n') + (rows.length > kept.length ? `\n(+${rows.length - kept.length} more rows)` : '');
}

function list(node, ctx) {
  const ordered = tagOf(node) === 'ol';
  let n = Number(node.getAttribute('start')) || 1;
  const items = [];
  for (const li of node.children) {
    if (tagOf(li) !== 'li') continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const lines = renderChildren(li, ctx).join('\n').split('\n');
    if (!lines.join('').trim()) continue;
    items.push([marker + lines[0], ...lines.slice(1).map((l) => (l ? ' '.repeat(marker.length) + l : l))].join('\n'));
  }
  return items.join('\n');
}

function codeBlock(node) {
  const inner = node.children.find((c) => tagOf(c) === 'code');
  const lang = /\b(?:language|lang)-([\w+#-]+)/.exec((inner || node).className)?.[1] || '';
  const text = (inner || node).textContent.replace(/^\n+|\s+$/g, '');
  if (!text) return '';
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}${lang}\n${text}\n${fence}`;
}

// An element's content as an array of block strings (paragraphs, headings, lists, ...).
function renderChildren(node, ctx) {
  const blocks = [];
  let run = '';
  const flush = () => {
    const t = run.replace(/[ \t\f\r]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
    if (t) blocks.push(t);
    run = '';
  };
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { run += collapse(c.nodeValue); continue; }
    const t = tagOf(c);
    if (SKIP.has(t)) continue;
    if (/^h[1-6]$/.test(t)) { flush(); const text = inline(c, ctx).replace(/\s+/g, ' ').trim(); if (text) blocks.push(`${'#'.repeat(Number(t[1]))} ${text}`); }
    else if (t === 'ul' || t === 'ol') { flush(); const l = list(c, ctx); if (l) blocks.push(l); }
    else if (t === 'pre') { flush(); const p = codeBlock(c); if (p) blocks.push(p); }
    else if (t === 'blockquote') { flush(); const q = renderChildren(c, ctx).join('\n\n'); if (q) blocks.push(q.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')); }
    else if (t === 'table') { flush(); const tb = table(c, ctx); if (tb) blocks.push(tb); }
    else if (t === 'hr') { flush(); blocks.push('---'); }
    else if (t === 'br') run += '\n';
    else if (t === 'p') { flush(); run = inline(c, ctx); flush(); }
    else if (BLOCK.has(t)) { flush(); blocks.push(...renderChildren(c, ctx)); }
    else run += inline({ childNodes: [c] }, ctx);
  }
  flush();
  return blocks;
}

// html: the article's markup. baseUrl resolves relative links. Returns compact markdown ('' when nothing readable).
function htmlToMarkdown(html, { baseUrl = '' } = {}) {
  const blocks = renderChildren(parseHtml(html), { base: baseUrl });
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { parseHtml, htmlToMarkdown, decode };
