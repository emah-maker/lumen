// "focus for 90 minutes": the chat message that starts focus mode instead of going to the AI (renderer/focus.js), and the length typed after /focus.
// Only a whole message that is exactly that request counts ("focus on my essay for two hours" is the AI's). A plain script in the pages;
// test/focus-units.js loads it with require().
(function (root) {
  const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, 'half an': 0.5, half: 0.5 };
  const AMOUNT = '(\\d+(?:[.,]\\d+)?|half an|half|an|a|one|two|three|four|five|six)';
  const UNIT = '(hours?|hrs?|h|minutes?|mins?|m)';
  const LENGTH = new RegExp(`^${AMOUNT}\\s*${UNIT}\\b\\.?$`, 'i');
  const START = new RegExp(`^(?:please\\s+)?(?:(?:start|begin|turn\\s+on|enable|enter|activate|set)\\s+)?(?:a\\s+|an\\s+|my\\s+)?focus(?:\\s+(?:mode|session|time))?(?:\\s+on)?(?:\\s+for)?\\s+(.+?)[.!]?(?:\\s+please)?$`, 'i');

  // "90 minutes", "2 hours", "1.5h", "an hour", "half an hour" -> whole minutes, or null
  function parseLength(text) {
    const m = LENGTH.exec(String(text || '').trim().replace(/\s+/g, ' '));
    if (!m) return null;
    const raw = m[1].toLowerCase();
    const n = raw in WORDS ? WORDS[raw] : Number(raw.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return null;
    const minutes = Math.round(/^h/i.test(m[2]) ? n * 60 : n);
    return minutes >= 1 && minutes <= 720 ? minutes : null;
  }
  // "focus for 90 minutes", "start focus mode for 2 hours", "focus 45 min" -> minutes, or null when the message is anything else
  function parseStart(text) {
    const s = String(text || '').trim();
    if (s.length < 7 || s.length > 80) return null;
    const m = START.exec(s);
    return m ? parseLength(m[1]) : null;
  }

  const api = { parseLength, parseStart };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.focusPhrase = api;
})(this);
