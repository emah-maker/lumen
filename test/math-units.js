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
  assert.strictEqual(md.inMath('x\n$$\ny'), true);
  assert.strictEqual(md.inMath('x\n$$\ny\n$$'), false);
});

check('price tiers are not math', () => {
  for (const s of ['- **Nopa** ($$) - Californian\n- **Zuni** ($$$) - Mediterranean', 'Price range: $$ to $$$$', 'Cheap ($) to fancy ($$$$)']) {
    assert.strictEqual(md.liftMath(s).maths.length, 0, s);
    assert.strictEqual(md.openMath(s), -1, s);
  }
});
check('$$ on its own line with spaces inside is a block', () => {
  const { maths } = md.liftMath('Then\n$$ x^2 + 1 $$\nso');
  assert.strictEqual(maths.length, 1);
  assert.strictEqual(maths[0].display, true);
});
check('dollars in a web address stay in the link', () => {
  const html = md.render('See https://graph.microsoft.com/v1.0/me/messages?$select=subject&$top=5 now');
  assert.match(html, /<a href="https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages\?\$select=subject&amp;\$top=5">/);
  assert.strictEqual(md.liftMath('[x](https://a.b/?$a$b)').maths.length, 0);
});
check('escaped citations \\[1\\] stay brackets', () => {
  const html = md.render('as shown \\[1\\] and \\[2, 3\\].');
  assert.match(html, /as shown \[1\] and \[2, 3\]\./);
});
check('more environments: vmatrix, aligned, array', () => {
  for (const env of ['vmatrix', 'Bmatrix', 'aligned', 'gathered', 'array', 'smallmatrix']) {
    assert.strictEqual(md.liftMath(`\\begin{${env}}a\\end{${env}}`).maths.length, 1, env);
  }
});
check('a formula indented under a list item stays in it', () => {
  const html = md.render('1. Solve:\n   $$x^2=4$$\n2. Done');
  assert.match(html, /^<ol><li>Solve:<pre class="math-src"[^>]*>x\^2=4<\/pre><\/li><li>Done<\/li><\/ol>$/);
});
check('streaming: an unfinished formula is found, money is not', () => {
  assert.strictEqual(md.openMath('The area is $\\pi r'), 'The area is '.length);
  assert.strictEqual(md.openMath('Let \\(\\alpha + '), 'Let '.length);
  assert.strictEqual(md.openMath('So\n\\begin{align}x&=1'), 'So\n'.length);
  assert.strictEqual(md.openMath('It costs $5 and'), -1);
  assert.strictEqual(md.openMath('Done: $x$.'), -1);
});
check('streaming: stableLength is linear (long math reply)', () => {
  const big = Array.from({ length: 3000 }, (_, k) => `Line ${k} with $x_${k}$\n`).join('\n');
  const t0 = Date.now();
  md.stableLength(big);
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
});

check('subscripts open a formula (H$_2$O), shell variables do not', () => {
  assert.strictEqual(md.liftMath('H$_2$O and CO$_2$ emissions').maths.length, 2);
  assert.strictEqual(md.liftMath('export PATH=$PATH:$HOME/bin').maths.length, 0);
});
check('```math fences are display math', () => {
  const { maths } = md.liftMath('See:\n```math\n\\int_0^1 x\\,dx\n```\nend');
  assert.strictEqual(maths.length, 1);
  assert.strictEqual(maths[0].display, true);
});
check('streaming: price tiers do not stop the stable prefix', () => {
  const s = '- **Nopa** ($$) - Californian\n\nNext paragraph\n\nMore';
  assert.ok(md.stableLength(s) > 30, String(md.stableLength(s)));
});
check('streaming: a command being typed waits', () => {
  assert.strictEqual(md.openMath('So\n\\begin{alig'), 3);
  assert.strictEqual(md.openMath('Then \\'), 5);
});
check('a formula after a blank line under a list item stays in it', () => {
  const html = md.render('1. Step\n\n   $$x=1$$\n\n2. Next');
  assert.match(html, /^<ol><li>Step<pre class="math-src"[^>]*>x=1<\/pre><\/li><li>Next<\/li><\/ol>$/);
});
check('private-use characters in the text are dropped, not swapped for formulas', () => {
  assert.ok(!md.render('a 0 b $x$').includes(''));
});

