// Pure logic for the `document` tool (rich editors: Google Docs first). No window, no network, so it unit-tests in Node.
// The first rule is to PRESERVE: reformatting a document means moving real ranges and applying styles, never retyping its
// content. So this file has the safety net: take a snapshot (words + counts of headings, images, tables, equations) from the
// editor's own export before the first edit, check each planned action against it (destructive?), and verify afterwards that
// nothing was lost. Nothing here touches the page; agent code feeds it the export text/html.

const clean = (s) => String(s || '').replace(/&nbsp;|\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const stripTags = (s) => decode(String(s || '').replace(/<[^>]*>/g, ' '));

// Fraction of the document one edit may remove before it needs the user's OK (guardrail: the ~20% rule).
const DESTRUCTIVE_FRACTION = 0.2;

// Docs / Word export html -> { src (the html), headings: [{ level, text, offset }], images, tables, equations, text }. Regex based: the export is
// machine generated, and this runs in main, where there is no DOM. Equations: math markup, or the images Docs renders them as.
function parseDocHtml(html) {
  const src = String(html || '').replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ');
  const headings = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(src))) {
    const text = clean(stripTags(m[2]));
    if (text) headings.push({ level: Number(m[1]), text, offset: m.index });
  }
  const imgTags = src.match(/<img\b[^>]*>/gi) || [];
  const isEq = (t) => /cht=tx|latex|equation|data-math|class="[^"]*\b(math|equation)\b/i.test(t);
  const equations = imgTags.filter(isEq).length + (src.match(/<math\b/gi) || []).length + (src.match(/<m:oMath\b/gi) || []).length;
  return {
    src,
    headings,
    images: imgTags.length - imgTags.filter(isEq).length,
    tables: (src.match(/<table\b/gi) || []).length,
    equations,
    text: clean(stripTags(src.replace(/<\/(p|div|h[1-6]|li|tr|br)>|<br\s*\/?>/gi, '\n'))),
  };
}

// Counts of OMML equations in a docx's word/document.xml (the reliable equation count when the docx is fetched).
function countOmml(xml) { return (String(xml || '').match(/<m:oMath(?!Para)\b/g) || []).length; }

const words = (text) => (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || []);
const bag = (ws) => { const b = new Map(); for (const w of ws) b.set(w, (b.get(w) || 0) + 1); return b; };

// Snapshot taken before the first edit of a run. rev: the doc's version/timestamp, for "undo all my edits".
function takeSnapshot({ html, text, rev, at }) {
  const parsed = parseDocHtml(html || '');
  const body = text != null ? String(text) : parsed.text;
  const ws = words(body);
  return {
    rev: rev || null,
    at: at || Date.now(),
    wordCount: ws.length,
    words: Object.fromEntries(bag(ws)),
    headings: parsed.headings.map((h) => ({ level: h.level, text: h.text })),
    images: parsed.images,
    tables: parsed.tables,
    equations: parsed.equations,
  };
}

// before: a snapshot. after: another snapshot. Same words (reordering is fine: it is a bag), same object counts. `expect` lets a
// caller allow what it meant to do ({ removedWords, addedWords, images: -1, headings: [{ level, text }] | 'any' ...}); anything beyond it is reported as lost/added.
function compareSnapshots(before, after, expect = {}) {
  const b = new Map(Object.entries(before.words || {})), a = new Map(Object.entries(after.words || {}));
  let lost = 0, added = 0;
  const lostSample = [], addedSample = [];
  for (const [w, n] of b) { const d = n - (a.get(w) || 0); if (d > 0) { lost += d; if (lostSample.length < 8) lostSample.push(w); } }
  for (const [w, n] of a) { const d = n - (b.get(w) || 0); if (d > 0) { added += d; if (addedSample.length < 8) addedSample.push(w); } }
  const okLost = Math.max(0, lost - (expect.removedWords || 0));
  const okAdded = Math.max(0, added - (expect.addedWords || 0));
  const objects = {};
  for (const k of ['images', 'tables', 'equations']) {
    const diff = (after[k] || 0) - (before[k] || 0) - (expect[k] || 0);
    if (diff) objects[k] = { before: before[k] || 0, after: after[k] || 0, change: diff };
  }
  // The headings (their order and levels): as they were, or as the edits planned ('any': an edit that makes new headings or renames them).
  const want = expect.headings === 'any' ? null : (expect.headings || before.headings);
  const headingsOk = !want || !after.headings || JSON.stringify(want.map((h) => [h.level, h.text])) === JSON.stringify(after.headings.map((h) => [h.level, h.text]));
  const problems = [];
  if (!headingsOk) problems.push('the headings are not in the order or styles they should be');
  if (okLost) problems.push(`${okLost} word${okLost === 1 ? '' : 's'} missing (e.g. ${lostSample.join(', ')})`);
  if (okAdded) problems.push(`${okAdded} word${okAdded === 1 ? '' : 's'} added (e.g. ${addedSample.join(', ')})`);
  for (const [k, v] of Object.entries(objects)) problems.push(`${k}: ${v.before} before, ${v.after} now`);
  return { ok: !problems.length, headingsOk, lostWords: okLost, addedWords: okAdded, objects, problems };
}

