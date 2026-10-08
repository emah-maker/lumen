// find_sources: scholarly source finding over free, keyless public APIs. Electron-free (the fetch is injected), so
// test/research-units.js covers it in plain Node against saved responses (test/fixtures/research), with no network.
//
//   OpenAlex          works search, open-access location (best_oa_location, the Unpaywall data), citation counts, is_retracted,
//                     and the cites / cited_by filters used for snowballing
//   Crossref          works search; retractions via updated-by (Retraction Watch data) and "Retracted:" titles
//   Semantic Scholar  paper search, citations and references of one paper
//   arXiv             Atom feed (preprints)
//   PubMed            E-utilities esearch + esummary (biomedicine)
//
// Privacy: nothing about the user is sent: no key, no mailto, no cookies; the only thing that leaves is the search text the AI
// chose. Every request has a timeout, a per-API spacing and a request budget; 429 / 5xx answers are retried with a capped
// backoff (Retry-After honoured); a failing API never fails the search, it is named under `errors`.
const quality = require('./source-quality');

const TIMEOUT_MS = 10000;
const MAX_RETRY_WAIT_MS = 4000;
const ATTEMPTS = 3;
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;
const ABSTRACT_CHARS = 600;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 60;
// Spacing between calls to one API (their published etiquette) and the most calls one find() makes to it.
const API_RULES = {
  openalex: { gap: 120, budget: 3 },
  crossref: { gap: 120, budget: 2 },
  semanticscholar: { gap: 1100, budget: 2 },
  arxiv: { gap: 3100, budget: 1 },
  pubmed: { gap: 350, budget: 2 },
};
const ALL_APIS = Object.keys(API_RULES);
const API_LABEL = { openalex: 'OpenAlex', crossref: 'Crossref', semanticscholar: 'Semantic Scholar', arxiv: 'arXiv', pubmed: 'PubMed' };

const clean = (text) => String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : null);
const stripTags = (html) => clean(String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&'));

// ---------- identifiers and names ----------

// A DOI at the end of a sentence or inside (parentheses): drop trailing punctuation, and a closing bracket only when nothing opened it.
function trimDoi(doi) {
  let d = doi.replace(/[.,;:]+$/, '');
  while (/[)\]]$/.test(d)) {
    const [open, close] = d.endsWith(')') ? ['(', ')'] : ['[', ']'];
    if (d.split(close).length <= d.split(open).length) break;
    d = d.slice(0, -1).replace(/[.,;:]+$/, '');
  }
  return d;
}
function normDoi(value) {
  const m = /10\.\d{4,9}\/[^\s"<>]+/i.exec(String(value ?? '').replace(/^doi:\s*/i, ''));
  return m ? trimDoi(m[0].toLowerCase()) : '';
}
const normTitle = (title) => clean(title).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'dos', 'du', 'la', 'le', 'bin', 'ibn', 'al', 'el', 'st', 'ter', 'ten']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
// "Najia Zulfiqar" -> { family: 'Zulfiqar', given: 'Najia' }; "Zulfiqar, Najia" and "Nakahori N" (PubMed) work too; "WHO" stays literal.
function parseName(raw) {
  const text = clean(raw).replace(/\.$/, '');
  if (!text) return null;
  if (text.includes(',')) {
    const [family, ...rest] = text.split(',');
    return { family: clean(family), given: clean(rest.join(' ')) };
  }
  const words = text.split(' ');
  if (words.length === 1) return { literal: text };
  let suffix = '';
  if (words.length > 2 && SUFFIXES.has(words[words.length - 1].toLowerCase().replace(/\./g, ''))) suffix = ` ${words.pop()}`;
  let i = words.length - 1;
  while (i > 1 && PARTICLES.has(words[i - 1].toLowerCase())) i--;
  return { family: `${words.slice(i).join(' ')}${suffix}`, given: words.slice(0, i).join(' ') };
}
// PubMed lists "Nakahori N" (family, initials): the family is everything before the trailing initials.
function parsePubmedName(raw) {
  const text = clean(raw);
  const m = /^(.+?)\s+([A-Z]{1,4})$/.exec(text);
  return m ? { family: m[1], given: m[2].split('').join('. ') + '.' } : parseName(text);
}

