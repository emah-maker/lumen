// Plain Node checks (no Electron window): address bar URL-or-search detection, the crash-safe
// settings file, Safari import, the Grok Build engine's argv/env/home and its own tool check (runs
// against a fake grok child), and both CLI engines' model choice (--model in the argv, `grok models`
// parsing, the picker entries).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveInput } = require('../search');
const { loadJson, writeJsonAtomic } = require('../settings-file');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

// ---- address bar
const searched = (text) => resolveInput(text, 'google').startsWith('https://www.google.com/search?q=');
for (const [input, want] of [
  ['github.com', 'https://github.com'],
  ['foo.dev', 'https://foo.dev'],
  ['sub.example.co.uk/path?q=1', 'https://sub.example.co.uk/path?q=1'],
  ['example.com:8080/a', 'https://example.com:8080/a'],
  ['localhost:3000', 'http://localhost:3000'],
  ['app.localhost:5173/x', 'http://app.localhost:5173/x'],
  ['192.168.1.1/admin', 'http://192.168.1.1/admin'],
  ['[::1]:8080', 'http://[::1]:8080'],
  ['https://node.js', 'https://node.js'],
  ['about:blank', 'about:blank'],
  // A typed or pasted path opens the file, as in Chrome (spaces included).
  ['/Users/me/My Page.html', 'file:///Users/me/My%20Page.html'],
  [`~/Downloads/a b.pdf`, require('url').pathToFileURL(require('os').homedir() + '/Downloads/a b.pdf').href],
  ['C:\\Users\\me\\page one.html', 'file:///C:/Users/me/page%20one.html'],
]) check(`"${input}" opens ${want}`, resolveInput(input, 'google') === want, resolveInput(input, 'google'));
for (const input of ['node.js', 'next.js', 'notes.txt', 'a.b', 'hello', 'next.js docs', 'user@example.com', 'javascript:alert(1);a.com', 'JavaScript:void(0)', '//server/share', 'what is /etc']) {
  check(`"${input}" is searched`, searched(input), resolveInput(input, 'google'));
}
check('the search engine setting is used', resolveInput('node.js', 'duckduckgo').startsWith('https://duckduckgo.com/'), resolveInput('node.js', 'duckduckgo'));

