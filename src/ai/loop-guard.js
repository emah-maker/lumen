// Pure helpers for the agent's tool loop (no Electron, unit-tested in test/units.js):
// - RepeatDetector: notices a model repeating the same failing (or pointless) action and returns a
//   note that tells it to change strategy. The note is appended to the tool result, nothing is blocked.
// - withNote: appends a text note to a tool result (string or content blocks).
// - trimToolResults: shortens old tool results for providers without server-side context editing.
// - cacheLastTool: puts the prompt-cache breakpoint on the last tool definition.

// Repeating these is normal (paging, waiting, re-reading), so only failures count for them.
const BENIGN = new Set(['scroll', 'press_key', 'wait', 'wait_for', 'screenshot', 'read_page', 'find', 'list_tabs', 'hover']);

// Reads whose identical repeat (same input, nothing done in between) can only return the same thing.
const STATIC_READS = new Set(['read_page', 'find', 'list_tabs', 'read_tabs', 'web_search', 'read_urls', 'read_pdf', 'analyze_posts']);

class RepeatDetector {
  constructor(limit = 8) {
    this.limit = limit;
    this.calls = [];
    this.stalled = false; // sticky: the strongest escalation was reached, so the run should wrap up
  }

  reset() { this.calls = []; this.stalled = false; }

  // Records a finished call; returns a note for the model, or null.
  record(name, input, ok) {
    let sig;
    try { sig = `${name}:${JSON.stringify(input ?? {})}`; } catch { sig = name; }
    this.calls.push({ name, sig, ok });
    if (this.calls.length > this.limit) this.calls.shift();
    let same = 0;
    for (let i = this.calls.length - 1; i >= 0 && this.calls[i].sig === sig && this.calls[i].ok === ok; i--) same++;
    let failStreak = 0;
    for (let i = this.calls.length - 1; i >= 0 && !this.calls[i].ok; i--) failStreak++;
    // Strongest tier: a note has not helped, so the loop ends the run with a final answer (see RunBudget).
    if ((!ok && (same >= 5 || failStreak >= 6)) || (ok && !BENIGN.has(name) && same >= 6)) this.stalled = true;
    const fix = 'Do something different: call read_page mode:"compact" for fresh refs, try click with the visible text, go straight to a URL with navigate, or use find. Reach for run_script only if no other tool can do it.';
    if (!ok && same >= 3) return `REPEAT: this exact call has failed ${same} times in a row. Retrying it will not help. ${fix} If nothing works, stop and tell the user what is blocking you.`;
    if (!ok && same === 2) return `NOTE: this exact call just failed twice. Re-read the page before trying again; ids and the page may have changed.`;
    if (!ok && failStreak >= 4) return `REPEAT: ${failStreak} tool calls in a row have failed. Stop varying the same approach. ${fix} If it is still failing, stop and tell the user.`;
    if (ok && STATIC_READS.has(name) && same >= 3) return `NOTE: you have made this same ${name} call ${same} times with the same input and nothing has changed. Use what you already have, act on it, or try something different.`;
    if (ok && !BENIGN.has(name) && same >= 3) return `REPEAT: you have made this same call ${same} times with the same input. It is not making progress. ${fix} If the task is already done, stop and answer.`;
    return null;
  }
}

// Per-run limits, pure so the agent loop stays small. The loop asks it three things: what note (if
// any) goes on the results of step N, whether step N is the last one (answer in text, tools off), and
// what to say about run_script. Nothing here blocks a tool; it only advises and picks the wrap-up turn.
const SAFETY_CEILING = 1000; // "Unlimited" still ends, gracefully, here
const STEP_CHOICES = [30, 60, 120, 250]; // Settings > You and AI > Max steps per task; 0 = Unlimited
// The saved setting -> a step limit: a positive whole number, or 0 for unlimited (also for anything unreadable).
const stepLimit = (v) => (Number.isInteger(v) && v > 0 ? Math.min(v, SAFETY_CEILING) : 0);
const SCRIPT_FREE = 2; // run_script calls per run before each further one carries a "use a dedicated tool" note

