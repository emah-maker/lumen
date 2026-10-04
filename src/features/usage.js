// ---------- usage: your plan's limits, and how much of them Lumen uses ----------
// Settings → You and AI → Usage, and the sidebar's meter under the composer.
//  - The plan's limits come from two places, both free: `claude -p /usage` (a local command: no
//    model call, 0 tokens), which reports "Current session: 29% used · resets 8:09pm" and a weekly
//    line when the plan has one, plus what the CLI saw contributing ("Top MCP servers: lumen 1%" is
//    Claude Code driving Lumen over MCP); and the rate_limit_event each Claude Code turn in the
//    sidebar reports as it runs (claude-code.js).
//  - Lumen's own use is logged per turn (usage.json in the profile, 35 days): tokens and the
//    list-price cost the CLI reports, for Claude Code, Grok Build and API-key chats. For Claude Code
//    turns, how far the 5-hour meter moved during the turn is kept too: the reading from just
//    before (the previous turn or /usage, when recent) against the one the turn ends with. Anything
//    else using the same account at that moment moves it too: a Claude Code session outside Lumen is
//    detected from its transcripts and makes that turn's share unknown; claude.ai and other machines
//    can't be seen, so the panel still calls it approximate.
//  - Codex (OpenAI's CLI) is not a sidebar engine; its use is read from Codex's own session logs (ai/codex-usage.js: token totals,
//    and the 5-hour / weekly windows its token_count events carry for ChatGPT plans) and kept here as numbers only. Codex
//    reports no price, so no cost is shown for it, and with an API-key sign-in (no rate_limits) the UI says so.
//  - Grok publishes no plan limits (no command, no field: grok 1.0.41), so its bar never shows a
//    plan percentage. It shows what is real: the chat's context-window fill, Lumen's own use in
//    rolling windows, a budget the user sets (a real progress bar toward that), and the limit-reached
//    state with the reset time Grok's own message named.
const { spawn } = require('child_process');
const { killTree } = require('../ai/cli-utils');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settingsFile = require('../settings/settings-file'); // tmp + rename + .bak writes, corrupt-file recovery

const KEEP_DAYS = 35;
const PLAN_TTL = 60 * 1000; // /usage is re-run at most once a minute
const FRESH = 10 * 60 * 1000; // a meter reading this recent counts as "just before" a turn
const FIVE_HOURS = 5 * 60 * 60 * 1000;

// "Current session: 29% used · resets Sep 28 at 8:09pm (America/New_York)" and friends.
function parsePlan(text) {
  const out = { subscription: /using your subscription/i.test(text), limits: [], contributions: [] };
  for (const m of String(text).matchAll(/^[ \t]*([^:\n]{3,60}):[ \t]*(\d+(?:\.\d+)?)% used(?:[ \t]*·[ \t]*resets[ \t]+([^\n]+))?[ \t]*$/gim)) {
    out.limits.push({ label: m[1].trim(), percent: Number(m[2]), resets: (m[3] || '').trim() || null });
  }
  // "Last 24h · 644 requests · 7 sessions" blocks, each with "Top MCP servers: a 13%, lumen 1%".
  const blocks = String(text).split(/^(?=Last \S+)/m).slice(1);
  for (const block of blocks) {
    const period = block.match(/^Last (\S+)/)[1];
    const mcp = block.match(/Top MCP servers:[ \t]*([^\n]+)/i);
    const servers = mcp ? [...mcp[1].matchAll(/([^,]+?)[ \t]+(\d+(?:\.\d+)?)%/g)].map((s) => ({ name: s[1].trim(), percent: Number(s[2]) })) : [];
    out.contributions.push({ period, servers, lumen: servers.find((s) => /^lumen$/i.test(s.name))?.percent ?? 0 });
  }
  return out;
}

// The 5-hour window from a rate_limit_event's info: { percent, resetsAt (ms) } or null.
function fiveHourOf(info) {
  const w = info?.unifiedWindows?.five_hour || (info?.rateLimitType === 'five_hour' ? info : null);
  if (!w || !Number.isFinite(Number(w.utilization ?? NaN)) || !Number.isFinite(Number(w.resetsAt))) return null;
  return { percent: Number(w.utilization) * 100, resetsAt: Number(w.resetsAt) * 1000 };
}

