// A short note with Undo at the bottom of the Bookmarks and Downloads pages (the same look as the organize note in the tab strip).
// managersToast({ text, undoLabel, onUndo, ms }): shown about 8 s, one at a time; Ctrl+Z (outside a text field) undoes it too.
(() => {
  let current = null;
  const dismiss = () => { if (!current) return; clearTimeout(current.timer); current.node.remove(); current = null; };
  window.managersToast = ({ text, undoLabel, onUndo, ms = 8000 }) => {
    dismiss();
    const node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status'); // read out, with its Undo button
    const words = Object.assign(document.createElement('span'), { className: 'toast-text', textContent: text });
    const undo = Object.assign(document.createElement('button'), { type: 'button', textContent: undoLabel });
    const run = () => { if (current?.node !== node) return; dismiss(); onUndo(); };
    undo.onclick = run;
    node.append(words, undo);
    document.body.append(node);
    current = { node, run, timer: setTimeout(dismiss, ms) };
  };
  document.addEventListener('keydown', (e) => {
    if (!current || e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const target = e.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return; // Ctrl+Z in the search box or a form means its own text
    e.preventDefault();
    current.run();
  });
})();
