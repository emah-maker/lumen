// Images a user sends to the AI, in main: which ones a request may carry, and what to tell the user when
// some are left out or the model can't see them. Pure functions, so test/chat-images-units.js runs them in
// plain Node. The renderer (renderer/chat-core.js) downsizes and converts first; this is the check at the door.
//
// Privacy: images only ever travel in the request of the model the user picked (or its CLI engine) and,
// encrypted, in the saved chat. Nothing here logs or forwards them.

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']); // what every backend accepts
const MAX_IMAGES = 5; // per message
const MAX_DATA_CHARS = 7_000_000; // base64 characters of one image (~5 MB; Claude's limit per image)
const BASE64 = /^[A-Za-z0-9+/]+=*$/;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The images of an agent:ask that can go on: { valid, rejected: [{ index, reason }] }. reason: 'type' | 'data' | 'size' | 'count'.
function cleanImages(images) {
  const list = Array.isArray(images) ? images : [];
  const valid = [];
  const rejected = [];
  list.forEach((img, index) => {
    if (!IMAGE_TYPES.has(img?.media_type)) rejected.push({ index, reason: 'type' });
    else if (typeof img.data !== 'string' || !img.data || !BASE64.test(img.data)) rejected.push({ index, reason: 'data' });
    else if (img.data.length >= MAX_DATA_CHARS) rejected.push({ index, reason: 'size' });
    else if (valid.length >= MAX_IMAGES) rejected.push({ index, reason: 'count' });
    else valid.push({ media_type: img.media_type, data: img.data });
  });
  return { valid, rejected };
}

// "Left out 2 images: one is too large, one is not a PNG, JPEG, GIF or WebP." Null when nothing was left out.
function rejectionNotice(rejected) {
  if (!rejected?.length) return null;
  const by = (reason) => rejected.filter((r) => r.reason === reason).length;
  const why = [];
  if (by('type')) why.push(`${plural(by('type'), 'image')} not a PNG, JPEG, GIF or WebP`);
  if (by('data')) why.push(`${plural(by('data'), 'image')} damaged`);
  if (by('size')) why.push(`${plural(by('size'), 'image')} too large (over about 5 MB)`);
  if (by('count')) why.push(`${plural(by('count'), 'image')} over the limit of ${MAX_IMAGES} per message`);
  return `Left out ${plural(rejected.length, 'image')}: ${why.join('; ')}. The rest of your message was sent.`;
}

// Images the user attached themselves, in an Anthropic-format history (not screenshots a tool returned).
function userImageCount(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (m?.role === 'user' && Array.isArray(m.content)) n += m.content.filter((b) => b?.type === 'image').length;
  }
  return n;
}

// Said once when a model that can't see images gets a chat that holds some (the text still goes).
function textOnlyNotice(modelName, count) {
  return `${modelName} can't see images, so ${count === 1 ? 'the image' : `the ${count} images`} in this chat ${count === 1 ? 'was' : 'were'} left out of the request. Your text was sent. Pick a model that can see images (Claude, GPT-5, Gemini, Grok 4) to ask about ${count === 1 ? 'it' : 'them'}.`;
}

// Said when a CLI engine's model can't take images.
function engineNotice(engineName, modelName, count) {
  return `${engineName}${modelName && modelName !== 'default' ? ` (${modelName})` : ''} can't see images, so ${count === 1 ? 'the image was' : `the ${count} images were`} left out. Your text was sent.`;
}

module.exports = { IMAGE_TYPES, MAX_IMAGES, MAX_DATA_CHARS, cleanImages, rejectionNotice, userImageCount, textOnlyNotice, engineNotice };