function dateParts(value) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(value ?? ''));
  return m ? { year: Number(m[1]), month: m[2] ? Number(m[2]) : null, day: m[3] ? Number(m[3]) : null } : { year: null, month: null, day: null };
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ---------- parsers: one saved API answer -> [work] ----------
// A work: { title, authors[{family,given}|{literal}], year, month, day, venue, doi, url, pdfUrl, citations, abstract, type, volume,
// issue, pages, publisher, retracted, retractionNotice, ids: {...}, from: [api] }. Missing fields are '' / null / [], never invented.

const base = (api) => ({ title: '', authors: [], year: null, month: null, day: null, venue: '', doi: '', url: '', pdfUrl: '', oaUrl: '', retractedBy: [], citations: null, abstract: '', type: '', volume: '', issue: '', pages: '', publisher: '', retracted: false, retractionNotice: false, ids: {}, from: [api] });

function invertedIndexText(index) {
  if (!index || typeof index !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) for (const p of Array.isArray(positions) ? positions : []) if (Number.isInteger(p) && p >= 0 && p < 5000) words[p] = word;
  return clean(words.filter((w) => w !== undefined).join(' '));
}

function parseOpenAlex(json) {
  const rows = Array.isArray(json?.results) ? json.results : [];
  return rows.map((r) => {
    const w = base('openalex');
    w.title = stripTags(r.title || r.display_name);
    w.authors = (r.authorships || []).map((a) => parseName(a?.author?.display_name || a?.raw_author_name)).filter(Boolean);
    const date = dateParts(r.publication_date || r.publication_year);
    Object.assign(w, { year: num(r.publication_year) ?? date.year, month: date.month, day: date.day });
    w.doi = normDoi(r.doi);
    const loc = r.primary_location || {};
    const oa = r.best_oa_location || {};
    w.venue = clean(loc.source?.display_name || loc.raw_source_name);
    w.venueType = clean(loc.source?.type);
    w.publisher = clean(loc.source?.host_organization_name);
    w.url = loc.landing_page_url || oa.landing_page_url || (w.doi ? `https://doi.org/${w.doi}` : '') || '';
    w.pdfUrl = oa.pdf_url || '';
    w.oaUrl = w.pdfUrl ? '' : (oa.landing_page_url || (r.open_access?.is_oa ? r.open_access.oa_url || '' : '') || ''); // free to read, but a web page, not a PDF
    w.oaStatus = clean(r.open_access?.oa_status);
    w.citations = num(r.cited_by_count);
    w.abstract = invertedIndexText(r.abstract_inverted_index);
    w.type = clean(loc.raw_type || r.type);
    w.workType = clean(r.type);
    w.volume = clean(r.biblio?.volume);
    w.issue = clean(r.biblio?.issue);
    w.pages = r.biblio?.first_page ? (r.biblio.last_page && r.biblio.last_page !== r.biblio.first_page ? `${r.biblio.first_page}-${r.biblio.last_page}` : String(r.biblio.first_page)) : '';
    w.retracted = r.is_retracted === true;
    if (w.retracted) w.retractedBy = ['OpenAlex'];
    w.ids.openalex = clean(r.id).replace('https://openalex.org/', '');
    return w;
  }).filter((w) => w.title);
}

