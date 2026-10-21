// Code block extras (renderer/code-extras.js), plain node with a tiny fake DOM: Mermaid loads lazily (not at start-up, not for a
// block that is not mermaid), runs in 'strict' mode, falls back to the plain code block on any error, the Wrap button
// toggles and remembers, and wide tables get a Fit switch. (The real SVG scrubbing and a real Mermaid draw are checked in
// Electron: see the PR.)
const assert = require('assert');

let failed = 0;
const pending = [];
const check = (name, fn) => pending.push(async () => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.stack || e.message}`); } });

class El {
  constructor(tag) {
    this.tag = tag; this.localName = tag; this.children = []; this.dataset = {}; this.classes = new Set(); this.attrs = {}; this.isConnected = true; this.textContent = '';
    this.classList = { add: (c) => this.classes.add(c), contains: (c) => this.classes.has(c), toggle: (c, f) => { const on = f === undefined ? !this.classes.has(c) : f; on ? this.classes.add(c) : this.classes.delete(c); return on; } };
  }
  set className(v) { this.classes = new Set(String(v).split(' ').filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set innerHTML(v) { this._html = v; if (this.tag === 'template') this.content = { firstElementChild: /^\s*<svg/.test(v) ? Object.assign(new El('svg'), { outerHTML: v, attributes: [], querySelectorAll: () => [] }) : null }; }
  get innerHTML() { return this._html || ''; }
  append(...n) { this.children.push(...n); }
  before() {}
  insertBefore(n) { this.children.push(n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; }
  click() { this.listeners?.click?.(); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (sel[0] === '.' ? c.classes.has(sel.slice(1)) : c.tag === sel) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}
const scripts = [];
global.window = { t: undefined };
global.localStorage = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = v; } };
global.document = {
  currentScript: { src: 'file:///app/renderer/code-extras.js' },
  createElement: (tag) => new El(tag),
  head: { append: (s) => scripts.push(s) },
  documentElement: { dataset: {} },
  getElementById: () => null,
};
require('../../src/renderer/code-extras.js');
const ex = window.codeExtras;

const block = (lang, source) => {
  const box = new El('div'); box.className = 'code-block';
  const head = new El('div'); head.className = 'code-head';
  const copy = new El('button'); copy.className = 'code-copy';
  head.append(copy);
  const pre = new El('pre'); pre.dataset.lang = lang;
  const code = new El('code'); code.textContent = source;
  pre.append(code);
  box.append(head, pre);
  return { box, pre, head };
};
const tick = () => new Promise((r) => setTimeout(r, 5));
const fakeMermaid = (render) => { const m = { inits: [], initialize(c) { this.inits.push(c); }, render }; return m; };

check('nothing loads at start-up, nor for a block that is not mermaid', async () => {
  assert.strictEqual(scripts.length, 0);
  const b = block('js', 'x');
  ex.decorate(b.box, b.pre, { finished: true });
  await tick();
  assert.strictEqual(scripts.length, 0);
});

check('a mermaid block still streaming is not drawn (and no script is loaded)', async () => {
  const b = block('mermaid', 'graph TD; A-->B');
  ex.decorate(b.box, b.pre, { finished: false });
  await tick();
  assert.strictEqual(scripts.length, 0);
  assert.ok(!b.box.classes.has('mermaid-ok'));
});

check('a finished mermaid block loads Mermaid once, from vendor/, and becomes a diagram in strict mode', async () => {
  ex._reset();
  const m = fakeMermaid(async (id, src) => ({ svg: `<svg id="${id}"><text>${src}</text></svg>` }));
  const a = block('mermaid', 'graph TD; A-->B');
  const b = block('mermaid', 'graph TD; C-->D');
  ex.decorate(a.box, a.pre, { finished: true });
  ex.decorate(b.box, b.pre, { finished: true });
  assert.strictEqual(scripts.length, 1, 'one script for two blocks');
  assert.strictEqual(scripts[0].src, 'file:///app/renderer/vendor/mermaid.min.js');
  window.mermaid = m;
  scripts[0].onload();
  await tick(); await tick(); await tick();
  assert.ok(a.box.classes.has('mermaid-ok') && b.box.classes.has('mermaid-ok'));
  assert.strictEqual(m.inits.length, 1);
  assert.strictEqual(m.inits[0].securityLevel, 'strict');
  assert.strictEqual(m.inits[0].startOnLoad, false);
  assert.ok(a.box.querySelector('.code-source'), 'a Source switch');
  assert.ok(!a.box.querySelector('.code-wrap'), 'no Wrap button on a diagram');
  // Source / Diagram switch
  a.box.querySelector('.code-source').click();
  assert.ok(a.box.classes.has('show-source'));
  assert.strictEqual(a.box.querySelector('.code-source').textContent, 'Diagram');
});

check('a drawing that fails leaves the code block as it was', async () => {
  const m = fakeMermaid(async () => { throw new Error('Parse error'); });
  ex._reset(); window.mermaid = m;
  const b = block('mermaid', 'this is not a diagram ((');
  ex.decorate(b.box, b.pre, { finished: true });
  await tick(); await tick(); await tick();
  assert.strictEqual(b.box.dataset.diagram, 'failed');
  assert.ok(!b.box.classes.has('mermaid-ok'));
  assert.ok(!b.box.querySelector('.mermaid-view'));
  assert.ok(b.box.children.includes(b.pre));
});

check('output that is not an SVG is refused', async () => {
  const m = fakeMermaid(async () => ({ svg: '<div>not svg</div>' }));
  ex._reset(); window.mermaid = m;
  const b = block('mermaid', 'graph TD; X-->Y');
  ex.decorate(b.box, b.pre, { finished: true });
  await tick(); await tick(); await tick();
  assert.strictEqual(b.box.dataset.diagram, 'failed');
});

check('Mermaid that never loads falls back, and a huge source is not even tried', async () => {
  delete window.mermaid; ex._reset(); scripts.length = 0;
  const b = block('mermaid', 'graph TD; A-->B');
  ex.decorate(b.box, b.pre, { finished: true });
  scripts[0].onerror();
  await tick(); await tick();
  assert.strictEqual(b.box.dataset.diagram, 'failed');
  scripts.length = 0;
  const big = block('mermaid', 'a'.repeat(30000));
  ex.decorate(big.box, big.pre, { finished: true });
  assert.strictEqual(scripts.length, 0);
});

check('Wrap button: toggles the block and is remembered for the next block', () => {
  const a = block('js', 'x');
  ex.decorate(a.box, a.pre, { finished: true });
  const btn = a.box.querySelector('.code-wrap');
  assert.strictEqual(btn.textContent, 'Wrap');
  btn.click();
  assert.ok(a.box.classes.has('wrap'));
  assert.strictEqual(btn.textContent, 'No wrap');
  assert.strictEqual(btn.attrs['aria-pressed'], 'true');
  const b = block('py', 'y');
  ex.decorate(b.box, b.pre, { finished: true });
  assert.ok(b.box.classes.has('wrap'), 'the choice carries to the next block');
  b.box.querySelector('.code-wrap').click();
  assert.ok(!b.box.classes.has('wrap'));
});

check('tables: five or more columns get a Fit switch, fewer do not', () => {
  const wide = new El('div'); wide.classes.add('table-wrap');
  const narrow = new El('div'); narrow.classes.add('table-wrap');
  const th = (n) => Array.from({ length: n }, () => new El('th'));
  const tableOf = (n) => { const t = new El('table'); const h = new El('thead'); h.tag = 'thead'; h.append(...th(n)); t.append(h); return t; };
  wide.append(tableOf(6)); narrow.append(tableOf(3));
  const root = { querySelectorAll: () => [wide, narrow] };
  const made = [];
  wide.before = (b) => made.push(b); narrow.before = (b) => made.push(b);
  // the fake selector for 'thead th' is not supported by El: give each wrap its own
  wide.querySelectorAll = () => th(6); narrow.querySelectorAll = () => th(3);
  ex.decorateTables(root);
  assert.strictEqual(made.length, 1);
  made[0].click();
  assert.ok(wide.classes.has('fit'));
  assert.strictEqual(made[0].textContent, 'Scroll');
});

check('Mermaid is vendored, never a start-up script, and code-extras.js is on both pages', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'src', 'renderer');
  assert.ok(fs.existsSync(path.join(dir, 'vendor/mermaid.min.js')) && fs.existsSync(path.join(dir, 'vendor/mermaid-LICENSE.txt')));
  for (const page of ['index.src.html', 'chat-page.html']) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    assert.ok(!/mermaid/i.test(html), `${page} must not load Mermaid at start-up`);
    assert.ok(html.includes('<script src="code-extras.js"></script>'), page);
  }
  const bundle = fs.readFileSync(path.join(dir, 'ui.bundle.js'), 'utf8');
  assert.ok(bundle.includes('window.codeExtras'), 'ui.bundle.js has code-extras.js');
  assert.ok(!bundle.includes('__esbuild_esm_mermaid_nm'), 'the bundle does not hold Mermaid itself');
});

check('chat-core.js hands each new code block and table to codeExtras', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'renderer', 'chat-core.js'), 'utf8');
  assert.ok(src.includes('window.codeExtras?.decorate(box, pre'));
  assert.ok(src.includes('window.codeExtras?.decorateTables(root)'));
});

(async () => {
  for (const run of pending) await run();
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log('code extras: all passed');
})();