// ---- Grok: rolling windows, budget, limit state (all from Lumen's own log or Grok's own message)
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WARN_AT = 80;
const DEFAULT_BUDGET = { unit: 'usd', daily: 0, weekly: 0 };
const recTokens = (r) => (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0);
const totals = (list) => list.reduce((a, r) => ({ turns: a.turns + 1, tokens: a.tokens + recTokens(r), costUSD: a.costUSD + (r.costUSD || 0) }), { turns: 0, tokens: 0, costUSD: 0 });

// { unit: 'usd' | 'tokens', daily, weekly } from anything a settings page could send; 0 = no limit.
function normalizeBudget(b) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, 1e12) : 0; };
  return { unit: b?.unit === 'tokens' ? 'tokens' : 'usd', daily: num(b?.daily), weekly: num(b?.weekly) };
}
// Where a budget period began (local time): midnight, or Monday's midnight. And when it ends.
function periodStart(kind, now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (kind === 'weekly') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
function periodEnd(kind, now) {
  const d = new Date(periodStart(kind, now));
  d.setDate(d.getDate() + (kind === 'weekly' ? 7 : 1));
  return d.getTime();
}
// ---- Codex: Codex's own reading of the plan's windows and its token totals (see ai/codex-usage.js), never a guess.
// scan: scanSessions()'s result | null. Returns what the panel, the bar and the status card show.
function codexSummary(scan, now, { installed = null } = {}) {
  const codexUsage = require('../ai/codex-usage');
  const limits = scan?.limits || null;
  const { fiveHour, weekly } = codexUsage.windowsOf(limits);
  const win = (w) => (w ? { percent: w.percent, minutes: w.minutes, resetsAt: w.resetsAt, expired: Boolean(w.expired || (w.resetsAt != null && w.resetsAt <= now)) } : null);
  const reached = codexUsage.limitReached(limits, now);
  const has = Boolean(scan && (scan.sessions || limits));
  return {
    available: has || installed === true,
    hasLimits: Boolean(limits),
    planType: limits?.planType || null,
    fiveHour: win(fiveHour), weekly: win(weekly), reached,
    readAt: limits?.at || null,
    sessions: scan?.sessions || 0,
    today: scan?.today || null, week: scan?.week || null,
    latestAt: scan?.latestAt || null,
    // Honest labels for what is missing: Codex logs no rate_limits for an API-key sign-in or before its first answer.
    note: !has ? 'No Codex sessions found yet.' : !limits ? 'Codex has not reported plan limits (an API-key sign-in has none, or no reply has finished yet).' : null,
  };
}
const grokRecords = (records) => records.filter((r) => r.engine === 'grokbuild');
// Lumen's own Grok use in the last 5 hours and 7 days (rolling), exactly from the log.
function grokWindows(records, now) {
  const mine = grokRecords(records);
  return { h5: totals(mine.filter((r) => r.at >= now - 5 * HOUR)), d7: totals(mine.filter((r) => r.at >= now - 7 * DAY)) };
}
// Progress toward the user's budget: null when none is set. Each set period reports { kind, used,
// limit, percent (unclamped), resetsAt }; `top` is the one furthest along.
function budgetStatus(records, budgetIn, now) {
  const budget = normalizeBudget(budgetIn);
  if (!(budget.daily > 0) && !(budget.weekly > 0)) return null;
  const mine = grokRecords(records);
  const periods = ['daily', 'weekly'].filter((k) => budget[k] > 0).map((kind) => {
    const list = mine.filter((r) => r.at >= periodStart(kind, now));
    const used = budget.unit === 'tokens' ? totals(list).tokens : totals(list).costUSD;
    return { kind, used, limit: budget[kind], percent: (used / budget[kind]) * 100, start: periodStart(kind, now), resetsAt: periodEnd(kind, now) };
  });
  return { unit: budget.unit, periods, top: periods.reduce((a, p) => (p.percent > a.percent ? p : a)) };
}
const levelOf = (percent, warnAt = WARN_AT, highAt = 100) => (percent >= highAt ? 'high' : percent >= warnAt ? 'warn' : 'ok');

// What the sidebar's usage bar shows for one engine, from summary()'s data, or null when there is
// nothing real to show (the bar stays hidden rather than guess).
//  - claudecode: the plan's 5-hour limit ({ kind: 'plan', percent, resetsAt | resetsText }), the
//    weekly limit when the plan has one, and Lumen's share of the window.
//  - grokbuild: never a plan percentage (Grok publishes no limits). In order of precedence:
//    { kind: 'limit' }   Grok said the plan's limit was reached (resetsAt when its message named a time);
//    { kind: 'budget' }  a progress bar toward the budget the user set;
//    { kind: 'context' } how full the current chat's context window is (percent null when unknown),
//                        with today's tokens and cost.
//    Every kind carries `windows`: Lumen's own use in the last 5 hours and 7 days, and `level`
//    ('ok' | 'warn' | 'high') for the colour.
//  - any other CLI engine: { kind: 'context' }, from the turns' own usage.
function barFor(engine, s) {
  if (!s) return null;
  if (engine === 'claudecode') {
    const limits = s.plan?.available ? s.plan.limits || [] : [];
    const session = limits.find((l) => /session/i.test(l.label));
    const week = limits.find((l) => /week/i.test(l.label));
    const percent = s.meter?.percent ?? session?.percent;
    if (percent == null || !Number.isFinite(percent)) return null;
    return {
      engine, kind: 'plan', percent: Math.max(0, Math.min(100, percent)),
      resetsAt: s.meter?.resetsAt || null, resetsText: session?.resets?.replace(/\s*\(.*\)$/, '') || null,
      weekly: week ? { percent: Math.max(0, Math.min(100, week.percent)), resetsText: week.resets?.replace(/\s*\(.*\)$/, '') || null } : null,
      lumenPoints: s.lumen?.window?.limitPoints ?? null,
    };
  }
  if (engine === 'codex') {
    const c = s.codex;
    if (!c) return null;
    if (c.reached) return { engine, kind: 'limit', percent: 100, level: 'high', resetsAt: c.reached.resetsAt || null, message: 'Codex plan limit reached', windows: null };
    const w = c.fiveHour && !c.fiveHour.expired ? c.fiveHour : c.weekly && !c.weekly.expired ? c.weekly : null;
    if (!w) return null;
    const wk = c.weekly && !c.weekly.expired ? c.weekly : null;
    return { engine, kind: 'plan', percent: Math.max(0, Math.min(100, w.percent)), level: levelOf(w.percent), resetsAt: w.resetsAt || null, resetsText: null, weekly: wk && wk !== w ? { percent: Math.max(0, Math.min(100, wk.percent)), resetsText: null } : null, lumenPoints: null };
  }
  const g = engine === 'grokbuild' ? s.grok || {} : {};
  const windows = g.windows || null;
  if (g.limit) return { engine, kind: 'limit', percent: 100, level: 'high', resetsAt: g.limit.resetsAt || null, message: g.limit.text || '', windows };
  const e = s.engines?.[engine];
  const budget = g.budget?.status;
  if (!budget && (!e || (!e.today?.turns && !windows?.d7?.turns) || (!e.today?.tokens && !e.today?.costUSD && !windows?.d7?.tokens))) return null;
  const { contextTokens, contextWindow, compactPercent } = e?.last || {};
  const contextPercent = contextWindow > 0 && contextTokens > 0 ? Math.min(100, (contextTokens / contextWindow) * 100) : null;
  const today = e?.today || { turns: 0, tokens: 0, costUSD: 0 };
  const context = { contextPercent, compactPercent: compactPercent || null, contextTokens: contextTokens || 0, contextWindow: contextWindow || 0 };
  if (budget) {
    const top = budget.top;
    return { engine, kind: 'budget', percent: Math.max(0, Math.min(100, top.percent)), level: levelOf(top.percent), unit: budget.unit, period: top.kind, used: top.used, limit: top.limit, resetsAt: top.resetsAt, ...context, tokens: today.tokens, costUSD: today.costUSD, turns: today.turns, windows };
  }
  // Amber from 10 points below the model's own auto-compaction threshold (100 when it isn't known).
  const compactAt = compactPercent || 100;
  return { engine, kind: 'context', percent: contextPercent, level: contextPercent == null ? 'ok' : levelOf(contextPercent, Math.max(1, compactAt - 10), Infinity), ...context, tokens: today.tokens, costUSD: today.costUSD, turns: today.turns, windows };
}

// Did any Claude Code session other than Lumen's own write since `since` (ms)? Lumen runs each turn in
// a temp folder named lumen-cc-* (and lumen-usage-* for /usage), so its transcripts sit in matching
// project folders under ~/.claude/projects; a changed transcript anywhere else is you using Claude
// Code in a terminal or an editor, and the 5-hour meter moved for that too.
const LUMEN_PROJECT = /lumen-(cc|usage)-/i;
async function otherClaudeActivity(since, projectsDir = path.join(os.homedir(), '.claude', 'projects')) {
  let dirs;
  try { dirs = await fs.promises.readdir(projectsDir); } catch { return false; }
  for (const dir of dirs) {
    if (LUMEN_PROJECT.test(dir)) continue;
    let files;
    try { files = await fs.promises.readdir(path.join(projectsDir, dir)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try { if ((await fs.promises.stat(path.join(projectsDir, dir, f))).mtimeMs > since) return true; } catch {}
    }
  }
  return false;
}

// deps: { app, claudeBin: async () => path | null, otherActivity?: async (sinceMs) => boolean }
function createUsage(deps) {
  let records = []; // { at, engine, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUSD, limitPoints }
  let meter = null; // the latest 5-hour reading: { percent, resetsAt, at, source }
  let latestInfo = null; // the latest rate_limit_event info (status, overage)
  let plan = null; // { at, data } from /usage
  let planRun = null;
  let planChild = null; // the `claude -p /usage` process while it runs
  let codexSnap = null; // the last Codex reading, numbers only: { at, scan } (scan: codexSummary's input, no text)
  let grokLimit = null; // Grok said the plan's limit was reached: { at, resetsAt (ms | null), text }
  let budget = { ...DEFAULT_BUDGET }; // the user's Grok budget (Settings → Usage); 0 = none
  let notified = {}; // budget notices already shown: { 'daily:<period start>:80': true }
  const file = () => path.join(deps.app.getPath('userData'), 'usage.json');

  function load() {
    try {
      const saved = settingsFile.loadJson(file()); // (an unparseable file is restored from .bak or set aside, never overwritten)
      if (Array.isArray(saved.records)) records = saved.records.filter((r) => r && Number.isFinite(r.at));
      if (saved.meter && Number.isFinite(saved.meter.percent)) meter = saved.meter;
      if (saved.grokLimit && Number.isFinite(saved.grokLimit.at)) grokLimit = { at: saved.grokLimit.at, resetsAt: Number.isFinite(saved.grokLimit.resetsAt) ? saved.grokLimit.resetsAt : null, text: String(saved.grokLimit.text || '').slice(0, 200) };
      if (saved.codex && Number.isFinite(saved.codex.at) && saved.codex.scan && typeof saved.codex.scan === 'object') codexSnap = { at: saved.codex.at, scan: saved.codex.scan };
      if (saved.budget) budget = normalizeBudget(saved.budget);
      if (saved.notified && typeof saved.notified === 'object') notified = saved.notified;
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[lumen] could not read usage.json:', err.message);
    }
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
      records = records.filter((r) => r.at >= cutoff);
      settingsFile.writeJsonAtomicAsync(file(), { records, meter, grokLimit, codex: codexSnap, budget, notified }, undefined, 0).catch((err) => console.error('[lumen] could not save usage.json:', err.message));
    }, 500);
  }

  // A new 5-hour reading; returns how many points it moved since the last one, when that one is
  // recent and in the same window (else null: unknown).
  function reading(percent, resetsAt, source) {
    const now = Date.now();
    const same = meter && Math.abs(meter.resetsAt - resetsAt) < 60 * 1000 && now - meter.at < FRESH;
    const moved = same ? Math.max(0, percent - meter.percent) : null;
    meter = { percent, resetsAt, at: now, source };
    return moved;
  }

  // One finished turn. `engine`: 'claudecode' | 'grokbuild' | 'anthropic' | 'openai' | …
  // Grok's limit state (see grokLimitNow): `limit` is { text, resetsAt } from a failed turn's message;
  // `ok` marks a finished turn, which clears it. Returns { notice } when this turn took a budget
  // over 80% or 100% for the first time in its period.
  // background: a background task's run (features/background-runner.js). Its tokens and cost count as
  // Lumen's, and its plan-meter reading chains with the sidebar's (each turn is measured against the
  // reading before it), but it is kept apart: never the sidebar's "last turn" context bar.
  function record(engine, { usage, rateLimit, model, session, limit, ok, background = false } = {}) {
    if (engine === 'grokbuild') {
      if (limit) { grokLimit = { at: clock(), resetsAt: Number.isFinite(limit.resetsAt) ? limit.resetsAt : null, text: String(limit.text || '').slice(0, 200) }; save(); }
      else if (ok && grokLimit) { grokLimit = null; save(); }
    }
    if (engine === 'codex') {
      // Lumen-driven Codex runs (codex exec --json): `rateLimit` is codex-usage.limitsOf()'s shape, `limit` a limit-reached message.
      if (rateLimit) { codexSnap = { at: clock(), scan: { ...(codexSnap?.scan || {}), sessions: codexSnap?.scan?.sessions || 0, limits: { ...rateLimit, at: clock() } } }; save(); }
      if (limit) { codexSnap = { at: clock(), scan: { ...(codexSnap?.scan || {}), limits: { planType: null, ...(codexSnap?.scan?.limits || {}), primary: codexSnap?.scan?.limits?.primary || { percent: 100, minutes: null, resetsAt: Number.isFinite(limit.resetsAt) ? limit.resetsAt : null }, at: clock(), reached: true } } }; save(); }
    }
    if (!usage) return null;
    let limitPoints = null;
    const beforeAt = meter?.at ?? null;
    if (rateLimit && engine !== 'codex') {
      latestInfo = rateLimit;
      const w = fiveHourOf(rateLimit);
      if (w) limitPoints = reading(w.percent, w.resetsAt, 'turn');
    }
    const rec = {
      at: clock(), engine, model: model || (usage.models || [])[0] || null,
      inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0,
      cacheReadTokens: usage.cacheReadTokens || 0, cacheWriteTokens: usage.cacheWriteTokens || 0,
      costUSD: usage.costUSD || 0, limitPoints, ...(background ? { background: true } : {}),
      // Grok reports the last model call's own input (a long tool loop would otherwise count the context once per call).
      contextTokens: Number.isFinite(usage.contextTokens) ? usage.contextTokens : (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0), contextWindow: usage.contextWindow || 0,
      ...(engine === 'grokbuild' ? { session: session || null, compactPercent: usage.compactPercent || null } : {}),
    };
    records.push(rec);
    // The meter is account-wide: if you used Claude Code elsewhere since the reading this turn is
    // measured against, its movement isn't Lumen's, so the share for this turn becomes unknown.
    if (limitPoints != null && beforeAt) {
      (deps.otherActivity || otherClaudeActivity)(beforeAt - 2000).then((other) => { if (other) { rec.limitPoints = null; save(); } }, () => {});
    }
    const notice = engine === 'grokbuild' ? budgetNotice(rec.at) : null;
    save();
    return notice ? { notice } : null;
  }

  const clock = () => (deps.now || Date.now)();
  // The limit-reached state while it applies: until the time Grok's message named, or (when it
  // named none) until the next finished turn clears it. A passed time drops it.
  function grokLimitNow(now = clock()) {
    if (!grokLimit) return null;
    if (grokLimit.resetsAt != null && grokLimit.resetsAt <= now) { grokLimit = null; save(); return null; }
    return grokLimit;
  }

  // One non-blocking notice per period and level (80%, 100%) when the budget is crossed.
  function budgetNotice(now) {
    const status = budgetStatus(records, budget, now);
    if (!status) return null;
    let text = null;
    for (const p of status.periods) {
      for (const level of [80, 100]) {
        if (p.percent < level) continue;
        const key = `${p.kind}:${p.start}:${level}`;
        if (notified[key]) continue;
        notified[key] = true;
        const fmt = status.unit === 'tokens' ? (n) => `${Math.round(n).toLocaleString('en-US')} tokens` : (n) => `$${n.toFixed(2)}`;
        const which = p.kind === 'daily' ? 'daily' : 'weekly';
        text = level === 100
          ? `You've reached your ${which} Grok budget (${fmt(p.used)} of ${fmt(p.limit)}). Nothing is blocked: it counts only Lumen's own Grok use, and you can change it in Settings → Usage.`
          : `You've used ${Math.round(p.percent)}% of your ${which} Grok budget (${fmt(p.used)} of ${fmt(p.limit)}). It counts only Lumen's own Grok use.`;
      }
    }
    notified = Object.fromEntries(Object.entries(notified).slice(-40));
    return text;
  }

  // `claude -p /usage`: a local command (0 tokens), run in an empty folder so no project settings
  // apply, like the sidebar engine's own runs. At most once a minute unless `refresh`.
  async function planUsage({ refresh = false } = {}) {
    if (!refresh && plan && Date.now() - plan.at < PLAN_TTL) return plan.data;
    if (planRun) return planRun;
    planRun = (async () => {
      const bin = await deps.claudeBin();
      if (!bin) return { available: false, reason: 'Claude Code is not installed.' };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-usage-'));
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const out = await new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        const child = spawn(bin, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], { shell: false, windowsHide: true, cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        planChild = child;
        // The CLI starts the user's own MCP servers (npx, node, ...): a stuck one would outlive a plain kill of
        // claude itself, so the whole process tree goes (cli-utils killTree), on the timeout and when Lumen quits.
        const timer = setTimeout(() => killTree(child), 30000);
        const ended = () => { clearTimeout(timer); if (planChild === child) planChild = null; };
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
        child.on('error', (err) => { ended(); resolve({ error: err.message }); });
        child.on('close', (code) => { ended(); resolve({ code, stdout, stderr }); });
      });
      require('../ai/temp-dirs').removeDir(dir); // (with retries: the CLI's tree may still hold it as its cwd for a moment)
      if (out.error) return { available: false, reason: out.error };
      let json;
      try { json = JSON.parse(out.stdout); } catch { return { available: false, reason: (out.stderr || out.stdout || 'No answer from Claude Code.').trim().split('\n')[0].slice(0, 200) }; }
      if (json.is_error) return { available: false, reason: String(json.result || 'Claude Code could not read your usage.').split('\n')[0].slice(0, 200) };
      const data = { available: true, ...parsePlan(json.result || '') };
      // The session line is the 5-hour window: it becomes the "before" reading for the next turn.
      const session = data.limits.find((l) => /session/i.test(l.label));
      if (session && meter && Date.now() - meter.at < FIVE_HOURS) reading(session.percent, meter.resetsAt, 'usage');
      return data;
    })().then((data) => { plan = { at: Date.now(), data }; return data; }).finally(() => { planRun = null; });
    return planRun;
  }

  const sum = (list) => list.reduce((a, r) => ({
    turns: a.turns + 1,
    tokens: a.tokens + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
    costUSD: a.costUSD + r.costUSD,
    limitPoints: r.limitPoints == null ? a.limitPoints : (a.limitPoints ?? 0) + r.limitPoints,
    unknown: a.unknown + (r.limitPoints == null && r.engine === 'claudecode' ? 1 : 0),
  }), { turns: 0, tokens: 0, costUSD: 0, limitPoints: null, unknown: 0 });

  const meterIsFresh = (now) => Boolean(meter && meter.resetsAt > now && now - meter.at < FRESH);

  // Codex's session logs, read at most every 20 seconds (a few small file tails; no model call); the reading is kept
  // (usage.json: numbers only) so the status card has it without scanning.
  let codexAt = 0;
  async function codexNow(now) {
    if (deps.codexScan && now - codexAt > 20000) {
      codexAt = now;
      try {
        const scan = await deps.codexScan(now);
        if (scan) { codexSnap = { at: now, scan }; save(); }
      } catch { /* unreadable logs: the last reading stands */ }
    }
    return codexSnap ? codexSummary(codexSnap.scan, now, { installed: deps.codexInstalled ? deps.codexInstalled() : null }) : deps.codexInstalled?.() ? codexSummary(null, now, { installed: true }) : null;
  }

  // Everything the panel and the meter show.
  async function summary({ refresh = false } = {}) {
    const now = clock();
    // The sidebar meter asks after every reply; while a turn's own rate_limit_event has the 5-hour
    // reading fresh, it doesn't need a `claude -p /usage` process (a whole CLI start) each time.
    const passive = !refresh && meterIsFresh(now);
    const planData = passive ? (plan?.data || { available: false, reason: 'Not read yet.' }) : await planUsage({ refresh }).catch((err) => ({ available: false, reason: err.message }));
    const windowStart = meter && meter.resetsAt > now ? meter.resetsAt - FIVE_HOURS : now - FIVE_HOURS;
    const since = (t) => records.filter((r) => r.at >= t);
    const byEngine = {};
    for (const r of since(now - 7 * 24 * 60 * 60 * 1000)) (byEngine[r.engine] ||= []).push(r);
    const today = since(new Date(now).setHours(0, 0, 0, 0));
    const engines = {};
    for (const name of new Set(records.map((r) => r.engine))) {
      const mine = records.filter((r) => r.engine === name);
      // a background run's context is not the sidebar chat's
      let last = [...mine].reverse().find((r) => !r.background) || { at: 0 };
      // Grok's context fill is the current chat's: its last turn, or none for a chat with no Grok turn yet.
      let fresh = false;
      if (name === 'grokbuild' && deps.grokSession) {
        const session = deps.grokSession();
        const own = session ? mine.filter((r) => r.session === session && !r.background) : [];
        if (own.length) last = own[own.length - 1]; else fresh = true;
      }
      engines[name] = { today: sum(today.filter((r) => r.engine === name)), background: sum(today.filter((r) => r.engine === name && r.background)), last: { at: last.at, contextTokens: fresh ? 0 : last.contextTokens || 0, contextWindow: last.contextWindow || 0, compactPercent: last.compactPercent || null } };
    }
    const codex = await codexNow(now);
    const result = {
      plan: planData,
      meter: meter && meter.resetsAt > now ? { percent: meter.percent, resetsAt: meter.resetsAt, at: meter.at } : null,
      status: latestInfo ? { status: latestInfo.status || null, overage: latestInfo.isUsingOverage ? 'in use' : latestInfo.overageStatus || null } : null,
      lumen: {
        window: { start: windowStart, ...sum(since(windowStart).filter((r) => r.engine === 'claudecode')), background: sum(since(windowStart).filter((r) => r.engine === 'claudecode' && r.background)).turns },
        today: sum(today),
        week: sum(since(now - 7 * 24 * 60 * 60 * 1000)),
        byEngine: Object.fromEntries(Object.entries(byEngine).map(([k, v]) => [k, sum(v)])),
      },
      engines,
      codex,
      // Grok: no plan numbers exist, only Lumen's own use, the user's budget and the limit message.
      grok: { limit: grokLimitNow(now), windows: grokWindows(records, now), budget: { config: budget, status: budgetStatus(records, budget, now) } },
    };
    result.bars = { claudecode: barFor('claudecode', result), grokbuild: barFor('grokbuild', result), codex: barFor('codex', result) };
    return result;
  }

  // A quick, synchronous look for the home page's AI status card (no CLI is started): the 5-hour reading when it is still current,
  // Grok's limit message, and what was counted today per engine.
  function glance(now = clock()) {
    const start = new Date(now).setHours(0, 0, 0, 0);
    const today = {};
    for (const r of records) {
      if (r.at < start) continue;
      const e = (today[r.engine] ||= { turns: 0, costUSD: 0 });
      e.turns++;
      e.costUSD += r.costUSD || 0;
    }
    const g = grokLimitNow(now);
    const cx = codexSnap ? codexSummary(codexSnap.scan, now) : null;
    const codexLimit = cx?.reached ? { resetsAt: cx.reached.resetsAt } : null;
    return { codexLimit, codexMeter: cx?.fiveHour && !cx.fiveHour.expired ? { percent: cx.fiveHour.percent, resetsAt: cx.fiveHour.resetsAt } : null, meter: meter && meter.resetsAt > now ? { percent: meter.percent, resetsAt: meter.resetsAt } : null, grokLimit: g ? { resetsAt: g.resetsAt } : null, today };
  }

  function clear() { records = []; codexSnap = null; codexAt = 0; save(); }
  function setBudget(next) { budget = normalizeBudget(next); save(); return budget; }

  // Lumen quitting ends a `claude -p /usage` still running, with everything it started: left behind, those
  // processes keep running, and on Windows they hold handles inherited from Lumen (a test's pipe to it).
  function shutdown() { if (planChild) killTree(planChild); planChild = null; }
  deps.app?.on?.('will-quit', shutdown);

  return { load, record, summary, planUsage, glance, clear, setBudget, shutdown, budget: () => budget, meter: () => meter };
}

module.exports = { createUsage, codexSummary, parsePlan, fiveHourOf, barFor, otherClaudeActivity, normalizeBudget, periodStart, periodEnd, grokWindows, budgetStatus };
