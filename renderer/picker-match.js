// Matching for the model picker's search (renderer/picker.js). A plain script in the UI; test/units.js loads it
// with require().
//
// A query word matches a field when it starts at the start of a word there, punctuation ignored on both sides:
// "2.5" and "gemini 2.5" find "Gemini 2.5 Flash", "4o" finds "GPT-4o mini", "gpt5" finds "GPT-5.6", "70b" finds
// "Llama 3.3 70B"; "mini" does not find "Gemini", nor "5" something that merely contains a 5 mid-word.
(function (root) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Where words start in `text`: its start, after anything that isn't a letter or digit, and where letters turn
  // into digits or back ("gpt4o" -> gpt, 4, o).
  function wordStarts(text) {
    const s = String(text || '').toLowerCase();
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (!/[a-z0-9]/.test(c)) continue;
      const p = s[i - 1];
      if (i === 0 || !/[a-z0-9]/.test(p) || (/\d/.test(c) && /[a-z]/.test(p)) || (/[a-z]/.test(c) && /\d/.test(p))) out.push(i);
    }
    return out;
  }
  // Does `word` start at a word start of `text` (reading on through punctuation)?
  function startsAt(text, word) {
    const w = norm(word);
    if (!w) return false;
    const s = String(text || '').toLowerCase();
    return wordStarts(s).some((i) => norm(s.slice(i)).startsWith(w));
  }
  // fields: { name, id, group, badges }. 0: no match; higher is better. 4: the words name the group ("claude" ->
  // the Claude group first); 3: the name starts with the whole query; 2: every word starts a word of the name;
  // 1: every word starts a word somewhere (the id, the group, a badge).
  function score(fields, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 1;
    const all = [fields.name, fields.id, fields.group, fields.badges];
    if (!words.every((w) => all.some((f) => startsAt(f, w)))) return 0;
    if (fields.group && words.every((w) => startsAt(fields.group, w))) return 4;
    if (norm(fields.name).startsWith(norm(words.join('')))) return 3;
    return words.every((w) => startsAt(fields.name, w)) ? 2 : 1;
  }
  const api = { score, startsAt, wordStarts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.pickerMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