// What the user hears after a run. Never "unchanged" unless the comparison said so.
function verifyMessage(result, snap) {
  if (result.ok) return 'Checked against the version from before my edits: same words, same pictures, tables and equations.';
  const undo = snap && snap.rev ? ' I can restore the earlier version (' + snap.rev + ').' : ' I can undo my edits to restore it.';
  return `Something changed that should not have: ${result.problems.join('; ')}.${undo}`;
}

// Plain summary of what an edit would remove, for the confirm card: "40% of the document (2 images, 1 table)".
function describeLoss({ fractionRemoved = 0, images = 0, tables = 0, equations = 0 }) {
  const parts = [];
  const n = (c, w) => (c ? `${c} ${w}${c === 1 ? '' : 's'}` : '');
  for (const p of [n(images, 'image'), n(tables, 'table'), n(equations, 'equation')]) if (p) parts.push(p);
  const pct = Math.round(fractionRemoved * 100);
  const head = pct ? `${pct}% of the document` : 'part of the document';
  return `This removes ${head}${parts.length ? ` (${parts.join(', ')})` : ''}. Continue?`;
}

// Does this planned action need the confirm card? `plan` describes the action's effect on the doc, from the snapshot:
//   { kind, selection: 'all'|'range', removedWords, images, tables, equations }, or { kind: 'replace', ... } for Find and replace.
// A select-all that gets typed or pasted over is a whole-document replace: refused unless the user asked for it (userAsked).
function checkAction(plan, snap, { userAsked = false } = {}) {
  const total = Math.max(1, snap.wordCount);
  const fractionRemoved = Math.min(1, (plan.removedWords || 0) / total);
  const lossy = (plan.images || 0) + (plan.tables || 0) + (plan.equations || 0) > 0;
  const wholeReplace = plan.selection === 'all' && /^(type|paste|insert|delete|replace)/.test(plan.kind || '');
  if (wholeReplace && !userAsked) {
    return { allow: false, confirm: false, refuse: true, reason: 'Replacing the whole document would retype its content and lose pictures, tables, equations and fonts. Move sections with cut and paste, and restyle with styles, instead.' };
  }
  if (fractionRemoved > DESTRUCTIVE_FRACTION || lossy || wholeReplace) {
    return { allow: false, confirm: true, refuse: false, message: describeLoss({ fractionRemoved, images: plan.images, tables: plan.tables, equations: plan.equations }) };
  }
  return { allow: true, confirm: false, refuse: false };
}

// A document's export as one region for the content guard (ai/content-guard.js snapshot shape), which cannot read a canvas editor.
function guardSnapshot({ text, html, region = 'gdoc' }) {
  const p = parseDocHtml(html || '');
  const body = String(text != null ? text : p.text);
  return { region, kind: 'rich', tag: 'gdoc', chars: body.length, text: body, truncated: false, images: p.images, tables: p.tables, equations: p.equations, items: 0, rows: 0, styled: 0, selChars: 0, selImages: 0, selTables: 0 };
}

// ---- outline / sections ----

const norm = (s) => clean(s).toLowerCase();
// Find a heading by text: exact, then starts-with, then contains (case-insensitive). ambiguous: several equal candidates.
function findHeading(headings, query) {
  const q = norm(query);
  if (!q) return { error: 'No heading given.' };
  for (const test of [(t) => t === q, (t) => t.startsWith(q), (t) => t.includes(q)]) {
    const hits = headings.map((h, i) => ({ h, i })).filter(({ h }) => test(norm(h.text)));
    if (hits.length === 1) return { index: hits[0].i, heading: hits[0].h };
    if (hits.length > 1) return { error: `"${query}" matches ${hits.length} headings (${hits.slice(0, 4).map(({ h }) => `"${h.text}"`).join(', ')}). Use more of the title.` };
  }
  return { error: `No heading matches "${query}". Headings: ${headings.slice(0, 12).map((h) => `"${h.text}"`).join(', ')}.` };
}

