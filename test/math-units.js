// Math in replies (renderer/markdown.js with the vendored Temml). Plain node: node test/math-units.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const md = require('../renderer/markdown.js');
let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

// Without Temml: the formula's source, marked, never read as markdown.
check('no Temml: inline source kept in a code span', () => {
  const html = md.render('Area is $\\pi r^2$ here.');
  assert.match(html, /<code class="math-src"[^>]*>\\pi r\^2<\/code>/);
});
check('money is not math', () => {
  for (const s of ['It costs $5 and $10.', 'From $5-$10 a month', 'Pay $ 5 now $', 'a \\$x\\$ b']) {
    const { maths } = md.liftMath(s);
    assert.strictEqual(maths.length, 0, s);
  }
});
check('\\$ reads as a dollar sign', () => assert.match(md.render('It is \\$5.'), /It is \$5\./));
check('emphasis inside math is left alone', () => {
  const html = md.render('$a*b*c$ and $x_1 + y_1$');
  assert.ok(!html.includes('<em>'), html);
});
check('code is never math', () => {
  const { maths } = md.liftMath('Run `echo $HOME $PATH` then\n```\nprice=$1 $2\n$$x$$\n```\n');
  assert.strictEqual(maths.length, 0);
});
check('display math on its own lines is a block, between paragraphs', () => {
  const { maths } = md.liftMath('Before\n$$\n\\int_0^1 x\\,dx\n$$\nAfter');
  assert.strictEqual(maths.length, 1);
  assert.strictEqual(maths[0].display, true);
  const html = md.render('Before\n$$\n\\int_0^1 x\\,dx\n$$\nAfter');
  assert.match(html, /<p>Before<\/p><pre class="math-src"[^>]*>\\int_0\^1 x\\,dx<\/pre><p>After<\/p>/);
});
check('\\[ \\], \\( \\) and \\begin{align}', () => {
  const { maths } = md.liftMath('\\[a=b\\]\n\nso \\(c\\) and\n\\begin{align}x&=1\\\\y&=2\\end{align}');
  assert.deepStrictEqual(maths.map((m) => m.display), [true, false, true]);
});
check('a | inside math does not split a table cell', () => {
  const html = md.render('| a | b |\n|---|---|\n| $|x|$ | 2 |');
  assert.match(html, /<td>.*\|x\|.*<\/td><td>2<\/td>/);
});
check('streaming: a blank line inside $$ is not a block end', () => {
  const s = 'Intro\n\n$$\na\n\nb';
  assert.strictEqual(md.stableLength(s), 'Intro\n\n'.length);
  assert.strictEqual(md.inMath('x $$ y'), true);
  assert.strictEqual(md.inMath('x $$ y $$'), false);
});

// With Temml: MathML, with the source kept as an annotation (copying a selection keeps the LaTeX).
const ctx = { globalThis: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'temml.min.js'), 'utf8') + ';globalThis.temml = temml;', ctx);
globalThis.temml = ctx.globalThis.temml;
check('Temml: inline MathML', () => {
  const html = md.render('Euler: $e^{i\\pi}+1=0$.');
  assert.match(html, /<math[^>]*>/);
  assert.match(html, /<annotation encoding="application\/x-tex">e\^\{i\\pi\}\+1=0<\/annotation>/);
  assert.ok(!/display="block"/.test(html));
});
check('Temml: display block', () => {
  const html = md.render('$$\n\\frac{a}{b}\n$$');
  assert.match(html, /^<div class="math-block" role="math"><math[^>]*display="block"/);
});
check('Temml: bad LaTeX falls back to its source, not a red error', () => {
  const html = md.render('Bad: $\\frac{a$ end');
  assert.ok(!html.includes('temml-error'), html);
});
check('Temml: HTML in a formula stays text', () => {
  const html = md.render('$\\text{<img src=x onerror=alert(1)>}$');
  assert.ok(!/<img/i.test(html), html);
});
delete globalThis.temml;

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