const crTitle = (v) => stripTags(Array.isArray(v) ? v[0] : v);
function crDate(item) {
  const parts = (item.issued || item['published-print'] || item['published-online'] || item.published)?.['date-parts']?.[0];
  return Array.isArray(parts) ? { year: num(parts[0]), month: num(parts[1]), day: num(parts[2]) } : { year: null, month: null, day: null };
}
const RETRACT_TYPES = new Set(['retraction', 'withdrawal', 'removal']);
function parseCrossref(json) {
  const rows = Array.isArray(json?.message?.items) ? json.message.items : Array.isArray(json?.message) ? json.message : json?.message?.DOI ? [json.message] : [];
  return rows.map((r) => {
    const w = base('crossref');
    w.title = crTitle(r.title);
    w.authors = (r.author || []).map((a) => (a.family ? { family: clean(a.family), given: clean(a.given) } : a.name ? { literal: clean(a.name) } : null)).filter(Boolean);
    Object.assign(w, crDate(r));
    w.doi = normDoi(r.DOI);
    w.venue = crTitle(r['container-title']);
    w.url = r.URL || (w.doi ? `https://doi.org/${w.doi}` : '');
    const pdf = (r.link || []).find((l) => /pdf/i.test(l['content-type'] || l.URL || '') && l['content-version'] === 'vor');
    w.pdfUrl = ''; // a Crossref link is the publisher's, often paywalled: only OpenAlex / Semantic Scholar say it is open
    w.publisherPdf = pdf?.URL || '';
    w.citations = num(r['is-referenced-by-count']);
    w.abstract = stripTags(r.abstract);
    w.type = clean(r.type);
    w.volume = clean(r.volume);
    w.issue = clean(r.issue);
    w.pages = clean(r.page || r['article-number']).replace(/--?/g, '-');
    w.publisher = clean(r.publisher);
    w.retracted = (r['updated-by'] || []).some((u) => RETRACT_TYPES.has(String(u.type).toLowerCase())) || /^\s*retracted\b[:\s]/i.test(crTitle(r.title));
    if (w.retracted) w.retractedBy = ['Crossref'];
    w.retractionNotice = !w.retracted && ((r['update-to'] || []).some((u) => RETRACT_TYPES.has(String(u.type).toLowerCase())) || /^\s*(retraction|withdrawal)( notice| note)?\b[:\s]/i.test(w.title));
    return w;
  }).filter((w) => w.title);
}

function s2Paper(p, via = 'semanticscholar') {
  const w = base(via);
  w.title = stripTags(p.title);
  w.authors = (p.authors || []).map((a) => parseName(a?.name)).filter(Boolean);
  const date = dateParts(p.publicationDate || p.year);
  Object.assign(w, { year: num(p.year) ?? date.year, month: date.month, day: date.day });
  w.doi = normDoi(p.externalIds?.DOI);
  w.venue = clean(p.journal?.name || p.venue);
  w.volume = clean(p.journal?.volume);
  w.pages = clean(p.journal?.pages).replace(/--?/g, '-');
  w.url = p.url || (w.doi ? `https://doi.org/${w.doi}` : '');
  w.pdfUrl = p.openAccessPdf?.url || '';
  w.citations = num(p.citationCount);
  w.abstract = clean(p.abstract);
  w.type = Array.isArray(p.publicationTypes) ? p.publicationTypes.join(',') : '';
  w.ids.s2 = clean(p.paperId);
  if (p.externalIds?.ArXiv) w.arxivId = p.externalIds.ArXiv;
  if (p.externalIds?.PubMed) w.ids.pmid = String(p.externalIds.PubMed);
  return w;
}
function parseSemanticScholar(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map((row) => s2Paper(row?.citingPaper || row?.citedPaper || row)).filter((w) => w.title);
}

const xmlText = (block, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? stripTags(m[1]) : '';
};
function parseArxiv(xml) {
  const entries = String(xml ?? '').split(/<entry>/i).slice(1).map((e) => e.split(/<\/entry>/i)[0]);
  return entries.map((e) => {
    const w = base('arxiv');
    w.title = xmlText(e, 'title');
    w.authors = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((m) => parseName(stripTags(m[1]))).filter(Boolean);
    Object.assign(w, dateParts(xmlText(e, 'published')));
    const id = /<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+?)\s*<\/id>/i.exec(e)?.[1] || '';
    const bare = id.replace(/v\d+$/, '');
    w.arxivId = bare;
    w.url = bare ? `https://arxiv.org/abs/${bare}` : '';
    w.pdfUrl = bare ? `https://arxiv.org/pdf/${bare}` : '';
    w.abstract = xmlText(e, 'summary');
    w.doi = normDoi(xmlText(e, 'arxiv:doi'));
    w.venue = clean(xmlText(e, 'arxiv:journal_ref')) || 'arXiv';
    w.type = 'preprint';
    w.publisher = 'arXiv';
    w.ids.arxiv = bare;
    return w;
  }).filter((w) => w.title);
}

