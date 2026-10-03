// What Codex really reports about usage, read without a model call and without keeping any text.
//
// Two machine-readable sources, both from OpenAI's open-source Codex (codex-rs/protocol):
//  - `codex exec --json` prints JSONL events; `turn.completed` carries
//      { "type":"turn.completed", "usage": { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }
//    (input_tokens includes the cached ones). There is no cost field: Codex does not report a price, so none is invented.
//  - Every Codex session (CLI, IDE extension, desktop app) is logged to <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl,
//    and each model call appends an event_msg of type token_count:
//      { "timestamp": "...Z", "type": "event_msg", "payload": { "type": "token_count",
//        "info": { "total_token_usage": {…}, "last_token_usage": {…}, "model_context_window": 272000 },
//        "rate_limits": { "limit_id":"codex", "primary": { "used_percent": 12.0, "window_minutes": 300, "resets_at": 1760000000 },
//                         "secondary": { "used_percent": 4.0, "window_minutes": 10080, "resets_at": 1760400000 },
//                         "plan_type": "plus", "rate_limit_reached_type": null } } }
//    (a TokenUsage is input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens; resets_at is
//    unix seconds; older builds sent resets_in_seconds instead). rate_limits is present for ChatGPT-plan sign-ins and null
//    for an API key: then there is no plan data and the UI says so.
// Privacy (PRIVACY.md): only the numbers above are read from a rollout (its last token_count lines, from the file's tail), never
// a prompt, reply, tool output, path or account field; only numbers and a plan word are kept.
const fs = require('fs');
const path = require('path');

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const nz = (v) => Math.max(0, num(v) ?? 0);

// A TokenUsage -> Lumen's record shape. Codex's input_tokens already include the cached ones: split them so the
// total isn't counted twice. Reasoning tokens are part of output_tokens.
function tokensOf(u) {
  if (!u || typeof u !== 'object') return null;
  const input = nz(u.input_tokens);
  const cached = Math.min(nz(u.cached_input_tokens), input);
  return { inputTokens: input - cached, outputTokens: nz(u.output_tokens), cacheReadTokens: cached, cacheWriteTokens: nz(u.cache_write_input_tokens), reasoningTokens: nz(u.reasoning_output_tokens), costUSD: 0 };
}

// rate_limits -> { planType, primary, secondary, reached } with windows { percent, minutes, resetsAt (ms) } or null.
function limitsOf(rl, at) {
  if (!rl || typeof rl !== 'object') return null;
  const win = (w) => {
    if (!w || typeof w !== 'object' || num(w.used_percent) == null) return null;
    const resetsAt = num(w.resets_at) != null ? num(w.resets_at) * 1000 : num(w.resets_in_seconds) != null && at ? at + num(w.resets_in_seconds) * 1000 : null;
    return { percent: Math.max(0, Math.min(100, num(w.used_percent))), minutes: num(w.window_minutes) != null ? Math.round(num(w.window_minutes)) : null, resetsAt };
  };
  const primary = win(rl.primary);
  const secondary = win(rl.secondary);
  if (!primary && !secondary) return null;
  const reached = Boolean(rl.rate_limit_reached_type) || [primary, secondary].some((w) => w && w.percent >= 100);
  const plan = typeof rl.plan_type === 'string' && /^[a-z0-9_-]{1,24}$/i.test(rl.plan_type) ? rl.plan_type.toLowerCase() : null;
  return { planType: plan, primary, secondary, reached };
}

// One rollout line (already JSON.parsed) -> { at, total, last, contextWindow, limits } for a token_count event, else null.
function fromRolloutLine(obj) {
  const p = obj && obj.type === 'event_msg' ? obj.payload : obj && obj.type === 'token_count' ? obj : null;
  if (!p || p.type !== 'token_count') return null;
  const at = Date.parse(obj.timestamp) || null;
  const info = p.info && typeof p.info === 'object' ? p.info : null;
  return {
    at,
    total: info ? tokensOf(info.total_token_usage) : null,
    last: info ? tokensOf(info.last_token_usage) : null,
    contextWindow: info ? nz(info.model_context_window) : 0,
    limits: limitsOf(p.rate_limits, at),
  };
}

