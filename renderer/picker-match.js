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
  // Does `word` start at a word start of `text` (reading on through punctuation)? A word that ends in a digit must
  // end where the text's number does: "2.5" finds "2.5 Flash", not "256K" or "2507".
  function startsAt(text, word) {
    const w = norm(word);
    if (!w) return false;
    const s = String(text || '').toLowerCase();
    return wordStarts(s).some((i) => {
      let k = 0, j = i;
      for (; j < s.length && k < w.length; j++) {
        if (!/[a-z0-9]/.test(s[j])) continue;
        if (s[j] !== w[k]) return false;
        k++;
      }
      if (k < w.length) return false;
      // Straight on into more digits is another number (2.5 vs 256, 2507; 4.1 vs 4.15); a dot then more ("5" in "5.6") is a sub-version.
      if (/\d/.test(w[w.length - 1]) && /\d/.test(s[j] || '')) return false;
      return true;
    });
  }
  // fields: { name, id, group, badges }. 0: no match; higher is better. 4: the words name the group ("claude" ->
  // the Claude group first); 3: the name starts with the whole query; 2: every word starts a word of the name;
  // 1: every word starts a word somewhere (the id, the group, a badge).
  function score(fields, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 1;
    const all = [fields.name, fields.id, fields.group, fields.badges, fields.detail];
    if (!words.every((w) => all.some((f) => startsAt(f, w)))) return 0;
    // The group ranks first only when the words name it outright ("claude"), not when one merely starts it ("mini" -> MiniMax).
    const groupWords = String(fields.group || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (groupWords.length && words.every((w) => groupWords.includes(norm(w)))) return 4;
    // Whole words of the name beat words it merely starts with ("mini" is a word of "GPT-4o mini", only the start of "MiniMax").
    const nameWords = String(fields.name || '').toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/).filter(Boolean);
    const whole = words.every((w) => nameWords.includes(norm(w)));
    const prefix = norm(fields.name).startsWith(norm(words.join('')));
    if (whole && prefix) return 3.5;
    if (whole) return 3;
    if (prefix) return 2.5;
    return words.every((w) => startsAt(fields.name, w)) ? 2 : 1;
  }
  const api = { score, startsAt, wordStarts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.pickerMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