function parsePubmed(searchJson, summaryJson) {
  const result = summaryJson?.result;
  const ids = Array.isArray(result?.uids) ? result.uids : Array.isArray(searchJson?.esearchresult?.idlist) ? searchJson.esearchresult.idlist : [];
  return ids.map((id) => result?.[id]).filter(Boolean).map((r) => {
    const w = base('pubmed');
    w.title = stripTags(r.title).replace(/\.$/, '');
    w.authors = (r.authors || []).filter((a) => !a.authtype || a.authtype === 'Author').map((a) => parsePubmedName(a.name)).filter(Boolean);
    const m = /^(\d{4})(?:\s+([A-Za-z]{3}))?(?:\s+(\d{1,2}))?/.exec(String(r.pubdate || r.epubdate || ''));
    if (m) Object.assign(w, { year: Number(m[1]), month: m[2] ? MONTHS.indexOf(m[2].toLowerCase()) + 1 || null : null, day: m[3] ? Number(m[3]) : null });
    const ids2 = r.articleids || [];
    w.doi = normDoi(ids2.find((x) => x.idtype === 'doi')?.value);
    const pmc = ids2.find((x) => x.idtype === 'pmc')?.value;
    w.venue = clean(r.fulljournalname || r.source);
    w.volume = clean(r.volume);
    w.issue = clean(r.issue);
    w.pages = clean(r.pages).replace(/--?/g, '-');
    w.url = `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`;
    w.pdfUrl = pmc ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmc}/pdf/` : '';
    w.type = 'journal-article';
    w.citations = null; // PubMed has no counts (pmcrefcount is PMC-only citing articles, a different number)
    w.retracted = (r.pubtype || []).some((t) => /^retracted publication$/i.test(t));
    if (w.retracted) w.retractedBy = ['PubMed'];
    w.retractionNotice = !w.retracted && (r.pubtype || []).some((t) => /^retraction of publication$/i.test(t));
    w.ids.pmid = String(r.uid);
    return w;
  }).filter((w) => w.title);
}

// ---------- merge and rank ----------

const workKey = (w) => (w.doi ? `d:${w.doi}` : `t:${normTitle(w.title)}`);
const better = (a, b) => (a !== '' && a !== null && a !== undefined && !(Array.isArray(a) && !a.length) ? a : b);
const longer = (a, b) => (String(a || '').length >= String(b || '').length ? a : b);

function mergeInto(into, w) {
  into.doi = better(into.doi, w.doi);
  into.title = longer(into.title, w.title);
  into.authors = into.authors.length >= w.authors.length ? into.authors : w.authors;
  for (const k of ['year', 'month', 'day']) into[k] = better(into[k], w[k]);
  for (const k of ['venue', 'venueType', 'url', 'pdfUrl', 'oaUrl', 'type', 'workType', 'volume', 'issue', 'pages', 'publisher', 'oaStatus', 'arxivId', 'publisherPdf']) into[k] = better(into[k], w[k]);
  into.abstract = longer(into.abstract, w.abstract);
  into.citations = Number.isFinite(into.citations) && Number.isFinite(w.citations) ? Math.max(into.citations, w.citations) : (Number.isFinite(into.citations) ? into.citations : w.citations);
  into.retracted = into.retracted || w.retracted;
  into.retractedBy = [...new Set([...(into.retractedBy || []), ...(w.retractedBy || [])])];
  into.retractionNotice = into.retractionNotice || w.retractionNotice;
  Object.assign(into.ids, w.ids);
  for (const f of w.from) if (!into.from.includes(f)) into.from.push(f);
  // A DOI that is the preprint's own (arXiv) does not make a journal article of it, but a journal type from any API wins over "preprint".
  if (into.type === 'preprint' && w.type && w.type !== 'preprint' && !/posted-content|preprint/i.test(w.type)) { into.type = w.type; into.venue = w.venue || into.venue; }
}

// Reciprocal-rank fusion across the APIs, then more agreeing APIs and more citations break ties. A title that matches a
// DOI'd record (same normalised title, one side without a DOI) joins it.
function mergeWorks(lists) {
  const map = new Map();
  const byTitle = new Map();
  for (const list of lists) {
    list.forEach((w, rank) => {
      const tkey = normTitle(w.title);
      let key = workKey(w);
      if (!w.doi && byTitle.has(tkey)) key = byTitle.get(tkey);
      let entry = map.get(key);
      if (!entry && w.doi && byTitle.has(tkey) && !map.get(byTitle.get(tkey)).work.doi) { // earlier DOI-less twin: re-key under the DOI
        const old = byTitle.get(tkey);
        entry = map.get(old);
        map.delete(old);
        map.set(key, entry);
      }
      if (!entry) { entry = { work: { ...w, authors: [...w.authors], ids: { ...w.ids }, from: [...w.from] }, score: 0 }; map.set(key, entry); }
      else mergeInto(entry.work, w);
      entry.score += 1 / (60 + rank);
      if (tkey) byTitle.set(tkey, key);
    });
  }
  return [...map.values()].sort((a, b) => b.score - a.score || (b.work.from.length - a.work.from.length) || ((b.work.citations || 0) - (a.work.citations || 0))).map((e) => finish(e.work));
}

function finish(w) {
  const out = { ...w, abstract: w.abstract ? (w.abstract.length > ABSTRACT_CHARS ? `${w.abstract.slice(0, ABSTRACT_CHARS - 1).trimEnd()}…` : w.abstract) : '' };
  if (!out.url && out.doi) out.url = `https://doi.org/${out.doi}`;
  out.kind = quality.kindOf(out);
  return out;
}

// ---------- the network: spacing, budget, retry, timeout ----------

function createLimiter({ sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const last = new Map();
  return {
    // Waits until `api` may be called again (its gap since the last call), then marks the call.
    async turn(api) {
      const gap = API_RULES[api]?.gap || 0;
      const prev = last.get(api);
      const wait = prev === undefined ? 0 : prev + gap - now(); // the first call to an API goes at once
      last.set(api, prev === undefined ? now() : Math.max(now(), prev + gap)); // reserve the slot so parallel callers queue behind each other
      if (wait > 0) await sleep(wait);
    },
  };
}
const defaultLimiter = createLimiter();

class ApiError extends Error {
  constructor(message, { status = 0, offline = false } = {}) { super(message); this.status = status; this.offline = offline; }
}

// -> parsed JSON (or text when `text`). Throws ApiError. `budget`: { [api]: callsLeft } shared by one find().
async function request(api, url, { fetchImpl = globalThis.fetch, signal, timeoutMs = TIMEOUT_MS, limiter = defaultLimiter, budget, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), text = false } = {}) {
  if (typeof fetchImpl !== 'function') throw new ApiError('no network access', { offline: true });
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (budget) {
      if ((budget[api] ?? 1) <= 0) throw lastError || new ApiError('request budget used up');
      budget[api] = (budget[api] ?? 1) - 1;
    }
    if (signal?.aborted) throw new ApiError('stopped');
    await limiter.turn(api);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: text ? 'application/atom+xml, text/xml' : 'application/json' }, credentials: 'omit', redirect: 'follow' });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const wait = Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600 * 2 ** (attempt - 1));
        lastError = new ApiError(res.status === 429 ? 'rate limited' : `server error ${res.status}`, { status: res.status });
        if (attempt < ATTEMPTS) { await sleep(wait); continue; }
        throw lastError;
      }
      if (res.status === 404) throw new ApiError('not found', { status: 404 });
      if (!res.ok) throw new ApiError(`HTTP ${res.status}`, { status: res.status });
      return text ? await res.text() : await res.json();
    } catch (err) {
      if (err instanceof ApiError) { if (err.status === 429 || err.status >= 500) lastError = err; if (err.status !== 429 && err.status < 500) throw err; if (attempt >= ATTEMPTS) throw err; continue; }
      if (signal?.aborted) throw new ApiError('stopped');
      if (ctrl.signal.aborted) { lastError = new ApiError('timed out'); if (attempt >= ATTEMPTS) throw lastError; continue; }
      throw new ApiError(/ENOTFOUND|ECONNREFUSED|ECONNRESET|ENETUNREACH|EAI_AGAIN|fetch failed|network|offline|ERR_INTERNET|ERR_NAME|ERR_CONNECTION/i.test(String(err?.message) + String(err?.cause?.code)) ? 'offline' : String(err?.message || err).split('\n')[0], { offline: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError || new ApiError('failed');
}

// ---------- URLs ----------

const enc = encodeURIComponent;
function cleanQuery(q) { return clean(q).slice(0, 300); }
function yearRange(from, to) { return { from: Number.isInteger(from) ? from : null, to: Number.isInteger(to) ? to : null }; }

const OA_SELECT = 'id,doi,title,publication_year,publication_date,authorships,primary_location,best_oa_location,open_access,cited_by_count,is_retracted,abstract_inverted_index,type,biblio';
function openalexUrl(q, { limit, from, to, oaOnly }) {
  const filters = [];
  if (from) filters.push(`from_publication_date:${from}-01-01`);
  if (to) filters.push(`to_publication_date:${to}-12-31`);
  if (oaOnly) filters.push('open_access.is_oa:true');
  return `https://api.openalex.org/works?search=${enc(q)}&per-page=${limit}&select=${OA_SELECT}${filters.length ? `&filter=${enc(filters.join(',')).replace(/%2C/g, ',').replace(/%3A/g, ':')}` : ''}`;
}
const CR_SELECT = 'DOI,title,author,issued,container-title,type,is-referenced-by-count,abstract,URL,volume,issue,page,publisher,updated-by,update-to,link,article-number';
function crossrefUrl(q, { limit, from, to }) {
  const filters = [];
  if (from) filters.push(`from-pub-date:${from}`);
  if (to) filters.push(`until-pub-date:${to}`);
  return `https://api.crossref.org/works?query=${enc(q)}&rows=${limit}&select=${CR_SELECT}${filters.length ? `&filter=${filters.join(',')}` : ''}`;
}
const S2_FIELDS = 'title,authors,year,venue,externalIds,abstract,citationCount,openAccessPdf,publicationTypes,journal,publicationDate,url';
function s2Url(q, { limit, from, to }) {
  const years = from || to ? `&year=${from || ''}-${to || ''}` : '';
  return `https://api.semanticscholar.org/graph/v1/paper/search?query=${enc(q)}&limit=${limit}&fields=${S2_FIELDS}${years}`;
}
// arXiv ORs bare words; AND them, keeping "quoted phrases".
function arxivQuery(q) {
  const terms = [...q.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ? `all:"${m[1]}"` : `all:${m[2].replace(/[^\p{L}\p{N}-]/gu, '')}`)).filter((t) => t !== 'all:').slice(0, 8);
  return terms.join(' AND ');
}
function arxivUrl(q, { limit }) {
  return `https://export.arxiv.org/api/query?search_query=${enc(arxivQuery(q)).replace(/%20/g, '+')}&max_results=${limit}&sortBy=relevance`;
}
function pubmedSearchUrl(q, { limit, from, to }) {
  const dates = from || to ? `&datetype=pdat&mindate=${from || 1800}&maxdate=${to || new Date().getFullYear() + 1}` : '';
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${enc(q)}&retmode=json&retmax=${limit}${dates}`;
}
const pubmedSummaryUrl = (ids) => `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`;

// ---------- one search ----------

const SEARCHERS = {
  async openalex(q, o, net) { return parseOpenAlex(await request('openalex', openalexUrl(q, o), net)); },
  async crossref(q, o, net) { return parseCrossref(await request('crossref', crossrefUrl(q, o), net)); },
  async semanticscholar(q, o, net) { return parseSemanticScholar(await request('semanticscholar', s2Url(q, o), net)); },
  async arxiv(q, o, net) { return parseArxiv(await request('arxiv', arxivUrl(q, o), { ...net, text: true })); },
  async pubmed(q, o, net) {
    const found = await request('pubmed', pubmedSearchUrl(q, o), net);
    const ids = (found?.esearchresult?.idlist || []).slice(0, o.limit);
    if (!ids.length) return [];
    return parsePubmed(found, await request('pubmed', pubmedSummaryUrl(ids), net));
  },
};

const cache = new Map();
const cacheGet = (key, now) => { const hit = cache.get(key); if (hit && now - hit.at < CACHE_MS) return hit.value; cache.delete(key); return null; };
const cachePut = (key, value, now) => { cache.set(key, { at: now, value }); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };

const postFilter = (works, { from, to, oaOnly }) => works.filter((w) => (!from || !w.year || w.year >= from) && (!to || !w.year || w.year <= to) && (!oaOnly || w.pdfUrl || w.oaUrl));

// find({ query, apis?, limit?, fromYear?, toYear?, oaOnly? }, { fetchImpl, signal, limiter, sleep, now }) ->
//   { results: [work], errors: { api: reason }, searched: [api], offline, total }   (never throws for a network problem)
async function find(input = {}, deps = {}) {
  const query = cleanQuery(input.query);
  if (!query) throw new Error('find_sources needs a query (or related: { doi, kind }).');
  const now = (deps.now || Date.now)();
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(input.limit)) || DEFAULT_LIMIT));
  const { from, to } = yearRange(Number.isInteger(input.from_year) ? input.from_year : null, Number.isInteger(input.to_year) ? input.to_year : null);
  const oaOnly = input.open_access === true;
  const apis = (Array.isArray(input.apis) && input.apis.length ? input.apis : ALL_APIS).filter((a) => SEARCHERS[a]);
  const key = JSON.stringify([query, apis, limit, from, to, oaOnly]);
  if (!deps.noCache) { const hit = cacheGet(key, now); if (hit) return { ...hit, cached: true }; }
  const budget = Object.fromEntries(apis.map((a) => [a, API_RULES[a].budget]));
  const net = { fetchImpl: deps.fetchImpl, signal: deps.signal, limiter: deps.limiter || defaultLimiter, budget, sleep: deps.sleep, timeoutMs: deps.timeoutMs };
  const opts = { limit: oaOnly ? limit * 2 : limit, from, to, oaOnly };
  const errors = {};
  const lists = await Promise.all(apis.map(async (api) => {
    try { return await SEARCHERS[api](query, opts, net); } catch (err) { errors[api] = err?.message || 'failed'; return []; }
  }));
  const failed = Object.keys(errors);
  const offline = failed.length === apis.length && apis.length > 0 && failed.every((a) => /offline|no network/.test(errors[a]));
  const merged = postFilter(mergeWorks(lists.map((l) => postFilter(l, { from, to, oaOnly: false }))), { from, to, oaOnly });
  const out = { results: merged.slice(0, limit), errors, searched: apis, offline, total: merged.length };
  if (!failed.length) cachePut(key, out, now); // a partial answer is not remembered: ask again soon, the API may be back
  return out;
}

// Snowballing from one key paper: who cites it, or what it cites. Semantic Scholar first (its citation graph is the richest
// and answers by DOI or arXiv id), OpenAlex when that is rate limited or does not know the paper.
async function related(input = {}, deps = {}) {
  const kind = input.kind === 'references' ? 'references' : 'cited_by';
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(input.limit)) || DEFAULT_LIMIT));
  const doi = normDoi(input.doi);
  const arxivId = /^(?:arxiv:)?(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/i.exec(clean(input.arxiv || input.id || ''))?.[1];
  const s2id = clean(input.s2 || '').replace(/[^\w]/g, '');
  const paper = doi ? `DOI:${doi}` : arxivId ? `ARXIV:${arxivId}` : s2id ? s2id : '';
  if (!paper) throw new Error('related needs a doi (or an arXiv id): find it with find_sources first.');
  const budget = { semanticscholar: 2, openalex: 3 };
  const net = { fetchImpl: deps.fetchImpl, signal: deps.signal, limiter: deps.limiter || defaultLimiter, budget, sleep: deps.sleep, timeoutMs: deps.timeoutMs };
  const errors = {};
  const searched = ['semanticscholar'];
  let results = [];
  try {
    const edge = kind === 'references' ? 'references' : 'citations';
    const json = await request('semanticscholar', `https://api.semanticscholar.org/graph/v1/paper/${encodeURI(paper)}/${edge}?fields=${S2_FIELDS}&limit=${Math.min(100, limit * 3)}`, net);
    results = parseSemanticScholar(json);
  } catch (err) { errors.semanticscholar = err?.message || 'failed'; }
  if (!results.length && (doi || arxivId)) {
    searched.push('openalex');
    try {
      const id = doi ? `https://doi.org/${doi}` : `https://arxiv.org/abs/${arxivId}`;
      const found = await request('openalex', `https://api.openalex.org/works?filter=${doi ? 'doi' : 'locations.landing_page_url'}:${enc(id)}&select=id`, net);
      const oaId = found?.results?.[0]?.id?.replace('https://openalex.org/', '');
      if (oaId) {
        const filter = kind === 'references' ? `cited_by:${oaId}` : `cites:${oaId}`;
        results = parseOpenAlex(await request('openalex', `https://api.openalex.org/works?filter=${filter}&per-page=${Math.min(50, limit * 2)}&sort=cited_by_count:desc&select=${OA_SELECT}`, net));
      } else errors.openalex = 'paper not found';
    } catch (err) { errors.openalex = err?.message || 'failed'; }
  }
  results = mergeWorks([results]).sort((a, b) => (b.citations || 0) - (a.citations || 0)).slice(0, limit);
  const offline = !results.length && Object.values(errors).length > 0 && Object.values(errors).every((m) => /offline|no network/.test(m));
  return { results, errors, searched, offline, total: results.length, related: { kind, paper } };
}

