// [autocomplete] Tab to finish the message being typed. After a short pause in the chat box, main asks a small model how the message
// most likely goes on (ai/autocomplete.js, agent:autocomplete); the guess shows as grey text after the caret. Tab takes all of it,
// Ctrl+Right (Alt+Right on a Mac) its next word; typing the same letters keeps the rest of it; any other key, Esc, a caret move, a click
// or sending drops it. With no guess shown Tab does what it always did. No guess while the "/" menu or the "@" tab picker is open (they
// own Tab then, and run first), for a "/" command, or with the caret anywhere but the end. Off in Settings → AI (main then answers 'off' at
// once, without a model call).
// Loaded after chat-core.js, tabs-ask.js and slash.js. The core (createCore) is DOM-free: test/units/autocomplete-units.js runs it in Node.
(function (root) {
  const DELAY_MS = 450;
  const CACHE = 40;

  // request(prefix) -> Promise<{ ok, text, error }>; cancel(): stop the request in flight; render(ghost): show or clear the grey text.
  function createCore({ request, cancel = () => {}, render = () => {}, delayMs = DELAY_MS, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) } /* (called as timers.set(...): a bare setTimeout there throws "Illegal invocation" in the browser) */, wants = () => true }) {
    let ghost = ''; // the grey text shown after `base`
    let base = null; // the composer text the ghost goes after
    let timer = null;
    let seq = 0;
    const cache = new Map(); // prefix -> guess
    const show = (text) => { if (text !== ghost) { ghost = text; render(ghost); } };
    const drop = () => { timers.clear(timer); timer = null; if (seq) { seq++; cancel(); } base = null; show(''); };
    const remember = (prefix, text) => { cache.delete(prefix); cache.set(prefix, text); while (cache.size > CACHE) cache.delete(cache.keys().next().value); };
    function ask(value) {
      const mine = ++seq;
      return Promise.resolve(request(value)).then((r) => {
        if (mine !== seq) return; // a newer prefix (or a dismissal) came since
        seq = 0;
        const text = r?.ok ? String(r.text || '') : '';
        remember(value, text);
        if (text) { base = value; show(text); }
      }, () => { if (mine === seq) seq = 0; });
    }
    return {
      get ghost() { return ghost; },
      get base() { return base; },
      // The text changed. `atEnd`: the caret is at its end with nothing selected; `blocked`: a menu owns the keys now.
      input(value, { atEnd = true, blocked = false } = {}) {
        // Typed into the guess: the rest of it stays.
        if (ghost && base != null && atEnd && !blocked && value.length > base.length && value.startsWith(base) && ghost.startsWith(value.slice(base.length))) {
          const rest = ghost.slice(value.length - base.length);
          timers.clear(timer); timer = null;
          base = value;
          if (rest) { show(rest); return; }
        }
        drop();
        if (blocked || !atEnd || !wants(value)) return;
        if (cache.has(value)) { const text = cache.get(value); if (text) { base = value; show(text); } return; }
        timer = timers.set(() => { timer = null; ask(value); }, delayMs);
      },
      // Tab: the whole guess (the text to put after the composer's), or null when there is none.
      accept() {
        if (!ghost) return null;
        const text = ghost;
        drop();
        return text;
      },
      // Ctrl+Right: the guess up to the end of its next word.
      acceptWord() {
        if (!ghost || base == null) return null;
        const word = /^\s*\S+/.exec(ghost)?.[0] || ghost;
        const rest = ghost.slice(word.length);
        base += word;
        show(rest);
        if (!rest) base = null;
        return word;
      },
      dismiss: drop,
      reset() { cache.clear(); drop(); },
    };
  }

  const api = { createCore, DELAY_MS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.chatAutocomplete = api;

  // ---------- the chat box ----------
  const prompt = document.getElementById('prompt');
  const assistant = window.assistant;
  if (!prompt || !assistant || typeof assistant.autocomplete !== 'function') return;
  const shownMenu = () => [...document.querySelectorAll('#tabs-picker, .slash-menu, #slash-menu')].some((el) => !el.hidden && el.offsetParent !== null);
  const atEnd = () => prompt.selectionStart === prompt.value.length && prompt.selectionEnd === prompt.value.length;

  // The grey text: a copy of the box's text (invisible) followed by the guess, laid over the box with the box's own font, padding and scroll.
  const layer = document.createElement('div');
  layer.className = 'autocomplete-layer';
  layer.setAttribute('aria-hidden', 'true');
  const typed = document.createElement('span');
  typed.className = 'autocomplete-typed';
  const ghostEl = document.createElement('span');
  ghostEl.className = 'autocomplete-ghost';
  const hint = document.createElement('span');
  hint.className = 'autocomplete-hint';
  hint.textContent = 'Tab';
  layer.append(typed, ghostEl, hint);
  prompt.insertAdjacentElement('afterend', layer);
  const COPIED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'direction'];
  function place() {
    const cs = getComputedStyle(prompt);
    for (const k of COPIED) layer.style[k] = cs[k];
    layer.style.left = `${prompt.offsetLeft}px`;
    layer.style.top = `${prompt.offsetTop}px`;
    layer.style.width = `${prompt.offsetWidth}px`;
    layer.style.height = `${prompt.offsetHeight}px`;
    layer.scrollTop = prompt.scrollTop;
  }
  function render(ghost) {
    if (!ghost) { layer.hidden = true; ghostEl.textContent = ''; return; }
    typed.textContent = prompt.value;
    ghostEl.textContent = ghost;
    layer.hidden = false;
    place();
  }
  layer.hidden = true;

  const core = createCore({
    request: (prefix) => assistant.autocomplete(prefix),
    cancel: () => { try { assistant.autocompleteCancel?.(); } catch {} },
    render,
    wants: (value) => value.replace(/\s/g, '').length >= 3 && !/^\s*\//.test(value),
  });
  root.chatAutocomplete.core = core;

  let inserting = false;
  const insert = (text) => {
    inserting = true;
    try {
      prompt.setRangeText(text, prompt.value.length, prompt.value.length, 'end');
      prompt.dispatchEvent(new Event('input', { bubbles: true })); // (the box grows, Send updates, the draft is saved: chat-core.js)
    } finally { inserting = false; }
    if (core.ghost) render(core.ghost);
  };
  prompt.addEventListener('input', (e) => {
    if (inserting) return;
    if (e.isComposing) { core.dismiss(); return; }
    core.input(prompt.value, { atEnd: atEnd(), blocked: shownMenu() });
  });
  prompt.addEventListener('keydown', (e) => {
    if (!core.ghost || e.isComposing) return;
    if (shownMenu()) { core.dismiss(); return; } // (the "/" menu or "@" picker took the keys before this ran)
    const wordKey = e.key === 'ArrowRight' && (navigator.platform.startsWith('Mac') ? e.altKey : e.ctrlKey) && !e.shiftKey;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && atEnd()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const text = core.accept();
      if (text) insert(text);
    } else if (wordKey && atEnd()) {
      e.preventDefault();
      const word = core.acceptWord();
      if (word) insert(word);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // (Esc takes the guess away first; the next one does what Esc does)
      core.dismiss();
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter'].includes(e.key) && !isImeEnter(e)) core.dismiss();
  });
  prompt.addEventListener('scroll', () => { if (core.ghost) layer.scrollTop = prompt.scrollTop; }, { passive: true });
  for (const type of ['blur', 'mousedown', 'cut', 'paste', 'drop']) prompt.addEventListener(type, () => core.dismiss());
  document.getElementById('composer')?.addEventListener('submit', () => core.dismiss(), { capture: true });
  window.addEventListener('resize', () => { if (core.ghost) place(); }, { passive: true });
})(this);