// ---- settings file
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-units-'));
const file = path.join(dir, 'settings.json');
const quiet = console.error;
console.error = () => {};
try {
  check('a missing file reads as empty settings', JSON.stringify(loadJson(file)) === '{}', JSON.stringify(loadJson(file)));
  writeJsonAtomic(file, { bookmarks: [1], v: 1 });
  writeJsonAtomic(file, { bookmarks: [1, 2], v: 2 });
  check('writes land', loadJson(file).v === 2, JSON.stringify(loadJson(file)));
  check('the previous good file is kept as .bak', JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).v === 1, fs.readFileSync(`${file}.bak`, 'utf8'));
  check('no temp file is left behind', !fs.existsSync(`${file}.tmp`), 'tmp exists');
  // A crash mid-write: the real file is cut off halfway.
  fs.writeFileSync(file, '{"bookmarks": [1, 2], "v"');
  check('a half-written file falls back to the backup', loadJson(file).v === 1, JSON.stringify(loadJson(file)));
  writeJsonAtomic(file, { v: 3 });
  check('writing after a broken file never replaces the good backup with the broken one', JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).v === 1, fs.readFileSync(`${file}.bak`, 'utf8'));
  // Broken with no usable backup: the file is set aside, not overwritten.
  fs.writeFileSync(file, '{broken');
  fs.writeFileSync(`${file}.bak`, 'also broken');
  check('unreadable file and backup read as empty', JSON.stringify(loadJson(file)) === '{}', JSON.stringify(loadJson(file)));
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.corrupt-'));
  check('the unreadable file is kept aside for recovery', aside.length === 1 && fs.readFileSync(path.join(dir, aside[0]), 'utf8') === '{broken', aside.join(','));
} finally {
  console.error = quiet;
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- Safari import (macOS): Bookmarks.plist as XML (what plutil produces) and History.db
const { readBrowser } = require('../importer');
const { DatabaseSync } = require('node:sqlite');
const safari = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fake-safari-'));
try {
  const leaf = (title, url) => `<dict><key>URIDictionary</key><dict><key>title</key><string>${title}</string></dict><key>URLString</key><string>${url}</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict>`;
  fs.writeFileSync(path.join(safari, 'Bookmarks.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Children</key><array>
    <dict><key>Title</key><string>BookmarksBar</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
      <key>Children</key><array>${leaf('Swift &amp; Co', 'https://swift.org/')}
        <dict><key>Title</key><string>Recipes</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>${leaf('Soup', 'https://soup.example/')}</array></dict>
        ${leaf('Local', 'file:///Users/me/notes.txt')}
      </array></dict>
    <dict><key>Title</key><string>com.apple.ReadingList</string><key>Children</key><array>${leaf('Later', 'https://later.example/')}</array></dict>
  </array>
  <key>WebBookmarkFileVersion</key><integer>1</integer><key>Sync</key><true/>
</dict></plist>`);
  const db = new DatabaseSync(path.join(safari, 'History.db'));
  db.exec('CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER); CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)');
  db.prepare('INSERT INTO history_items VALUES (1, ?, 9)').run('https://www.apple.com/');
  db.prepare('INSERT INTO history_visits VALUES (1, 1, ?, ?)').run((Date.UTC(2026, 8, 1) / 1000) - 978307200, 'Apple');
  db.close();
  const data = readBrowser('safari', safari);
  check('Safari bookmarks are read (web only, folders kept, Reading List left out)', JSON.stringify(data.bookmarks) === JSON.stringify([{ url: 'https://swift.org/', title: 'Swift & Co' }, { url: 'https://soup.example/', title: 'Soup', folder: 'Recipes' }]), JSON.stringify(data.bookmarks));
  check('Safari history is read with its dates', data.history.length === 1 && data.history[0].url === 'https://www.apple.com/' && data.history[0].last === Date.UTC(2026, 8, 1) && data.history[0].visits === 9, JSON.stringify(data.history));
} finally {
  fs.rmSync(safari, { recursive: true, force: true });
}

// ---- Grok Build engine: argv, env and its own GROK_HOME (grok-build.js)
const gb = require('../grok-build');
const gbData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-gb-'));
try {
  const argv = gb.buildArgs({ promptFile: 'p.json', sessionId: 'id', resume: false, systemPrompt: 'sys', cwd: 'cwd' });
  const allows = argv.flatMap((a, i) => (argv[i - 1] === '--allow' ? [a] : []));
  check('Grok Build allows Lumen MCP tools, search_tool and run_terminal_command (gated per call by Lumen\'s own PreToolUse hook), not use_tool itself', JSON.stringify(allows) === JSON.stringify(['lumen__*', 'search_tool', 'run_terminal_command']) && !argv.includes('use_tool'), JSON.stringify(allows));
  check('Grok Build leaves the terminal to Lumen\'s gate instead of --deny, and runs under dontAsk', !argv.some((a, i) => a === '--deny' && argv[i + 1] === 'run_terminal_command') && argv[argv.indexOf('--permission-mode') + 1] === 'dontAsk', argv.join(' '));

  const env = gb.buildEnv({ userData: gbData, base: { PATH: 'x', GROK_HOME: '/users/real/.grok', GROK_CLAUDE_MCPS_ENABLED: '1', GROK_CONFIG: '{}', ELECTRON_RUN_AS_NODE: '1' } });
  check('Grok Build GROK_HOME is Lumen\'s own folder under userData, not the user\'s', env.GROK_HOME === path.join(gbData, 'grok-home') && env.GROK_HOME === gb.grokHomeFor(gbData), env.GROK_HOME);
  check('Grok Build turns off its Claude/Cursor imports in the env (beats config.toml)', env.GROK_CLAUDE_MCPS_ENABLED === '0' && env.GROK_CURSOR_MCPS_ENABLED === '0' && env.GROK_CLAUDE_HOOKS_ENABLED === '0', JSON.stringify(env));
  check('Grok Build env drops config overlays and ELECTRON_RUN_AS_NODE', !('GROK_CONFIG' in env) && !('ELECTRON_RUN_AS_NODE' in env) && env.PATH === 'x', JSON.stringify(env));
  const scrubbed = gb.buildEnv({ userData: gbData, base: { Path: 'p', SystemRoot: 'C:\\Windows', TEMP: 't', HTTPS_PROXY: 'http://proxy', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-2', XAI_API_KEY: 'xai-1', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 'aws', NPM_CONFIG_USERCONFIG: 'x', GROK_SANDBOX: 'off', LUMEN_GB_DEBUG: 'f' } });
  check('Grok Build env keeps what a process needs to start and reach the network', scrubbed.Path === 'p' && scrubbed.SystemRoot === 'C:\\Windows' && scrubbed.TEMP === 't' && scrubbed.HTTPS_PROXY === 'http://proxy' && scrubbed.LANG === 'en_US.UTF-8', JSON.stringify(scrubbed));
  check('Grok Build env keeps XAI_API_KEY (Grok\'s own API-key sign-in)', scrubbed.XAI_API_KEY === 'xai-1', JSON.stringify(scrubbed));
  check('Grok Build env drops other API keys, tokens and the user\'s own GROK_* settings', !['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_CONFIG_USERCONFIG', 'GROK_SANDBOX', 'LUMEN_GB_DEBUG'].some((k) => k in scrubbed), JSON.stringify(scrubbed));
  check('Grok Build env: HOME and USERPROFILE are the empty sidebar folder, GROK_HOME Lumen\'s', scrubbed.HOME === path.join(gbData, 'grok-sidebar') && scrubbed.USERPROFILE === scrubbed.HOME && scrubbed.GROK_HOME === gb.grokHomeFor(gbData), JSON.stringify(scrubbed));

  // Lumen's own check on the tool calls Grok reports.
  check('tool check: Lumen\'s tools pass (lumen__read_page, search_tool, use_tool -> lumen__x, run_terminal_command -- gated per call by the PreToolUse hook, not this check)', gb.isLumenTool('lumen__read_page') && gb.isLumenTool('search_tool', { query: 'page' }) && gb.isLumenTool('use_tool', { tool_name: 'lumen__x', tool_input: {} }) && gb.isLumenTool('run_terminal_command', { command: 'echo' }), 'rejected a Lumen tool');
  check('tool check: other tools are refused (use_tool -> other__x, Bash, edit_file)', ![['use_tool', { tool_name: 'other__x' }], ['Bash'], ['edit_file'], ['use_tool', {}], ['use_tool', null], ['use_tool', { tool_name: 'xlumen__a' }], ['lumen__'], ['web_search']].some(([n, i]) => gb.isLumenTool(n, i)), 'accepted a non-Lumen tool');
  const streamed = (lines) => { const w = gb.toolWatch(); for (const l of lines) { const bad = w(l); if (bad) return bad; } return null; };
  const ev = (event) => ({ type: 'stream_event', event });
  const useTool = (name, index = 1) => [ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'c', name: 'use_tool', input: {} } }), ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ tool_name: name, tool_input: {} }) } }), ev({ type: 'content_block_stop', index })];
  check('tool check (stream): a built-in is caught at content_block_start', streamed([ev({ type: 'message_start' }), ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'edit_file', input: {} } })]) === 'edit_file', 'missed');
  check('tool check (stream): run_terminal_command is left alone here (Lumen\'s PreToolUse gate already judged it, per call)', streamed([ev({ type: 'message_start' }), ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'run_terminal_command', input: {} } })]) === null, 'caught');
  check('tool check (stream): use_tool is judged by the tool it names', streamed(useTool('lumen__read_page')) === null && streamed(useTool('other__probe')) === 'use_tool other__probe', streamed(useTool('other__probe')));
  check('tool check (stream): a use_tool whose input never parses is refused', streamed([ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'use_tool', input: {} } }), ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"tool_na' } }), ev({ type: 'content_block_stop', index: 2 })]) === 'use_tool (unreadable)', 'accepted');
  check('tool check (stream): hosted server tools and whole assistant messages are checked too', streamed([ev({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search' } })]) === 'web_search' && streamed([{ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'edit_file', input: {} }] } }]) === 'edit_file' && streamed([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'use_tool', input: { tool_name: 'lumen__click' } }] } }]) === null, 'missed');

  const toml = gb.grokConfig({ gate: 'C:\\Lumen\\grok-home\\lumen-gate.cmd' });
  const servers = [...toml.matchAll(/^\[mcp_servers\.([^\].]+)\]$/gm)].map((m) => m[1]);
  check('Grok Build config.toml has only the lumen MCP server', JSON.stringify(servers) === '["lumen"]', JSON.stringify(servers));
  check('Grok Build config.toml reaches Lumen over HTTP with the token from the env, no secret on disk', toml.includes('url = "${LUMEN_MCP_URL}"') && toml.includes('"Bearer ${LUMEN_MCP_TOKEN}"') && !/Lumen\.exe/.test(toml) && !/[a-f0-9]{40}/.test(toml), toml);
  check('Grok Build config.toml runs Lumen\'s gate on every prompt and every tool call (no matcher)', toml.includes('[[hooks.UserPromptSubmit]]\nhooks = [{ type = "command", command = "C:\\\\Lumen\\\\grok-home\\\\lumen-gate.cmd", timeout = 30 }]') && toml.includes('[[hooks.PreToolUse]]\nhooks = [{ type = "command", command = "C:\\\\Lumen\\\\grok-home\\\\lumen-gate.cmd", timeout = 30 }]') && !/matcher/.test(toml), toml);
  check('Grok Build gate script: a gate it can\'t reach is a deny (exit 2), on Windows and elsewhere', /curl\.exe" -s -f .*"%LUMEN_HOOK_URL%" \|\| exit \/b 2\r\n$/.test(gb.gateScript('win32')) && /^#!\/bin\/sh\ncurl -s -f .*"\$LUMEN_HOOK_URL" \|\| exit 2\n$/.test(gb.gateScript('darwin')), gb.gateScript('win32') + gb.gateScript('linux'));
  const gd = require('../mcp-http').gateDecision;
  const names = ['navigate', 'read_page'];
  check('Grok gate allows search_tool and Lumen\'s own tools', gd('search_tool', names) === null && gd('lumen__navigate', names) === null && gd('lumen__read_page', names) === null, 'denied');
  check('Grok gate denies built-ins, other servers, unknown lumen__ names and use_tool itself', ['run_terminal_command', 'read_file', 'Bash', 'other__ping', 'lumen__nope', 'lumen__', 'lumen__navigate/x', 'xlumen__navigate', 'use_tool', '', undefined].every((n) => gd(n, names)?.hookSpecificOutput?.permissionDecision === 'deny'), 'allowed one');
  check('Grok Build status: an XAI_API_KEY sign-in counts as signed in', JSON.stringify(gb.parseGrokModels('You are using XAI_API_KEY.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n')) === JSON.stringify({ signedIn: true, detail: 'grok-4.6', models: ['grok-4.6', 'grok-4.5'] }), JSON.stringify(gb.parseGrokModels('You are using XAI_API_KEY.\n\nDefault model: grok-4.6\n')));
  check('Grok Build config.toml turns off Claude and Cursor MCP imports', /\[compat\.claude\][^[]*mcps = false/.test(toml) && /\[compat\.cursor\][^[]*mcps = false/.test(toml), toml);

  // Sign-in: only auth.json is shared, and a refreshed token goes back to the user's file.
  const userHome = path.join(gbData, 'user-grok');
  const home = gb.grokHomeFor(gbData);
  fs.mkdirSync(userHome); fs.mkdirSync(home);
  fs.writeFileSync(path.join(userHome, 'auth.json'), 'token-1');
  fs.writeFileSync(path.join(userHome, 'config.toml'), '[mcp_servers.other]');
  const before = gb.linkAuth(userHome, home);
  check('Grok Build shares the user\'s auth.json with its own home', fs.readFileSync(path.join(home, 'auth.json'), 'utf8') === 'token-1', fs.readdirSync(home).join(','));
  check('Grok Build does not copy the user\'s config.toml', !fs.existsSync(path.join(home, 'config.toml')), fs.readdirSync(home).join(','));
  fs.rmSync(path.join(home, 'auth.json')); // Grok replacing the file on a token refresh
  fs.writeFileSync(path.join(home, 'auth.json'), 'token-2');
  check('Grok Build copies a refreshed token back when the user\'s file is unchanged', gb.settleAuth(userHome, home, before) && fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8') === 'token-2', fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8'));
  const again = gb.linkAuth(userHome, home);
  fs.rmSync(path.join(home, 'auth.json'));
  fs.writeFileSync(path.join(home, 'auth.json'), 'token-3');
  fs.writeFileSync(path.join(userHome, 'auth.json'), 'token-new-login-longer'); // the user signed in again meanwhile
  check('Grok Build never overwrites a newer sign-in of the user\'s', !gb.settleAuth(userHome, home, again) && fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8') === 'token-new-login-longer', fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8'));
  fs.rmSync(path.join(userHome, 'auth.json'));
  gb.linkAuth(userHome, home);
  check('Grok Build signed out: no auth.json is left in its home', !fs.existsSync(path.join(home, 'auth.json')), fs.readdirSync(home).join(','));
} finally {
  fs.rmSync(gbData, { recursive: true, force: true });
}

// Grok Build runs against a fake grok child: `script` is the stream it prints (one JSON object per
// line; a function in it runs instead, e.g. to bring Lumen's tools up), or a list of those, one per
// spawn; a kill ends it (close with no exit code), as taskkill would. Resolves the run's result, the
// events it emitted, the kills and the spawn calls. Nothing touches the user's own ~/.grok.
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
async function fakeGrokRun(script, { run = {}, engine: extra = {} } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-gbrun-'));
  const savedHome = process.env.GROK_HOME;
  process.env.GROK_HOME = path.join(data, 'user-grok'); // userGrokHome(): no auth.json there
  const scripts = Array.isArray(script[0]) ? script : [script];
  const kills = [];
  const spawns = [];
  let spawned = null;
  const spawn = (bin, argv, opts) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 4242 + spawns.length, exitCode: null, killed: false, stdout: new PassThrough(), stderr: new PassThrough() });
    spawned = { bin, argv, opts, child };
    const lines = scripts[Math.min(spawns.length, scripts.length - 1)];
    spawns.push(spawned);
    (async () => {
      for (const line of lines) {
        if (child.killed) return;
        if (typeof line === 'function') line();
        else if (line.stderr) child.stderr.write(`${line.stderr}\n`);
        else child.stdout.write(`${JSON.stringify(line)}\n`);
        await new Promise((r) => setImmediate(r));
      }
      child.exitCode = 0;
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    })();
    return child;
  };
  const kill = (child) => {
    kills.push(child.pid);
    if (child.killed) return;
    child.killed = true;
    child.stdout.end();
    setImmediate(() => child.emit('close', null));
  };
  const gate = { opened: [], closed: [], armed: () => extra.armed !== false, listed: () => true, open(tag) { this.opened.push(tag); return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'm'.repeat(48), hookUrl: `http://127.0.0.1:1/hook/${'h'.repeat(48)}` }; }, close(tag) { this.closed.push(tag); } };
  const engine = new gb.GrokBuildEngine({ userData: data, gate: async () => gate, spawn, kill, ...extra });
  engine.detect = async () => 'grok.exe';
  const events = [];
  try {
    const out = await engine.run({ prompt: 'hi', sessionId: 'id-1', resume: false, systemPrompt: 'S', signal: new AbortController().signal, emit: (e) => events.push(e), ...run });
    return { out, events, kills, spawned, spawns, data, engine, gate };
  } finally {
    if (savedHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = savedHome;
    fs.rmSync(data, { recursive: true, force: true });
  }
}
const gbEv = (event) => ({ type: 'stream_event', event });
const gbText = (index, text) => [gbEv({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }), gbEv({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })];
const gbUse = (index, name) => [gbEv({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `c${index}`, name: 'use_tool', input: {} } }), gbEv({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ tool_name: name, tool_input: {} }) } }), gbEv({ type: 'content_block_stop', index })];
const gbInit = { type: 'system', subtype: 'init', session_id: 'id-1', mcp_servers: [{ name: 'lumen', status: 'pending' }] };
const gbDone = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'id-1', total_cost_usd: 0.01 });
// Lumen's HTTP MCP server and gate for Grok Build (mcp-http.js), on a real localhost port.
async function grokGateServer() {
  const calls = [];
  const gate = await require('../mcp-http').startHttp({ tools: [{ name: 'ping', description: 'p', input_schema: { type: 'object' } }], callTool: async (name, args, session) => { calls.push([name, session.engine]); return { content: [{ type: 'text', text: 'pong' }], isError: false }; }, holdMs: 300 });
  const http = require('http');
  const post = (url, body, headers = {}) => new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    req.end(JSON.stringify(body));
  });
  try {
    const run = gate.open('tag-1');
    const auth = { authorization: `Bearer ${run.mcpToken}` };
    check('Grok gate server: MCP without the run token is refused (401)', (await post(run.mcpUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status === 401 && (await post(run.mcpUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${'0'.repeat(48)}` })).status === 401, 'accepted');
    check('Grok gate server: a request from a web page (Origin) or another Host is refused (403)', (await post(run.mcpUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...auth, origin: 'https://evil.test' })).status === 403 && (await post(run.mcpUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...auth, host: `evil.test:${gate.port}` })).status === 403, 'accepted');
    const armedRes = post(run.hookUrl, { hook_event_name: 'UserPromptSubmit' });
    const init = await post(run.mcpUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'grok' } } }, auth);
    const list = await post(run.mcpUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
    const call = await post(run.mcpUrl, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } }, auth);
    check('Grok gate server: initialize, tools/list and tools/call work with the token, tagged with the run', init.body?.result?.serverInfo?.name === 'lumen' && list.body?.result?.tools?.[0]?.name === 'ping' && call.body?.result?.content?.[0]?.text === 'pong' && JSON.stringify(calls) === '[["ping","tag-1"]]' && gate.listed('tag-1'), JSON.stringify({ init: init.body, list: list.body, call: call.body, calls }));
    check('Grok gate server: UserPromptSubmit arms the run', (await armedRes).status === 200 && gate.armed('tag-1'), 'not armed');
    const pre = (name) => post(run.hookUrl, { hook_event_name: 'PreToolUse', tool_name: name, tool_input: {} }).then((r) => r.body?.hookSpecificOutput?.permissionDecision || 'allow');
    check('Grok gate server: PreToolUse allows lumen__ping and search_tool, denies the rest', await pre('lumen__ping') === 'allow' && await pre('search_tool') === 'allow' && await pre('run_terminal_command') === 'deny' && await pre('other__ping') === 'deny' && JSON.stringify(gate.allowed('tag-1')) === '["lumen__ping","search_tool"]', JSON.stringify(gate.allowed('tag-1')));
    gate.close('tag-1');
    const late = await post(run.hookUrl, { hook_event_name: 'PreToolUse', tool_name: 'lumen__ping' });
    check('Grok gate server: after the run, its hook URL denies and its MCP token is refused', late.body?.hookSpecificOutput?.permissionDecision === 'deny' && (await post(run.mcpUrl, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, auth)).status === 401 && !gate.armed('tag-1'), JSON.stringify(late.body));
  } finally {
    gate.stop();
  }
}

// The PreToolUse gate's decision for run_terminal_command specifically (mcp-http.js terminalDecision):
// grokGateServer() above covers the no-onTerminalApproval default (an automatic deny, unchanged from
// before this existed); this covers the approval flow itself, isolated from the real grok CLI and
// Electron. "always" is remembered per chat session (the 2nd arg to open(), grok-build.js's Grok
// session id), not per message tag, and never leaks across chats.
async function grokTerminalApproval() {
  const asked = [];
  const answers = ['once', 'always', 'deny']; // consumed in order, one per ask
  const gate = await require('../mcp-http').startHttp({
    tools: [],
    callTool: async () => ({ content: [], isError: false }),
    onTerminalApproval: async (tag, command) => { asked.push({ tag, command }); return answers[asked.length - 1]; },
    terminalHoldMs: 500,
  });
  const http = require('http');
  const post = (url, body) => new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    req.end(JSON.stringify(body));
  });
  const term = (run) => post(run.hookUrl, { hook_event_name: 'PreToolUse', tool_name: 'run_terminal_command', tool_input: { command: 'echo hi' } }).then((r) => r.body?.hookSpecificOutput?.permissionDecision || 'allow');
  try {
    const run1 = gate.open('t1', 'chatA'); // message 1 of chat A: asked, 'once' allows just this call
    check('Grok gate: run_terminal_command with onTerminalApproval asks, and "once" allows that call', await term(run1) === 'allow' && asked.length === 1 && asked[0].command === 'echo hi', JSON.stringify(asked));
    gate.close('t1');

    const run2 = gate.open('t2', 'chatA'); // message 2, same chat: "once" wasn't remembered, asks again
    check('Grok gate: "once" is not remembered -- the next message in the same chat asks again', await term(run2) === 'allow' && asked.length === 2, JSON.stringify(asked));
    gate.close('t2');

    const run3 = gate.open('t3', 'chatA'); // message 3, same chat: "always" (from message 2) is remembered
    check('Grok gate: "always" is remembered for the rest of this chat -- no third ask', await term(run3) === 'allow' && asked.length === 2, JSON.stringify(asked));
    gate.close('t3');

    const run4 = gate.open('t4', 'chatB'); // a different chat: never said "always", asked on its own
    check('Grok gate: a different chat session is asked on its own; another chat\'s "always" doesn\'t leak into it', await term(run4) === 'deny' && asked.length === 3, JSON.stringify(asked));
    gate.close('t4');
  } finally {
    gate.stop();
  }

  // A stuck onTerminalApproval (never resolves, e.g. a card left unanswered) times out to a deny
  // instead of hanging -- same fail-closed default as an unreachable gate.
  const stuckAsked = [];
  const stuckGate = await require('../mcp-http').startHttp({
    tools: [],
    callTool: async () => ({ content: [], isError: false }),
    onTerminalApproval: async (_tag, command) => { stuckAsked.push(command); return new Promise(() => {}); },
    terminalHoldMs: 200,
  });
  try {
    const srun = stuckGate.open('s1', 'chatC');
    const before = Date.now();
    const decision = await term(srun);
    check('Grok gate: an unanswered approval times out to a deny (fail-closed), not a hang', decision === 'deny' && Date.now() - before < 5000 && stuckAsked.length === 1, JSON.stringify({ decision, elapsed: Date.now() - before }));
  } finally {
    stuckGate.stop();
  }
}

async function grokRuns() {
  {
    const { out, events, kills, spawned } = await fakeGrokRun([gbInit, gbEv({ type: 'message_start' }), ...gbText(0, 'Let me look.'), gbEv({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'edit_file', input: {} } }), ...gbText(2, 'LEAKED'), gbDone('LEAKED')]);
    const error = events.find((e) => e.type === 'error');
    check('Grok Build run: a built-in tool call kills the process tree at once', kills.length === 1 && kills[0] === spawned.child.pid, JSON.stringify(kills));
    check('Grok Build run: it ends as failed, with an error naming the tool, and drops the session', out.failed === true && out.sessionId === null && /isn't one of Lumen's \(edit_file\)/.test(error?.text || ''), JSON.stringify({ out, error }));
    check('Grok Build run: nothing after the off-limits call reaches the sidebar', !events.some((e) => /LEAKED/.test(e.text || '')) && !/LEAKED/.test(out.text), JSON.stringify(events));
    check('Grok Build run: the child gets the scrubbed env and the empty sidebar folder as cwd', spawned.opts.cwd.endsWith('grok-sidebar') && spawned.opts.env.HOME === spawned.opts.cwd && spawned.opts.stdio[0] === 'ignore' && spawned.opts.shell === false && !Object.keys(spawned.opts.env).some((k) => /API_KEY|TOKEN|SECRET/i.test(k) && !['LUMEN_MCP_TOKEN', 'XAI_API_KEY'].includes(k)), JSON.stringify(spawned.opts));
  }
  {
    // run_terminal_command is no longer an automatic kill here: Lumen's PreToolUse gate (mcp-http.js
    // terminalDecision) is what judges it now, per call, before it ever runs -- this stream-level
    // check (the last-resort layer) just needs to leave it alone once it's been reported.
    const { out, events, kills } = await fakeGrokRun([gbInit, gbEv({ type: 'message_start' }), ...gbText(0, 'Running it.'), gbEv({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'run_terminal_command', input: {} } }), ...gbText(2, ' Done.'), gbDone('Running it. Done.')]);
    check('Grok Build run: run_terminal_command in the stream is not killed here (the gate already judged it)', kills.length === 0 && out.failed !== true && out.text === 'Running it. Done.', JSON.stringify({ out, events, kills }));
  }
  {
    const { out, spawned, gate } = await fakeGrokRun([gbInit, gbEv({ type: 'message_start' }), ...gbText(0, 'Hi.'), gbDone('Hi.')]);
    const env = spawned.opts.env;
    check('Grok Build run: the child gets this run\'s MCP URL, token and gate URL in its env only', env.LUMEN_MCP_URL === 'http://127.0.0.1:1/mcp' && env.LUMEN_MCP_TOKEN === 'm'.repeat(48) && env.LUMEN_HOOK_URL.endsWith('h'.repeat(48)) && out.text === 'Hi.', JSON.stringify(env));
    check('Grok Build run: the gate is opened for the run and closed after it', gate.opened.length === 1 && JSON.stringify(gate.closed) === JSON.stringify(gate.opened), JSON.stringify(gate));
  }
  {
    // Grok answering before Lumen's gate saw the turn's UserPromptSubmit: hooks not loaded.
    const { out, events, kills } = await fakeGrokRun([gbInit, gbEv({ type: 'message_start' }), ...gbText(0, 'LEAKED'), gbEv({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'run_terminal_command', input: {} } }), gbDone('LEAKED')], { engine: { armed: false } });
    check('Grok Build run: model output before Lumen\'s gate is armed stops the run at once', kills.length === 1 && out.failed === true && out.sessionId === null && /couldn't confirm its check/.test(events.find((e) => e.type === 'error')?.text || ''), JSON.stringify({ out, events, kills }));
    check('Grok Build run: nothing of an unguarded run reaches the sidebar', !events.some((e) => /LEAKED/.test(e.text || '')) && !/LEAKED/.test(out.text), JSON.stringify(events));
  }
  await grokGateServer();
  await grokTerminalApproval();
  {
    const { out, kills, events } = await fakeGrokRun([gbInit, gbEv({ type: 'message_start' }), ...gbUse(0, 'other__probe'), gbDone('probed')]);
    check('Grok Build run: use_tool on another server is stopped the same way', kills.length === 1 && out.failed && /use_tool other__probe/.test(events.find((e) => e.type === 'error')?.text || ''), JSON.stringify({ out, kills }));
  }
  {
    const { out, kills, events } = await fakeGrokRun([gbInit, gbEv({ type: 'message_start' }), ...gbUse(0, 'lumen__read_page'), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c0', content: 'ok' }] } }, gbEv({ type: 'message_start' }), ...gbText(0, 'The page says hi.'), gbDone('The page says hi.')]);
    check('Grok Build run: Lumen\'s own tools run to the end untouched', kills.length === 0 && !out.failed && out.text === 'The page says hi.' && out.sessionId === 'id-1' && !events.some((e) => e.type === 'error'), JSON.stringify({ out, kills, events }));
  }

  // A chat's first message waits for Lumen's tools. Grok's own log line about its MCP wait decides
  // (lines as grok 1.0.41 prints them, colour codes included once); lumenReady is the fallback.
  const thinking = (index, t) => [gbEv({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }), gbEv({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } })];
  const flag = (argv, f) => argv[argv.indexOf(f) + 1];
  const late = '\x1b[2m2026-09-28T13:55:59.920798Z\x1b[0m \x1b[32m INFO\x1b[0m wait_for_mcp_handshakes_until: done session_id=5b3a outcome=DeadlineExpired elapsed_ms=2003 final_initializing_names=["lumen"] final_client_names=[]';
  const onTime = '2026-09-28T13:56:16.819695Z  INFO wait_for_mcp_handshakes_until: wait_for_mcp_handshakes_until: done session_id=50ea outcome=Complete elapsed_ms=2 final_initializing_names=[] final_client_names=["lumen"]';
  check('MCP wait line: lumen late / on time / other lines', JSON.stringify(gb.mcpWait(late)) === '{"lumen":false}' && JSON.stringify(gb.mcpWait(onTime)) === '{"lumen":true}' && gb.mcpWait('some other log line') === null && gb.mcpWait('wait_for_mcp_handshakes_until: done final_client_names=["other"]').lumen === false, JSON.stringify([gb.mcpWait(late), gb.mcpWait(onTime)]));
  check('Grok Build env turns on only that log line, without colour', gb.buildEnv({ userData: 'u', base: { RUST_LOG: 'debug' } }).RUST_LOG === 'off,xai_grok_shell::session::acp_session::mcp_snapshot=info' && gb.buildEnv({ userData: 'u', base: {} }).NO_COLOR === '1', gb.buildEnv({ userData: 'u', base: {} }).RUST_LOG);
  {
    let ready = false;
    const { out, events, kills, spawns } = await fakeGrokRun([
      [{ stderr: late }, () => { ready = true; }, gbInit, gbEv({ type: 'message_start' }), ...thinking(0, 'Lumen is still connecting'), ...gbText(1, 'BLIND'), gbDone('BLIND')],
      [{ stderr: onTime }, { ...gbInit, session_id: 'id-2' }, gbEv({ type: 'message_start' }), ...gbText(0, 'The page says hi.'), { ...gbDone('The page says hi.'), session_id: 'id-2' }],
    ], { engine: { lumenReady: () => ready } });
    check('Grok Build first message: grok\'s log saying lumen was late means a retry, even if the bridge came up since', spawns.length === 2 && kills.length === 1 && out.text === 'The page says hi.' && out.sessionId === 'id-2' && !events.some((e) => /BLIND|still connecting/.test(e.text || '')), JSON.stringify({ out, events, n: spawns.length }));
  }
  {
    const { out, events, spawns } = await fakeGrokRun([{ stderr: onTime }, gbInit, gbEv({ type: 'message_start' }), ...gbText(0, 'Hi.'), gbDone('Hi.')], { engine: { lumenReady: () => false } });
    check('Grok Build first message: grok\'s log saying lumen was connected lets the reply through', spawns.length === 1 && out.text === 'Hi.' && events.some((e) => e.text === 'Hi.'), JSON.stringify({ out, events }));
  }
  {
    let ready = false;
    const blind = [gbInit, gbEv({ type: 'message_start' }), ...thinking(0, 'no tools?'), ...gbText(1, 'BLIND: I cannot see your page.'), gbDone('BLIND')];
    const warm = [() => { ready = true; }, { ...gbInit, session_id: 'id-2' }, gbEv({ type: 'message_start' }), ...gbText(0, 'The page says hi.'), { ...gbDone('The page says hi.'), session_id: 'id-2' }];
    const { out, events, kills, spawns } = await fakeGrokRun([blind, warm], { engine: { lumenReady: () => ready } });
    check('Grok Build first message: a reply begun before Lumen\'s tools are up is stopped and sent again', spawns.length === 2 && kills.length === 1 && kills[0] === spawns[0].child.pid && out.text === 'The page says hi.' && !out.failed, JSON.stringify({ out, kills, n: spawns.length }));
    check('Grok Build first message: nothing of the stopped try reaches the sidebar', !events.some((e) => /BLIND|no tools/.test(e.text || '')) && !events.some((e) => e.type === 'error' || e.type === 'notice'), JSON.stringify(events));
    check('Grok Build first message: the second try is a new session with the same prompt file', flag(spawns[0].argv, '--session-id') === 'id-1' && flag(spawns[1].argv, '--session-id') !== 'id-1' && /^[0-9a-f-]{36}$/.test(flag(spawns[1].argv, '--session-id')) && flag(spawns[1].argv, '--prompt-file') === flag(spawns[0].argv, '--prompt-file') && out.sessionId === 'id-2', JSON.stringify(spawns.map((s) => s.argv.slice(-4))));
  }
  {
    let ready = false;
    const { out, events, kills, spawns } = await fakeGrokRun([gbInit, gbEv({ type: 'message_start' }), ...thinking(0, 'first thought'), () => { ready = true; }, gbEv({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' then more' } }), ...gbText(1, 'Hello.'), gbDone('Hello.')], { engine: { lumenReady: () => ready } });
    const shown = events.filter((e) => e.type === 'thinking' || e.type === 'text').map((e) => e.text);
    check('Grok Build first message: held thinking is shown, in order, once Lumen\'s tools are up', spawns.length === 1 && kills.length === 0 && JSON.stringify(shown) === '["first thought"," then more","Hello."]' && out.text === 'Hello.', JSON.stringify({ shown, kills }));
  }
  {
    const { out, events, spawns } = await fakeGrokRun([gbInit, gbEv({ type: 'message_start' }), ...gbText(0, 'Resumed.'), gbDone('Resumed.')], { run: { resume: true }, engine: { lumenReady: () => false } });
    check('Grok Build later messages (resume) are not held or retried', spawns.length === 1 && out.text === 'Resumed.' && events.some((e) => e.text === 'Resumed.') && flag(spawns[0].argv, '--resume') === 'id-1', JSON.stringify({ out, n: spawns.length }));
  }
  {
    // status(): `grok models` runs the way sidebar runs start grok, so its default is the runs' default.
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-gbstatus-'));
    const savedHome = process.env.GROK_HOME;
    const savedDefault = process.env.GROK_DEFAULT_MODEL;
    const userHome = path.join(data, 'user-grok');
    fs.mkdirSync(userHome);
    fs.writeFileSync(path.join(userHome, 'auth.json'), 'token-1');
    fs.writeFileSync(path.join(userHome, 'config.toml'), '[models]\ndefault = "grok-4.6"\n');
    process.env.GROK_HOME = userHome;
    process.env.GROK_DEFAULT_MODEL = 'grok-4.6'; // the user's own default: sidebar runs never see it
    const calls = [];
    const exec = (bin, argv, opts, cb) => {
      calls.push({ argv, opts, auth: fs.existsSync(path.join(opts.env.GROK_HOME, 'auth.json')) ? fs.readFileSync(path.join(opts.env.GROK_HOME, 'auth.json'), 'utf8') : null });
      setImmediate(() => cb(null, 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n', ''));
    };
    try {
      const engine = new gb.GrokBuildEngine({ userData: data, gate: async () => null, exec });
      engine.detect = async () => 'grok.exe';
      const userFiles = fs.readdirSync(userHome).sort().join(',');
      const s = await engine.status(true);
      const [call] = calls;
      check('Grok Build status runs `grok models` in Lumen\'s GROK_HOME, with the runs\' env and cwd', calls.length === 1 && call.argv.join(' ') === 'models' && call.opts.env.GROK_HOME === gb.grokHomeFor(data) && call.opts.cwd === path.join(data, 'grok-sidebar') && call.opts.env.HOME === call.opts.cwd && !('GROK_DEFAULT_MODEL' in call.opts.env) && call.opts.shell === false, JSON.stringify(call && { env: call.opts.env, cwd: call.opts.cwd }));
      check('Grok Build status: the user\'s sign-in is shared, so signed-in detection still works', call.auth === 'token-1' && s.signedIn === true && s.detail === 'grok-4.7' && JSON.stringify(s.models) === '["grok-4.7","grok-4.6"]', JSON.stringify(s));
      check('Grok Build status writes nothing to the user\'s own ~/.grok', fs.readdirSync(userHome).sort().join(',') === userFiles && fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8') === 'token-1', fs.readdirSync(userHome).join(','));
      engine.active = { tag: 'x' }; // a run in progress keeps its own link
      fs.rmSync(path.join(gb.grokHomeFor(data), 'auth.json'));
      fs.writeFileSync(path.join(gb.grokHomeFor(data), 'auth.json'), 'refreshed-by-grok');
      await engine.status(true);
      check('Grok Build status during a run leaves the run\'s auth.json alone', calls[1].auth === 'refreshed-by-grok' && fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8') === 'token-1', calls[1].auth);
      check('grok models: "You are not authenticated." means signed out', gb.parseGrokModels('You are not authenticated.\n\nDefault model: grok-4.6\n').signedIn === false, JSON.stringify(gb.parseGrokModels('You are not authenticated.')));
    } finally {
      if (savedHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = savedHome;
      if (savedDefault === undefined) delete process.env.GROK_DEFAULT_MODEL; else process.env.GROK_DEFAULT_MODEL = savedDefault;
      fs.rmSync(data, { recursive: true, force: true });
    }
  }
  {
    const { createSession } = require('../mcp');
    const s = createSession({ tools: [{ name: 'read_page', description: 'd', input_schema: {} }], callTool: async () => ({}), enabled: () => true, onEvent: () => {}, send: () => {}, engine: 'tag' });
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const before = Boolean(s.session.listed);
    await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    check('MCP session: marked as listed once the agent has fetched Lumen\'s tools (what lumenReady reads)', !before && s.session.listed === true && s.session.engine === 'tag', JSON.stringify(s.session));
  }
  {
    const { out, events, spawns } = await fakeGrokRun([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Not logged in. Run `grok login`.'] }], { engine: { lumenReady: () => false } });
    check('Grok Build first message: a failed start is reported, not retried', spawns.length === 1 && out.failed && /not signed in/.test(events.find((e) => e.type === 'error')?.text || ''), JSON.stringify({ out, events }));
    const crashed = await fakeGrokRun([{ stderr: onTime }, { stderr: 'panicked at the disco' }], { engine: { lumenReady: () => true } });
    const said = crashed.events.find((e) => e.type === 'error')?.text || '';
    check('Grok Build: the MCP wait log line never shows up as error text', /panicked at the disco/.test(said) && !/wait_for_mcp/.test(said), said);
  }
}

// ---- CLI engines' model choice: picker ids -> --model, and the picker entries themselves
const { engineModel, validModel } = require('../cli-utils');
const cc = require('../claude-code');
const { claudeCodeOptions, grokBuildOptions } = require('../features/ai-agents');
check('engine model: the part after the engine prefix, else default', engineModel('claudecode:opus') === 'opus' && engineModel('grokbuild:grok-4.6') === 'grok-4.6' && engineModel('claudecode:default') === 'default' && engineModel('claudecode:') === 'default' && engineModel(undefined) === 'default', [engineModel('claudecode:opus'), engineModel('claudecode:')].join(','));
check('model names that could read as a flag are refused', !validModel('--tools') && !validModel('-m') && !validModel('') && !validModel('a b') && validModel('grok-4.7-build-fast') && validModel('opus[1m]'), 'validModel');
{
  const base = { mcpConfig: 'm.json', sessionId: 'id', resume: false, systemPrompt: 'S' };
  const plain = cc.buildArgs(base);
  const opus = cc.buildArgs({ ...base, model: 'opus' });
  const resumed = cc.buildArgs({ ...base, resume: true, model: 'haiku' });
  const flag = (argv, f) => argv[argv.indexOf(f) + 1];
  check('Claude Code default passes no --model (the CLI decides)', !plain.includes('--model') && JSON.stringify(plain) === JSON.stringify(cc.buildArgs({ ...base, model: 'default' })), plain.join(' '));
  check('Claude Code with a model passes --model <alias>', flag(opus, '--model') === 'opus' && opus.filter((a) => a === '--model').length === 1, opus.join(' '));
  check('Claude Code keeps its lockdown flags with a model', flag(opus, '--tools') === '' && opus.includes('--strict-mcp-config') && flag(opus, '--allowedTools') === 'mcp__lumen' && flag(opus, '--permission-mode') === 'dontAsk', opus.join(' '));
  check('Claude Code resumes with the newly picked model', flag(resumed, '--resume') === 'id' && flag(resumed, '--model') === 'haiku', resumed.join(' '));
  check('Claude Code never passes a flag-like model', !cc.buildArgs({ ...base, model: '--dangerously-skip-permissions' }).includes('--dangerously-skip-permissions'), 'flag-like model passed');
  check('Claude Code models: default first, then the CLI\'s aliases', JSON.stringify(cc.MODELS.map((m) => m.id)) === '["default","fable","opus","sonnet","haiku"]', JSON.stringify(cc.MODELS));

  const g = { promptFile: 'p.json', sessionId: 'id', resume: false, systemPrompt: 'sys', cwd: 'cwd' };
  const gPlain = gb.buildArgs(g);
  const gModel = gb.buildArgs({ ...g, model: 'grok-4.6' });
  check('Grok Build default passes no --model', !gPlain.includes('--model') && !gPlain.includes('-m'), gPlain.join(' '));
  check('Grok Build with a model passes --model <id>, keeping its permission rules', flag(gModel, '--model') === 'grok-4.6' && flag(gModel, '--permission-mode') === 'dontAsk' && JSON.stringify(gModel.flatMap((a, i) => (gModel[i - 1] === '--allow' ? [a] : []))) === '["lumen__*","search_tool"]', gModel.join(' '));
  check('Grok Build never passes a flag-like model', !gb.buildArgs({ ...g, model: '--always-approve' }).includes('--always-approve'), 'flag-like model passed');

  const out = 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n';
  const parsed = gb.parseGrokModels(out);
  check('grok models: signed in, default and the list', parsed.signedIn === true && parsed.detail === 'grok-4.7' && JSON.stringify(parsed.models) === '["grok-4.7","grok-4.7-build-fast","grok-4.6","grok-4.5"]', JSON.stringify(parsed));
  check('grok models: signed in without a list -> no models', JSON.stringify(gb.parseGrokModels('You are logged in with grok.com.\n\nDefault model: grok-4.7\n').models) === '[]', 'models');
  check('grok models: signed out / unknown -> no models', JSON.stringify(gb.parseGrokModels('Not logged in. Run `grok login`.')) === JSON.stringify({ signedIn: false, detail: null, models: [] }) && gb.parseGrokModels('???').signedIn === 'unknown' && gb.parseGrokModels('???').models.length === 0, JSON.stringify(gb.parseGrokModels('???')));

  const ccOpts = claudeCodeOptions({ signedIn: true });
  check('picker: Claude Code default keeps its id and plain label', ccOpts[0].id === 'claudecode:default' && ccOpts[0].label === 'Claude Code', JSON.stringify(ccOpts[0]));
  check('picker: Claude Code models are labelled "Claude Code · <model>" in one group', ccOpts.find((o) => o.id === 'claudecode:opus')?.label === 'Claude Code · Opus' && ccOpts.every((o) => o.group === 'Your Claude account'), JSON.stringify(ccOpts.map((o) => o.label)));
  check('picker: signed-out Claude Code says how to sign in on every entry', claudeCodeOptions({ signedIn: false }).every((o) => o.signedIn === false && /\/login/.test(o.detail)), 'detail');
  const gbOpts = grokBuildOptions({ signedIn: true, accountDetail: 'grok-4.7', models: parsed.models });
  check('picker: Grok Build default first, then each listed model', JSON.stringify(gbOpts.map((o) => o.id)) === '["grokbuild:default","grokbuild:grok-4.7","grokbuild:grok-4.7-build-fast","grokbuild:grok-4.6","grokbuild:grok-4.5"]', JSON.stringify(gbOpts.map((o) => o.id)));
  check('picker: every Grok Build entry is labelled experimental and names Lumen\'s tool check', gbOpts.every((o) => /\(experimental\)$/.test(o.label) && /experimental: Grok asks Lumen before every tool call/.test(o.detail) && o.group === 'Your Grok account') && gbOpts[0].label === 'Grok Build (experimental)' && gbOpts[3].label === 'Grok Build · grok-4.6 (experimental)', JSON.stringify(gbOpts.map((o) => o.label)));
  const kept = grokBuildOptions({ signedIn: 'unknown', models: [], saved: 'grokbuild:grok-4.6' });
  check('picker: a saved Grok Build model stays offered when grok models gave no list', JSON.stringify(kept.map((o) => o.id)) === '["grokbuild:default","grokbuild:grok-4.6"]', JSON.stringify(kept.map((o) => o.id)));
  check('picker: only the default when nothing is listed or saved (old settings keep working)', JSON.stringify(grokBuildOptions({ saved: 'grokbuild:default' }).map((o) => o.id)) === '["grokbuild:default"]' && grokBuildOptions({ saved: 'grokbuild:--x' }).length === 1 && grokBuildOptions({ saved: 'claude-opus-5' }).length === 1, 'options');
}

// ---- updates (features/updates.js): who may update, how, and what to download
{
  const zu = require('../features/zip-update');
  const zp = zu.swapPaths(path.join('C:', 'Apps', 'Lumen', 'Lumen.exe'));
  check('zip update: staging, old copy and script sit next to the install folder', path.dirname(zp.staging) === path.join('C:', 'Apps') && zp.staging.endsWith('Lumen.update') && zp.old.endsWith('Lumen.old') && zp.script.endsWith('Lumen.update.cmd'), JSON.stringify(zp));
  check('zip update: the expected hash comes from the matching latest.yml entry', zu.expectedHash([{ url: 'a.exe', sha512: 'x' }, { url: 'Lumen-1.0.0-win-x64.zip', sha512: 'zz' }], 'Lumen-1.0.0-win-x64.zip') === 'zz' && zu.expectedHash([], 'a.zip') === '', 'hash');
  check('zip update: a missing or different hash is refused', zu.hashMatches('a', 'a') && !zu.hashMatches('a', 'b') && !zu.hashMatches('', ''), 'match');
  const tree = { r: ['Lumen'], 'r/Lumen': ['Lumen.exe', 'x.dll'], flat: ['Lumen.exe'], two: ['a', 'b'] };
  const fakeLs = (d) => (tree[d.split(path.sep).join('/')] || []).map((n) => ({ name: n, isDirectory: () => !n.includes('.') }));
  check('zip update: finds the exe at the zip root or inside its single folder', zu.findRoot('flat', 'Lumen.exe', fakeLs) === 'flat' && zu.findRoot('r', 'Lumen.exe', fakeLs) === path.join('r', 'Lumen') && zu.findRoot('two', 'Lumen.exe', fakeLs) === null, 'root');
  const A = 'C:/A';
  const sw = zu.swapScript({ pid: 42, dir: `${A}/Lumen`, root: `${A}/Lumen.update/files`, old: `${A}/Lumen.old`, exe: `${A}/Lumen/Lumen.exe`, errFile: 'C:/P/update-error.txt', staging: `${A}/Lumen.update`, self: `${A}/Lumen.update.cmd` });
  const mv = (a, b) => `move "${A}/${a}" "${A}/${b}"`;
  check('zip update: the swap script waits for Lumen, renames both folders, restores on failure, relaunches', sw.includes('PID eq 42') && sw.includes(mv('Lumen', 'Lumen.old')) && sw.includes(mv('Lumen.update/files', 'Lumen')) && sw.includes(mv('Lumen.old', 'Lumen')) && sw.includes('update-error.txt') && sw.includes(`start "" "${A}/Lumen/Lumen.exe"`), 'script');
  check('zip update: only zip copies stage in-app', require('../features/updates').canStage('zip') && !require('../features/updates').canStage('portable') && !require('../features/updates').canStage('nsis'), 'canStage');
  const { disabledReason, installKind, canAutoInstall, isNewer, manualAsset } = require('../features/updates');
  check('updates: off in a development run', disabledReason({ packaged: false, test: false }) === 'dev', disabledReason({ packaged: false }));
  check('updates: off in test mode', disabledReason({ packaged: false, test: true }) === 'test', disabledReason({ packaged: false, test: true }));
  check('updates: a test can opt in (test mode only)', disabledReason({ packaged: false, test: true, override: true }) === null && disabledReason({ packaged: false, test: false, override: true }) === 'dev', 'override');
  check('updates: off in the MCP bridge, even packaged', disabledReason({ packaged: true, mcp: true }) === 'mcp' && disabledReason({ packaged: false, test: true, override: true, mcp: true }) === 'mcp', 'mcp');
  check('updates: on in a packaged app', disabledReason({ packaged: true, test: false }) === null, disabledReason({ packaged: true }));

  const exe = path.join('C:', 'Users', 'me', 'AppData', 'Local', 'Programs', 'Lumen', 'Lumen.exe');
  const uninstaller = path.join(path.dirname(exe), 'Uninstall Lumen.exe');
  const nsis = installKind({ platform: 'win32', execPath: exe, exists: (p) => p === uninstaller });
  check('updates: a Windows copy next to the NSIS uninstaller is an installed copy', nsis === 'nsis' && canAutoInstall(nsis), nsis);
  const zip = installKind({ platform: 'win32', execPath: exe, exists: () => false });
  check('updates: a Windows copy without it (zip, hand-copied) can\'t install updates', zip === 'zip' && !canAutoInstall(zip), zip);
  const portable = installKind({ platform: 'win32', execPath: exe, env: { PORTABLE_EXECUTABLE_DIR: 'D:\\' }, exists: () => true });
  check('updates: a portable exe never installs updates', portable === 'portable' && !canAutoInstall(portable), portable);
  const mac = installKind({ platform: 'darwin', execPath: '/Applications/Lumen.app/Contents/MacOS/Lumen', exists: () => true });
  check('updates: macOS (unsigned) never installs updates itself', mac === 'mac' && !canAutoInstall(mac), mac);
  check('updates: Linux falls back to the releases page', installKind({ platform: 'linux', execPath: '/opt/lumen/lumen' }) === 'other' && manualAsset({ kind: 'other', version: '1.0.0' }) === null, 'linux');

  check('updates: version compare', isNewer('0.3.0', '0.2.4') && isNewer('v0.2.10', '0.2.9') && isNewer('1.0.0', '0.99.99') && !isNewer('0.2.4', '0.2.4') && !isNewer('0.2.3', '0.2.4'), 'semver');
  check('updates: a pre-release sorts before its release', isNewer('1.0.0', '1.0.0-beta.2') && !isNewer('1.0.0-beta.2', '1.0.0') && isNewer('1.0.0-beta.10', '1.0.0-beta.2'), 'pre');

  const base = 'https://github.com/emah-maker/lumen/releases/download/v0.3.0/';
  const arm = manualAsset({ kind: 'mac', version: '0.3.0', arch: 'arm64' });
  check('updates: an Apple silicon Mac gets the arm64 dmg', arm.url === `${base}Lumen-0.3.0-mac-arm64.dmg`, JSON.stringify(arm));
  check('updates: an Intel Mac gets the x64 dmg', manualAsset({ kind: 'mac', version: '0.3.0', arch: 'x64' }).name === 'Lumen-0.3.0-mac-x64.dmg', manualAsset({ kind: 'mac', version: '0.3.0', arch: 'x64' }).name);
  check('updates: a zip or portable copy gets the zip', manualAsset({ kind: 'zip', version: '0.3.0', arch: 'x64' }).url === `${base}Lumen-0.3.0-win-x64.zip` && manualAsset({ kind: 'portable', version: '0.3.0' }).name === 'Lumen-0.3.0-win-x64.zip', 'zip');
  const listed = manualAsset({ kind: 'mac', version: '0.3.0', arch: 'arm64', files: [{ url: 'Lumen-0.3.0-mac-arm64.zip' }, { url: 'https://example.com/x/Lumen-0.3.0-mac-arm64.dmg' }] });
  check('updates: a full URL listed in the release info is used as is', listed.url === 'https://example.com/x/Lumen-0.3.0-mac-arm64.dmg', listed.url);
  check('updates: a relative name in the release info still gets the GitHub download URL', manualAsset({ kind: 'mac', version: '0.3.0', arch: 'arm64', files: [{ url: 'Lumen-0.3.0-mac-arm64.dmg' }] }).url === `${base}Lumen-0.3.0-mac-arm64.dmg`, 'relative');
  check('updates: a non-https URL in the release info is ignored', manualAsset({ kind: 'zip', version: '0.3.0', files: [{ url: 'http://evil.example/Lumen-0.3.0-win-x64.zip' }] }).url === `${base}Lumen-0.3.0-win-x64.zip`, 'http');
}

// ---- The UI's sandboxed preload is a committed bundle; it must match preload.js and the library
{
  const { bundle, OUT } = require('../scripts/bundle-preload');
  const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  check('preload bundle: preload.bundle.js is up to date (run node scripts/bundle-preload.js)', committed === bundle(), `${committed.length} vs ${bundle().length} chars`);
  const requires = [...committed.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)].map((m) => m[2]).filter((id) => id !== 'electron' && id !== 'electron-chrome-extensions/browser-action');
  check('preload bundle: needs nothing a sandboxed preload can\'t load', requires.length === 0, requires.join(', '));
}

// ---- launcher.js: the first process hands over to the launcher (macOS: with the links it was sent)
{
  const { handOver, launcherArgs } = require('../launcher');
  const fakeApp = () => {
    const app = new (require('events'))();
    app.calls = [];
    app.whenReady = () => ({ then: (fn) => { app.ready = fn; } });
    app.releaseSingleInstanceLock = () => app.calls.push('release');
    app.exit = (code) => app.calls.push(`exit ${code}`);
    return app;
  };
  const started = [];
  const start = (links) => started.push(links);

  const win = fakeApp();
  handOver(win, () => true, { platform: 'win32', start });
  check('launcher: Windows/Linux hand over at once, with no extra links', started.length === 1 && started[0].length === 0 && win.calls.join() === 'release,exit 0', JSON.stringify({ started, calls: win.calls }));

  started.length = 0;
  const mac = fakeApp();
  handOver(mac, () => true, { platform: 'darwin', start });
  let prevented = 0;
  mac.emit('open-url', { preventDefault: () => prevented++ }, 'https://example.com/a');
  mac.emit('open-url', { preventDefault: () => prevented++ }, 'https://example.com/b');
  check('launcher: macOS waits for ready before handing over', started.length === 0 && mac.calls.length === 0, JSON.stringify(mac.calls));
  mac.ready();
  check('launcher: macOS passes the links that launched Lumen on to the browser', started.length === 1 && started[0].join() === 'https://example.com/a,https://example.com/b' && prevented === 2 && mac.calls.join() === 'release,exit 0', JSON.stringify({ started, calls: mac.calls }));

  started.length = 0;
  const other = fakeApp();
  handOver(other, () => false, { platform: 'darwin', start });
  other.ready();
  check('launcher: a copy that can\'t take the lock just quits', started.length === 0 && other.calls.join() === 'exit 0', JSON.stringify(other.calls));

  const args = launcherArgs(['Lumen', 'C:\\app', '--flag'], ['https://example.com/a']);
  check('launcher: its arguments are launcher.js, the original ones, then the links', /launcher\.js$/.test(args[0]) && args.slice(1).join(' ') === 'C:\\app --flag https://example.com/a', JSON.stringify(args));
}

// ---- Windows icons: Lumen.exe is Electron's binary, so shortcuts must name Lumen's .ico
{
  const { appIcon, fixShortcutIcons } = require('../features/instance');
  check('icon: falls back to the app\'s own assets/icon.ico', appIcon() === path.join(__dirname, '..', 'assets', 'icon.ico') && fs.existsSync(appIcon()), appIcon());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-icons-'));
  const desktop = path.join(dir, 'Desktop');
  const programs = path.join(dir, 'AppData', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  fs.mkdirSync(path.join(programs, 'Lumen'), { recursive: true });
  fs.mkdirSync(path.join(programs, 'Tools'));
  fs.mkdirSync(desktop);
  const links = {
    [path.join(desktop, 'Lumen.lnk')]: { target: process.execPath, icon: process.execPath },
    [path.join(programs, 'Lumen', 'Lumen.lnk')]: { target: process.execPath, icon: '' },
    [path.join(programs, 'Lumen.lnk')]: { target: 'C:\\Other\\Lumen.exe', icon: 'C:\\Other\\Lumen.exe' },
    [path.join(programs, 'Electron.lnk')]: { target: process.execPath, icon: `${process.execPath},0` }, // a stray one under another name
    [path.join(programs, 'Tools', 'Editor.lnk')]: { target: 'C:\\Tools\\editor.exe', icon: '' },
  };
  for (const file of Object.keys(links)) fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(programs, 'Tools', 'notes.txt'), ''); // not a shortcut: never read
  const updates = [];
  const read = [];
  const shell = { readShortcutLink: (f) => { read.push(f); return links[f]; }, writeShortcutLink: (f, op, o) => { updates.push({ f, op, icon: o.icon }); return true; } };
  const fakeApp = (packaged) => ({ isPackaged: packaged, getPath: (n) => (n === 'desktop' ? desktop : path.join(dir, 'AppData')) });
  fixShortcutIcons(fakeApp(false), shell);
  check('icon: dev runs leave shortcuts alone', updates.length === 0, JSON.stringify(updates));
  fixShortcutIcons(fakeApp(true), shell);
  if (process.platform === 'win32') {
    check('icon: every shortcut to this exe gets Lumen\'s .ico, whatever its name', updates.length === 3 && updates.every((u) => u.op === 'update' && /\.ico$/.test(u.icon)) && updates.some((u) => u.f === path.join(programs, 'Electron.lnk')), JSON.stringify(updates));
    check('icon: shortcuts in Start menu subfolders are read, other files are not', read.includes(path.join(programs, 'Tools', 'Editor.lnk')) && !read.some((f) => /\.txt$/.test(f)), JSON.stringify(read));
    check('icon: a shortcut to another program in a subfolder is left alone', !updates.some((u) => u.f === path.join(programs, 'Tools', 'Editor.lnk')), JSON.stringify(updates));
    check('icon: a shortcut to another program is left alone', !updates.some((u) => u.f === path.join(programs, 'Lumen.lnk')), JSON.stringify(updates));
    updates.length = 0;
    for (const file of Object.keys(links)) links[file].icon = appIcon();
    fixShortcutIcons(fakeApp(true), shell);
    check('icon: shortcuts that already have the .ico are not rewritten', updates.length === 0, JSON.stringify(updates));
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- Electron fuses: packaged macOS builds turn off NODE_OPTIONS and --inspect; Windows is untouched
async function fuseChecks() {
  const afterPack = require('../scripts/after-pack');
  const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');
  const mac = afterPack.fuses('darwin');
  check('fuses: macOS turns off NODE_OPTIONS and --inspect', mac && mac[FuseV1Options.EnableNodeOptionsEnvironmentVariable] === false && mac[FuseV1Options.EnableNodeCliInspectArguments] === false, JSON.stringify(mac));
  check('fuses: macOS leaves RunAsNode alone (the MCP bridge needs it)', mac && !(FuseV1Options.RunAsNode in mac), JSON.stringify(mac));
  check('fuses: Windows and Linux binaries are not touched', afterPack.fuses('win32') === null && afterPack.fuses('linux') === null, 'not null');

  // Run the hook on a fake mac app: a framework binary that carries Electron's fuse wire.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fuses-'));
  const framework = path.join(out, 'Lumen.app', 'Contents', 'Frameworks', 'Electron Framework.framework');
  fs.mkdirSync(framework, { recursive: true });
  fs.writeFileSync(path.join(framework, 'Electron Framework'), Buffer.concat([Buffer.alloc(64), Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 9]), Buffer.from('101100011'), Buffer.alloc(64)]));
  const calls = [];
  const packager = { addElectronFuses: (ctx, cfg) => { calls.push(ctx.electronPlatformName); return require('@electron/fuses').flipFuses(path.join(ctx.appOutDir, 'Lumen.app'), cfg); } };
  await afterPack.default({ appOutDir: out, electronPlatformName: 'darwin', packager });
  const wire = await getCurrentFuseWire(path.join(out, 'Lumen.app'));
  const on = (fuse) => String.fromCharCode(wire[fuse]); // the wire holds ASCII '0' / '1'
  check('fuses: the hook flips the mac binary', calls.length === 1 && on(FuseV1Options.EnableNodeOptionsEnvironmentVariable) === '0' && on(FuseV1Options.EnableNodeCliInspectArguments) === '0' && on(FuseV1Options.RunAsNode) === '1', JSON.stringify(wire));
  await afterPack.default({ appOutDir: out, electronPlatformName: 'linux', packager });
  check('fuses: the hook never flips a non-mac build', calls.length === 1, JSON.stringify(calls));
  fs.rmSync(out, { recursive: true, force: true });
}

// ---- Tab search matching (renderer/tab-search-match.js) and tab audio (features/tab-tools.js)
{
  const { rank, itemScore } = require('../renderer/tab-search-match');
  const items = [
    { title: 'Inbox - Gmail', url: 'https://mail.google.com/mail/u/0/' },
    { title: 'Beta Notes', url: 'https://notes.example/beta' },
    { title: 'Unrelated page', url: 'https://docs.example/zeta-path' },
    { title: 'Alphabet soup', url: 'https://food.example/soup' },
  ];
  check('tabsearch: an empty query keeps every tab in order', rank('', items).length === 4 && rank('  ', items)[0] === items[0], 'order');
  check('tabsearch: a title word finds its tab first', rank('beta', items)[0] === items[1], JSON.stringify(rank('beta', items)));
  check('tabsearch: part of the address matches too', rank('zeta', items)[0] === items[2], JSON.stringify(rank('zeta', items)));
  check('tabsearch: letters in order with gaps match (gml -> Gmail)', rank('gml', items)[0] === items[0], JSON.stringify(rank('gml', items)));
  check('tabsearch: every word has to match', rank('beta soup', items).length === 0 && rank('gmail inbox', items)[0] === items[0], JSON.stringify(rank('beta soup', items)));
  check('tabsearch: no match drops the tab', rank('qqq', items).length === 0 && itemScore('qqq', items[0]) === -1, 'matched');
  check('tabsearch: a word start beats the middle of a word', itemScore('soup', items[3]) > itemScore('bet', { title: 'alphabet', url: '' }), 'ranking');
  check('tabsearch: case does not matter', rank('BETA', items)[0] === items[1], 'case');

  const { create } = require('../features/tab-tools');
  const fakeWc = (url) => {
    const handlers = {};
    return { url, muted: false, audible: false, getURL() { return this.url; }, isDestroyed: () => false, isAudioMuted() { return this.muted; }, setAudioMuted(m) { this.muted = m; }, isCurrentlyAudible() { return this.audible; }, on(ev, fn) { (handlers[ev] ||= []).push(fn); }, emit(ev) { (handlers[ev] || []).forEach((fn) => fn()); } };
  };
  let changes = 0;
  const tools = create({ onChange: () => { changes++; }, isWebUrl: (u) => /^https?:/.test(u) });
  const mk = (url) => ({ view: { webContents: fakeWc(url) } });
  const a = mk('https://music.example/a');
  const b = mk('https://music.example/b');
  const c = mk('https://other.example/');
  [a, b, c].forEach((t) => tools.wire(t));
  const urlOf = (t) => t.view.webContents.getURL();
  a.view.webContents.audible = true;
  a.view.webContents.emit('audio-state-changed');
  check('tab-tools: a sound starting or stopping refreshes the strip', changes === 1, changes);
  check('tab-tools: state reports audible and muted', JSON.stringify(tools.state(a, true)) === '{"audible":true,"muted":false}' && JSON.stringify(tools.state({ muted: true }, false)) === '{"audible":false,"muted":true}', JSON.stringify(tools.state(a, true)));
  tools.setMuted(a, true);
  check('tab-tools: Mute Tab mutes only that tab', a.view.webContents.muted && !b.view.webContents.muted, 'mute');
  tools.setMuted(a, false);
  tools.setSiteMuted('music.example', true, [a, b, c], urlOf);
  check('tab-tools: Mute Site mutes every tab on the host, not others', a.view.webContents.muted && b.view.webContents.muted && !c.view.webContents.muted && tools.siteMuted('music.example'), 'site');
  c.view.webContents.url = 'https://music.example/c';
  c.view.webContents.emit('did-navigate');
  check('tab-tools: a tab arriving on a muted site is muted', c.view.webContents.muted && c.siteMuted, 'arrive');
  c.view.webContents.url = 'https://elsewhere.example/';
  c.view.webContents.emit('did-navigate');
  check('tab-tools: and unmuted again when it leaves', !c.view.webContents.muted, 'leave');
  tools.setMuted(b, true); // by hand as well
  b.view.webContents.url = 'https://elsewhere.example/x';
  b.view.webContents.emit('did-navigate');
  check('tab-tools: a tab muted by hand stays muted when it leaves the site', b.view.webContents.muted, 'hand');
  tools.setSiteMuted('music.example', false, [a, b, c], urlOf);
  check('tab-tools: Unmute Site unmutes the tabs on that site', !a.view.webContents.muted && !tools.siteMuted('music.example'), 'unmute');
  const woken = { muted: true, view: { webContents: fakeWc('https://x.example/') } };
  tools.wire(woken);
  check('tab-tools: a woken tab keeps its mute', woken.view.webContents.muted, 'sleep');
  check('tab-tools: only web pages have a site to mute', tools.siteOf('file:///C:/x.html') === '' && tools.siteOf('https://a.example/p') === 'a.example', tools.siteOf('file:///C:/x.html'));
  const closed = ['https://one.example/', 'https://two.example/'];
  tools.noteClosed(closed[0], 'One');
  tools.noteClosed(closed[1], '');
  const entries = tools.closedEntries(closed);
  check('tab-tools: recently closed lists newest first with titles and indexes', entries[0].index === 1 && entries[0].title === closed[1] && entries[1].title === 'One' && entries[1].index === 0, JSON.stringify(entries));
  for (let i = 0; i < 120; i++) tools.noteClosed(`https://n${i}.example/`, `n${i}`);
  check('tab-tools: the closed-title list stays bounded', tools.closedEntries(['https://one.example/'])[0].title === 'https://one.example/', 'unbounded');
}

// ---- Bookmarks page: Netscape bookmark files (features/bookmark-html.js)
{
  const { toNetscape, parseNetscape } = require('../features/bookmark-html');
  const list = [
    { url: 'https://a.example/', title: 'A & <b>' },
    { url: 'https://b.example/x?y=1&z=2', title: 'B "quoted"', folder: 'Work' },
    { url: 'https://c.example/', title: 'C', folder: 'Work' },
  ];
  const html = toNetscape(list);
  check('bookmarks: export is a Netscape bookmark file', /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/.test(html) && /<H3>Work<\/H3>/.test(html), html);
  check('bookmarks: export escapes titles and addresses', html.includes('A &amp; &lt;b&gt;') && html.includes('x?y=1&amp;z=2') && !html.includes('<b>'), html);
  check('bookmarks: export then import gives the same bookmarks back', JSON.stringify(parseNetscape(html)) === JSON.stringify(list), JSON.stringify(parseNetscape(html)));
  const chrome = `<DL><p><DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3><DL><p>
    <DT><A HREF="https://top.example/" ADD_DATE="1">Top</A>
    <DT><H3>Recipes</H3><DL><p><DT><H3>Soups</H3><DL><p><DT><A HREF="https://soup.example/">Soup</A></DL><p>
      <DT><A HREF="https://cake.example/">Cake &#38; tea</A></DL><p>
    <DT><A HREF="javascript:alert(1)">Bookmarklet</A><DT><A HREF='file:///C:/x'>File</A><DT><A HREF=https://bare.example/>Bare</A>
  </DL><p></DL><p>`;
  const got = parseNetscape(chrome);
  check('bookmarks: import reads nested folders as their innermost name', got.find((b) => b.url === 'https://soup.example/')?.folder === 'Soups' && got.find((b) => b.url === 'https://cake.example/')?.folder === 'Recipes', JSON.stringify(got));
  check('bookmarks: the browser\'s own bookmarks-bar folder is not kept as a folder', got.find((b) => b.url === 'https://top.example/')?.folder === undefined, JSON.stringify(got));
  check('bookmarks: import keeps only http(s) links', got.length === 4 && !got.some((b) => /^(javascript|file):/.test(b.url)), JSON.stringify(got));
  check('bookmarks: import decodes entities and unquoted addresses', got.some((b) => b.title === 'Cake & tea') && got.some((b) => b.url === 'https://bare.example/'), JSON.stringify(got));
}

// ---- Clear browsing data by time range: site activity (features/site-activity.js)
{
  const { createSiteActivity, related } = require('../features/site-activity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-activity-'));
  let t = 1_000_000_000_000;
  const a = createSiteActivity({ userData: dir, now: () => t });
  a.record('.old.example', t - 3 * 86400e3);
  a.record('new.example');
  a.record('new.example', t - 10); // an older time never moves it back
  check('site activity: a leading dot is dropped from cookie domains', a.get('old.example') === t - 3 * 86400e3, a.get('old.example'));
  check('site activity: since() lists only domains active in the range', JSON.stringify(a.since(t - 3600e3)) === '["new.example"]', JSON.stringify(a.since(t - 3600e3)));
  a.forget(['new.example']);
  check('site activity: forget() drops cleared domains', a.get('new.example') === undefined && a.since(0).length === 1, JSON.stringify(a.since(0)));
  check('site activity: a cookie domain matches its subdomains and parents', related('example.com', 'www.example.com') && related('www.example.com', 'example.com') && related('a.b', 'a.b'), 'related');
  check('site activity: unrelated domains don\'t match', !related('example.com', 'badexample.com') && !related('ample.com', 'example.com'), 'unrelated');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- the sidebar usage bar (features/usage.js barFor, cli-utils usageOf)
{
  const { barFor } = require('../features/usage');
  const { usageOf } = require('../cli-utils');
  const plan = { available: true, limits: [{ label: 'Current session', percent: 29, resets: '8:09pm (America/New_York)' }, { label: 'Current week (all models)', percent: 12, resets: 'Oct 2' }] };
  let b = barFor('claudecode', { plan, meter: null, lumen: { window: { limitPoints: 3 } } });
  check('usage bar: Claude Code shows the session and weekly limits', b.kind === 'plan' && b.percent === 29 && b.resetsText === '8:09pm' && b.weekly.percent === 12 && b.lumenPoints === 3, JSON.stringify(b));
  b = barFor('claudecode', { plan: { available: false }, meter: { percent: 140, resetsAt: 5 } });
  check('usage bar: a live meter reading wins and is clamped to 100', b.percent === 100 && b.resetsAt === 5 && b.weekly === null, JSON.stringify(b));
  check('usage bar: no plan data and no meter hides the Claude bar', barFor('claudecode', { plan: { available: false } }) === null);
  const s = { engines: { grokbuild: { today: { turns: 2, tokens: 5000, costUSD: 0.02 }, last: { contextTokens: 50000, contextWindow: 200000 } } } };
  b = barFor('grokbuild', s);
  check('usage bar: Grok Build shows context fill, tokens and cost', b.kind === 'context' && b.percent === 25 && b.tokens === 5000 && b.costUSD === 0.02, JSON.stringify(b));
  b = barFor('grokbuild', { engines: { grokbuild: { today: { turns: 1, tokens: 10, costUSD: 0 }, last: { contextTokens: 10, contextWindow: 0 } } } });
  check('usage bar: an unknown context window gives no percent, only counts', b.percent === null && b.tokens === 10, JSON.stringify(b));
  check('usage bar: an engine with no turns today is hidden', barFor('grokbuild', { engines: { grokbuild: { today: { turns: 0, tokens: 0, costUSD: 0 }, last: {} } } }) === null && barFor('grokbuild', {}) === null);
  const u = usageOf({ usage: { input_tokens: 5 }, modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } }, total_cost_usd: 0.1 });
  check('usage bar: usageOf reads the largest context window', u.contextWindow === 1000000 && u.inputTokens === 5, JSON.stringify(u));
}

// ---- AI chat usage totals (features/chat-usage.js)
{
  const { addUsage, describeUsage } = require('../features/chat-usage');
  let u = addUsage(null, { model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: 200 } });
  check('usage: a Claude turn is priced from the table', u.input === 1000 && u.output === 200 && Math.abs(u.cost - 0.01) < 1e-9 && u.unpriced === 0 && u.turns === 1, JSON.stringify(u));
  u = addUsage(u, { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 0 } });
  check('usage: cache reads are priced at the cache rate and totals add up', Math.abs(u.cost - (0.01 + 0.5 + 0.00005)) < 1e-9 && u.cacheRead === 1000000 && u.turns === 2, u.cost);
  const oa = addUsage(null, { model: 'openai:gpt-5.6', usage: { prompt_tokens: 500, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 } } });
  check('usage: a model without a price counts tokens and shows the cost as unknown', oa.input === 400 && oa.cacheRead === 100 && oa.output === 50 && oa.cost === 0 && oa.unpriced === 1 && describeUsage(oa) === '550 tokens · cost n/a', `${JSON.stringify(oa)} ${describeUsage(oa)}`);
  const or = addUsage(null, { model: 'openrouter:x/y', usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0042 } });
  check('usage: OpenRouter\'s own reported cost is used', or.cost === 0.0042 && or.unpriced === 0 && describeUsage(or) === '110 tokens · ~$0.0042', describeUsage(or));
  const cc = addUsage(addUsage(null, { model: 'claudecode:default', cost: 0.02 }), { model: 'claudecode:default' });
  check('usage: a CLI engine\'s reported cost is used; a turn without one marks the total partial', Math.abs(cc.cost - 0.02) < 1e-9 && cc.unpriced === 1 && describeUsage(cc) === '~$0.02+', describeUsage(cc));
  const grok = addUsage(null, { model: 'xai:grok-4', usage: { prompt_tokens: 1000000, completion_tokens: 0 } });
  check('usage: Grok is priced under its provider id', Math.abs(grok.cost - 3) < 1e-9, grok.cost);
  check('usage: a chat with no turns shows no usage line', describeUsage(null) === '' && describeUsage({}) === '', describeUsage(null));
  check('usage: nonsense numbers count as zero', addUsage(null, { usage: { input_tokens: -5, output_tokens: 'x' } }).input === 0, 'negative');
}

