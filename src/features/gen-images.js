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
const MAX_LOCAL = 4; // pictures taken from file paths a reply names
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

// A request to make a picture ANYWHERE in a message ("look at the pdf and generate an image on how to do the problem"), for a
// message that is not a bare "draw a cat": it needs the model to read something first, so it is not sent straight to a provider
// (imageRequest) but the model is told to use generate_image (pictureIntent -> agent.js pictureNote). Only a hint, so it errs wide.
const MAKE_VERBS = '(?:generate|create|make|produce|render|design|draw|paint|sketch|illustrate)';
const LOOSE_NOUN = 'image|picture|photo|photograph|illustration|drawing|painting|logo|icon|poster|wallpaper|artwork|portrait|cartoon|sketch|rendering|render|infographic';
const LOOSE_NOT = '(?!\\s+(?:upload|gallery|carousel|component|tag|element|format|file|viewer|editor|library|processing|resize|compression|optimi[sz]ation|url|path|src|attribute|hosting|cdn|loading|loader)\\b)';
const LOOSE = new RegExp(`\\b${MAKE_VERBS}\\s+(?:me\\s+|us\\s+)?(?:(?:an?|some|another)\\s+(?:(?!(?:the|this|that|these|those|my|our|your|its|his|her|their)\\b)[\\w'-]+\\s+){0,4}?(?:${LOOSE_NOUN})s?\\b|(?:images|pictures|image|picture)\\b)${LOOSE_NOT}`, 'i');
const CODE_TALK = /\b(?:python|javascript|typescript|node(?:js)?|react|vue|css|html|canvas|pil|pillow|opencv|matplotlib|api|sdk|library|npm|pip|function|script|program|code|component)\b/i;
const NEGATED = /\b(?:don'?t|do not|never|no need to|without|instead of|stop)\s+(?:\w+\s+){0,3}$/i;
function pictureIntent(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 4000) return null;
  const direct = imageRequest(t);
  if (direct) return { ...direct, loose: false };
  if (/\?\s*$/.test(t) && /^\s*(?:how|what|why|which|where|when|is|are|do|does)\b/i.test(t)) return null; // a question about pictures
  if (CODE_TALK.test(t)) return null;
  const m = LOOSE.exec(t);
  if (!m || NEGATED.test(t.slice(Math.max(0, m.index - 30), m.index))) return null;
  return { prompt: t, explicit: false, loose: true };
}

// ---------- "this", "that", "it": the reply just above ----------
// "generate an image to show this" means the assistant's latest reply (then the user's own latest message), never something
// earlier in the chat. A request that points at something ("this", "above", "what you just said", "the last one", "show it") or
// names no subject at all ("generate an image please") gets that reply as the subject of the picture; older turns are background only.
const POINTS = /\b(?:this|these|those|above|(?:what|everything|all)\s+(?:you|we)\s+(?:just\s+)?(?:said|wrote|explained|showed|did|covered)|the\s+(?:last|previous|latest|above)\s+(?:one|answer|reply|response|part|step)|the\s+(?:answer|solution|reply|response|explanation|result)|(?:show|illustrate|visuali[sz]e|depict|of|for)\s+(?:that|it|them))\b/i;
const FILLER = new Set(['to', 'show', 'illustrate', 'visualize', 'visualise', 'explain', 'depict', 'of', 'for', 'me', 'us', 'please', 'a', 'an', 'the', 'some', 'another', 'new', 'quick', 'simple', 'nice', 'and', 'pls', 'plz', 'can', 'you', 'could', 'would', 'also', 'now', 'then', 'with', 'about', 'on', 'in', 'as', 'so', 'i', 'see', 'understand', 'help', 'make', 'generate', 'create', 'draw', 'produce', 'render', 'design', 'paint', 'sketch', 'this', 'that', 'it', 'these', 'those', 'them', 'above', ...LOOSE_NOUN.split('|')]);
const SLASH_HEAD = /^\s*\/(?:image|imagine|draw)\s+/i;
function pointsAtChat(text) {
  const t = String(text || '').replace(SLASH_HEAD, '').trim();
  if (!t) return true;
  if (POINTS.test(t)) return true;
  const words = t.toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ').split(/\s+/).filter(Boolean);
  return !words.some((w) => !FILLER.has(w) && !FILLER.has(w.replace(/s$/, '')));
}