class RunBudget {
  // limit: the user's Max steps setting (0/unset: unlimited, ended only by the safety ceiling).
  constructor({ limit = 0, scriptFree = SCRIPT_FREE, warnAt = 0.75 } = {}) {
    this.finite = stepLimit(limit) > 0;
    this.max = this.finite ? stepLimit(limit) : SAFETY_CEILING;
    this.scriptFree = scriptFree;
    this.warnStep = Math.ceil(this.max * warnAt);
    this.scripts = 0;
    this.toolCalls = 0;
    this.warned = false;
  }

  // Step (0-based) is the last model turn of the run: it must answer in text.
  isFinal(step) { return step >= this.max - 1; }

  countCall(name) { this.toolCalls++; if (name === 'run_script') this.scripts++; }

  // Note for a run_script result once the free calls are used up (null before that). Never blocks.
  scriptNote() {
    if (this.scripts <= this.scriptFree) return null;
    return `NOTE: that is run_script call ${this.scripts} in this task. Scripts are a last resort: use read_page (extract:"tables"|"links"|"lists" pulls data as JSON), find, click, type_text, navigate, read_urls, web_search or batch for anything they can do. Use another script only if nothing else can, and then do it in one call.`;
  }

  // Note for the tool results that follow step `step`, or null. Starts at ~75% of the ceiling, then
  // every step in the last few, and says so plainly on the step before the tool-free final turn.
  stepNote(step) {
    const left = this.max - (step + 1); // turns remaining after this one
    if (left <= 0) return null;
    if (!this.finite) return left === 1 ? 'FINAL STEP NEXT: tools will be turned off, so you must answer in text. Say what is done and what remains.' : null; // no countdown without a chosen limit
    if (left === 1) return 'FINAL STEP NEXT: tools will be turned off, so you must answer in text. Say what is done and what remains.';
    if (step + 1 >= this.warnStep && (!this.warned || left <= 5)) {
      this.warned = true;
      return `NOTE: ${left} steps left in this task. Finish it now, or summarize what is done and what remains.`;
    }
    return null;
  }
}

// Text appended to the last message when the run must end in a plain answer.
const WRAP_UP = {
  limit: 'STEP LIMIT REACHED. Do not call any more tools. In plain text, tell the user what you finished, what you found, and what still remains, so they can say "continue".',
  stalled: 'You keep hitting the same problem and more tool calls will not fix it. Do not call any more tools. In plain text, tell the user what you did, exactly what is blocking you, and what they could try.',
};
const LIMIT_NOTICE = 'Reached the step limit. Say "continue" to pick up where it left off.';
const STALL_NOTICE = 'Stopped retrying a step that kept failing. Say "continue" to try again, or tell me another way.';

// Did a CLI engine (Claude Code or Grok Build) end its run at the turn cap? Their result line says so
// as subtype error_max_turns (or stop_reason max_turns) rather than success, sometimes with is_error
// unset, so the caller must check this before treating a non-success result as a failure.
function turnLimitHit(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.subtype === 'error_max_turns' || /^max[_-]?turns/i.test(String(result.stop_reason || ''))) return true;
  const said = `${(result.errors || []).join(' ')} ${typeof result.result === 'string' ? result.result : ''}`;
  return result.subtype !== 'success' && /max(imum)?( number of)?[ _-]?turns|turn limit/i.test(said);
}

function withNote(content, note) {
  if (!note) return content;
  if (Array.isArray(content)) return [...content, { type: 'text', text: note }];
  if (typeof content !== 'string') return content;
  return `${content}\n\n${note}`;
}

