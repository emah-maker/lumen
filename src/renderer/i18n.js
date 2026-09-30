// UI strings for Lumen's own pages (the browser UI, Settings). The preload hands over the table
// main built from locales/ (features/i18n.js); this file only looks keys up. A page without a table
// (or a key missing from it) shows the English text written in the HTML, or the key itself.
(() => {
  const table = (window.lumenI18n && window.lumenI18n.strings) || {};
  const format = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole)) : text);
  const has = (key) => typeof table[key] === 'string';
  const t = (key, vars) => format(has(key) ? table[key] : key, vars);

  // Static markup: data-i18n sets the text, data-i18n-<attr> sets that attribute (title, aria-label,
  // placeholder). The English stays in the HTML as the fallback.
  const ATTRS = ['title', 'aria-label', 'placeholder'];
  function translate(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) if (has(el.dataset.i18n)) el.textContent = t(el.dataset.i18n);
    for (const attr of ATTRS) {
      for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
        const key = el.getAttribute(`data-i18n-${attr}`);
        if (has(key)) el.setAttribute(attr, t(key));
      }
    }
  }

  window.t = t;
  // Settings gets its table asynchronously (settings:strings): swap it in, then re-translate.
  window.setI18n = (loaded) => {
    if (!loaded || typeof loaded.strings !== 'object') return;
    for (const key of Object.keys(table)) delete table[key];
    Object.assign(table, loaded.strings);
    if (loaded.locale) document.documentElement.lang = loaded.locale;
    translate();
  };
  window.translatePage = translate;
  if (window.lumenI18n?.locale) document.documentElement.lang = window.lumenI18n.locale;
  translate();
})();
