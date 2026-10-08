// Does this message point at what the user is looking at? ("what is this", "explain this error", "is this a scam",
// "solve this", "on my screen") When it does, the sidebar attaches a screenshot of the active tab, so the user does not
// have to describe it. A pure function of the typed words (no model call, no I/O), so it is cheap enough to run on every
// keystroke: main.js's agent uses it to decide, and the composer (renderer/chat-core.js) to light the camera button.
//
// A weighted score, not one regex: "this" alone is almost always about the AI's previous answer ("this is wrong, try
// again"), so only a deictic with something visible after it counts: a verb that acts on a thing (explain, solve, fix),
// a question about it (what is this, is this a scam), or a noun that lives on a page (this chart, this error, this
// video). English only.
//
//   wantsScreen(text, { hasSelection, lastTurns }) -> { screen: boolean, reason: string, score: number }
//     hasSelection  the user has text selected on the page (it is attached as text, so a bare "this" means that)
//     lastTurns     the recent conversation, [{ role: 'user' | 'assistant', text }], oldest first (optional)

const THRESHOLD = 5;

// Things that are on a page and can be pointed at.
const NOUN = '(?:page|screen|tab|site|website|web ?page|window|app|chart|graph|plot|diagram|map|table|spreadsheet|sheet|image|picture|photo|pic|screenshot|video|clip|gif|meme|slide|slides|pdf|document|doc|article|post|tweet|thread|comment|review|ad|ads|listing|product|price|offer|deal|form|field|input|button|menu|popup|pop-up|dialog|modal|banner|notification|alert|error|errors|warning|message|email|e-mail|mail|invoice|receipt|bill|statement|quiz|question|problem|exercise|equation|formula|proof|puzzle|assignment|homework|test|exam|task|ticket|issue|bug|stack ?trace|traceback|log|logs|output|result|results|code|snippet|function|script|command|config|setting|settings|ui|interface|layout|design|mockup|logo|icon|text|paragraph|sentence|passage|section|heading|title|caption|label|option|options|plan|list|link|url|address|name|number|code|captcha|stat|stats|data|figure|numbers|dashboard|report|resume|cv|profile|bio|recipe|menu|schedule|calendar|event|game|level|board|card|cards|tile|widget|thing|things)';
// These nouns are mostly about the AI's own previous output ("this code doesn't work"): they count only with a verb.
const OUTPUT_NOUN = /^(?:code|snippet|function|script|command|result|results|output|plan|list|message|text|paragraph|sentence|section|name|number|options?|data|things?|config|log|logs)$/i;

const VISUAL_NOUN = /\b(?:chart|graph|plot|diagram|image|picture|photo|pic|screenshot|video|clip|gif|meme|map|slide|slides|pdf|page|screen|tab|site|website|webpage|window|layout|design|mockup|logo|icon|ui|interface|dashboard|popup|pop-up|banner|captcha|table|spreadsheet)\b/i;

