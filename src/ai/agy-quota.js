// [usage] Antigravity's plan quota, read from agy itself: the same numbers agy's own status line shows.
// agy publishes no usage command and prints no quota with -p (stream-json carries tokens only), but its terminal UI fetches
// the plan's quota from Google at start and passes it to the `statusLine` command its settings name, as JSON on stdin:
//   "plan_tier": "Google AI Pro",
//   "quota": { "gemini-5h":     { "remaining_fraction": 0.99, "reset_time": "2026-11-03T03:25:51Z", "reset_in_seconds": 13985 },
//              "gemini-weekly": { … }, "3p-5h": { "remaining_fraction": 0, … }, "3p-weekly": { … } }
// (agy 1.4.12, recorded on this computer 2026-11-02; "3p" is the Claude and GPT models, "gemini" the Gemini ones, each with its own
// 5-hour and weekly window.) ai/agy-quota-probe.js runs that UI for a few seconds in a pseudo console, with no prompt, a throwaway
// HOME (as every Lumen run of agy: ai/antigravity.js buildEnv) and a statusLine command that writes the JSON to a file.
// Lumen sends nothing anywhere: agy makes its own quota request with its own sign-in, as it does every time it starts.
//
//   readQuota({ bin })   -> the parsed reading, or null (not Windows, not signed in, agy too old to pass a quota, or it timed out)
//   parseStatus(json)    -> { at, tier, groups: { gemini: { windows: [{ minutes, percent, resetsAt }] }, '3p': … } } | null
//   groupOf(modelId)     -> which group a picker model draws from ('gemini' | '3p')
//   settingsFor(dir), commandLine(bin, args), STATUS_FILE: what the probe uses
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUS_FILE = 'lumen-agy-status.json';
const PROBE = path.join(__dirname, 'agy-quota-probe.js');

// The settings for the probe's run, passed with --settings (never saved by agy): the statusLine command, and the workspace
// trusted so agy asks nothing. The command has no path and no quote: agy hands it to cmd.exe, which runs it in the workspace.
function settingsFor(dir) {
  return { statusLine: { type: 'command', command: `more > ${STATUS_FILE}` }, trustedWorkspaces: [path.resolve(dir)] };
}

// One argument as CreateProcess's command line parser reads it back (backslashes doubled only before a quote).
function quoteArg(a) {
  const s = String(a);
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
// The whole command line; a .cmd or .bat (a test's fake agy) goes through cmd.exe, which CreateProcess needs for a script.
function commandLine(bin, args = []) {
  const line = [bin, ...args].map(quoteArg).join(' ');
  return /\.(cmd|bat)$/i.test(bin) ? `${quoteArg(process.env.ComSpec || 'cmd.exe')} /d /s /c "${line}"` : line;
}

// A window's length from its name in the quota key: "5h" 300, "weekly" 10080, "daily" 1440, "12h" 720, "30d" 43200; else null.
function minutesOf(name) {
  const s = String(name || '').toLowerCase();
  if (s === 'weekly' || s === 'week') return 7 * 24 * 60;
  if (s === 'daily' || s === 'day') return 24 * 60;
  if (s === 'monthly' || s === 'month') return 30 * 24 * 60;
  const m = /^(\d+)\s*([hdm])$/.exec(s);
  return m ? Number(m[1]) * { h: 60, d: 1440, m: 1 }[m[2]] : null;
}

// The status line JSON -> what Lumen keeps (numbers and the plan's name; not the email or the paths it also carries).
function parseStatus(json, now = Date.now()) {
  const q = json && typeof json === 'object' ? json.quota : null;
  if (!q || typeof q !== 'object') return null;
  const groups = {};
  for (const [key, b] of Object.entries(q)) {
    const m = /^(.+)-([^-]+)$/.exec(key);
    const remaining = Number(b && b.remaining_fraction);
    if (!m || !Number.isFinite(remaining)) continue;
    const at = Date.parse(b.reset_time);
    const secs = Number(b.reset_in_seconds);
    const resetsAt = Number.isFinite(at) ? at : Number.isFinite(secs) ? now + secs * 1000 : null;
    const percent = Math.max(0, Math.min(100, (1 - remaining) * 100));
    (groups[m[1]] ||= { windows: [] }).windows.push({ minutes: minutesOf(m[2]), percent, resetsAt });
  }
  if (!Object.keys(groups).length) return null;
  for (const g of Object.values(groups)) g.windows.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  const tier = typeof json.plan_tier === 'string' && json.plan_tier.trim() ? json.plan_tier.trim().slice(0, 60) : null;
  return { at: now, tier, groups };
}

// Which quota a picker model uses: the Gemini models their own, every other model agy offers (Claude, GPT-OSS) the "3p" one.
// Auto and the default are Gemini (agy's own default model).
function groupOf(modelId) {
  const id = String(modelId || '').replace(/^antigravity:/, '').toLowerCase();
  return !id || /gemini|^auto$|^default$/.test(id) ? 'gemini' : '3p';
}

// Runs the probe. bin: agy's path (ai/antigravity.js findAgy). Resolves the reading or null; never rejects.
function readQuota({ bin, timeoutMs = 12000, spawn = null, platform = process.platform, env = process.env, now = Date.now } = {}) {
  if (platform !== 'win32' || !bin) return Promise.resolve(null);
  const cli = require('./cli-utils'); // (the hidden-spawn helper; a hidden test copy of Lumen never starts the real agy)
  if (cli.testBlocksRealCli(bin)) return Promise.resolve(null);
  spawn ||= cli.spawn;
  let root;
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agy-quota-'));
    for (const d of ['work', 'home']) fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settingsFor(path.join(root, 'work'))));
  } catch { return Promise.resolve(null); }
  const { buildEnv } = require('./antigravity');
  const childEnv = { ...buildEnv({ home: path.join(root, 'home'), base: env }), ELECTRON_RUN_AS_NODE: '1' };
  return new Promise((resolve) => {
    let out = '';
    let child;
    const finish = (text) => {
      clearTimeout(timer);
      require('./temp-dirs').removeDir(root);
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      resolve(parseStatus(json, now()));
    };
    const timer = setTimeout(() => { try { child && child.kill(); } catch {} }, timeoutMs);
    try {
      child = spawn(process.execPath, [PROBE, bin, path.join(root, 'work'), path.join(root, 'settings.json'), String(Math.max(1000, timeoutMs - 3000))], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: childEnv });
    } catch { finish(''); return; }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => finish(''));
    child.on('close', (code) => finish(code === 0 ? out : ''));
  });
}

// The reading as the usage summary shows it: each group's windows still running, marked expired once their reset passed.
function summaryOf(reading, now = Date.now()) {
  if (!reading || !reading.groups) return null;
  const groups = {};
  for (const [name, g] of Object.entries(reading.groups)) {
    groups[name] = { windows: (g.windows || []).map((w) => ({ ...w, expired: w.resetsAt != null && w.resetsAt <= now })) };
  }
  return { readAt: reading.at, tier: reading.tier || null, groups };
}

module.exports = { readQuota, parseStatus, summaryOf, groupOf, minutesOf, settingsFor, commandLine, quoteArg, STATUS_FILE, PROBE };