// ---------- the text the model reads ----------

const authorLine = (authors) => {
  const names = authors.map((a) => a.literal || [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean);
  return names.length > 4 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
};

// ids: ['S1', ...] parallel to results. The record's id is what research_board's add takes.
function describe(results, ids, { errors = {}, offline = false, related: rel, total = results.length, searched = [] } = {}) {
  const head = rel
    ? `${results.length} ${rel.kind === 'references' ? 'references of' : 'papers citing'} ${rel.paper.replace(/^DOI:/, 'doi:')}, most cited first:`
    : `${results.length} source${results.length === 1 ? '' : 's'}${total > results.length ? ` (of ${total})` : ''} from ${searched.map((a) => API_LABEL[a]).join(', ')}:`;
  const lines = results.map((w, i) => {
    const bits = [`${ids[i]}. ${w.title}`];
    const who = authorLine(w.authors);
    bits.push(`   ${[who, w.year, w.venue].filter(Boolean).join(' · ')} ${quality.shortLabel(w)}`.trimEnd());
    const links = [w.doi ? `doi:${w.doi}` : '', w.pdfUrl ? `OA PDF: ${w.pdfUrl}` : w.oaUrl ? `free full text: ${w.oaUrl}` : '', !w.doi && w.url ? w.url : ''].filter(Boolean);
    if (links.length) bits.push(`   ${links.join('  ')}`);
    if (w.abstract) bits.push(`   ${w.abstract.slice(0, 280)}${w.abstract.length > 280 ? '…' : ''}`);
    return bits.join('\n');
  });
  const problems = Object.entries(errors).map(([api, why]) => `${API_LABEL[api] || api}: ${why}`);
  const notes = [];
  if (results.some((w) => w.retracted)) notes.push('RETRACTED flags come from OpenAlex, Crossref or PubMed (the database named in the label of the paper in the board); confirm on the publisher\'s page before telling the user, and never rely on a retracted paper.');
  if (offline) notes.push('No scholarly database could be reached (offline?). Say so; do not make up papers.');
  else if (problems.length) notes.push(`Not available this time: ${problems.join('; ')}.`);
  if (!results.length && !offline) notes.push('No matches. Try fewer or different keywords, or drop the year filter.');
  return `<untrusted_page_content>\n${head}\n${lines.join('\n')}${notes.length ? `\n\n${notes.join('\n')}` : ''}\n(Metadata comes from public databases and can be wrong or incomplete. Read a source before quoting it.)\n</untrusted_page_content>`;
}

module.exports = {
  trimDoi, ALL_APIS, API_RULES, API_LABEL, MAX_LIMIT, DEFAULT_LIMIT, ABSTRACT_CHARS,
  normDoi, normTitle, parseName, parsePubmedName, invertedIndexText,
  parseOpenAlex, parseCrossref, parseSemanticScholar, parseArxiv, parsePubmed,
  mergeWorks, createLimiter, request, ApiError, find, related, describe, arxivQuery,
  openalexUrl, crossrefUrl, s2Url, arxivUrl, pubmedSearchUrl, pubmedSummaryUrl,
  clearCache: () => cache.clear(),
};
