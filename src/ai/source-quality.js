// Source quality signals for the research framework (find_sources, the Research board, /research's Sources list).
// Pure and Electron-free: assess(source) -> { kind, kindLabel, domainTier, recency, chips[] }. Nothing here fetches; it only
// reads what the scholarly APIs or the page itself reported, and says so. The chips are hints for the reader, never a verdict:
// a government page can be wrong and a blog can be right, so the AI is told to weigh them, not obey them.
//
//   kind        what the source is: journal, conference, preprint, book, thesis, report, government, university, news,
//               blog, forum, wikipedia, organisation, web (anything else)
//   domainTier  high (peer-reviewed venue, .gov, .edu, a known publisher), medium (news, organisations, Wikipedia),
//               low (blogs, forums, anonymous web pages)
//   recency     { year, age, label }: label 'new' (this year or last), 'recent' (<= 5 years), 'dated' (> 10 years), else ''
//   chips       [{ kind, text, tone: 'good' | 'info' | 'warn' | 'bad' }] in display order: retraction first
//   verified    the quote check: true (found in the source text), false (read the source, did not find it), null (not checked)

const PUBLISHERS = [
  'nature.com', 'science.org', 'sciencemag.org', 'springer.com', 'springernature.com', 'link.springer.com', 'sciencedirect.com',
  'elsevier.com', 'cell.com', 'thelancet.com', 'wiley.com', 'onlinelibrary.wiley.com', 'tandfonline.com', 'sagepub.com',
  'journals.sagepub.com', 'jstor.org', 'ieee.org', 'ieeexplore.ieee.org', 'acm.org', 'dl.acm.org', 'pnas.org', 'nejm.org',
  'bmj.com', 'jamanetwork.com', 'plos.org', 'journals.plos.org', 'frontiersin.org', 'mdpi.com', 'oup.com', 'academic.oup.com',
  'cambridge.org', 'aps.org', 'iop.org', 'annualreviews.org', 'apa.org', 'psycnet.apa.org', 'biomedcentral.com', 'elifesciences.org',
  'royalsocietypublishing.org', 'aaai.org', 'neurips.cc', 'openreview.net', 'aclanthology.org', 'jmlr.org', 'degruyter.com',
];
const PREPRINTS = ['arxiv.org', 'biorxiv.org', 'medrxiv.org', 'ssrn.com', 'osf.io', 'preprints.org', 'researchsquare.com', 'chemrxiv.org', 'hal.science', 'eprint.iacr.org'];
const NEWS = [
  'nytimes.com', 'washingtonpost.com', 'wsj.com', 'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'theguardian.com', 'npr.org',
  'cnn.com', 'bloomberg.com', 'ft.com', 'economist.com', 'usatoday.com', 'latimes.com', 'politico.com', 'axios.com', 'theatlantic.com',
  'newyorker.com', 'time.com', 'forbes.com', 'cnbc.com', 'nbcnews.com', 'abcnews.go.com', 'cbsnews.com', 'pbs.org', 'aljazeera.com',
  'wired.com', 'arstechnica.com', 'theverge.com', 'techcrunch.com', 'statnews.com', 'scientificamerican.com', 'newscientist.com', 'bostonglobe.com',
];
const BLOGS = ['medium.com', 'substack.com', 'wordpress.com', 'blogspot.com', 'tumblr.com', 'dev.to', 'hashnode.dev', 'ghost.io', 'wixsite.com', 'quora.com'];
const FORUMS = ['reddit.com', 'news.ycombinator.com', 'stackexchange.com', 'stackoverflow.com', 'quora.com', 'discourse.org', '4chan.org', 'lemmy.world', 'x.com', 'twitter.com', 'facebook.com', 'tiktok.com'];
const ORG_TLDS = /\.(org|int)$/;

const hostOf = (url) => {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch { return ''; }
};
const inList = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

// What a bare URL says about its source. Used for web pages and as a fallback for scholarly records without a type.
function kindOfHost(host) {
  if (!host) return 'web';
  if (/(^|\.)wikipedia\.org$|(^|\.)wikimedia\.org$|(^|\.)wikibooks\.org$/.test(host)) return 'wikipedia';
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(host) || /(^|\.)(europa\.eu|who\.int|un\.org|nih\.gov|cdc\.gov)$/.test(host) || /\.gov\.[a-z]{2}$/.test(host)) return 'government';
  if (inList(host, PREPRINTS)) return 'preprint';
  if (inList(host, PUBLISHERS)) return 'journal';
  if (inList(host, NEWS)) return 'news';
  if (inList(host, FORUMS)) return 'forum';
  if (inList(host, BLOGS) || /^blog\./.test(host) || /\.blog$/.test(host)) return 'blog';
  if (/\.edu(\.[a-z]{2})?$/.test(host) || /\.ac\.[a-z]{2}$/.test(host)) return 'university';
  if (/^(forum|forums|community|discuss|answers)\./.test(host)) return 'forum';
  if (ORG_TLDS.test(host)) return 'organisation';
  return 'web';
}

const KIND_LABEL = {
  journal: 'Peer-reviewed journal', conference: 'Conference paper', preprint: 'Preprint', book: 'Book', thesis: 'Thesis', report: 'Report',
  government: 'Government', university: 'University site', news: 'News', blog: 'Blog', forum: 'Forum / social', wikipedia: 'Wikipedia',
  organisation: 'Organisation', web: 'Web page',
};
const TIER = { journal: 'high', conference: 'high', government: 'high', university: 'high', book: 'high', thesis: 'medium', report: 'medium', preprint: 'medium', news: 'medium', organisation: 'medium', wikipedia: 'medium', blog: 'low', forum: 'low', web: 'low' };

