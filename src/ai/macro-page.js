// Macros, page side: the code that runs inside a web page (an isolated world) to
//   - tell whether a field holds a secret (password, one-time code, card details),
//   - describe an element as a robust locator (role + name, text, test id, id, CSS fallback), and
//   - find an element again from such a locator, among the elements read_page's registry holds
//     (window.__claudeEls, the ids click / type_text take), so a macro step becomes an ordinary
//     agent tool call and there is no second automation engine,
//   - record what the user does in the tab (clicks, typed text, selects, a few keys) without ever
//     reading a secret field's value.
// Everything the page runs comes from kit(), one function that is serialized into the page and also
// called directly by test/macros-units.js against a fake DOM. Arguments reach the page only through JSON.
const pageScripts = require('./page-scripts');

function kit() {
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const attrOf = (el, name) => (el && el.getAttribute ? el.getAttribute(name) || '' : '');

  // A field whose value is a secret: never recorded, never typed into by a macro.
  const SECRET_WORDS = /pass(word|wd|code|phrase)|pwd|one.?time|\botp\b|2fa|card.?(number|num|no\b)|cc.?(num|number|csc|cvc|cvv|exp)|cvv|cvc|security.?code|iban|routing.?number|account.?number|\bssn\b|social.?security/i;
  const isSensitiveField = (el) => {
    if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(String(el.tagName))) return false;
    const type = String(el.type || attrOf(el, 'type')).toLowerCase();
    const ac = attrOf(el, 'autocomplete').toLowerCase();
    if (type === 'password') return true;
    if (/(^|\s)(current-password|new-password|one-time-code)(\s|$)/.test(ac) || /(^|\s)cc-/.test(ac)) return true;
    return SECRET_WORDS.test([el.name, el.id, attrOf(el, 'placeholder'), attrOf(el, 'aria-label'), attrOf(el, 'data-testid')].join(' '));
  };

  const implicitRole = (el) => {
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.type || attrOf(el, 'type')).toLowerCase();
    if (tag === 'a') return attrOf(el, 'href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (/^(submit|button|reset|image)$/.test(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return '';
  };
  const roleOf = (el) => clean(attrOf(el, 'role')).split(' ')[0] || implicitRole(el);

  const TESTIDS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
  const testidOf = (el) => { for (const a of TESTIDS) { const v = attrOf(el, a); if (v) return v; } return ''; };
  // An id a framework generated (react-:r1:, ember123, long hashes, long digit runs) will not be there next time.
  const stableId = (id) => Boolean(id) && id.length <= 60 && !/^(:|\d)|\d{4,}|[a-f0-9]{10,}|^(ember|react|radix|mui|headlessui|__)|[:]r\w*:/i.test(id);
  const esc = (s) => String(s).replace(/([^\w-])/g, '\\$1');
  const quoteAttr = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

  // A short selector for `el`: the nearest unique id, else tag + a distinguishing attribute, else a tag:nth-of-type path.
  const cssFor = (el, doc) => {
    const unique = (sel) => { try { return doc.querySelectorAll(sel).length === 1; } catch { return false; } };
    const parts = [];
    for (let node = el, depth = 0; node && node.tagName && node.tagName !== 'HTML' && depth < 5; node = node.parentElement, depth++) {
      const tag = node.tagName.toLowerCase();
      const id = attrOf(node, 'id');
      if (stableId(id)) { parts.unshift(`${tag}#${esc(id)}`); if (unique(parts.join(' > '))) break; continue; }
      const tid = testidOf(node);
      let seg = tag;
      if (tid) seg = `${tag}[${TESTIDS.find((a) => attrOf(node, a))}=${quoteAttr(tid)}]`;
      else if (attrOf(node, 'name')) seg = `${tag}[name=${quoteAttr(attrOf(node, 'name'))}]`;
      else if (attrOf(node, 'aria-label')) seg = `${tag}[aria-label=${quoteAttr(attrOf(node, 'aria-label'))}]`;
      else if (node.parentElement) {
        const same = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) seg = `${tag}:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      if (unique(parts.join(' > '))) break;
    }
    return parts.join(' > ').slice(0, 300);
  };

  // nameOf(el): the accessible name (page-scripts.js accessibleName, the same one read_page puts in its registry).
  const buildLocator = (el, nameOf, doc) => {
    const loc = { tag: String(el.tagName || '').toLowerCase() };
    const role = roleOf(el);
    if (role) loc.role = role;
    const name = clean(nameOf ? nameOf(el) : '').slice(0, 80);
    if (name) loc.name = name;
    const text = clean(el.innerText || el.textContent || '').slice(0, 80);
    if (text && text !== name) loc.text = text;
    const tid = testidOf(el);
    if (tid) loc.testid = tid.slice(0, 100);
    const id = attrOf(el, 'id');
    if (stableId(id)) loc.id = id;
    const type = String(el.type || attrOf(el, 'type')).toLowerCase();
    if (loc.tag === 'input' && type) loc.inputType = type;
    const ac = attrOf(el, 'autocomplete');
    if (ac) loc.autocomplete = ac.slice(0, 40);
    if (isSensitiveField(el)) loc.sensitive = true;
    if (doc) { const css = cssFor(el, doc); if (css) loc.css = css; }
    return loc;
  };

  // Finds the element for `loc` among `registry` ([{el, label}], read_page's window.__claudeEls; the
  // id is the index + 1). Order: test id, id, role + name, name, exact text, contained text, CSS.
  // The CSS fallback may find an element read_page does not list: it joins the registry (so an id
  // exists for it). -> { id, via, ambiguous, secret } or null.
  const resolveLocator = (loc, registry, doc) => {
    const norm = (s) => clean(s).toLowerCase();
    const items = registry.map((entry, i) => ({ el: entry.el, id: i + 1, label: norm(entry.label), text: norm(entry.el.innerText || entry.el.textContent) }));
    const pick = (list, via) => {
      if (!list.length) return null;
      let best = list;
      if (list.length > 1) {
        const sameTag = list.filter((i) => !loc.tag || String(i.el.tagName).toLowerCase() === loc.tag);
        const sameType = sameTag.filter((i) => !loc.inputType || String(i.el.type || '').toLowerCase() === loc.inputType);
        best = sameType.length ? sameType : sameTag.length ? sameTag : list;
      }
      return { id: best[0].id, via, ambiguous: best.length > 1, secret: isSensitiveField(best[0].el) };
    };
    let found = null;
    if (loc.testid) found = pick(items.filter((i) => testidOf(i.el) === loc.testid), 'testid');
    if (!found && loc.id) found = pick(items.filter((i) => attrOf(i.el, 'id') === loc.id), 'id');
    if (!found && loc.name) {
      const name = norm(loc.name);
      found = (loc.role && pick(items.filter((i) => roleOf(i.el) === loc.role && i.label === name), 'role-name')) || pick(items.filter((i) => i.label === name), 'name');
    }
    if (!found && loc.text) {
      const text = norm(loc.text);
      found = pick(items.filter((i) => i.text === text), 'text') || (text.length >= 3 ? pick(items.filter((i) => i.text.includes(text) || i.label.includes(text)), 'text-contains') : null);
    }
    if (!found && loc.css && doc) {
      let el = null;
      try { el = doc.querySelector(loc.css); } catch { el = null; }
      if (el) {
        let at = items.find((i) => i.el === el);
        if (!at) { registry.push({ el, chain: [], label: clean(el.innerText || el.textContent).slice(0, 80) }); at = { el, id: registry.length }; }
        found = { id: at.id, via: 'css', ambiguous: false, secret: isSensitiveField(el) };
      }
    }
    return found;
  };

  return { clean, isSensitiveField, implicitRole, roleOf, buildLocator, resolveLocator, cssFor, stableId, testidOf };
}

// Runs in the page: [{ id, via, ambiguous, secret }] for one locator (call after a registry read).
const resolveSource = (locator) => `(${kit.toString()})().resolveLocator(${JSON.stringify(locator)}, window.__claudeEls || [], document)`;

// The recorder's page script: installs listeners and keeps events in window.__lumenMacroRec (drained by
// the main process every few hundred ms). Nothing leaves the page by itself. A secret field's value is
// never read: typing in one records a "pause" (the user fills it in at run time), and the field
// is listed by label only.
function recorderMain(kitFn, win, nameOf) {
  const kit = kitFn();
  const doc = win.document;
  if (win.__lumenMacroRec) return 'already';
  const events = [];
  const masked = new WeakSet();
  let pending = null;
  const name = (el) => { try { return nameOf(el); } catch { return ''; } };
  const push = (e) => { if (events.length < 500) events.push({ ...e, url: win.location.href }); };
  const interactive = (el) => (el && el.closest ? el.closest('a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],label,[onclick]') || el : el);
  const textual = (el) => el && (el.tagName === 'TEXTAREA' || el.isContentEditable === true || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(String(el.type))));
  const submitLike = (el) => (el.tagName === 'INPUT' && /^(submit|image)$/i.test(String(el.type))) || (el.tagName === 'BUTTON' && String(el.type || 'submit').toLowerCase() === 'submit' && Boolean(el.form));
  const mask = (el) => {
    if (masked.has(el)) return;
    masked.add(el);
    const label = kit.clean(name(el)).slice(0, 60);
    push({ type: 'pause', masked: true, note: label ? `Enter ${label} yourself` : 'Fill in the secret field yourself' });
  };
  const flush = () => {
    if (!pending) return;
    const el = pending.el;
    pending = null;
    if (kit.isSensitiveField(el)) return; // (never reached for a secret field; checked again before the value is read)
    push({ type: 'type', locator: kit.buildLocator(el, name, doc), text: String(el.isContentEditable ? el.innerText : el.value) });
  };
  const on = (type, fn) => doc.addEventListener(type, fn, true);
  const handlers = {
    input: (e) => {
      if (!e.isTrusted) return;
      const el = e.target;
      if (!textual(el)) return;
      if (kit.isSensitiveField(el)) { mask(el); return; }
      if (pending && pending.el !== el) flush();
      pending = { el };
    },
    change: (e) => {
      if (!e.isTrusted) return;
      const el = e.target;
      if (el && el.tagName === 'SELECT') {
        if (kit.isSensitiveField(el)) { mask(el); return; }
        flush();
        const chosen = el.selectedOptions && el.selectedOptions[0];
        push({ type: 'select', locator: kit.buildLocator(el, name, doc), option: kit.clean(chosen ? chosen.textContent : '').slice(0, 200) });
      } else if (textual(el) && pending && pending.el === el) flush();
    },
    focusout: (e) => { if (pending && pending.el === e.target) flush(); },
    click: (e) => {
      if (!e.isTrusted) return;
      const el = interactive(e.target);
      if (!el || !el.tagName) return;
      if (textual(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return; // a type or select step focuses the field itself
      flush();
      const locator = kit.buildLocator(el, name, doc);
      push({ type: 'click', locator, submit: submitLike(el) });
    },
    keydown: (e) => {
      if (!e.isTrusted) return;
      const mods = [];
      if (e.ctrlKey) mods.push('control');
      if (e.altKey) mods.push('alt');
      if (e.metaKey) mods.push('meta');
      const key = String(e.key);
      const chord = mods.length > 0 && key.length === 1 && !/^[cvxazy]$/i.test(key);
      if (!(key === 'Enter' || key === 'Escape' || chord)) return;
      const el = e.target;
      if (el && kit.isSensitiveField(el)) { mask(el); if (key !== 'Enter') return; } else flush();
      push({ type: 'key', key: key.length === 1 ? key.toLowerCase() : key, modifiers: e.shiftKey && chord ? [...mods, 'shift'] : mods });
    },
  };
  for (const [type, fn] of Object.entries(handlers)) on(type, fn);
  win.__lumenMacroRec = {
    drain() { flush(); return events.splice(0); },
    stop() { for (const [type, fn] of Object.entries(handlers)) doc.removeEventListener(type, fn, true); delete win.__lumenMacroRec; },
  };
  return 'installed';
}

// accessibleName lives inside page-scripts' HELPERS (the same text read_page labels elements with).
const recorderSource = () => `(() => {
  ${pageScripts.HELPERS}
  return (${recorderMain.toString()})(${kit.toString()}, window, accessibleName);
})()`;
const drainSource = () => '(window.__lumenMacroRec ? window.__lumenMacroRec.drain() : null)';
const stopSource = () => '(window.__lumenMacroRec ? (window.__lumenMacroRec.stop(), true) : false)';

module.exports = { kit, resolveSource, recorderMain, recorderSource, drainSource, stopSource };