// ---- AI chat history (features/chat-store.js)
{
  const { createChatStore, autoTitle, toMarkdown } = require('../features/chat-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chats-'));
  const enc = (s) => Buffer.from(s).toString('base64').split('').reverse().join(''); // stand-in for the OS keychain
  const dec = (s) => Buffer.from(s.split('').reverse().join(''), 'base64').toString();
  let clock = 1000;
  const chat = (text) => ({ settings: { model: 'claude-opus-5' }, messages: [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
  const store = createChatStore({ dir, encrypt: enc, decrypt: dec, limit: 3, now: () => clock++ });

  check('chats: the title is the first message without Lumen\'s additions', autoTitle(chat('<browser_state>\nx\n</browser_state>\n\n<untrusted_page_content title="t">page</untrusted_page_content>\n\nWhat is up?')) === 'What is up?', autoTitle(chat('<browser_state>x</browser_state> What is up?')));
  const long = autoTitle(chat('word '.repeat(40)));
  check('chats: a long first message is cut to a short title', long.length === 60 && long.endsWith('…'), long);
  check('chats: an image-only first message is titled "Image"', autoTitle({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'The user attached the image(s) above without a message.' }] }] }) === 'Image', 'image');

  const ids = [0, 1, 2, 3].map(() => store.newId());
  check('chats: ids are random hex', new Set(ids).size === 4 && ids.every((id) => /^[a-f0-9]{16}$/.test(id)), ids.join());
  store.setCurrent(ids[0]);
  ids.forEach((id, i) => store.save(id, chat(`chat ${i}`)));
  check('chats: the newest `limit` chats are kept, plus the open one', store.list().map((c) => c.title).join() === 'chat 3,chat 2,chat 1,chat 0', store.list().map((c) => c.title).join());
  store.setCurrent(ids[3]);
  store.save(ids[3], chat('chat 3'));
  check('chats: past the limit, the oldest chat and its file go', store.list().length === 3 && !store.list().some((c) => c.id === ids[0]) && !fs.existsSync(path.join(dir, `${ids[0]}.json`)), store.list().map((c) => c.title).join());
  const disk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  check('chats: the index and chats are written encrypted', disk.includes('"enc"') && !/chat 1|claude-opus-5/.test(disk), disk.slice(0, 120));
  check('chats: an empty chat is not saved', store.save(store.newId(), { messages: [] }) === true && store.list().length === 3, store.list().length);
  check('chats: a chat loads back', store.load(ids[2])?.messages?.[0]?.content?.[0]?.text === 'chat 2', JSON.stringify(store.load(ids[2])).slice(0, 100));
  check('chats: an id that is not in the list does not load', store.load('../index') === null && store.load(ids[0]) === null, 'loaded');

  check('chats: rename cleans the title', store.rename(ids[2], '  My\n  trip\u0007 ') && store.list().find((c) => c.id === ids[2]).title === 'My trip', store.list().find((c) => c.id === ids[2])?.title);
  store.save(ids[2], chat('chat 2 again'));
  check('chats: a renamed title stays after more messages', store.list().find((c) => c.id === ids[2]).title === 'My trip', store.list().find((c) => c.id === ids[2])?.title);
  check('chats: a blank rename is refused', store.rename(ids[2], '   ') === false && store.rename('nope', 'x') === false, 'renamed');

  const reopened = createChatStore({ dir, encrypt: enc, decrypt: dec, limit: 3 });
  check('chats: the list and open chat survive a restart', reopened.list().length === 3 && reopened.current() === ids[3] && reopened.list()[0].id === ids[2], JSON.stringify(reopened.list().map((c) => c.title)));
  check('chats: delete removes the entry and its file', reopened.remove(ids[1]) && !reopened.list().some((c) => c.id === ids[1]) && !fs.existsSync(path.join(dir, `${ids[1]}.json`)), 'still there');
  check('chats: deleting the open chat clears which one is open', reopened.remove(ids[3]) && reopened.current() === null, reopened.current());
  check('chats: deleting an unknown chat does nothing', reopened.remove('0000000000000000') === false, 'removed');

  // The single chat.json of older versions moves into the list, once.
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-legacy-'));
  const legacyFile = path.join(legacyDir, 'chat.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ enc: enc(JSON.stringify(chat('from before'))) }));
  const migrating = createChatStore({ dir: path.join(legacyDir, 'chats'), encrypt: enc, decrypt: dec, legacyFile });
  const migratedId = migrating.migrate();
  check('chats: the old chat.json becomes the open chat in the list', migratedId && migrating.current() === migratedId && migrating.list()[0]?.title === 'from before' && !fs.existsSync(legacyFile), JSON.stringify(migrating.list()));
  check('chats: migrating twice does nothing', migrating.migrate() === null && migrating.list().length === 1, migrating.list().length);
  fs.writeFileSync(legacyFile, JSON.stringify({ enc: 'not-decryptable' }));
  check('chats: an old chat.json that can\'t be decrypted is dropped', migrating.migrate() === null && !fs.existsSync(legacyFile) && migrating.list().length === 1, 'kept');

  const noKeychainDir = path.join(legacyDir, 'none');
  const noKeychain = createChatStore({ dir: noKeychainDir, encrypt: enc, decrypt: dec, available: () => false });
  check('chats: with no keychain nothing is written', noKeychain.save(noKeychain.newId(), chat('secret')) === false && !fs.existsSync(noKeychainDir), 'wrote');

  const md = toMarkdown({ title: 'Trip\nplan', created: Date.UTC(2026, 8, 28, 14, 5), model: 'claude-opus-5', usageLine: '1.2k tokens · ~$0.01' }, [
    { role: 'user', text: 'Find flights', images: ['data:image/png;base64,AAAA'] },
    { role: 'assistant', text: 'Here are **three**.', images: [], steps: 2 },
  ]);
  check('chats: export Markdown has the title, date, model, usage and each turn', md.startsWith('# Trip plan\n\n_2026-09-28 14:05 · Model: claude-opus-5 · Usage: 1.2k tokens · ~$0.01_') && md.includes('## You\n\n_1 image attached (not included)_\n\nFind flights') && md.includes('## Assistant\n\n_Used 2 browser actions_\n\nHere are **three**.') && !md.includes('base64'), md);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(legacyDir, { recursive: true, force: true });
}

