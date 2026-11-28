// [humanize] Runs the user's own humanizer skill on a piece of text: the page's right-click "Humanize" (features/humanize-page.js), the
// "Humanize" action under a reply and /humanize in the chat box (renderer/humanize.js). This file holds no writing rules: the
// instructions are the skill's own, as Lumen's skills code hands them over (features/skills.js humanizer -> forAI). What is here is
// the run around them: where the text goes, which model, reading the answer back, and checking that nothing it must keep was lost.
//
// Which model rewrites (plan): the chat's own AI. An API model: its cheaper sibling (subagents.helperModel; Settings → AI → helpers
// "same model" keeps the chat's model), the chat's own model if that one is refused. An engine with a one-shot runner (Claude Code,
// Grok Build, Antigravity): that engine's CLI, with no tools, no MCP servers and an empty folder (ai/cli-json.js); Claude Code on
// Haiku. Codex (no one-shot runner): the API model /btw would use (its vendor's key, else the default model). No API model at all:
// the user's own Claude Code when it is installed and signed in. The text goes nowhere else.
// Electron-free (the skill and the model calls are injected): test/units/humanize-units.js.
const { helperModel } = require('./subagents');
const btw = require('./btw');
const fallback = require('./fallback');
const autoModel = require('./auto-model');

const MAX_CHARS = 12000; // what one rewrite takes (a long email or a page of a document); more is refused, not cut
const MAX_TOKENS = 4096;
const TIME_MS = 60000; // API call
const CLI_TIME_MS = 120000; // a CLI starts a process and sends nothing until it is done
const CLI_ENGINES = ['claudecode', 'grokbuild', 'antigravity'];

// Where the text came from, so the skill picks the right mode and the answer fits back where it goes.
const WHERE = {
  selection: 'The text was selected on a web page or in a text box (an email, a document, a form) and may be put back in that box: keep its line breaks and add no Markdown it did not have.',
  reply: 'The text is a reply an AI assistant wrote in a chat: keep its Markdown (lists, code, tables, links).',
  paste: 'The text was pasted by the user, who wants it to sound like they wrote it.',
};

// The system prompt: the skill's block (skills.js forAI), then how this run returns its answer (the skill's embedded mode).
function buildSystem({ skillText, kind = 'selection' }) {
  return `${String(skillText || '').trim()}

This run is the skill in embedded mode, inside the Lumen browser's Humanize: you have no tools and no files. ${WHERE[kind] || WHERE.selection}
Reply with only the final text inside <rewrite></rewrite>: no first draft, no list of tells, no notes.`;
}

// The user message: the text in its own tag (it is material to edit, never instructions).
function buildMessages({ text }) {
  return [{ role: 'user', content: `<text_to_rewrite>\n${String(text ?? '')}\n</text_to_rewrite>\n\nHumanize the text above. Reply with only <rewrite>…</rewrite>.` }];
}

