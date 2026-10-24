// Scripts injected into web pages via webContents.executeJavaScript.
// Every argument interpolated here is either a validated integer or passed through JSON.stringify.
//
// read_page stores the elements it lists in window.__claudeEls (index = id - 1) so later actions
// can find them again, including elements inside open shadow roots and same-origin iframes. With
// frames.js reading every embedded frame in its own isolated world (readPage(..., { frames: false })),
// each frame keeps its own registry and the walk stops at iframes.

const { resolveUploadTarget } = require('../features/upload-files');

const TEXT_CHUNK = 12000;
const ELEMENT_PAGE = 150;

// The page's visible text. document.body.innerText leaves out open shadow roots (web components), so
// on a page that has them the text is put together from the rendered tree: the components' text
// where they are, a slot's assigned nodes in place of the slot, hidden elements left out.
const PAGE_TEXT = `
  const pageText = (doc) => {
    const body = doc.body;
    if (!body) return '';
    const hosts = [];
    const findHosts = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { hosts.push(el); findHosts(el.shadowRoot); } };
    findHosts(doc);
    if (!hosts.length) return body.innerText;
    const holds = new Set(); // elements with a shadow host at or below them
    for (const host of hosts) for (let el = host; el && !holds.has(el); el = el.parentElement || el.getRootNode().host) holds.add(el);
    const view = doc.defaultView;
    const textOf = (node) => {
      if (node.nodeType === 3) return node.nodeValue.replace(/\\s+/g, ' ');
      if (node.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return '';
      const s = view.getComputedStyle(node);
      if (s.display === 'none') return '';
      let inner;
      if (!holds.has(node)) inner = s.visibility === 'hidden' ? '' : node.innerText || '';
      else {
        const assigned = node.tagName === 'SLOT' ? node.assignedNodes({ flatten: true }) : [];
        const kids = node.shadowRoot ? node.shadowRoot.childNodes : assigned.length ? assigned : node.childNodes;
        inner = [...kids].map(textOf).join('');
      }
      return /^inline/.test(s.display) || s.display === 'contents' ? inner : '\\n' + inner + '\\n';
    };
    return textOf(body).replace(/[ \\t]*\\n[ \\t]*/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  };
`;

const HELPERS = `
  // Brings an element on screen for a click or typing. One that is already fully in view stays where it is: centring it every time moved
  // the page under the user's eyes at each step of a task (a visible jump per click).
  const bringIntoView = (el, inline) => {
    const w = el.ownerDocument.defaultView;
    const r = el.getBoundingClientRect();
    if (r.top >= 0 && r.left >= 0 && r.bottom <= w.innerHeight && r.right <= w.innerWidth) return;
    el.scrollIntoView(inline ? { block: 'center', inline: 'center', behavior: 'instant' } : { block: 'center', behavior: 'instant' });
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const clean = (s) => (s || '').trim().replace(/\\s+/g, ' ');
  const accessibleName = (el) => {
    const doc = el.ownerDocument;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = clean(by.split(/\\s+/).map((id) => doc.getElementById(id)?.innerText || '').join(' '));
      if (text) return text;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.labels && el.labels.length) {
      // Strip the control itself from wrapping labels, so a select's options don't leak into its name.
      const text = clean([...el.labels].map((l) => {
        const copy = l.cloneNode(true);
        copy.querySelectorAll('select, textarea, input, button').forEach((n) => n.remove());
        return copy.textContent;
      }).join(' '));
      if (text) return text;
    }
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    if (el.tagName !== 'SELECT') {
      const text = clean(el.innerText);
      if (text) return text;
      const img = el.querySelector('img[alt]');
      if (img && clean(img.alt)) return clean(img.alt);
    }
    return clean(el.getAttribute('placeholder') || el.title || el.name || '');
  };
  // A field whose value is a secret, never read out: a password field, or one marked as a password
  // (autocomplete current-password / new-password, a name like "password"): a page's "show password"
  // button turns the field into a text field, but its value is still the password.
  const secretField = (el) => el.tagName === 'INPUT' && (String(el.type).toLowerCase() === 'password'
    || /password|one-time-code/i.test(el.getAttribute('autocomplete') || '') || /pass(word|wd|code)|pwd/i.test((el.name || '') + ' ' + (el.id || '')));
  const entryFor = (id) => {
    const entry = (window.__claudeEls || [])[id - 1];
    return entry && entry.el.isConnected ? entry : null;
  };
${PAGE_TEXT}
`;

