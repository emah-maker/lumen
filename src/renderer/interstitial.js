// Shared by the certificate, HTTPS-only and Safe Browsing warning pages: a sentence from locales/en.json (through window.t,
// i18n.js) with a placeholder filled by an element, e.g. fill(note, 'certError.lead', { host: strong }). Strings (not
// nodes) in `vars` are filled in as text. The English written in the HTML stays as the fallback when there is no table.
window.fill = (el, key, vars = {}) => {
  const template = window.t(key);
  if (template === key) return; // no table: keep the HTML's own text
  const parts = [];
  for (const [i, piece] of template.split(/\{(\w+)\}/).entries()) {
    if (i % 2 === 0) { if (piece) parts.push(document.createTextNode(piece)); continue; }
    const value = vars[piece];
    parts.push(value instanceof Node ? value : document.createTextNode(value === undefined ? `{${piece}}` : String(value)));
  }
  el.replaceChildren(...parts);
};
