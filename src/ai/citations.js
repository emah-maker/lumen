// A small CSL-like citation formatter: APA 7, MLA 9, Chicago (author-date, 17th), IEEE, plus BibTeX and RIS export. No
// dependencies, Electron-free, pure functions, so test/research-units.js checks every style against known-correct examples.
//
// Input: one source record as the Research board keeps it (src/ai/research-board.js; the scholarly APIs' works have the same
// fields): { type, title, authors: [{ family, given } | { literal }], year, month, day, venue (journal / container / site),
// siteName, volume, issue, pages, publisher, place, edition, doi, url, accessed (ISO date), arxivId }.
// `type` is one of: article-journal, paper-conference, article (preprint), book, chapter, thesis, report, webpage; any
// other value, or none, is guessed from the fields (a journal name -> article, else webpage).
//
// What it does NOT do: look anything up, abbreviate journal names (IEEE wants abbreviations: the full name is used), or know
// proper nouns (APA's sentence case lowercases a Title Case title heuristically, see sentenceCase). The copy buttons say
// "check against your style guide"; this is a drafting aid, not a replacement for one.
const ITALIC_ON = '\u0001';
const ITALIC_OFF = '\u0002';
const I = (text) => (text ? `${ITALIC_ON}${text}${ITALIC_OFF}` : '');
const plain = (s) => s.replace(/[\u0001\u0002]/g, '');
const toHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/\u0001/g, '<i>').replace(/\u0002/g, '</i>');
const toMarkdown = (s) => s.replace(/[\u0001\u0002]/g, '*');

const STYLES = ['apa', 'mla', 'chicago', 'ieee'];
const STYLE_NAMES = { apa: 'APA 7', mla: 'MLA 9', chicago: 'Chicago (author-date)', ieee: 'IEEE', bibtex: 'BibTeX', ris: 'RIS' };
const EXPORTS = ['bibtex', 'ris'];

const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u0001\u0002]/g, ' ').replace(/\s+/g, ' ').trim();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MLA_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const IEEE_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

// ---------- normalising ----------