// frames: false leaves iframes to frames.js (each read in its own frame); they are only counted.
// list: false returns the text and the element count only (read_page's default: the model works from
// compact outlines and find, and the 150-element JSON list cost more than the page's text); the registry
// is built either way, so ids still resolve.
function readPage(textOffset, elementOffset, { frames = true, list = true } = {}) {
  return `(() => {
    ${HELPERS}
    const selector = [
      'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
      '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=checkbox]',
      '[role=radio]', '[role=option]', '[role=combobox]', '[role=searchbox]', '[role=textbox]',
      '[role=switch]', '[contenteditable=""]', '[contenteditable=true]', '[onclick]',
    ].join(',');
    const registry = [];
    let crossOriginFrames = 0;
    // A styled label is often the only visible part of a file upload (its input is hidden): it can be named to upload_file.
    const fileLabel = (el) => el.tagName === 'LABEL' && Boolean(el.control) && el.control.tagName === 'INPUT' && el.control.type === 'file';
    const walk =(root, chain) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot, chain);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let doc = null;
          try { doc = ${frames ? 'el.contentDocument' : 'null'}; } catch {}
          if (doc && doc.body) { if (isVisible(el)) walk(doc, [...chain, el]); }
          else if (isVisible(el)) crossOriginFrames++;
          continue;
        }
        if (!(el.matches(selector) || fileLabel(el)) || el.disabled || !isVisible(el)) continue;
        registry.push({ el, chain });
      }
    };
    walk(document, []);
    window.__claudeEls = registry;

    const listing = ${list ? 'true' : 'false'};
    const elements = registry.slice(${elementOffset}, ${elementOffset + ELEMENT_PAGE}).map((entry, i) => {
      const { el, chain } = entry;
      const id = ${elementOffset} + i + 1;
      const label = accessibleName(el).slice(0, 80);
      entry.label = label;
      if (!listing) return null;
      const item = { id, tag: el.tagName.toLowerCase(), label };
      const kind = el.getAttribute('role') || (el.tagName === 'INPUT' ? el.type : null);
      if (kind) item.kind = kind;
      if (el.tagName === 'A') item.href = (el.origin === location.origin ? el.href.slice(el.origin.length) || '/' : el.href).slice(0, 80);
      if ((el.type === 'radio' || el.type === 'checkbox') && el.name) item.group = el.name;
      if ('value' in el && el.tagName !== 'BUTTON' && el.value && !secretField(el) &&
          el.type !== 'radio' && el.type !== 'checkbox' && el.value !== label) item.value = String(el.value).slice(0, 80);
      if (el.tagName === 'SELECT') item.options = [...el.options].slice(0, 30).map((o) => o.text.trim());
      if (el.checked) item.checked = true;
      if (chain.length) item.inFrame = true;
      const r = el.getBoundingClientRect();
      if (!chain.length && (r.bottom < 0 || r.top > innerHeight)) item.offscreen = true;
      return item;
    });
    // Name the rest too, so step labels work for ids on later pages.
    registry.forEach((entry) => { if (entry.label === undefined) entry.label = accessibleName(entry.el).slice(0, 80); });

    const text = pageText(document).replace(/\\n{3,}/g, '\\n\\n');
    const start = ${textOffset};
    const end = start + ${TEXT_CHUNK};
    if (!listing) {
      return {
        url: location.href,
        title: document.title,
        text: text.slice(start, end),
        textRange: [start, Math.min(end, text.length)],
        totalTextChars: text.length,
        moreTextAvailable: text.length > end,
        scroll: { y: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight },
        totalElements: registry.length,
        elementsNotListed: true,
        crossOriginFrames,
      };
    }
    return {
      url: location.href,
      title: document.title,
      text: text.slice(start, end),
      textRange: [start, Math.min(end, text.length)],
      totalTextChars: text.length,
      moreTextAvailable: text.length > end,
      scroll: { y: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight },
      elements,
      elementRange: [${elementOffset + 1}, ${elementOffset} + elements.length],
      totalElements: registry.length,
      moreElementsAvailable: registry.length > ${elementOffset + ELEMENT_PAGE},
      crossOriginFrames,
    };
  })()`;
}

