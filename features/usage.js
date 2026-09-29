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
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// What the sidebar's usage bar shows for one engine, from summary()'s data, or null when there is
// nothing real to show (the bar stays hidden rather than guess).
//  - claudecode: the plan's 5-hour limit ({ kind: 'plan', percent, resetsAt | resetsText }), the
//    weekly limit when the plan has one, and Lumen's share of the window.
//  - any other CLI engine: { kind: 'context' }, from the turns' own usage: tokens and cost today, and
//    how full the context window was on the last turn when the CLI reports its size (else percent null).
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
  const e = s.engines?.[engine];
  if (!e || !e.today?.turns || (!e.today.tokens && !e.today.costUSD)) return null;
  const { contextTokens, contextWindow } = e.last || {};
  const percent = contextWindow > 0 && contextTokens > 0 ? Math.min(100, (contextTokens / contextWindow) * 100) : null;
  return { engine, kind: 'context', percent, tokens: e.today.tokens, costUSD: e.today.costUSD, turns: e.today.turns, contextTokens: contextTokens || 0, contextWindow: contextWindow || 0 };
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
  const file = () => path.join(deps.app.getPath('userData'), 'usage.json');

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (Array.isArray(saved.records)) records = saved.records.filter((r) => r && Number.isFinite(r.at));
      if (saved.meter && Number.isFinite(saved.meter.percent)) meter = saved.meter;
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
      fs.promises.writeFile(file(), JSON.stringify({ records, meter })).catch((err) => console.error('[lumen] could not save usage.json:', err.message));
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
  function record(engine, { usage, rateLimit, model } = {}) {
    if (!usage) return;
    let limitPoints = null;
    const beforeAt = meter?.at ?? null;
    if (rateLimit) {
      latestInfo = rateLimit;
      const w = fiveHourOf(rateLimit);
      if (w) limitPoints = reading(w.percent, w.resetsAt, 'turn');
    }
    const rec = {
      at: Date.now(), engine, model: model || (usage.models || [])[0] || null,
      inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0,
      cacheReadTokens: usage.cacheReadTokens || 0, cacheWriteTokens: usage.cacheWriteTokens || 0,
      costUSD: usage.costUSD || 0, limitPoints,
      contextTokens: (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0), contextWindow: usage.contextWindow || 0,
    };
    records.push(rec);
    // The meter is account-wide: if you used Claude Code elsewhere since the reading this turn is
    // measured against, its movement isn't Lumen's, so the share for this turn becomes unknown.
    if (limitPoints != null && beforeAt) {
      (deps.otherActivity || otherClaudeActivity)(beforeAt - 2000).then((other) => { if (other) { rec.limitPoints = null; save(); } }, () => {});
    }
    save();
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
        const timer = setTimeout(() => child.kill(), 30000);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
        child.on('error', (err) => { clearTimeout(timer); resolve({ error: err.message }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      fs.rm(dir, { recursive: true, force: true }, () => {});
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

  // Everything the panel and the meter show.
  async function summary({ refresh = false } = {}) {
    const now = Date.now();
    // The sidebar meter asks after every reply; while a turn's own rate_limit_event has the 5-hour
    // reading fresh, it doesn't need a `claude -p /usage` process (a whole CLI start) each time.
    const passive = !refresh && meterIsFresh(now);
    const planData = passive ? (plan?.data || { available: false, reason: 'Not read yet.' }) : await planUsage({ refresh }).catch((err) => ({ available: false, reason: err.message }));
    const windowStart = meter && meter.resetsAt > now ? meter.resetsAt - FIVE_HOURS : now - FIVE_HOURS;
    const since = (t) => records.filter((r) => r.at >= t);
    const byEngine = {};
    for (const r of since(now - 7 * 24 * 60 * 60 * 1000)) (byEngine[r.engine] ||= []).push(r);
    const today = since(new Date().setHours(0, 0, 0, 0));
    const engines = {};
    for (const name of new Set(records.map((r) => r.engine))) {
      const mine = records.filter((r) => r.engine === name);
      const last = mine[mine.length - 1];
      engines[name] = { today: sum(today.filter((r) => r.engine === name)), last: { at: last.at, contextTokens: last.contextTokens || 0, contextWindow: last.contextWindow || 0 } };
    }
    const result = {
      plan: planData,
      meter: meter && meter.resetsAt > now ? { percent: meter.percent, resetsAt: meter.resetsAt, at: meter.at } : null,
      status: latestInfo ? { status: latestInfo.status || null, overage: latestInfo.isUsingOverage ? 'in use' : latestInfo.overageStatus || null } : null,
      lumen: {
        window: { start: windowStart, ...sum(since(windowStart).filter((r) => r.engine === 'claudecode')) },
        today: sum(since(new Date().setHours(0, 0, 0, 0))),
        week: sum(since(now - 7 * 24 * 60 * 60 * 1000)),
        byEngine: Object.fromEntries(Object.entries(byEngine).map(([k, v]) => [k, sum(v)])),
      },
      engines,
    };
    result.bars = { claudecode: barFor('claudecode', result), grokbuild: barFor('grokbuild', result) };
    return result;
  }

  function clear() { records = []; save(); }

  return { load, record, summary, planUsage, clear, meter: () => meter };
}

module.exports = { createUsage, parsePlan, fiveHourOf, barFor, otherClaudeActivity };
