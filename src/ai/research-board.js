// The Research board: the sources of one chat. Every source the AI or the user adds is kept with its metadata, the user's note,
// a star and any pinned quotes. Pure, Electron-free data code (test/research-units.js); main.js keeps one board per chat in the
// chat's settings (settings.research), so it is saved, restored and deleted with the chat.
//
// A board: { v: 1, next: 4, sources: [source] }.  A source is addressed by its number `n` (1, 2, 3...), which is also the [n]
// in the AI's answers and in the panel; a number is never reused after a removal, so an old answer's [3] stays true.
//   source: { n, title, authors[{family,given}|{literal}], year, month, day, venue, siteName, volume, issue, pages, publisher,
//             doi, url, pdfUrl, abstract, cslType, arxivId, citations, retracted, retractionNotice, kind, accessed,
//             starred, note, by: 'ai' | 'user', added, quotes: [quote] }
//   quote:  { q, text, page, heading, note, url, verified: true | false | null, by, added }
//
// What the AI may change: add sources (find_sources ids, a DOI, or a URL + the facts it read), pin quotes, star. What it may
// not do: edit the user's notes (they are the user's) or remove a source the user added. Everything stored is cut to a
// length and stripped of control characters; a URL is only ever http(s).
const quality = require('./source-quality');
const { cleanUrl, findDoi } = require('./page-meta');
const { normTitle } = require('./scholar');
const citations = require('./citations');

const MAX_SOURCES = 150;
const MAX_QUOTES = 25;
const MAX_NOTE = 2000;
const MAX_QUOTE = 1200;
const VERSION = 1;

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const line = (v, n) => clean(v, n * 2).replace(/\s*\n\s*/g, ' ').slice(0, n);
const intOrNull = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
const cslSet = new Set(['article-journal', 'paper-conference', 'article', 'book', 'chapter', 'thesis', 'report', 'webpage']);

const emptyBoard = () => ({ v: VERSION, next: 1, sources: [] });

// ---------- cleaning ----------

function cleanAuthors(list) {
  return (Array.isArray(list) ? list : []).slice(0, 60).map((a) => {
    if (typeof a === 'string') return citations.parseAuthor(line(a, 120));
    if (a && typeof a === 'object') return a.literal ? { literal: line(a.literal, 120) } : a.family ? { family: line(a.family, 80), given: line(a.given, 80) } : null;
    return null;
  }).filter((a) => a && (a.literal || a.family));
}

function cleanQuote(q, { by = 'ai', now = Date.now() } = {}) {
  const text = clean(q?.text ?? q, MAX_QUOTE);
  if (!text || typeof text !== 'string') return null;
  const url = cleanUrl(q?.url);
  return {
    q: typeof q?.q === 'string' && /^q\d{1,6}$/.test(q.q) ? q.q : '',
    text,
    page: intOrNull(q?.page, 1, 100000),
    heading: line(q?.heading, 160),
    note: clean(q?.note, 400),
    url,
    verified: q?.verified === true ? true : q?.verified === false ? false : null,
    by: q?.by === 'user' ? 'user' : by === 'user' ? 'user' : 'ai',
    added: Number.isFinite(q?.added) ? q.added : now,
  };
}

