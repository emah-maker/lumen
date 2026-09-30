// ---------- saved passwords: the scripts that run in a web page (features/passwords.js) ----------
// Two scripts, both run by main.js with executeJavaScriptInIsolatedWorld in Lumen's own world
// PASSWORD_WORLD, and only in tabs features/passwords.js allows (never private windows, research tabs,
// the AI's reader views, Lumen's own pages, or plain-http sites other than localhost):
//  - watch(): waits for the user to sign in (a form submitted, or a click / Enter with a filled password
//    field, followed by the page leaving or the field going away) and resolves with { username, password }.
//    The result goes back to main.js as the script's return value: the page gets no IPC channel, preload
//    or global of any kind, so there is nothing a page (or a script the AI runs in it) could call.
//  - fill(username, password): puts one saved login into the page's fields. Run only from the user's own
//    click (the key button or the right-click menu); it never submits the form.
// An isolated world has its own globals: the page's scripts, extensions and the AI's scripts (agent.js
// CLAUDE_WORLD, and run_script in the main world) can't see this world's variables, so a password
// captured or filled here lives only in these closures and in main.js's memory.
//
// The rules (pickCredentials, fillTargets) are plain functions over duck-typed field descriptions so
// test/password-units.js runs them in Node; they are stringified into the page scripts, so they use
// nothing from outside themselves.

const PASSWORD_WORLD = 1077; // agent.js uses 1001 (CLAUDE_WORLD); main.js has its own for page text and skills

// A field: { type, value, autocomplete, name, id, visible, form, order, readOnly, disabled }.
// `form` is the index of its <form> on the page (-1: none); `order` its position in document order.

// One-time codes, card numbers and CAPTCHAs are typed into password-type fields too: never a login.
function notALogin(f) {
  const ac = String(f.autocomplete || '').toLowerCase();
  if (/one-time-code|(^|\s)cc-/.test(ac)) return true;
  return /otp|totp|one.?time|2fa|mfa|verif|captcha|security.?code|cvv|cvc|card.?num|\bpin\b/i.test(`${f.name || ''} ${f.id || ''}`);
}

// What the user just signed in with: { username, password } or null (no filled password field).
// A sign-up or change-password form has several: the new one (autocomplete="new-password", else the
// last filled one) is what gets saved. The username is the nearest text or email field before it in the
// same form, preferring one marked autocomplete="username"/"email"; on a two-step sign-in (the address
// on one page, the password on the next) sites keep it in a hidden autocomplete="username" field.
function pickCredentials(fields) {
  const MAX_USERNAME = 512;
  const MAX_PASSWORD = 1024;
  const ac = (f) => String(f.autocomplete || '').toLowerCase();
  const passwords = fields.filter((f) => f.type === 'password' && f.visible && typeof f.value === 'string' && f.value && f.value.length <= MAX_PASSWORD && !notALogin(f));
  if (!passwords.length) return null;
  const fresh = passwords.filter((f) => /new-password/.test(ac(f)));
  const chosen = fresh.length ? fresh[fresh.length - 1] : passwords[passwords.length - 1];
  const texty = (f) => ['text', 'email', 'tel', ''].includes(f.type) && typeof f.value === 'string' && f.value.trim() && f.value.length <= MAX_USERNAME && !notALogin(f);
  const named = (f) => /username|email/.test(ac(f));
  const before = fields.filter((f) => texty(f) && f.visible && f.form === chosen.form && f.order < chosen.order);
  const user = before.filter(named).pop() || before.pop()
    || fields.filter((f) => (texty(f) || (f.type === 'hidden' && typeof f.value === 'string' && f.value.trim() && f.value.length <= MAX_USERNAME)) && /username/.test(ac(f))).pop();
  return { username: user ? user.value.trim() : '', password: chosen.value };
}

// Where a saved login goes: { username: order or -1, password: order or -1 }, or null when the page has
// nowhere to put it. The password field is the focused one if it is a password field, else the first
// one that isn't a "new password" field. The username field is the nearest text or email field before
// it in the same form. With no password field (step one of a two-step sign-in) only the username is
// filled: the focused text field, or one marked autocomplete="username".
function fillTargets(fields, focused = -1) {
  const ac = (f) => String(f.autocomplete || '').toLowerCase();
  const usable = (f) => f.visible && !f.readOnly && !f.disabled && !notALogin(f);
  const texty = (f) => ['text', 'email', 'tel', ''].includes(f.type) && usable(f);
  const named = (f) => /username|email/.test(ac(f));
  const passwords = fields.filter((f) => f.type === 'password' && usable(f));
  if (!passwords.length) {
    const user = fields.find((f) => f.order === focused && texty(f)) || fields.find((f) => texty(f) && /username/.test(ac(f)));
    return user ? { username: user.order, password: -1 } : null;
  }
  const pw = passwords.find((f) => f.order === focused) || passwords.find((f) => /current-password/.test(ac(f)))
    || passwords.find((f) => !/new-password/.test(ac(f))) || passwords[0];
  const before = fields.filter((f) => texty(f) && f.form === pw.form && f.order < pw.order);
  const user = before.filter(named).pop() || before.pop() || null;
  return { username: user ? user.order : -1, password: pw.order };
}

