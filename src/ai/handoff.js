// Give-up detector: a final reply that hands the work back to the user ("paste the text here", "you'll need to ...",
// "give me access", "open it in a browser") gets ONE automatic follow-up turn, instead of ending the run (agent.js
// runTaskOnce). The judge is local and instant: a small scoring classifier over the reply and the request, no model call.
// A reply that stops for a real reason (a sign-in, a payment, a CAPTCHA, the user's own choice, a confirm before something
// destructive) is left alone. Pure: no Electron, no network. docs/settings.md (Show what the AI couldn't do).

const RETRY_OPEN = '<lumen_retry>';
const RETRY_CLOSE = '</lumen_retry>';
const RETRY_BLOCK = /<lumen_retry>[\s\S]*?<\/lumen_retry>\s*/g;

// What the AI is told on the follow-up turn. Never shown in the chat (transcriptFor drops the block).
const FOLLOWUP = `${RETRY_OPEN}Your last reply handed the work back to me. Don't. In one line, list what you tried. Then try a different approach with the tools you have: another tool, another page or source, or a different route to the same result. Don't ask me to paste, open, copy, click or do any step you can do. If the answer is a script, command or formula, giving it to me is complete: don't go hunting for MATLAB, Octave, Python or any other program on this computer just to run it yourself. Stop only if you are blocked by a sign-in only I can do, a purchase, a message to send, a CAPTCHA, a choice only I can make, or a destructive change that needs my OK, and say which.${RETRY_CLOSE}`;

