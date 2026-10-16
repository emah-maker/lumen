// Fuzzy matching for the Files picker and the AI's find_file. Pure, and fast enough for a few thousand names a keystroke; the indexed
// folders (up to 20k names each) are ranked inside the indexer's worker thread (files-index-worker.js) with this same code, so the
// main thread only ever ranks the pinned and recent lists (at most 500).
//
//   matchText(query, text, opts)    -> { score, positions } | null: every word of the query must be found in `text`
//   rank(query, items, opts)        -> [{ item, score, positions }] best first. opts: { limit, name(item), where(item), bonus(item), loose }
//
// A word matches best as a piece of the name that starts a word ("slides" in "Chapter 4 slides.pptx"), then as a piece anywhere, then as
// letters in order ("c4s" in "Chapter 4 slides"). A word the name lacks may still be found in the folder (`where`), for a lower score.
// `positions` are indexes into the name, for highlighting. `loose`: a name is kept when at least half of the words match (the AI's
// lookups are descriptions, not exact names).

const SEP = /[\s_\-.()[\]]/;
const norm = (s) => String(s || '').toLowerCase();
const wordStart = (text, i) => i === 0 || SEP.test(text[i - 1]) || (text[i - 1] >= 'a' && text[i - 1] <= 'z' && text[i] >= 'A' && text[i] <= 'Z');

// One word against one text: { score, positions } or null.
function matchWord(word, raw) {
  const text = norm(raw);
  const at = text.indexOf(word);
  if (at >= 0) {
    // Prefer an occurrence that starts a word, if there is one.
    let best = at;
    for (let i = at; i >= 0; i = text.indexOf(word, i + 1)) { if (wordStart(raw, i)) { best = i; break; } }
    const positions = [];
    for (let i = 0; i < word.length; i++) positions.push(best + i);
    const starts = wordStart(raw, best);
    const end = best + word.length;
    const whole = starts && (end === text.length || SEP.test(text[end]));
    return { score: 100 + (best === 0 ? 30 : 0) + (starts ? 25 : 0) + (whole ? 15 : 0) + Math.round((word.length / text.length) * 20), positions };
  }
  if (word.length < 2) return null;
  // Letters in order: greedy, taking a word start when one is close ahead.
  const positions = [];
  let from = 0;
  let score = 0;
  let last = -2;
  for (const ch of word) {
    let i = text.indexOf(ch, from);
    if (i < 0) return null;
    for (let j = i; j >= 0 && j - i <= 6; j = text.indexOf(ch, j + 1)) { if (wordStart(raw, j)) { i = j; break; } }
    score += 8 + (i === last + 1 ? 10 : 0) + (wordStart(raw, i) ? 8 : 0) - Math.min(i - from, 10) * 0.3;
    positions.push(i); last = i; from = i + 1;
  }
  return { score: Math.max(score, 1), positions };
}

const words = (query) => norm(query).split(/[\s_\-.,]+/).filter(Boolean).slice(0, 8);

function matchText(query, text, { where = '', loose = false } = {}) {
  const ws = typeof query === 'string' ? words(query) : query;
  if (!ws.length) return { score: 0, positions: [] };
  let score = 0;
  let hit = 0;
  const positions = [];
  for (const w of ws) {
    const m = matchWord(w, text);
    if (m) { score += m.score; positions.push(...m.positions); hit++; continue; }
    if (where && norm(where).includes(w)) { score += 12; hit++; continue; }
    if (!loose) return null;
  }
  if (!hit || (loose && hit < Math.ceil(ws.length / 2))) return null;
  score += Math.round((hit / ws.length) * 20); // (loose: more words matched ranks higher)
  return { score, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

function rank(query, items, { limit = 30, name = (x) => x.name, where = (x) => x.path, bonus = () => 0, loose = false } = {}) {
  const ws = words(query);
  const out = [];
  for (const item of items) {
    const n = name(item);
    const m = matchText(ws, n, { where: where(item), loose });
    if (m) out.push({ item, score: m.score + bonus(item) - Math.min(String(n).length, 80) * 0.05, positions: m.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

module.exports = { matchText, rank, words };
