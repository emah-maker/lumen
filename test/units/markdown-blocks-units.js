// Markdown correctness in replies (renderer/markdown.js): block quotes, nested lists, task lists, rules, strike,
// nested emphasis, backslash escapes, reference links, citations and footnotes. Plain node: node test/units/markdown-blocks-units.js
const assert = require('assert');
const md = require('../../src/renderer/markdown.js');
let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const r = (s) => md.render(s);

// B1
check('B1: a block quote renders as <blockquote>, not &gt; text', () => {
  const html = r('> A quote *here*\n> second line\n\nafter');
  assert.strictEqual(html, '<blockquote><p>A quote <em>here</em><br>second line</p></blockquote><p>after</p>');
  assert.ok(!html.includes('&gt;'));
});
check('B1: quotes nest and hold lists and code', () => {
  assert.match(r('> outer\n>> inner'), /<blockquote><p>outer<\/p><blockquote><p>inner<\/p><\/blockquote><\/blockquote>/);
  assert.match(r('> - a\n> - b'), /<blockquote><ul><li>a<\/li><li>b<\/li><\/ul><\/blockquote>/);
  assert.match(r('> ```js\n> x > y\n> ```'), /<blockquote><pre data-lang="js"><code>x &gt; y<\/code><\/pre><\/blockquote>/);
});
check('B1: a > inside a fence or mid-line stays text', () => {
  assert.ok(!r('```\n> not a quote\n```').includes('<blockquote>'));
  assert.ok(!r('a > b').includes('<blockquote>'));
});