// Scrolls the element into view, flashes a ring on it, and reports its center in tab coordinates.
function locate(id) {
  return `(() => {
    ${HELPERS}
    const entry = entryFor(${id});
    if (!entry) return null;
    const { el, chain } = entry;
    bringIntoView(el, true);
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2, y = r.top + r.height / 2;
    const root = el.getRootNode();
    const hit = (root.elementFromPoint ? root : el.ownerDocument).elementFromPoint(x, y);
    const covered = !(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    for (let i = chain.length - 1; i >= 0; i--) {
      const f = chain[i].getBoundingClientRect();
      x += f.left + chain[i].clientLeft;
      y += f.top + chain[i].clientTop;
    }
    const ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:28px;height:28px;margin:-14px 0 0 -14px;' +
      'border:2px solid #0a84ff;border-radius:50%;box-shadow:0 0 0 4px rgba(10,132,255,.28);' + (matchMedia('(prefers-reduced-motion: reduce)').matches ? '' : 'transition:opacity .5s .3s;') +
      'left:' + x + 'px;top:' + y + 'px';
    document.documentElement.appendChild(ring);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches; // (no fade: it stays a moment, then goes)
    if (!still) requestAnimationFrame(() => { ring.style.opacity = '0'; });
    setTimeout(() => ring.remove(), still ? 600 : 900);
    return { x: Math.round(x), y: Math.round(y), covered, tag: el.tagName.toLowerCase(), label: entry.label || accessibleName(el) };
  })()`;
}

function domClick(id) {
  return `(() => {
    ${HELPERS}
    const entry = entryFor(${id});
    if (!entry) return false;
    entry.el.click();
    return true;
  })()`;
}

// hover on a tab that is not on screen (no real mouse reaches it): the element gets the pointer and
// mouse events a hover sends, so menus that open on mouseover still open.
function domHover(id) {
  return `(() => {
    ${HELPERS}
    const entry = entryFor(${id});
    if (!entry) return false;
    const r = entry.el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      const init = { ...at, bubbles: !type.endsWith('enter') };
      entry.el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse' }) : new MouseEvent(type, init));
    }
    return true;
  })()`;
}

// Prepares an element for text entry. Returns 'ok' (focused, contents selected so insertText
// replaces them), 'setvalue' (needs a direct value set: select, date, color...), 'toggle'
// (checkbox/radio: use click), 'missing', or 'unfocusable'.
function focusForTyping(id) {
  return `(() => {
    ${HELPERS}
    const entry = entryFor(${id});
    if (!entry) return 'missing';
    const el = entry.el;
    bringIntoView(el, false);
    if (el.tagName === 'SELECT') return 'setvalue';
    if (el.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(el.type)) return 'toggle';
      if (['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(el.type)) return 'setvalue';
    }
    el.focus();
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      const sel = el.ownerDocument.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const active = el.getRootNode().activeElement;
    return active === el || el.contains(active) ? 'ok' : 'unfocusable';
  })()`;
}

// Sets a value directly, through the native setter so frameworks like React see the change.
function setValue(id, text) {
  return `(() => {
    ${HELPERS}
    const el = entryFor(${id})?.el;
    if (!el) return null;
    const want = ${JSON.stringify(text)}.trim();
    let value = want;
    let shown = want;
    if (el.tagName === 'SELECT') {
      const lower = want.toLowerCase();
      const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === lower || o.value.toLowerCase() === lower)
        || [...el.options].find((o) => o.text.trim().toLowerCase().includes(lower));
      if (!opt) return null;
      value = opt.value;
      shown = opt.text.trim();
    }
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === value ? shown : null;
  })()`;
}