// One `codex exec --json` event -> { usage } (turn.completed) | { error: text } (turn.failed / error) | null.
// The error text is kept short: it is shown to the user as the limit-reached reason, and parsed for a reset time.
function fromExecEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'turn.completed') { const usage = tokensOf(obj.usage); return usage ? { usage } : null; }
  if (obj.type === 'turn.failed' || obj.type === 'error') {
    const msg = String(obj.error?.message || obj.message || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 240);
    return msg ? { error: msg, limit: limitMessage(msg) } : null;
  }
  return null;
}
// "You've hit your usage limit. Try again at 3:40 PM." / "…try again in 3 hours 20 minutes" -> { text, resetsAt (ms|null) } or null.
function limitMessage(text, now = Date.now()) {
  const t = String(text || '');
  if (!/usage limit|rate.?limit|limit reached|hit your .*limit|quota/i.test(t)) return null;
  let resetsAt = null;
  const rel = /\b(?:in|after)\s+(?:(\d+)\s*(?:days?|d)\s*)?(?:(\d+)\s*(?:hours?|hrs?|h)\s*)?(?:(\d+)\s*(?:m|min|minutes?)\b)?/i.exec(t);
  if (rel && (rel[1] || rel[2] || rel[3])) resetsAt = now + (((Number(rel[1]) || 0) * 24 + (Number(rel[2]) || 0)) * 60 + (Number(rel[3]) || 0)) * 60000;
  return { text: t.slice(0, 200), resetsAt };
}

// ---------- scanning the session logs ----------
const DAY = 86400000;
// The last token_count in a file, read from its tail only. { total, last, contextWindow, limits, at } or null.
function lastTokenCount(file, io = {}) {
  const f = io.fs || fs;
  let fd;
  try {
    fd = f.openSync(file, 'r');
    const size = f.fstatSync(fd).size;
    for (const span of [128 * 1024, 1024 * 1024]) {
      const len = Math.min(size, span);
      const buf = Buffer.alloc(len);
      f.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (len < size) lines.shift(); // starts mid-line
      let withLimits = null;
      let last = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('token_count')) continue;
        let ev;
        try { ev = fromRolloutLine(JSON.parse(line)); } catch { continue; }
        if (!ev) continue;
        last ||= ev;
        if (ev.limits) { withLimits = ev.limits; break; }
      }
      if (last) return { ...last, limits: withLimits || last.limits, at: last.at };
      if (len >= size) break;
    }
  } catch { /* unreadable: skipped */ } finally { if (fd !== undefined) try { f.closeSync(fd); } catch {} }
  return null;
}