function normalize(src) {
  const s = src || {};
  const year = Number(s.year) || (Number(String(s.date || '').slice(0, 4)) || null);
  const month = Number(s.month) || (/^\d{4}-(\d{2})/.test(String(s.date || '')) ? Number(RegExp.$1) : null);
  const day = Number(s.day) || (/^\d{4}-\d{2}-(\d{2})/.test(String(s.date || '')) ? Number(RegExp.$1) : null);
  const authors = (Array.isArray(s.authors) ? s.authors : []).map((a) => (typeof a === 'string' ? parseAuthor(a) : a)).filter(Boolean)
    .map((a) => (a.literal ? { literal: clean(a.literal) } : { family: clean(a.family), given: clean(a.given) })).filter((a) => a.literal || a.family);
  const doi = clean(s.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  const url = /^https?:\/\//i.test(clean(s.url)) ? clean(s.url) : '';
  const out = {
    type: cslType(s), title: clean(s.title).replace(/\.+$/, (m) => (m.length > 1 ? m : '')), authors, year: year && year > 0 ? year : null, month: month >= 1 && month <= 12 ? month : null, day: day >= 1 && day <= 31 ? day : null,
    venue: clean(s.venue), siteName: clean(s.siteName), volume: clean(s.volume), issue: clean(s.issue), pages: clean(s.pages).replace(/\s*[-–—]+\s*/g, '–'),
    publisher: clean(s.publisher), place: clean(s.place), edition: clean(s.edition), doi, url, accessed: clean(s.accessed), arxivId: clean(s.arxivId),
  };
  if (/^(\d+)(st|nd|rd|th)?( ed\.?| edition)?$/i.test(out.edition)) out.edition = `${RegExp.$1}${ordinalSuffix(Number(RegExp.$1))}`;
  return out;
}
const ordinalSuffix = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th');

const CSL_TYPES = new Set(['article-journal', 'paper-conference', 'article', 'book', 'chapter', 'thesis', 'report', 'webpage']);
function cslType(s) {
  if (CSL_TYPES.has(s.cslType)) return s.cslType; // the board stores the exact type; a raw API "article" below is a journal article
  const t = String(s.type || '').toLowerCase();
  if (t === 'article' && s.arxivId) return 'article';
  if (/journal|^article$/.test(t) && !/preprint/.test(t)) return 'article-journal';
  if (/proceedings|conference|paper-conference/.test(t)) return 'paper-conference';
  if (/preprint|posted-content/.test(t)) return 'article';
  if (/^book$|monograph/.test(t)) return 'book';
  if (/chapter/.test(t)) return 'chapter';
  if (/thesis|dissertation/.test(t)) return 'thesis';
  if (/report/.test(t)) return 'report';
  if (/web|site|news|blog/.test(t)) return 'webpage';
  if (s.arxivId) return 'article';
  if (clean(s.venue) && (s.doi || s.volume || s.issue)) return 'article-journal';
  return 'webpage';
}

function parseAuthor(text) {
  const t = clean(text);
  if (!t) return null;
  if (t.includes(',')) { const [family, ...rest] = t.split(','); return { family: clean(family), given: clean(rest.join(' ')) }; }
  const w = t.split(' ');
  return w.length === 1 ? { literal: t } : { family: w[w.length - 1], given: w.slice(0, -1).join(' ') };
}

// ---------- shared pieces ----------

// "John Adam" -> "J. A."; "Jean-Paul" -> "J.-P."; "J.A." -> "J. A."
function initials(given) {
  return clean(given).split(/\s+/).filter(Boolean).map((part) => part.split('-').map((p) => {
    const letters = p.replace(/\./g, '');
    if (!letters) return '';
    if (letters.length > 1 && letters === letters.toUpperCase() && p.includes('.')) return letters.split('').map((c) => `${c}.`).join(' ');
    return `${[...letters][0].toUpperCase()}.`;
  }).filter(Boolean).join('-')).join(' ');
}
const fullFirst = (a) => (a.literal ? a.literal : [a.given, a.family].filter(Boolean).join(' '));
const inverted = (a) => (a.literal ? a.literal : [a.family, a.given].filter(Boolean).join(', '));

// Puts a full stop after `s` unless it already ends in one (or ? !), looking past italic marks and closing quotes.
function dot(s) {
  const visible = plain(s).replace(/["”’')\]]+$/, '');
  return s && !/[.?!]$/.test(visible) ? `${s}.` : s;
}
// A title in italics followed by its full stop, which stays roman ("*Title*."), unless the title ends in ? or !.
const idot = (title) => (/[?!]$/.test(title) ? I(title) : `${I(title)}.`);
const isRange = (pages) => /[–,]/.test(pages);

const TITLE_MINOR = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'in', 'of', 'off', 'on', 'per', 'to', 'up', 'via', 'with', 'from', 'into', 'over', 'than', 'vs', 'vs.', 'among', 'between', 'through', 'during', 'about', 'above', 'across', 'after', 'against', 'along', 'around', 'before', 'behind', 'below', 'beneath', 'beside', 'beyond', 'despite', 'down', 'inside', 'near', 'onto', 'outside', 'past', 'since', 'throughout', 'toward', 'towards', 'under', 'until', 'upon', 'within', 'without']);
// Title case that only ever raises letters (never lowers one), so a proper noun or acronym is never damaged.
function titleCase(title) {
  const words = String(title).split(/(\s+)/);
  let first = true;
  let afterColon = false;
  const wordIdx = words.map((w, i) => (/\S/.test(w) ? i : -1)).filter((i) => i >= 0);
  const last = wordIdx[wordIdx.length - 1];
  return words.map((w, i) => {
    if (!/\S/.test(w)) return w;
    const bare = w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9.]+$/g, '');
    const force = first || afterColon || i === last;
    first = false;
    afterColon = /[:?!.—–]$/.test(w);
    if (!force && TITLE_MINOR.has(bare)) return w;
    if (/^.[^\s]*[A-Z]/.test(w.replace(/^[^A-Za-z]+/, ''))) return w; // iPhone, eBay, McDonald: already as written
    return w.replace(/^([^A-Za-z\u00C0-\u024F]*)([a-z\u00DF-\u00FF])/, (_m, pre, c) => `${pre}${c.toUpperCase()}`);
  }).join('');
}
// APA's sentence case, applied only to a title that looks Title Cased (most long words capitalised). Acronyms (2+ capitals),
// mixed-case words (iPhone), the first word and the first word after a colon keep their case; everything else is lowered.
// Proper nouns inside a Title Cased title are lost: check them.
function sentenceCase(title) {
  const words = String(title).split(/(\s+)/);
  const long = words.filter((w) => /^[A-Za-z]{4,}/.test(w.replace(/^[^A-Za-z]+/, '')));
  if (long.length < 2 || long.filter((w) => /^[A-Z]/.test(w.replace(/^[^A-Za-z]+/, ''))).length / long.length < 0.7) return title;
  let first = true;
  let afterColon = false;
  return words.map((w) => {
    if (!/\S/.test(w)) return w;
    const keep = first || afterColon || /[A-Z].*[A-Z]/.test(w) || /\d/.test(w) && /[A-Z]/.test(w);
    first = false;
    afterColon = /[:?!]$/.test(w);
    return keep ? w : w.replace(/^([^A-Za-z]*)([A-Z])([a-z]+[^A-Za-z]*)$/, (_m, pre, c, rest) => `${pre}${c.toLowerCase()}${rest}`);
  }).join('');
}

