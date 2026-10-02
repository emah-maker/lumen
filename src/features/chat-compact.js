// /compact and /context: the chat commands main answers itself (agent.js commandTurn), whichever AI the chat uses.
// Pure functions; the agent does the requests.
//  - Claude Code keeps the conversation in its own session: the command goes to the CLI as typed (in stream-json
//    mode a message that is exactly a slash command runs it), with or without full access, since neither grants a
//    tool. Its compact_boundary event says how many tokens the conversation had before and after.
//  - An API model's conversation is Lumen's own array: /compact asks the same model for a summary of everything
//    before the last exchange, and that summary replaces those turns (compactPlan / applySummary). The turns
//    still show in the sidebar (settings.compactedItems), only the model sees the summary instead. Nothing is
//    changed when the summary fails or comes back empty.

const COMMANDS = ['compact', 'context'];
const SUMMARY_TAG = 'earlier_conversation_summary';
const SUMMARY_BLOCK = new RegExp(`^<${SUMMARY_TAG}>[\\s\\S]*?</${SUMMARY_TAG}>\\s*`);
const KEEP_ITEMS = 300; // compacted turns kept for the sidebar's view of the chat
const ITEM_CHARS = 8000;
const SUMMARY_INPUT_CHARS = 200_000; // of the earlier conversation, sent to be summarized (its newest part)
const AUTO_AT = 0.8; // auto-compact once the history passes this share of what a request may carry

// "/compact keep the prices" -> { name: 'compact', args: 'keep the prices' }; anything else -> null.
function chatCommand(text) {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(String(text ?? '').trim());
  if (!m || !COMMANDS.includes(m[1].toLowerCase())) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim().slice(0, 2000) };
}

const blocksOf = (m) => (Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }]);

// Where an exchange starts: a user message with something the user sent (text or an image) and no tool results,
// so cutting the history there leaves no tool call without its result.
function turnStarts(messages) {
  const out = [];
  messages.forEach((m, i) => {
    if (m.role !== 'user') return;
    const blocks = blocksOf(m);
    if (blocks.some((b) => b.type === 'tool_result')) return;
    if (blocks.some((b) => b.type === 'image' || (b.type === 'text' && String(b.text || '').trim()))) out.push(i);
  });
  return out;
}

// What to replace: { cut } (messages before index `cut` are summarized; the last `keep` exchanges stay as they
// are), or null when there is nothing older than them.
function compactPlan(messages, keep = 1) {
  const starts = turnStarts(messages);
  if (starts.length <= keep) return null;
  const cut = starts[starts.length - keep];
  return cut > 0 ? { cut } : null;
}

// The summary block a message carries (an earlier /compact), as a content block, or null.
function summaryBlockOf(message) {
  if (!message || message.role !== 'user') return null;
  return blocksOf(message).find((b) => b.type === 'text' && SUMMARY_BLOCK.test(String(b.text || ''))) || null;
}
// The text of the chat's current summary, or ''.
function summaryOf(messages) {
  const block = summaryBlockOf(messages?.[0]);
  if (!block) return '';
  return String(block.text).replace(new RegExp(`^<${SUMMARY_TAG}>\\s*`), '').replace(new RegExp(`\\s*</${SUMMARY_TAG}>[\\s\\S]*$`), '');
}

// The request that asks for the summary. `items`: transcriptFor() of the turns being replaced; `prior`: the summary
// those turns already started with; `instructions`: what the user typed after /compact.
function summaryRequest({ items, prior = '', instructions = '' }) {
  const lines = items.map((it) => `${it.role === 'user' ? 'User' : 'Assistant'}: ${String(it.text || '').trim() || (it.images?.length ? '(sent an image)' : '')}`).filter((l) => !/:\s*$/.test(l));
  let body = lines.join('\n\n');
  if (body.length > SUMMARY_INPUT_CHARS) body = `(the oldest part is left out)\n\n${body.slice(-SUMMARY_INPUT_CHARS)}`;
  return [
    'Summarize the conversation below so that it can replace it: you will continue the chat with only this summary and the latest messages in view.',
    'Keep what matters for going on: what the user wants and has decided, facts, numbers, names, links and pages found, what was done in the browser (tabs, forms, sites) and what is still open. Leave out pleasantries. Use short bullet points under a few headings, at most about 400 words. Write only the summary, no preamble. Do not use any tools.',
    instructions ? `The user asked that the summary focus on: ${instructions}` : '',
    prior ? `<summary_so_far>\n${prior}\n</summary_so_far>` : '',
    `<conversation>\n${body}\n</conversation>`,
  ].filter(Boolean).join('\n\n');
}

// Replaces messages[0, cut) with `summary`, in place: it goes first in the message that now starts the chat. The
// replaced turns' transcript joins settings.compactedItems (text only), so the sidebar still shows them.
function applySummary(messages, cut, summary, items = []) {
  const text = String(summary || '').trim();
  if (!text || !(cut > 0) || cut >= messages.length) return false;
  messages.splice(0, cut);
  const first = messages[0];
  const rest = blocksOf(first).filter((b) => !summaryBlockOf({ role: 'user', content: [b] }));
  first.content = [{ type: 'text', text: `<${SUMMARY_TAG}>\n${text}\n</${SUMMARY_TAG}>\n\n` }, ...rest];
  const settings = messages.settings;
  if (settings) {
    const kept = items.map((it) => ({ role: it.role, text: String(it.text || '').slice(0, ITEM_CHARS), images: [], ...(it.steps ? { steps: it.steps } : {}) }));
    settings.compactedItems = [...(Array.isArray(settings.compactedItems) ? settings.compactedItems : []), ...kept].slice(-KEEP_ITEMS);
    settings.compactions = (settings.compactions || 0) + 1;
  }
  return true;
}

// A rough token count for text Lumen built itself (a summary): about 4 characters per token.
const estimateTokens = (chars) => Math.ceil(Math.max(0, chars) / 4);

// Whether an API chat should compact before its next request: its history is near what one request may carry
// (agent.js contextBudget, in characters), where the oldest turns would otherwise be left out.
const shouldAutoCompact = (historyChars, budgetChars) => budgetChars > 0 && historyChars > budgetChars * AUTO_AT;

module.exports = { COMMANDS, SUMMARY_TAG, SUMMARY_BLOCK, AUTO_AT, chatCommand, turnStarts, compactPlan, summaryBlockOf, summaryOf, summaryRequest, applySummary, estimateTokens, shouldAutoCompact };
