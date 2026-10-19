// Source metadata from a page: what "Add this page" to the Research board captures. Two halves:
//   PAGE_SCRIPT   a script the main process runs in the tab; it only READS (meta tags, JSON-LD, the first screenful of text)
//                 and returns a JSON string of raw facts. It never changes the page.
//   fromRaw(raw)  pure: raw facts -> a source record (title, authors, date, journal / site, volume, pages, DOI, PDF link, type).
// Sources of truth, best first: Google Scholar's citation_* meta tags, Dublin Core (DC.* / prism), JSON-LD (schema.org
// ScholarlyArticle / Article / NewsArticle / Book), Open Graph and article:* tags, plain <meta name=author>, then the visible
// title and a DOI found in the text. rawFromHtml() builds the same raw facts from an HTML string (tests, saved pages).
const { parseAuthor } = require('./citations');

const clean = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
const MAX_FIELD = 600;
// An address without tracking parameters (utm_*, fbclid, gclid, ...) or an empty fragment; '' for anything not http(s).
function cleanUrl(value) {
  try {
    const u = new URL(String(value ?? ''));
    if (!/^https?:$/.test(u.protocol)) return '';
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|mc_|fbclid$|gclid$|msclkid$|igshid$|ref$|ref_src$|_hsenc$|_hsmi$)/i.test(key)) u.searchParams.delete(key);
    return u.href.replace(/#$/, '');
  } catch { return ''; }
}
const cut = (v, n = MAX_FIELD) => clean(v).slice(0, n);

// Runs in the page. Returns a JSON string (the tab runner serialises results).
const PAGE_SCRIPT = `(() => {
  const metas = [];
  for (const m of document.querySelectorAll('meta[name], meta[property], meta[itemprop]')) {
    const key = (m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('itemprop') || '').toLowerCase();
    const content = m.getAttribute('content');
    if (key && content) metas.push([key, content.slice(0, 1500)]);
    if (metas.length >= 300) break;
  }
  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 8).map((s) => (s.textContent || '').slice(0, 60000));
  const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
  const doiLinks = [...document.querySelectorAll('a[href*="doi.org/10."]')].slice(0, 5).map((a) => a.href);
  const body = (document.body?.innerText || '').slice(0, 8000);
  return JSON.stringify({ url: location.href, title: document.title || '', canonical, lang: document.documentElement.lang || '', metas, jsonld, doiLinks, body });
})()`;

// ---------- raw facts from HTML (tests; also any saved page) ----------

const attrOf = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
};
const unescapeHtml = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

function rawFromHtml(html, url = '') {
  const src = String(html ?? '');
  const metas = [];
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attrOf(tag, 'name') || attrOf(tag, 'property') || attrOf(tag, 'itemprop')).toLowerCase();
    const content = attrOf(tag, 'content');
    if (key && content) metas.push([key, unescapeHtml(content)]);
  }
  const jsonld = [...src.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const title = unescapeHtml((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src) || [])[1] || '');
  const canonical = attrOf((/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i.exec(src) || [''])[0], 'href');
  const body = unescapeHtml(src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<head[\s\S]*?<\/head>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').slice(0, 8000);
  return { url, title, canonical, lang: attrOf((/<html\b[^>]*>/i.exec(src) || [''])[0], 'lang'), metas, jsonld, doiLinks: [], body };
}

// ---------- reading the raw facts ----------

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;
function findDoi(text) {
  const m = DOI_RE.exec(String(text ?? '').replace(/^doi:\s*/i, ''));
  return m ? require('./scholar').trimDoi(m[1].toLowerCase()) : '';
}

function parseDate(value) {
  const v = clean(value);
  let m = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/.exec(v);
  if (m) return { year: Number(m[1]), month: Number(m[2]) || null, day: m[3] ? Number(m[3]) : null };
  m = /^(\d{4})$/.exec(v);
  if (m) return { year: Number(m[1]), month: null, day: null };
  const t = Date.parse(v);
  if (Number.isFinite(t)) { const d = new Date(t); if (d.getFullYear() > 1000) return { year: d.getFullYear(), month: d.getMonth() + 1, day: /\d{1,2}/.test(v.replace(/\d{4}/, '')) ? d.getDate() : null }; }
  m = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(v);
  return m ? { year: Number(m[1]), month: null, day: null } : { year: null, month: null, day: null };
}