// [ai manners] The field the user's caret is in (and where in it), kept in the AI's own world before a tool acts in
// the page, and put back after (focusRestore): clicking or typing elsewhere moves the page's focus, and the user's
// next key must still land where they were. Returns true when a field was kept (nothing is kept when the user is in
// no field, so a page the user is not typing in is left exactly as the tool leaves it).
function focusSave() {
  return `(() => {
    const deep = (doc) => {
      let a = doc.activeElement;
      for (let i = 0; i < 10 && a; i++) {
        let inner = a.shadowRoot && a.shadowRoot.activeElement;
        if (!inner && a.tagName === 'IFRAME') { try { inner = a.contentDocument && a.contentDocument.activeElement; } catch { inner = null; } }
        if (!inner || inner === a) break;
        a = inner;
      }
      return a;
    };
    const el = deep(document);
    const plain = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'];
    const typable = el && el !== document.body && el !== document.documentElement && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !plain.includes(el.type)));
    if (!typable) { window.__lumenKept = null; return false; }
    const keep = { el };
    try { if (typeof el.selectionStart === 'number') { keep.start = el.selectionStart; keep.end = el.selectionEnd; keep.dir = el.selectionDirection; } } catch {}
    if (el.isContentEditable) { const sel = el.ownerDocument.getSelection(); if (sel && sel.rangeCount) keep.range = sel.getRangeAt(0).cloneRange(); }
    window.__lumenKept = keep;
    return true;
  })()`;
}

// Is the field the user's caret is in the one a tool is about to type into? `id` null: whichever field has the page's focus (a key press
// goes there). false when the user is in no text field, or in another one than element `id`.
function userInField(id = null) {
  return `(() => {
    ${HELPERS}
    let a = document.activeElement;
    for (let i = 0; i < 10 && a; i++) {
      let inner = a.shadowRoot && a.shadowRoot.activeElement;
      if (!inner && a.tagName === 'IFRAME') { try { inner = a.contentDocument && a.contentDocument.activeElement; } catch { inner = null; } }
      if (!inner || inner === a) break;
      a = inner;
    }
    const plain = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'];
    const typable = a && a !== document.body && a !== document.documentElement && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !plain.includes(a.type)));
    if (!typable) return false;
    const target = ${id === null ? 'null' : `entryFor(${Number(id)})`};
    return ${id === null ? 'true' : 'Boolean(target && target.el === a)'};
  })()`;
}

// ...and back. `exceptId`: the element the tool just typed into (a tool that typed into the very field the user was in
// has changed its text on purpose: its caret is left where the typing put it).
function focusRestore(exceptId = null) {
  return `(() => {
    ${HELPERS}
    const keep = window.__lumenKept;
    window.__lumenKept = null;
    if (!keep || !keep.el.isConnected) return false;
    const el = keep.el;
    const target = ${exceptId === null ? 'null' : `entryFor(${Number(exceptId)})`};
    if (target && target.el === el) return false;
    if (el.getRootNode().activeElement !== el) el.focus({ preventScroll: true });
    try { if (keep.start != null) el.setSelectionRange(keep.start, keep.end, keep.dir || 'none'); } catch {}
    if (keep.range) { const sel = el.ownerDocument.getSelection(); sel.removeAllRanges(); sel.addRange(keep.range); }
    return true;
  })()`;
}

// A click by position in a tab that is not on screen (no real mouse reaches it): the element under the point gets the
// pointer and mouse events a click sends. x, y: CSS pixels. Returns { tag, label } or null.
function domClickAt(x, y) {
  return `(() => {
    ${HELPERS}
    let el = document.elementFromPoint(${Number(x)}, ${Number(y)});
    if (!el) return null;
    for (let i = 0; i < 10 && el.shadowRoot && el.shadowRoot.elementFromPoint; i++) {
      const inner = el.shadowRoot.elementFromPoint(${Number(x)}, ${Number(y)});
      if (!inner || inner === el) break;
      el = inner;
    }
    const at = { bubbles: true, cancelable: true, view: window, clientX: ${Number(x)}, clientY: ${Number(y)}, button: 0 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...at, pointerType: 'mouse' }) : new MouseEvent(type, at));
    }
    if (el.matches('input, textarea, select, [contenteditable], [contenteditable="true"]') && typeof el.focus === 'function') el.focus({ preventScroll: true }); // a click on a field puts the page's focus there (in the page only)
    el.click();
    return { tag: el.tagName.toLowerCase(), label: accessibleName(el) };
  })()`;
}

