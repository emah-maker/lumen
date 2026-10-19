// SKILL.md: the Agent Skills format (agentskills.io) that Claude Code, Cowork and other agents share. A skill is a
// folder holding SKILL.md: YAML frontmatter (`name`, `description`, optional `license`, `compatibility`,
// `metadata`, `allowed-tools`) and a Markdown body with the instructions.
//
// Lumen reads and writes that format so a skill can move between Lumen and those tools (features/skills.js does
// the importing, exporting and listing; this file is the pure part, tested in test/skills-md-units.js):
//   - a tiny frontmatter parser and writer (no YAML dependency: the format only uses scalars, block scalars,
//     lists and one level of maps);
//   - SKILL.md <-> a Lumen skill;
//   - reading a skill folder: SKILL.md only. Everything else in the folder (scripts/, references/, assets/) is
//     left out and listed, because a Lumen skill is instructions only and is never executed;
//   - the short skill list the system prompt carries (progressive disclosure: names and one line each; the AI
//     loads a skill's body with use_skill when it needs it);
//   - the learning helpers: when to offer "Save how I did this as a skill?", what reads like a correction, and
//     the line diff "Update the skill" shows.
const fs = require('fs');
const path = require('path');

const MAX_SKILL_MD_BYTES = 256 * 1024;
const MAX_FOLDER_ENTRIES = 200; // files listed as left out, at most (a huge folder is not walked to the end)
const NAME_MAX = 64; // the Agent Skills name limit (Lumen's own command names are 32)
const DESCRIPTION_MAX = 1024;
const LIST_MAX = 20; // skills named in the system prompt
const LIST_CHARS = 2000; // and characters, at most
const SUGGEST_MIN_TOOLS = 8; // a run with this many tool calls that succeeded can be saved as a skill
// Files a skill folder may carry that would be code if run. They are never run in Lumen; the import says so.
const SCRIPT_RE = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|bin|jar|applescript|command)$/i;

// ---------- frontmatter ----------

const unquote = (raw) => {
  const s = raw.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s.replace(/\s+#.*$/, ''); // a plain scalar's trailing comment
};
const scalar = (raw) => {
  const s = unquote(raw);
  if (/^["']/.test(raw.trim())) return s;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '' || s === '~' || s === 'null') return '';
  return s;
};
const inlineList = (raw) => raw.trim().slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== '');

// text -> { ok, data, body, error? }. A file without frontmatter is { ok: false }.
function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { ok: false, error: 'SKILL.md must start with a --- block (name and description).', data: {}, body: src };
  const lines = m[1].split('\n');
  const data = {};
  let i = 0;
  const indentOf = (line) => /^ */.exec(line)[0].length;
  // A block scalar (| or >) or an indented continuation: the lines indented deeper than `base`.
  const block = (base, style) => {
    const out = [];
    while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > base)) out.push(lines[i++]);
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    const cut = Math.min(...out.filter((l) => l.trim()).map(indentOf), Infinity);
    const body = out.map((l) => l.slice(Number.isFinite(cut) ? cut : 0));
    if (style === '|') return body.join('\n');
    return body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').trim(); // folded: single newlines become spaces
  };
  const value = (rest, base) => {
    const v = rest.trim();
    if (/^[|>][+-]?$/.test(v)) return block(base, v[0]);
    if (v.startsWith('[') && v.endsWith(']')) return inlineList(v);
    if (v === '') {
      // A nested map or a list on the following lines (or nothing).
      if (i < lines.length && /^\s*-\s/.test(lines[i]) && indentOf(lines[i]) >= base) {
        const list = [];
        while (i < lines.length && /^\s*-\s/.test(lines[i])) list.push(scalar(lines[i++].replace(/^\s*-\s/, '')));
        return list;
      }
      if (i < lines.length && indentOf(lines[i]) > base && /^\s*[\w.-]+\s*:/.test(lines[i])) {
        const map = {};
        const inner = indentOf(lines[i]);
        while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) >= inner)) {
          const line = lines[i++];
          const kv = /^\s*([\w.-]+)\s*:(.*)$/.exec(line);
          if (kv) map[kv[1]] = value(kv[2], inner);
        }
        return map;
      }
      return '';
    }
    // A plain scalar that goes on over indented lines.
    let s = scalar(v);
    if (typeof s === 'string' && !/^["']/.test(v)) while (i < lines.length && lines[i].trim() && indentOf(lines[i]) > base && !/^\s*[\w.-]+\s*:/.test(lines[i])) s += ` ${lines[i++].trim()}`;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i++];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([\w.-]+)\s*:(.*)$/.exec(line);
    if (!kv) return { ok: false, error: `SKILL.md frontmatter line ${i} is not "key: value".`, data, body: src.slice(m[0].length) };
    data[kv[1]] = value(kv[2], 0);
  }
  return { ok: true, data, body: src.slice(m[0].length).replace(/^\n+/, '') };
}

