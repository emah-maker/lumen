// Auto model routing: when a local CLI engine runs with no model picked ('claudecode:default'), choose
// the model per message from the situation (browsing, research, a rewrite, code, an image, ...: see "situations" below)
// and how hard the task looks. Pure and cheap (no extra model call): a score
// from the prompt text and what is attached, bucketed into light / standard / heavy, held to the situation's floor or ceiling, then looked up
// in TABLE. A model the user picked (anything but 'default') is never touched, and neither is an
// engine with no row in TABLE (Grok Build: its model ids come from `grok models`, so no fixed tiers).
// The picker's own "Auto" (ai/auto-model.js, docs/auto-model.md) reuses this scoring (tierFor) for every engine and provider.
// Agent.claudeCodePlan calls route(); the previous tier is kept in the chat's settings (ccAutoTier),
// and is pinned (never lowered) while the chat's CLI session lasts.

const TIERS = ['light', 'standard', 'heavy'];

// The one mapping table: engine -> tier -> a `claude --model` family alias (each follows that family's
// latest model, see claude-code.js MODELS). An engine absent here is left on its own default.
const TABLE = {
  claudecode: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
};
const NAMES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

const HEAVY_WORDS = /\b(refactor\w*|architect\w*|design(?:ing)?|debug\w*|root cause|investigat\w+|implement\w*|migrat\w+|optimi[sz]\w+|audit|race condition|deadlock|memory leak|trade-?offs?|algorithm\w*|rewrite|redesign|codebase|multi-?file|across (?:the )?(?:files|repo|project)|end-to-end|integrat\w+|concurren\w+|prove|derive|analy[sz]e|review (?:the|this|my)|why (?:does|is|do|are|did|isn'?t|doesn'?t|won'?t)|step[- ]by[- ]step|from scratch|comprehensive|in depth|thorough\w*)\b/gi;
const MEDIUM_WORDS = /\b(fix|bug|error|exception|crash\w*|write|build|script|code|function|test\w*|plan|compare|research|explain|regex|sql|api|config\w*|compile\w*)\b/gi;
const LIGHT_WORDS = /\b(what(?:'s| is) the (?:time|date|weather)|what time|summari[sz]e|tl;?dr|translate|define|definition of|spell\w*|convert|weather|who is|open|go to|navigate to|search for|look up|scroll|click|bookmark|close (?:this|the) tab|rephrase|proofread|hello|hi|hey|thanks|thank you)\b/gi;
const CODE_WORDS = /\b(fix|bugs?|errors?|exception|crash\w*|script|code|coding|function|test\w*|regex|sql|api|config\w*|compile\w*|implement\w*|refactor\w*|debug\w*|stack ?trace|commit|repo)\b|```/i;
const ACK = /^\s*(?:continue|go on|keep going|carry on|yes|yeah|yep|y|ok|okay|sure|do it|fix it|try again|retry|proceed|go ahead|next|more|and\??|then\??|please|thanks?|sounds good|that works|again)[\s.!?]*$/i;

// A pure sign-off ("thanks", "great, thank you so much", "got it"): nothing to read or do, so the smallest model
// answers it, whatever the chat was doing before. ("ok" and "yes" alone stay follow-ups: they may mean "go ahead".)
const CLOSER = /^\s*(?:(?:ok(?:ay)?|great|perfect|awesome|nice|cool|good|got it|brilliant|wonderful|excellent|amazing)[\s,.!-]*)?(?:thanks?(?: a lot| a bunch| so much| very much| again)?|thank you(?: so much| very much| again)?|thx|ty|cheers|got it|perfect|great|awesome|nice one|cool|that'?s? (?:all|it)|all good|no thanks)(?:\s+(?:for (?:that|the help|your help|everything)|that(?:'s| is) (?:perfect|great|all|it)))?[\s.!)]*$/i;
const count = (text, re) => (String(text).match(re) || []).length;

// How hard a message looks. Higher is harder; roughly -4 (a greeting) to 15+ (a multi-part debugging brief).
function score(prompt, { imageCount = 0, tabCount = 0 } = {}) {
  const t = String(prompt || '').trim();
  let s = 0;
  const len = t.length;
  if (len > 1500) s += 3; else if (len > 600) s += 2; else if (len > 250) s += 1; else if (len < 40) s -= 1;
  // Steps and requirements: numbered / bulleted lines, and sequencing words.
  const listed = count(t, /^\s*(?:\d+[.)]|[-*•])\s+\S/gm);
  const sequenced = count(t, /\b(?:then|after that|afterwards|finally|first|second|third|also|additionally|as well as|make sure)\b/gi);
  s += Math.min(3, Math.floor(listed / 2)) + Math.min(2, Math.floor(sequenced / 2));
  s += Math.min(6, count(t, HEAVY_WORDS) * 2);
  s += Math.min(2, count(t, MEDIUM_WORDS));
  if (/```/.test(t)) s += 2;
  if (/Traceback \(most recent call last\)|^\s+at .+:\d+/m.test(t)) s += 2;
  if (count(t, /[\w./\\-]+\.(?:js|ts|tsx|jsx|py|go|rs|java|c|cpp|css|html|json|md|sql)\b/gi) >= 2) s += 2;
  // Simple lookups and small chores pull down, unless the message is long (a light word inside a long brief means nothing).
  if (len < 300 && count(t, LIGHT_WORDS)) s -= 2;
  if (imageCount) s += 1;
  if (tabCount >= 4) s += 2; else if (tabCount >= 2) s += 1;
  return s;
}

// Haiku 5.5 handles ordinary chat, page questions, summaries and plain browsing well, so 'light' (Haiku) reaches up to a score of 1,
// unless the message is about code (CODE_WORDS): that stays on Sonnet. Only a clearly hard brief (6+) goes to Opus.
const LIGHT_MAX = 1;
const HEAVY_MIN = 6;
const tierOf = (s, coding = false) => (s >= HEAVY_MIN ? 'heavy' : s <= (coding ? -2 : LIGHT_MAX) ? 'light' : 'standard');

// ---------- situations ----------
// Difficulty alone is a poor guide: "open the cart and check out" is short but needs a model that does not misclick, and
// "summarize this long page" is long but cheap. So each message is first sorted into a SITUATION (a handful of things a browser
// assistant actually sees, read from the words and the signals Lumen already has: attached images and tabs, whether the
// message is about the page in view), and each situation sets a floor / ceiling on the tier that the score then moves within.
// Evidence for the floors is in docs/auto-model.md ("Research"). No model call: regexes and counts.
//   quick      a sign-off ("thanks"): the smallest model        imagegen   "draw a logo": the model only writes the prompt
//   chat       everything else: the score decides              rewrite    translate, rephrase, proofread: small unless long
//   page       a question about the page in view: small, the score may raise it
//   browse     open / click / fill / buy: reliable tool use beats raw size; a multi-step or form task is never the smallest
//   research   sources, literature, verifying a value against a source, many tabs: synthesis over long context, never the smallest
//   compare    "compare", "versus", "pros and cons", "which should I buy": weighing options, never the smallest
//   writing    new text (an email, a post, a cover letter, an essay): short pieces small, long-form or high-stakes pieces mid-size, deep long-form the strongest
//   code       code and debugging: the score decides (Sonnet and up unless trivial)
//   reasoning  proofs and maths: never the smallest, the hardest ("prove", "theorem") the strongest
//   vision     an attached image: any model that sees; charts, forms, mockups and the like are never the smallest
const SITUATIONS = ['quick', 'chat', 'page', 'rewrite', 'writing', 'imagegen', 'browse', 'research', 'compare', 'code', 'reasoning', 'vision'];
const WRITE_VERB = /\b(?:write|draft|compose|prepare|put together|come up with|generate|create|make)\b/i;
const WRITE_NOUN = /\b(?:essays?|reports?|articles?|stor(?:y|ies)|cover letters?|letters?|e-?mails?|posts?|speech(?:es)?|proposals?|(?:personal |mission |purpose )?statements?|bios?|blogs?|paragraphs?|poems?|messages?|captions?|toasts?|newsletters?|white ?papers?|chapters?|reviews?|descriptions?|scripts? for|recommendations?|cv|resume|résumé)\b/i;
const WRITE_LONG = /\b(?:essays?|reports?|articles?|stor(?:y|ies)|cover letters?|speech(?:es)?|proposals?|(?:personal |mission |purpose )?statements?|white ?papers?|chapters?|newsletters?|recommendation letters?|cv|resume|résumé)\b/i;
const WRITE_DEEP = /\b(?:in[- ]depth|thorough\w*|comprehensive|rigorous|publication|academic|scholarly|detailed analysis)\b/i;
const COMPARE = /\b(?:compare|comparison|versus|vs\.?|pros and cons|which (?:\w+ ){0,2}(?:should i|do you|would you) (?:buy|get|choose|pick|go with|recommend)|which is (?:better|best))\b/i;
// A requested length: "1500 word", "2 pages". -> approximate words (0 when none was asked)
function lengthAsked(t) {
  const w = /\b(\d[\d,]{1,5})[- ]?words?\b/i.exec(t);
  if (w) return Number(w[1].replace(/,/g, ''));
  const p = /\b(\d{1,3}|one|two|three|four|five)[- ]?pages?\b/i.exec(t);
  if (p) return ({ one: 1, two: 2, three: 3, four: 4, five: 5 }[p[1].toLowerCase()] || Number(p[1])) * 450;
  return 0;
}
const IMAGEGEN = /^\s*(?:please\s+)?(?:draw|sketch|paint|illustrate|generate|create|make|design|render)\b[^.?!\n]{0,40}\b(?:images?|pictures?|photos?|illustrations?|logos?|icons?|posters?|wallpapers?|sketch(?:es)?|drawings?|portraits?|banners?|avatars?)\b/i;
const REWRITE = /\b(?:translate|translation|rewrite|rephrase|reword|paraphrase|proofread|copy-?edit|shorten|polish|fix (?:the )?(?:grammar|typos?|spelling)|make (?:it|this|that) (?:shorter|longer|more \w+|sound \w+)|in (?:plain|simple) (?:english|words))\b/i;
const MATH = /\b(?:prove|proof|theorem|lemma|derive|derivation|integral|derivative|eigen\w+|combinatori\w+|calculus|algebra|olympiad|solve (?:for|the equation)|equations?)\b/i;
const MATH_HARD = /\b(?:prove|proof|theorem|lemma|olympiad)\b/i;
const RESEARCH = /\b(?:research|literature review|find sources|peer-?reviewed|scholarly|citations?|bibliograph\w+|fact-?check|state of the art|systematic review|deep dive|what does the (?:research|evidence|literature) say|(?:sources?|references?) (?:on|for|about)|studies (?:on|about|show))\b/i;
// Checking a claim, a table or a value against a source ("double check the tables", "is this right", "look it up"): the model has to find
// the source, read it and compare, so it is research: never the smallest model, and the tools stay on.
const VERIFY = /\b(?:double[- ]?check|re-?check|verify|verification|fact[- ]?check|check (?:the|this|that|these|those|my|if|whether) (?:\w+ ){0,2}(?:tables?|values?|numbers?|figures?|data|facts?|claims?|answers?|results?|sources?|steam|units?|properties)|look (?:it|this|that|them) up|look up (?:the |a )?(?:tables?|values?|numbers?|figures?|data|sources?|steam|propert(?:y|ies)|references?)|is (?:this|that|it) (?:right|correct|true|accurate)|are (?:these|those|they) (?:right|correct|accurate)|confirm (?:the |these |those |this |that |my )?(?:\w+ )?(?:values?|numbers?|figures?|data|facts?)|find (?:the|a) source|(?:what'?s|where'?s) the source)\b/i;
const ACTION = /\b(?:open|go to|navigate to|visit|click|fill (?:in|out)|(?:sign (?:in|up|out)|log ?(?:in|out))(?!\s+(?:button|link|page|tab|form))|book|reserve|order|buy|purchase|add .{1,30} to (?:my |the )?cart|check ?out|submit|download|upload|scroll|unsubscribe|subscribe|search for|find me|bookmark|close (?:this|the|all)|switch to|rename|move it)\b/gi;
const FORMISH = /\b(?:form|checkout|payment|password|credit card|book|reserve|apply|register|order|buy|purchase|cart)\b/i;
const SEQUENCE = /\b(?:then|after that|afterwards|and then|finally|next)\b/i;
const VISUAL_HARD = /\b(?:charts?|graphs?|diagrams?|tables?|spreadsheets?|invoices?|receipts?|forms?|ui|mockups?|designs?|layouts?|wireframes?|slides?|equations?|handwritten|schematics?)\b/i;
const PAGEWORDS = /\b(?:this|the current|that) (?:page|article|tab|site|website|post|pdf|document|thread|video)\b|\b(?:summari[sz]e|tl;?dr|what does (?:it|this) say)\b/i;
const RANK = { light: 0, standard: 1, heavy: 2 };
const atLeast = (tier, floor) => (RANK[tier] >= RANK[floor] ? tier : floor);

// Which situation a message is. -> { kind, multi }  (multi: a browsing task with several steps, a form or a purchase)
// unattended: nobody is watching (a background task): it is treated as browsing, and never goes to the smallest model.
function situationOf(prompt, { imageCount = 0, tabCount = 0, page = false, unattended = false, previousKind = null, followUp = false } = {}) {
  const t = String(prompt || '').trim();
  if (unattended) return { kind: 'browse', multi: true };
  if (!imageCount && !tabCount && t.length <= 60 && CLOSER.test(t)) return { kind: 'quick', multi: false }; // (a sign-off ends any task, whatever it was)
  if (followUp && previousKind && SITUATIONS.includes(previousKind)) return { kind: previousKind, multi: previousKind === 'browse' };
  const actions = count(t, ACTION);
  const browsing = actions > 0 && !CODE_WORDS.test(t);
  const multi = browsing && (actions >= 2 || (SEQUENCE.test(t) && actions >= 1) || FORMISH.test(t) || tabCount >= 2);
  if (!imageCount && IMAGEGEN.test(t)) return { kind: 'imagegen', multi: false };
  if (CODE_WORDS.test(t)) return { kind: 'code', multi: false };
  if (MATH.test(t)) return { kind: 'reasoning', multi: false };
  if (RESEARCH.test(t) || VERIFY.test(t) || tabCount >= 3) return { kind: 'research', multi: false };
  if (COMPARE.test(t)) return { kind: 'compare', multi: false };
  if (REWRITE.test(t) && !browsing) return { kind: 'rewrite', multi: false };
  const words = lengthAsked(t);
  if (!browsing && ((WRITE_VERB.test(t) && WRITE_NOUN.test(t)) || (WRITE_VERB.test(t) && words > 0))) {
    const long = words > 300 || WRITE_LONG.test(t);
    return { kind: 'writing', multi: false, long, deep: long && WRITE_DEEP.test(t) };
  }
  if (imageCount) return { kind: 'vision', multi: false };
  if (browsing) return { kind: 'browse', multi };
  if (page || tabCount > 0 || PAGEWORDS.test(t)) return { kind: 'page', multi: false };
  return { kind: 'chat', multi: false };
}

// The scored tier, held to what the situation needs.
function applySituation(tier, sit, { prompt = '' } = {}) {
  const len = String(prompt).trim().length;
  switch (sit.kind) {
    case 'quick': case 'imagegen': return 'light';
    case 'rewrite': return len > 1500 ? atLeast(tier === 'heavy' ? 'standard' : tier, 'standard') : 'light';
    case 'browse': return sit.multi ? atLeast(tier, 'standard') : tier;
    case 'research': case 'compare': return atLeast(tier, 'standard');
    case 'writing': return sit.deep ? 'heavy' : sit.long ? atLeast(tier, 'standard') : (tier === 'heavy' ? 'standard' : 'light');
    case 'reasoning': return atLeast(tier, MATH_HARD.test(prompt) ? 'heavy' : 'standard');
    case 'vision': return VISUAL_HARD.test(prompt) ? atLeast(tier, 'standard') : tier;
    default: return tier;
  }
}

// A short reason for the picker's tooltip ("Auto: Sonnet for a browsing task"). The tier says how much, the situation what.
function whyOf(kind, tier, { tools = true, multi = false } = {}) {
  switch (kind) {
    case 'quick': return 'a quick reply';
    case 'imagegen': return 'a picture request';
    case 'rewrite': return tier === 'light' ? 'a rewrite or translation' : 'a long rewrite';
    case 'page': return tier === 'light' ? 'a question about the page' : tier === 'heavy' ? 'a demanding question about the page' : 'a long page';
    case 'browse': return multi ? 'a multi-step browsing task' : 'a browsing task';
    case 'research': return tier === 'heavy' ? 'deep research' : 'research across sources';
    case 'compare': return 'a comparison';
    case 'writing': return tier === 'light' ? 'a short piece of writing' : tier === 'heavy' ? 'a demanding piece of writing' : 'a long piece of writing';
    case 'code': return tier === 'heavy' ? 'a hard coding task' : 'a coding task';
    case 'reasoning': return tier === 'heavy' ? 'a hard proof' : 'a reasoning problem';
    case 'vision': return 'an image';
    default: return tier === 'light' ? (tools ? 'a quick task' : 'a quick question') : tier === 'heavy' ? 'a demanding task' : 'a typical request';
  }
}

// Tier for this message given the conversation so far. `previous` is { tier, turns, kind } from the last
// routed turn. A short follow-up ("continue", "fix it", "yes") never drops below the previous turn's
// tier (and keeps its situation), so a hard task isn't handed to a smaller model halfway through; a real change of subject
// (a long or heavier message) is scored on its own.
// pinned: the message continues a CLI session routed before (Claude Code --resume). The tier then
// never goes down, whatever the message: another model mid-session starts its prompt cache from
// scratch. It can still go up for a harder message. A new session is scored on its own again.
// page: the message is about the page in view (a screenshot, a selection, an attached tab). unattended: a background task.
function tierFor(prompt, { imageCount = 0, tabCount = 0, previous = null, pinned = false, page = false, unattended = false, tools = true } = {}) {
  const s = score(prompt, { imageCount, tabCount });
  const t = String(prompt || '').trim();
  const prev = previous && TIERS.includes(previous.tier) && previous.turns > 0 ? previous.tier : null;
  const followUp = Boolean(prev) && (ACK.test(t) || (t.length <= 40 && !imageCount && !count(t, LIGHT_WORDS)));
  const sit = situationOf(t, { imageCount, tabCount, page, unattended, previousKind: prev ? previous.kind : null, followUp });
  if (sit.kind === 'quick' && !pinned) return { tier: 'light', score: s, followUp: false, closer: true, kind: 'quick', why: whyOf('quick', 'light') };
  let tier = applySituation(tierOf(s, CODE_WORDS.test(t)), sit, { prompt: t });
  if (unattended) tier = atLeast(tier, 'standard');
  if ((followUp || (pinned && prev)) && TIERS.indexOf(prev) > TIERS.indexOf(tier)) tier = prev;
  return { tier, score: s, followUp, kind: sit.kind, multi: sit.multi, why: whyOf(sit.kind, tier, { multi: sit.multi, tools }) };
}

// The engine's model for a tier, or null when the engine has no tiers.
const modelForTier = (engine, tier) => TABLE[engine]?.[tier] || null;

const labelFor = (model) => `Auto · ${NAMES[model] || model}`;

// The one call. `picked` is the model part of the picker id ('default' when none was chosen).
// Returns { model, auto, tier?, score?, label? }: model is what to pass on (the picked one unless auto-routed).
function route({ engine, picked = 'default', prompt, imageCount = 0, tabCount = 0, previous = null, pinned = false, enabled = true, page = false } = {}) {
  if (!enabled || (picked && picked !== 'default') || !TABLE[engine]) return { model: picked || 'default', auto: false };
  const { tier, score: s, followUp, kind, why } = tierFor(prompt, { imageCount, tabCount, previous, pinned, page });
  const model = modelForTier(engine, tier);
  return { model, auto: true, tier, score: s, followUp, kind, why, label: labelFor(model) };
}

module.exports = { TIERS, TABLE, SITUATIONS, LIGHT_MAX, HEAVY_MIN, score, tierOf, tierFor, situationOf, applySituation, whyOf, modelForTier, labelFor, route };
