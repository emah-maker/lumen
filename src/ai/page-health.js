// Pure helpers for reading pages well (no Electron, no DOM; test/page-reading-units.js): what kind of page a
// read got (page health), the structured data a page carries (JSON-LD, meta tags, embedded JSON "data islands")
// squeezed into something a model can read cheaply, and slicing a long read into chunks (read_urls offset).
// The in-page scripts that collect the raw material live in page-reading.js; this file only judges and compacts it.
// Ideas adapted from the MIT-licensed websurf project; the code is our own.

// ---------------------------------------------------------------- page health

// What a read of a page actually got, from signals the page script measured:
//   title, textHead (the first ~3000 chars of visible text), textLen (all of it), scriptCount / scriptBytes (what
//   the page's scripts weigh), rootEmpty (an empty #root / #app / #__next / #__nuxt), islandBytes (the biggest
//   embedded JSON), hasPassword (a visible password field), hasCaptcha (a captcha or bot-check widget).
// -> { kind, reason }. kind: ok | js_shell (the text is empty because a script has not drawn the page) | wall (a
// login, paywall, bot check or consent wall stands in front of it) | soft_404 (a 200 that says it found nothing) |
// data_shell (little text, but the content sits in embedded JSON).
const BOT = /verify (that )?you are (a )?human|are you a (robot|human)|checking your browser|just a moment\.\.\.|attention required|access denied|unusual traffic|press (&|and) hold|complete the security check|enable javascript and cookies to continue|bot (detection|check)|cf-chl|ddos protection|request blocked/i;
const PAYWALL = /subscribe to (continue|read|unlock)|subscribers? only|(reached|used) (your|the) (free |monthly |article )?(limit|articles)|create a free account to (continue|read)|already a subscriber|unlock this (article|story)|become a member to (read|continue)|this (article|content) is (for|available to) (subscribers|members)/i;
const SIGN_IN = /(please )?(sign|log) ?in to (continue|view|see|access|read)|you (must|need to) be (logged|signed) in|(sign|log) ?in (is )?required|login required|authentication required/i;
const CONSENT = /(accept|agree to) (all )?(cookies|the use of cookies|our cookie)[^.]{0,40}to continue|before you continue to|we value your privacy.{0,80}(accept|agree)/i;
const NOT_FOUND = /\b404\b|page (can ?not|could not|can't|was not|wasn't|is not) (be )?found|not found|no longer (available|exists?)|(does not|doesn't) exist|nothing (here|found)|couldn't find (that|this|the) page|this page (is gone|has been removed)|no such page/i;
const NEEDS_JS = /enable javascript|requires javascript|javascript is (disabled|required)|turn on javascript|you need to enable javascript/i;

function classifyPage(sig = {}) {
  const textLen = Number(sig.textLen) || 0;
  const head = String(sig.textHead || '').slice(0, 3000);
  const title = String(sig.title || '');
  const both = `${title}\n${head}`;
  const scriptBytes = Number(sig.scriptBytes) || 0;
  const scriptCount = Number(sig.scriptCount) || 0;
  const islandBytes = Number(sig.islandBytes) || 0;
  // Walls are short: a long article that mentions "subscribe to continue" in a footer is still an article.
  if (textLen < 4000) {
    if ((sig.hasCaptcha && textLen < 1500) || BOT.test(both)) return { kind: 'wall', reason: 'bot check' };
    if (CONSENT.test(both) && textLen < 1500) return { kind: 'wall', reason: 'consent' };
    if (PAYWALL.test(both) && textLen < 2500) return { kind: 'wall', reason: 'paywall' };
    if (SIGN_IN.test(both) || (sig.hasPassword && textLen < 1200)) return { kind: 'wall', reason: 'sign-in' };
  }
  if (textLen < 1500 && (NOT_FOUND.test(title) || NOT_FOUND.test(head.slice(0, 400)))) return { kind: 'soft_404', reason: '' };
  if (textLen < 500 && islandBytes >= 2048) return { kind: 'data_shell', reason: '' };
  if (textLen < 400 && (scriptBytes > 20000 || scriptCount >= 5 || sig.rootEmpty || NEEDS_JS.test(head))) return { kind: 'js_shell', reason: '' };
  return { kind: 'ok', reason: '' };
}

// One short line for a result, '' when the page is fine.
function healthLine(health) {
  switch (health?.kind) {
    case 'js_shell': return 'Page: js_shell — little text; the page is drawn by script (any embedded data is below). Try navigate + read_page or wait_for.';
    case 'wall': return `Page: wall — ${{ 'bot check': 'bot check; use another source, never solve it', consent: 'cookie/consent wall', paywall: 'paywall; try another source', 'sign-in': 'sign-in required; try as_user' }[health.reason] || 'blocked'}`;
    case 'soft_404': return 'Page: soft_404 — looks like a not-found page; check the URL or search again.';
    case 'data_shell': return 'Page: data_shell — little text; the content is in embedded data below.';
    default: return '';
  }
}

// ---------------------------------------------------------------- structured data

const NOISE_KEY = /^(__typename|@context|tracking\w*|clickTracking\w*|csn|xsrf\w*|csrf\w*|nonce|beacon\w*|loggingDirectives|webCommandMetadata|commandMetadata|serializedContextData|trackingParams|ei|signature|cacheKey|impressionEndpoints|adPlacements|playerAds|responseContext|serviceTrackingParams|attestation|gcfConfig|experiment\w*|analytics\w*|sentry\w*|__N_SSP|__N_SSG|isFallback|buildId|assetPrefix|runtimeConfig|scriptLoader|nextExport|autoExport|gssp|gip)$/i;
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_[ce]id|_hsenc|_hsmi|igshid|yclid|ref|ref_src|ref_url|source|cmpid|sr_share|spm|trk|trkid|sid)$/i;
const BASE64ISH = /^(data:[^,]{0,80};base64,|[A-Za-z0-9+/_-]{80,}={0,2}$)/;

