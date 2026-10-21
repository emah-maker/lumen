// More code languages in replies (renderer/highlight.js): html/xml, yaml, toml, diff, php, ruby, kotlin, swift.
const assert = require('assert');
global.window = {};
require('../../src/renderer/highlight.js');
const h = window.highlightCode.test;

const html = h('<div class="a" id=\'b\'>hi & <b>x</b></div><!-- c -->', 'html');
assert.ok(html.includes('<span class="tk-kw">&lt;div</span>'), html);
assert.ok(html.includes('<span class="tk-fn">class</span>') && html.includes('<span class="tk-str">"a"</span>'), html);
assert.ok(html.includes('<span class="tk-com">&lt;!-- c --&gt;</span>'), html);
assert.ok(html.includes('hi &amp; '), 'text between tags is plain and escaped');
assert.ok(!html.includes('<div'), 'no raw tags in the output');
assert.strictEqual(h('<a href="x">', 'xml'), h('<a href="x">', 'html'), 'xml and svg read as html');
assert.ok(h('title="not in a tag"', 'html').includes('title="not in a tag"'), 'quotes outside tags stay plain');

const y = h('name: web # c\nports:\n  - "80"\nok: true', 'yaml');
assert.ok(y.includes('<span class="tk-key">name</span>') && y.includes('<span class="tk-key">ports</span>'), y);
assert.ok(y.includes('<span class="tk-com"># c</span>') && y.includes('<span class="tk-kw">true</span>') && y.includes('<span class="tk-str">"80"</span>'), y);
const t = h('[pkg]\nname = "x"\nn = 3', 'toml');
assert.ok(t.includes('<span class="tk-key">name</span>') && t.includes('<span class="tk-num">3</span>'), t);

const d = h('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old <b>\n+new\n ctx', 'diff');
assert.ok(d.includes('<span class="tk-add">+new</span>') && d.includes('<span class="tk-del">-old &lt;b&gt;</span>'), d);
assert.ok(d.includes('<span class="tk-hunk">@@ -1 +1 @@</span>') && d.includes('<span class="tk-meta">--- a/x</span>'), d);
assert.ok(d.includes('\n ctx'), 'context lines are plain');

assert.ok(h('<?php\n$x = 1; // c\n# d\nfunction f() { return $x; }', 'php').includes('<span class="tk-kw">function</span>'));
assert.ok(h('# c\ndef f\n  puts "x"\nend', 'ruby').includes('<span class="tk-kw">def</span>'));
assert.ok(h('fun main() { val x = 1 }', 'kotlin').includes('<span class="tk-kw">fun</span>'));
assert.ok(h('func f() { let x = 1 }', 'swift').includes('<span class="tk-kw">func</span>'));
console.log('markdown highlight: all passed');
