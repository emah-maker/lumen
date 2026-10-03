// Codex's own settings file (~/.codex/config.toml, or $CODEX_HOME/config.toml): reading whether Lumen is in
// [mcp_servers], and adding or updating just that one entry without touching anything else in the file.
//
// The file is the user's: other servers, profiles, comments, key order and line endings are kept exactly as
// they are. Only the lines of the `lumen` server are rewritten (its command, args and env; other keys the user set
// on it, such as startup_timeout_sec, stay), a new entry goes at the end, and a copy of the old file is kept first.
// Shape written (the same as Codex's own `codex mcp add`, and README.md):
//   [mcp_servers.lumen]
//   command = '<Lumen.exe>'
//   args = ['<app>/mcp.js']
//   env = { ELECTRON_RUN_AS_NODE = "1" }
// This is not a TOML parser: it understands tables, string/array/inline-table values of this one entry, and refuses
// (state 'unsupported') the forms it cannot edit safely (an inline `mcp_servers = { … }`, dotted keys).
const fs = require('fs');
const os = require('os');
const path = require('path');

const codexHome = (env = process.env, homedir = os.homedir()) => (env.CODEX_HOME && String(env.CODEX_HOME).trim()) || path.join(homedir, '.codex');
const configPath = (env, homedir) => path.join(codexHome(env, homedir), 'config.toml');

