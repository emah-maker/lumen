// Sub/superscripts in replies (renderer/markdown.js). Plain node: node test/subsup-units.js
const assert = require('assert');
const md = require('../src/renderer/markdown.js');
let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const r = (s) => md.render(s);

check('<sub> and <sup> render as elements', () => {
  assert.strictEqual(r('σ<sub>x</sub> / E'), '<p>σ<sub>x</sub> / E</p>');
  assert.strictEqual(r('x<sup>2</sup>'), '<p>x<sup>2</sup></p>');
});
check('in a list item, a heading and a table cell', () => {
  assert.match(r('* ε<sub>x</sub> = σ<sub>x</sub> / E'), /<li>ε<sub>x<\/sub> = σ<sub>x<\/sub> \/ E<\/li>/);
  assert.match(r('## CO<sub>2</sub>'), /<h\d[^>]*>CO<sub>2<\/sub>/);
  assert.match(r('| a |\n|---|\n| H<sub>2</sub>O |'), /<td>H<sub>2<\/sub>O<\/td>/);
});
check('nesting and bold inside', () => {
  assert.strictEqual(r('<sub>a<sup>b</sup></sub>'), '<p><sub>a<sup>b</sup></sub></p>');
  assert.strictEqual(r('<sub>**b**</sub>'), '<p><sub><strong>b</strong></sub></p>');
});
check('upper case tags are accepted and normalised', () => {
  assert.strictEqual(r('<SUB>x</SUB>'), '<p><sub>x</sub></p>');
});
check('attributes are rejected and stay escaped', () => {
  assert.strictEqual(r('<sub onclick=alert(1)>x</sub>'), '<p>&lt;sub onclick=alert(1)&gt;x&lt;/sub&gt;</p>');
  assert.ok(!/<sub[^>]* /.test(r('<sub class="a">x</sub>')));
  assert.ok(!r('<sup style="x">x</sup>').includes('<sup'));
  assert.ok(!r('<sub>a</sub onclick>').includes('<sub'));
});
check('unbalanced or mismatched tags stay escaped', () => {
  assert.strictEqual(r('<sub>open'), '<p>&lt;sub&gt;open</p>');
  assert.strictEqual(r('close</sup>'), '<p>close&lt;/sup&gt;</p>');
  assert.strictEqual(r('<sub>a</sup>'), '<p>&lt;sub&gt;a&lt;/sup&gt;</p>');
  assert.strictEqual(r('<sub><sub>a</sub>'), '<p>&lt;sub&gt;<sub>a</sub></p>');
});
check('inside code spans and fenced blocks they stay literal', () => {
  assert.strictEqual(r('`<sub>x</sub>`'), '<p><code>&lt;sub&gt;x&lt;/sub&gt;</code></p>');
  const block = r('```\n<sub>x</sub> H~2~O\n```');
  assert.ok(!/<sub>/.test(block) && block.includes('&lt;sub&gt;x&lt;/sub&gt; H~2~O'), block);
});
check('XSS attempts are escaped', () => {
  for (const s of ['<sub><script>alert(1)</script></sub>', '<sub><img src=x onerror=alert(1)></sub>', '<sup><a href="javascript:1">x</a></sup>', '<sub/onclick=1>x</sub>', '<sub\nonclick=1>x</sub>']) {
    const html = r(s).replace(/<\/?(?:sub|sup|p)>|<br>/g, '');
    assert.ok(!/<[a-z]/i.test(html), `${s} -> ${html}`);
  }
});
check('H~2~O is a subscript; ~~strike~~, "~5 and ~10" and paths are left alone', () => {
  assert.strictEqual(r('H~2~O'), '<p>H<sub>2</sub>O</p>');
  assert.ok(!r('~~gone~~').includes('<sub'));
  assert.ok(!r('about ~5 and ~10').includes('<sub'));
  assert.ok(!r('see ~/a and ~/b').includes('<sub'));
  assert.ok(!r('https://x.org/~u/a~b').includes('<sub'));
});
check('x^2^ is a superscript; a lone ^ and regexes are left alone', () => {
  assert.strictEqual(r('x^2^'), '<p>x<sup>2</sup></p>');
  assert.ok(!r('a ^ b and ^start').includes('<sup'));
  assert.ok(!r('`x^2^`').includes('<sup'));
});
check('math is not touched: $x^2^$ stays a formula', () => {
  assert.ok(!r('$x^2^3$').includes('<sup>2</sup>'));
});
check('plainScripts: clean text for copy, export and notifications', () => {
  assert.strictEqual(md.plainScripts('σ<sub>x</sub> and ε<sub>xy</sub>'), 'σ_x and ε_(xy)');
  assert.strictEqual(md.plainScripts('m<sup>2</sup> H~2~O x^2^'), 'm^2 H_2O x^2');
  assert.strictEqual(md.plainScripts('<sub>a<sup>b</sup></sub>'), '_(a^b)');
  assert.strictEqual(md.plainScripts('`<sub>x</sub>` and $a^2^$'), '`<sub>x</sub>` and $a^2^$');
  assert.strictEqual(md.plainScripts('<sub onclick=1>x</sub> <sub>open'), '<sub onclick=1>x</sub> <sub>open');
  assert.strictEqual(md.plainScripts('no marks'), 'no marks');
});
check('chat export and notification text use the clean form', () => {
  const { toMarkdown } = require('../src/features/chat-store.js');
  const out = toMarkdown({ title: 't' }, [{ role: 'assistant', text: 'σ<sub>x</sub>' }]);
  assert.ok(out.includes('σ_x') && !out.includes('<sub>'), out);
  const { notification } = require('../src/features/chat-runs.js');
  assert.ok(notification('done', { reply: 'σ<sub>x</sub> is stress' }).title.includes('σ_x'));
});

process.exit(failed ? 1 : 0);