// [regex, weight, label]. A match adds its weight once.
const POSITIVE = [
  // explicit
  [/\bscreen ?shots?\b/i, 10, 'asks about a screenshot'],
  [/\b(?:look(?:ing)? (?:at|on)|see|check|read|watch|view) (?:my|the|this|your) screen\b/i, 10, 'look at the screen'],
  [/\b(?:on|in) (?:my|the|this|your) (?:screen|monitor|display)\b/i, 9, 'on my screen'],
  [/\bmy screen\b/i, 8, 'my screen'],
  [/\b(?:what|everything|anything|all) (?:i|you)(?:'m| am| can| are)? (?:currently |now )?(?:see(?:ing)?|looking at|viewing|watching)\b/i, 9, 'what I see'],
  [/\b(?:what am i|what are we|what is it i am|what's it i'm) (?:looking at|seeing|viewing|watching|reading)\b/i, 9, 'what am I looking at'],
  [/\b(?:what i(?:'m| am) (?:looking at|seeing|viewing|watching|reading))\b/i, 9, 'what I am looking at'],
  [/\b(?:can|do|could|did) you (?:even )?see (?:this|it|that|what|my|the|me)\b/i, 8, 'can you see'],
  [/\bas you can see\b/i, 6, 'as you can see'],
  [/\b(?:look|looks|looking) (?:at|here)\b.{0,12}\b(?:this|here)\b|\blook(?:ing)? at (?:this|these|that)\b/i, 8, 'look at this'],
  [/\blook (?:here|over here)\b/i, 8, 'look here'],
  [/\b(?:see|check|check out|read|watch) (?:this|these)\b/i, 7, 'see this'],
  [/\b(?:the )?(?:thing|stuff|part|bit|section|area|box|one) (?:on|in|at) (?:the |my |this )?(?:screen|page|tab|site|website|window)\b/i, 9, 'the thing on screen'],
  [/\bwhat (?:do|can|did) you see\b/i, 8, 'what do you see'],
  [/\b(?:on|in|at|from) (?:this|the current|the open|the active) (?:page|tab|site|website|webpage|window|screen|video|article|document|pdf)\b/i, 7, 'on this page'],
  [/\b(?:the|this) (?:current|open|active|opened) (?:page|tab|site|website|webpage|window)\b/i, 5, 'the current page'],
  [/\b(?:what(?:'s| is)|what are|who(?:'s| is)|who are) (?:on|in) (?:this|the|my) (?:page|tab|screen|image|picture|photo|video|site|website)\b/i, 9, 'what is on'],
  // a question about "this"
  [/\bwhat(?:'s| is| are|s)? (?:this|these|that thing|that on)\b/i, 6, 'what is this'],
  [/\bwhat(?:'s| is)? (?:going on|happening|wrong|up|the (?:deal|point|catch)) (?:here|with this|on this|in this)\b/i, 7, 'what is going on here'],
  [/\bwhat (?:does|do|did) (?:this|these) (?:mean|say|do|show|represent|stand for|refer to|look like)\b/i, 7, 'what does this mean'],
  [/\b(?:what|who|where|why|how|when|which)\b[^.?!]{0,40}\b(?:this|these) (?:means?|says?|is|are|does|do|about|for|from|come from|work|works)\b/i, 5, 'wh-question about this'],
  [/\b(?:who|where|whose) (?:is|are|made|wrote|took|drew|painted|posted|owns) (?:this|these|that)\b/i, 6, 'who is this'],
  [/\b(?:where|what|which) (?:is|are|was|were|am i|are we)? ?(?:this|these) (?:from|photo|picture|image|place|location|taken|located)\b/i, 6, 'where is this'],
  [/\bis (?:this|that|it) (?:a |an )?(?:scam|fake|real|legit|legitimate|safe|spam|phishing|virus|malware|trustworthy|reliable|genuine|authentic|ai|ai-generated|photoshopped|edited|true|accurate|correct|right|wrong|ok|okay|normal|supposed to|good|bad|worth|a good|a bad)\b/i, 5, 'is this ...?'],
  [/\b(?:does|do|did|will|would|can|could|should) (?:this|these) (?:look|seem|sound|make sense|work|apply|count|mean|matter|help|fit|add up|belong)\b/i, 5, 'does this ...?'],
  [/\b(?:why|how) (?:is|are|does|do|did|can|could|would|should)(?: (?:it|this|that))? (?:this|these) (?:happen|happening|showing|show|appear|appearing|look|looking|so|not|still|keep|work|working)\b/i, 5, 'why is this'],
  [/\bwhat (?:should|can|do|could|would|must|shall) (?:i|we) (?:do|click|press|choose|pick|select|enter|type|write|put|fill|answer|say|reply|use) (?:here|now|next|on this|in this|about this|with this)\b/i, 7, 'what do I do here'],
  [/\bwhat(?:'s| is) (?:next|the next step|the answer|the solution|the fix|the correct (?:answer|option)|the right (?:answer|option)) (?:here|on|for|to|in)\b/i, 5, 'what is next here'],
  [/\b(?:how|where|what) (?:do|can|should|would|could) (?:i|we) (?:use|read|fix|solve|answer|fill|find|click|open|get|do|make|set|change|close|remove|skip|submit|enter|type) (?:this|these|it|that|here)\b[^.?!]{0,6}$/i, 4, 'how do I ... this'],
  [/\b(?:what|which|where) (?:button|link|option|field|box|tab|menu|icon|thing)\b[^.?!]{0,30}\b(?:click|press|tap|choose|select|use|open|here|this)\b/i, 6, 'which button'],
  // an action on "this"
  [/\b(?:explain|solve|summari[sz]e|translate|read|describe|analy[sz]e|analyse|decode|interpret|identify|define|critique|proofread|simplify|clarify|decipher|diagnose|debug|answer|grade|rate|review|evaluate|fact[- ]?check|verify|proof ?read|break down|walk me through|walk through|go over|figure out|make sense of|tell me (?:about|what)|talk me through|unpack|annotate|transcribe|reply to|respond to|rewrite|improve|fix|complete|finish|do|redo|fill(?: in| out)?|calculate|compute|convert|compare|find|spot|count|measure|pick|choose|rank|price|quote|extract|copy|list|label) (?:this|these|that one|all this|all of this|everything here|everything on)\b/i, 6, 'verb + this'],
  [/\b(?:help(?: me)?|assist(?: me)?) (?:with|on|understand|figure out|solve|fix|read|do|get|decide|choose|make sense of) (?:this|these)\b/i, 6, 'help with this'],
  [/\b(?:explain|describe|summari[sz]e|show me|tell me|teach me|walk me through) (?:what )?(?:i(?:'m| am) (?:looking at|seeing|reading|watching)|this|here)\b/i, 6, 'explain this'],
  [/\b(?:what(?:'s| is)|what are|how(?:'s| is)) (?:the|this) (?:the )?(?:point|gist|idea|summary|main idea|takeaway|tl;?dr) (?:of|here|in)\b/i, 5, 'the gist of'],
  [/\b(?:tl;?dr|summary|summarize|summarise|gist)\b.{0,16}\b(?:this|here|the page|page)\b|\b(?:this|here)\b.{0,16}\b(?:tl;?dr|summary|summarize|summarise)\b/i, 6, 'tl;dr this'],
  [/\bwhat(?:'s| is) (?:the )?(?:answer|solution|fix|cause|reason|meaning|total|sum|price|cost|date|time|name|rule|deadline) (?:to|for|of|on|in|here|on this|in this)\b[^.?!]{0,20}\b(?:this|here|these)\b/i, 6, 'what is the answer to this'],
  [/\b(?:what|which|how many|how much)\b[^.?!]{0,30}\b(?:is|are|am|do|does)\b[^.?!]{0,30}\b(?:shown|displayed|showing|listed|written|visible|selected|highlighted|circled|marked|at the top|at the bottom|on the left|on the right|in the corner|in red|in blue|in green)\b/i, 7, 'what is shown'],
  [/\b(?:the|this|that) (?:red|blue|green|yellow|orange|highlighted|selected|circled|top|bottom|left|right|big|small|first|second|third|last|next|previous|above|below|following|attached|shown|displayed) (?:one|thing|part|bit|text|line|box|button|link|number|item|row|column|graph|chart|picture|image|word|sentence|paragraph|section|error|message|option|field|icon|label|result|answer|question)\b/i, 6, 'that red thing'],
  [/\b(?:the|this) (?:above|following|below) (?:error|text|question|problem|image|picture|screen|code|table|chart|graph|paragraph|email|message|equation)\b/i, 6, 'the above'],
  [/\b(?:what|how) (?:does|do|would|should|can|is|are) (?:the|this|these) (?:error|warning|popup|pop-up|dialog|message|notification|alert|banner|graph|chart|table|diagram|screen|page|form|button|icon|symbol|label) (?:mean|say|show|display|tell|look|work|do)\b/i, 7, 'what does the error mean'],
];

// A deictic followed by a noun from the page: "this chart", "these results", "that error".
const DEICTIC_NOUN = new RegExp(`\\b(?:this|these|that|those) (?:\\w+ ){0,2}?(${NOUN})\\b`, 'gi');

// Words that make "this" about the AI's own previous answer.
const ABOUT_AI = [
  [/\b(?:this|that|it) (?:is|was|isn't|wasn't|is not|was not|are|were|seems|seemed|looks|looked|sounds|sounded|feels|felt|doesn't|does not|didn't|did not|won't|will not|still|worked|works|helped|helps|makes|made|fixed|fixes|broke|breaks|worked|failed|fails|is still|has|had|gives|gave|gets|got)\b/i, 'comment on the answer'],
  [/^\s*(?:no|nope|nah|yes|yeah|yep|ok|okay|thanks|thank you|thx|cool|nice|great|good|perfect|wrong|incorrect|right|correct|try again|again|continue|go on|more|next|stop|wait|hmm|huh)\b/i, 'reply to the answer'],
  [/\b(?:try again|do it again|once more|one more time|start over|never ?mind|that works|that worked|that's (?:wrong|right|correct|not right|not what i|better|worse|good|great|perfect|it|all|enough)|you(?:'re| are) (?:wrong|right)|you (?:forgot|missed|got|made|said|wrote|gave|didn't|did not|keep|already))\b/i, 'comment on the answer'],
];

// Something is being asked of the answer, not the page: "make this shorter", "add this to the list", "translate this to French".
const REWORK_ANSWER = /\b(?:make|keep|write|say|put|turn|change) (?:this|that|it) (?:shorter|longer|simpler|better|clearer|more|less|into|a bit|bullet|formal|casual|funnier|nicer)\b|\b(?:do|write|redo|rewrite|code|build|implement|make) (?:this|that|it) (?:in|with|using|as|for|but)\b|\b(?:shorten|lengthen|rephrase|reword|expand|elaborate on|add to|continue|extend|redo|repeat|rerun) (?:this|that|it)\b/i;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function lastAssistant(lastTurns) {
  if (!Array.isArray(lastTurns)) return '';
  for (let i = lastTurns.length - 1; i >= 0; i--) if (lastTurns[i]?.role === 'assistant') return clean(lastTurns[i].text);
  return '';
}

function wantsScreen(text, { hasSelection = false, lastTurns = [] } = {}) {
  const t = clean(text);
  if (t.length < 3 || t.length > 600) return { screen: false, reason: t ? 'too long to be a pointer' : 'empty', score: 0 }; // an essay is about its own words
  if (t.startsWith('/')) return { screen: false, reason: 'a command', score: 0 }; // /compact, /image ...
  let score = 0;
  const why = [];
  for (const [re, weight, label] of POSITIVE) {
    if (re.test(t)) { score += weight; why.push(label); }
  }
  // "this chart", "that error": a deictic with something visible after it (count the best, then a little for each more).
  let nouns = 0;
  let visual = VISUAL_NOUN.test(t) && /\b(?:this|these|that|those|my|the|on|in) /i.test(t);
  for (const m of t.matchAll(DEICTIC_NOUN)) {
    const noun = m[1];
    if (OUTPUT_NOUN.test(noun) && !score) continue; // "this code doesn't work": only with a verb that points at it (above)
    nouns += nouns ? 1 : 6;
    why.push(`this ${noun.toLowerCase()}`);
    if (VISUAL_NOUN.test(noun)) visual = true;
  }
  score += nouns;
  // A bare "this"/"here" is worth almost nothing on its own; it only breaks a tie.
  if (/\b(?:this|these)\b(?! (?:is|was|isn't|wasn't|doesn't|does not|didn't|won't|still|seems|looks|sounds|works|worked|helps|helped))/i.test(t) && score > 0) score += 1;
  if (/\bhere\b/i.test(t) && score > 0) score += 1;

  const answer = lastAssistant(lastTurns);
  // The AI's own last answer is the likelier referent when the words only react to it.
  const reacts = ABOUT_AI.filter(([re]) => re.test(t));
  if (reacts.length) {
    const visibleWord = visual || nouns > 0 && !/^(?:code|result|results|output)$/i.test(why.join(' '));
    const penalty = visibleWord ? 2 : answer ? 7 : 4;
    score -= penalty;
    if (score < THRESHOLD) why.push(`reacts to the answer (${reacts[0][1]})`);
  }
  if (/\bhow (?:do|can|to|would|should)\b[^.?!]{0,30}\bscreen ?shots?\b/i.test(t) && !/\bmy screen\b/i.test(t)) { score -= 12; why.push('asks how to take screenshots'); } // a how-to, not a request
  if (REWORK_ANSWER.test(t) && !visual) { score -= 6; why.push('asks to rework the answer'); }
  // Judging an answer: "is this right?" straight after a reply is about the reply.
  if (answer && /\b(?:is|was|are) (?:this|that|it) (?:right|correct|true|accurate|ok|okay|good|bad|wrong|fine|enough|all|the same|better|worse)\b/i.test(t) && !visual && nouns === 0) { score -= 4; why.push('judging the previous answer'); }
  // Selected text is attached as text and is what a bare "this" points at.
  if (hasSelection && !visual && !/\bscreen|screenshot\b/i.test(t)) { score = Math.min(score, THRESHOLD - 1); why.push('text is selected'); }
  const hit = score >= THRESHOLD;
  return { screen: hit, reason: hit ? why.slice(0, 3).join(', ') : (why.length ? `weak: ${why.slice(0, 2).join(', ')}` : 'no pointer to the screen'), score };
}

const api = { wantsScreen, THRESHOLD };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.screenIntent = api; // (the renderer: globalThis is the window)