// The files modified since `since`, newest first (the day folders are walked; older days are skipped by name).
function recentRollouts(home, since, io = {}) {
  const f = io.fs || fs;
  const root = path.join(home, 'sessions');
  const out = [];
  const list = (dir) => { try { return f.readdirSync(dir); } catch { return []; } };
  const first = new Date(since - DAY);
  const stamp = (y, m, d) => y * 10000 + m * 100 + d;
  const from = stamp(first.getFullYear(), first.getMonth() + 1, first.getDate());
  for (const y of list(root).filter((n) => /^\d{4}$/.test(n))) {
    for (const m of list(path.join(root, y)).filter((n) => /^\d{2}$/.test(n))) {
      for (const d of list(path.join(root, y, m)).filter((n) => /^\d{2}$/.test(n))) {
        if (stamp(Number(y), Number(m), Number(d)) < from) continue;
        for (const name of list(path.join(root, y, m, d))) {
          if (!/^rollout-.*\.jsonl$/.test(name)) continue;
          const file = path.join(root, y, m, d, name);
          try { const st = f.statSync(file); if (st.mtimeMs >= since) out.push({ file, mtime: st.mtimeMs }); } catch {}
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// What the panel shows: { sessions, today, week, limits, latestAt, plan } from Codex's own session logs.
//   today / week: { sessions, tokens, input, output, cached, reasoning } (a session's final cumulative total, counted on the day it was last written)
//   limits: the newest rate_limits reading, as limitsOf(), with `at`; windows whose reset time has passed are marked `expired`
function scanSessions({ home, now = Date.now(), days = 7, maxFiles = 200, io = {} } = {}) {
  const files = recentRollouts(home, now - days * DAY, io).slice(0, maxFiles);
  const startToday = new Date(now).setHours(0, 0, 0, 0);
  const empty = () => ({ sessions: 0, tokens: 0, input: 0, output: 0, cached: 0, reasoning: 0 });
  const today = empty();
  const week = empty();
  let limits = null;
  let limitsAt = 0;
  let latestAt = 0;
  for (const { file, mtime } of files) {
    const ev = lastTokenCount(file, io);
    if (!ev) continue;
    if (ev.total) {
      const add = (acc) => { acc.sessions++; acc.input += ev.total.inputTokens; acc.cached += ev.total.cacheReadTokens; acc.output += ev.total.outputTokens; acc.reasoning += ev.total.reasoningTokens; acc.tokens += ev.total.inputTokens + ev.total.cacheReadTokens + ev.total.outputTokens; };
      add(week);
      if (mtime >= startToday) add(today);
    }
    const at = ev.at || mtime;
    latestAt = Math.max(latestAt, at);
    if (ev.limits && at >= limitsAt) { limits = ev.limits; limitsAt = at; }
  }
  const mark = (w) => (w ? { ...w, expired: w.resetsAt != null && w.resetsAt <= now } : null);
  return {
    sessions: files.length, today, week, latestAt: latestAt || null,
    limits: limits ? { ...limits, at: limitsAt, primary: mark(limits.primary), secondary: mark(limits.secondary) } : null,
  };
}

const DEFAULT_WINDOWS = { five: 300, week: 10080 };
// The 5-hour and weekly windows out of a limits reading, whichever of primary / secondary each is (by window_minutes).
function windowsOf(limits) {
  if (!limits) return { fiveHour: null, weekly: null };
  const list = [limits.primary, limits.secondary].filter(Boolean);
  const near = (w, minutes) => w.minutes != null && Math.abs(w.minutes - minutes) <= minutes * 0.2;
  const fiveHour = list.find((w) => near(w, DEFAULT_WINDOWS.five)) || (list[0] && list[0].minutes == null ? list[0] : null);
  const weekly = list.find((w) => near(w, DEFAULT_WINDOWS.week)) || (list.length > 1 && list[1].minutes == null ? list[1] : null);
  return { fiveHour: fiveHour || null, weekly: weekly || null, other: list.filter((w) => w !== fiveHour && w !== weekly) };
}

// The limit-reached state from a reading: { resetsAt (ms | null) } while a window at 100% hasn't reset, else null.
function limitReached(limits, now = Date.now()) {
  if (!limits) return null;
  const hit = [limits.primary, limits.secondary].filter((w) => w && w.percent >= 100 && !(w.resetsAt != null && w.resetsAt <= now));
  if (!hit.length) return null;
  const times = hit.map((w) => w.resetsAt).filter((t) => t != null);
  return { resetsAt: times.length ? Math.max(...times) : null }; // usable again once every full window has reset
}

// Is the user signed in to Codex? Never reads the token: only the file's presence, and for ChatGPT / API-key login the CLI's own word.
// io.run(['login','status']) -> { ok, stdout, stderr }; absent: the auth.json file decides.
async function loginState({ home, run, io = {} } = {}) {
  const f = io.fs || fs;
  const hasAuthFile = (() => { try { return f.statSync(path.join(home, 'auth.json')).isFile(); } catch { return false; } })();
  if (run) {
    const r = await run(['login', 'status']).catch(() => null);
    if (r) {
      const text = `${r.stdout || ''}\n${r.stderr || ''}`;
      if (r.ok && /logged in/i.test(text)) return { signedIn: true, method: /chatgpt/i.test(text) ? 'chatgpt' : /api key/i.test(text) ? 'apikey' : 'unknown' };
      if (/not logged in|logged out/i.test(text) || (!r.ok && /login|auth/i.test(text) && !/unrecognized|unknown|unexpected/i.test(text))) return { signedIn: false };
    }
  }
  // An older CLI without `login status`: the credentials file's presence is the best sign (its contents are never read).
  return { signedIn: hasAuthFile ? true : null, method: 'unknown', fromFile: true };
}

module.exports = { tokensOf, limitsOf, fromRolloutLine, fromExecEvent, limitMessage, lastTokenCount, recentRollouts, scanSessions, windowsOf, limitReached, loginState };