check('clearly-math formulas may touch a word: $n$th, 5 $\\mu$m, $\\times$2', () => {
  for (const s of ['the $n$th term', 'about 5 $\\mu$m wide', 'roughly $\\sim$10 users', 'scaled $\\times$2']) assert.strictEqual(md.liftMath(s).maths.length, 1, s);
  assert.strictEqual(md.liftMath('export PATH=$PATH:$HOME/bin').maths.length, 0);
  assert.strictEqual(md.liftMath('From $5-$10 a month').maths.length, 0);
});
check('a price legend at the start of lines is not math', () => {
  assert.strictEqual(md.liftMath('$$ – moderate\n$$$ – expensive').maths.length, 0);
});
check('streaming: formulas starting with a digit, ( or | wait; money and shell text do not', () => {
  assert.strictEqual(md.openMath('Solve $2x+1'), 'Solve '.length);
  assert.strictEqual(md.openMath('Expand $(a+b'), 'Expand '.length);
  assert.strictEqual(md.openMath('So $|x'), 'So '.length);
  assert.strictEqual(md.openMath('Water is H$_2'), 'Water is H'.length);
  assert.strictEqual(md.openMath('It costs $5 and'), -1);
  assert.strictEqual(md.openMath('Set $HOME to'), -1);
});

check('streaming: everyday money and prose variables never hold the line', () => {
  for (const s of ['The Pro plan costs $20/month and', 'Revenue grew from $1.2M in', 'From $5k-', 'Only $9.99 now', 'PHP variables like $name and']) assert.strictEqual(md.openMath(s), -1, s);
  assert.strictEqual(md.openMath('Solve $2x+1'), 'Solve '.length);
});
check('streaming: a stray \\( in a path holds only a short tail, and never the stable prefix', () => {
  const long = `C:\\Users\\(name)\\docs ${'word '.repeat(80)}`;
  assert.strictEqual(md.openMath(long), -1);
  assert.ok(md.stableLength('Path C:\\Users\\[x\n\nNext\n\nMore') > 10);
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
  assert.match(html, /^<div class="math-block"><math[^>]*display="block"/);
});
check('Temml: bad LaTeX falls back to its source, not a red error', () => {
  const html = md.render('Bad: $\\frac{a$ end');
  assert.ok(!html.includes('temml-error'), html);
});
check('Temml: a display formula inside a sentence is drawn at display size', () => {
  assert.match(md.render('so $$\\sum_{i=1}^n i$$ holds'), /\\displaystyle/);
});
check('Temml: a long inline formula gets its own scroller; an environment in a sentence renders', () => {
  assert.match(md.render('Long: $a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9$ ok'), /<span class="math-inline"><math/);
  const html = md.render('We have \\begin{aligned}x&=1\\end{aligned} and more');
  assert.ok(!html.includes('math-src'), html);
});
check('Temml: siunitx and physics commands render', () => {
  for (const t of ['$\\SI{5}{kg}$', '$\\dv{f}{x}$', '$\\abs{x}$']) assert.ok(!md.render(t).includes('math-src'), t);
});
check('Temml: siunitx units, \\num exponents, \\dv[2] and physics vectors render', () => {
  for (const t of ['$\\SI{9.8}{\\meter\\per\\second\\squared}$', '$\\si{\\kilo\\gram}$', '$\\num{3e8}$', '$\\dv[2]{y}{x}$', '$\\vb{E} = -\\grad V$', '$\\bar{x}$']) {
    const html = md.render(t);
    assert.ok(!html.includes('math-src'), `${t} -> ${html.slice(0, 120)}`);
  }
  assert.match(md.render('$\\num{3e8}$'), /×|&#xd7;|times/);
});
check('Temml: HTML in a formula stays text', () => {
  const html = md.render('$\\text{<img src=x onerror=alert(1)>}$');
  assert.ok(!/<img/i.test(html), html);
});
delete globalThis.temml;

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