// Shared by both scripts: the rules above, and collect(), which lists the page's input fields (open
// shadow roots included) with their descriptions. A field that was a password field when the user typed
// in it still counts as one after a "show password" button turned it into a text field.
const HELPERS = `
  ${notALogin.toString()}
  ${pickCredentials.toString()}
  ${fillTargets.toString()}
  const state = window.__lumenPasswords || (window.__lumenPasswords = { seen: new WeakSet() });
  const collect = () => {
    const els = [];
    const walk = (root, depth) => {
      for (const el of root.querySelectorAll('input')) els.push(el);
      if (depth < 3) for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot, depth + 1);
    };
    walk(document, 0);
    const forms = [];
    return els.map((el, order) => {
      let form = -1;
      if (el.form) { form = forms.indexOf(el.form); if (form < 0) { forms.push(el.form); form = forms.length - 1; } }
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      const type = state.seen.has(el) ? 'password' : String(el.type || '').toLowerCase();
      return { el, info: { type, value: el.value, autocomplete: el.getAttribute('autocomplete') || '', name: el.name || '', id: el.id || '', visible, form, order, readOnly: el.readOnly, disabled: el.disabled } };
    });
  };
`;

// Resolves with { username, password } once the user has signed in on this page, or null when main.js
// stops it (Save passwords turned off). One watcher per page: a second call gets the same promise.
// A trigger (a submit, or a trusted click on a button or Enter in a field, with a filled password field)
// only notes the login; it is reported when the form really goes (a submit nobody cancelled), when the
// password field goes away (a single-page sign-in), or when main.js sees the page start to leave and
// calls flush(). A click on "show password" alone leaves the field in place, so nothing is offered, and
// a noted login is forgotten after 30 seconds.
function watch() {
  return `(() => {
    ${HELPERS}
    if (state.pending) return state.pending;
    let resolveIt;
    state.pending = new Promise((resolve) => { resolveIt = resolve; });
    const listeners = [];
    const on = (type, fn) => { document.addEventListener(type, fn, true); listeners.push([type, fn]); };
    let noted = null;
    let field = null;
    let since = 0;
    let timer = null;
    const finish = (value) => {
      for (const [type, fn] of listeners) document.removeEventListener(type, fn, true);
      clearInterval(timer);
      state.pending = null;
      state.flush = null;
      state.stop = null;
      noted = null;
      field = null;
      resolveIt(value);
    };
    const gone = (el) => !el || !el.isConnected || !el.getClientRects().length;
    const check = () => {
      if (!noted) return;
      if (gone(field)) { finish(noted); return; }
      if (Date.now() - since > 30000) { noted = null; field = null; clearInterval(timer); timer = null; }
    };
    const note = () => {
      const list = collect();
      const got = pickCredentials(list.map((d) => d.info));
      if (!got) return false;
      noted = got;
      field = (list.find((d) => d.info.type === 'password' && d.el.value === got.password) || {}).el || null;
      since = Date.now();
      if (!timer) timer = setInterval(check, 400);
      return true;
    };
    on('input', (e) => { const t = e.target; if (t && t.tagName === 'INPUT' && String(t.type).toLowerCase() === 'password') state.seen.add(t); });
    on('submit', (e) => {
      if (!note()) return;
      setTimeout(() => { if (noted && !e.defaultPrevented) finish(noted); }, 0);
    });
    on('click', (e) => {
      if (!e.isTrusted || !e.target || !e.target.closest) return;
      if (e.target.closest('button, input[type=submit], input[type=button], input[type=image], [role=button], a')) note();
    });
    on('keydown', (e) => { if (e.isTrusted && e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') note(); });
    state.flush = () => { if (noted) finish(noted); };
    state.stop = () => finish(null);
    return state.pending;
  })()`;
}

// main.js runs these on navigation (flush) and when Save passwords is turned off (stop).
const FLUSH = '(() => { const s = window.__lumenPasswords; if (s && s.flush) s.flush(); return true; })()';
const STOP = '(() => { const s = window.__lumenPasswords; if (s && s.stop) s.stop(); return true; })()';

// Puts one login into the page. Returns 'filled' (a password field was filled), 'username' (only the
// username: step one of a two-step sign-in) or 'none'. The values are set through the input's own value
// setter, then input and change events are sent, so frameworks (React and the like) see the change as
// typing. Nothing is submitted.
function fill(username, password) {
  return `(() => {
    ${HELPERS}
    const list = collect();
    const focused = list.findIndex((d) => d.el === document.activeElement);
    const target = fillTargets(list.map((d) => d.info), focused);
    if (!target) return 'none';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const put = (el, value) => {
      el.focus();
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const username = ${JSON.stringify(String(username))};
    if (target.username >= 0 && username) put(list[target.username].el, username);
    if (target.password >= 0) {
      put(list[target.password].el, ${JSON.stringify(String(password))});
      state.seen.add(list[target.password].el);
    }
    return target.password >= 0 ? 'filled' : target.username >= 0 && username ? 'username' : 'none';
  })()`;
}

module.exports = { PASSWORD_WORLD, pickCredentials, fillTargets, notALogin, watch, fill, FLUSH, STOP };