// Reasons that need the user. Checked first: a reply that has one is never a handoff.
const LEGIT = [
  ['captcha', /\bcaptcha\b|\brecaptcha\b|\bhcaptcha\b|not a robot|bot[- ](?:check|detection|protection)|verify (?:that )?you(?:'re| are) (?:a )?human/i],
  ['sign-in', /\b(?:sign|log)(?:ged|ging)?[ -]?(?:in|into|on)\b|\bsign-?in\b|\blog-?in\b|\bpassword\b|\bpasscode\b|two-factor|\b2fa\b|\bmfa\b|verification code|one-time (?:code|password)|\bpasskey\b|authenticator|security key|credentials/i],
  // Money or an outgoing message, with an ask to confirm.
  ['payment', /\b(?:purchase|payment|checkout|check out|credit card|card number|billing|place (?:the|your) order|pay for|buy)\b[\s\S]{0,200}?\b(?:confirm|approve|go ahead|proceed|permission|ok|okay|your (?:call|decision|choice))\b|\b(?:confirm|approve|go ahead|proceed|permission|okay)\b[\s\S]{0,200}?\b(?:purchase|payment|checkout|credit card|billing|place (?:the|your) order|pay for|buy)\b/i],
  ['send', /\b(?:confirm|approve|go ahead|proceed|permission|okay|ok to|want me to)\b[\s\S]{0,160}?\b(?:send|post|publish|submit|reply to|email|message|tweet)\b|\b(?:send|post|publish|submit)\b[\s\S]{0,120}?\b(?:confirm|approve|go ahead|your (?:ok|okay|approval|permission))/i],
  ['destructive', /\b(?:confirm|approve|go ahead|proceed|permission|okay|ok to|are you sure|want me to|should i)\b[\s\S]{0,160}?\b(?:delete|remove|erase|wipe|overwrite|discard|empty|permanently|irreversible|cannot be undone|can't be undone)\b|\b(?:delete|erase|wipe|overwrite|permanently|irreversible|cannot be undone|can't be undone)\b[\s\S]{0,160}?\b(?:confirm|approve|go ahead|your (?:ok|okay|approval)|are you sure)\b/i],
];

// A question back about which way to go: the request really is ambiguous.
const CHOICE = /\b(?:which (?:one|of|do you|would you|option)|did you mean|do you mean|would you (?:prefer|like me to [^?]{1,80}\bor\b)|do you want me to [^?]{1,80}\bor\b|what would you like|can you clarify|could you clarify|which .{1,40} (?:should|do you want))\b/i;

// Ways of handing work back. strong: one match is enough. weak: needs a short reply, or a second kind.
const HANDOFF = [
  // The user is asked to supply content the AI could read itself.
  ['paste', true, /\b(?:paste|copy[- ]?(?:and|&)[- ]?paste|copy[- ]paste)\b|\b(?:send|share|give|provide|upload|attach|drop)(?: me)?(?: in)? (?:the |your |a |an )?(?:full |entire |whole |complete |actual |exact )?(?:text|content|contents|copy|body|transcript|report|document|doc|article|essay|draft|file|link|url|screenshot|details)\b[^.!?\n]{0,40}\b(?:here|to me|in (?:the )?chat|so i can)\b/i],
  // Access the AI wants the user to grant, or says it lacks.
  ['access', true, /\b(?:give|grant|allow|enable|provide|turn on)(?: me| claude| the ai| lumen)?\b[^.!?\n]{0,50}\b(?:access|permission|clipboard)\b|\bI (?:need|require) (?:you to (?:give|grant|allow|enable)|access|permission)\b|\bI (?:don't|do not) have (?:access|permission)\b|\bI (?:can(?:'|no)t|cannot|am (?:not )?unable to|'m (?:not )?unable to|am not able to|'m not able to) (?:access|read|open|reach|see|view|get into)\b/i],
  // A step for the user.
  ['user-step', true, /\byou(?:'ll| will| would)? (?:need|have|must|'ll have|will have) to\b|\byou(?:'d| would) (?:need|have) to\b|\byou (?:can|could|may|should|might want to) (?:just |simply |easily |quickly )?(?:do|try|open|go|click|copy|run|use|check|download|install|select|press|navigate|visit|look|search|ask|manually|take)\b|\b(?:it|this|that) (?:should |will |would )?takes? (?:you )?(?:only |just |about |around |roughly |maybe )*\d+\s*(?:-\s*\d+\s*)?(?:minutes?|mins?|seconds?)\b|\b(?:open|go to|navigate to|visit|click|copy|download|install|run|select)\b[^.!?\n]{0,60}\b(?:yourself|manually|on your own|on your end)\b|\bI(?:'d| would)? (?:recommend|suggest) (?:that )?you\b|\b(?:it'?s |it is |that'?s |that is )?up to you\b|\bleave (?:it|that|this) (?:to|with) you\b|\bfrom your (?:side|end)\b|\bon your (?:side|end)\b|\bif you(?:'d| would)? (?:like|want|prefer),? (?:you )?(?:can|could)\b|\bhere'?s how you (?:can|could)\b|\bfeel free to (?:do|try|open|copy|paste|run)\b/i],
  ['open-elsewhere', true, /\bopen (?:it|that|this|them|the (?:file|document|doc|page|link|pdf|report|result))\b[^.!?\n]{0,40}\b(?:in|with|using|via) (?:a |your |the |an )?(?:web )?(?:browser|chrome|firefox|edge|safari|word|excel|docs|google docs?|viewer|app|another)\b|\b(?:download|save) (?:it|that|the file)\b[^.!?\n]{0,30}\b(?:and|then) (?:open|upload|send)\b/i],
  // "I can't": a give-up on its own only when that is nearly the whole reply.
  ['cannot', false, /\bI (?:can(?:'|no)t|cannot|am (?:not )?unable to|'m (?:not )?unable to|am not able to|'m not able to|don't (?:have|know) (?:a way|any way|the ability|the tools?|how)|do not (?:have|know) (?:a way|any way|the ability|the tools?|how)|lack the|couldn't|could not|wasn't able to|was not able to)\b|\b(?:isn't|is not|aren't|are not) (?:something|possible|something I can)\b|\b(?:outside|beyond) (?:what|my)\b[^.!?\n]{0,30}\b(?:can|capabilit|tools)/i],
];

// A request for an explanation or instructions: "you can ..." is then the answer, not a handoff.
const INSTRUCTIONAL = /^\s*(?:please\s+)?(?:how (?:do|can|should|would|could|to|does)|what(?:'s| is| are| does| should)|why\b|when\b|where\b|which\b|who\b|explain|tell me|walk me through|teach me|show me how|steps? (?:to|for)|can you (?:explain|tell me|show me how)|is it (?:possible|ok|okay)|should i|do i need|what do i)\b|\bhow (?:do|can|could|should|would) (?:i|you|one|we)\b|\bhow to\b|\bwalk me through\b|\bstep[- ]by[- ]step\b|\binstructions\b/i;

// The reply with what is not the AI's own words taken out: fenced code, quoted lines and inline code (a draft or page text
// that contains "paste" or "I can't" is not the AI giving up).
function bodyOf(reply) {
  return String(reply || '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\*\*|__|^#+\s*/gm, '')
    .trim();
}

// A reply that delivers code, a script, a command or a formula as the answer ends with "run it", "save it as x.m",
// "paste it into your terminal": that is how the answer is used, not the AI handing the work back.
const RUN_VERB = /\b(?:run|runs|running|execute|executing|paste|pasting|save|saving|copy|copying|type|enter|compile|launch|load|import|source|call|use|put|drop|open (?:matlab|octave|python|a terminal|your terminal|the terminal|the command|the editor|an editor|your editor|a shell|powershell|cmd|the console|a console|your ide))\b/i;
const RUN_TARGET = /\b(?:it|this|that|these|those|them|script|code|command|commands|snippet|program|function|macro|query|file|below|above|terminal|command window|command prompt|shell|console|editor|prompt|matlab|octave|python|node|bash|powershell|cmd)\b|\.\w{1,4}\b/i;
const ASK_BACK = /\bhere\b|\bto me\b|\bin (?:the )?chat\b|\bsend me\b|\bshare\b|\bgive me\b|\b(?:text|contents?) of\b/i;
const DELIVERS = /\b(?:here(?:'s| is| are)|below (?:is|are)|this is|i(?:'ve| have)? (?:wrote|written|made|put together|created|prepared|drafted))\b[^.!?\n]{0,60}\b(?:script|code|command|commands|snippet|function|macro|formula|equation|query|program|solution|steps?|instructions)\b/i;

// The reply's text with the "run it / save it as / paste it into your terminal" sentences taken out, when the reply does
// deliver something to use. What is left is judged as before. Returns { text, delivers, codeMain }.
function withoutUsage(raw, body) {
  const src = String(raw || '');
  const code = (src.match(/```[\s\S]*?(?:```|$)/g) || []).join('');
  const hasCode = code.replace(/```\w*/g, '').trim().length >= 3 || /`[^`\n]{3,}`/.test(src);
  const delivers = hasCode || DELIVERS.test(body);
  const codeMain = code.length >= 40 && code.length >= src.trim().length * 0.5;
  if (!delivers) return { text: body, delivers, codeMain };
  const text = body.split(/(?<=[.!?])\s+|\n+/).filter((sent) => !(RUN_VERB.test(sent) && RUN_TARGET.test(sent) && !ASK_BACK.test(sent))).join('\n').trim();
  return { text, delivers, codeMain };
}

const STRONG_WINDOW = 700; // the last stretch of a reply, where the handoff usually is
const SHORT_REPLY = 900; // a reply this short that says "I can't" is a give-up

// reply: the final reply text. request: what the user asked ('' if unknown). Returns
// { handoff: boolean, kind: 'paste'|'access'|'user-step'|'open-elsewhere'|'cannot'|null, legit: string|null }.
// `legit` is set when the reply stops for a reason that needs the user, and then `handoff` is false.
function classify(reply, request = '') {
  const full = bodyOf(reply);
  const used = withoutUsage(reply, full);
  const body = used.text;
  const none = { handoff: false, kind: null, legit: null };
  if (!full || full.length < 12 || !body) return none;
  // The last paragraph is what the user is asked to do; earlier text may be the answer's own substance.
  const tail = body.slice(-STRONG_WINDOW);
  const head = body.slice(0, STRONG_WINDOW);
  const legit = LEGIT.find(([, re]) => re.test(tail) || (body.length < SHORT_REPLY && re.test(body)));
  const instructional = INSTRUCTIONAL.test(String(request || ''));
  const kinds = [];
  for (const [kind, strong, re] of HANDOFF) {
    if (kind === 'user-step' && instructional) continue; // they asked for instructions
    const hit = strong ? re.test(tail) || re.test(head) : (body.length < SHORT_REPLY && re.test(body));
    if (hit) kinds.push([kind, strong]);
  }
  if (legit) return { handoff: false, kind: null, legit: legit[0] };
  // The user's own call: the reply ends on a question that offers a choice or asks what is meant.
  const lastLine = body.split(/\n+/).filter(Boolean).pop() || '';
  if (/\?\s*$/.test(lastLine) && CHOICE.test(lastLine) && !kinds.some(([k]) => k === 'paste' || k === 'access')) return { handoff: false, kind: null, legit: 'choice' };
  if (!kinds.length) return none;
  // A reply that is mostly code is the answer, unless it also says it can't or lacks access.
  if (used.codeMain && !kinds.some(([k]) => k === 'cannot' || k === 'access')) return none;
  // A long reply with only a weak line is an answer with a caveat. A long one with a strong handoff in its tail is not.
  const strong = kinds.find(([, s]) => s);
  if (!strong && kinds.length < 2 && body.length >= SHORT_REPLY) return none;
  const first = strong ? strong[0] : kinds[0][0];
  // A long, substantive answer ending "you can also do X": the strong match must be in the tail and the reply short enough
  // that the handoff is a real part of it (a 3000-character answer with one "you can try" line is the answer).
  if (body.length > 2500 && !['paste', 'access'].includes(first)) return none;
  return { handoff: true, kind: first, legit: null };
}

// The final reply of a run: the last assistant message's text, when it ended without a tool call. '' otherwise.
function finalReply(messages) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (!last || last.role !== 'assistant') return '';
  const blocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content || '') }];
  if (blocks.some((b) => b.type === 'tool_use')) return '';
  return blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n\n').trim();
}

const isRetryText = (text) => String(text || '').includes(RETRY_OPEN);
const withoutRetry = (text) => String(text || '').replace(RETRY_BLOCK, '');

module.exports = { classify, finalReply, bodyOf, isRetryText, withoutRetry, FOLLOWUP, RETRY_OPEN, RETRY_CLOSE, RETRY_BLOCK };