// "A. Smith; B. Jones" / "Smith, John and Jane Doe" / "John Smith, Jane Doe" / one name -> [{family, given}|{literal}]
function splitNames(text) {
  const t = clean(text).replace(/^by\s+/i, '');
  if (!t) return [];
  let parts;
  if (t.includes(';')) parts = t.split(';');
  else if (/\s(?:and|&)\s/.test(t)) parts = t.split(/\s+(?:and|&)\s+/).flatMap((p) => (/,/.test(p) && p.split(',').every((x) => x.trim().split(/\s+/).length >= 2) ? p.split(',') : [p]));
  else if (t.includes(',') && t.split(',').every((x) => x.trim().split(/\s+/).length >= 2)) parts = t.split(',');
  else parts = [t];
  return parts.map((p) => clean(p)).filter((p) => p && p.length < 120 && !/^https?:/i.test(p)).map(parseAuthor).filter(Boolean);
}

function asArray(v) { return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]; }
function walkLd(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) { for (const n of node.slice(0, 50)) walkLd(n, out, depth + 1); return; }
  if (node['@type']) out.push(node);
  if (node['@graph']) walkLd(node['@graph'], out, depth + 1);
}
const ldType = (n) => asArray(n['@type']).map((t) => String(t));
const ldName = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v.name || v['@id'] || '') : '');
function ldAuthors(node) {
  return asArray(node.author || node.creator).flatMap((a) => {
    if (typeof a === 'string') return splitNames(a);
    if (a && typeof a === 'object') {
      if (ldType(a).includes('Organization')) return a.name ? [{ literal: cut(a.name, 120) }] : [];
      if (a.givenName || a.familyName) return [{ family: cut(a.familyName, 80), given: cut(a.givenName, 80) }];
      return a.name ? splitNames(a.name).slice(0, 1) : [];
    }
    return [];
  });
}

function parseLd(raw) {
  const nodes = [];
  for (const text of asArray(raw.jsonld)) {
    try { walkLd(JSON.parse(text), nodes); } catch { /* a broken block is ignored */ }
  }
  const rank = (n) => (ldType(n).some((t) => /ScholarlyArticle/.test(t)) ? 0 : ldType(n).some((t) => /Article|Report|Book|Thesis|BlogPosting|Dataset/.test(t)) ? 1 : ldType(n).includes('WebPage') ? 2 : 3);
  return nodes.sort((a, b) => rank(a) - rank(b))[0] || null;
}

const SCHOLARLY_LD = /ScholarlyArticle|MedicalScholarlyArticle/;

