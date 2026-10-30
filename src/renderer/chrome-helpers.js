// Small pure helpers for the browser chrome (app.js), kept apart so test/units/chrome-ux-units.js can load them with require().
(function (root) {
  // An address on this computer itself (localhost, 127.x.x.x, [::1], name.localhost). Browsers treat it as safe to talk to
  // without encryption: nothing crosses a network, so "Not secure" would be a false alarm on a developer's own server.
  function isLoopbackUrl(url) {
    let host;
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '[::1]' || host === '::1') return true;
    const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    return Boolean(m) && [m[1], m[2], m[3]].every((n) => Number(n) <= 255);
  }

  // Text that is an address, not a search: a scheme, a host with a dot, localhost, an IP or host:port (no spaces). Typing one of
  // these and pressing Enter goes to exactly that address, whatever the suggestions say.
  function looksLikeAddress(text) {
    const s = String(text || '').trim();
    if (!s || /\s/.test(s)) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|chrome|lumen|file|data|javascript|view-source|mailto):/i.test(s)) return true;
    return /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z][a-z0-9-]*|[a-z0-9-]+(?=:\d))(:\d+)?([/?#].*)?$/i.test(s);
  }

  // The address bar, as in Chrome. The list's first row is always what is in the field (a search for the text as typed, the URL,
  // or the site completed in place) and is where Enter goes until an arrow key picks another row. Nothing typed is ever replaced
  // by a guess: a page that only matches the words is a row to pick, never what Enter opens.

  // What a row puts in the field when the arrow keys reach it.
  const rowValue = (item) => (item.kind === 'search' ? item.title : item.go);

  // Whether a completion that has just arrived may go into the field (Chrome's rules): only while typing forward with the caret
  // at the end, the field still holding exactly the text the completion was asked for. Never after Backspace or Delete (they
  // take the completion away), a paste, a drop, undo, or mid-composition (an IME).
  function mayInlineComplete({ value, typed, selectionStart, selectionEnd, inputType = '', composing = false }) {
    if (composing || value !== typed || !String(typed).trim() || /\s/.test(typed)) return false;
    if (selectionStart !== value.length || selectionEnd !== value.length) return false;
    return !/^(delete|insertFromPaste|insertFromDrop|insertReplacementText|historyUndo|historyRedo)/.test(inputType);
  }

  // Typing the next letter of a completion that is showing keeps it showing at once (the field does not flicker back to the bare
  // text until the next list arrives): the completion for the longer text, or null when the letter doesn't match it.
  function extendInline(inline, value, inputType = '', caretAtEnd = true) {
    if (!inline || !caretAtEnd || !/^insertText$/.test(inputType) || /\s/.test(value)) return null;
    if (value.length >= inline.text.length || !inline.text.toLowerCase().startsWith(value.toLowerCase())) return null;
    return { text: value + inline.text.slice(value.length), url: inline.url };
  }

  // What Enter does: { item } for a row the arrow keys picked (while the field still shows it), else { go } with exactly what the
  // field shows: the completed site while its completion is still there, otherwise the text itself (main.js searches it or opens it).
  function enterAction({ value, inline, items, selected }) {
    const item = items && selected > 0 ? items[selected] : null;
    if (item && value === rowValue(item)) return { item };
    if (inline && value === inline.text) return { go: inline.url };
    return { go: String(value || '').trim() };
  }

  const api = { isLoopbackUrl, looksLikeAddress, rowValue, mayInlineComplete, extendInline, enterAction };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.chromeHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis);