const SUBJECT_CHARS = 3200;
const QUESTION_CHARS = 400;
const clip = (text, n) => {
  const t = String(text || '').trim();
  if (t.length <= n) return t;
  const head = Math.min(500, Math.floor(n / 5)); // the opening names what the reply is about, the tail is where it got to
  return `${t.slice(0, head).trimEnd()} […] ${t.slice(-(n - head)).trimStart()}`;
};

// items: the chat as transcriptFor makes it ({ role, text }); the message that asks for the picture may be last (it is left off).
// -> { text, question } for the latest assistant reply that has words, or null when there is none. (No reply yet: the user's own
// latest earlier message, the question or the attachment's note, is the subject.)
function chatSubject(items) {
  const list = (items || []).filter((m) => m && String(m.text || '').trim());
  while (list.length && list[list.length - 1].role === 'user') list.pop(); // the request itself is not its own subject
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user') continue;
    const q = list.slice(0, i).reverse().find((m) => m.role === 'user');
    return { text: clip(list[i].text, SUBJECT_CHARS), question: q ? clip(q.text, QUESTION_CHARS) : '' };
  }
  return null;
}

// What goes to the picture provider (it has no chat of its own): the user's words, then the latest reply as the subject. "draw a cat"
// is left alone. -> { prompt, shown } (shown: the words the picture is captioned with).
function imagePromptFrom(askPrompt, items) {
  const own = String(askPrompt || '').trim();
  if (!pointsAtChat(own)) return { prompt: own, shown: own };
  const asked = own.replace(SLASH_HEAD, '');
  let subject = chatSubject(items);
  if (!subject) { // nothing was answered yet: the user's own latest earlier message
    const before = (items || []).filter((m) => m?.role === 'user' && String(m.text || '').trim());
    before.pop(); // the request
    const last = before[before.length - 1];
    if (!last) return { prompt: own, shown: own };
    subject = { text: clip(last.text, SUBJECT_CHARS), question: '', user: true };
  }
  const prompt = [
    asked || 'Make a picture',
    '',
    subject.user
      ? 'Subject (the user\'s latest earlier message, which "this", "that" and "it" in the request mean):'
      : 'Subject (the assistant\'s latest reply, which "this", "that" and "it" in the request mean; draw this, nothing from earlier in the conversation):',
    '"""',
    subject.text,
    '"""',
    ...(subject.question ? ['', `Background only (the question that reply answered): ${subject.question}`] : []),
  ].join('\n');
  return { prompt, shown: asked || subject.text.slice(0, 200) };
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
const WIN_PATH = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/][^\s"'<>|*?`]+?\.(?:png|jpe?g|gif|webp))\b/gi;
const POSIX_PATH = /(?:^|[\s("'`])(\/[^\s"'<>|*?`]+?\.(?:png|jpe?g|gif|webp))\b/gi;
const TILDE_PATH = /(?:^|[\s("'`])(~[\\/][^\s"'<>|*?`]+?\.(?:png|jpe?g|gif|webp))\b/gi;
const EXT = '(?:png|jpe?g|gif|webp)';
const ROOT = '(?:[A-Za-z]:[\\\\/]|/|~[\\\\/])';
// A path with spaces, as a model writes it: in backticks or quotes, in <angle brackets>, or as a markdown link/image target.
const QUOTED_PATH = new RegExp(`([\`"'])(${ROOT}[^\`"'\\n<>|*?]*?\\.${EXT})\\1`, 'gi');
const ANGLE_PATH = new RegExp(`<(${ROOT}[^<>\\n|*?]*?\\.${EXT})>`, 'gi');
const LINK_PATH = new RegExp(`\\]\\(\\s*(${ROOT}[^\\n()<>|*?]*?\\.${EXT})(?:\\s+"[^"\\n]*")?\\s*\\)`, 'gi');
const FILE_URL = new RegExp(`file://[^\\s"'<>|*?\`()\\]]+?\\.${EXT}(?![\\w%])`, 'gi');
// A file: address -> the path it names ("file:///C:/a%20b/x.png" -> "C:/a b/x.png"); null when it is not a local one.
function fromFileUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:' || (u.hostname && u.hostname !== 'localhost')) return null;
    const p = decodeURIComponent(u.pathname);
    return /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p;
  } catch { return null; }
}
// With `home`: "~/x.png" and (on Windows) a Git Bash path "/c/Users/me/x.png" are read as the native path they stand for.
// Also read: file:// addresses, and a path with spaces inside backticks, quotes, <...> or a markdown link/image target.
function pathsIn(text, { home = null, platform = process.platform } = {}) {
  const found = new Set();
  const s = String(text || '');
  const native = (p) => {
    if (home && /^~[\\/]/.test(p)) return path.join(home, p.slice(2));
    if (platform === 'win32' && home) return p.replace(/^\/([A-Za-z])\//, (_a, d) => `${d.toUpperCase()}:/`);
    return p;
  };
  for (const m of s.matchAll(FILE_URL)) { const p = fromFileUrl(m[0]); if (p) found.add(native(p)); }
  const plain = s.replace(FILE_URL, ' ');
  for (const m of plain.matchAll(QUOTED_PATH)) found.add(native(m[2]));
  for (const m of plain.matchAll(ANGLE_PATH)) found.add(native(m[1]));
  for (const m of plain.matchAll(LINK_PATH)) found.add(native(m[1]));
  for (const m of plain.matchAll(WIN_PATH)) found.add(m[0]);
  for (const m of plain.matchAll(POSIX_PATH)) found.add(native(m[1]));
  if (home) for (const m of plain.matchAll(TILDE_PATH)) found.add(path.join(home, m[1].slice(2)));
  return [...found].slice(0, 20);
}

// Image paths a tool reported in its result (any shape: text, JSON text, or an object such as { path: "C:\\...\\1.jpg" }).
function toolImagePaths(value, { home = null } = {}, out = [], depth = 0) {
  if (out.length >= 20 || depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t[0] === '{' || t[0] === '[') { try { return toolImagePaths(JSON.parse(t), { home }, out, depth + 1); } catch { /* plain text */ } }
    for (const p of pathsIn(value.slice(0, 20000), { home })) if (out.length < 20 && !out.includes(p)) out.push(p);
  } else if (Array.isArray(value)) value.slice(0, 50).forEach((v) => toolImagePaths(v, { home }, out, depth + 1));
  else if (typeof value === 'object') Object.values(value).slice(0, 50).forEach((v) => toolImagePaths(v, { home }, out, depth + 1));
  return out;
}

// The files among `text`'s paths that really are pictures lying inside one of `roots` (the engine's own working and temp
// folders): [{ file, buffer, mime }]. A path elsewhere, a link out of the roots, a big file or non-image bytes are skipped.
// fresh: { roots, since, until, home } (a CLI that runs as in a terminal, "full access"): a picture also counts when it lies
// in one of fresh.roots (the home folder and the folders the run was pointed at) AND was written during the run (its modified
// time is between `since` and `until`). A file that was already there is never shown, whatever names it.
function findLocalImages(text, roots, { fsImpl = fs, max = MAX_BYTES, fresh = null, paths = [] } = {}) {
  const real = (list) => { const out = []; for (const r of list || []) { try { out.push(normalise(fsImpl.realpathSync(r))); } catch { /* not there */ } } return out; };
  const realRoots = real(roots);
  const freshRoots = fresh ? real(fresh.roots) : [];
  const within = (key, list) => list.some((root) => key === root || key.startsWith(root + path.sep.toLowerCase()) || key.startsWith(`${root}/`) || key.startsWith(`${root}${path.sep}`));
  const out = [];
  for (const p of [...new Set([...pathsIn(text, { home: fresh?.home || null }), ...(Array.isArray(paths) ? paths.map(String).slice(0, 20) : [])])]) {
    if (out.length >= MAX_LOCAL) break;
    try {
      if (!path.isAbsolute(p)) continue;
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
  MAX_BYTES, MAX_PER_REPLY, sniff, parseDataUrl, fromBase64, extractImages, resolveImage, imageRequest, pictureIntent, pointsAtChat, chatSubject, imagePromptFrom, markdownImages,
  createImageStore, pathsIn, toolImagePaths, fromFileUrl, findLocalImages, publicHost, fetchRemoteImage,
};
