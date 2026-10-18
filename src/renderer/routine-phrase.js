// A fast yes/no for "does this message start with a schedule phrase?" ("every weekday at 8am: check my email").
// It only gates the IPC that really parses it (features/routines.js parseScheduleText), so the composer asks main
// about likely matches and not about every keystroke. A plain script in the pages; test/routine-phrase-units.js loads it with require().
(function (root) {
  const DAY = '(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*';
  const UNIT = '(?:day|days|weekday|weekdays|work\\s*day|morning|mornings|afternoon|evening|evenings|night|week|hour|hours)';
  const GATE = [
    /^(?:daily|weekly|hourly|weekdays)\b/i, // "daily at 9: ...", "weekdays at 8am ..."
    /^on\s+weekdays\b/i,
    new RegExp(`^(?:every|each)\\s+${UNIT}\\b`, 'i'), // "every day", "each morning", "every weekday", "every hour"
    /^every\s+\d{1,2}\s+hours?\b/i, // "every 3 hours"
    new RegExp(`^(?:every|each)\\s+${DAY}\\b`, 'i'), // "every monday and friday"
  ];

  function looksScheduled(text) {
    const s = String(text || '').trimStart();
    if (s.length < 5 || s.length > 4000 || !/\s\S/.test(s)) return false; // (one bare word is not a request)
    const head = s.slice(0, 80);
    return GATE.some((re) => re.test(head));
  }

  const api = { looksScheduled };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.routinePhrase = api;
})(this);
