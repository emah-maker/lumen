// Images the AI makes or returns, kept for the chat: where they come from, how they are checked, and where they
// live. Pure and fs-only (no Electron), so test/gen-images-units.js runs it all in plain Node.
//
//   sniff / parseDataUrl     only PNG, JPEG, GIF and WebP bytes pass (decided by the first bytes, never by a name or header)
//   extractImages(json)      every response shape that can carry a picture, as one list (see its comment)
//   imageRequest(text)       "draw a cat" / "/image a cat": is this message asking for a picture?
//   markdownImages(text)     ![alt](url) in a reply
//   createImageStore         the saved pictures: one file per image under <userData>/generated-images/<chat>/, encrypted
//                            with the OS keychain like the chat itself (no keychain: kept in memory only, as chats are)
//   findLocalImages          file paths a CLI engine printed, kept only when they lie in the engine's own folders
//   fetchRemoteImage         a picture from the web: https only, no cookies, no private addresses, size capped
//
// Privacy: a picture goes where the user's own model sent it and into the local, encrypted chat store; nothing here
// uploads or logs image data.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 12 * 1024 * 1024; // one picture, on disk and from the network
const MAX_PER_REPLY = 8;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

// The type of an image from its first bytes: { mime, ext } or null. (SVG is never accepted: it can carry script.)
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

// "data:image/png;base64,…" -> { buffer, mime }, or null for anything else (other types, bad base64, too big, not really an image).
function parseDataUrl(url, max = MAX_BYTES) {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,([\s\S]+)$/i.exec(String(url || '').slice(0, max * 2));
  if (!m || !B64.test(m[2].replace(/\s+/g, ''))) return null;
  return fromBase64(m[2], max);
}

function fromBase64(data, max = MAX_BYTES) {
  const clean = String(data || '').replace(/\s+/g, '');
  if (!clean || clean.length > Math.ceil(max * 4 / 3) + 4 || !B64.test(clean)) return null;
  const buffer = Buffer.from(clean, 'base64');
  const type = sniff(buffer);
  return type && buffer.length <= max ? { buffer, mime: type.mime } : null;
}

// ---------- every shape a picture comes back in ----------
// Returns [{ data (base64) | url, alt }]; the caller turns each into bytes (resolveImage).
//   OpenAI / xAI images API         { data: [{ b64_json | url, revised_prompt }] }
//   OpenAI Responses                { output: [{ type: 'image_generation_call', result: <base64>, revised_prompt }] }
//   Gemini generateContent          { candidates: [{ content: { parts: [{ inlineData: { mimeType, data } } | { inline_data: { mime_type, data } }] } }] }
//   OpenRouter / chat completions   { choices: [{ message | delta: { images: [{ type: 'image_url', image_url: { url } }] } }] }
//   Anthropic-style blocks          [{ type: 'image', source: { type: 'base64', data } }] (a tool result's content) or { content: [...] }
//   MCP tool result                 { content: [{ type: 'image', data, mimeType }] }
function extractImages(json) {
  const out = [];
  const add = (entry) => { if (entry && (entry.data || entry.url) && out.length < MAX_PER_REPLY) out.push(entry); };
  const fromUrl = (url, alt) => (typeof url === 'string' && url ? (url.startsWith('data:') ? { data: url, alt } : { url, alt }) : null);
  const block = (b) => {
    if (!b || typeof b !== 'object') return;
    if (b.type === 'image' && b.source?.type === 'base64') add({ data: b.source.data, alt: '' });
    else if (b.type === 'image' && b.source?.type === 'url') add(fromUrl(b.source.url, ''));
    else if (b.type === 'image' && typeof b.data === 'string') add({ data: b.data, alt: '' }); // an MCP image
    else if (b.type === 'image_generation_call' && typeof b.result === 'string') add({ data: b.result, alt: b.revised_prompt || '' });
    else if (b.type === 'image_url') add(fromUrl(typeof b.image_url === 'string' ? b.image_url : b.image_url?.url, ''));
  };
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(block); return; }
    if (!v || typeof v !== 'object') return;
    for (const d of Array.isArray(v.data) ? v.data : []) add(d?.b64_json ? { data: d.b64_json, alt: d.revised_prompt || '' } : fromUrl(d?.url, d?.revised_prompt || ''));
    for (const o of Array.isArray(v.output) ? v.output : []) block(o);
    for (const c of Array.isArray(v.candidates) ? v.candidates : []) {
      for (const p of Array.isArray(c?.content?.parts) ? c.content.parts : []) {
        const inline = p?.inlineData || p?.inline_data;
        if (inline?.data) add({ data: inline.data, alt: '' });
      }
    }
    for (const ch of Array.isArray(v.choices) ? v.choices : []) {
      for (const im of [...(Array.isArray(ch?.message?.images) ? ch.message.images : []), ...(Array.isArray(ch?.delta?.images) ? ch.delta.images : [])]) block(im);
    }
    if (Array.isArray(v.content)) v.content.forEach(block);
  };
  walk(json);
  return out;
}