// A string for a model: tracking noise and base64 gone, URL query tracking removed, long text clipped.
function cleanString(s, max) {
  if (BASE64ISH.test(s)) return null;
  let t = s;
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
      t = u.href;
      if (t.length > 160) t = `${u.origin}${u.pathname}`.slice(0, 160);
    } catch {}
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Value -> a smaller value with the same useful fields. limits: depth, array (items kept), keys (per object), str.
function shrink(v, limits, depth = 0) {
  if (v === null || v === undefined || v === '' || typeof v === 'function') return undefined;
  if (typeof v === 'string') { const s = cleanString(v, limits.str); return s === null || s === '' ? undefined : s; }
  if (typeof v !== 'object') return v;
  if (depth >= limits.depth) return Array.isArray(v) ? `[${v.length} items]` : '{…}';
  if (Array.isArray(v)) {
    const out = v.slice(0, limits.array).map((x) => shrink(x, limits, depth + 1)).filter((x) => x !== undefined);
    if (v.length > limits.array) out.push(`(+${v.length - limits.array} more)`);
    return out.length ? out : undefined;
  }
  const out = {};
  let kept = 0;
  for (const [k, x] of Object.entries(v)) {
    if (NOISE_KEY.test(k)) continue;
    const s = shrink(x, limits, depth + 1);
    if (s === undefined || (typeof s === 'object' && !Object.keys(s).length)) continue;
    if (kept++ >= limits.keys) { out['…'] = `${Object.keys(v).length - limits.keys} more keys`; break; }
    out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

// JSON text for a value within `budget` chars: tries gentler limits first, tighter ones until it fits.
function compactJson(value, budget = 3000) {
  const steps = [
    { depth: 8, array: 8, keys: 40, str: 200 },
    { depth: 6, array: 5, keys: 30, str: 140 },
    { depth: 5, array: 3, keys: 20, str: 100 },
    { depth: 4, array: 2, keys: 14, str: 80 },
    { depth: 3, array: 2, keys: 10, str: 60 },
  ];
  let out = '';
  for (const limits of steps) {
    const s = shrink(value, limits);
    out = s === undefined ? '' : JSON.stringify(s);
    if (out.length <= budget) return out;
  }
  return `${out.slice(0, budget)}…`;
}

// The part of a framework's data island worth reading: Next.js keeps the page's data in props.pageProps, Nuxt
// in data/state, Apollo and Redux stores are flat already.
function unwrapIsland(name, v) {
  if (!v || typeof v !== 'object') return v;
  if (/NEXT_DATA/.test(name) && v.props?.pageProps) return { page: v.page, query: v.query, ...v.props.pageProps };
  if (/NUXT/.test(name)) return v.data || v.state || v;
  if (/UNIVERSAL_DATA/.test(name) && v.__DEFAULT_SCOPE__) return v.__DEFAULT_SCOPE__;
  return v;
}

// The JSON object a script assigns to one of `names` (window.__NUXT__ = {...}; var ytInitialData = {...};), found by
// scanning for the balanced braces (string-aware), or null. Self-contained: page-reading.js also runs it in the page.
function extractAssignedJson(script, names) {
  const src = String(script);
  const re = new RegExp(`(?:^|[^\\w$.])(?:window\\.|self\\.|globalThis\\.)?(${names.join('|')})["']?\\]?\\s*=\\s*(?=[{\\[])`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const start = re.lastIndex;
    const open = src[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = '';
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === inString) inString = '';
      } else if (ch === '"' || ch === "'") inString = ch;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) return { name: m[1], text: src.slice(start, i + 1) };
    }
  }
  return null;
}

const tryParse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

// JSON-LD blocks (raw strings) -> flat entities, @graph and arrays expanded.
function jsonLdEntities(blocks) {
  const out = [];
  const add = (v) => {
    if (Array.isArray(v)) return v.forEach(add);
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v['@graph'])) return v['@graph'].forEach(add);
    out.push(v);
  };
  for (const b of blocks || []) add(tryParse(String(b).trim()));
  return out;
}

const typeOf = (e) => [].concat(e['@type'] || 'Thing').join('/');

