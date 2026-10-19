// A page that behaves like a Google Doc as far as the `document` tool can tell (test/document-tool.js): an editable body whose caret lives
// in the page, the editor's shortcuts (Ctrl+F Find, Ctrl+H Find and replace, Ctrl+Alt+0-6 styles, Ctrl+Shift+Down/Up by paragraph), and
// an export (/document/d/<id>/export?format=txt|html) that follows the document a moment AFTER an edit, as Docs' saved copy does.
// Not Google Docs: it only mimics the keyboard and the export, so the tool's logic can be tested offline.
const IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const DOC_HTML = `<h1>Abstract</h1><p>We measured the spring constant of a coil.</p>
<h1>Methods</h1><p>A mass hung from the spring and we timed ten swings.</p><h2>Setup</h2><p>Clamp the stand to the bench.</p><p><img src="${IMG}" alt="apparatus"></p><table><tbody><tr><td>mass</td><td>time</td></tr><tr><td>100</td><td>4.1</td></tr></tbody></table>
<h1>Results</h1><p>The graphs show a straight line.</p><p><img src="${IMG}" alt="graph one"></p><p><img src="${IMG}" alt="graph two"></p><p><img data-math="x^2" src="${IMG}" alt="equation"></p>
<h1>Discussion</h1><p>The spring behaved as expected.</p>`;

const PAGE = (docHtml) => `<!doctype html><html><head><title>Lab report - Google Docs</title><style>
body{font:16px sans-serif;margin:0}#doc{margin:20px;min-height:300px;outline:none}#find,#fr{display:none;margin:8px;padding:4px;border:1px solid #888}
#fr.on,#find.on{display:block}table{border-collapse:collapse}td{border:1px solid #888;padding:2px 6px}img{width:20px;height:20px}</style></head><body>
<div id="find"><input id="fi" type="text" aria-label="Find"></div>
<div id="fr" class="modal-dialog" role="dialog"><input id="f1" type="text" aria-label="Find"><input id="f2" type="text" aria-label="Replace with">
<button id="b-next">Next</button><button id="b-rep">Replace</button><button id="b-all">Replace all</button></div>
<div id="doc" contenteditable="true">${docHtml}</div>
<script>
const doc = document.getElementById('doc'), find = document.getElementById('find'), fi = document.getElementById('fi');
const fr = document.getElementById('fr'), f1 = document.getElementById('f1'), f2 = document.getElementById('f2');
window.__log = [];
const text = () => [...doc.children].map((el) => el.tagName === 'TABLE' ? [...el.rows].map((r) => [...r.cells].map((c) => c.textContent).join('\\t')).join('\\n') : el.textContent).join('\\n');
const sync = () => fetch('/sync', { method: 'POST', body: JSON.stringify({ txt: text(), html: doc.innerHTML }) });
new MutationObserver(sync).observe(doc, { subtree: true, childList: true, characterData: true, attributes: true });
sync();
const sel = () => getSelection();
const blockOf = (node) => { let n = node; while (n && n.parentNode !== doc) n = n.parentNode; return n; };
const matches = (q) => {
  const out = [], needle = q.toLowerCase();
  if (!needle) return out;
  const walk = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) { const t = n.data.toLowerCase(); let i = 0; while ((i = t.indexOf(needle, i)) >= 0) { out.push({ n, i, len: needle.length }); i += needle.length; } }
  return out;
};
// Docs' own undo is not the browser's: typing into its Find boxes must not be a step in the document's undo history.
for (const box of [fi, f1, f2]) box.addEventListener('beforeinput', (e) => { if (e.inputType === 'insertText' && e.data) { e.preventDefault(); box.value = box.value.slice(0, box.selectionStart) + e.data + box.value.slice(box.selectionEnd); box.dispatchEvent(new Event('input')); } });
let cur = 0, found = [];
const showMatch = (m) => { const r = document.createRange(); r.setStart(m.n, m.i); r.setEnd(m.n, m.i + m.len); sel().removeAllRanges(); sel().addRange(r); };
fi.addEventListener('input', () => { found = matches(fi.value); cur = 0; });
fi.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); cur = (cur + 1) % Math.max(1, found.length); }
  if (e.key === 'Escape') { e.preventDefault(); find.classList.remove('on'); doc.focus(); if (found[cur]) showMatch(found[cur]); }
});
let rcur = 0;
const replaceIn = (all) => {
  const q = f1.value, rep = f2.value, hits = matches(q);
  if (!hits.length) return;
  doc.focus();
  for (const m of (all ? hits.reverse() : [hits[Math.min(rcur, hits.length - 1)]])) { showMatch(m); document.execCommand('insertText', false, rep); }
};
document.getElementById('b-all').onclick = () => replaceIn(true);
document.getElementById('b-next').onclick = () => { rcur = 0; };
document.getElementById('b-rep').onclick = () => replaceIn(false);
fr.addEventListener('keydown', (e) => { if (e.key === 'Escape') { fr.classList.remove('on'); doc.focus(); } });
const restyle = (level) => { doc.focus(); document.execCommand('formatBlock', false, level ? 'h' + level : 'p'); };
const endOf = (b) => [b, b.childNodes.length];
document.addEventListener('keydown', (e) => {
  const k = e.key;
  if (e.ctrlKey && !e.altKey && !e.shiftKey && (k === 'f' || k === 'F')) { e.preventDefault(); find.classList.add('on'); fi.value = ''; found = []; fi.focus(); return; }
  if (e.ctrlKey && !e.altKey && (k === 'h' || k === 'H')) { e.preventDefault(); fr.classList.add('on'); f1.value = ''; f2.value = ''; f1.focus(); return; }
  if (e.ctrlKey && e.altKey && /^[0-6]$/.test(k)) { e.preventDefault(); restyle(Number(k)); return; }
  if (e.ctrlKey && e.shiftKey && (k === 'ArrowDown' || k === 'ArrowUp')) {
    e.preventDefault();
    const s = sel(); if (!s.rangeCount || !doc.contains(s.focusNode)) return;
    const blocks = [...doc.children];
    let fb = blockOf(s.focusNode), i = blocks.indexOf(fb);
    const atEnd = (() => { const r = document.createRange(); r.selectNodeContents(fb); r.setStart(s.focusNode, s.focusOffset); return r.toString() === '' && !r.cloneContents().querySelector('img,table'); })();
    if (k === 'ArrowDown') { const t = (!atEnd || i < 0) ? fb : blocks[i + 1]; if (t) s.extend(...endOf(t)); }
    else { const t = blocks[i - 1]; if (t) s.extend(...endOf(t)); }
  }
}, true);
</script></body></html>`;

module.exports = { DOC_HTML, PAGE, IMG };