// Did a click reach the page? clickProbeArm() listens (capture phase, one record per page) for any mouse event a click sends;
// clickProbeRead() reports whether one came (done: and removes the listener). A click that is dropped (a view that is not
// painting) leaves the record empty. The listener only records; it never touches the page's own handling.
function clickProbeArm() {
  return `(() => {
    const key = Symbol.for('lumen.clickProbe');
    if (window[key]) window[key].off();
    const rec = { hit: false };
    const on = () => { rec.hit = true; };
    const types = ['mousedown', 'mouseup', 'click', 'pointerdown'];
    for (const t of types) window.addEventListener(t, on, true);
    rec.off = () => { for (const t of types) window.removeEventListener(t, on, true); };
    window[key] = rec;
    return true;
  })()`;
}
function clickProbeRead(done = false) {
  return `(() => {
    const key = Symbol.for('lumen.clickProbe');
    const rec = window[key];
    if (!rec) return true; // (a navigation cleared it: the click happened)
    const hit = rec.hit;
    if (${done ? 'true' : 'hit'}) { rec.off(); delete window[key]; }
    return hit;
  })()`;
}

// Scrolls the window, or else the largest scrollable container around the middle of the view (a web app: Google Docs). Resolves (a promise)
// once the position has held still for two 50 ms samples (smooth scrolling, scroll-linked loading), at most ~400 ms.
function scroll(pages) {
  return `(() => {
    const dy = Math.round(innerHeight * 0.85 * ${pages});
    const settle = (read, result) => new Promise((resolve) => {
      let last = read();
      const began = Date.now();
      const tick = () => {
        const now = read();
        if (now === last || Date.now() - began >= 400) return resolve(result(now));
        last = now;
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
    const before = scrollY;
    window.scrollBy(0, dy);
    if (scrollY !== before) return settle(() => Math.round(scrollY), (y) => ({ scrolled: 'window', y }));
    // The window cannot move (a web app: Google Docs draws inside .kix-appview-editor): the largest scrollable container around
    // the middle of the view, else the largest one anywhere.
    const scrollable = (el) => {
      const s = getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
    };
    let best = null, bestArea = 0;
    const consider = (el) => { const area = el.clientWidth * el.clientHeight; if (area > bestArea) { best = el; bestArea = area; } };
    for (let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); el; el = el.parentElement || (el.getRootNode() && el.getRootNode().host) || null) {
      if (el !== document.documentElement && el !== document.body && scrollable(el)) consider(el);
    }
    if (!best) for (const el of document.querySelectorAll('*')) if (scrollable(el)) consider(el);
    if (!best) return { scrolled: 'none' };
    const room = best.scrollHeight - best.clientHeight;
    best.scrollBy(0, dy);
    const label = best.tagName.toLowerCase() + (best.className && typeof best.className === 'string' ? '.' + best.className.trim().split(/\\s+/)[0] : '');
    return settle(() => Math.round(best.scrollTop), (y) => ({ scrolled: 'container', y, max: Math.round(room), in: label }));
  })()`;
}

// wait_for's page check: does the page's visible text contain `text`? Case-insensitive, and whitespace-insensitive on both
// sides (a heading split by a line break or a non-breaking space still matches its multi-word text).
function textProbe(text) {
  return `(() => {
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const want = norm(${JSON.stringify(text)});
    return norm(document.body ? document.body.innerText : '').includes(want);
  })()`;
}

// Finds the best element for a piece of visible text or a label. mode 'field' only considers
// form controls; 'click' prefers buttons and links. Returns { id } or { error }.
function findTarget(text, mode) {
  return `(() => {
    ${HELPERS}
    const registry = window.__claudeEls;
    if (!registry) return { error: 'no-registry' };
    const want = ${JSON.stringify(text)}.trim().toLowerCase().replace(/\\s+/g, ' ');
    const isField = (el) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable ||
      ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch'].includes(el.getAttribute('role'));
    let best = null, bestScore = 0, ties = 0;
    registry.forEach((entry, index) => {
      if (!entry.el.isConnected) return;
      if (${JSON.stringify(mode)} === 'field' && !isField(entry.el)) return;
      const legend = ['radio', 'checkbox'].includes(entry.el.type) ? entry.el.closest('fieldset')?.querySelector('legend')?.innerText : null;
      const names = [entry.label ?? accessibleName(entry.el), entry.el.getAttribute('placeholder'), entry.el.name, secretField(entry.el) ? null : entry.el.value, legend] // never match on a password
        .filter(Boolean).map((n) => clean(String(n)).toLowerCase());
      let score = 0;
      for (const n of names) {
        if (n === want) score = Math.max(score, 3);
        else if (n.startsWith(want)) score = Math.max(score, 2);
        else if (n.includes(want)) score = Math.max(score, 1);
      }
      if (!score) return;
      if (${JSON.stringify(mode)} === 'click' && /^(A|BUTTON)$/.test(entry.el.tagName)) score += 0.5;
      if (score > bestScore) { best = index; bestScore = score; ties = 0; }
      else if (score === bestScore) ties++;
    });
    if (best === null) return { error: 'not-found' };
    return { id: best + 1, ambiguous: ties > 0 && bestScore < 3, score: bestScore };
  })()`;
}