// Returns messages where tool results older than the newest `keep` tool-result messages are cut to
// `maxChars` (images dropped). Never mutates the input. Only for providers that lack server-side
// context editing: for Anthropic the clear_tool_uses edit does this, and editing old turns by hand
// would break the prompt cache.
function trimToolResults(messages, { keep = 4, maxChars = 1500 } = {}) {
  const hasResult = (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
  const indexes = messages.map((m, i) => (hasResult(m) ? i : -1)).filter((i) => i >= 0);
  const old = new Set(indexes.slice(0, Math.max(0, indexes.length - keep)));
  if (!old.size) return messages;
  const cut = (text) => (text.length > maxChars ? `${text.slice(0, maxChars)}\n[older result trimmed: ${text.length} chars]` : text);
  return messages.map((m, i) => {
    if (!old.has(i)) return m;
    return {
      ...m,
      content: m.content.map((b) => {
        if (b.type !== 'tool_result') return b;
        if (typeof b.content === 'string') return { ...b, content: cut(b.content) };
        if (!Array.isArray(b.content)) return b;
        const parts = b.content.map((p) => (p.type === 'image' ? { type: 'text', text: '[earlier screenshot omitted]' } : p.type === 'text' ? { ...p, text: cut(p.text) } : p));
        return { ...b, content: parts };
      }),
    };
  });
}

// One breakpoint on the last tool: the (large, stable) tool list is cached on its own, whatever the
// system prompt or the moving message tail do. Returns a new array; clears any earlier marker.
function cacheLastTool(tools) {
  if (!tools.length) return tools;
  return tools.map((t, i) => {
    const { cache_control, ...rest } = t;
    return i === tools.length - 1 ? { ...rest, cache_control: { type: 'ephemeral' } } : rest;
  });
}

// Read-only tools that may run side by side when the model asks for several in one turn. Nothing
// here acts on a page, navigates the task's tab, or runs code (read_page since_last keeps a diff
// baseline, so it stays sequential).
const PARALLEL_READS = new Set(['read_page', 'find', 'read_urls', 'read_tabs', 'web_search', 'read_pdf', 'screenshot', 'list_tabs', 'analyze_posts']);
const isParallelRead = (use) => PARALLEL_READS.has(use.name) && !(use.name === 'read_page' && use.input && use.input.since_last);

// Runs a turn's tool calls. Every call is gated (`gate`, may throw) one at a time, in order, before
// it runs; a run of consecutive parallel-safe calls is gated first and then executed together, and
// anything else waits for the calls before it. `exec` runs an approved call. Returns one outcome
// per call, in call order: { ok, value } | { ok: false, error, gated } | { skipped: true }.
// `halts(outcome)` (e.g. the user stopped, the tab closed) skips every call after that outcome.
// `onOutcome` fires as each call finishes (for live progress).
async function runToolUses(uses, { isParallel = isParallelRead, gate, exec, halts = () => false, onOutcome = () => {} }) {
  const outcomes = new Array(uses.length);
  let group = [];
  let halted = false;
  const settle = (i, outcome) => { outcomes[i] = outcome; onOutcome(uses[i], outcome, i); };
  const flush = async () => {
    const indexes = group;
    group = [];
    await Promise.all(indexes.map((i) => Promise.resolve().then(() => exec(uses[i], i)).then((value) => { settle(i, { ok: true, value }); }, (error) => { settle(i, { ok: false, error }); })));
    if (indexes.some((i) => halts(outcomes[i]))) halted = true;
  };
  for (let i = 0; i < uses.length; i++) {
    const parallel = isParallel(uses[i]);
    if (!parallel || halted) await flush();
    if (halted) { settle(i, { skipped: true }); continue; }
    try {
      await gate(uses[i], i);
    } catch (error) {
      settle(i, { ok: false, error, gated: true });
      if (halts(outcomes[i])) halted = true;
      continue;
    }
    group.push(i);
    if (!parallel) await flush();
  }
  await flush();
  return outcomes;
}

// Identical read-only calls: the same call again, with nothing done in between, can only return what the
// model already has. The first run is remembered (as a promise, so two identical calls in one turn share
// one run); a repeat gets one line back instead of the whole result. "Nothing done in between" is any
// tool that is not a read, a different task-tab URL, or more than CACHE_FRESH calls since (the API clears
// older tool results, and a model that can no longer see the first one must get it again). Errors are
// never cached. Pure: `run` does the call, `ctx` is the task tab's address.
const CACHEABLE = new Set(['find', 'list_tabs', 'read_tabs', 'web_search', 'read_urls', 'read_pdf', 'analyze_posts']);
const CACHE_FRESH = 6;
class ToolCallCache {
  constructor(fresh = CACHE_FRESH) { this.fresh = fresh; this.entries = new Map(); this.seq = 0; this.hits = 0; this.turn = 0; }
  clear() { this.entries.clear(); }
  nextTurn() { this.turn++; } // the model's next reply: a repeat after this is "earlier", not "this turn"
  keyOf(use, ctx) {
    if (!CACHEABLE.has(use.name) || (use.name === 'read_urls' && use.input && use.input.as_user)) return null;
    try { return `${use.name}|${ctx || ''}|${JSON.stringify(use.input ?? {})}`; } catch { return null; }
  }
  async run(use, ctx, run) {
    this.seq++;
    if (!CACHEABLE.has(use.name)) { if (!PARALLEL_READS.has(use.name)) this.clear(); return run(); } // an acting tool: whatever was read may be stale
    const key = this.keyOf(use, ctx);
    if (!key) return run();
    const hit = this.entries.get(key);
    if (hit && this.seq - hit.seq <= this.fresh) {
      this.hits++;
      const ago = this.seq - hit.seq;
      await hit.promise.catch(() => {});
      return ago <= 2 && hit.turn === this.turn ? 'Same call as another one in this turn: see that result.' : `Same as your earlier ${use.name} call (${ago} call${ago === 1 ? '' : 's'} ago): same input and nothing has changed since, so nothing new to show. Use that result.`;
    }
    const promise = Promise.resolve().then(run);
    const entry = { seq: this.seq, promise, turn: this.turn };
    this.entries.set(key, entry);
    promise.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return promise;
  }
}

// Page text the sidebar attached to earlier messages (<untrusted_page_content …>…</untrusted_page_content>)
// is kept whole in every later request, and for a long task it is most of what is re-sent. Once the chat
// is past the context-management trigger (60k tokens) the old ones are cut to their title and address;
// the page itself is a read_page away, and the newest user message keeps its page. Returns the same array
// when nothing changes, otherwise new message objects; never mutates. Called only once the trigger has
// fired (and then on every request, so the cached prefix stays the same from then on).
const PAGE_OPEN = /<untrusted_page_content([^>]*)>[\s\S]*?<\/untrusted_page_content>\s*/g;
function stubOldPages(messages, upTo = Infinity) {
  const isTyped = (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  const newest = Math.min(messages.findLastIndex(isTyped), upTo);
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= newest || m.role !== 'user' || !Array.isArray(m.content)) return m;
    let touched = false;
    const content = m.content.map((b) => {
      if (b?.type !== 'text' || typeof b.text !== 'string' || !b.text.includes('<untrusted_page_content')) return b;
      const text = b.text.replace(PAGE_OPEN, (_, attrs) => `<untrusted_page_content${attrs}>\n(Page text left out of this earlier message; call read_page for the page.)\n</untrusted_page_content>\n\n`);
      if (text === b.text) return b;
      touched = true;
      return { ...b, text };
    });
    if (!touched) return m;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : messages;
}
// Stubbing an old message changes the request from that message on, so it is done in batches (messages.pageStubUpTo
// moves up only once `batch` page-bearing user messages have piled up behind the newest one), not on every user turn.
function advancePageStub(messages, batch = 2) {
  const isTyped = (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  const hasPage = (m) => Array.isArray(m.content) && m.content.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes('<untrusted_page_content') && !b.text.includes('(Page text left out'));
  const newest = messages.findLastIndex(isTyped);
  let piled = 0;
  for (let i = messages.pageStubUpTo || 0; i < newest; i++) if (isTyped(messages[i]) && hasPage(messages[i])) piled++;
  if (piled >= batch) messages.pageStubUpTo = newest;
  return messages.pageStubUpTo || 0;
}
const CONTEXT_TRIGGER_TOKENS = 60000; // the same number requestFor gives the API's clear_tool_uses edit

// A plain question that needs neither the page nor a tool: short, text only, no link, and none of
// the words people use when they mean the page or an action. Conservative: when unsure, false.
const NEEDS_BROWSER = /\b(this|these|that|page|tab|tabs|site|website|here|above|below|screen|click|open|go to|navigate|search|google|find|look up|fill|book|buy|order|add to|sign|log ?in|download|summari[sz]e|summary|tl;?dr|read|scroll|type|select|compare|check|screenshot|form|link|cart|price|video|article|pdf|current|latest|today|now)\b|https?:|www\.|\.(com|org|net|io|dev)\b/i;
function isSimpleQuestion(text, imageCount = 0) {
  const t = String(text || '').trim();
  return imageCount === 0 && t.length > 0 && t.length <= 160 && !NEEDS_BROWSER.test(t);
}

// Pictures in a chat ride along in every later request (an API model is sent the whole history each time, and a picture is
// the heaviest part of it: megabytes of base64 to upload and read again). Only the newest `keep` typed messages and what
// follows them keep their pictures (the user's attachments and the screenshots the AI took); older ones become a short note.
// The cut moves only when a new typed message arrives, so the prefix is stable within a turn and the provider's cache holds.
const OLD_IMAGE_NOTE = '[earlier picture left out to keep the request fast; ask the user to attach it again if it matters]';
function stubOldImages(messages, keep = 2) {
  const isTyped = (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'));
  let seen = 0;
  let cut = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTyped(messages[i]) && ++seen === keep) { cut = i; break; }
  }
  if (cut <= 0) return messages;
  const swap = (b) => (b?.type === 'image' ? { type: 'text', text: OLD_IMAGE_NOTE } : b?.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c) => c?.type === 'image') ? { ...b, content: b.content.map(swap) } : b);
  const holds = (m) => Array.isArray(m.content) && m.content.some((b) => b?.type === 'image' || (b?.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c) => c?.type === 'image')));
  if (!messages.slice(0, cut).some(holds)) return messages;
  return messages.map((m, i) => (i < cut && m.role === 'user' && holds(m) ? { ...m, content: m.content.map(swap) } : m));
}

