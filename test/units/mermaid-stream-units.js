// A streamed reply's ```mermaid block is drawn when the reply ends (renderer/chat-core.js decorateCode). endStream's last draw
// (flushStreaming) decorates the blocks while the bubble still has 'streaming', so codeExtras.decorate got { finished: false } and the
// diagram was never drawn; the next decorateCode skipped the block (already .code-ready). The block stayed code until a reload.
// Runs the real decorateCode against a tiny fake DOM. Plain Node.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'chat-core.js'), 'utf8');
const start = src.indexOf('function decorateCode(');
const end = src.indexOf('\nfunction endStream(', start);
check('decorateCode found in chat-core.js', start > -1 && end > start);

class El {
  constructor(tag, { cls = [], lang } = {}) { this.tag = tag; this.children = []; this.dataset = lang ? { lang } : {}; this.classes = new Set(cls); this.parentElement = null; this.textContent = ''; }
  get classList() { const c = this.classes; return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x) }; }
  set className(v) { this.classes = new Set(String(v).split(' ').filter(Boolean)); }
  append(...n) { for (const x of n) { x.parentElement = this; this.children.push(x); } }
  replaceWith(n) { const p = this.parentElement; const i = p.children.indexOf(this); p.children[i] = n; n.parentElement = p; }
  addEventListener() {}
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const all = this.all();
    if (sel.startsWith('pre:not(.math-src):not(.code-ready)')) return all.filter((n) => n.tag === 'pre' && !n.classes.has('math-src') && !n.classes.has('code-ready'));
    if (sel === '.code-block > pre[data-lang="mermaid"]') return all.filter((n) => n.tag === 'pre' && n.dataset.lang === 'mermaid' && n.parentElement?.classes.has('code-block'));
    if (sel === 'code') return all.filter((n) => n.tag === 'code');
    return [];
  }
}

const calls = [];
const window = {
  codeExtras: { decorateTables() {}, decorate(box, pre, { finished = true } = {}) { calls.push(finished); if (pre.dataset.lang === 'mermaid' && finished && !box.dataset.diagram) box.dataset.diagram = 'pending'; } },
};
const document = { createElement: (tag) => new El(tag) };
const t = (k) => k;
// eslint-disable-next-line no-new-func
const decorateCode = new Function('window', 'document', 't', `${src.slice(start, end)}\nreturn decorateCode;`)(window, document, t);

// endStream's order: the last draw while still streaming, then 'streaming' comes off and decorateCode runs again.
const bubble = new El('div', { cls: ['streaming'] });
const pre = new El('pre', { lang: 'mermaid' });
pre.append(new El('code'));
bubble.append(pre);
decorateCode(bubble);
check('while streaming the block is not drawn yet', calls.length === 1 && calls[0] === false && !pre.parentElement.dataset.diagram, JSON.stringify(calls));
bubble.classList.remove('streaming');
decorateCode(bubble);
check('when the reply ends the diagram is drawn', pre.parentElement.classes.has('code-block') && pre.parentElement.dataset.diagram === 'pending' && calls[calls.length - 1] === true, JSON.stringify(calls));
const before = calls.length;
decorateCode(bubble);
check('a block already tried is not decorated again', calls.length === before, JSON.stringify(calls));

// A code block of another language is left alone at the end.
const other = new El('div', { cls: ['streaming'] });
const js = new El('pre', { lang: 'js' });
js.append(new El('code'));
other.append(js);
calls.length = 0;
decorateCode(other);
other.classList.remove('streaming');
decorateCode(other);
check('a non-mermaid block gets no second decorate', calls.length === 1, JSON.stringify(calls));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
