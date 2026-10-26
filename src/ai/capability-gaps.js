// "Show what the AI couldn't do" (Settings → AI): a private, local list of the times the sidebar AI still handed work back after its
// one automatic second try (ai/handoff.js). Each entry is the date, the site (a host name only), what was missing (a category,
// never the reply's words) and the tool error that went with it. No page content, no text the user wrote, nothing leaves the
// computer unless the user copies the list and sends it. Stored as <profile>/diagnostics/ai-gaps.jsonl, newest last, capped.
// Off with Settings → AI → "Keep a list of what the AI couldn't do" (aiGapLog).
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 200;
const FILE = 'ai-gaps.jsonl';

// What was missing, in the user's words: the kind of handoff the classifier saw.
const MISSING = {
  paste: 'asked you to paste content it could not read itself',
  access: 'said it lacked access or permission',
  'user-step': 'asked you to do a step',
  'open-elsewhere': 'asked you to open something in another app',
  cannot: 'said it could not do it',
};

const oneLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const hostOnly = (s) => { const h = oneLine(s, 120).toLowerCase(); return /^[a-z0-9.-]+$/.test(h) ? h : ''; };
// A tool error can carry an address or a page's words: keep only its first sentence, with addresses, long numbers and quoted text removed.
const scrub = (s) => oneLine(String(s ?? '').replace(/https?:\/\/\S+/g, '[address]').replace(/file:\/\/\S+/g, '[file]').replace(/["“][^"”]{0,200}["”]/g, '"…"').replace(/\b[A-Za-z]:\\[^\s]*/g, '[path]').replace(/\b\d{6,}\b/g, '#'), 160);

// One entry from what the run knows. kind: a key of MISSING. tool: { tool, error } of the last failed tool call, if any.
function entryFor({ kind, site = '', tool = null, model = '' } = {}, now = new Date()) {
  return {
    date: now.toISOString().slice(0, 10),
    site: hostOnly(site),
    missing: MISSING[kind] || MISSING.cannot,
    tool: tool?.tool ? oneLine(tool.tool, 40) : '',
    error: tool?.error ? scrub(tool.error) : '',
    ...(model ? { engine: oneLine(String(model).split(':')[0], 20) } : {}),
  };
}

function createGapLog({ dir, enabled = () => true }) {
  const file = () => path.join(dir(), 'diagnostics', FILE);
  const read = () => {
    try {
      return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && typeof e.date === 'string' && typeof e.missing === 'string').slice(-MAX_ENTRIES);
    } catch { return []; }
  };
  const write = (entries) => {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      const tmp = `${file()}.tmp`; // (temp file and rename: a quit in the middle leaves the old log whole)
      fs.writeFileSync(tmp, entries.length ?`${entries.map((e) => JSON.stringify(e)).join('\n')}\n` : '');
      fs.renameSync(tmp, file());
    } catch { /* a diagnostics file that can't be written is never a reason to fail a chat */ }
  };
  return {
    enabled,
    // Appends one entry (when the setting is on). Returns the entry or null.
    record(info) {
      if (!enabled()) return null;
      const entry = entryFor(info);
      write([...read(), entry].slice(-MAX_ENTRIES));
      return entry;
    },
    list: () => read().reverse(),
    clear() { write([]); return []; },
    // The list as plain text, for the user to copy and send.
    report: () => read().map((e) => `${e.date}  ${e.site || '(no site)'}  ${e.missing}${e.tool ? `  [${e.tool}${e.error ? `: ${e.error}` : ''}]` : ''}${e.engine ? `  (${e.engine})` : ''}`).join('\n'),
    file,
  };
}

module.exports = { createGapLog, entryFor, scrub, MISSING, MAX_ENTRIES, FILE };