// A question about the pictures the user attached ("what's in this picture?", "read the total"): it needs neither the page's
// text nor a tool, so the page is not read first (that read waits up to 4 s on a heavy or loading page). Words that mean the
// page or an action still make it a browser question; "this", "screen" and "read" point at the picture here.
const NEEDS_BROWSER_PICTURE = /\b(page|tab|tabs|site|website|click|open|go to|navigate|search|google|find|look up|fill|book|buy|order|add to|sign|log ?in|download|scroll|type|select|form|link|cart|video|article|pdf|take (a |another )?screenshot|my screen|current tab)\b|https?:|www\.|\.(com|org|net|io|dev)\b/i;
function isPictureQuestion(text, imageCount = 0) {
  const t = String(text || '').trim();
  return imageCount > 0 && t.length <= 240 && !NEEDS_BROWSER_PICTURE.test(t);
}

module.exports = { isPictureQuestion, stubOldImages, OLD_IMAGE_NOTE, RunBudget, SAFETY_CEILING, STEP_CHOICES, stepLimit, WRAP_UP, LIMIT_NOTICE, STALL_NOTICE, turnLimitHit, isSimpleQuestion, RepeatDetector, ToolCallCache, CACHEABLE, stubOldPages, advancePageStub, CONTEXT_TRIGGER_TOKENS, withNote, trimToolResults, cacheLastTool, BENIGN, PARALLEL_READS, isParallelRead, runToolUses };