const doiUrl = (c) => (c.doi ? `https://doi.org/${c.doi}` : '');
const stripProtocol = (u) => u.replace(/^https?:\/\//i, '').replace(/\/$/, '');
const hostName = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function accessedParts(c) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(c.accessed);
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}
const site = (c) => c.siteName || c.venue || '';

// ---------- APA 7 ----------

function apaAuthors(list) {
  const names = list.map((a) => (a.literal ? a.literal : `${a.family}${a.given ? `, ${initials(a.given)}` : ''}`));
  if (names.length === 1) return names[0];
  if (names.length <= 20) return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  return `${names.slice(0, 19).join(', ')}, \u0003 ${names[names.length - 1]}`; // \u0003: the ". . ." of APA, put back after the spacing clean-up
}
function apaDate(c, { full = false } = {}) {
  if (!c.year) return '(n.d.)';
  if (full && c.month) return `(${c.year}, ${MONTHS[c.month - 1]}${c.day ? ` ${c.day}` : ''})`;
  return `(${c.year})`;
}
function apa(c) {
  const t = c.type;
  const title = sentenceCase(c.title);
  const link = doiUrl(c) || c.url;
  const who = c.authors.length ? apaAuthors(c.authors) : '';
  const date = apaDate(c, { full: t === 'webpage' });
  const head = (workTitle) => (who ? `${dot(who)} ${date}.` : `${workTitle} ${date}.`);
  const tail = (...parts) => parts.filter(Boolean).join(' ');
  if (t === 'article-journal') {
    const pages = c.pages ? `, ${c.pages}` : '';
    const source = c.venue ? `${c.volume ? `${I(`${c.venue}, ${c.volume}`)}${c.issue ? `(${c.issue})` : ''}` : I(c.venue)}${pages}.` : '';
    return tail(head(dot(title)), who ? dot(title) : '', source, link);
  }
  if (t === 'book') { const named = `${I(title)}${c.edition ? ` (${c.edition} ed.)` : ''}.`; return tail(head(named), who ? named : '', c.publisher ? dot(c.publisher) : '', link); }
  if (t === 'chapter') return tail(head(dot(title)), who ? dot(title) : '', c.venue ? `In ${I(c.venue)}${c.pages ? ` (pp. ${c.pages})` : ''}.` : '', c.publisher ? dot(c.publisher) : '', link);
  if (t === 'paper-conference') return tail(head(dot(title)), who ? dot(title) : '', c.venue ? `In ${I(c.venue)}${c.pages ? ` (pp. ${c.pages})` : ''}.` : '', c.publisher ? dot(c.publisher) : '', link);
  if (t === 'article') return tail(head(idot(title)), who ? idot(title) : '', dot(c.venue && c.venue !== 'arXiv' ? c.venue : c.publisher || c.venue || ''), link);
  if (t === 'thesis') { const named = `${I(title)} [${c.publisher ? `Thesis, ${c.publisher}` : 'Thesis'}].`; return tail(head(named), who ? named : '', link); }
  if (t === 'report') return tail(head(idot(title)), who ? idot(title) : '', c.publisher ? dot(c.publisher) : '', link);
  // webpage
  const siteName = site(c);
  const publisherSame = siteName && c.authors.length === 1 && (c.authors[0].literal || '').toLowerCase() === siteName.toLowerCase();
  return tail(head(idot(title)), who ? idot(title) : '', siteName && !publisherSame ? dot(siteName) : '', link);
}

// ---------- MLA 9 ----------