function fromRaw(raw, { now = new Date() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const metas = asArray(r.metas).filter((m) => Array.isArray(m) && typeof m[0] === 'string');
  const all = (...keys) => metas.filter(([k]) => keys.includes(k)).map(([, v]) => clean(v)).filter(Boolean);
  const one = (...keys) => all(...keys)[0] || '';
  const ld = parseLd(r);
  const url = cleanUrl(/^https?:\/\//i.test(r.canonical || '') ? r.canonical : r.url);
  const pageUrl = cleanUrl(r.url) || url;

  const title = cut(one('citation_title', 'dc.title', 'dcterms.title', 'prism.title') || ldName(ld?.headline || ld?.name) || one('og:title', 'twitter:title') || r.title, 400);
  let authors = all('citation_author', 'dc.creator', 'dcterms.creator', 'prism.author').flatMap((a) => splitNames(a));
  if (!authors.length && ld) authors = ldAuthors(ld);
  if (!authors.length) authors = all('author', 'article:author', 'parsely-author', 'sailthru.author').filter((a) => !/^https?:/i.test(a)).flatMap((a) => splitNames(a));
  authors = authors.slice(0, 40);

  const dateText = one('citation_publication_date', 'citation_date', 'citation_online_date', 'dc.date', 'dc.date.issued', 'dcterms.issued', 'prism.publicationdate', 'article:published_time', 'og:article:published_time', 'datepublished', 'date') || cut(ld?.datePublished || ld?.dateCreated, 40);
  const date = parseDate(dateText);

  const journal = one('citation_journal_title', 'prism.publicationname', 'dc.source') || (SCHOLARLY_LD.test(ldType(ld || {}).join()) ? ldName(ld?.isPartOf) : '') || '';
  const conference = one('citation_conference_title', 'citation_conference');
  const siteName = cut(one('og:site_name', 'application-name', 'citation_publisher') || ldName(ld?.publisher) || ldName(ld?.isPartOf), 120);
  const publisher = cut(one('citation_publisher', 'dc.publisher', 'prism.publisher') || ldName(ld?.publisher), 120);
  const firstpage = one('citation_firstpage', 'prism.startingpage');
  const lastpage = one('citation_lastpage', 'prism.endingpage');
  const doiMeta = findDoi(one('citation_doi', 'prism.doi', 'dc.identifier.doi', 'bepress_citation_doi')) || findDoi(all('dc.identifier', 'dc.identifier.uri').find((v) => DOI_RE.test(v)) || '')
    || findDoi(asArray(ld?.identifier).map((i) => (typeof i === 'string' ? i : i?.value || '')).find((v) => DOI_RE.test(v)) || '') || findDoi(asArray(ld?.sameAs).find((v) => DOI_RE.test(String(v))) || '');
  const doiUrl = findDoi(/doi\.org\/(10\.[^?#]+)/i.exec(pageUrl || '')?.[1] || '');
  const doiLink = findDoi(asArray(r.doiLinks)[0] || '');
  const doiText = findDoi(/\b(?:doi|DOI)[:\s]+(10\.\d{4,9}\/\S+)/.exec(String(r.body || ''))?.[1] || '');
  const doi = doiMeta || doiUrl || doiLink || doiText;
  const arxivId = one('citation_arxiv_id') || (/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(pageUrl || '')?.[1] || '');

  let cslType = 'webpage';
  if (arxivId) cslType = 'article';
  else if (conference) cslType = 'paper-conference';
  else if (one('citation_dissertation_name')) cslType = 'thesis';
  else if (one('citation_technical_report_institution')) cslType = 'report';
  else if (one('citation_book_title') && !journal) cslType = 'chapter';
  else if (journal || SCHOLARLY_LD.test(ldType(ld || {}).join())) cslType = 'article-journal';
  else if (ldType(ld || {}).includes('Book') || one('og:type') === 'book') cslType = 'book';

  const source = {
    title,
    authors,
    year: date.year,
    month: date.month,
    day: date.day,
    venue: cut(journal || conference || one('citation_book_title') || '', 300),
    siteName: cslType === 'webpage' || cslType === 'book' ? siteName : '',
    volume: cut(one('citation_volume', 'prism.volume'), 30),
    issue: cut(one('citation_issue', 'prism.number'), 30),
    pages: firstpage ? cut(lastpage && lastpage !== firstpage ? `${firstpage}-${lastpage}` : firstpage, 40) : '',
    publisher,
    doi,
    url: url || pageUrl,
    pdfUrl: /^https?:\/\//i.test(one('citation_pdf_url')) ? one('citation_pdf_url') : '',
    abstract: cut(one('citation_abstract', 'dc.description', 'description', 'og:description', 'twitter:description') || ldName(ld?.description), 1200),
    cslType,
    arxivId,
    accessed: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
  };
  if (!source.title) source.title = cut(r.title, 400);
  source.metaFound = Boolean(one('citation_title') || ld || one('dc.title') || authors.length);
  source.doiFromText = !doiMeta && !doiUrl && !doiLink && Boolean(doiText);
  return source;
}

module.exports = { cleanUrl, PAGE_SCRIPT, rawFromHtml, fromRaw, findDoi, parseDate, splitNames };