// The rewrite in a model's answer: the inside of <rewrite> (the last one: a skill that shows a first draft may use the tag twice), else
// the whole answer without a lead-in line or a code fence around it.
function parseReply(raw) {
  let text = String(raw ?? '').replace(/\r\n/g, '\n');
  const tagged = [...text.matchAll(/<rewrite>\n?([\s\S]*?)\n?<\/rewrite>/gi)].pop();
  if (tagged) return tagged[1].replace(/^\n+|\s+$/g, '');
  const open = /<rewrite>\n?([\s\S]*)$/i.exec(text); // cut off before the closing tag (the token limit)
  if (open) return open[1].replace(/^\n+|\s+$/g, '');
  text = text.trim();
  text = text.replace(/^(?:(?:sure|certainly|of course|okay|ok)[,!.]?\s*)?(?:here(?:'s| is)|below is)[^\n]{0,80}(?:rewrite|rewritten|version|revision|text)[^\n]*:\s*\n+/i, '');
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1];
  return text.trim();
}

// What a rewrite must keep, found in the original: links, inline code and code blocks, numbers (with their unit signs), @mentions
// and {placeholders}. -> the ones the rewrite no longer has (each at most once), so the card can say what to check.
function missingFacts(original, rewrite) {
  const src = String(original ?? '');
  const out = String(rewrite ?? '');
  const items = new Set();
  for (const m of src.matchAll(/```[\s\S]*?```/g)) items.add(m[0].trim());
  const noBlocks = src.replace(/```[\s\S]*?```/g, ' ');
  for (const m of noBlocks.matchAll(/https?:\/\/[^\s<>()"'\]]+[^\s<>()"'\].,;:!?]/gi)) items.add(m[0]);
  for (const m of noBlocks.matchAll(/`[^`\n]+`/g)) items.add(m[0]);
  for (const m of noBlocks.matchAll(/(?<![\w@])@[A-Za-z0-9_][\w.-]*\w|\{[A-Za-z_][\w ]{0,30}\}|\[[A-Z][\w ]{0,30}\]/g)) items.add(m[0]);
  const plainSrc = noBlocks.replace(/https?:\/\/\S+/gi, ' ').replace(/`[^`\n]+`/g, ' ');
  for (const m of plainSrc.matchAll(/[$€£¥]?\d[\d,]*(?:\.\d+)?%?/g)) items.add(m[0].replace(/[.,]+$/, ''));
  const flat = (s) => s.replace(/\s+/g, ' ');
  const hay = flat(out);
  const plainOut = out.replace(/,(?=\d{3}\b)/g, ''); // 12,000 and 12000 are the same number
  return [...items].filter((item) => {
    if (hay.includes(flat(item))) return false;
    if (/^[$€£¥]?\d/.test(item) && plainOut.includes(item.replace(/,(?=\d{3}\b)/g, ''))) return false;
    return true;
  });
}

// "/humanize <text>", "humanize this: <text>" or "humanize this" with the text on the next lines -> the text; '' for the command alone
// (the chat then humanizes the last reply); null for any other message. renderer/chat-commands.js HUMANIZE_PHRASE matches the same.
function parseCommand(input) {
  const s = String(input ?? '');
  const m = /^\s*(?:\/humanize\b|humani[sz]e (?:this|the following)\b)[ \t]*:?[ \t]*(?:\r?\n)?([\s\S]*)$/i.exec(s);
  return m ? m[1].trim() : null;
}

// Which model rewrites. chatModel: the chat's concrete model id ('auto' resolved by the caller); options: the connected models
// (main.js modelOptions()); defaultModel: the user's default; mode: 'auto' (the cheaper sibling) or 'same'; local: Claude Code is
// installed and signed in. -> { kind: 'api', model, own } | { kind: 'cli', engine, model, own } | null.
function plan({ chatModel, defaultModel = '', options = [], mode = 'auto', local = false }) {
  const chat = [chatModel, defaultModel].map((m) => String(m || '')).find((m) => m && !autoModel.isAuto(m)) || '';
  if (chat && !fallback.isEngine(chat)) return { kind: 'api', model: helperModel(chat, mode), own: chat };
  const engine = chat ? chat.split(':')[0] : '';
  if (CLI_ENGINES.includes(engine)) {
    const own = chat.split(':').slice(1).join(':') || 'default';
    const model = engine === 'claudecode' && mode !== 'same' ? 'haiku' : own === 'auto' ? 'default' : own;
    return { kind: 'cli', engine, model, own: own === 'auto' ? 'default' : own };
  }
  const picked = btw.plan({ chatModel: chat, defaultModel, options, mode, local }); // Codex, or no chat model: an API model, else Claude Code
  if (!picked) return null;
  if (picked.local) return { kind: 'cli', engine: 'claudecode', model: 'haiku', own: 'haiku' };
  return { kind: 'api', model: picked.model, own: picked.own };
}

const refusedModel = (err) => err?.status === 404 || err?.status === 400 || err?.status === 403 || /model/i.test(String(err?.message));

// One rewrite. skill: features/skills.js humanizer()'s answer ({ text } or { error: 'missing' | 'skills-off' }). `api(model, { system,
// messages, signal, maxTokens })` -> an Anthropic-shaped message; `cli({ engine, model, system, user, signal, timeoutMs })` -> the
// answer's text. Never throws: { ok, text, model, kind, engine?, missing, unchanged, error? }.
async function run({ text, kind = 'selection', skill, chatModel, defaultModel, options, mode = 'auto', local = false, api, cli, onUsage = () => {}, signal, timeMs }) {
  const input = String(text ?? '').replace(/\r\n/g, '\n');
  if (!input.trim()) return { ok: false, error: 'empty', text: '' };
  if (!skill?.text) return { ok: false, error: skill?.error === 'skills-off' ? 'skills-off' : 'no-skill', text: '' };
  if (input.length > MAX_CHARS) return { ok: false, error: 'too-long', text: '', max: MAX_CHARS };
  const picked = plan({ chatModel, defaultModel, options, mode, local });
  if (!picked) return { ok: false, error: 'no-provider', text: '' };
  if (signal?.aborted) return { ok: false, error: 'stopped', text: '', ...picked };
  const system = buildSystem({ skillText: skill.text, kind });
  const messages = buildMessages({ text: input });
  const ctrl = new AbortController();
  const outer = () => ctrl.abort();
  signal?.addEventListener('abort', outer, { once: true });
  let timedOut = false;
  const limit = timeMs ?? (picked.kind === 'cli' ? CLI_TIME_MS : TIME_MS);
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, limit);
  let used = picked.model;
  try {
    let said;
    if (picked.kind === 'cli') {
      const ask = (model) => cli({ engine: picked.engine, model, system, user: messages[0].content, signal: ctrl.signal, timeoutMs: limit });
      try { said = await ask(used); } catch (err) { // Haiku not on this plan: the chat's own Claude Code model, once
        if (used === picked.own || ctrl.signal.aborted || /not signed in|usage limit|isn.t installed/i.test(String(err?.message))) throw err;
        used = picked.own;
        said = await ask(used);
      }
    } else {
      const ask = (model) => api(model, { system, messages, signal: ctrl.signal, maxTokens: MAX_TOKENS });
      let message;
      try { message = await ask(used); } catch (err) { // the cheaper model is not on this key: the chat's own, once
        if (used === picked.own || ctrl.signal.aborted || !refusedModel(err)) throw err;
        used = picked.own;
        message = await ask(used);
      }
      try { onUsage(message, used); } catch { /* accounting never fails the rewrite */ }
      said = (Array.isArray(message?.content) ? message.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
    }
    const out = parseReply(said);
    if (!out) return { ok: false, error: 'no-answer', text: '', kind: picked.kind, engine: picked.engine, model: used };
    return { ok: true, text: out, kind: picked.kind, engine: picked.engine, model: used, missing: missingFacts(input, out), unchanged: out.trim() === input.trim() };
  } catch (err) {
    if (timedOut) return { ok: false, error: 'timeout', text: '', kind: picked.kind, model: used };
    if (signal?.aborted) return { ok: false, error: 'stopped', text: '', kind: picked.kind, model: used };
    return { ok: false, error: String(err?.message || err).split('\n')[0].slice(0, 300), text: '', kind: picked.kind, model: used };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', outer);
  }
}

// The CLI's JSON shape for the engines that answer in JSON (Grok Build, Antigravity: cli-json.js completeJSON).
const CLI_SCHEMA = { type: 'object', properties: { rewrite: { type: 'string' } }, required: ['rewrite'], additionalProperties: false };

module.exports = { MAX_CHARS, MAX_TOKENS, TIME_MS, CLI_TIME_MS, CLI_ENGINES, CLI_SCHEMA, WHERE, buildSystem, buildMessages, parseReply, missingFacts, parseCommand, plan, run };
