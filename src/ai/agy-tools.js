// What an Antigravity run (antigravity.js) may call, in ONE place so the hook gate (mcp-http.js agyDecision, which sees
// { toolCall: { name, args } } before a tool runs) and the stream check (antigravity.js offToolOf, which sees the same call in
// agy's stream-json step) always agree.
//
// Lumen's own tools reach agy as qualified names (mcp_lumen_click, lumen__click, ...). The one built-in agy needs is a
// READ of Lumen's own tool descriptor files (<home>/.gemini/antigravity-cli/mcp/lumen/<tool>.json): agy opens one with view_file
// before it calls the tool (seen in a live run). Nothing else of agy's is allowed: no shell, no writes, no other file.
const path = require('path');

const AGY_LUMEN_PREFIX = /^(?:mcp[_-]{1,2})?lumen(?:__|_|\/|\.|:)([\w-]+)$/i; // mcp_lumen_click, mcp__lumen__click, lumen__click, lumen/click
const AGY_READS = /^(view_file|list_dir)$/i; // read-only, and only of the descriptor folder (descriptorPathOk)
const PATH_KEY = /path|file|dir|target|uri|folder/i;

const descriptorDir = (home) => path.join(home, '.gemini', 'antigravity-cli', 'mcp', 'lumen');

// Every path-like argument of a call (agy's names: AbsolutePath, DirectoryPath, ...), as strings.
function pathArgs(args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return []; } }
  if (!a || typeof a !== 'object') return [];
  return Object.entries(a).filter(([k, v]) => PATH_KEY.test(k) && typeof v === 'string' && v).map(([, v]) => v);
}

// Is every path of the call inside (or is) the descriptor folder of `home`? `required`: a call that names no path at all fails
// (the hook, which fails closed); the stream check passes false and leaves a pathless call to the hook.
function descriptorPathOk(args, home, required = true) {
  const paths = pathArgs(args);
  if (!paths.length) return !required;
  if (!home) return false;
  const win = process.platform === 'win32';
  const norm = (p) => (win ? p.toLowerCase() : p);
  const root = norm(path.resolve(descriptorDir(home)));
  return paths.every((p) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.includes('\0')) return false; // a URL
    const rel = path.relative(root, norm(path.resolve(p)));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

// One verdict for both sides, under the chat home `home`.
// toolNames: Lumen's real tool names (the hook knows them); omitted by the stream check, which accepts any Lumen-qualified name.
function agyAllowed({ name, args, home, toolNames = null, required = true }) {
  const n = String(name || '');
  const m = AGY_LUMEN_PREFIX.exec(n);
  if (m) return !toolNames || toolNames.includes(m[1]);
  return AGY_READS.test(n) && descriptorPathOk(args, home, required);
}

module.exports = { AGY_LUMEN_PREFIX, AGY_READS, descriptorDir, descriptorPathOk, pathArgs, agyAllowed };