function mlaAuthors(list) {
  if (!list.length) return '';
  if (list.length === 1) return inverted(list[0]);
  if (list.length === 2) return `${inverted(list[0])}, and ${fullFirst(list[1])}`;
  return `${inverted(list[0])}, et al`;
}
const mlaQuote = (title) => (/[?!]$/.test(title) ? `“${title}”` : `“${title}.”`);
function mlaDate(c) {
  if (!c.year) return '';
  if (c.month && c.day) return `${c.day} ${MLA_MONTHS[c.month - 1]} ${c.year}`;
  if (c.month) return `${MLA_MONTHS[c.month - 1]} ${c.year}`;
  return String(c.year);
}
function mla(c) {
  const t = c.type;
  const who = mlaAuthors(c.authors);
  const lead = who ? `${dot(who)} ` : '';
  const doiLink = doiUrl(c);
  const urlLink = c.url ? stripProtocol(c.url) : '';
  const link = doiLink || urlLink;
  const end = (parts) => { const s = parts.filter(Boolean).join(', '); return s ? `${dot(s)}` : ''; };
  const withLink = (parts) => `${end([...parts, link])}`;
  const pg = c.pages ? `${isRange(c.pages) ? 'pp.' : 'p.'} ${c.pages.replace(/–/g, '-')}` : '';
  if (t === 'article-journal') {
    const container = [I(c.venue), c.volume ? `vol. ${c.volume}` : '', c.issue ? `no. ${c.issue}` : '', c.year ? String(c.year) : '', pg];
    return `${lead}${who ? `${mlaQuote(titleCase(c.title))} ` : `${mlaQuote(titleCase(c.title))} `}${withLink(container)}`.trim();
  }
  if (t === 'book') {
    const ed = c.edition ? `${c.edition} ed.` : '';
    return `${lead}${idot(titleCase(c.title))} ${[ed, c.publisher, c.year ? String(c.year) : ''].filter(Boolean).join(', ')}${link ? `, ${link}` : ''}.`.replace(/\.\.$/, '.').replace(/ \./, '.');
  }
  if (t === 'chapter' || t === 'paper-conference') {
    const container = [I(c.venue), c.publisher, mlaDate(c), pg];
    return `${lead}${mlaQuote(titleCase(c.title))} ${withLink(container)}`.trim();
  }
  if (t === 'article') return `${lead}${mlaQuote(titleCase(c.title))} ${withLink([I(c.venue || c.publisher || 'arXiv'), mlaDate(c)])}`.trim();
  if (t === 'thesis') return `${lead}${idot(titleCase(c.title))} ${withLink([c.year ? String(c.year) : '', c.publisher, 'Thesis'])}`.trim();
  if (t === 'report') return `${lead}${idot(titleCase(c.title))} ${withLink([c.publisher, mlaDate(c)])}`.trim();
  // webpage
  const acc = accessedParts(c);
  const accessedText = acc ? `Accessed ${acc.day} ${MLA_MONTHS[acc.month - 1]} ${acc.year}.` : '';
  const siteName = site(c) || hostName(c.url);
  const sameAsAuthor = siteName && c.authors.length === 1 && (c.authors[0].literal || '').toLowerCase() === siteName.toLowerCase();
  const container = [siteName && !sameAsAuthor ? I(siteName) : '', c.publisher && c.publisher !== siteName ? c.publisher : '', mlaDate(c)];
  return `${lead}${mlaQuote(titleCase(c.title))} ${withLink(container)}${accessedText ? ` ${accessedText}` : ''}`.trim();
}

// ---------- Chicago author-date (17th) ----------

function chicagoAuthors(list) {
  if (!list.length) return '';
  let names = list.map((a, i) => (i === 0 ? inverted(a) : fullFirst(a)));
  let etal = false;
  if (names.length > 10) { names = names.slice(0, 7); etal = true; }
  if (etal) return `${names.join(', ')}, et al.`;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}