// A scholarly record's own type words (Crossref / OpenAlex / Semantic Scholar / PubMed) -> kind.
function kindOfRecord(src) {
  const t = String(src.type || src.workType || '').toLowerCase();
  const venueType = String(src.venueType || '').toLowerCase();
  if (/preprint|posted-content|repository/.test(t) || /repository|preprint/.test(venueType)) return 'preprint';
  if (/proceedings|conference/.test(t) || /conference/.test(venueType)) return 'conference';
  if (/dissertation|thesis/.test(t)) return 'thesis';
  if (/^book$|monograph|edited-book|reference-book/.test(t)) return 'book';
  if (/report|standard|grant|dataset/.test(t) && !/journal/.test(t)) return 'report';
  if (/journal-article|article-journal|journal|^article$|review/.test(t) || /journal/.test(venueType)) return 'journal';
  return '';
}

function kindOf(src) {
  const host = hostOf(src.url || src.pdfUrl || '');
  const fromHost = kindOfHost(host);
  const own = kindOfRecord(src);
  if (own) {
    // A DOI'd article on a preprint server is a preprint whatever the metadata says (OpenAlex files arXiv under "article").
    if (own === 'journal' && fromHost === 'preprint') return 'preprint';
    return own;
  }
  if (src.doi && (src.venue || src.volume) && !['news', 'blog', 'forum', 'wikipedia'].includes(fromHost)) return 'journal';
  if (src.arxivId) return 'preprint';
  return fromHost;
}

const monthName = (m) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] || '';
function recency(src, now = new Date()) {
  const year = Number(src.year) || (Number(String(src.date || '').slice(0, 4)) || null);
  if (!year || year < 1000 || year > now.getFullYear() + 2) return { year: null, age: null, label: '', text: '' };
  const age = now.getFullYear() - year;
  const label = age <= 1 ? 'new' : age <= 5 ? 'recent' : age > 10 ? 'dated' : '';
  const month = Number(src.month) || (/^\d{4}-(\d{2})/.test(String(src.date || '')) ? Number(RegExp.$1) : 0);
  return { year, age, label, text: month && age <= 1 ? `${monthName(month)} ${year}` : String(year) };
}

function assess(src, { now = new Date() } = {}) {
  const s = src || {};
  const kind = kindOf(s);
  const host = hostOf(s.url || s.pdfUrl || '');
  const rec = recency(s, now);
  const chips = [];
  // id: what the panel translates (renderer/research.js, research.chip.<id>); text: the English fallback; n: the number in it.
  const chip = (kind, id, text, tone, n) => chips.push({ kind, id, text, tone, ...(n !== undefined ? { n } : {}) });
  const by = Array.isArray(s.retractedBy) && s.retractedBy.length ? s.retractedBy.join(', ') : '';
  if (s.retracted === true) chip('retracted', by ? 'retracted.by' : 'retracted', by ? `Retracted (${by})` : 'Retracted', 'bad', by || undefined);
  else if (s.retractionNotice === true) chip('retracted', 'notice', 'Retraction notice', 'bad');
  chip('type', `type.${kind}`, KIND_LABEL[kind], TIER[kind] === 'high' ? 'good' : TIER[kind] === 'low' ? 'warn' : 'info');
  if (rec.year) chip('year', rec.label === 'dated' ? 'year.dated' : 'year', rec.label === 'dated' ? `${rec.text} (dated)` : rec.text, rec.label === 'dated' ? 'warn' : 'info', rec.text);
  if (Number.isFinite(s.citations) && s.citations >= 0) chip('cites', s.citations === 1 ? 'cites.one' : 'cites', `${s.citations.toLocaleString('en-US')} citation${s.citations === 1 ? '' : 's'}`, s.citations >= 100 ? 'good' : 'info', s.citations.toLocaleString('en-US'));
  if (host && /\.gov(\.[a-z]{2})?$|\.mil$/.test(host)) chip('domain', 'gov', '.gov', 'good');
  else if (host && /\.edu(\.[a-z]{2})?$|\.ac\.[a-z]{2}$/.test(host)) chip('domain', 'edu', '.edu', 'good');
  else if (host && inList(host, PUBLISHERS) && kind === 'journal') chip('domain', 'publisher', 'known publisher', 'good');
  if ((s.pdfUrl || s.oaUrl) && s.openAccess !== false) chip('oa', 'oa', 'Open access', 'good');
  if (s.verified === true) chip('verified', 'verified', 'Quote verified', 'good');
  else if (s.verified === false) chip('verified', 'notfound', 'Quote not found', 'bad');
  else if (Array.isArray(s.quotes) && s.quotes.length) chip('verified', 'unverified', 'Unverified', 'warn');
  return { kind, kindLabel: KIND_LABEL[kind], domainTier: s.retracted ? 'low' : TIER[kind], recency: rec, chips, host };
}

// One line for the model: "[peer-reviewed journal, 2023, 412 citations, RETRACTED]".
function shortLabel(src, opts) {
  const a = assess(src, opts);
  const parts = [];
  if (src.retracted) parts.push(Array.isArray(src.retractedBy) && src.retractedBy.length ? `RETRACTED per ${src.retractedBy.join(', ')}` : 'RETRACTED');
  else if (src.retractionNotice) parts.push('RETRACTION NOTICE');
  parts.push(a.kindLabel.toLowerCase());
  if (a.recency.year) parts.push(String(a.recency.year));
  if (Number.isFinite(src.citations)) parts.push(`${src.citations} cited`);
  if (src.pdfUrl || src.oaUrl) parts.push('open access');
  return `[${parts.join(', ')}]`;
}

module.exports = { assess, shortLabel, kindOf, kindOfHost, hostOf, recency, KIND_LABEL };