// ---- [ai controls] "Turn off AI on this site" (features/ai-sites.js): one switch per registrable domain
{
  const { createAiSites, siteOf, siteFromInput } = require('../features/ai-sites');
  check('ai-sites: a subdomain belongs to its site', siteOf('https://mail.example.co.uk/inbox?x=1') === 'example.co.uk', siteOf('https://mail.example.co.uk/inbox'));
  check('ai-sites: non-web addresses have no site', siteOf('file:///C:/x.html') === '' && siteOf('about:blank') === '' && siteOf('not a url') === '', 'site for non-web');
  check('ai-sites: typed names and full addresses both work', siteFromInput('www.Example.com') === 'example.com' && siteFromInput('https://a.b.example.com/x') === 'example.com', siteFromInput('www.Example.com'));
  let saved = {};
  const changes = [];
  const sites = createAiSites({ readSettings: () => ({ ...saved }), writeSettings: (v) => { saved = v; }, onChange: (site, off) => changes.push([site, off]) });
  sites.set('https://login.bank.example/x', true);
  check('ai-sites: turning one address off covers the whole site', sites.isOff('https://www.bank.example/') && !sites.isOff('https://other.example/'), JSON.stringify(saved));
  sites.set('bank.example', true);
  check('ai-sites: the list has no duplicates', sites.list().length === 1, JSON.stringify(sites.list()));
  sites.set('bank.example', false);
  check('ai-sites: turning it back on removes it', !sites.isOff('https://www.bank.example/') && sites.list().length === 0 && changes.length === 3, JSON.stringify(changes));
  saved = { aiOffSites: 'garbage' };
  check('ai-sites: a damaged setting reads as no sites', sites.list().length === 0 && !sites.isOff('https://x.example/'), 'threw or listed');
}

