// Automations, page side: the code an automation runs inside a web page (its own isolated world, WORLD) to
//   - read the page's form: each field's label, kind, choices, whether it is required and what it holds now; a password field,
//     a CAPTCHA, a form inside an embedded job board (Greenhouse, Lever…), the Submit button, the page's title and heading;
//   - fill the fields features/automations.js planFill chose, the way typing would (input and change events, so the page's own
//     scripts see it), and tick or pick choices by clicking them;
//   - find a recorded Submit button again, click it, and read what the page says after;
//   - list a search page's links.
// Elements are marked with a data-lumen-auto attribute (a ref) when read, so later calls find the same ones. Arguments reach the
// page only through JSON. The page's own text is data: nothing here follows it.
const WORLD = 1061;

function kit() {
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) || '' : '');
  const shown = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  let next = Number(document.documentElement.getAttribute('data-lumen-auto-n') || 0);
  const refOf = (el) => {
    let ref = attr(el, 'data-lumen-auto');
    if (!ref) { ref = `f${++next}`; el.setAttribute('data-lumen-auto', ref); document.documentElement.setAttribute('data-lumen-auto-n', String(next)); }
    return ref;
  };
  const byRef = (ref) => document.querySelector(`[data-lumen-auto="${String(ref).replace(/[^a-z0-9]/gi, '')}"]`);
  const textOf = (el) => clean(el ? (el.innerText || el.textContent || '') : '');

  // A field's question: its <label>, aria-label(ledby), the fieldset's legend for a choice, a heading-like text just before it,
  // its placeholder, its name.
  function labelOf(el) {
    const byIds = attr(el, 'aria-labelledby').split(/\s+/).filter(Boolean).map((id) => textOf(document.getElementById(id))).filter(Boolean).join(' ');
    if (byIds) return byIds;
    if (attr(el, 'aria-label')) return clean(attr(el, 'aria-label'));
    const own = el.labels && el.labels[0] ? textOf(el.labels[0]) : '';
    if (own && el.type !== 'radio' && el.type !== 'checkbox') return own;
    if (el.type === 'radio' || (el.type === 'checkbox' && el.closest('fieldset'))) {
      const legend = el.closest('fieldset') && el.closest('fieldset').querySelector('legend');
      if (legend) return textOf(legend);
      const group = el.closest('[role="radiogroup"],[role="group"]');
      if (group && attr(group, 'aria-labelledby')) return textOf(document.getElementById(attr(group, 'aria-labelledby')));
      if (group && attr(group, 'aria-label')) return clean(attr(group, 'aria-label'));
    }
    if (own) return own;
    let p = el.previousElementSibling;
    for (let i = 0; p && i < 3; i++, p = p.previousElementSibling) { const t = textOf(p); if (t && t.length < 200) return t; }
    const parentText = el.parentElement && el.parentElement.firstChild && el.parentElement.firstChild.nodeType === 3 ? clean(el.parentElement.firstChild.textContent) : '';
    return parentText || clean(attr(el, 'placeholder')) || clean(el.name || el.id || '');
  }
  const required = (el, label) => Boolean(el.required || attr(el, 'aria-required') === 'true' || /\*\s*$|\(required\)/i.test(label));
  const optionText = (el) => (el.labels && el.labels[0] ? textOf(el.labels[0]) : clean(attr(el, 'aria-label') || el.value));

  const CAPTCHA = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha|captcha/i;
  const EMBED = /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|jobvite\.com|icims\.com|myworkdayjobs\.com|bamboohr\.com|recruitee\.com|breezy\.hr|jazzhr|applytojob\.com/i;
  const SUBMIT = /^(submit|apply|send|finish|complete)\b|submit application|send application|apply now|submit your application/i;

  function scan() {
    const fields = [];
    const groups = new Map();
    let fileFields = 0;
    const els = [...document.querySelectorAll('input, select, textarea')];
    for (const el of els) {
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
      if (/^(hidden|submit|button|image|reset|search)$/.test(type)) continue;
      if (el.disabled || el.readOnly) continue;
      if (type !== 'file' && !shown(el) && !(type === 'radio' || type === 'checkbox')) continue; // (choices are often styled boxes over hidden inputs)
      if ((type === 'radio' || type === 'checkbox') && !shown(el) && !(el.labels && el.labels[0] && shown(el.labels[0]))) continue;
      if (type === 'radio') {
        const key = el.name || refOf(el);
        let g = groups.get(key);
        if (!g) {
          const label = labelOf(el);
          g = { ref: refOf(el), tag: 'input', type: 'radio', name: el.name || '', label, required: required(el, label), options: [], value: '' };
          groups.set(key, g);
          fields.push(g);
        }
        el.setAttribute('data-lumen-auto-group', g.ref);
        g.options.push({ value: el.value, text: optionText(el) });
        if (el.checked) g.value = el.value;
        if (el.required) g.required = true;
        continue;
      }
      const label = labelOf(el);
      const f = { ref: refOf(el), tag, type, name: el.name || '', id: el.id || '', label, placeholder: clean(attr(el, 'placeholder')), autocomplete: attr(el, 'autocomplete'), required: required(el, label), maxLength: el.maxLength > 0 ? el.maxLength : 0 };
      if (type === 'file') { fileFields++; f.value = el.files && el.files.length ? el.files[0].name : ''; }
      else if (type === 'checkbox') { f.checked = el.checked; f.value = el.checked ? 'yes' : ''; }
      else if (tag === 'select') {
        f.options = [...el.options].map((o, i) => ({ value: o.value, text: clean(o.text), placeholder: (i === 0 && (!o.value || /^(select|choose|please|--)/i.test(clean(o.text)))) }));
        const chosen = el.options[el.selectedIndex];
        f.value = chosen && !(el.selectedIndex === 0 && f.options[0] && f.options[0].placeholder) ? chosen.value : '';
      } else f.value = el.value;
      fields.push(f);
    }
    const password = [...document.querySelectorAll('input[type="password"]')].some(shown);
    const captcha = [...document.querySelectorAll('iframe')].some((f) => CAPTCHA.test(f.src || '') && shown(f)) || [...document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')].some(shown);
    const embeds = [...document.querySelectorAll('iframe')].filter((f) => EMBED.test(f.src || '')).map((f) => f.src).slice(0, 3);
    const buttons = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(shown);
    const signIn = buttons.some((b) => /^(sign in|log in|login)\b/i.test(clean(b.innerText || b.value)));
    const sub = buttons.find((b) => (b.type === 'submit' || b.tagName === 'INPUT') && b.closest('form') && SUBMIT.test(clean(b.innerText || b.value || attr(b, 'aria-label'))))
      || buttons.find((b) => SUBMIT.test(clean(b.innerText || b.value || attr(b, 'aria-label'))))
      || buttons.find((b) => b.type === 'submit' && b.closest('form'));
    const meta = document.querySelector('meta[property="og:site_name"]');
    return {
      url: location.href, fields, fileFields, password, captcha, embeds, signIn,
      submit: sub ? { ref: refOf(sub), text: clean(sub.innerText || sub.value || attr(sub, 'aria-label')).slice(0, 80) } : null,
      page: { title: document.title, h1: textOf(document.querySelector('h1')).slice(0, 200), siteName: meta ? clean(meta.content) : '' },
    };
  }

  // Sets a value the way typing does: the element's own setter (so a framework's value tracking sees a change), then input
  // and change events.
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }
  function fill(list) {
    const out = [];
    for (const f of list || []) {
      try {
        if (f.kind === 'radio') {
          const radio = [...document.querySelectorAll(`[data-lumen-auto-group="${f.ref}"]`)].find((r) => r.value === f.option);
          if (!radio) throw new Error('choice gone');
          if (!radio.checked) radio.click();
          out.push({ ref: f.ref, ok: radio.checked });
          continue;
        }
        const el = byRef(f.ref);
        if (!el) throw new Error('field gone');
        if (f.kind === 'checkbox') { if (el.checked !== Boolean(f.checked)) el.click(); out.push({ ref: f.ref, ok: el.checked === Boolean(f.checked) }); continue; }
        if (f.kind === 'select') { setValue(el, f.option); out.push({ ref: f.ref, ok: el.value === f.option }); continue; }
        setValue(el, String(f.value));
        out.push({ ref: f.ref, ok: el.value === String(f.value) || (el.maxLength > 0 && String(f.value).startsWith(el.value)) });
      } catch (err) { out.push({ ref: f.ref, ok: false, error: String(err && err.message || err) }); }
    }
    return out;
  }

  // A recorded Submit button again (features/macros.js locator: test id, id, name or text), as a ref; or ''.
  function find(loc) {
    const l = loc || {};
    const tries = [];
    if (l.testid) tries.push(() => document.querySelector(`[data-testid="${CSS.escape(l.testid)}"]`));
    if (l.id) tries.push(() => document.getElementById(l.id));
    const want = clean(l.name || l.text || l.label).toLowerCase();
    if (want) tries.push(() => [...document.querySelectorAll('button, input[type="submit"], [role="button"], a')].filter(shown).find((b) => clean(b.innerText || b.value || attr(b, 'aria-label')).toLowerCase() === want));
    if (l.css) tries.push(() => { try { return document.querySelector(l.css); } catch { return null; } });
    for (const t of tries) { const el = t(); if (el && shown(el)) return refOf(el); }
    return '';
  }
  function click(ref) {
    const el = byRef(ref);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }
  // What the page says now: its text (the start), fields marked wrong, and its alerts.
  function check() {
    const invalid = [...document.querySelectorAll('[aria-invalid="true"], input:invalid, select:invalid, textarea:invalid')].filter(shown).map((el) => labelOf(el)).slice(0, 10);
    const alerts = [...document.querySelectorAll('[role="alert"], .error, .errors, .field-error, .invalid-feedback')].filter(shown).map(textOf).filter(Boolean).slice(0, 5);
    return { url: location.href, text: textOf(document.body).slice(0, 3000), invalid, alerts };
  }
  function links() {
    return [...document.querySelectorAll('a[href]')].slice(0, 2000).map((a) => ({ href: a.href, text: textOf(a).slice(0, 200) })).filter((l) => /^https?:/i.test(l.href)).slice(0, 800);
  }
  return { scan, fill, find, click, check, links, labelOf };
}

const call = (fn, arg) => `(${kit.toString()})().${fn}(${arg === undefined ? '' : JSON.stringify(arg)})`;
const scanSource = () => call('scan');
const fillSource = (fills) => call('fill', (fills || []).map((f) => ({ ref: f.ref, kind: f.kind, value: f.value, option: f.option, checked: f.checked })));
const findSource = (locator) => call('find', locator || {});
const clickSource = (ref) => call('click', String(ref));
const checkSource = () => call('check');
const linksSource = () => call('links');
// The page's main world (the DevTools session's Runtime.evaluate) finds a file field by its ref this way.
const fileSelector = (ref) => `[data-lumen-auto="${String(ref).replace(/[^a-z0-9]/gi, '')}"]`;

module.exports = { WORLD, kit, scanSource, fillSource, findSource, clickSource, checkSource, linksSource, fileSelector };
