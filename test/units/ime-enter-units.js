// IME Enter: no Enter handler in Lumen's own pages may act while an IME composition is being confirmed (Japanese / Chinese / Korean
// input: that Enter picks the text, not "send"). renderer/ime.js has the one check (isImeEnter); this suite tests it and greps every
// Enter handler in src/renderer and src/preload for it, so a new handler cannot ship without the guard.
const fs = require('fs');
const path = require('path');
const { isImeEnter, markCompositionEnd } = require('../../src/renderer/ime');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

// ---- the helper
check('plain Enter is not IME', isImeEnter({ key: 'Enter', keyCode: 13, isComposing: false, timeStamp: 5000 }) === false);
check('isComposing is IME', isImeEnter({ key: 'Enter', isComposing: true, timeStamp: 5000 }) === true);
check('keyCode 229 is IME', isImeEnter({ key: 'Enter', keyCode: 229, isComposing: false, timeStamp: 5000 }) === true);
check('no event is not IME', isImeEnter(null) === false && isImeEnter(undefined) === false);
markCompositionEnd(10000);
check('Safari-style: Enter within 60 ms after compositionend is IME', isImeEnter({ key: 'Enter', keyCode: 13, isComposing: false, timeStamp: 10005 }) === true);
check('Safari-style: Enter 200 ms after compositionend is a real Enter', isImeEnter({ key: 'Enter', keyCode: 13, isComposing: false, timeStamp: 10200 }) === false);
check('Safari-style: an Enter before the compositionend is not caught by the window', isImeEnter({ key: 'Enter', keyCode: 13, isComposing: false, timeStamp: 9990 }) === false);
check('Safari-style: other keys right after compositionend are untouched', isImeEnter({ key: 'a', keyCode: 65, isComposing: false, timeStamp: 10005 }) === false);

// ---- every Enter check in a handler is guarded
const root = path.join(__dirname, '..', '..');
const ENTER = /(===|!==|==)\s*'Enter'|'Enter'\s*\]\s*\.includes|case 'Enter'/;
// Handlers that legitimately do not need the guard: [file, text on the line (or the line above), reason]. A button, link, card or list
// item has no composition.
const ALLOW = [
  ['app.js', "isTab && (e.key === 'Enter'", 'a tab in the strip is a button: Enter activates it, nothing is being typed'],
  ['app.js', "$('security').addEventListener", 'the padlock is a button'],
  ['chat-core.js', 'e.target === card', 'a permission / question card (the card itself is focused, not a text field)'],
  ['desktop-card.js', 'thumb.onkeydown', 'a thumbnail acting as a button'],
  ['dictation.js', "e.key !== 'Enter' && e.key !== ' '", 'the mic is a button'],
  ['focus-block.js', 'holdButton', 'a hold button'],
  ['gen-images.js', "img.addEventListener('keydown'", 'an image acting as a button'],
  ['newtab-stacks.js', 'e.target === rail', 'the focused rail (a list), not a text field'],
  ['picker.js', "['ArrowDown', 'ArrowUp', 'Enter', ' '].includes", 'the picker button opens the menu; no text field'],
  ['picker.js', "onControl && (e.key === 'Enter'", 'returns early for a button inside the picker'],
  ['settings.js', "link.addEventListener('keydown'", 'a nav link'],
  ['settings.js', "item.addEventListener('keydown'", 'a list item acting as a button (e.target === item)'],
  ['slides.js', "k === 'Enter'", 'presenting: the slide advances; no text field has focus'],
  ['step-ui.js', "e.key !== 'Enter' && e.key !== ' '", 'a step card acting as a button'],
  ['step-ui.js', "card.shot2.addEventListener('keydown'", 'a screenshot acting as a button'],
  ['tabs-ask.js', "e.shiftKey && e.key === 'Enter'", 'only returns (Shift+Enter does nothing here); the Enter branch above is guarded'],
  ['tool-overlay.js', "current.mode === 'select' && e.key === 'Enter'", 'only stops a select list from submitting; no text field'],
];
const files = [];
for (const dir of ['src/renderer', 'src/preload']) {
  for (const f of fs.readdirSync(path.join(root, dir))) if (/\.js$/.test(f) && !/\.bundle\.js$/.test(f)) files.push(path.join(dir, f));
}
let seen = 0;
for (const rel of files) {
  const lines = fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
  const base = path.basename(rel);
  lines.forEach((line, i) => {
    if (base === 'ime.js' || !ENTER.test(line) || /^\s*\/\//.test(line)) return;
    seen++;
    // the guard is on the line, or an early `if (isImeEnter(e)) return;` at the top of the handler a few lines up
    const near = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
    const guarded = /isImeEnter\(/.test(line) || /isImeEnter\(e\)( \|\| [\w.]+)* return|isImeEnter\(e\)[^\n]*\) return/.test(near);
    const allowed = ALLOW.some(([f, text]) => f === base && lines.slice(Math.max(0, i - 1), i + 1).join('\n').includes(text));
    check(`${base}:${i + 1} Enter handler ignores IME composition`, guarded || allowed, line.trim());
  });
}
check('the scan found the Enter handlers', seen > 40, seen);
// an allowlist entry that matches nothing is stale
for (const [f, text] of ALLOW) {
  const hit = files.some((rel) => path.basename(rel) === f && fs.readFileSync(path.join(root, rel), 'utf8').includes(text));
  check(`allowlist entry still matches: ${f} ${text}`, hit);
}

// ---- every page that loads a guarded script also loads ime.js
const LAZY = { 'chat-page.html': ['chat-project-page.js'] };
const guardedFiles = new Set(files.filter((rel) => /isImeEnter\(/.test(fs.readFileSync(path.join(root, rel), 'utf8'))).map((rel) => path.basename(rel)));
const pages = fs.readdirSync(path.join(root, 'src/renderer')).filter((f) => /\.html$/.test(f) && !/^(index|settings)\.html$/.test(f));
for (const html of pages) {
  const src = fs.readFileSync(path.join(root, 'src/renderer', html), 'utf8');
  const loaded = [...src.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => path.basename(m[1]));
  const extra = html === 'pdfviewer.html' ? ['pdfviewer.js'] : html === 'index.src.html' ? ['notes.js', 'meeting.js', 'command-bar.js', 'files-picker.js'] : (LAZY[html] || []);
  const uses = [...loaded, ...extra].filter((s) => guardedFiles.has(s) && s !== 'ime.js');
  if (uses.length) check(`${html} loads ime.js (needed by ${uses.slice(0, 3).join(', ')})`, loaded.includes('ime.js'), loaded.join(','));
}
check('the PDF viewer scheme serves ime.js', /'\/ime\.js': 'ime\.js'/.test(fs.readFileSync(path.join(root, 'src/features/pdf-viewer.js'), 'utf8')));

process.exit(failures ? 1 : 0);