// B2
check('B2: nested bullets stay nested', () => {
  assert.strictEqual(r('- a\n  - b\n    - c\n- d'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
});
check('B2: an ordered list keeps counting across nested items', () => {
  const html = r('1. first\n   - y\n2. second\n   - z\n3. third');
  assert.strictEqual((html.match(/<ol/g) || []).length, 1, html);
  assert.strictEqual(html, '<ol><li>first<ul><li>y</li></ul></li><li>second<ul><li>z</li></ul></li><li>third</li></ol>');
});
check('B2: mixed bullet then ordered lists', () => {
  assert.strictEqual(r('- a\n  - b\n1. x\n   - y\n2. z'), '<ul><li>a<ul><li>b</li></ul></li></ul><ol><li>x<ul><li>y</li></ul></li><li>z</li></ol>');
});
check('B2: an ordered list that starts at 3 keeps its number; blank lines between items keep one list', () => {
  assert.match(r('3. c\n4. d'), /^<ol start="3">/);
  assert.strictEqual((r('1. a\n\n2. b\n\n3. c').match(/<ol/g) || []).length, 1);
});
check('B2: an item can hold a second paragraph and a code block', () => {
  assert.strictEqual(r('1. a\n\n   more\n2. b\n   ```js\n   x\n   ```'), '<ol><li><p>a</p><p>more</p></li><li>b<pre data-lang="js"><code>x</code></pre></li></ol>');
});
check('B2: four-space and tab nesting', () => {
  assert.match(r('- a\n    - b'), /<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/);
  assert.match(r('- a\n\t- b'), /<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/);
});
check('B2: text after a list (no blank line) is a paragraph', () => {
  assert.strictEqual(r('- a\n- b\ntext'), '<ul><li>a</li><li>b</li></ul><p>text</p>');
});

// B3
check('B3: task lists render checkboxes', () => {
  const html = r('- [x] done\n- [ ] todo');
  assert.ok(html.includes('<li class="task"><input type="checkbox" disabled checked> done</li>'), html);
  assert.ok(html.includes('<li class="task"><input type="checkbox" disabled> todo</li>'), html);
});
check('B3: ~~strike~~ renders', () => {
  assert.strictEqual(r('a ~~gone~~ b'), '<p>a <del>gone</del> b</p>');
  assert.ok(!r('x ~~ y ~~ z').includes('<del>'));
});
check('B3: --- and *** are rules; a bullet is not', () => {
  assert.strictEqual(r('above\n\n---\n\nbelow'), '<p>above</p><hr><p>below</p>');
  assert.strictEqual(r('***'), '<hr>');
  assert.strictEqual(r('* * *'), '<hr>');
  assert.ok(!r('- a').includes('<hr>'));
});
check('B3: a table separator is still a table', () => {
  assert.ok(r('| a | b |\n|---|---|\n| 1 | 2 |').includes('<table>'));
});

// B4
check('B4: bold holding italic', () => {
  assert.strictEqual(r('**bold *nested* inside**'), '<p><strong>bold <em>nested</em> inside</strong></p>');
  assert.strictEqual(r('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
  assert.strictEqual(r('***both***'), '<p><strong><em>both</em></strong></p>');
});
check('B4: bold around a link and code', () => {
  assert.match(r('**[t](https://x.com) and `c`**'), /<strong><a href="https:\/\/x.com">t<\/a> and <code>c<\/code><\/strong>/);
});
check('B4: backslash escapes', () => {
  assert.strictEqual(r('\\*not italic\\* and \\_x\\_ and \\\\'), '<p>*not italic* and _x_ and \\</p>');
  assert.strictEqual(r('\\<b\\> \\#x'), '<p>&lt;b&gt; #x</p>');
  assert.strictEqual(r('C:\\Users\\me'), '<p>C:\\Users\\me</p>');
  assert.strictEqual(r('`\\*` code'), '<p><code>\\*</code> code</p>');
});
check('B4: snake_case and spaced stars are not emphasis', () => {
  assert.strictEqual(r('use snake_case_name and 2 * 3 * 4'), '<p>use snake_case_name and 2 * 3 * 4</p>');
  assert.strictEqual(r('_it_ and __bold__'), '<p><em>it</em> and <strong>bold</strong></p>');
});
check('B4: an escaped pipe stays in its table cell', () => {
  assert.match(r('| a | b |\n|---|---|\n| x \\| y | z |'), /<td>x \| y<\/td><td>z<\/td>/);
});

// B5
check('B5: [1] citations link to their definition and the definition line is hidden', () => {
  const html = r('Claim [1] and more [2].\n\n[1]: https://a.com/x?y=1&z=2\n[2]: https://b.com "Title"');
  assert.ok(html.includes('<a class="md-cite" href="https://a.com/x?y=1&amp;z=2">[1]</a>'), html);
  assert.ok(html.includes('<a class="md-cite" href="https://b.com">[2]</a>'), html);
  assert.ok(!html.includes('[1]:') && !html.includes('Title'), html);
});
check('B5: [1][2] side by side are two citations', () => {
  const html = r('x [1][2]\n\n[1]: https://a.com\n[2]: https://b.com');
  assert.strictEqual((html.match(/md-cite/g) || []).length, 2, html);
});
check('B5: [text][id] and [id][] reference links', () => {
  const html = r('see [the docs][d] and [d][]\n\n[D]: https://d.com');
  assert.strictEqual((html.match(/<a[^>]*href="https:\/\/d.com"/g) || []).length, 2, html);
});
check('B5: an undefined [1] stays text; only http(s) definitions count', () => {
  assert.strictEqual(r('a [1] b'), '<p>a [1] b</p>');
  const html = r('[x]\n\n[x]: javascript:alert(1)');
  assert.ok(!html.includes('<a'), html);
});
check('B5: a definition inside a code fence is kept as code', () => {
  const html = r('```\n[1]: https://a.com\n```\n\nsee [1]');
  assert.ok(html.includes('[1]: https://a.com'), html);
  assert.ok(!html.includes('<a'), html);
});
check('B5: footnotes number in order of use and list at the end', () => {
  const html = r('A[^b] and B[^a].\n\n[^a]: Note a.\n[^b]: Note b\n    continues.');
  assert.ok(html.includes('<sup class="fn-ref" data-fn="1" title="Note b continues.">1</sup>'), html);
  assert.ok(html.includes('data-fn="2"'), html);
  assert.ok(html.endsWith('<section class="footnotes"><ol><li>Note b continues.</li><li>Note a.</li></ol></section>'), html);
  assert.strictEqual(r('x[^zz]'), '<p>x[^zz]</p>');
});

// Safety
check('markdown stays safe: no raw HTML, no javascript: links', () => {
  const html = r('<script>alert(1)</script> [x](javascript:alert(1)) > <img src=x onerror=y>\n\n> <b>q</b>\n\n- <i>l</i>\n\n[r]: https://a.com" onmouseover="x\n\n[r]');
  assert.ok(!/<(script|img|b|i)[ >]/.test(html), html);
  assert.ok(!/href="javascript/.test(html) && !/<a [^>]*on\w+=/.test(html), html);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('markdown blocks: all passed');