// 165–176 -> 165–76 (CMOS 9.61): under 100 or a multiple of 100 in full; 101-109 the changed digit; otherwise the last two digits when the hundreds match.
function chicagoPages(pages) {
  const m = /^(\d+)–(\d+)$/.exec(pages);
  if (!m) return pages;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (b <= a || a < 100 || a % 100 === 0 || Math.floor(a / 100) !== Math.floor(b / 100)) return pages;
  const rest = b % 100;
  return `${m[1]}–${a % 100 < 10 ? String(rest) : String(rest).padStart(2, '0')}`;
}
function chicago(c) {
  const t = c.type;
  const siteName = site(c) || hostName(c.url);
  let who = chicagoAuthors(c.authors);
  const sameAsAuthor = !who && t === 'webpage' && site(c);
  if (sameAsAuthor) who = site(c);
  const year = c.year ? String(c.year) : 'n.d.';
  const link = doiUrl(c) || c.url;
  const lead = who ? `${dot(who)} ` : '';
  const join = (...parts) => parts.filter(Boolean).join(' ').trim();
  const q = (title) => (/[?!]$/.test(title) ? `“${title}”` : `“${title}.”`);
  const date = c.month && c.day ? `${MONTHS[c.month - 1]} ${c.day}, ${c.year}.` : '';
  const tt = titleCase(c.title);
  // No author: the title takes the author's place (CMOS 15.36).
  const hq = who ? [lead + `${year}.`, q(tt)] : [q(tt), `${year}.`];
  const hi = who ? [lead + `${year}.`, idot(tt)] : [idot(tt), `${year}.`];
  if (t === 'article-journal') {
    const vol = c.volume ? ` ${c.volume}${c.issue ? ` (${c.issue})` : ''}` : '';
    const pages = c.pages ? `${c.volume ? ': ' : ', '}${chicagoPages(c.pages)}` : '';
    return join(...hq, c.venue ? `${I(c.venue)}${vol}${pages}.` : '', link ? dot(link) : '').replace(/\.\.$/, '.');
  }
  if (t === 'book') return join(...hi, c.edition ? `${c.edition} ed.` : '', c.publisher ? `${c.place ? `${c.place}: ` : ''}${dot(c.publisher)}` : '', link ? dot(link) : '');
  if (t === 'chapter' || t === 'paper-conference') return join(...hq, c.venue ? `In ${I(c.venue)}${c.pages ? `, ${c.pages}` : ''}.` : '', c.publisher ? `${c.place ? `${c.place}: ` : ''}${dot(c.publisher)}` : '', link ? dot(link) : '');
  if (t === 'article') return join(...hq, `${I(c.venue || c.publisher || 'arXiv')}${c.arxivId && !c.doi ? ` ${c.arxivId}` : ''}.`, link ? dot(link) : '');
  if (t === 'thesis') return join(...hq, `${c.publisher ? `${c.publisher}.` : 'Thesis.'}`, link ? dot(link) : '');
  if (t === 'report') return join(...hi, c.publisher ? `${c.place ? `${c.place}: ` : ''}${dot(c.publisher)}` : '', link ? dot(link) : '');
  return join(...hq, siteName && !sameAsAuthor && siteName !== who ? `${dot(siteName)}` : '', date, link ? dot(link) : '');
}

// ---------- IEEE ----------

function ieeeAuthors(list) {
  const names = list.map((a) => (a.literal ? a.literal : `${a.given ? `${initials(a.given)} ` : ''}${a.family}`));
  if (names.length > 6) return `${names[0]} et al.`;
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}
function ieeeDate(c) { return c.year ? `${c.month ? `${IEEE_MONTHS[c.month - 1]} ` : ''}${c.year}` : ''; }
function ieee(c, index) {
  const t = c.type;
  const num = index ? `[${index}] ` : '';
  const who = ieeeAuthors(c.authors);
  const pg = c.pages ? `${isRange(c.pages) ? 'pp.' : 'p.'} ${c.pages}` : '';
  const doi = c.doi ? `doi: ${c.doi}` : '';
  const joinC = (parts) => parts.filter(Boolean).join(', ');
  const q = (title) => `“${title},”`;
  const lead = who ? `${who}, ` : '';
  const tt = t === 'book' ? titleCase(c.title) : sentenceCase(c.title);
  if (t === 'article-journal') return `${num}${lead}${q(tt)} ${joinC([I(c.venue), c.volume ? `vol. ${c.volume}` : '', c.issue ? `no. ${c.issue}` : '', pg, ieeeDate(c), doi || (c.url ? `[Online]. Available: ${c.url}` : ''), ''].slice(0, -1))}.`.replace(/\.\.$/, '.').replace(/, \[Online\]/, '. [Online]');
  if (t === 'book') return `${num}${lead}${I(tt)}${c.edition ? `, ${c.edition} ed` : ''}. ${c.place ? `${c.place}: ` : ''}${joinC([c.publisher, c.year ? String(c.year) : ''])}.`.replace(/\. \./, '.');
  if (t === 'paper-conference' || t === 'chapter') return `${num}${lead}${q(tt)} in ${joinC([I(c.venue), c.publisher, ieeeDate(c), pg, doi])}.`;
  if (t === 'article') return `${num}${lead}${q(tt)} ${c.arxivId ? `arXiv:${c.arxivId}` : joinC([I(c.venue || c.publisher)])}, ${ieeeDate(c) || 'n.d.'}${c.doi ? `, ${doi}` : c.url && !c.arxivId ? `. [Online]. Available: ${c.url}` : ''}.`.replace(/\.\.$/, '.');
  if (t === 'thesis') return `${num}${lead}${q(tt)} ${joinC([c.publisher, ieeeDate(c)])}.`;
  if (t === 'report') return `${num}${lead}${q(tt)} ${joinC([c.publisher, ieeeDate(c)])}.`;
  const acc = accessedParts(c);
  const accessedText = acc ? ` (accessed ${IEEE_MONTHS[acc.month - 1]} ${acc.day}, ${acc.year})` : '';
  const siteName = site(c) || hostName(c.url);
  return `${num}${lead}${q(tt)} ${siteName ? `${siteName}. ` : ''}${c.url ? `[Online]. Available: ${c.url}` : ''}${accessedText}${c.url ? '.' : ''}`.trim().replace(/\.\.$/, '.');
}