// One extracted entry -> { buffer, mime } | null. A data URL or base64 string is decoded here; a web address is
// fetched (fetchRemoteImage), which is only done for addresses the provider itself returned.
async function resolveImage(entry, { fetchImpl } = {}) {
  if (!entry) return null;
  if (entry.url) return fetchRemoteImage(entry.url, { fetchImpl });
  return String(entry.data).startsWith('data:') ? parseDataUrl(entry.data) : fromBase64(entry.data);
}

// ---------- asking for a picture ----------
// "draw a cat", "generate an image of a sunset", "create a logo for my cafe", or "/image a cat". Words that only
// mention pictures ("an image upload form", "draw a conclusion") are left to the model.
const NOUN = '(?:image|picture|photo|photograph|illustration|drawing|painting|logo|icon|poster|wallpaper|artwork|portrait|cartoon|sketch|render(?:ing)?)';
const MAKE = /^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need|would\s+like|'d\s+like)\s+(?:you\s+to\s+|to\s+)?)?(?:generate|create|make|produce|render|design|draw|paint|sketch|illustrate)\s+(?:me\s+|us\s+)?(?:an?\s+|some\s+|another\s+)?(?:(?!(?:the|this|that|these|those|my|our|your|its|his|her|their)\b)[\w'-]+\s+){0,4}?(?:image|picture|photo|photograph|illustration|drawing|painting|logo|icon|poster|wallpaper|artwork|portrait|cartoon|sketch|rendering|render)s?\b(?!\s+(?:upload|gallery|carousel|component|tag|element|format|file|viewer|editor|library|processing|resize|compression|optimi[sz]ation|url|path|src|attribute|hosting|cdn|loading|loader)\b)/i;
const DRAW = /^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:draw|paint|sketch|illustrate)\s+(?:me\s+|us\s+)?(?:an?\s+|the\s+|some\s+)(?!(?:conclusion|comparison|parallel|line|distinction|connection|map\s+of\s+the\s+code|attention|breath|blank)\b)[^\n]{3,}/i;
const SLASH = /^\s*\/(?:image|imagine|draw)\s+([\s\S]{2,})$/i;
function imageRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 600) return null;
  const slash = SLASH.exec(t);
  if (slash) return { prompt: slash[1].trim(), explicit: true };
  if (/\?\s*$/.test(t) && /^\s*(?:how|what|why|which|where|when|is|are|do|does)\b/i.test(t)) return null; // a question about pictures
  if (MAKE.test(t) || DRAW.test(t)) return { prompt: t, explicit: false };
  return null;
}

// ![alt](url) in a reply: [{ alt, url }] (any url; the renderer and main decide what may load).
function markdownImages(text) {
  const out = [];
  const re = /!\[([^\]\n]{0,300})\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\s*\)/g;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < MAX_PER_REPLY) out.push({ alt: m[1], url: m[2].replace(/^<|>$/g, '') });
  return out;
}

// ---------- the pictures kept with a chat ----------
const CHAT_KEY = /^(?:[a-f0-9]{16}|0)$/;
const ID_RE = /^((?:[a-f0-9]{16}|0))~([a-f0-9]{16})$/;

function createImageStore({ dir, encrypt = (s) => s, decrypt = (s) => s, available = () => true, maxBytes = MAX_BYTES }) {
  const mem = new Map(); // id -> { buffer, mime }  (no keychain: nothing is written, as with chats)
  const parse = (id) => { const m = ID_RE.exec(String(id || '')); return m ? { chat: m[1], name: m[2] } : null; };
  const fileOf = (p) => path.join(dir, p.chat, `${p.name}.img`);

  // buffer or base64 data -> { id, mime, bytes } | null (not an image, or too big)
  function save(chatId, input, { alt = '' } = {}) {
    const buffer = Buffer.isBuffer(input) ? input : fromBase64(input)?.buffer;
    const type = buffer && buffer.length <= maxBytes ? sniff(buffer) : null;
    if (!type) return null;
    const chat = CHAT_KEY.test(String(chatId)) ? String(chatId) : '0';
    const name = crypto.randomBytes(8).toString('hex');
    const id = `${chat}~${name}`;
    if (available()) {
      const file = fileOf({ chat, name });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ enc: encrypt(buffer.toString('base64')), mime: type.mime }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } else mem.set(id, { buffer, mime: type.mime });
    return { id, mime: type.mime, bytes: buffer.length, alt: String(alt || '').slice(0, 300) };
  }

  function read(id) {
    const p = parse(id);
    if (!p) return null;
    if (mem.has(id)) return mem.get(id);
    try {
      const raw = JSON.parse(fs.readFileSync(fileOf(p), 'utf8'));
      const got = fromBase64(decrypt(raw.enc), maxBytes);
      return got ? { buffer: got.buffer, mime: got.mime } : null;
    } catch { return null; }
  }

  const dataUrl = (id) => { const r = read(id); return r ? `data:${r.mime};base64,${r.buffer.toString('base64')}` : null; };

  function removeChat(chatId) {
    const chat = String(chatId);
    if (!CHAT_KEY.test(chat)) return;
    for (const id of [...mem.keys()]) if (id.startsWith(`${chat}~`)) mem.delete(id);
    try { fs.rmSync(path.join(dir, chat), { recursive: true, force: true }); } catch {}
  }

  // Folders of chats that no longer exist (deleted while closed, or never saved) are removed.
  function prune(keepChatIds) {
    const keep = new Set([...keepChatIds].map(String));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      if (!CHAT_KEY.test(name) || keep.has(name)) continue;
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); n++; } catch {}
    }
    return n;
  }

  return { save, read, dataUrl, removeChat, prune, parse };
}

