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


// [helpers] Rows for what an Antigravity subagent does (full access only: agy keeps its own tools and invoke_subagent). The stream
// has no parent marker on a child's steps (agy's stream-json step_update carries conversation_id of the run, and subagent_info only on
// the parent's own invoke_subagent step), so the rows come from the PreToolUse hook (mcp-http.js agyDecision), whose payload has the
// documented common field conversationId: a subagent is a conversation of its own (parent_conversation_id), so its calls arrive with an
// id that is not the run's. parent(id) is the run's own conversation (the stream's init event, or the saved session). With the parent
// unknown, or the same id on every call, nothing is shown (the behaviour before this). Lumen's own tools are skipped: their rows come
// from the MCP side. The hook has no PostToolUse, so a row ends when that helper's next call starts, or at finish().
const SAFE_CONV = /^[A-Za-z0-9_.-]{1,128}$/;
const clipText = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const baseName = (p) => clipText(String(p || '').split(/[\\/]/).filter(Boolean).pop() || p, 60); // (either separator: a Windows path on any platform)
const arg = (a, ...keys) => { for (const k of keys) if (typeof a?.[k] === 'string' && a[k]) return a[k]; return ''; };
// "Helper · Running npm test": agy's own tool names (run_command, view_file, ...) in plain words, the main argument when it has one.
function helperLabel(name, args) {
  const n = String(name || '').toLowerCase();
  const cmd = arg(args, 'CommandLine', 'command');
  const file = arg(args, 'AbsolutePath', 'TargetFile', 'FilePath', 'Path', 'DirectoryPath');
  let what;
  if (n === 'run_command' && cmd) what = `Running ${clipText(cmd, 70)}`;
  else if ((n === 'view_file' || n === 'read_file') && file) what = `Reading ${baseName(file)}`;
  else if (/^(write_to_file|create_file|edit_file|replace_file_content|multi_replace_file_content)$/.test(n) && file) what = `Editing ${baseName(file)}`;
  else if (n === 'list_dir' && file) what = `Listing ${baseName(file)}`;
  else if (/^(grep_search|find_by_name|search_directory|code_search)$/.test(n)) what = `Searching for ${clipText(arg(args, 'Query', 'Pattern', 'SearchTerm') || 'files', 60)}`;
  else if (/^(read_url_content|read_url)$/.test(n) && arg(args, 'Url', 'URL')) what = `Fetching ${clipText(arg(args, 'Url', 'URL'), 60)}`;
  else if (n === 'search_web') what = `Searching the web for ${clipText(arg(args, 'query', 'Query'), 60)}`;
  else if (n === 'invoke_subagent') what = 'Starting another helper';
  else what = `Using ${n.replace(/^mcp[_-]+/, '').replace(/[_-]+/g, ' ') || 'a tool'}`;
  return `Helper · ${what}`;
}
function helperRows(emit) {
  let parent = null;
  let seq = 0;
  const open = new Map(); // conversation id -> the row id of that helper's last call, still shown as running
  const done = (id) => { try { emit({ type: 'tool_done', id, ok: true }); } catch { /* the run is over */ } };
  return {
    parent(id) { if (typeof id === 'string' && SAFE_CONV.test(id)) parent = id; },
    // A hook payload ({ toolCall: { name, args }, conversationId }): true when it was a subagent's call and a row was started.
    call(msg) {
      const conv = typeof msg?.conversationId === 'string' ? msg.conversationId : '';
      const name = String(msg?.toolCall?.name || '');
      if (!parent || !SAFE_CONV.test(conv) || conv === parent || !name || AGY_LUMEN_PREFIX.test(name)) return false;
      if (open.has(conv)) done(open.get(conv));
      let args = msg.toolCall.args;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
      const id = `agy-${conv.replace(/[^\w-]/g, '').slice(0, 12)}-${++seq}`;
      open.set(conv, id);
      const input = Object.fromEntries(Object.entries(args).slice(0, 8).map(([k, v]) => [k, typeof v === 'string' ? clipText(v, 200) : v]).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))); // (a file's whole text is not a step's detail)
      emit({ type: 'tool', id, name, input, label: helperLabel(name, args) });
      return true;
    },
    // finish(): every helper's last row; finish(conv): that helper's (its invoke_subagent step is done in the stream).
    finish(conv = null) { for (const [c, id] of [...open]) if (!conv || c === conv) { done(id); open.delete(c); } },
  };
}

module.exports = { helperRows, helperLabel, AGY_LUMEN_PREFIX, AGY_READS, descriptorDir, descriptorPathOk, pathArgs, agyAllowed };
