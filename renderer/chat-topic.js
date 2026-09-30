// Whether a message typed into the sidebar starts a new topic (renderer/chat-core.js then sends it in a
// new chat, with a way back). Local and cautious: anything that reads like a follow-up ("why?", "make it
// shorter", "what about Rust") stays, and so does any message sharing a word with the chat so far. Only a
// message of its own, with nothing in common with the chat, counts as new. Plain script in the UI;
// test/units.js loads it with require().
(function (root) {
  const STOPWORDS = new Set(`a about above after again all also am an and any anything are as ask at be because been before being
best better between both but by can cannot could did do does doing done down each even ever every few for from get gets getting give
go going good got had has have having he help her here hers him his how i if in into is it its itself just know let like look looking
make many me might mine more most much must my need no nor not now of off on once one only or other our out over own please put
quick quickly really right same say see she should show so some something sure take tell than thank thanks that the their them
then there these they thing things think this those through to too try under up us use using very want was way we well were what
when where which while who whom why will with without would write yes yet you your yours
explain describe list find give compare difference summarize summary write rewrite example examples mean means idea ideas`.split(/\s+/));

  // Opening words of a reply to what was just said.
  const FOLLOW_UP_START = /^(and|but|also|so|then|ok|okay|k|thanks|thank|thx|yes|yeah|yep|yup|no|nope|nah|sure|great|cool|nice|perfect|awesome|what about|how about|why|continue|go on|keep going|more|another|again|instead|now|next|wait|hmm|actually|same|shorter|longer|simpler|redo|retry|fix|translate|elaborate|expand)\b/i;
  // Words that point back at the chat so far.
  const REFERS_BACK = /\b(it|its|it's|that|that's|this|these|those|they|them|their|theirs|he|she|him|her|his|above|previous|previously|earlier|before|again|also|too|same|instead|else|former|latter|mentioned|said|you said|your answer|your reply|the answer|the code|the list|the page)\b/i;

  function stem(w) {
    if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('es') && /(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }

  // The words that carry a message's subject: no function words, no bare numbers.
  function contentWords(text) {
    const out = new Set();
    for (const raw of String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}+#]+/u)) {
      if (raw.length < 3 || /^\d+$/.test(raw) || STOPWORDS.has(raw)) continue;
      const w = stem(raw);
      if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
    }
    return out;
  }

  // Two words for the same thing: equal, or one the start of the other ("react" / "reactjs").
  const related = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a)));

  // `text`: the new message. `previous`: the chat's messages so far (the user's and the replies), as text.
  function isNewTopic(text, previous) {
    const msg = String(text || '').trim();
    const before = (previous || []).filter((s) => typeof s === 'string' && s.trim());
    if (!msg || !before.length) return false;
    if (FOLLOW_UP_START.test(msg) || REFERS_BACK.test(msg)) return false;
    const words = [...contentWords(msg)];
    if (words.length < 2) return false; // too short to tell: most short messages are follow-ups
    const seen = [...contentWords(before.join('\n'))];
    return !words.some((w) => seen.some((s) => related(w, s)));
  }

  const api = { isNewTopic, contentWords };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.chatTopic = api;
})(this);