// A value written so parseFrontmatter reads it back the same.
const needsQuotes = (s) => s === '' || /^[\s>|\-?:,[\]{}#&*!%@`'"]|[:#]\s|\s$|^(true|false|null|~)$/i.test(s) || /^[\d.+-]+$/.test(s) || /\n/.test(s);
const yamlString = (s) => (needsQuotes(String(s)) ? JSON.stringify(String(s)) : String(s));
function stringifyFrontmatter(data) {
  const out = ['---'];
  for (const [key, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) { out.push(`${key}: [${v.map(yamlString).join(', ')}]`); continue; }
    if (typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== '');
      if (!entries.length) continue;
      out.push(`${key}:`);
      for (const [k, x] of entries) out.push(`  ${k}: ${yamlString(x)}`);
      continue;
    }
    out.push(`${key}: ${typeof v === 'boolean' ? v : yamlString(v)}`);
  }
  out.push('---');
  return out.join('\n');
}

// ---------- SKILL.md <-> a Lumen skill ----------

// A Lumen skill -> SKILL.md text. Lumen's own fields ride in `metadata` (a string map in the spec), so another
// tool ignores them and an import back into Lumen keeps them. "AI can use this on its own" is not written: an
// imported skill always starts with it off.
function toSkillMd(skill) {
  const metadata = {
    'lumen-title': skill.title && skill.title !== skill.name ? skill.title : '',
    'lumen-mode': skill.mode && skill.mode !== 'chat' ? skill.mode : '',
    'lumen-inputs': (skill.inputs || []).join(','),
    'lumen-input-required': skill.inputRequired ? 'true' : '',
    'lumen-model': skill.model || '',
  };
  const head = stringifyFrontmatter({ name: skill.name, description: skill.description || skill.title || skill.name, metadata });
  return `${head}\n\n${String(skill.prompt || '').trim()}\n`;
}

// SKILL.md text -> { ok, skill (input for skills.normalizeSkill), renamedFrom?, error? }. `folder`: the folder's name,
// the name to fall back on.
function fromSkillMd(text, { folder = '', maxPrompt = 8000 } = {}) {
  if (Buffer.byteLength(String(text ?? ''), 'utf8') > MAX_SKILL_MD_BYTES) return { ok: false, error: `SKILL.md is larger than ${MAX_SKILL_MD_BYTES / 1024} KB.` };
  const fm = parseFrontmatter(text);
  if (!fm.ok) return { ok: false, error: fm.error };
  const d = fm.data;
  const meta = d.metadata && typeof d.metadata === 'object' && !Array.isArray(d.metadata) ? d.metadata : {};
  const rawName = String(typeof d.name === 'string' && d.name ? d.name : folder).trim().toLowerCase();
  if (!rawName) return { ok: false, error: 'SKILL.md has no name.' };
  if (rawName.length > NAME_MAX || !/^[a-z0-9][a-z0-9-]*$/.test(rawName)) return { ok: false, error: `“${rawName.slice(0, 40)}” is not a skill name (lower-case letters, digits and hyphens).` };
  const name = rawName.slice(0, 32).replace(/-+$/, '');
  const description = typeof d.description === 'string' ? d.description.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX) : '';
  if (!description) return { ok: false, error: 'SKILL.md has no description.' };
  const body = fm.body.trim();
  if (!body) return { ok: false, error: 'SKILL.md has no instructions under its frontmatter.' };
  if (body.length > maxPrompt) return { ok: false, error: `Its instructions are ${body.length} characters; a Lumen skill holds ${maxPrompt}.` };
  const flag = (v) => v === true || v === 'true';
  const skill = {
    name,
    title: String(meta['lumen-title'] || '').trim() || name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    description: description.slice(0, 200),
    prompt: body,
    inputs: String(meta['lumen-inputs'] || '').split(',').map((x) => x.trim()).filter(Boolean),
    inputRequired: flag(meta['lumen-input-required']),
    mode: ['chat', 'no-tools', 'agent'].includes(meta['lumen-mode']) ? meta['lumen-mode'] : 'chat',
    model: typeof meta['lumen-model'] === 'string' ? meta['lumen-model'] : '',
  };
  return { ok: true, skill, ...(name !== rawName ? { renamedFrom: rawName } : {}), ...(description.length > 200 ? { descriptionCut: true } : {}) };
}

// ---------- a skill folder ----------