// Any input (the AI's tool call, a find_sources record, page metadata, a saved file) -> a clean source without n / quotes.
function cleanSource(input, { by = 'ai', now = Date.now() } = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const doi = findDoi(s.doi);
  const url = cleanUrl(s.url) || (doi ? `https://doi.org/${doi}` : '');
  const title = line(s.title, 400);
  const authors = cleanAuthors(s.authors);
  const year = intOrNull(s.year, 1000, new Date().getFullYear() + 2);
  const draft = {
    title, authors, year, month: intOrNull(s.month, 1, 12), day: intOrNull(s.day, 1, 31),
    venue: line(s.venue, 300), siteName: line(s.siteName, 120), volume: line(s.volume, 30), issue: line(s.issue, 30), pages: line(s.pages, 40), publisher: line(s.publisher, 160),
    doi, url, pdfUrl: cleanUrl(s.pdfUrl), oaUrl: cleanUrl(s.oaUrl), abstract: clean(s.abstract, 1200), arxivId: line(s.arxivId, 40),
    citations: Number.isInteger(s.citations) && s.citations >= 0 ? s.citations : null,
    retracted: s.retracted === true, retractionNotice: s.retractionNotice === true,
    retractedBy: (Array.isArray(s.retractedBy) ? s.retractedBy : []).filter((x) => ['OpenAlex', 'Crossref', 'PubMed'].includes(x)),
    retractionFlag: (Array.isArray(s.retractionFlag) ? s.retractionFlag : []).filter((x) => ['OpenAlex', 'PubMed', 'Crossref (publisher notice only)'].includes(x)),
    concern: s.concern === true, corrected: s.corrected === true,
    accessed: /^\d{4}-\d{2}-\d{2}$/.test(String(s.accessed || '')) ? s.accessed : '',
    type: line(s.type, 40), workType: line(s.workType, 40), venueType: line(s.venueType, 40),
  };
  draft.cslType = cslSet.has(s.cslType) ? s.cslType : citations.cslType({ ...draft, type: draft.type || draft.workType, cslType: '' });
  draft.kind = s.kind && /^[a-z]{3,14}$/.test(s.kind) ? s.kind : quality.kindOf(draft);
  if (draft.kind === 'preprint' && draft.cslType === 'article-journal' && !draft.doi) draft.cslType = 'article';
  return { ...draft, by: by === 'user' ? 'user' : 'ai' };
}

// A key two records of the same work share: the DOI, else the address without its query / fragment, else title + year.
function keysOf(s) {
  const keys = [];
  if (s.doi) keys.push(`d:${s.doi}`);
  if (s.url) { try { const u = new URL(s.url); keys.push(`u:${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${/^\/?$/.test(u.pathname) ? u.search : ''}`.toLowerCase()); } catch { /* skip */ } }
  const t = normTitle(s.title);
  if (t.length >= 12) keys.push(`t:${t}`);
  return keys;
}
const findDuplicate = (board, s) => { const keys = new Set(keysOf(s)); return board.sources.find((x) => keysOf(x).some((k) => keys.has(k))) || null; };

// ---------- the board ----------

function normalizeBoard(raw, { now = Date.now() } = {}) {
  const board = emptyBoard();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sources)) return board;
  let maxN = 0;
  for (const item of raw.sources.slice(0, MAX_SOURCES)) {
    const s = cleanSource(item, { by: item?.by, now });
    if (!s.title && !s.url) continue;
    const n = Number.isInteger(item?.n) && item.n > 0 && !board.sources.some((x) => x.n === item.n) ? item.n : 0;
    const quotes = (Array.isArray(item?.quotes) ? item.quotes : []).slice(0, MAX_QUOTES).map((q, i) => { const c = cleanQuote(q, { now }); return c && { ...c, q: c.q || `q${i + 1}` }; }).filter(Boolean);
    board.sources.push({ ...s, n, starred: item?.starred === true, note: clean(item?.note, MAX_NOTE), added: Number.isFinite(item?.added) ? item.added : now, quotes });
    maxN = Math.max(maxN, n);
  }
  let next = Math.max(maxN + 1, Number.isInteger(raw.next) ? raw.next : 1);
  for (const s of board.sources) if (!s.n) s.n = next++;
  board.next = next;
  return board;
}

const byNumber = (board, n) => board.sources.find((s) => s.n === Number(n)) || null;

