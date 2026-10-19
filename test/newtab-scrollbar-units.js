// New-tab overlay scrollbar wiring (src/renderer/newtab.html + newtab-scrollbar.js): pure checks, no window.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = async function newtabScrollbarUnits(check) {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const html = read('src/renderer/newtab.html');
  const js = read('src/renderer/newtab-scrollbar.js');
  check('new tab scrollbar: no reserved gutter, native scrollbar off for every background', !/scrollbar-gutter\s*:\s*stable/.test(html) && /html\s*\{\s*scrollbar-width:\s*none/.test(html) && /html::-webkit-scrollbar\s*\{\s*display:\s*none/.test(html), '');
  check('new tab scrollbar: the thumb is a fixed overlay, hidden until html.show-scrollbar', /#sbar\s*\{[^}]*position:\s*fixed[^}]*opacity:\s*0/.test(html) && /html\.show-scrollbar #sbar\s*\{\s*opacity:\s*1/.test(html), '');
  check('new tab scrollbar: the script is loaded by the page', /<script src="newtab-scrollbar\.js"><\/script>/.test(html), '');

  // Drive the script with a tiny fake DOM.
  const listeners = {};
  const classes = new Set();
  const mk = () => ({ style: {}, children: [], setAttribute() {}, appendChild(c) { this.children.push(c); }, addEventListener() {} });
  const root = { clientWidth: 1000, clientHeight: 500, scrollHeight: 2000, scrollTop: 0, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  const doc = { documentElement: root, scrollingElement: root, body: mk(), createElement: mk, addEventListener: (t, f) => { listeners[t] = f; } };
  const win = { addEventListener() {}, };
  vm.runInNewContext(js, { document: doc, window: win, ResizeObserver: class { observe() {} }, setTimeout: () => 0 });
  check('new tab scrollbar: hidden while the pointer is away from the edge', !classes.has('show-scrollbar'), '');
  listeners.mousemove({ clientX: 990, clientY: 10 });
  check('new tab scrollbar: shown with the pointer within 16px of the right edge', classes.has('show-scrollbar'), '');
  listeners.mousemove({ clientX: 500, clientY: 10 });
  check('new tab scrollbar: hidden again when the pointer leaves the edge', !classes.has('show-scrollbar'), '');
  const thumbH = doc.body.children[0].children[0].style.height;
  check('new tab scrollbar: thumb height follows the visible share (500/2000 of 500px = 125px)', thumbH === '125px', thumbH);
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