// A section is its heading plus everything up to the next heading of the same or higher level (subsections go with it).
// Returns inclusive heading indexes [from, to] (to = last heading inside the section).
function sectionSpan(headings, index) {
  const lvl = headings[index].level;
  let to = index;
  for (let i = index + 1; i < headings.length && headings[i].level > lvl; i++) to = i;
  return { from: index, to };
}

// Order of headings (by original index) after moving section `from` before/after section `target`. Refuses to move a section
// into itself.
function planMove(headings, fromQuery, where, targetQuery) {
  if (where !== 'before' && where !== 'after') return { error: 'where must be "before" or "after".' };
  const f = findHeading(headings, fromQuery);
  if (f.error) return f;
  const t = findHeading(headings, targetQuery);
  if (t.error) return t;
  const span = sectionSpan(headings, f.index);
  if (t.index >= span.from && t.index <= span.to) return { error: 'The target is inside the section being moved.' };
  const tSpan = sectionSpan(headings, t.index);
  const moving = headings.map((_, i) => i).filter((i) => i >= span.from && i <= span.to);
  const rest = headings.map((_, i) => i).filter((i) => i < span.from || i > span.to);
  const anchor = where === 'before' ? tSpan.from : tSpan.to;
  const at = rest.indexOf(anchor) + (where === 'before' ? 0 : 1);
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  return { order, from: span, target: tSpan, wholeSections: moving.length };
}

// ---- styles ----

const STYLES = { 'normal': 0, 'normal text': 0, 'body': 0, 'paragraph': 0, 'title': null, 'heading 1': 1, 'heading 2': 2, 'heading 3': 3, 'heading 4': 4, 'heading 5': 5, 'heading 6': 6 };
// 'Heading 2' / 'h2' / 'Normal' -> { level } (0 = Normal) or { error }. Docs: Ctrl+Alt+<level>.
function parseStyle(name) {
  let s = norm(name).replace(/^h(\d)$/, 'heading $1');
  if (!(s in STYLES) || STYLES[s] == null) return { error: `Unknown style "${name}". Use Normal or Heading 1 to Heading 6.` };
  return { level: STYLES[s] };
}
// Key combo the AI presses (ai-edit-commands' trusted press_key) per editor. Word Online only has the documented basics.
function styleShortcut(editor, level) {
  if (editor === 'gdocs') return `Control+Alt+${level}`;
  if (editor === 'word') return level <= 3 ? `Control+Alt+${level}` : null; // desktop shortcut; unconfirmed on the web
  return null;
}

// ---- which editor ----

function detectEditor(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.hostname === 'docs.google.com' && /^\/document\/d\//.test(u.pathname)) return 'gdocs';
  if (/(^|\.)officeapps\.live\.com$|(^|\.)office\.com$|(^|\.)sharepoint\.com$/.test(u.hostname) && /word|wordedit|\.docx/i.test(u.href)) return 'word';
  if (/(^|\.)notion\.(so|com)$/.test(u.hostname)) return 'notion';
  return null;
}
// Docs export url for a doc page url; format: txt | html | docx. The doc's own session reads it (read-gdocs-pdf).
function gdocsExportUrl(url, format = 'txt') {
  const m = /^(https:\/\/docs\.google\.com\/document\/d\/[\w-]+)/.exec(String(url || ''));
  return m ? `${m[1]}/export?format=${format}` : null;
}

// ---- markdown for insert_markdown ----

// Minimal Markdown -> HTML for rich paste (headings, bold/italic, links, lists, paragraphs). Docs' own "Paste from Markdown" is
// preferred when its menu item exists; this is the fallback and also what the clipboard's text/html carries.
function markdownToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(md || '').split(/\r?\n/)) {
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}

module.exports = {
  DESTRUCTIVE_FRACTION, clean, parseDocHtml, countOmml, words, takeSnapshot, guardSnapshot, compareSnapshots, verifyMessage, describeLoss, checkAction,
  findHeading, sectionSpan, planMove, parseStyle, styleShortcut, detectEditor, gdocsExportUrl, markdownToHtml,
};