// ---- Safe Browsing (features/safe-browsing.js): Google's published vectors, list updates, lookups ----
async function safeBrowsingRuns() {
  const sb = require('../features/safe-browsing');
  // developers.google.com/safe-browsing/v4/urls-hashing: every canonicalization example.
  const vectors = [
    ['http://host/%25%32%35', 'http://host/%25'],
    ['http://host/%25%32%35%25%32%35', 'http://host/%25%25'],
    ['http://host/%2525252525252525', 'http://host/%25'],
    ['http://host/asdf%25%32%35asd', 'http://host/asdf%25asd'],
    ['http://host/%%%25%32%35asd%%', 'http://host/%25%25%25asd%25%25'],
    ['http://www.google.com/', 'http://www.google.com/'],
    ['http://%31%36%38%2e%31%38%38%2e%39%39%2e%32%36/%2E%73%65%63%75%72%65/%77%77%77%2E%65%62%61%79%2E%63%6F%6D/', 'http://168.188.99.26/.secure/www.ebay.com/'],
    ['http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/', 'http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/'],
    ['http://host%23.com/%257Ea%2521b%2540c%2523d%2524e%25f%255E00%252611%252A22%252833%252944_55%252B', 'http://host%23.com/~a!b@c%23d$e%25f^00&11*22(33)44_55+'],
    ['http://3279880203/blah', 'http://195.127.0.11/blah'],
    ['http://www.google.com/blah/..', 'http://www.google.com/'],
    ['www.google.com/', 'http://www.google.com/'],
    ['www.google.com', 'http://www.google.com/'],
    ['http://www.evil.com/blah#frag', 'http://www.evil.com/blah'],
    ['http://www.GOOgle.com/', 'http://www.google.com/'],
    ['http://www.google.com.../', 'http://www.google.com/'],
    ['http://www.google.com/foo\tbar\rbaz\n2', 'http://www.google.com/foobarbaz2'],
    ['http://www.google.com/q?', 'http://www.google.com/q?'],
    ['http://www.google.com/q?r?', 'http://www.google.com/q?r?'],
    ['http://www.google.com/q?r?s', 'http://www.google.com/q?r?s'],
    ['http://evil.com/foo#bar#baz', 'http://evil.com/foo'],
    ['http://evil.com/foo;', 'http://evil.com/foo;'],
    ['http://evil.com/foo?bar;', 'http://evil.com/foo?bar;'],
    ['http://\x01\x80.com/', 'http://%01%80.com/'],
    ['http://notrailingslash.com', 'http://notrailingslash.com/'],
    ['http://www.gotaport.com:1234/', 'http://www.gotaport.com/'],
    ['  http://www.google.com/  ', 'http://www.google.com/'],
    ['http:// leadingspace.com/', 'http://%20leadingspace.com/'],
    ['http://%20leadingspace.com/', 'http://%20leadingspace.com/'],
    ['%20leadingspace.com/', 'http://%20leadingspace.com/'],
    ['https://www.securesite.com/', 'https://www.securesite.com/'],
    ['http://host.com/ab%23cd', 'http://host.com/ab%23cd'],
    ['http://host.com//twoslashes?more//slashes', 'http://host.com/twoslashes?more//slashes'],
  ];
  const wrong = vectors.filter(([i, o]) => sb.canonicalize(i)?.url !== o).map(([i, o]) => `${JSON.stringify(i)} -> ${sb.canonicalize(i)?.url} (want ${o})`);
  check(`safe browsing: all ${vectors.length} of Google's canonicalization examples`, wrong.length === 0, wrong.join('; '));
  // reference/URLs.and.Hashing (v5): IPv6 forms.
  const v6 = ['http://[2001:0db8:0000::1]/', 'http://[::ffff:1.2.3.4]/', 'http://[64:ff9b::1.2.3.4]/'].map((u) => sb.canonicalize(u).url);
  check('safe browsing: IPv6 hosts are shortened; mapped and NAT64 ones become IPv4', v6.join() === 'http://[2001:db8::1]/,http://1.2.3.4/,http://1.2.3.4/', v6);
  // reference/URLs.and.Hashing (v5): the host-suffix / path-prefix examples.
  const same = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
  const ex = [
    ['http://a.b.com/1/2.html?param=1', ['a.b.com/1/2.html?param=1', 'a.b.com/1/2.html', 'a.b.com/', 'a.b.com/1/', 'b.com/1/2.html?param=1', 'b.com/1/2.html', 'b.com/', 'b.com/1/']],
    ['http://a.b.c.d.e.f.com/1.html', ['a.b.c.d.e.f.com/1.html', 'a.b.c.d.e.f.com/', 'c.d.e.f.com/1.html', 'c.d.e.f.com/', 'd.e.f.com/1.html', 'd.e.f.com/', 'e.f.com/1.html', 'e.f.com/', 'f.com/1.html', 'f.com/']],
    ['http://1.2.3.4/1/', ['1.2.3.4/1/', '1.2.3.4/']],
    ['http://example.co.uk/1', ['example.co.uk/1', 'example.co.uk/']],
  ];
  for (const [u, want] of ex) check(`safe browsing: expressions for ${u}`, same(sb.expressions(u), want), JSON.stringify(sb.expressions(u)));
  const many = sb.expressions('http://a.b.c.d.e.f.g.example.com/1/2/3/4/5/6.html?q=1');
  check('safe browsing: at most 5 hosts x 6 paths', many.length === 30, many.length);
  // reference/Local.Database: the worked hashes and the Rice-delta example.
  const docHash = sb.sha256('a.example.com/').toString('hex');
  check('safe browsing: SHA-256 of "a.example.com/" matches the documented hash', docHash === '291bc5421f1cd54d99afcc55d166e2b9fe42447025895bf09dd41b2110a687dc', docHash);
  const riceData = Buffer.from([0x74, 0x00, 0xd2, 0x97, 0x1b, 0xed, 0x49, 0x74, 0x00]).toString('base64');
  const rice = sb.riceDecode({ firstValue: 489866504, riceParameter: 30, entriesCount: 2, encodedData: riceData });
  check('safe browsing: the documented Rice-delta example decodes', rice.join() === [0x1d32c508, 0x291bc542, 0xf7a502e5].join(), rice.map((x) => x.toString(16)));
  let threw = false;
  try { sb.riceDecode({ firstValue: 1, riceParameter: 30, entriesCount: 5, encodedData: riceData }); } catch { threw = true; }
  check('safe browsing: truncated Rice data is an error, not garbage', threw, 'no error');

  // Rice-encodes values (the inverse of riceDecode), for the fake list updates below.
  const encode = (values, k = 8) => {
    const sorted = [...values].sort((a, b) => a - b);
    const bits = [];
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i] - sorted[i - 1];
      const q = Math.floor(d / 2 ** k); const r = d % 2 ** k;
      for (let j = 0; j < q; j++) bits.push(1);
      bits.push(0);
      for (let j = 0; j < k; j++) bits.push(Math.floor(r / 2 ** j) % 2);
    }
    const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
    bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i & 7); });
    return { firstValue: sorted[0], riceParameter: k, entriesCount: sorted.length - 1, encodedData: bytes.toString('base64') };
  };
  const full = sb.applyUpdate(new Uint32Array(0), { partialUpdate: false, additionsFourBytes: encode([30, 10, 20, 40]) });
  check('safe browsing: a full update gives the sorted prefixes', [...full].join() === '10,20,30,40', [...full]);
  const partial = sb.applyUpdate(full, { partialUpdate: true, compressedRemovals: encode([1, 3]), additionsFourBytes: encode([25]) });
  check('safe browsing: a partial update removes by index (before adding), then adds', [...partial].join() === '10,25,30', [...partial]);
  let outOfRange = false;
  try { sb.applyUpdate(full, { partialUpdate: true, compressedRemovals: encode([9]) }); } catch { outOfRange = true; }
  check('safe browsing: a removal index past the end is an error', outOfRange, 'accepted');
  const sum = sb.checksum(Uint32Array.from([0x1d32c508, 0x291bc542, 0xf7a502e5]));
  const wantSum = require('crypto').createHash('sha256').update(Buffer.from('1d32c508291bc542f7a502e5', 'hex')).digest('base64');
  check('safe browsing: the checksum is SHA-256 over the sorted 4-byte prefixes', sum === wantSum, sum);
  check('safe browsing: durations parse ("1800s", "3.5s", missing)', sb.durationMs('1800s') === 1800e3 && sb.durationMs('3.5s') === 3500 && sb.durationMs(undefined) === 0, [sb.durationMs('1800s'), sb.durationMs('3.5s')]);
  const min = 60e3;
  const b = [sb.backoffMs(1, 0), sb.backoffMs(1, 0.999), sb.backoffMs(2, 0), sb.backoffMs(3, 0.5), sb.backoffMs(20, 0.9)];
  check('safe browsing: backoff is 15-30 min after one error, doubling, never over 24 h',
    b[0] === 15 * min && b[1] < 30 * min && b[2] === 30 * min && b[3] === 90 * min && b[4] === 24 * 60 * min, b);

  // The service, against a fake Google.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sb-'));
  const evil = 'http://evil.example/login.html';
  const evilHash = sb.sha256('evil.example/login.html');
  const collide = 'http://safe.example/'; // its prefix is in the list too, but Google has no full hash for it
  let settings = { safeBrowsing: true };
  let key = 'test-key';
  const calls = [];
  let listBody = null;
  let searchStatus = 200;
  const fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/v5/hashLists:batchGet') return { ok: true, status: 200, json: async () => listBody(u) };
    if (u.pathname === '/v5/hashes:search') {
      if (searchStatus !== 200) return { ok: false, status: searchStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ fullHashes: [{ fullHash: evilHash.toString('base64'), fullHashDetails: [{ threatType: 'SOCIAL_ENGINEERING' }] }], cacheDuration: '300s' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const prefixes = [evilHash.readUInt32BE(0), sb.sha256('safe.example/').readUInt32BE(0)];
  const sortedPrefixes = Uint32Array.from([...prefixes].sort((x, y) => x - y));
  const good = (names) => ({
    hashLists: names.map((name) => (name === 'se-4b'
      ? { name, version: 'djE=', partialUpdate: false, additionsFourBytes: encode(prefixes, 28), sha256Checksum: sb.checksum(sortedPrefixes), minimumWaitDuration: '1800s' }
      : { name, version: 'djE=', partialUpdate: false, minimumWaitDuration: '1800s', sha256Checksum: sb.checksum(new Uint32Array(0)) })),
  });
  listBody = (u) => good(u.searchParams.getAll('names'));
  const services = [];
  const make = () => {
    const s = sb.createSafeBrowsing({ readSettings: () => settings, apiKey: () => key, dir: () => dir, fetch, isTab: () => true, warnUrl: 'file:///sb.html', baseUrl: 'https://sb.test' });
    services.push(s);
    return s;
  };
  const svc = make();
  await svc.refresh();
  check('safe browsing: the lists download (one batchGet for all three)', calls.filter((c) => c.includes('batchGet')).length === 1 && svc.status().entries === 2, JSON.stringify(svc.status()));
  check('safe browsing: the key and alt=json go with every request', calls.length > 0 && calls.every((c) => /[?&]key=test-key/.test(c) && /[?&]alt=json/.test(c)), calls.join(' '));
  calls.length = 0;
  check('safe browsing: a page not in the lists needs no request at all', (await svc.check('https://www.wikipedia.org/wiki/Cat')) === null && calls.length === 0, calls);
  const hit = await svc.check(evil);
  check('safe browsing: a listed page is flagged with its threat type', hit?.threat === 'SOCIAL_ENGINEERING', JSON.stringify(hit));
  const sent = calls.filter((c) => c.includes('hashes:search'));
  const sentPrefixes = sent.length ? new URL(sent[0]).searchParams.getAll('hashPrefixes') : [];
  check('safe browsing: only 4-byte prefixes are sent, never the address', sent.length === 1 && sentPrefixes.length > 0 && sentPrefixes.every((p) => Buffer.from(p, 'base64').length === 4) && !sent[0].includes('evil'), sent);
  calls.length = 0;
  check('safe browsing: the answer is cached (no second request)', (await svc.check(evil))?.threat === 'SOCIAL_ENGINEERING' && calls.length === 0, calls);
  check('safe browsing: a prefix match whose full hash differs is safe', (await svc.check(collide)) === null, 'flagged');
  check('safe browsing: localhost and private addresses are never checked', (await svc.check('http://127.0.0.1/evil')) === null && (await svc.check('http://192.168.1.1/')) === null, 'checked');
  // Stored lists survive a restart; a damaged file is thrown away.
  check('safe browsing: the lists are kept on disk between runs', make().status().entries === 2, JSON.stringify(make().status()));
  const binFile = path.join(dir, 'se-4b.bin');
  const bytes = fs.readFileSync(binFile);
  bytes[0] ^= 0xff;
  fs.writeFileSync(binFile, bytes);
  check('safe browsing: a damaged list file fails its checksum and is dropped', make().status().entries === 0, JSON.stringify(make().status()));
  // A server checksum that doesn't match: the list is dropped and fetched whole, right away.
  let round = 0;
  listBody = (u) => {
    round++;
    const body = good(u.searchParams.getAll('names'));
    if (round === 1) body.hashLists[0].sha256Checksum = Buffer.alloc(32).toString('base64');
    return body;
  };
  const fresh = make();
  calls.length = 0;
  await fresh.refresh();
  const batches = calls.filter((c) => c.includes('batchGet')).map((c) => new URL(c).searchParams.getAll('names'));
  check('safe browsing: a checksum mismatch resets the list and fetches it again at once',
    round === 2 && fresh.status().entries === 2 && batches[1]?.join() === 'se-4b', JSON.stringify({ round, batches, status: fresh.status() }));
  // Google unreachable: pages load, and the next search waits (backoff).
  searchStatus = 503;
  const offline = make();
  calls.length = 0;
  check('safe browsing: if Google is unreachable, the page loads (fail open)', (await offline.check('http://safe.example/')) === null, 'blocked');
  const before = calls.length;
  await offline.check('http://safe.example/');
  check('safe browsing: after a failed search, the next one backs off', calls.length === before, calls.length - before);
  searchStatus = 200;
  // The setting, or the key, off: nothing is checked and nothing is sent.
  settings = { safeBrowsing: false };
  calls.length = 0;
  check('safe browsing: off by default, and switched off it checks and sends nothing',
    (await make().check(evil)) === null && calls.length === 0 && require('../settings-backend').DEFAULTS.safeBrowsing === false, calls);
  settings = { safeBrowsing: true };
  key = null;
  check('safe browsing: on without a key is inactive and sends nothing', (await make().check(evil)) === null && make().status().active === false && calls.length === 0, JSON.stringify(make().status()));
  let passed = null;
  make().gate({ resourceType: 'mainFrame', url: evil, webContents: null }, (r) => { passed = r; });
  check('safe browsing: the gate lets pages through when inactive', JSON.stringify(passed) === '{}', JSON.stringify(passed));
  for (const s of services) s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

fuseChecks().catch((err) => check('fuses: after-pack hook', false, err.stack)).then(safeBrowsingRuns).catch((err) => check('Safe Browsing against a fake Google', false, err.stack)).then(grokRuns).catch((err) => check('Grok Build runs against a fake grok', false, err.stack)).then(() => {
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
});