// For a field that isn't on the page (e.g. "Search Wikipedia" hidden at narrow widths), finds the
// control that reveals it: a button or link sharing a word with the label, preferring disclosure
// controls (aria-expanded/aria-controls). Never a submit button. Returns an id or null.
function findToggle(text) {
  return `(() => {
    ${HELPERS}
    const registry = window.__claudeEls || [];
    const words = ${JSON.stringify(text)}.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const wantsSearch = words.includes('search');
    let best = null, bestScore = 0;
    registry.forEach((entry, index) => {
      const el = entry.el;
      if (!el.isConnected) return;
      const clickable = ['BUTTON', 'A', 'SUMMARY'].includes(el.tagName) || el.getAttribute('role') === 'button';
      if (!clickable) return;
      if (el.tagName === 'BUTTON' && (el.type || 'submit') === 'submit' && el.form) return; // would submit a form
      const hintsEarly = (String(el.className || '') + ' ' + (el.id || '')).toLowerCase();
      const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
      const disclosure = el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls') || /toggle/.test(hintsEarly);
      // A link that navigates somewhere (a logo, a nav item) is not a toggle, unless it is a search/disclosure control.
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href) && !disclosure && !(wantsSearch && /search/.test(hintsEarly + ' ' + href.toLowerCase()))) return;
      const name = clean(entry.label || accessibleName(el)).toLowerCase();
      const nameWords = name.split(/[^a-z0-9]+/);
      const hints = (String(el.className || '') + ' ' + (el.id || '')).toLowerCase();
      let score = 0;
      if (words.some((w) => nameWords.includes(w))) score += 2;
      if (wantsSearch && (/search/.test(hints) || el.closest('[role=search]'))) score += 1;
      if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls') || /toggle/.test(hints)) score += 1;
      if (score > bestScore) { best = index; bestScore = score; }
    });
    return best === null || bestScore < 2 ? null : best + 1;
  })()`;
}

function toggleState(id) {
  return `(() => { ${HELPERS} const e = entryFor(${id}); return e ? { checked: Boolean(e.el.checked ?? e.el.getAttribute('aria-checked') === 'true'), type: e.el.type || e.el.getAttribute('role') } : null; })()`;
}

// Submits the form that contains the element, the way pressing its submit button would.
function submitForm(id) {
  return `(() => {
    ${HELPERS}
    const form = entryFor(${id})?.el.form;
    if (!form) return false;
    form.requestSubmit();
    return true;
  })()`;
}

// Label of a previously listed element, for step descriptions.
function labelOf(id) {
  return `(() => { const e = (window.__claudeEls || [])[${id - 1}]; return e ? { label: e.label || '', tag: e.el.tagName.toLowerCase() } : null; })()`;
}

// ---- upload_file (features/upload-files.js)
// Finds the file input behind element `id` (the input itself, its label, a button that has one inside or beside it) and
// marks it with `token` (an attribute the DevTools side finds it by; uploadCleanup takes it off), counting the input and
// change events it gets. { status: 'missing' | 'click' (no input found: a click should open the page's file chooser) | 'input', ... }
function uploadProbe(id, token) {
  return `(() => {
    ${HELPERS}
    const entry = entryFor(${id});
    if (!entry) return { status: 'missing' };
    const found = (${resolveUploadTarget.toString()})(entry.el);
    const base = { label: (entry.label || accessibleName(entry.el) || '').slice(0, 80), tag: entry.el.tagName.toLowerCase() };
    if (!found.input) return { ...base, status: 'click', ambiguous: Boolean(found.ambiguous) };
    const input = found.input;
    const events = { input: 0, change: 0 };
    input.addEventListener('input', () => { events.input++; });
    input.addEventListener('change', () => { events.change++; });
    window.__claudeUploads = window.__claudeUploads || {};
    window.__claudeUploads[${JSON.stringify(token)}] = { el: input, events };
    input.setAttribute('data-lumen-upload', ${JSON.stringify(token)});
    if (!base.label) base.label = (accessibleName(input) || input.name || '').slice(0, 80);
    return { ...base, status: 'input', how: found.how, accept: input.accept || '', multiple: input.multiple, disabled: input.disabled, directory: Boolean(input.webkitdirectory) };
  })()`;
}