// ---------- pictures a CLI engine wrote to disk ----------
// Absolute paths in the engine's reply that end in an image extension.
const WIN_PATH = /(?:[A-Za-z]:[\\/][^\s"'<>|*?`]+?\.(?:png|jpe?g|gif|webp))\b/gi;
const POSIX_PATH = /(?:^|[\s("'`])(\/[^\s"'<>|*?`]+?\.(?:png|jpe?g|gif|webp))\b/gi;
const TILDE_PATH = /(?:^|[\s("'`])(~[\\/][^\s"'<>|*?`]+?\.(?:png|jpe?g|gif|webp))\b/gi;
// With `home`: "~/x.png" and (on Windows) a Git Bash path "/c/Users/me/x.png" are read as the native path they stand for.
function pathsIn(text, { home = null, platform = process.platform } = {}) {
  const found = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(WIN_PATH)) found.add(m[0]);
  for (const m of s.matchAll(POSIX_PATH)) found.add(platform === 'win32' && home ? m[1].replace(/^\/([A-Za-z])\//, (_a, d) => `${d.toUpperCase()}:/`) : m[1]);
  if (home) for (const m of s.matchAll(TILDE_PATH)) found.add(path.join(home, m[1].slice(2)));
  return [...found].slice(0, 20);
}

// The files among `text`'s paths that really are pictures lying inside one of `roots` (the engine's own working and temp
// folders): [{ file, buffer, mime }]. A path elsewhere, a link out of the roots, a big file or non-image bytes are skipped.
// fresh: { roots, since, until, home } (a CLI that runs as in a terminal, "full access"): a picture also counts when it lies
// in one of fresh.roots (the home folder and the folders the run was pointed at) AND was written during the run (its modified
// time is between `since` and `until`). A file that was already there is never shown, whatever names it.
function findLocalImages(text, roots, { fsImpl = fs, max = MAX_BYTES, fresh = null } = {}) {
  const real = (list) => { const out = []; for (const r of list || []) { try { out.push(normalise(fsImpl.realpathSync(r))); } catch { /* not there */ } } return out; };
  const realRoots = real(roots);
  const freshRoots = fresh ? real(fresh.roots) : [];
  const within = (key, list) => list.some((root) => key === root || key.startsWith(root + path.sep.toLowerCase()) || key.startsWith(`${root}/`) || key.startsWith(`${root}${path.sep}`));
  const out = [];
  for (const p of pathsIn(text, { home: fresh?.home || null })) {
    if (out.length >= MAX_PER_REPLY) break;
    try {
      const realPath = fsImpl.realpathSync(p);
      const key = normalise(realPath);
      const stat = fsImpl.statSync(realPath);
      const own = within(key, realRoots);
      const recent = !own && freshRoots.length > 0 && within(key, freshRoots) && stat.mtimeMs >= fresh.since && stat.mtimeMs <= (fresh.until ?? Date.now()) + 60000;
      if (!own && !recent) continue;
      if (!stat.isFile() || stat.size > max || stat.size < 12) continue;
      const buffer = fsImpl.readFileSync(realPath);
      const type = sniff(buffer);
      if (type && !out.some((o) => o.file === realPath)) out.push({ file: realPath, buffer, mime: type.mime });
    } catch { /* not there, or not readable: skipped */ }
  }
  return out;
}
const normalise = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? String(p).toLowerCase() : String(p)).replace(/[\\/]+$/, '');

// ---------- pictures from the web ----------
// Not a private or local address (best effort: a literal IP or a well-known local name).
function publicHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (h.includes(':')) return !(h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:'));
  return h.includes('.');
}

// https only, no cookies or credentials, redirects checked one by one, the body capped. { buffer, mime } | null.
async function fetchRemoteImage(url, { fetchImpl = globalThis.fetch, max = MAX_BYTES, timeoutMs = 20000 } = {}) {
  let current = String(url || '');
  for (let hops = 0; hops < 4; hops++) {
    let u;
    try { u = new URL(current); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || !publicHost(u.hostname)) return null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(u.href, { credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer', headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' }, ...(ctrl ? { signal: ctrl.signal } : {}) });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers?.get?.('location');
        if (!next) return null;
        current = new URL(next, u).href;
        continue;
      }
      if (!res.ok) return null;
      const length = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(length) && length > max) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      const type = buffer.length <= max ? sniff(buffer) : null;
      return type ? { buffer, mime: type.mime } : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  return null;
}

module.exports = {
  MAX_BYTES, MAX_PER_REPLY, sniff, parseDataUrl, fromBase64, extractImages, resolveImage, imageRequest, markdownImages,
  createImageStore, pathsIn, findLocalImages, publicHost, fetchRemoteImage,
};