// ---------- TOML values ----------
function tomlString(s) {
  const v = String(s);
  if (v.includes('\\') && !/['\u0000-\u001f\u007f]/.test(v)) return `'${v}'`; // a literal string for anything with backslashes: no escapes, so a Windows path stays readable
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

// One string at the start of `text`: { value, rest } or null.
function readString(text) {
  const t = text.trimStart();
  if (t[0] === "'") {
    if (t.startsWith("'''")) return null;
    const end = t.indexOf("'", 1);
    return end < 0 ? null : { value: t.slice(1, end), rest: t.slice(end + 1) };
  }
  if (t[0] === '"') {
    if (t.startsWith('"""')) return null;
    let out = '';
    for (let i = 1; i < t.length; i++) {
      const c = t[i];
      if (c === '"') return { value: out, rest: t.slice(i + 1) };
      if (c === '\\') {
        const n = t[++i];
        const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[n];
        if (simple !== undefined) out += simple;
        else if (n === 'u' || n === 'U') { const len = n === 'u' ? 4 : 8; out += String.fromCodePoint(parseInt(t.slice(i + 1, i + 1 + len), 16)); i += len; } else return null;
      } else out += c;
    }
  }
  return null;
}
// ["a", 'b'] -> ['a','b'] (a trailing comma and comments between items are fine), or null.
function readStringArray(text) {
  let t = text.trim();
  if (t[0] !== '[') return null;
  t = t.slice(1);
  const out = [];
  for (;;) {
    t = t.replace(/^(?:\s+|#[^\n]*)+/, '');
    if (t[0] === ']') return out;
    const s = readString(t);
    if (!s) return null;
    out.push(s.value);
    t = s.rest.replace(/^(?:\s+|#[^\n]*)+/, '');
    if (t[0] === ',') t = t.slice(1); else if (t[0] !== ']') return null;
  }
}
// { A = "1", B = 'x' } -> { A: '1', B: 'x' }, or null.
function readInlineTable(text) {
  let t = text.trim();
  if (t[0] !== '{') return null;
  t = t.slice(1);
  const out = {};
  for (;;) {
    t = t.trimStart();
    if (t[0] === '}') return out;
    const km = /^(?:([A-Za-z0-9_-]+)|("(?:[^"\\]|\\.)*")|('[^']*'))\s*=\s*/.exec(t);
    if (!km) return null;
    const key = km[1] || readString(km[2] || km[3]).value;
    const val = readString(t.slice(km[0].length));
    if (!val) return null;
    out[key] = val.value;
    t = val.rest.trimStart();
    if (t[0] === ',') t = t.slice(1); else if (t[0] !== '}') return null;
  }
}

// ---------- the file, as lines ----------
// A table header line: [a.b."c d"] or [[a.b]]. Returns { path: ['a','b','c d'], array } or null.
function parseHeader(line) {
  const m = /^\s*(\[\[?)\s*(.*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
  if (!m) return null;
  const segments = [];
  let rest = m[2];
  while (rest.length) {
    const seg = /^(?:([A-Za-z0-9_-]+)|("(?:[^"\\]|\\.)*")|('[^']*'))\s*(?:\.\s*|$)/.exec(rest);
    if (!seg) return null;
    segments.push(seg[1] || readString(seg[2] || seg[3]).value);
    rest = rest.slice(seg[0].length);
  }
  return segments.length ? { path: segments, array: m[1] === '[[' } : null;
}

// Bracket depth change of a value that continues over lines (arrays), ignoring brackets inside strings and comments.
function depthDelta(text) {
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; } else if (c === '"' || c === "'") {
      const q = c;
      for (i++; i < text.length && text[i] !== q; i++) if (q === '"' && text[i] === '\\') i++;
    } else if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
}

// Splits the text into tables: [{ header: {path,array}|null, start, end (exclusive), keys: [{key,start,end,value}] }].
// A multi-line value is one key spanning several lines. Multi-line strings (""" / ''') mark the file unsupported.
function scan(lines) {
  const tables = [{ header: null, start: 0, end: lines.length, keys: [] }];
  let unsupported = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const header = parseHeader(line);
    if (header) { tables[tables.length - 1].end = i; tables.push({ header, start: i, end: lines.length, keys: [] }); continue; }
    const km = /^\s*((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=\s*(.*)$/.exec(line);
    if (!km) continue;
    let value = km[2];
    if (/"""|'''/.test(value)) { unsupported = true; }
    const start = i;
    let depth = depthDelta(value);
    while (depth > 0 && i + 1 < lines.length) { i++; value += `\n${lines[i]}`; depth = depthDelta(value); }
    tables[tables.length - 1].keys.push({ key: km[1].replace(/\s+/g, ''), start, end: i + 1, value });
  }
  return { tables, unsupported };
}

const isTable = (t, ...p) => t.header && !t.header.array && t.header.path.length === p.length && t.header.path.every((s, i) => s === p[i]);

// The state of the lumen entry in `text` against what we would write.
//   { state: 'absent' | 'same' | 'stale' | 'disabled' | 'unsupported', command, args, ... }
function inspect(text, desired) {
  const lines = String(text || '').split(/\r?\n/);
  const { tables, unsupported } = scan(lines);
  if (unsupported && /(^|\n)\s*(\[mcp_servers|mcp_servers\s*[.=])/.test(text)) return { state: 'unsupported', why: 'The file uses a multi-line string near the MCP settings.' };
  // Forms we cannot edit in place: mcp_servers = { … } or mcp_servers.lumen.* dotted keys at the root / in [mcp_servers].
  const root = tables[0];
  if (root.keys.some((k) => k.key === 'mcp_servers' || /^mcp_servers\./.test(k.key))) return { state: 'unsupported', why: 'mcp_servers is written as an inline table or dotted keys.' };
  if (tables.some((t) => isTable(t, 'mcp_servers') && t.keys.some((k) => k.key === 'lumen' || /^lumen\./.test(k.key)))) return { state: 'unsupported', why: 'The lumen server is written as an inline table.' };
  const main = tables.filter((t) => isTable(t, 'mcp_servers', 'lumen'));
  const envT = tables.filter((t) => isTable(t, 'mcp_servers', 'lumen', 'env'));
  if (main.length > 1 || envT.length > 1) return { state: 'unsupported', why: 'The lumen server appears twice.' };
  if (tables.some((t) => t.header && t.header.path[0] === 'mcp_servers' && t.header.path[1] === 'lumen' && !isTable(t, 'mcp_servers', 'lumen') && !isTable(t, 'mcp_servers', 'lumen', 'env'))) return { state: 'unsupported', why: 'The lumen server has sub-tables other than env.' };
  if (!main.length) return { state: envT.length ? 'unsupported' : 'absent', lines, tables, ...(envT.length ? { why: 'Only the env table of lumen exists.' } : {}) };
  const t = main[0];
  const get = (name) => t.keys.find((k) => k.key === name);
  const cmd = get('command');
  const args = get('args');
  const env = get('env');
  const command = cmd ? readString(cmd.value)?.value ?? null : null;
  const argv = args ? readStringArray(args.value) : null;
  const envValues = env ? readInlineTable(env.value) : envT.length ? Object.fromEntries(envT[0].keys.map((k) => [k.key, readString(k.value)?.value ?? ''])) : {};
  const enabled = get('enabled') ? /^\s*false\b/.test(get('enabled').value) ? false : true : true;
  const same = command !== null && command === desired.command
    && Array.isArray(argv) && argv.length === (desired.args || []).length && argv.every((a, i) => a === desired.args[i])
    && Object.entries(desired.env || {}).every(([k, v]) => envValues?.[k] === v);
  return { state: same ? (enabled ? 'same' : 'disabled') : 'stale', command, args: argv, env: envValues, enabled, lines, tables, main: t, envTable: envT[0] || null, keys: { cmd, args, env } };
}

const newEol = (text) => (/\r\n/.test(text) ? '\r\n' : '\n');
function entryLines(desired, extraEnv = {}) {
  const env = { ...extraEnv, ...(desired.env || {}) };
  return [
    `command = ${tomlString(desired.command)}`,
    `args = [${(desired.args || []).map(tomlString).join(', ')}]`,
    ...(Object.keys(env).length ? [`env = { ${Object.entries(env).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ')} }`] : []),
  ];
}

// The file's new text with the lumen entry present and current, { text, changed, state } (state: what it was).
// desired: { command, args: [..], env: { ELECTRON_RUN_AS_NODE: '1' } }
function mergeLumen(text, desired) {
  const original = String(text || '');
  const info = inspect(original, desired);
  if (info.state === 'unsupported') return { text: original, changed: false, state: 'unsupported', why: info.why };
  const eol = newEol(original);
  if (info.state === 'same' || info.state === 'disabled') return { text: original, changed: false, state: info.state };
  if (info.state === 'absent') {
    const base = original.replace(/(\r?\n)*$/, '');
    const block = ['[mcp_servers.lumen]', ...entryLines(desired)].join(eol);
    return { text: `${base}${base ? eol + eol : ''}${block}${eol}`, changed: true, state: 'absent' };
  }
  // stale: rewrite command / args / env (keeping any other env variable the user put there), leave every other line alone
  const lines = info.lines;
  const drop = new Set();
  for (const k of [info.keys.cmd, info.keys.args, info.keys.env]) if (k) for (let i = k.start; i < k.end; i++) drop.add(i);
  if (info.envTable) for (let i = info.envTable.start; i < info.envTable.end; i++) drop.add(i);
  const fresh = entryLines(desired, info.env && typeof info.env === 'object' ? info.env : {});
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) continue;
    out.push(lines[i]);
    if (i === info.main.start) out.push(...fresh);
  }
  // a removed env sub-table leaves its trailing blank line: collapse the doubled blank lines it made
  const joined = out.join(eol).replace(new RegExp(`(${eol}){3,}`, 'g'), eol + eol);
  return { text: joined, changed: joined !== original, state: 'stale' };
}

// ---------- the file on disk ----------
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
// Writes the merge (after a backup next to the file; the newest three backups are kept). { ok, state, changed, backup?, error? }
function applyToFile(file, desired, io = {}) {
  const f = io.fs || fs;
  let text = '';
  try { text = f.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') return { ok: false, error: `Could not read ${file}: ${err.message}` }; }
  const merged = mergeLumen(text, desired);
  if (merged.state === 'unsupported') return { ok: false, state: 'unsupported', error: `Lumen could not safely edit ${file} (${merged.why}) Add the [mcp_servers.lumen] entry by hand: see Copy next to the button.` };
  if (!merged.changed) return { ok: true, state: merged.state, changed: false };
  try {
    f.mkdirSync(path.dirname(file), { recursive: true });
    let backup;
    if (text) {
      backup = `${file}.lumen-${stamp(io.now ? io.now() : new Date())}.bak`;
      f.writeFileSync(backup, text, { mode: 0o600 });
      const dir = path.dirname(file);
      const mine = f.readdirSync(dir).filter((n) => n.startsWith(`${path.basename(file)}.lumen-`) && n.endsWith('.bak')).sort();
      for (const old of mine.slice(0, -3)) { try { f.unlinkSync(path.join(dir, old)); } catch {} }
    }
    const tmp = `${file}.lumen-tmp`;
    f.writeFileSync(tmp, merged.text);
    f.renameSync(tmp, file);
    return { ok: true, state: merged.state, changed: true, backup };
  } catch (err) {
    return { ok: false, error: `Could not write ${file}: ${err.message}` };
  }
}

// Reads the file's lumen state without changing anything.
function stateOfFile(file, desired, io = {}) {
  let text = '';
  try { text = (io.fs || fs).readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') return { state: 'unreadable', error: err.message }; }
  const { state, why, command, args } = inspect(text, desired);
  return { state, why, command, args };
}

module.exports = { codexHome, configPath, mergeLumen, inspect, applyToFile, stateOfFile, tomlString, readString, readStringArray, readInlineTable };
