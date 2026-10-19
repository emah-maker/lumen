// The marker the AI writes when it names an open tab in its reply: [[tab:12]] (12 is the id list_tabs gave it). The chat turns it into a
// tab chip (renderer/tab-ref.js). Pure and tiny: a plain script in the UI (window.tabMarker), require()d by main and the tests.
//
//   idsIn(text)                 the tab ids the markers in the text name, in order, once each (markers in code never count)
//   stepTabs(name, input)       the tab ids a tool step names in its input
//   replace(text, fn)           the text with each marker replaced by fn(id); code (fenced blocks, `inline`) is left as written
//   toMarkdown(text, tabs)      a marker as "Title (url)" for an exported chat; tabs: { id: { t, u } }
//   neutralize(value)           text that came from a page or a tool result, made unable to read as a marker (a zero-width space in it)
// Only the AI's own reply text is ever read for markers. Anything a web page says goes through neutralize() before the model sees it,
// and the chat reads markers only in an assistant bubble's text (never in code, a link, a message of yours or a step's details).
(function (root) {
  const RE = /\[\[tab:(\d{1,9})\]\]/g;
  const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;
  const FORGERY = /\[\[(\s*tab\s*:)/gi;
  const ZWSP = '​';

  function replace(text, fn) {
    const parts = String(text ?? '').split(CODE); // (a split with a capture group keeps the code parts, at the odd indexes)
    return parts.map((part, i) => (i % 2 ? part : part.replace(RE, (_m, id) => fn(Number(id))))).join('');
  }
  function idsIn(text) {
    const out = [];
    replace(text, (id) => { if (!out.includes(id)) out.push(id); return ''; });
    return out;
  }
  const clean = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[[\]]/g, '').trim();
  function toMarkdown(text, tabs) {
    return replace(text, (id) => {
      const snap = tabs && typeof tabs === 'object' ? tabs[id] || tabs[String(id)] : null;
      const title = clean(snap?.t || '');
      const url = clean(snap?.u || '').replace(/\s/g, '%20');
      if (title && url) return `${title} (${url})`;
      return title || url || `tab ${id}`;
    });
  }
  // A string that came from outside the AI (page text, a tab title, a tool result): "[[tab:" in it can no longer be read as a marker.
  function neutralize(value, depth = 0) {
    if (typeof value === 'string') return value.includes('[[') ? value.replace(FORGERY, `[${ZWSP}[$1`) : value;
    if (depth > 6 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => neutralize(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = typeof v === 'string' && k === 'data' ? v : neutralize(v, depth + 1); // (a picture's base64 is left alone)
    return out;
  }

  // The tabs a step names in its own input (switch_tab, close_tab, read_tabs ids, group_tabs, any tab_id): ids only, at most 8.
  const int = (v) => (Number.isInteger(v) && v >= 0 && v < 1e9 ? [v] : []);
  function stepTabs(name, input) {
    if (!input || typeof input !== 'object') return [];
    const n = String(name || '').replace(/^mcp__lumen__/, '');
    const list = n === 'read_tabs' ? input.ids : n === 'group_tabs' || n === 'ungroup_tabs' ? input.tab_ids : null;
    const ids = Array.isArray(list) ? list.flatMap(int) : int(input.tab_id);
    return [...new Set(ids)].slice(0, 8);
  }

  const api = { stepTabs, idsIn, replace, toMarkdown, neutralize, RE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.tabMarker = api;
})(this);
