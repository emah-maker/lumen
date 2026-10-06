// Reading pages well: the in-page scripts that collect what page-health.js judges and compacts (a page's health
// signals, its JSON-LD / meta tags / embedded JSON data islands, Readability's article) and the glue that turns
// them into read_urls and read_page results. agent.js's readInBackground (read_urls), its read_page full read and
// snapshot.js's read_page outline call in here; everything that decides something is pure and lives in
// page-health.js, page-markdown.js and page-outline.js (test/page-reading-units.js).

/* global document */
const fs = require('fs');
const path = require('path');
const health = require('./page-health');
const { htmlToMarkdown } = require('./page-markdown');
const { outlineDom, formatOutline } = require('./page-outline');
const { PAGE_TEXT } = require('./page-scripts');

const READER_WORLD = 1002; // the isolated world Readability runs in (features/page-tools.js); 1001 is the AI's page scripts
const vendor = (name) => fs.readFileSync(path.join(__dirname, '..', 'vendor', 'readability', name), 'utf8');
let readabilitySrc = null;
let readerableSrc = null;

// Globals that hold a page's whole state as an object (assigned in an inline script, so an isolated world cannot see
// them: the script text is scanned for the assignment instead).
const ISLAND_GLOBALS = ['__NUXT__', 'ytInitialData', '__APOLLO_STATE__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__INITIAL_DATA__', '__REDUX_STATE__'];
const MAX_ISLAND_TEXT = 600000; // a bigger island is counted but not sent over (it could not be shown anyway)

// Runs in the page: health signals, and with withData the raw structured data. Self-contained (serialized with
// extractAssignedJson, which it receives as `extract`).
function pageProbe(opts, extract) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const scripts = [...document.scripts];
  const jsonTypes = /json/i;
  let scriptBytes = 0;
  for (const s of scripts) if (!jsonTypes.test(s.type || '')) scriptBytes += (s.textContent || '').length + (s.src ? 20000 / 5 : 0); // an external script is code we cannot see: count it as a fifth of a big one
  const rootEmpty = ['root', 'app', '__next', '__nuxt', '___gatsby', 'app-root', 'svelte'].some((id) => {
    const el = document.getElementById(id);
    return Boolean(el) && !clean(el.textContent) && el.children.length < 2;
  });
  const visible = (el) => Boolean(el) && (el.offsetParent !== null || el.getClientRects().length > 0);
  const out = {
    scriptCount: scripts.length,
    scriptBytes,
    rootEmpty,
    hasPassword: visible(document.querySelector('input[type=password]')),
    hasCaptcha: Boolean(document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha,.cf-turnstile,#challenge-form,#cf-challenge-running')),
  };
  // Candidate data islands, biggest first: JSON script tags over 2 KB, and inline scripts assigning a state global.
  const found = [];
  for (const s of scripts) {
    const text = s.textContent || '';
    if (text.length < 2048) continue;
    if (/^application\/(ld\+)?json$|^application\/.*\+json$/i.test(s.type || '')) {
      if (/ld\+json/i.test(s.type)) continue; // JSON-LD is collected below
      found.push({ name: s.id || s.getAttribute('data-name') || 'json', bytes: text.length, text: text.length <= opts.maxText ? text : '' });
    } else if (!s.src && !jsonTypes.test(s.type || '') && opts.globals.some((g) => text.includes(g))) {
      const hit = extract(text.length > 4000000 ? text.slice(0, 4000000) : text, opts.globals);
      if (hit) found.push({ name: hit.name, bytes: hit.text.length, text: hit.text.length <= opts.maxText ? hit.text : '' });
    }
  }
  found.sort((a, b) => b.bytes - a.bytes);
  out.islandBytes = found[0]?.bytes || 0;
  if (!opts.withData) return out;
  out.islands = found.slice(0, 3).filter((f) => f.text);
  out.jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => (s.textContent || '').slice(0, 100000)).filter(Boolean).slice(0, 8);
  const meta = {};
  const wanted = /^(description|keywords|author|og:[a-z_:]+|twitter:(title|description|card)|article:(published_time|modified_time|author))$/;
  for (const m of document.querySelectorAll('meta[name],meta[property]')) {
    const key = (m.getAttribute('property') || m.getAttribute('name') || '').toLowerCase();
    const value = clean(m.getAttribute('content'));
    if (value && wanted.test(key) && !(key in meta)) meta[key] = value.slice(0, 300);
  }
  const canonical = document.querySelector('link[rel=canonical]');
  if (canonical && canonical.href) meta.canonical = canonical.href;
  out.meta = meta;
  return out;
}

// -> JS source: the probe for this page. withData false: signals only (cheap).
function probeScript(withData) {
  return `(() => { ${health.extractAssignedJson.toString()}; return (${pageProbe.toString()})(${JSON.stringify({ withData: Boolean(withData), globals: ISLAND_GLOBALS, maxText: MAX_ISLAND_TEXT })}, extractAssignedJson); })()`;
}