// -> { source, added, duplicate } (a record already on the board is merged, never doubled; the user's note, star and quotes stay).
function addSource(board, input, { by = 'ai', now = Date.now() } = {}) {
  const s = cleanSource(input, { by, now });
  if (!s.title && !s.url) throw new Error('A source needs a title or a URL.');
  if (!s.title) s.title = s.url;
  const dup = findDuplicate(board, s);
  if (dup) {
    for (const k of Object.keys(s)) {
      if (k === 'by') continue;
      const empty = dup[k] === '' || dup[k] === null || dup[k] === undefined || (Array.isArray(dup[k]) && !dup[k].length);
      if (empty && !(s[k] === '' || s[k] === null || (Array.isArray(s[k]) && !s[k].length))) dup[k] = s[k];
    }
    dup.retracted = dup.retracted || s.retracted;
    dup.retractionNotice = dup.retractionNotice || s.retractionNotice;
    dup.retractionFlag = [...new Set([...(dup.retractionFlag || []), ...(s.retractionFlag || [])])];
    dup.concern = dup.concern || s.concern;
    dup.corrected = dup.corrected || s.corrected;
    if (s.citations !== null && (dup.citations === null || s.citations > dup.citations)) dup.citations = s.citations;
    return { source: dup, added: false };
  }
  if (board.sources.length >= MAX_SOURCES) throw new Error(`The research board holds ${MAX_SOURCES} sources. Remove some first.`);
  const source = { ...s, n: board.next++, starred: false, note: '', added: now, quotes: [] };
  board.sources.push(source);
  return { source, added: true };
}

function removeSource(board, n, { by = 'user' } = {}) {
  const s = byNumber(board, n);
  if (!s) return false;
  if (by === 'ai' && s.by === 'user') throw new Error('The user added this source themselves; only they can remove it.');
  board.sources = board.sources.filter((x) => x !== s);
  return true;
}

// patch: { starred, note, title } (the user's edits); the AI may only star.
function updateSource(board, n, patch = {}, { by = 'user' } = {}) {
  const s = byNumber(board, n);
  if (!s) return null;
  if (typeof patch.starred === 'boolean') s.starred = patch.starred;
  if (by === 'user') {
    if (typeof patch.note === 'string') s.note = clean(patch.note, MAX_NOTE);
    if (typeof patch.title === 'string' && line(patch.title, 400)) s.title = line(patch.title, 400);
  }
  return s;
}

function addQuote(board, n, input, { by = 'ai', now = Date.now() } = {}) {
  const s = byNumber(board, n);
  if (!s) throw new Error(`No source [${n}] on the research board.`);
  const q = cleanQuote(input, { by, now });
  if (!q) throw new Error('The quote is empty.');
  const existing = s.quotes.find((x) => normTitle(x.text) === normTitle(q.text));
  if (existing) { Object.assign(existing, { page: existing.page ?? q.page, heading: existing.heading || q.heading, url: existing.url || q.url, verified: q.verified ?? existing.verified }); return { source: s, quote: existing, added: false }; }
  if (s.quotes.length >= MAX_QUOTES) throw new Error(`Source [${n}] already has ${MAX_QUOTES} pinned quotes.`);
  const id = `q${(s.quotes.reduce((m, x) => Math.max(m, Number(String(x.q).slice(1)) || 0), 0)) + 1}`;
  const quote = { ...q, q: id };
  s.quotes.push(quote);
  return { source: s, quote, added: true };
}

function removeQuote(board, n, qid) {
  const s = byNumber(board, n);
  if (!s) return false;
  const before = s.quotes.length;
  s.quotes = s.quotes.filter((x) => x.q !== qid);
  return s.quotes.length < before;
}

// ---------- links to the exact passage ----------