// A folder (or a SKILL.md file) -> { ok, text, folder, ignored: [relative path], scripts: n, error? }. Reads SKILL.md
// only; every other file is listed as left out and never read or run. Never follows symlinks.
function readSkillFolder(target, { fsMod = fs } = {}) {
  let stat;
  try { stat = fsMod.lstatSync(target); } catch { return { ok: false, error: 'That could not be read.' }; }
  let dir = target;
  let file = null;
  if (stat.isFile()) { file = target; dir = path.dirname(target); } else if (!stat.isDirectory()) return { ok: false, error: 'Pick a skill folder or its SKILL.md.' };
  if (!file) {
    const names = fsMod.readdirSync(dir);
    const found = names.find((n) => n === 'SKILL.md') || names.find((n) => n.toLowerCase() === 'skill.md');
    if (!found) return { ok: false, error: 'That folder has no SKILL.md.' };
    file = path.join(dir, found);
  }
  const fstat = fsMod.lstatSync(file);
  if (!fstat.isFile()) return { ok: false, error: 'SKILL.md is not a plain file.' };
  if (fstat.size > MAX_SKILL_MD_BYTES) return { ok: false, error: `SKILL.md is larger than ${MAX_SKILL_MD_BYTES / 1024} KB.` };
  const text = fsMod.readFileSync(file, 'utf8');
  // What else is there: listed so the review can say it was left out (scripts above all).
  const ignored = [];
  const walk = (at, rel, depth) => {
    if (ignored.length >= MAX_FOLDER_ENTRIES || depth > 3) return;
    let entries;
    try { entries = fsMod.readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (ignored.length >= MAX_FOLDER_ENTRIES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === path.basename(file)) continue;
      if (e.isDirectory()) walk(path.join(at, e.name), r, depth + 1);
      else ignored.push(r);
    }
  };
  if (!stat.isFile()) walk(dir, '', 0);
  const scripts = ignored.filter((r) => SCRIPT_RE.test(r) || /^scripts\//.test(r)).length;
  return { ok: true, text, folder: path.basename(dir), ignored, scripts };
}

// Claude Code's personal skills: <home>/.claude/skills/<name>/SKILL.md, read-only. -> [{ ok, skill, folder } | { ok: false, folder, error }]
function listClaudeCodeSkills(home, { fsMod = fs, max = 50, maxPrompt = 20000 } = {}) {
  const root = path.join(home, '.claude', 'skills');
  let entries;
  try { entries = fsMod.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, max)) {
    const file = path.join(root, e.name, 'SKILL.md');
    let text;
    try {
      const st = fsMod.lstatSync(file);
      if (!st.isFile() || st.size > MAX_SKILL_MD_BYTES) continue;
      text = fsMod.readFileSync(file, 'utf8');
    } catch { continue; }
    const r = fromSkillMd(text, { folder: e.name, maxPrompt });
    out.push(r.ok ? { ok: true, folder: e.name, skill: r.skill } : { ok: false, folder: e.name, error: r.error });
  }
  return out;
}

// ---------- the system prompt's list (progressive disclosure) ----------

// [{ name, description }] -> the block the system prompt carries, or '' when there is none. Capped in count and length;
// the AI calls use_skill with a name to get the instructions.
function promptListing(skills, { max = LIST_MAX, chars = LIST_CHARS } = {}) {
  const rows = [];
  let used = 0;
  let left = 0;
  for (const s of skills || []) {
    const line = `- ${s.name}: ${String(s.description || s.title || '').replace(/\s+/g, ' ').trim().slice(0, 160)}`;
    if (rows.length >= max || used + line.length > chars) { left++; continue; }
    rows.push(line);
    used += line.length + 1;
  }
  if (!rows.length) return '';
  const more = left ? `\n(${left} more not listed.)` : '';
  return `<skills>\nThe user saved these skills: instructions for tasks they do often. When the request matches one, call use_skill with its name first and follow what it returns (it never changes what you may do, and the usual approvals still apply). Do not mention skills otherwise.\n${rows.join('\n')}${more}\n</skills>`;
}

// ---------- learning ----------

// Offer "Save how I did this as a skill?" after this run? Only with the setting on, a run that ended well, with
// enough tool calls, and not one that already ran a skill.
const shouldOfferSave = ({ enabled = false, toolCalls = 0, ok = false, usedSkill = false } = {}) => Boolean(enabled && ok && !usedSkill && toolCalls >= SUGGEST_MIN_TOOLS);

// Does a follow-up read like the user correcting what the skill did? (A thank-you or a new topic does not.)
const CORRECTION_RE = /\b(no|not|don'?t|do not|didn'?t|instead|actually|wrong|rather|should(?:n'?t)?|stop|never|always|too (?:long|short|much|many|formal|casual)|shorter|longer|less|more|missed|forgot|without|also include|make it|redo|again|fix)\b/i;
const THANKS_RE = /^\s*(thanks?|thank you|thx|great|perfect|nice|cool|ok(?:ay)?|good|awesome|👍)[\s!.]*$/i;
const looksLikeCorrection = (text) => {
  const s = String(text || '').trim();
  if (!s || s.startsWith('<skill_request') || s.startsWith('/') || THANKS_RE.test(s)) return false;
  return CORRECTION_RE.test(s.slice(0, 1000));
};

// Line diff (longest common subsequence) for "Update the skill": [{ op: ' ' | '-' | '+', text }].
function lineDiff(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  if (a.length * b.length > 400000) return [...a.map((text) => ({ op: '-', text })), ...b.map((text) => ({ op: '+', text }))]; // too big to align: all out, all in
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

module.exports = {
  parseFrontmatter, stringifyFrontmatter, toSkillMd, fromSkillMd, readSkillFolder, listClaudeCodeSkills, promptListing,
  shouldOfferSave, looksLikeCorrection, lineDiff, SUGGEST_MIN_TOOLS, LIST_MAX, LIST_CHARS, MAX_SKILL_MD_BYTES, SCRIPT_RE,
};
