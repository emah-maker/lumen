// Google Docs, Sheets and Slides text for the AI's page reads. Docs draws the document on a canvas, so the page's DOM holds
// almost none of it; the editor's own export gives all of it. The export is fetched from INSIDE the tab (same origin, the
// user's own cookies), so a document the user cannot open fails here as it does for them, and nothing goes anywhere else.
// If the page's fetch is refused (the export redirects to another host), the tab's own session asks the same
// docs.google.com address (still the user's cookies). Used by read_page, read_tabs and the message's page context.

const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

// url -> { kind: 'doc' | 'sheet' | 'slides', label, id, gid, exportUrl } | null. Self-contained (no outer names): the
// same source also runs inside the page (page-text.js), through toString().
function exportTarget(url, allowLocal) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const local = allowLocal === true && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (!(local || (u.protocol === 'https:' && u.hostname === 'docs.google.com'))) return null;
  const m = /^\/(document|spreadsheets|presentation)(?:\/u\/\d+)?\/d\/([\w-]+)(?:\/|$)/.exec(u.pathname);
  if (!m || m[2] === 'e') return null; // (/d/e/… is a published copy: its own address)
  const base = `${u.origin}/${m[1]}/d/${m[2]}`;
  if (m[1] === 'document') return { kind: 'doc', label: 'Google Docs', id: m[2], gid: '', exportUrl: `${base}/export?format=txt` };
  if (m[1] === 'presentation') return { kind: 'slides', label: 'Google Slides', id: m[2], gid: '', exportUrl: `${base}/export?format=txt` };
  const gid = (/(?:^|[#&?])gid=(\d+)/.exec(u.hash) || /(?:^|[?&])gid=(\d+)/.exec(u.search) || [])[1] || '';
  return { kind: 'sheet', label: 'Google Sheets', id: m[2], gid, exportUrl: `${base}/export?format=csv${gid ? `&gid=${gid}` : ''}` };
}

// The script: fetches the export in the page and resolves { ok, status, type, text } (never rejects).
function fetchScript(exportUrl) {
  return `(async () => {
    try {
      const res = await fetch(${JSON.stringify(exportUrl)}, { credentials: 'include', redirect: 'follow' });
      const type = res.headers.get('content-type') || '';
      const text = await res.text();
      return { ok: res.ok, status: res.status, type, text: text.slice(0, ${MAX_EXPORT_BYTES}) };
    } catch (err) { return { ok: false, status: 0, type: '', text: '' }; }
  })()`;
}

// A usable answer: success, text (not the sign-in or error page).
function usable(r) {
  return Boolean(r && r.ok && typeof r.text === 'string' && r.text.trim() && !/^text\/html/i.test(r.type || ''));
}

const clean = (text) => String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// { text, label, note } | null. `run(script)` evaluates in the tab; `sessionFetch(url)` is the tab session's fetch (optional).
async function readExport(url, { run, sessionFetch, allowLocal = allowLocalHosts() } = {}) {
  const target = exportTarget(url, allowLocal);
  if (!target || typeof run !== 'function') return null;
  let r = null;
  try { r = await run(fetchScript(target.exportUrl)); } catch { r = null; }
  if (!usable(r) && typeof sessionFetch === 'function') {
    try {
      const res = await sessionFetch(target.exportUrl);
      const type = res.headers.get('content-type') || '';
      r = { ok: res.ok, status: res.status, type, text: (await res.text()).slice(0, MAX_EXPORT_BYTES) };
    } catch { r = null; }
  }
  if (!usable(r)) return null;
  const text = clean(r.text);
  if (!text) return null;
  const note = target.kind === 'sheet'
    ? `${target.gid ? `sheet gid ${target.gid}` : 'the first sheet'} as CSV; to read another sheet, click its tab and read again`
    : 'the full text, not only what is on screen';
  return { text, label: target.label, note, kind: target.kind };
}

// Tests (CLAUDE_BROWSER_TEST) may point a local fixture at the same routes.
const allowLocalHosts = () => process.env.CLAUDE_BROWSER_TEST === '1';

// The label that goes ahead of the text.
const header = (r) => `Document text (from ${r.label} export; ${r.note}):\n`;

// Replaces a read_page result's text with the export's (paged by text_offset, as read_page's own text is).
async function overlayPage(page, textOffset, chunk, opts) {
  if (!page || typeof page !== 'object') return page;
  const r = await readExport(page.url, opts);
  if (!r) return page;
  const full = header(r) + r.text;
  const start = Math.max(0, textOffset || 0);
  const end = start + chunk;
  return { ...page, text: full.slice(start, end), textRange: [start, Math.min(end, full.length)], totalTextChars: full.length, moreTextAvailable: full.length > end, source: `${r.label} export` };
}

module.exports = { exportTarget, fetchScript, readExport, overlayPage, header, usable, allowLocalHosts };
