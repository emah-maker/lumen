// Images in the new-tab page's Ask AI box. Pure rules shared by the page (renderer/newtab-images.js), main (the newtab-ai:* calls)
// and the tests: which pictures are accepted, how many, how big. The limits are the chat composer's (renderer/chat-core.js
// MAX_ATTACH and MAX_FILE_BYTES): 10 attachments, each up to 25 MB; the chat itself decides how many go as pictures.
(function () {
'use strict';

const MAX_IMAGES = 10;
const MAX_BYTES = 25 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml'];
const BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' };
const EXTENSIONS = Object.keys(BY_EXT);

// The picture type of a file-like { type, name } ('' when it is not one this box takes). Some systems give a dropped photo no type.
function typeOf(file) {
  const type = String((file && file.type) || '').toLowerCase();
  if (TYPES.includes(type)) return type;
  if (type) return '';
  const ext = /\.([a-z0-9]+)$/i.exec(String((file && file.name) || ''));
  return (ext && BY_EXT[ext[1].toLowerCase()]) || '';
}

// What to do with `files` when `have` pictures are already in the box: { take: [{ file, type }], problems: [{ code, name }] }.
// Codes: 'notImage' (not a picture type the chat takes), 'empty', 'big', 'limit' (name is the count left out).
function plan(have, files) {
  const take = [];
  const problems = [];
  let over = 0;
  for (const file of files || []) {
    const type = typeOf(file);
    const name = String((file && file.name) || '');
    if (!type) { problems.push({ code: 'notImage', name }); continue; }
    if (!file.size) { problems.push({ code: 'empty', name }); continue; }
    if (file.size > MAX_BYTES) { problems.push({ code: 'big', name }); continue; }
    if (have + take.length >= MAX_IMAGES) { over++; continue; }
    take.push({ file, type });
  }
  if (over) problems.push({ code: 'limit', name: String(over) });
  return { take, problems };
}

// Main's check of what the page sent: [{ type, data (ArrayBuffer or a view), name? }] -> [{ type, data (Buffer), name }].
// Anything malformed, of another type, empty or over the cap is dropped; at most MAX_IMAGES are kept.
function clean(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (out.length >= MAX_IMAGES) break;
    const type = item && typeof item.type === 'string' ? item.type.toLowerCase() : '';
    const raw = item && item.data;
    const data = raw instanceof ArrayBuffer ? Buffer.from(raw) : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : null;
    if (!TYPES.includes(type) || !data || !data.length || data.length > MAX_BYTES) continue;
    out.push({ type, data, name: typeof item.name === 'string' ? item.name.slice(0, 200) : '' });
  }
  return out;
}

const api = { MAX_IMAGES, MAX_BYTES, TYPES, EXTENSIONS, typeOf, plan, clean };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NewtabImageRules = api;
})();
