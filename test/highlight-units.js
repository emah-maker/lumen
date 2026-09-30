// Code colours in chat replies (renderer/highlight.js): the tokenizer colours, escapes, and leaves unknown languages alone.
const assert = require('assert');
global.window = {};
require('../renderer/highlight.js');
const h = window.highlightCode.test;

const js = h('const x = foo("a\\"b", 42); // hi', 'javascript');
assert.ok(js.includes('<span class="tk-kw">const</span>'));
assert.ok(js.includes('<span class="tk-fn">foo</span>'));
assert.ok(js.includes('<span class="tk-str">"a\\"b"</span>'));
assert.ok(js.includes('<span class="tk-num">42</span>'));
assert.ok(js.includes('<span class="tk-com">// hi</span>'));
assert.strictEqual(h('a < b && "<i>"', 'js'), 'a &lt; b &amp;&amp; <span class="tk-str">"&lt;i&gt;"</span>', 'everything is escaped');
assert.ok(h('# note\nx = 1', 'python').startsWith('<span class="tk-com"># note</span>'));
assert.ok(h('{"a": 1}', 'json').includes('<span class="tk-key">"a"</span>'), 'JSON keys apart from values');
assert.ok(h('SELECT 1', 'sql').includes('<span class="tk-kw">SELECT</span>'), 'SQL keywords in any case');
assert.strictEqual(h('x', 'brainfuck'), null, 'unknown languages stay plain');
assert.strictEqual(h('x'.repeat(70000), 'js'), null, 'huge blocks stay plain');
console.log('highlight units: all passed');
