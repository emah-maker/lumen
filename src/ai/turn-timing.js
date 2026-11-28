// [turn timing] LUMEN_TURN_TIMING=1 prints where a sidebar task's time goes, next to LUMEN_TOOL_TIMING's per-tool lines:
//   [lumen] turn anthropic claude-opus-5-5 #2: prep 3 ms · first byte 410 ms · first token 620 ms · tool call 1840 ms · end 1900 ms · in 812 (cache read 5100, write 230) out 96 · 24.9k chars
// one line per model request on the API engines (agent.js claudeTurn, providers.js streamTurnOnce): "prep" is Lumen's own time
// between the last tool's end and the request going out, "first byte" the first stream event, "first token" the first text or
// thinking, "tool call" the first tool call's start, "end" the whole response. The CLI engines (Claude Code, Codex, Grok Build,
// Antigravity) run their own model loop, so their rounds are read from the events they send the chat (taskTimer):
//   [lumen] turn claudecode round 2: model 1320 ms · tools 240 ms
// and every task ends with one summary line:
//   [lumen] task anthropic:claude-opus-5-5: 4 model calls 6.8 s (first byte avg 420 ms) · tools 0.9 s · Lumen 31 ms · total 7.8 s · in 3.1k (cached 20.4k) out 410
// Off (the default), every function here returns a no-op and nothing is measured.
const on = () => process.env.LUMEN_TURN_TIMING === '1';
const NOOP_REQUEST = { mark() {}, done() {} };

const kilo = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

// The token counts of a response, whichever API sent them: Anthropic (input_tokens, cache_read_input_tokens,
// cache_creation_input_tokens, output_tokens) or Chat Completions (prompt_tokens with prompt_tokens_details.cached_tokens, completion_tokens).
function tokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (Number.isFinite(usage.input_tokens)) {
    return { input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0, output: usage.output_tokens || 0 };
  }
  if (Number.isFinite(usage.prompt_tokens)) {
    const cached = usage.prompt_tokens_details?.cached_tokens || 0;
    return { input: usage.prompt_tokens - cached, cacheRead: cached, cacheWrite: 0, output: usage.completion_tokens || 0 };
  }
  return null;
}

// A task's clock (one per sidebar message, kept on its task scope): counts model requests and tool time, and prints the summary.
// label: "anthropic:claude-opus-5-5", "claudecode:sonnet", …; now: injectable for tests.
function taskTimer(label, { now = Date.now, log = console.log } = {}) {
  if (!on()) return null;
  const t0 = now();
  const s = { label, requests: 0, modelMs: 0, firstByte: [], toolMs: 0, prepMs: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, lastToolEnd: t0, rounds: 0 };
  // CLI rounds, read from the chat's events: a round is the model's time up to its first tool call, then those tools' time.
  let roundStart = t0;
  let roundModel = null;
  let roundTools = 0;
  let pending = 0;
  let sawRequest = false; // an API engine reports its own requests (request()), so events are only used to count tool time
  const endRound = () => {
    if (roundModel === null) return;
    s.rounds++;
    if (!sawRequest) { s.modelMs += roundModel; log(`[lumen] turn ${label.split(':')[0]} round ${s.rounds}: model ${roundModel} ms · tools ${roundTools} ms`); }
    roundModel = null; roundTools = 0;
  };
  const timer = {
    stats: s,
    // One model request (API engines). prep is measured from the last tool's end (or the task's start).
    request(provider, model, { chars = 0 } = {}) {
      sawRequest = true;
      const sent = now();
      const n = ++s.requests;
      const prep = Math.max(0, sent - s.lastToolEnd);
      s.prepMs += prep;
      const marks = {};
      return {
        mark(kind) { if (!(kind in marks)) marks[kind] = now() - sent; },
        done(usage) {
          const end = now() - sent;
          s.modelMs += end;
          if ('byte' in marks) s.firstByte.push(marks.byte);
          const tok = tokensOf(usage);
          if (tok) { s.input += tok.input; s.cacheRead += tok.cacheRead; s.cacheWrite += tok.cacheWrite; s.output += tok.output; }
          const parts = [`prep ${prep} ms`];
          if ('byte' in marks) parts.push(`first byte ${marks.byte} ms`);
          if ('token' in marks) parts.push(`first token ${marks.token} ms`);
          if ('tool' in marks) parts.push(`tool call ${marks.tool} ms`);
          parts.push(`end ${end} ms`);
          if (tok) parts.push(`in ${tok.input} (cache read ${tok.cacheRead}, write ${tok.cacheWrite}) out ${tok.output}`);
          if (chars) parts.push(`${kilo(chars)} chars`);
          log(`[lumen] turn ${provider} ${model} #${n}: ${parts.join(' · ')}`);
          s.lastToolEnd = now(); // (until a tool runs, Lumen's own time counts from here)
        },
      };
    },
    // The chat's events, as the task emits them.
    event(e) {
      if (!e || typeof e !== 'object') return;
      const t = now();
      if (e.type === 'tool') {
        if (roundModel === null) roundModel = t - roundStart;
        pending++;
      } else if (e.type === 'tool_done') {
        const ms = Number.isFinite(e.ms) ? e.ms : 0;
        s.toolMs += ms; roundTools += ms;
        pending = Math.max(0, pending - 1);
        if (!pending) { s.lastToolEnd = t; endRound(); roundStart = t; }
      }
    },
    finish() {
      if (roundModel === null && !sawRequest) { roundModel = now() - roundStart; endRound(); } // the CLI's closing answer
      const total = now() - t0;
      const fb = s.firstByte.length ? ` (first byte avg ${Math.round(s.firstByte.reduce((a, b) => a + b, 0) / s.firstByte.length)} ms)` : '';
      const calls = sawRequest ? `${s.requests} model call${s.requests === 1 ? '' : 's'} ${secs(s.modelMs)}${fb}` : `${s.rounds} model round${s.rounds === 1 ? '' : 's'} ${secs(s.modelMs)}`;
      const tokens = s.input || s.cacheRead || s.output ? ` · in ${kilo(s.input)} (cached ${kilo(s.cacheRead)}) out ${kilo(s.output)}` : '';
      log(`[lumen] task ${label}: ${calls} · tools ${secs(s.toolMs)}${sawRequest ? ` · Lumen ${s.prepMs} ms` : ''} · total ${secs(total)}${tokens}`);
      return { ...s, total };
    },
  };
  return timer;
}

// The request clock for the running task's timer, or a no-op (off, or no task).
const requestOf = (timer, provider, model, opts) => (timer ? timer.request(provider, model, opts) : NOOP_REQUEST);

module.exports = { on, taskTimer, requestOf, tokensOf, NOOP_REQUEST };
