// Auto model routing: when a local CLI engine runs with no model picked ('claudecode:default'), choose
// the model per message from how hard the task looks. Pure and cheap (no extra model call): a score
// from the prompt text and what is attached, bucketed into light / standard / heavy, then looked up
// in TABLE. A model the user picked (anything but 'default') is never touched, and neither is an
// engine with no row in TABLE (Grok Build: its model ids come from `grok models`, so no fixed tiers).
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
const ACK = /^\s*(?:continue|go on|keep going|carry on|yes|yeah|yep|y|ok|okay|sure|do it|fix it|try again|retry|proceed|go ahead|next|more|and\??|then\??|please|thanks?|sounds good|that works|again)[\s.!?]*$/i;

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

const tierOf = (s) => (s <= -2 ? 'light' : s >= 5 ? 'heavy' : 'standard');

// Tier for this message given the conversation so far. `previous` is { tier, turns } from the last
// routed turn. A short follow-up ("continue", "fix it", "yes") never drops below the previous turn's
// tier, so a hard task isn't handed to a smaller model halfway through; a real change of subject
// (a long or heavier message) is scored on its own.
// pinned: the message continues a CLI session routed before (Claude Code --resume). The tier then
// never goes down, whatever the message: another model mid-session starts its prompt cache from
// scratch. It can still go up for a harder message. A new session is scored on its own again.
function tierFor(prompt, { imageCount = 0, tabCount = 0, previous = null, pinned = false } = {}) {
  const s = score(prompt, { imageCount, tabCount });
  let tier = tierOf(s);
  const t = String(prompt || '').trim();
  const prev = previous && TIERS.includes(previous.tier) && previous.turns > 0 ? previous.tier : null;
  const followUp = Boolean(prev) && (ACK.test(t) || (t.length <= 40 && !imageCount && !count(t, LIGHT_WORDS)));
  if ((followUp || (pinned && prev)) && TIERS.indexOf(prev) > TIERS.indexOf(tier)) tier = prev;
  return { tier, score: s, followUp };
}

// The engine's model for a tier, or null when the engine has no tiers.
const modelForTier = (engine, tier) => TABLE[engine]?.[tier] || null;

const labelFor = (model) => `Auto · ${NAMES[model] || model}`;

// The one call. `picked` is the model part of the picker id ('default' when none was chosen).
// Returns { model, auto, tier?, score?, label? }: model is what to pass on (the picked one unless auto-routed).
function route({ engine, picked = 'default', prompt, imageCount = 0, tabCount = 0, previous = null, pinned = false, enabled = true } = {}) {
  if (!enabled || (picked && picked !== 'default') || !TABLE[engine]) return { model: picked || 'default', auto: false };
  const { tier, score: s, followUp } = tierFor(prompt, { imageCount, tabCount, previous, pinned });
  const model = modelForTier(engine, tier);
  return { model, auto: true, tier, score: s, followUp, label: labelFor(model) };
}

module.exports = { TIERS, TABLE, score, tierOf, tierFor, modelForTier, labelFor, route };
