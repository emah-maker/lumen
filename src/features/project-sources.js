// A project's sources (lumen://chat > Projects): the files and the pages the AI can read in the project's chats. Files are in features/project-files.js and
// pages are the project's `links` (features/chat-store.js: [{ url, title, added, named? }]); this file is what the two share and what pages need that files don't:
// reading a page's title when the user asks (Add a link, Re-read), kept Electron-free so test/units/project-workspace-units.js runs it in plain Node.
//
//   parseTitle(html)                   the page's <title>, tidied; '' when it has none
//   readTitle(url, { fetch })          { ok: true, title } | { ok: false, reason }: one GET (8 s, the first 200 KB), only when the user adds or re-reads a page
//   sameUrl(a, b)                      the same page (the #fragment does not count)
//   sitePrefix(text)                   a website source's address: 'docs.python.org/3/' -> 'https://docs.python.org/3/' ('' for anything that is not a web address)
//   looksLikeSite(text)                a bare domain or an address that ends in '/': the page offers "Just this page / The whole site"
//   inSite(url, prefix)                the page is on the website: the same host (www or not) and a path under the prefix (never another host or a sibling path)
//   describe(link)                     { title, domain, path, bare }: what a row shows for a pinned page, also for one pinned before pages had titles
// Nothing here reads a page for the AI: the AI reads a pinned page itself, in a chat, with read_urls (and its usual approval).
const MAX_BYTES = 200000;
const TIMEOUT_MS = 8000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

function parseTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? '').slice(0, MAX_BYTES * 2));
  if (!m) return '';
  return decode(m[1].replace(/<[^>]*>/g, ' ')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// fetch: (url, init) -> a Response (main.js passes net.fetch; a test passes a fake).
async function readTitle(url, { fetch, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { return { ok: false, reason: 'address' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'address' };
  try {
    const res = await fetch(u.href, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } });
    if (!res.ok) return { ok: false, reason: 'status' };
    const type = String(res.headers?.get?.('content-type') || '');
    if (type && !/html|xml|text\/plain/i.test(type)) return { ok: false, reason: 'type' };
    let text = '';
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let seen = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += value.length;
        text += decoder.decode(value, { stream: true });
        if (/<\/title>/i.test(text) || seen >= maxBytes) { try { await reader.cancel(); } catch { /* done */ } break; }
      }
    } else text = String(await res.text()).slice(0, maxBytes);
    const title = parseTitle(text);
    return title ? { ok: true, title } : { ok: false, reason: 'notitle' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

const strip = (u) => { try { const x = new URL(String(u)); x.hash = ''; return x.href; } catch { return String(u ?? ''); } };
const sameUrl = (a, b) => strip(a) === strip(b);

// ---- websites: a source that is a domain or a path prefix (a link with site: true), searched and read page by page when a chat needs it
function sitePrefix(input) {
  let raw = String(input ?? '').trim().slice(0, 2000);
  if (!raw) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || u.username || u.password) return '';
    u.hash = '';
    u.search = '';
    return u.href;
  } catch { return ''; }
}
function looksLikeSite(input) {
  const p = sitePrefix(input);
  if (!p) return false;
  const path = new URL(p).pathname;
  return path === '/' || path.endsWith('/');
}
const bareHost = (h) => String(h).toLowerCase().replace(/^www./, '');
function inSite(url, prefix) {
  let u; let p;
  try { u = new URL(String(url)); p = new URL(String(prefix)); } catch { return false; }
  if (!/^https?:$/.test(u.protocol) || !/^https?:$/.test(p.protocol)) return false;
  if (bareHost(u.hostname) !== bareHost(p.hostname) || u.port !== p.port) return false;
  const base = p.pathname;
  if (base === '/') return true;
  if (base.endsWith('/')) return u.pathname.startsWith(base) || u.pathname === base.slice(0, -1);
  return u.pathname === base || u.pathname.startsWith(`${base}/`);
}

// A row for a pinned page. A page pinned before titles were kept (or from a typed address) has none: its row says the site and the path instead of a bare address.
function describe(link) {
  let domain;
  let path = '';
  try { const u = new URL(String(link?.url)); domain = u.host.replace(/^www\./, ''); path = u.pathname === '/' ? '' : `${u.pathname}${u.search}`; } catch { domain = String(link?.url ?? ''); }
  const title = String(link?.title ?? '').trim();
  return { title: title || domain, domain, path, bare: !title, site: link?.site === true };
}

module.exports = { parseTitle, readTitle, sameUrl, sitePrefix, looksLikeSite, inSite, describe, MAX_BYTES, TIMEOUT_MS };