// After the files were set: makes sure the page got the input and change events a real selection fires (the DevTools
// command normally fires them; one missing is sent), then reports what the field holds and what the page shows.
function uploadReport(token, names) {
  return `(() => {
    ${HELPERS}
    const rec = (window.__claudeUploads || {})[${JSON.stringify(token)}] || null; // (none when a file chooser was answered: no field to read back)
    const el = rec ? rec.el : null;
    const files = el ? Array.prototype.slice.call(el.files || []).map((f) => f.name) : null;
    if (el && files.length) {
      if (!rec.events.input) el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      if (!rec.events.change) el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return new Promise((resolve) => setTimeout(() => {
      const text = (document.body && document.body.innerText) || '';
      const wanted = ${JSON.stringify(names)};
      const scope = (el && el.closest('form')) || document.body;
      const alerts = Array.prototype.slice.call(scope.querySelectorAll('[role=alert], [aria-invalid=true], [class*=error], [class*=invalid]'))
        .filter((e) => e !== el && isVisible(e)).map((e) => clean(e.innerText)).filter(Boolean).slice(0, 3).map((s) => s.slice(0, 160));
      resolve({ files, shown: wanted.map((n) => text.includes(n)), alerts, events: rec ? { ...rec.events } : null });
    }, 400));
  })()`;
}

function uploadCleanup(token) {
  return `(() => {
    const rec = (window.__claudeUploads || {})[${JSON.stringify(token)}];
    if (rec) { try { rec.el.removeAttribute('data-lumen-upload'); } catch {} delete window.__claudeUploads[${JSON.stringify(token)}]; }
    return true;
  })()`;
}

