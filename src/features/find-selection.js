// ---------- Ctrl+F starts from what is selected on the page ----------
//
// As in Chrome, opening the find bar with text selected on the page puts that text in the bar (selected,
// so typing replaces it) and searches for it. pageSelection() asks the page for it: the selected text of
// the page, or of the text field being edited (a field's selection isn't part of the page's). It is
// cut to one short line, and a password field's is never read. The page gets a moment to answer; a
// busy or hung one just opens the bar empty, as before.

const MAX = 200;
const WAIT_MS = 150;

const SCRIPT = `(() => {
  const a = document.activeElement;
  let s = '';
  if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'password' && typeof a.selectionStart === 'number') s = a.value.slice(a.selectionStart, a.selectionEnd);
  else s = String(getSelection());
  return s.slice(0, ${MAX * 4});
})()`;

// One line of at most MAX characters, or '' for nothing worth searching for.
function clean(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX).trim();
}

// -> the page's selection as clean() leaves it ('' when none, or the page didn't answer in time).
async function pageSelection(wc, { wait = WAIT_MS } = {}) {
  if (!wc || wc.isDestroyed?.()) return '';
  let timer;
  try {
    const answer = await Promise.race([
      wc.executeJavaScript(SCRIPT),
      new Promise((resolve) => { timer = setTimeout(resolve, wait, ''); }),
    ]);
    return clean(answer);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pageSelection, clean, SCRIPT, MAX, WAIT_MS };
