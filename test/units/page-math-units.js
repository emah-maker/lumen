// [page math] renderer/page-math.js: formulas in a page the AI wrote are typeset as MathML before the sandboxed preview shows it
// (the preview allows no network, so a page's MathJax/KaTeX CDN script never loads). Plain Node, with the vendored Temml.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PM = require('../../src/renderer/page-math');
const canvas = require('../../src/renderer/chat-canvas');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const ctx = { globalThis: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'vendor', 'temml.min.js'), 'utf8') + ';globalThis.temml = temml;', ctx);
const temml = ctx.globalThis.temml;
const maths = (s) => (s.match(/<math/g) || []).length;
const strip = (s) => s.replace(/<div[^>]*><math[\s\S]*?<\/math><\/div>|<math[\s\S]*?<\/math>/g, '[M]');

// The page from the user's report (2026-11-16): display formulas, a cases block with raw "<" (0<x<a), inline $Q(y)$, money, a script.
const page = [
  '<h2>2. Reactions and internal forces</h2>',
  '<p>$$\\sum M_A=0:\\qquad R_D L-P_1 a-P_2 c=0$$ $$\\boxed{R_D=\\frac{P_1a+P_2c}{L}}$$</p>',
  '<p>Shear force: $$ \\boxed{V(x)=\\begin{cases}R_A,&0<x<a\\\\R_A-P_1,&a<x<c\\\\-R_D,&c<x<L\\end{cases}} $$</p>',
  '<h2>3. Section equations</h2>',
  '<p>Shear stress, with $Q(y)=\\frac{b}{2}\\left(\\frac{h^2}{4}-y^2\\right)$: \\(\\tau=\\frac{VQ}{Ib}\\) and \\[I=\\frac{bh^3}{12}\\]</p>',
  '<p>It costs $5 and $10, and <code>$$x$$</code> stays code.</p>',
  '<script>var s = "$$y$$";</script>',
].join('\n');
const out = PM.mathify(page, temml);
check('every formula of the report is MathML (3 display + $Q$, \\(\\), \\[\\] = 6)', maths(out) === 6, `${maths(out)}\n${strip(out)}`);
check('the raw "<" in the cases block no longer swallows the page: the next heading survives', /<h2>3\. Section equations<\/h2>/.test(out) && !/0<x<a/.test(out), strip(out));
check('money, <code> and <script> are left alone', /costs \$5 and \$10/.test(out) && /<code>\$\$x\$\$<\/code>/.test(out) && /var s = "\$\$y\$\$"/.test(out), strip(out));
check('a "formula" spanning HTML tags is not math', PM.mathify('<p>$$ a </p><p> b $$</p>', temml) === '<p>$$ a </p><p> b $$</p>');
check('entities inside a formula are read as their characters', maths(PM.mathify('<p>$$0 &lt; x &lt; a$$</p>', temml)) === 1);
check('unreadable LaTeX is left as written', PM.mathify('<p>$$\\frac{a$$</p>', temml) === '<p>$$\\frac{a$$</p>');
check('without Temml or without math, the page is untouched', PM.mathify(page, null) === page && PM.mathify('<p>hi</p>', temml) === '<p>hi</p>');
check('hasMath', PM.hasMath(page) && !PM.hasMath('<p>$5 and $ 10</p>'));
// The preview document: math is typeset there (with Temml loaded), SVG is not touched.
globalThis.temml = temml;
check('frameDocument typesets an HTML page\'s math', maths(canvas.frameDocument('html', page)) === 6);
check('frameDocument leaves an SVG alone', !/<math/.test(canvas.frameDocument('svg', '<svg><text>$$x$$</text></svg>')));
delete globalThis.temml;

console.log(failures ? `\n${failures} failed` : '\nall page-math checks passed');
process.exit(failures ? 1 : 0);