// ---- upload_file, the drop route (agent.js dropFiles)
// Counts the files a drop on the page carries (the browser's own drag and drop first), and answers dragover/drop at the window when the page
// did not, so a page with no drop target is never navigated to the dropped file.
function dropProbeArm() {
  return `(() => {
    const rec = { seen: 0, handled: false };
    const count = (e) => { rec.seen = Math.max(rec.seen, e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files.length : 0); };
    const guard = (e) => { if (e.defaultPrevented) { if (e.type === 'drop') rec.handled = true; } else e.preventDefault(); };
    rec.off = () => { document.removeEventListener('drop', count, true); window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard); };
    document.addEventListener('drop', count, true);
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    window.__claudeDrop = rec;
    return true;
  })()`;
}
function dropProbeRead() { return '(window.__claudeDrop ? { seen: window.__claudeDrop.seen, handled: window.__claudeDrop.handled } : { seen: 0, handled: false })'; }
function dropProbeDisarm() { return '(() => { const r = window.__claudeDrop; if (r) { try { r.off(); } catch {} } delete window.__claudeDrop; delete window.__claudeDropFiles; return true; })()'; }
function dropFilesReset() { return '(() => { window.__claudeDropFiles = []; if (window.__claudeDrop) window.__claudeDrop.handled = false; return true; })()'; }
// Where a file drop could land, most likely first (CSS pixels): the page's main region, its lists, anything that says it takes drops, then the
// middle of the page.
function dropTargets() {
  return `(() => {
    const out = [];
    const add = (x, y) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && !out.some((p) => Math.abs(p.x - x) < 12 && Math.abs(p.y - y) < 12)) out.push({ x, y }); };
    const sel = '[role=main], main, [role=grid], [role=list], [role=listbox], [aria-label*=drop i], [class*=drop i], [id*=drop i], [data-dropzone]';
    const seen = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 60 || getComputedStyle(el).visibility === 'hidden') continue;
      const x0 = Math.max(0, r.left), x1 = Math.min(innerWidth, r.right), y0 = Math.max(0, r.top), y1 = Math.min(innerHeight, r.bottom);
      if (x1 - x0 > 40 && y1 - y0 > 40) seen.push({ area: (x1 - x0) * (y1 - y0), x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
    }
    seen.sort((a, b) => b.area - a.area);
    for (const s of seen.slice(0, 4)) add(s.x, s.y);
    for (const [fx, fy] of [[0.6, 0.55], [0.5, 0.5], [0.6, 0.3], [0.5, 0.75], [0.8, 0.4]]) add(innerWidth * fx, innerHeight * fy);
    return out.slice(0, 8);
  })()`;
}
// Builds the files in the page and drops them (dragenter, dragover, drop) at each of the points until a drop is cancelled, which is what a drop
// target does. One piece of a file (base64) is added by dropFilesAdd (first: it starts a new file; else it is appended to the last).
function dropFilesAdd(name, type, b64, first) {
  return `(() => {
    const list = window.__claudeDropFiles = window.__claudeDropFiles || [];
    if (${first ? 'true' : 'false'}) list.push({ name: ${JSON.stringify(name)}, type: ${JSON.stringify(type)}, parts: [] });
    const bin = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    list[list.length - 1].parts.push(bytes);
    return true;
  })()`;
}
function dropFilesSend(points) {
  return `(() => {
    const dt = new DataTransfer();
    for (const f of window.__claudeDropFiles || []) dt.items.add(new File(f.parts, f.name, { type: f.type }));
    for (const p of ${JSON.stringify(points)}) {
      const target = document.elementFromPoint(p.x, p.y) || document.body;
      const fire = (type) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: p.x, clientY: p.y }));
      fire('dragenter'); fire('dragover');
      fire('drop');
      if (window.__claudeDrop && window.__claudeDrop.handled) return true;
    }
    return false;
  })()`;
}

// What read_page returns: the page's facts as JSON, then its text.
function formatFull(page, extras = '') {
  const { text, ...rest } = page;
  // A chunk that ends before the page's text does says how to get the rest (a table can be cut by it: extract:"tables" reads one whole).
  const end = page.textRange ? page.textRange[1] : 0;
  const more = page.moreTextAvailable ? `
[characters ${page.textRange[0]}-${end} of ${page.totalTextChars}; read_page mode:"full" text_offset:${end} for the next part, or extract:"tables" for whole tables]` : '';
  return `<untrusted_page_content>
${JSON.stringify(rest)}${extras ? `
${extras}` : ''}

PAGE TEXT:
${text}${more}
</untrusted_page_content>`;
}

// What the page looks like after a click, in a few words: its title and the focused element (a field, a button, or the editing surface of an
// app such as Google Docs). A click_at result carries it, so the model need not take a screenshot to learn whether it landed.
const glance = `(() => {
  const name = (a, tag) => String(a.getAttribute('aria-label') || a.placeholder || a.name || a.title || (/^(button|a|summary)$/.test(tag) ? a.innerText : '') || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  const a = document.activeElement;
  let focus = '';
  if (a && a !== document.body && a !== document.documentElement) {
    const tag = a.tagName.toLowerCase();
    if (tag === 'iframe' && /texteventtarget/i.test(a.className + ' ' + a.id)) focus = 'the page text input (typing and keys go to the document)';
    else {
      const role = a.getAttribute('role') || (tag === 'input' ? (a.type || 'text') + ' field' : tag === 'textarea' ? 'text area' : a.isContentEditable ? 'editable text' : tag);
      const label = name(a, tag);
      focus = label ? role + ' "' + label + '"' : role;
    }
  }
  return { title: document.title, focus };
})()`;

module.exports = { glance, PAGE_TEXT, HELPERS, readPage, formatFull, locate, domClick, domHover, domClickAt, clickProbeArm, clickProbeRead, focusSave, focusRestore, userInField, focusForTyping, setValue, scroll, labelOf, findTarget, findToggle, toggleState, submitForm, textProbe, uploadProbe, uploadReport, uploadCleanup, dropProbeArm, dropProbeRead, dropProbeDisarm, dropFilesReset, dropTargets, dropFilesAdd, dropFilesSend };