// A web page URL that scrolls to and highlights `quote` in Chromium: url#:~:text=<start>[,<end>]. Long quotes use the
// start,end form (the spec's way of keeping a fragment short). '-', ',' and '&' are percent-encoded as the spec asks. Any old
// fragment is replaced. A PDF gets #page=N instead (page known) or the bare URL.
const tfEncode = (s) => encodeURIComponent(s).replace(/-/g, '%2D').replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function fragmentUrl(url, quote, { page = null } = {}) {
  const clean0 = cleanUrl(url);
  if (!clean0) return '';
  const base = clean0.replace(/#.*$/, '');
  const isPdf = /\.pdf($|\?)/i.test(base);
  if (isPdf) return page ? `${base}#page=${page}` : base;
  const words = String(quote ?? '').replace(/\s+/g, ' ').replace(/^[\s"“”'‘’.…]+|[\s"“”'‘’.,;:!?…]+$/g, '').split(' ').filter(Boolean);
  if (!words.length) return base;
  if (words.length <= 8) return `${base}#:~:text=${tfEncode(words.join(' '))}`;
  return `${base}#:~:text=${tfEncode(words.slice(0, 4).join(' '))},${tfEncode(words.slice(-4).join(' '))}`;
}

// ---------- did the source really say it? ----------

// Page text as the AI read it is markdown with links and emphasis; a quote is plain words. Compare in one normal form.
function squash(text) {
  return String(text ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―−]/g, '-').replace(/­/g, '')
    .replace(/…/g, '...')
    .toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}
// "...first part ... second part..." matches if every piece is found, in order.
function findQuote(haystack, quote) {
  const pieces = squash(quote).split(/\s*(?:\.\.\.|\[\.\.\.\]|\[…\])\s*/).map((p) => p.replace(/^["'\s]+|["'\s]+$/g, '').trim()).filter((p) => p.length >= 8);
  if (!pieces.length) return -1;
  let from = 0;
  let first = -1;
  for (const piece of pieces) {
    const at = haystack.indexOf(piece, from);
    if (at < 0) return -1;
    if (first < 0) first = at;
    from = at + piece.length;
  }
  return first;
}

// texts: [{ url, name, kind: 'web' | 'pdf', text }] (collectTexts) -> { verified, via: url | name, page, heading } where
// verified is true (found), false (a text for this source was read and does not contain it) or null (nothing to check against).
function verifyQuote(quote, url, texts, { doi = '' } = {}) {
  const target = (() => { try { const u = new URL(url); return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase(); } catch { return ''; } })();
  const relevant = (texts || []).filter((t) => {
    if (t.kind === 'pdf') return true; // a read_pdf result names no address: any PDF read in this chat may be it (checked by content)
    try { const u = new URL(t.url); return target && `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase() === target; } catch { return false; }
  });
  let read = false;
  for (const t of relevant) {
    if (t.kind === 'pdf') {
      const pages = String(t.text).split(/^--- Page (\d+) of \d+ ---$/m);
      let sawPage = false;
      for (let i = 1; i < pages.length; i += 2) {
        sawPage = true;
        if (findQuote(squash(pages[i + 1]), quote) >= 0) return { verified: true, via: t.name || t.url || 'PDF', page: Number(pages[i]), heading: '' };
      }
      if (sawPage && (t.url || '') === url) read = true;
      continue;
    }
    read = true;
    const body = String(t.text);
    const flat = squash(body);
    const at = findQuote(flat, quote);
    if (at >= 0) return { verified: true, via: t.url, page: null, heading: headingBefore(body, quote) };
  }
  return { verified: read ? false : null, via: '', page: null, heading: '' };
}

// The nearest markdown heading above the first words of the quote in the original page text ('' when none).
function headingBefore(body, quote) {
  const probe = squash(quote).split(/\s*\.\.\.\s*/)[0].split(' ').slice(0, 6).join(' ');
  if (!probe) return '';
  const lines = String(body).split('\n');
  let heading = '';
  let acc = '';
  for (const ln of lines) {
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(ln);
    if (h) heading = squash(h[1]) === '' ? heading : h[1].replace(/[*_`]/g, '').trim();
    acc = `${squash(acc.slice(-200))} ${squash(ln)}`;
    if (acc.includes(probe)) return heading.slice(0, 160);
  }
  return '';
}

// The page and PDF texts the AI has read in this chat (tool results in the history): read_urls wraps each page in
// <untrusted_page_content url="...">, read_pdf marks pages "--- Page N of M ---". -> [{ url, name, kind, text }]
function collectTexts(messages) {
  const out = [];
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'tool_result') continue;
      const text = textOf(b.content);
      if (!text || text.length > 3000000) continue;
      for (const part of text.matchAll(/<untrusted_page_content url="([^"]+)">\n([\s\S]*?)\n<\/untrusted_page_content>/g)) out.push({ url: part[1].replace(/&#38;/g, '&'), name: '', kind: 'web', text: part[2] });
      const pdf = /<untrusted_page_content>\n(?:PDF|Presentation): ([^\n(]+?) \(\d+ (?:pages|slides)[\s\S]*?\n\n([\s\S]*?)\n<\/untrusted_page_content>/.exec(text);
      if (pdf && /--- Page \d+ of \d+ ---/.test(pdf[2])) out.push({ url: '', name: pdf[1].trim(), kind: 'pdf', text: pdf[2] });
    }
  }
  return out.slice(-60);
}

// ---------- views ----------

const chipsOf = (s, now) => {
  const verified = s.quotes.length ? (s.quotes.every((q) => q.verified === true) ? true : s.quotes.some((q) => q.verified === false) ? false : null) : undefined;
  return quality.assess({ ...s, verified, quotes: s.quotes.length ? s.quotes : undefined }, { now }).chips;
};

// What the panel and the Sources list draw: each source with its chips, a one-line reference (APA) and its links.
function view(board, { now = new Date() } = {}) {
  return {
    count: board.sources.length,
    sources: board.sources.map((s) => {
      const reference = (() => { try { return citations.format(s, 'apa').text; } catch { return s.title; } })();
      return {
        n: s.n, title: s.title, authors: s.authors, year: s.year, venue: s.venue || s.siteName, doi: s.doi, url: s.url, pdfUrl: s.pdfUrl, oaUrl: s.oaUrl, starred: s.starred, note: s.note, by: s.by,
        abstract: s.abstract, chips: chipsOf(s, now), reference, host: quality.hostOf(s.url),
        quotes: s.quotes.map((q) => ({ ...q, link: q.url || fragmentUrl(s.url, q.text, { page: q.page }) })),
      };
    }),
  };
}

// For the model: the board in a few lines (numbers, titles, quote counts, user notes).
function summary(board) {
  if (!board.sources.length) return 'The research board is empty.';
  return board.sources.map((s) => {
    const who = s.authors.slice(0, 2).map((a) => a.literal || a.family).join(', ') + (s.authors.length > 2 ? ' et al.' : '');
    const flags = [s.starred ? 'starred' : '', s.retracted ? 'RETRACTED' : '', s.by === 'user' ? 'added by user' : ''].filter(Boolean).join(', ');
    const note = s.note ? `\n    user's note: ${s.note.slice(0, 200)}` : '';
    const quotes = s.quotes.map((q) => `\n    "${q.text.slice(0, 120)}${q.text.length > 120 ? '…' : ''}"${q.page ? ` (p. ${q.page})` : ''}${q.heading ? ` (${q.heading})` : ''} ${q.verified === true ? 'verified' : q.verified === false ? 'NOT FOUND in source' : 'unverified'}`).join('');
    return `[${s.n}] ${s.title}${who ? ` — ${who}` : ''}${s.year ? ` (${s.year})` : ''} ${quality.shortLabel(s)}${flags ? ` {${flags}}` : ''}${s.url ? `\n    ${s.url}` : ''}${note}${quotes}`;
  }).join('\n');
}

module.exports = {
  MAX_SOURCES, MAX_QUOTES, VERSION, emptyBoard, normalizeBoard, cleanSource, cleanQuote, addSource, removeSource, updateSource, addQuote, removeQuote, byNumber,
  fragmentUrl, squash, findQuote, verifyQuote, collectTexts, view, summary, keysOf, findDuplicate,
};