// -> JS source for a background read: the whole visible text, the probe's raw data, and (when the page looks like an
// article) Readability's cleaned HTML. Readability and its readerable check are the vendored files Reader mode uses.
function backgroundReadScript() {
  readabilitySrc ??= vendor('Readability.js');
  readerableSrc ??= vendor('Readability-readerable.js');
  return `(() => {
    ${PAGE_TEXT}
    const text = pageText(document).replace(/\\n{3,}/g, '\\n\\n');
    let article = null;
    try {
      const run = () => {
        ${readabilitySrc}
        ${readerableSrc}
        if (!isProbablyReaderable(document)) return null;
        const doc = document.cloneNode(true);
        // A heading wrapped with small links of its own (Wikipedia's div.mw-heading + "[edit]", a "#" permalink) reads to
        // Readability as a short, link-heavy block and is dropped with its wrapper: the article lost every section title.
        // The heading is kept alone.
        for (const h of doc.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
          const w = h.parentElement;
          if (!w || w === doc.body || !/^(DIV|HEADER|SPAN|HGROUP)$/.test(w.tagName)) continue;
          const others = [...w.children].filter((c) => c !== h);
          const extra = (w.textContent || '').trim().length - (h.textContent || '').trim().length;
          if (others.length && extra <= 30 && others.every((c) => (c.textContent || '').trim().length <= 24)) w.replaceWith(h);
        }
        const a = new Readability(doc).parse();
        return a && a.content ? { title: a.title || '', byline: a.byline || '', content: a.content.slice(0, 600000) } : null;
      };
      article = run();
    } catch {}
    return { url: location.href, title: document.title, text: text.slice(0, 400000), textLen: text.length, article, probe: ${probeScript(true)} };
  })()`;
}

// Executes a script in the reader's isolated world, bounded in time (a torn-down document never settles).
function runIn(wc, code, timeoutMs) {
  let timer;
  return Promise.race([
    wc.executeJavaScriptInIsolatedWorld(READER_WORLD, [{ code }]),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The page did not respond. It may still be loading; try again.')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

// Everything a read needs from a loaded page (read_urls): { url, title, text, textLen, article, probe }.
const readBackground = (wc, timeoutMs = 12000) => runIn(wc, backgroundReadScript(), timeoutMs);

// A background read -> { title, text, health }: the result text is the health line (when the page is not fine), the
// chunk of the page asked for (Readability's article as markdown when the page is one and it did not lose most of the
// text, else the plain visible text), a note for the next chunk, and compact structured data.
// requested: the address asked for (a redirect from it to a sign-in page is a wall: page-health.js loginRedirect).
function finishRead(raw, { maxChars, offset, requested = '' } = {}) {
  const probe = raw.probe || {};
  const text = String(raw.text || '');
  let body = text;
  let article = false;
  if (raw.article?.content) {
    const md = htmlToMarkdown(raw.article.content, { baseUrl: raw.url });
    const by = raw.article.byline ? `By ${String(raw.article.byline).replace(/\s+/g, ' ').trim()}\n\n` : '';
    if (md.length >= 400 && md.length >= text.length * 0.25) { body = by + md; article = true; }
  }
  const verdict = health.classifyPage({ ...probe, title: raw.title, textHead: text.slice(0, 3000), textLen: raw.textLen ?? text.length, loginRedirect: Boolean(requested) && health.loginRedirect(requested, raw.url) });
  const first = !(Number(offset) > 0);
  const shell = verdict.kind === 'js_shell' || verdict.kind === 'data_shell';
  const slice = health.slicePage(body, { maxChars, offset });
  const parts = [];
  const line = first ? health.healthLine(verdict) : '';
  if (line) parts.push(line);
  if (slice.text) parts.push(slice.text);
  if (slice.note) parts.push(slice.note);
  if (first) {
    const structured = health.formatStructured(probe, shell ? { islands: 3, budget: 4500 } : { islands: 0, budget: 1200 });
    if (structured) parts.push(structured);
  }
  return { title: raw.title, text: parts.join('\n\n'), health: verdict.kind, article };
}

// read_page's full read of the active tab: the extra lines (health, and structured data for a shell page or when
// asked for) to put in front of the page text, '' for an ordinary page. Runs the probe through `runScript`.
async function fullReadExtras(page, runScript, { structured = false } = {}) {
  let probe = await runScript(probeScript(false)).catch(() => null);
  if (!probe) return '';
  const verdict = health.classifyPage({ ...probe, title: page.title, textHead: page.text.slice(0, 3000), textLen: page.totalTextChars });
  const shell = verdict.kind === 'js_shell' || verdict.kind === 'data_shell';
  const lines = [health.healthLine(verdict)];
  if (shell || structured) {
    probe = await runScript(probeScript(true)).catch(() => probe);
    lines.push(health.formatStructured(probe, { islands: 3, budget: 4500 }));
  }
  return lines.filter(Boolean).join('\n');
}

// The page-side call for the outline, and read_page mode "outline" as text.
function outlineScript() {
  return `(() => {
    const hooks = { hidden: (el) => typeof el.checkVisibility === 'function' && !el.checkVisibility() };
    const out = (${outlineDom.toString()})(document.body || document.documentElement, { href: location.href }, hooks);
    if (!out.next) {
      const l = document.querySelector('link[rel~=next][href]');
      if (l) out.next = { rank: 1, text: 'Next', href: l.href };
    }
    return { outline: out, title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 3000), textLen: document.body ? document.body.innerText.length : 0 };
  })()`;
}

async function readOutline(runScript) {
  const [page, probe] = await Promise.all([runScript(outlineScript(), 15000), runScript(probeScript(true), 15000).catch(() => ({}))]);
  const verdict = health.classifyPage({ ...probe, title: page.title, textHead: page.text, textLen: page.textLen });
  return formatOutline(page.outline, { title: page.title, url: page.url, healthLine: health.healthLine(verdict), structured: (() => { const s = health.summarizeStructured(probe); return s ? `Structured data: ${s}` : ''; })() });
}

module.exports = { readBackground, finishRead, fullReadExtras, readOutline, probeScript, outlineScript, backgroundReadScript, pageProbe, ISLAND_GLOBALS };