// ---------- BibTeX and RIS ----------

const BIB_TYPE = { 'article-journal': 'article', 'paper-conference': 'inproceedings', article: 'misc', book: 'book', chapter: 'incollection', thesis: 'phdthesis', report: 'techreport', webpage: 'misc' };
const bibEscape = (s) => String(s).replace(/([&%$#_])/g, '\\$1').replace(/[{}]/g, '');
function bibKey(c, taken = new Set()) {
  const a = c.authors[0];
  const family = (a ? a.family || a.literal : c.title.split(' ')[0] || 'source').normalize('NFKD').replace(/[^A-Za-z]/g, '').toLowerCase() || 'source';
  const stop = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'to', 'and', 'for']);
  const word = (c.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').split(' ').find((w) => w && !stop.has(w)) || '');
  const base = `${family}${c.year || 'nd'}${word}`;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${String.fromCharCode(95 + n)}`;
  taken.add(key);
  return key;
}
function bibtex(c, taken) {
  const type = BIB_TYPE[c.type] || 'misc';
  const authors = c.authors.map((a) => (a.literal ? `{${bibEscape(a.literal)}}` : `${bibEscape(a.family)}${a.given ? `, ${bibEscape(a.given)}` : ''}`)).join(' and ');
  const fields = [['author', authors], ['title', c.title ? `{${bibEscape(c.title)}}` : ''], ['year', c.year || '']];
  const venueField = type === 'article' ? 'journal' : type === 'inproceedings' || type === 'incollection' ? 'booktitle' : type === 'misc' && c.type === 'article' ? 'howpublished' : '';
  if (c.type === 'article') fields.push(c.arxivId ? ['eprint', c.arxivId] : null, c.arxivId ? ['archiveprefix', 'arXiv'] : ['howpublished', bibEscape(c.venue || c.publisher)]);
  else if (venueField) fields.push([venueField, bibEscape(c.venue)]);
  else if (c.type === 'webpage' && site(c)) fields.push(['howpublished', bibEscape(site(c))]);
  if (c.month) fields.push(['month', ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][c.month - 1]]);
  fields.push(['volume', bibEscape(c.volume)], ['number', bibEscape(c.issue)], ['pages', c.pages.replace('–', '--')], ['publisher', bibEscape(c.type === 'article' ? '' : c.publisher)], ['address', bibEscape(c.place)], ['edition', c.edition],
    ['doi', c.doi], ['url', c.url && !c.doi ? c.url : c.url]);
  if (c.type === 'thesis') fields.push(['school', bibEscape(c.publisher)]);
  const body = fields.filter((f) => f && f[1] !== '' && f[1] !== undefined).map(([k, v]) => `  ${k} = ${k === 'month' || k === 'year' ? v : /^\{/.test(String(v)) ? v : `{${v}}`}`);
  return `@${type}{${bibKey(c, taken)},\n${body.join(',\n')}\n}`;
}

const RIS_TYPE = { 'article-journal': 'JOUR', 'paper-conference': 'CONF', article: 'JOUR', book: 'BOOK', chapter: 'CHAP', thesis: 'THES', report: 'RPRT', webpage: 'ELEC' };
function ris(c) {
  const lines = [`TY  - ${RIS_TYPE[c.type] || 'GEN'}`];
  for (const a of c.authors) lines.push(`AU  - ${a.literal ? a.literal : `${a.family}${a.given ? `, ${a.given}` : ''}`}`);
  lines.push(`TI  - ${c.title}`);
  if (c.venue) lines.push(`${c.type === 'article-journal' || c.type === 'article' ? 'JO' : 'T2'}  - ${c.type === 'article' && !c.venue ? 'arXiv' : c.venue}`);
  if (c.year) lines.push(`PY  - ${c.year}${c.month ? `/${String(c.month).padStart(2, '0')}${c.day ? `/${String(c.day).padStart(2, '0')}` : '/'}` : ''}`.replace(/\/$/, ''));
  if (c.volume) lines.push(`VL  - ${c.volume}`);
  if (c.issue) lines.push(`IS  - ${c.issue}`);
  if (c.pages) { const [a, b] = c.pages.split('–'); lines.push(`SP  - ${a}`); if (b) lines.push(`EP  - ${b}`); }
  if (c.publisher) lines.push(`PB  - ${c.publisher}`);
  if (c.place) lines.push(`CY  - ${c.place}`);
  if (c.doi) lines.push(`DO  - ${c.doi}`);
  if (c.url) lines.push(`UR  - ${c.url}`);
  lines.push('ER  - ');
  return lines.join('\n');
}

// ---------- the public API ----------

const RENDERERS = { apa, mla, chicago, ieee };

// format(source, 'apa' | 'mla' | 'chicago' | 'ieee' | 'bibtex' | 'ris', { index }) -> { text, html, markdown }
function format(source, style = 'apa', { index = 0, keys } = {}) {
  const c = normalize(source);
  if (!c.title && !c.authors.length) throw new Error('This source has no title or author to cite.');
  if (!c.title) c.title = 'Untitled';
  if (style === 'bibtex') { const t = bibtex(c, keys || new Set()); return { text: t, html: toHtml(t), markdown: t }; }
  if (style === 'ris') { const t = ris(c); return { text: t, html: toHtml(t), markdown: t }; }
  const fn = RENDERERS[style];
  if (!fn) throw new Error(`Unknown citation style: ${style}. Use ${STYLES.concat(EXPORTS).join(', ')}.`);
  const raw = fn(c, index).replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1').replace(/\.{2,}(?!\.)/g, '.').trim();
  const done = raw.replace(/\u0003/g, '. . .');
  return { text: plain(done), html: toHtml(done), markdown: toMarkdown(done) };
}

const sortKey = (c) => `${(c.authors[0]?.family || c.authors[0]?.literal || c.title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '')}|${c.year || 9999}|${(c.title || '').toLowerCase()}`;

// A whole bibliography: APA / MLA / Chicago alphabetical by first author (then year), IEEE in the order given, numbered;
// BibTeX / RIS joined by blank lines. -> { text, html, markdown, count }
function bibliography(sources, style = 'apa') {
  const list = (Array.isArray(sources) ? sources : []).map((s) => ({ s, c: normalize(s) })).filter(({ c }) => c.title || c.authors.length);
  if (!list.length) throw new Error('Nothing to cite: add sources to the research board first.');
  if (style !== 'ieee' && style !== 'bibtex' && style !== 'ris') list.sort((a, b) => (sortKey(a.c) < sortKey(b.c) ? -1 : sortKey(a.c) > sortKey(b.c) ? 1 : 0));
  const keys = new Set();
  const items = list.map(({ s }, i) => format(s, style, { index: i + 1, keys }));
  const sep = style === 'bibtex' || style === 'ris' ? '\n\n' : '\n';
  return { text: items.map((x) => x.text).join(sep), html: style === 'ieee' || style === 'bibtex' || style === 'ris' ? items.map((x) => x.html).join(sep === '\n' ? '<br>' : '<br><br>') : items.map((x) => `<p style="margin:0 0 .6em 2em;text-indent:-2em">${x.html}</p>`).join(''), markdown: items.map((x) => x.markdown).join(sep), count: items.length };
}

module.exports = { STYLES, EXPORTS, STYLE_NAMES, format, bibliography, normalize, cslType, initials, titleCase, sentenceCase, parseAuthor, bibKey };