// The raw material the page script collected -> a compact "Structured data" section ('' when there is nothing).
//   raw: { meta: {name: content}, jsonld: [raw JSON strings], islands: [{ name, text, bytes }] }
//   opts: islands (how many data islands to include, 0 for an ordinary page), budget (chars for the whole section)
const META_ORDER = ['description', 'og:title', 'og:type', 'og:site_name', 'og:description', 'og:image', 'canonical', 'article:published_time', 'article:modified_time', 'author', 'article:author', 'twitter:title', 'twitter:description', 'keywords'];
function formatStructured(raw = {}, { islands = 0, budget = 3500 } = {}) {
  const lines = [];
  const meta = raw.meta || {};
  const metaKeys = META_ORDER.filter((k) => meta[k]);
  const seen = new Set();
  const metaLines = [];
  for (const k of metaKeys) {
    const v = cleanString(String(meta[k]), 220);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    metaLines.push(`${k}: ${v}`);
  }
  if (metaLines.length) lines.push(`meta: ${metaLines.join(' | ')}`);
  const entities = jsonLdEntities(raw.jsonld);
  for (const e of entities.slice(0, 6)) {
    const { '@type': _t, ...rest } = e;
    const body = compactJson(rest, 700);
    if (body) lines.push(`JSON-LD ${typeOf(e)}: ${body}`);
  }
  if (islands > 0) {
    const parsed = (raw.islands || []).map((i) => {
      const v = unwrapIsland(i.name, tryParse(i.text));
      return v === undefined ? null : { ...i, v };
    }).filter(Boolean).sort((a, b) => b.bytes - a.bytes).slice(0, islands);
    const each = Math.max(600, Math.floor((budget - lines.join('\n').length) / Math.max(1, parsed.length)));
    for (const i of parsed) {
      const body = compactJson(i.v, each);
      if (body) lines.push(`data ${i.name} (${i.bytes > 1024 ? `${Math.round(i.bytes / 1024)} KB` : `${i.bytes} B`}, compacted): ${body}`);
    }
  }
  if (!lines.length) return '';
  let out = `Structured data:\n${lines.join('\n')}`;
  if (out.length > budget) out = `${out.slice(0, budget)}…`;
  return out;
}

// A one-paragraph digest of the same material, for the outline: what is there, not the data itself.
function summarizeStructured(raw = {}) {
  const parts = [];
  const ents = jsonLdEntities(raw.jsonld);
  if (ents.length) {
    parts.push(`JSON-LD: ${ents.slice(0, 5).map((e) => {
      const name = e.headline || e.name || e.title;
      return `${typeOf(e)}${name ? ` "${cleanString(String(name), 70)}"` : ''}`;
    }).join(', ')}${ents.length > 5 ? `, +${ents.length - 5} more` : ''}`);
  }
  const meta = raw.meta || {};
  const bits = ['og:type', 'article:published_time', 'author'].filter((k) => meta[k]).map((k) => `${k.replace(/^article:/, '')} ${cleanString(String(meta[k]), 60)}`);
  if (bits.length) parts.push(`meta: ${bits.join(', ')}`);
  const islands = (raw.islands || []).map((i) => ({ ...i, v: tryParse(i.text) })).filter((i) => i.v && typeof i.v === 'object').sort((a, b) => b.bytes - a.bytes).slice(0, 3);
  if (islands.length) parts.push(`data: ${islands.map((i) => `${i.name} ${Math.max(1, Math.round(i.bytes / 1024))} KB (${Object.keys(unwrapIsland(i.name, i.v)).filter((k) => !NOISE_KEY.test(k)).slice(0, 6).join(', ')})`).join('; ')}`);
  return parts.join('. ');
}

// ---------------------------------------------------------------- paging

// A read's text, cut to the chunk asked for: `offset` chars in, at most `maxChars` (1000-30000, default 8000).
// Returns { text, from, to, total, more, note }; note says how to get the next chunk (read_urls offset: N).
const MAX_CHARS_DEFAULT = 8000;
function clampChars(n) { return Math.min(30000, Math.max(1000, Math.round(Number(n)) || MAX_CHARS_DEFAULT)); }
function slicePage(text, { maxChars, offset } = {}) {
  const max = clampChars(maxChars);
  const total = text.length;
  const from = Math.min(Math.max(0, Math.floor(Number(offset)) || 0), total);
  let to = Math.min(total, from + max);
  if (to < total) { // end on a line or word boundary when one is close
    const cut = text.lastIndexOf('\n', to);
    if (cut > from + max * 0.7) to = cut;
  }
  const more = to < total;
  const note = more ? `[chars ${from}-${to} of ${total}; for the next chunk call read_urls again with offset: ${to}]`
    : from > 0 ? `[chars ${from}-${total} of ${total}: the end]`
      : '';
  return { text: text.slice(from, to), from, to, total, more, note };
}

module.exports = { classifyPage, healthLine, compactJson, extractAssignedJson, jsonLdEntities, formatStructured, summarizeStructured, unwrapIsland, slicePage, clampChars, MAX_CHARS_DEFAULT };
