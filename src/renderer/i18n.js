// UI strings for Lumen's own pages (the browser UI, Settings). The preload hands over the table
// main built from locales/ (features/i18n.js); this file only looks keys up. A page without a table
// (or a key missing from it) shows the English text written in the HTML, or the key itself.
(() => {
  const table = (window.lumenI18n && window.lumenI18n.strings) || {};
  const format = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole)) : text);
  const has = (key) => typeof table[key] === 'string';
  // The strings name shortcuts the Windows way ("New tab (Ctrl+T)"); on macOS they read "⌘T", "⇧⌘K",
  // as Mac menus write them. Ctrl+Tab stays: on a Mac that one really is the Control key.
  const MAC = /^Mac/.test(navigator.platform || '');
  const forMac = (text) => text.replace(/\bCtrl\+((?:Shift\+|Alt\+)*)(?!Tab\b)([A-Z0-9](?![A-Za-z])|F\d{1,2}\b|PageUp|PageDown|Enter|Delete|Backspace|[/=,\-[\]])/g,
    (_m, mods, key) => `${mods.includes('Alt+') ? '⌥' : ''}${mods.includes('Shift+') ? '⇧' : ''}⌘${key}`);
  const t = (key, vars) => { const text = format(has(key) ? table[key] : key, vars); return MAC ? forMac(text) : text; };

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
