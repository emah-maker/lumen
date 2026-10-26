// Helpers: Off | Auto | On (the aiSubagents setting; Settings → AI and the sidebar's Helpers row). In Auto, whether a chat's requests list the `delegate`
// tool is worked out from what the user has said, with a cheap local check and no model call: a task with several independent parts ("apply to
// these 10 jobs", "for each of these sites", "compare A, B and C", a list of links) gets the tool; a single-step request, a question about one
// page or chit-chat does not, which keeps its definition out of the prompt. Pure functions (no Electron, no disk): agent.js helpersOffered feeds
// them the messages, test/units/helpers-auto-units.js covers them.
'use strict';

// Legacy settings were true / false; they mean On / Off. Anything else (no value, 'auto') is Auto.
function modeOf(value) {
  if (value === true || value === 'on') return 'on';
  if (value === false || value === 'off') return 'off';
  return 'auto';
}

const NUM_WORDS = 'three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|several|multiple|many|various|a few|a bunch of|a couple of|dozens of';
const ITEM_NOUNS = 'jobs?|roles?|positions?|postings?|listings?|internships?|co-?ops?|applications?|sites?|websites?|web ?pages?|pages?|links?|urls?|articles?|papers?|studies|sources?|stores?|shops?|retailers?|vendors?|products?|items?|options?|candidates?|companies|firms|restaurants?|hotels?|flights?|apartments?|schools?|universities|colleges?|courses?|professors?|reviews?|videos?|files?|documents?|pdfs?|tabs?|emails?|accounts?|forms?|profiles?|competitors?|alternatives?|brands?|models?|laptops?|phones?|cars?|prices?|quotes?|names?|people|contacts?|repos?|repositories|tools?|apps?|services?|platforms?|newsletters?|threads?|posts?|topics?|questions?|queries|keywords?|cities|countries|teams?|players?';
const COUNTED = new RegExp(`\\b(?:(?:\\d{1,3}|${NUM_WORDS})(?:\\s+(?:different|separate|other|more|of|these|those|the|top|best|new|open|local|online|major|big|popular|free))*\\s+(?:${ITEM_NOUNS})|(?:${ITEM_NOUNS})\\s+(?:1|one)\\s*(?:through|to|-|–)\\s*\\d+)\\b`, 'i');
const EACH = /\b(for each|each of (?:the|these|those|them|my)|every one of|one by one|one at a time for each|all of (?:these|those|them)|each (?:site|page|link|company|job|file|tab|one|item|result|source|store|product|paper|article)|every (?:site|page|link|company|job|file|tab|item|result|source|store|product|paper|article))\b/i;
const EXPLICIT = /\b(helpers?|sub-?agents?|in parallel|parallel(?:ly)?|at the same time|simultaneous(?:ly)?|concurrent(?:ly)?|side by side|batch)\b/i;
const MULTI_SOURCE = /\b(?:from|across|on|at|over|through|using)\s+(?:several|multiple|many|various|different|a few|a bunch of|dozens of|\d{1,3}|three|four|five|six|seven|eight|nine|ten)\s+(?:different\s+)?(?:sites|websites|sources|pages|stores|shops|retailers|vendors|blogs|papers|articles|databases|tabs|places|apps|platforms|reviews)\b/i;
const RESEARCH = /\b(research|investigate|survey|literature review|deep dive|look into|dig into|gather|collect|round ?up|scrape|compile|audit)\b/i;
const COMPARE = /\b(compare|comparison|versus|vs\.?|which is (?:cheaper|better|best)|price check|cheapest|best deal)\b/i;
const ACTION = /\b(research|check|compare|find|look up|lookup|read|summari[sz]e|apply|fill|extract|review|analy[sz]e|open|visit|go through|scan|list|search|get|pull|rate|grade|rank|look at|screen|collect|gather|fetch|download|translate|classify|categori[sz]e|sort|tell me about|what do)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|io|gov|co|ai|dev|app)\b(?:\/[^\s<>"')\]]*)?/gi;
const LIST_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/;
const COMMA_LIST = /[^,;.\n]{1,50},\s*[^,;.\n]{1,50},\s*(?:and|or|&)\s+[^,;.\n]{1,50}/; // "A, B, and C"
const COMMA_LIST_4 = /[^,;.\n]{1,40},\s*[^,;.\n]{1,40},\s*[^,;.\n]{1,40},\s*[^,;.\n]{1,40}/;

const MAX_CHARS = 1500; // the user's own words come first: a long paste (a page, an article) is not read for list-like words

// -> { offer, why } for one message's text. `why` names the first signal that fired (a test and a debugging aid, never shown).
function judge(text) {
  const t = String(text || '').slice(0, MAX_CHARS);
  if (t.trim().length < 12) return { offer: false, why: 'short' };
  const words = t.trim().split(/\s+/).length;
  if (EXPLICIT.test(t) && words >= 4) return { offer: true, why: 'explicit' };
  if (EACH.test(t) && ACTION.test(t)) return { offer: true, why: 'each' };
  if (COUNTED.test(t) && ACTION.test(t) && words >= 4) return { offer: true, why: 'counted' };
  if (MULTI_SOURCE.test(t) && (RESEARCH.test(t) || COMPARE.test(t) || ACTION.test(t))) return { offer: true, why: 'sources' };
  const urls = new Set((t.match(URL_RE) || []).map((u) => u.toLowerCase().replace(/[.,;:!?]+$/, '')));
  if (urls.size >= 3 && ACTION.test(t)) return { offer: true, why: 'urls' };
  const listed = t.split('\n').filter((l) => LIST_LINE.test(l)).length;
  if (listed >= 3 && ACTION.test(t)) return { offer: true, why: 'list' };
  if ((COMPARE.test(t) || RESEARCH.test(t)) && (COMMA_LIST.test(t) || COMMA_LIST_4.test(t))) return { offer: true, why: 'compare-list' };
  if (urls.size >= 2 && (COMPARE.test(t) || RESEARCH.test(t))) return { offer: true, why: 'compare-urls' };
  return { offer: false, why: 'single' };
}

const textOf = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');

// Whether Auto lists delegate for these messages: true once any of the user's last messages asked for a job with several parts. It stays on for the
// rest of the chat (the conversation's earlier request still says so), so the tool list does not change from one message to the next and the
// prompt cache of the tools and system prompt keeps working.
function wantsHelpers(messages, { lookBack = 30 } = {}) {
  if (!Array.isArray(messages)) return false;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0 && seen < lookBack; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const text = textOf(m);
    if (!text) continue; // (a tool result)
    seen++;
    if (judge(text).offer) return true;
  }
  return false;
}

// Whether the delegate tool is listed: Off never, On always, Auto when wantsHelpers says so.
const offered = (value, messages) => { const mode = modeOf(value); return mode === 'on' || (mode === 'auto' && wantsHelpers(messages)); };

module.exports = { modeOf, judge, wantsHelpers, offered };
