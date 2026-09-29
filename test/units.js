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
  ['/Users/me/My Page.html', process.platform === 'win32' ? 'file:///C:/Users/me/My%20Page.html' : 'file:///Users/me/My%20Page.html'],
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
    check('Grok Build run: run_terminal_command in the stream is not killed here (the gate already judged it)', kills.length === 0 && out.failed !== true && out.text === 'Running it.\n\n Done.', JSON.stringify({ out, events, kills }));
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
  check('Grok Build with a model passes --model <id>, keeping its permission rules', flag(gModel, '--model') === 'grok-4.6' && flag(gModel, '--permission-mode') === 'dontAsk' && JSON.stringify(gModel.flatMap((a, i) => (gModel[i - 1] === '--allow' ? [a] : []))) === '["lumen__*","search_tool","run_terminal_command"]', gModel.join(' '));
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
  check('zip update: staging and old copy sit next to the install folder', path.dirname(zp.staging) === path.join('C:', 'Apps') && zp.staging.endsWith('Lumen.update') && zp.old.endsWith('Lumen.old') && zp.script === null, JSON.stringify(zp));
  check('zip update: the expected hash comes from the matching latest.yml entry', zu.expectedHash([{ url: 'a.exe', sha512: 'x' }, { url: 'Lumen-1.0.0-win-x64.zip', sha512: 'zz' }], 'Lumen-1.0.0-win-x64.zip') === 'zz' && zu.expectedHash([], 'a.zip') === '', 'hash');
  check('zip update: a missing or different hash is refused', zu.hashMatches('a', 'a') && !zu.hashMatches('a', 'b') && !zu.hashMatches('', ''), 'match');
  const tree = { r: ['Lumen'], 'r/Lumen': ['Lumen.exe', 'x.dll'], flat: ['Lumen.exe'], two: ['a', 'b'] };
  const fakeLs = (d) => (tree[d.split(path.sep).join('/')] || []).map((n) => ({ name: n, isDirectory: () => !n.includes('.') }));
  check('zip update: finds the exe at the zip root or inside its single folder', zu.findRoot('flat', 'Lumen.exe', fakeLs) === 'flat' && zu.findRoot('r', 'Lumen.exe', fakeLs) === path.join('r', 'Lumen') && zu.findRoot('two', 'Lumen.exe', fakeLs) === null, 'root');
  // Windows swap: no script file, a copy of the signed exe in Node mode runs swap-helper.js
  const fakeStaged = { dir: 'C:/A/Lumen', root: 'C:/A/Lumen.update/files', old: 'C:/A/Lumen.old', staging: 'C:/A/Lumen.update', script: null, helper: { exe: 'T/lumen-update-helper/Lumen.exe', script: 'T/lumen-update-helper/swap-helper.js', dir: 'T/lumen-update-helper' } };
  const hc = zu.helperCommand({ staged: fakeStaged, execPath: 'C:/A/Lumen/Lumen.exe', errFile: 'C:/P/update-error.txt', pid: 42 });
  const ho = JSON.parse(hc.args[1]);
  check('zip update (win): the swap runs the copied exe in Node mode with a .js helper, detached, from outside the install', hc.command.endsWith('Lumen.exe') && hc.args[0].endsWith('swap-helper.js') && hc.options.env.ELECTRON_RUN_AS_NODE === '1' && hc.options.detached && hc.options.cwd === 'T/lumen-update-helper' && ho.pid === 42 && ho.dir === 'C:/A/Lumen' && ho.root === 'C:/A/Lumen.update/files' && ho.old === 'C:/A/Lumen.old' && ho.exe === 'C:/A/Lumen/Lumen.exe' && ho.errFile === 'C:/P/update-error.txt', JSON.stringify(hc));
  const swapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-swap-unit-'));
  {
    const spawned = [];
    const before = fs.readdirSync(swapDir);
    zu.launchSwap({ staged: fakeStaged, execPath: 'C:/A/Lumen/Lumen.exe', errFile: 'x', platform: 'win32', pid: 1, spawnFn: (...a) => { spawned.push(a); return { unref() {} }; } });
    check('zip update (win): launching writes no .cmd/.bat/.ps1/.vbs and starts no script host', spawned.length === 1 && !/(cmd|powershell|wscript|cscript|pwsh)(\.exe)?$/i.test(spawned[0][0]) && !spawned[0][1].some((x) => /\.(cmd|bat|ps1|vbs)$/i.test(x)) && fs.readdirSync(swapDir).length === before.length, JSON.stringify(spawned));
  }
  fs.rmSync(swapDir, { recursive: true, force: true });
  const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'features', 'swap-helper.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'features', 'zip-update.js'), 'utf8');
  check('zip update (win): the update path has no script hosts, no Unblock-File and no Zone.Identifier tricks', !/powershell|Unblock-File|Zone\.Identifier|wscript|cscript|\.cmd\b|\.bat\b|\.vbs/i.test(helperSrc.replace(/\/\/.*$/gm, '')), 'found one');
  check('zip update (win): the helper copy brings only the exe, its start-up data and the helper script', JSON.stringify(zu.HELPER_FILES) === '["icudtl.dat","snapshot_blob.bin","v8_context_snapshot.bin"]', JSON.stringify(zu.HELPER_FILES));
  // the staged exe sanity check: exists, >10 MB, MZ header
  {
    const { checkExe } = require('../features/swap-helper');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-exe-unit-'));
    const mk = (name, head, size) => { const f = path.join(d, name); const b = Buffer.alloc(size); b.write(head, 'latin1'); fs.writeFileSync(f, b); return f; };
    check('staged exe check: a real-sized MZ file passes', checkExe(mk('ok.exe', 'MZ', 11 * 1024 * 1024)) === null, checkExe(mk('ok.exe', 'MZ', 11 * 1024 * 1024)));
    check('staged exe check: too small, no MZ header, or missing is refused', /too small/.test(checkExe(mk('small.exe', 'MZ', 1000)) || '') && /isn't a Windows executable/.test(checkExe(mk('bad.exe', 'PK', 11 * 1024 * 1024)) || '') && /missing/.test(checkExe(path.join(d, 'nope.exe')) || ''), 'checks');
    fs.rmSync(d, { recursive: true, force: true });
  }
  // the NSIS uninstaller travels with the update
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-carry-unit-'));
    fs.mkdirSync(path.join(d, 'old')); fs.mkdirSync(path.join(d, 'new'));
    fs.writeFileSync(path.join(d, 'old', 'Uninstall Lumen.exe'), 'u'); fs.writeFileSync(path.join(d, 'old', 'other.txt'), 'o');
    zu.carryOver(path.join(d, 'old'), path.join(d, 'new'));
    check('zip update: the NSIS uninstaller is carried into the new folder, nothing else', fs.existsSync(path.join(d, 'new', 'Uninstall Lumen.exe')) && !fs.existsSync(path.join(d, 'new', 'other.txt')), fs.readdirSync(path.join(d, 'new')).join());
    fs.rmSync(d, { recursive: true, force: true });
  }
  // macOS
  const mp = zu.swapPaths('/Applications/Lumen.app/Contents/MacOS/Lumen', 'darwin');
  check('zip update (mac): the app bundle is the install; staging, old and script are its siblings', mp.dir === '/Applications/Lumen.app' && mp.old === '/Applications/Lumen.app.old' && mp.staging === '/Applications/.Lumen.update' && mp.script === '/Applications/.Lumen.update.sh', JSON.stringify(mp));
  check('zip update (mac): the bundle is found from the exe path', zu.macBundle('/Users/me/Apps/Lumen.app/Contents/MacOS/Lumen') === '/Users/me/Apps/Lumen.app' && zu.macBundle('/opt/lumen') === '', 'bundle');
  const msw = zu.macSwapScript({ pid: 42, dir: mp.dir, root: '/Applications/.Lumen.update/files/Lumen.app', old: mp.old, errFile: "/Users/o'brien/update-error.txt", staging: mp.staging, self: mp.script });
  check('zip update (mac): the script waits for the pid, moves the app aside, moves the new one in, clears quarantine, reopens, and rolls back', msw.startsWith('#!/bin/sh') && msw.includes('PID=42') && msw.includes('kill -0 "$PID"') && msw.includes('mv "$APP" "$OLD"') && msw.includes('mv "$NEW" "$APP"') && msw.includes('mv "$OLD" "$APP"') && msw.includes('xattr -cr "$NEW"') && msw.includes('xattr -cr "$APP"') && msw.includes('open "$APP"') && msw.includes('> "$ERR"'), msw);
  check('zip update (mac): paths with quotes are shell-quoted', msw.includes("ERR='/Users/o'\\''brien/update-error.txt'"), msw.split('\n').find((l) => l.startsWith('ERR')));
  const mq = zu.macSwapScript({ pid: 42, dir: mp.dir, root: '/Applications/.Lumen.update/files/Lumen.app', old: mp.old, errFile: '/e', staging: mp.staging, self: mp.script, relaunch: false });
  check('zip update (mac): quitting applies the update without reopening Lumen, and is a no-op when the staged app is gone', !/^\s*open /m.test(mq) && mq.includes('[ -d "$NEW" ] ||') && mq.includes('mv "$NEW" "$APP"') && /^\s*open /m.test(msw) && !msw.includes('[ -d "$NEW" ] ||'), mq);
  check('zip update (win): relaunch defaults to true and quit-apply passes false to the helper', JSON.parse(hc.args[1]).relaunch === true && JSON.parse(zu.helperCommand({ staged: fakeStaged, execPath: 'C:/A/Lumen/Lumen.exe', errFile: 'e', pid: 1, relaunch: false }).args[1]).relaunch === false, 'relaunch');
  {
    // a staged update left by an earlier run: reused only while it is complete
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-staged-unit-'));
    const exe = path.join(d, 'Lumen', 'Lumen.exe');
    const sp = zu.swapPaths(exe);
    const root = path.join(sp.staging, 'files', 'Lumen');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'Lumen.exe'), 'x');
    const ok = () => null;
    check('staged update: no marker means nothing to reuse', zu.readStaged(exe, 'win32', ok) === null, 'no marker');
    fs.writeFileSync(path.join(sp.staging, 'staged.json'), JSON.stringify({ version: '9.9.9', sha512: 'h', root: 'files/Lumen' }));
    const got = zu.readStaged(exe, 'win32', ok);
    check('staged update: a marker with an intact folder restores the version and paths', got && got.version === '9.9.9' && got.sha512 === 'h' && got.staged.root === root && got.staged.dir === sp.dir && got.staged.old === sp.old, JSON.stringify(got));
    check('staged update: a damaged exe is refused', zu.readStaged(exe, 'win32', () => 'too small') === null, 'exe');
    fs.writeFileSync(path.join(sp.staging, 'staged.json'), JSON.stringify({ version: '9.9.9', root: '../../elsewhere' }));
    check('staged update: a marker pointing outside the staging folder is not trusted', zu.readStaged(exe, 'win32', ok) === null, 'escape');
    fs.writeFileSync(path.join(sp.staging, 'staged.json'), '{not json');
    check('staged update: an unreadable marker is not trusted', zu.readStaged(exe, 'win32', ok) === null && zu.readMarker(exe) === null, 'garbage');
    fs.writeFileSync(path.join(sp.staging, 'staged.json'), JSON.stringify({ version: '9.9.9', root: 'files/Gone' }));
    check('staged update: a missing folder is not reused', zu.readStaged(exe, 'win32', ok) === null, 'gone');
    fs.rmSync(d, { recursive: true, force: true });
  }
  const macTree = { flat: ['__MACOSX', 'Lumen.app'], none: ['a.txt'] };
  const macLs = (d) => (macTree[d] || []).map((n) => ({ name: n, isDirectory: () => !n.endsWith('.txt') }));
  check('zip update (mac): finds Lumen.app in the unpacked zip', zu.findApp('flat', 'Lumen.app', macLs) === path.join('flat', 'Lumen.app') && zu.findApp('none', 'Lumen.app', macLs) === null, 'app');
  // writable location
  const okProbe = () => {};
  const badProbe = () => { throw new Error('EACCES'); };
  const okAccess = () => {};
  const winExe = 'C:\\Users\\me\\AppData\\Local\\Programs\\Lumen\\Lumen.exe';
  check('install location: writable folder and parent can be replaced', zu.canReplace(winExe, 'win32', okProbe, okAccess), 'ok');
  check('install location: a folder that is not writable can not (Program Files style)', !zu.canReplace('C:\\Program Files\\Lumen\\Lumen.exe', 'win32', okProbe, (d) => { if (/Program Files/.test(d)) throw new Error('EACCES'); }), 'dir');
  check('install location: a writable folder inside an unwritable parent can not', !zu.canReplace('C:\\Program Files\\Lumen\\Lumen.exe', 'win32', okProbe, (d) => { if (d === 'C:\\Program Files') throw new Error('EACCES'); }), 'parent');
  check('install location: access() passing but a real write failing (ACLs) can not', !zu.canReplace(winExe, 'win32', badProbe, okAccess), 'probe');
  check('install location (mac): /Applications not writable can not; writable can', !zu.canReplace('/Applications/Lumen.app/Contents/MacOS/Lumen', 'darwin', okProbe, (d) => { if (d === '/Applications') throw new Error('EACCES'); }) && zu.canReplace('/Applications/Lumen.app/Contents/MacOS/Lumen', 'darwin', okProbe, okAccess), 'mac');
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-probe-unit-'));
    fs.mkdirSync(path.join(d, 'Lumen'));
    check('install location: the real probe passes on a temp install and leaves nothing behind', zu.canReplace(path.join(d, 'Lumen', 'Lumen.exe'), 'win32') && fs.readdirSync(d).join() === 'Lumen' && fs.readdirSync(path.join(d, 'Lumen')).length === 0, fs.readdirSync(d).join());
    check('install location: a folder that does not exist can not be replaced', !zu.canReplace(path.join(d, 'gone', 'Lumen.exe'), 'win32'), 'gone');
    fs.rmSync(d, { recursive: true, force: true });
  }
  const { disabledReason, installKind, updateMode, isNewer, stageAsset, manualAsset } = require('../features/updates');
  check('updates: off in a development run', disabledReason({ packaged: false, test: false }) === 'dev', disabledReason({ packaged: false }));
  check('updates: off in test mode', disabledReason({ packaged: false, test: true }) === 'test', disabledReason({ packaged: false, test: true }));
  check('updates: a test can opt in (test mode only)', disabledReason({ packaged: false, test: true, override: true }) === null && disabledReason({ packaged: false, test: false, override: true }) === 'dev', 'override');
  check('updates: off in the MCP bridge, even packaged', disabledReason({ packaged: true, mcp: true }) === 'mcp' && disabledReason({ packaged: false, test: true, override: true, mcp: true }) === 'mcp', 'mcp');
  check('updates: on in a packaged app', disabledReason({ packaged: true, test: false }) === null, disabledReason({ packaged: true }));

  const exe = path.join('C:', 'Users', 'me', 'AppData', 'Local', 'Programs', 'Lumen', 'Lumen.exe');
  const uninstaller = path.join(path.dirname(exe), 'Uninstall Lumen.exe');
  const nsis = installKind({ platform: 'win32', execPath: exe, exists: (p) => p === uninstaller });
  check('updates: a Windows copy next to the NSIS uninstaller is an installed copy', nsis === 'nsis', nsis);
  const zip = installKind({ platform: 'win32', execPath: exe, exists: () => false });
  check('updates: a Windows copy without it (zip, hand-copied) is a zip copy', zip === 'zip', zip);
  const portable = installKind({ platform: 'win32', execPath: exe, env: { PORTABLE_EXECUTABLE_DIR: 'D:\\' }, exists: () => true });
  check('updates: a portable exe is its own kind', portable === 'portable', portable);
  const mac = installKind({ platform: 'darwin', execPath: '/Applications/Lumen.app/Contents/MacOS/Lumen', exists: () => true });
  check('updates: macOS is the mac kind', mac === 'mac', mac);
  check('updates: Linux falls back to the releases page', installKind({ platform: 'linux', execPath: '/opt/lumen/lumen' }) === 'other' && manualAsset({ kind: 'other', version: '1.0.0' }) === null && stageAsset({ kind: 'other', version: '1.0.0' }) === null, 'linux');
  const yes = () => true;
  const no = () => false;
  check('updates: a writable NSIS install (per-user) swaps in place like a zip copy', updateMode({ kind: 'nsis', replaceable: yes }) === 'stage' && updateMode({ kind: 'zip', replaceable: yes }) === 'stage' && updateMode({ kind: 'mac', replaceable: yes }) === 'stage', 'stage');
  check('updates: a per-machine / unwritable install falls back to the manual prompt', updateMode({ kind: 'nsis', replaceable: no }) === 'manual' && updateMode({ kind: 'mac', replaceable: no }) === 'manual' && updateMode({ kind: 'zip', replaceable: no }) === 'manual', 'manual');
  check('updates: portable and Linux never swap, and never even probe the disk', updateMode({ kind: 'portable', replaceable: () => { throw new Error('probed'); } }) === 'manual' && updateMode({ kind: 'other', replaceable: () => { throw new Error('probed'); } }) === 'manual', 'portable');

  check('updates: version compare', isNewer('0.3.0', '0.2.4') && isNewer('v0.2.10', '0.2.9') && isNewer('1.0.0', '0.99.99') && !isNewer('0.2.4', '0.2.4') && !isNewer('0.2.3', '0.2.4'), 'semver');
  check('updates: a pre-release sorts before its release', isNewer('1.0.0', '1.0.0-beta.2') && !isNewer('1.0.0-beta.2', '1.0.0') && isNewer('1.0.0-beta.10', '1.0.0-beta.2'), 'pre');

  const base = 'https://github.com/emah-maker/lumen/releases/download/v0.3.0/';
  const arm = manualAsset({ kind: 'mac', version: '0.3.0', arch: 'arm64' });
  check('updates: an Apple silicon Mac gets the arm64 dmg', arm.url === `${base}Lumen-0.3.0-mac-arm64.dmg`, JSON.stringify(arm));
  check('updates: an Intel Mac gets the x64 dmg', manualAsset({ kind: 'mac', version: '0.3.0', arch: 'x64' }).name === 'Lumen-0.3.0-mac-x64.dmg', manualAsset({ kind: 'mac', version: '0.3.0', arch: 'x64' }).name);
  check('updates: Apple silicon stages the arm64 zip and Intel the x64 zip', stageAsset({ kind: 'mac', version: '0.3.0', arch: 'arm64' }).url === `${base}Lumen-0.3.0-mac-arm64.zip` && stageAsset({ kind: 'mac', version: '0.3.0', arch: 'x64' }).name === 'Lumen-0.3.0-mac-x64.zip', 'mac zip');
  check('updates: installed and zip Windows copies stage the win zip', stageAsset({ kind: 'nsis', version: '0.3.0', arch: 'x64' }).name === 'Lumen-0.3.0-win-x64.zip' && stageAsset({ kind: 'zip', version: '0.3.0' }).name === 'Lumen-0.3.0-win-x64.zip' && stageAsset({ kind: 'portable', version: '0.3.0' }) === null, 'win zip');
  check("updates: the staged zip's hash comes from the release info (latest-mac.yml lists both zips)", zu.expectedHash([{ url: 'Lumen-0.3.0-mac-arm64.zip', sha512: 'A' }, { url: 'Lumen-0.3.0-mac-x64.zip', sha512: 'X' }, { url: 'Lumen-0.3.0-mac-x64.dmg', sha512: 'D' }], 'Lumen-0.3.0-mac-x64.zip') === 'X', 'yml');
  check('updates: a per-machine installed copy has no file to drop in, so the releases page', manualAsset({ kind: 'nsis', version: '0.3.0' }) === null, 'nsis manual');
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
// ---- agent loop guards (loop-guard.js)
{
  const { RepeatDetector, withNote, trimToolResults, cacheLastTool } = require('../loop-guard');
  const d = new RepeatDetector();
  const click = { element_id: 7 };
  check('repeat: first failure has no note', d.record('click', click, false) === null, '');
  check('repeat: second identical failure warns', /failed twice/.test(d.record('click', click, false) || ''), '');
  check('repeat: third identical failure forces a new strategy', /REPEAT/.test(d.record('click', click, false) || ''), '');
  const e = new RepeatDetector();
  const notes = ['a', 'b', 'c', 'd'].map((x) => e.record('click', { text: x }, false));
  check('repeat: four different failures in a row are flagged', /4 tool calls/.test(notes[3] || '') && !notes[1], JSON.stringify(notes));
  const f = new RepeatDetector();
  f.record('navigate', { url: 'a' }, true); f.record('navigate', { url: 'a' }, true);
  check('repeat: same successful call three times is flagged', /same call 3 times/.test(f.record('navigate', { url: 'a' }, true) || ''), '');
  const g = new RepeatDetector();
  const scrolls = [1, 2, 3, 4].map(() => g.record('scroll', { direction: 'down' }, true));
  check('repeat: scrolling or re-reading repeatedly is not flagged', scrolls.every((n) => n === null), '');
  g.record('click', click, false);
  check('repeat: a success breaks a failure run', g.record('click', click, true) === null, '');
  check('withNote: string, blocks, passthrough', withNote('x', 'n') === 'x\n\nn' && withNote([{ type: 'text', text: 'x' }], 'n').length === 2 && withNote('x', null) === 'x' && withNote({ a: 1 }, 'n').a === 1, '');

  const result = (id, content) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
  const big = 'y'.repeat(5000);
  const history = [{ role: 'user', content: 'hi' }, result('1', big), result('2', [{ type: 'image', source: {} }, { type: 'text', text: big }]), result('3', big), result('4', big), result('5', big), result('6', big)];
  const trimmed = trimToolResults(history, { keep: 4, maxChars: 100 });
  check('trim: old results are cut, images dropped, recent kept whole', trimmed[1].content[0].content.length < 200 && trimmed[2].content[0].content[0].text.includes('omitted') && trimmed[3].content[0].content.length === 5000 && trimmed[6].content[0].content.length === 5000, JSON.stringify(trimmed[1]).slice(0, 120));
  check('trim: does not mutate its input, and small histories pass through', history[1].content[0].content === big && trimToolResults(history.slice(0, 3), { keep: 4 }) === history.slice(0, 3) || trimToolResults(history.slice(0, 3), { keep: 4 }).length === 3, '');

  {
    const { RunBudget, stepLimit, turnLimitHit, WRAP_UP, LIMIT_NOTICE, SAFETY_CEILING } = require('../loop-guard');
    const fin = new RunBudget({ limit: 60 });
    const notes = Array.from({ length: 60 }, (_, s) => fin.stepNote(s));
    check('budget: no note before 75% of a chosen limit', notes.slice(0, 44).every((n) => n === null), '');
    check('budget: warns at 75% with the steps left', /^NOTE: 15 steps left/.test(notes[44] || ''), String(notes[44]));
    check('budget: quiet between the first warning and the last five', notes[45] === null && /5 steps left/.test(notes[54] || '') && /1 steps? left|FINAL STEP/.test(notes[58] || ''), JSON.stringify(notes.slice(44, 60)));
    check('budget: the step before the last says tools go off; the last step is final', /FINAL STEP NEXT/.test(notes[58] || '') && notes[59] === null && fin.isFinal(59) && !fin.isFinal(58), '');
    const free = new RunBudget();
    check('budget: unlimited has no countdown, only the safety ceiling wrap-up', free.max === SAFETY_CEILING && Array.from({ length: 900 }, (_, s) => free.stepNote(s)).every((n) => n === null) && /FINAL STEP/.test(free.stepNote(SAFETY_CEILING - 2)) && free.isFinal(SAFETY_CEILING - 1), '');
    check('budget: stepLimit accepts positive ints, everything else is unlimited', stepLimit(30) === 30 && stepLimit(0) === 0 && stepLimit(undefined) === 0 && stepLimit('60') === 0 && stepLimit(-4) === 0 && stepLimit(1.5) === 0 && stepLimit(99999) === SAFETY_CEILING, '');
    const sc = new RunBudget();
    const scriptNotes = [1, 2, 3, 4].map(() => { sc.countCall('run_script'); return sc.scriptNote(); });
    sc.countCall('click');
    check('budget: first two run_script calls are clean, later ones get a last-resort note, none blocked', scriptNotes[0] === null && scriptNotes[1] === null && /last resort/.test(scriptNotes[2] || '') && /call 4/.test(scriptNotes[3] || '') && sc.toolCalls === 5 && sc.scripts === 4, JSON.stringify(scriptNotes));
    const st = new RepeatDetector();
    for (let i = 0; i < 4; i++) st.record('click', { element_id: 1 }, false);
    const early = st.stalled;
    st.record('click', { element_id: 1 }, false);
    check('repeat: the strongest escalation (5 identical failures) marks the run stalled, weaker ones do not', early === false && st.stalled === true && !new RepeatDetector().stalled, '');
    const st2 = new RepeatDetector();
    ['a', 'b', 'c', 'd', 'e', 'f'].forEach((x) => st2.record('click', { text: x }, false));
    check('repeat: six different failures in a row also stall the run', st2.stalled === true, '');
    check('wrap-up: texts tell the model to answer without tools; notice offers continue', /Do not call any more tools/.test(WRAP_UP.limit) && /Do not call any more tools/.test(WRAP_UP.stalled) && /Say "continue"/.test(LIMIT_NOTICE), '');
    check('cli: error_max_turns result is a turn limit, not a failure', turnLimitHit({ type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: 31, session_id: 'x' }) && turnLimitHit({ type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: 'max_turns' }) && turnLimitHit({ subtype: 'error_during_execution', errors: ['Reached maximum number of turns (30)'] }), '');
    check('cli: success, cancellations and other errors are not turn limits', !turnLimitHit({ subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'max turns are 30' }) && !turnLimitHit({ subtype: 'error_during_execution', is_error: true, errors: ['cancelled'] }) && !turnLimitHit(null), '');
    const cc = require('../claude-code');
    const gb = require('../grok-build');
    const ccArgs = (maxTurns) => cc.buildArgs({ mcpConfig: 'm', sessionId: 's', resume: false, systemPrompt: 'p', maxTurns });
    const gbArgs = (maxTurns) => gb.buildArgs({ promptFile: 'f', sessionId: 's', resume: false, systemPrompt: 'p', cwd: 'c', maxTurns });
    const flag = (a) => a[a.indexOf('--max-turns') + 1];
    check('cli args: Claude Code has no cap when unlimited, the chosen cap otherwise', !ccArgs(0).includes('--max-turns') && flag(ccArgs(60)) === '60', '');
    check('cli args: Grok always has a cap: the chosen one, else 100', flag(gbArgs(120)) === '120' && flag(gbArgs(0)) === '100' && !gb.ARGS_BASE.includes('--max-turns'), '');
    const { DEFAULTS } = require('../settings-backend');
    check('setting: maxSteps defaults to unlimited', DEFAULTS.maxSteps === 0, '');
  }

  const { ReadCache } = require('../snapshot');
  const rc = new ReadCache();
  check('read cache: first read is full, an identical soon read is one line', rc.check(1, 'https://a.test/', 'c', 'page') === null && /Unchanged/.test(rc.check(1, 'https://a.test/', 'c', 'page') || ''), '');
  check('read cache: other content, URL, request shape or tab is a full read', rc.check(1, 'https://a.test/', 'c', 'page 2') === null && rc.check(1, 'https://b.test/', 'c', 'page 2') === null && rc.check(1, 'https://b.test/', 'f', 'page 2') === null && rc.check(2, 'https://b.test/', 'f', 'page 2') === null, '');
  rc.check(1, 'u', 'c', 'x'); rc.tick('click');
  check('read cache: a click invalidates it, reads and searches do not', rc.check(1, 'u', 'c', 'x') === null && (rc.tick('find'), rc.tick('screenshot'), /Unchanged/.test(rc.check(1, 'u', 'c', 'x') || '')), '');
  for (let i = 0; i < 8; i++) rc.tick('find');
  check('read cache: too many calls later the model gets the page again', rc.check(1, 'u', 'c', 'x') === null && /Unchanged/.test(rc.check(1, 'u', 'c', 'x') || ''), '');

  {
    const { requestFor, DEFAULT_MODEL } = require('../agent');
    const msgs = (extra) => Object.assign([{ role: 'user', content: 'hi' }, ...extra], { settings: { model: DEFAULT_MODEL } });
    const a = requestFor(msgs([]).settings, msgs([]));
    const b = requestFor(msgs([]).settings, msgs([{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'more' }]));
    const marks = (p) => (JSON.stringify(p).match(/"cache_control"/g) || []).length;
    check('request: tools + system prefix is identical across turns (cache-stable)', JSON.stringify([a.tools, a.system]) === JSON.stringify([b.tools, b.system]), '');
    check('request: at most 4 cache breakpoints, one on the last tool and one on system', marks(a) <= 4 && a.tools[a.tools.length - 1].cache_control && a.system[0].cache_control, String(marks(a)));
    const { isSimpleQuestion } = require('../loop-guard');
    check('simple turn: plain questions qualify, page or action requests and images do not', isSimpleQuestion('What is the capital of France?') && !isSimpleQuestion('summarize this') && !isSimpleQuestion('Book a table at 7') && !isSimpleQuestion('what is on the left?', 1) && !isSimpleQuestion('see https://x.test') && !isSimpleQuestion('x'.repeat(200)), '');
    const simple = msgs([]);
    simple.simpleTurn = simple[0];
    const sp = requestFor(simple.settings, simple);
    const later = msgs([{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'more' }]);
    later.simpleTurn = later[0];
    const lp = requestFor(later.settings, later);
    const picked = msgs([]);
    picked.settings.model = 'claude-sonnet-5';
    picked.simpleTurn = picked[0];
    check('simple turn: low effort and small cap on the first turn only, and not on a picked model', sp.output_config.effort === 'low' && sp.max_tokens <= 8000 && lp.max_tokens === 64000 && lp.output_config.effort === 'high' && requestFor(picked.settings, picked).max_tokens === 64000, JSON.stringify([sp.output_config, lp.output_config]));
    check('request: tool definitions stay under 10k chars (about 2.5k tokens)', JSON.stringify(a.tools).length < 10000, String(JSON.stringify(a.tools).length));
  }

  const tools = [{ name: 'a', cache_control: { type: 'ephemeral' } }, { name: 'b' }, { name: 'c' }];
  const cached = cacheLastTool(tools);
  check('cache_control: only the last tool is marked, input untouched', cached.filter((t) => t.cache_control).length === 1 && cached[2].cache_control.type === 'ephemeral' && tools[0].cache_control && cacheLastTool([]).length === 0, JSON.stringify(cached));
}

async function schedulerRuns() {
  const { runToolUses } = require('../loop-guard');
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uses = [{ name: 'read_page', input: {} }, { name: 'find', input: {} }, { name: 'click', input: {} }, { name: 'screenshot', input: {} }, { name: 'read_urls', input: {} }].map((u, i) => ({ ...u, id: `t${i}` }));
  const out = await runToolUses(uses, {
    gate: async (u) => { log.push(`gate:${u.id}`); await sleep(1); },
    exec: async (u) => { log.push(`start:${u.id}`); await sleep(u.id === 't0' ? 30 : 5); log.push(`end:${u.id}`); return u.id; },
  });
  check('parallel: results come back in call order', out.map((o) => o.value).join() === 't0,t1,t2,t3,t4', JSON.stringify(out));
  check('parallel: every gate in a read group runs before any of them starts', log.indexOf('gate:t1') < log.indexOf('start:t0'), log.join(' '));
  check('parallel: reads overlap (t1 ends before slow t0)', log.indexOf('end:t1') < log.indexOf('end:t0'), log.join(' '));
  check('parallel: an action waits for the reads before it and runs alone', log.indexOf('end:t0') < log.indexOf('gate:t2') && log.indexOf('end:t2') < log.indexOf('start:t3'), log.join(' '));

  const denied = await runToolUses(uses.slice(0, 3), {
    gate: async (u) => { if (u.id === 't1') throw new Error('no'); },
    exec: async (u) => u.id,
  });
  check('parallel: a denied gate fails only that call, others still run', denied[0].ok && !denied[1].ok && denied[1].gated && denied[2].ok, JSON.stringify(denied));

  const halted = await runToolUses(uses, { gate: async () => {}, exec: async (u) => { if (u.id === 't1') throw new Error('gone'); return 1; }, halts: (o) => o && o.ok === false });
  check('parallel: a halting outcome skips the calls after its group', halted[0].ok && !halted[1].ok && halted.slice(2).every((o) => o.skipped), JSON.stringify(halted));
  check('parallel: read_page since_last and run_script stay sequential', !require('../loop-guard').isParallelRead({ name: 'read_page', input: { since_last: true } }) && !require('../loop-guard').isParallelRead({ name: 'run_script', input: {} }) && require('../loop-guard').isParallelRead({ name: 'read_pdf', input: {} }), '');
}

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

// ---- read_pdf: text extraction and the per-chat permission gate (features/pdf-text.js)
async function pdfRuns() {
  const zlib = require('zlib');
  const pdfText = require('../features/pdf-text');
  const objs = [];
  const add = (dict, stream) => objs.push(stream ? Buffer.concat([Buffer.from(`${dict.replace('>>', `/Length ${stream.length}>>`)}\nstream\n`), stream, Buffer.from('\nendstream')]) : Buffer.from(dict));
  add('<</Type/Catalog/Pages 2 0 R>>');
  add('<</Type/Pages/Kids[3 0 R 7 0 R]/Count 2/Resources<</Font<</F1 5 0 R /F2 8 0 R>>>>>>');
  add('<</Type/Page/Parent 2 0 R/Contents 4 0 R>>');
  add('<</Filter/FlateDecode>>', zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 700 Td (Hello \\(PDF\\) world) Tj 0 -14 Td [(Second) -300 (line)] TJ ET')));
  add('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  add('<<>>', Buffer.alloc(0));
  add('<</Type/Page/Parent 2 0 R/Contents 9 0 R>>');
  add('<</Type/Font/Subtype/Type0/ToUnicode 10 0 R>>');
  add('<<>>', Buffer.from('BT /F2 12 Tf <00010002> Tj ET'));
  add('<<>>', Buffer.from('/CIDInit begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0048> <0002> <0069> endbfchar endcmap'));
  const parts = [Buffer.from('%PDF-1.4\n')];
  objs.forEach((o, i) => parts.push(Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')));
  parts.push(Buffer.from('trailer\n<</Root 1 0 R>>\n%%EOF'));
  const pdf = Buffer.concat(parts);

  const all = pdfText.extractPdfText(pdf);
  check('pdf text: pages, a compressed stream, escapes, TJ gaps and a ToUnicode font',
    all.numPages === 2 && all.text.includes('Hello (PDF) world') && all.text.includes('Second line') && all.text.includes('--- Page 2 of 2 ---\nHi') && !all.truncated, JSON.stringify(all));
  const second = pdfText.extractPdfText(pdf, { pages: '2' });
  check('pdf text: a page range', second.pages.join() === '2' && !second.text.includes('Hello'), JSON.stringify(second));
  const cut = pdfText.extractPdfText(pdf, { maxChars: 60 });
  check('pdf text: output is capped and says where to continue', cut.truncated && cut.next === 2 && cut.pages.join() === '1', JSON.stringify(cut));
  check('pdf text: ranges parse ("4-", "1-3,7", out of range)', pdfText.parsePageRange('3-', 5).join() === '3,4,5' && pdfText.parsePageRange('1-2,4', 9).join() === '1,2,4' && pdfText.parsePageRange('9', 3).length === 0, 'ranges');
  let bad = '';
  try { pdfText.extractPdfText(Buffer.from('hello')); } catch (err) { bad = err.message; }
  check('pdf text: a file that is not a PDF is refused', /not a PDF/.test(bad), bad);

  const url = require('url').pathToFileURL('/Users/secret-person/Taxes/2025 return.pdf').href;
  check('pdf card shows the file name only, never the folder', pdfText.pdfName(url) === '2025 return.pdf' && pdfText.pdfName('https://x.test/a/b%20c.pdf?token=1') === 'b c.pdf', pdfText.pdfName(url));
  const chat = [];
  const asked = [];
  const ask = (answer) => async (name) => { asked.push(name); return answer; };
  check('pdf gate: a denial is refused and not remembered', (await pdfText.requirePdfPermission(chat, url, ask(false))) === false && !chat.pdfAllowed.size, 'denied');
  check('pdf gate: an allow is asked once per PDF in a chat', (await pdfText.requirePdfPermission(chat, url, ask(true))) === true && (await pdfText.requirePdfPermission(chat, `${url}#page=3`, ask(false))) === true && asked.length === 2, JSON.stringify(asked));
  check('pdf gate: another PDF, and another chat, ask again', (await pdfText.requirePdfPermission(chat, 'https://x.test/other.pdf', ask(false))) === false && (await pdfText.requirePdfPermission([], url, ask(false))) === false && asked.length === 4, JSON.stringify(asked));
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'agent.js'), 'utf8');
  check('read_pdf is a reading tool (it taints the run) with a tool definition', /READING_TOOLS = new Set\([^)]*'read_pdf'/.test(agentSrc) && /name: 'read_pdf'/.test(agentSrc), 'agent.js');
}

// ---- macOS re-signing with Lumen's own certificate (scripts/after-sign.js)
{
  const { identityHash } = require('../scripts/after-sign');
  const hash = '5CBDFCED634205BA0AAF0B7C097B0A331A48D467';
  const good = `  1) ${hash} "Lumen Release Signing" (CSSMERR_TP_NOT_TRUSTED)\n     1 identities found\n`;
  check('after-sign: finds the Lumen identity by name, trusted or not', identityHash(good, 'Lumen Release Signing') === hash, String(identityHash(good, 'Lumen Release Signing')));
  check('after-sign: another identity name is not picked', identityHash(good, 'Somebody Else') === null, 'picked');
  check('after-sign: an empty listing has no identity', identityHash('     0 identities found\n', 'Lumen Release Signing') === null, 'picked');
}

// ---- usage: Lumen's share of the account-wide 5-hour meter ignores your other Claude Code use
async function usageShareRuns() {
  const { createUsage, otherClaudeActivity } = require('../features/usage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-share-'));
  const mkfile = (dir, name, ageMs) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const f = path.join(root, dir, name);
    fs.writeFileSync(f, '{}');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
  };
  const since = Date.now() - 60000;
  mkfile('C--tmp-lumen-cc-AAAA', 's.jsonl', 0);
  mkfile('C--tmp-lumen-usage-BBBB', 's.jsonl', 0);
  mkfile('C--proj-other', 'old.jsonl', 3600e3);
  check('other Claude activity: Lumen\'s own folders and old transcripts do not count', (await otherClaudeActivity(since, root)) === false, 'counted');
  mkfile('C--proj-other', 'new.jsonl', 1000);
  check('other Claude activity: a recent transcript elsewhere does', (await otherClaudeActivity(since, root)) === true, 'missed');
  check('other Claude activity: no projects folder is not activity', (await otherClaudeActivity(since, path.join(root, 'nope'))) === false, 'counted');
  fs.rmSync(root, { recursive: true, force: true });

  const run = async (other) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-share-u-'));
    const u = createUsage({ app: { getPath: () => dir }, claudeBin: async () => null, otherActivity: async () => other });
    const turn = (pct) => ({ usage: { inputTokens: 1, outputTokens: 1, models: ['m'] }, rateLimit: { unifiedWindows: { five_hour: { utilization: pct, resetsAt: Date.now() / 1000 + 3600 } } } });
    u.record('claudecode', turn(0.10));
    u.record('claudecode', turn(0.16));
    await new Promise((r) => setTimeout(r, 30));
    const points = (await u.summary({ refresh: false })).lumen?.window?.limitPoints;
    fs.rmSync(dir, { recursive: true, force: true });
    return points;
  };
  const alone = await run(false);
  check('share of the meter: alone, the second turn is credited with its movement', Math.abs(alone - 6) < 0.01, String(alone));
  const shared = await run(true);
  check('share of the meter: with other Claude use in between, it is left unknown, not credited', shared == null, String(shared));
}

// ---- sidebar speed: incremental markdown tail, cached CLI lookup, passive usage refresh
async function speedRuns() {
  const { render, stableLength } = require('../renderer/markdown');
  const src = 'Intro line\n\n- a\n- b\n\n```js\nx\n\ny\n```\n\nTail text';
  const cut = stableLength(src);
  check('markdown: stable head ends at the last blank line outside a code fence', src.slice(cut) === 'Tail text', JSON.stringify(src.slice(cut)));
  check('markdown: a blank line inside an open fence is not a boundary', stableLength('a\n\n```\nx\n\ny\n') === 3, String(stableLength('a\n\n```\nx\n\ny\n')));
  check('markdown: head + tail render the same as the whole', render(src.slice(0, cut)) + render(src.slice(cut)) === render(src), 'split');
  check('markdown: no boundary without a finished blank line', stableLength('one\ntwo') === 0 && stableLength('one\n') === 0, 'none');
  const eng = new cc.ClaudeCodeEngine({ userData: os.tmpdir(), mcpCommand: () => ({}), ensureServer: () => {} });
  let looks = 0;
  eng.detect = async () => { looks++; return eng.bin; };
  eng.bin = process.execPath;
  const a = await eng.ensureBin();
  check('CLI lookup: a binary found earlier is reused, no new `where`', a === process.execPath && looks === 0, String(looks));
  eng.bin = path.join(os.tmpdir(), 'no-such-claude-bin');
  await eng.ensureBin();
  check('CLI lookup: a binary that vanished is looked for again', looks === 1, String(looks));
  const { createUsage } = require('../features/usage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-u-'));
  let probes = 0;
  const u = createUsage({ app: { getPath: () => dir }, claudeBin: async () => { probes++; return null; } });
  await u.summary({ refresh: true });
  u.record('claudecode', { usage: { inputTokens: 1, outputTokens: 1, models: ['x'] }, rateLimit: { unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: Date.now() / 1000 + 3600 } } } });
  const before = probes;
  await u.summary({ refresh: false });
  check('usage: the after-reply refresh skips /usage while the 5-hour reading is fresh', probes === before && before === 1, `${before} ${probes}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- lumen://chat (features/chat-page.js): the URL guard, who may call what, and which tab the AI works in
async function chatPageRuns() {
  const { EventEmitter } = require('events');
  const chatPage = require('../features/chat-page');
  const { pathToFileURL } = require('url');
  const CHAT = chatPage.CHAT_URL;
  check('chat page: its own URL is recognised, with a hash or query', chatPage.isChatUrl(CHAT) && chatPage.isChatUrl(`${CHAT}#x`) && chatPage.isChatUrl(`${CHAT}?a=1`), CHAT);
  check('chat page: the path compares without case (Windows)', chatPage.isChatUrl(CHAT.replace('chat-page.html', 'CHAT-Page.HTML')), CHAT);
  check('chat page: web pages, other local pages and script URLs are not it',
    ['https://example.com/', 'http://127.0.0.1/renderer/chat-page.html', 'javascript:1', '', null, undefined, 42, 'file:///etc/passwd',
      pathToFileURL(path.join(__dirname, '..', 'renderer', 'chat-page.html.evil')).href,
      pathToFileURL(path.join(__dirname, '..', 'renderer', 'settings.html')).href,
      pathToFileURL(path.join(__dirname, '..', 'renderer', 'chat-page.htmlx')).href,
      `https://x.test/?u=${CHAT}`].every((u) => !chatPage.isChatUrl(u)), 'lookalike accepted');
  check('chat page: lumen://chat and chrome://chat are typed forms of it, nothing near them is',
    Boolean(chatPage.parseChatInput('lumen://chat')) && Boolean(chatPage.parseChatInput(' chrome://CHAT/ ')) && ['lumen://chats', 'lumen://chat/x', 'chat', 'https://chat.example', 'lumen://settings', '', null].every((x) => !chatPage.parseChatInput(x)), 'parse');
  check('chat page: it shows as lumen://chat in the address bar', chatPage.displayUrl(CHAT) === 'lumen://chat', chatPage.displayUrl(CHAT));

  // Every other tab: nothing can navigate, redirect or load a frame there.
  const other = new EventEmitter();
  chatPage.guardOthers(other);
  const tryNav = (wc, name, url, extra = {}) => { let stopped = false; wc.emit(name, { url, preventDefault: () => { stopped = true; }, ...extra }); return stopped; };
  check('chat page guard: a web page navigating to the chat page is stopped (navigate, redirect, frame)', ['will-navigate', 'will-redirect', 'will-frame-navigate'].every((n) => tryNav(other, n, CHAT)), 'not stopped');
  check('chat page guard: ordinary navigation is left alone', ['will-navigate', 'will-redirect', 'will-frame-navigate'].every((n) => !tryNav(other, n, 'https://example.com/')), 'blocked');
  // The chat tab itself is locked to its page.
  const own = new EventEmitter();
  let left = null;
  own.setWindowOpenHandler = (fn) => { own.open = fn; };
  chatPage.guardTab(own, (url) => { left = url; });
  check('chat page guard: the chat tab refuses other pages, redirects and popups', tryNav(own, 'will-navigate', 'https://example.com/') && tryNav(own, 'will-redirect', CHAT) && tryNav(own, 'will-frame-navigate', CHAT, { isMainFrame: false }) && own.open().action === 'deny', 'open');
  check('chat page guard: the chat page can reload itself', !tryNav(own, 'will-navigate', CHAT) && !tryNav(own, 'will-frame-navigate', `${CHAT}#x`, { isMainFrame: true }), 'blocked');
  own.emit('did-navigate', {}, 'https://example.com/');
  await new Promise((r) => setImmediate(r));
  check('chat page guard: a page that still commits in the chat tab moves to an ordinary tab', left === 'https://example.com/', String(left));

  // What the page's preload may send: only chat calls, checked against the allowlist main enforces.
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'features', 'chat-preload.js'), 'utf8');
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.(?:send|invoke|sendSync)\('([^']+)'/g)].map((m) => m[1]);
  check('chat page preload: every call it can make is on the allowlist', channels.length > 10 && channels.every((c) => chatPage.CHAT_IPC.has(c)), channels.filter((c) => !chatPage.CHAT_IPC.has(c)).join(', '));
  const risky = [...chatPage.CHAT_IPC].filter((c) => /^(mcp|automation|import|cli|claudecode):|set-provider-key|sign-in|prefs:(?!ui)|set-ai-site|updates|:clear|relaunch/.test(c));
  check('chat page allowlist: no keys, sign-in, MCP, automation, import, CLI or data-clearing calls', risky.length === 0, risky.join(', '));
  check('chat page allowlist: settings calls are the model list and the model pick only', [...chatPage.CHAT_IPC].filter((c) => c.startsWith('settings:')).sort().join() === 'settings:get,settings:set-model', [...chatPage.CHAT_IPC].join(','));

  // Which tab the AI works in when a run starts on the chat page.
  const tab = (id, more = {}) => ({ id, chat: false, offLimits: false, closing: false, viewedAt: 0, lastActiveAt: 0, ...more });
  check('target tab: the one looked at last, not the chat tab in front', chatPage.pickTargetTab([tab(1, { viewedAt: 100 }), tab(2, { viewedAt: 300 }), tab(3, { chat: true, viewedAt: 900 })]) === 2, 'pick');
  check('target tab: Settings, Bookmarks and other off-limits tabs and closing tabs are skipped', chatPage.pickTargetTab([tab(1, { viewedAt: 100 }), tab(2, { viewedAt: 500, offLimits: true }), tab(3, { viewedAt: 400, closing: true })]) === 1, 'pick');
  check('target tab: no ordinary tab means none (main opens one)', chatPage.pickTargetTab([tab(1, { chat: true }), tab(2, { offLimits: true })]) === null && chatPage.pickTargetTab([]) === null && chatPage.pickTargetTab(undefined) === null, 'pick');
  check('target tab: a tab never looked at falls back to when it was last left; the newer view wins ties', chatPage.pickTargetTab([tab(1, { lastActiveAt: 10 }), tab(2, { lastActiveAt: 20 })]) === 2 && chatPage.pickTargetTab([tab(1, { viewedAt: 50, lastActiveAt: 60 }), tab(2, { viewedAt: 50, lastActiveAt: 10 })]) === 1, 'pick');

  // The run both views share.
  const tracker = chatPage.createRunTracker();
  check('run tracker: idle until a run starts', !tracker.running() && tracker.get() === null, 'idle');
  tracker.start({ runId: 7, text: 'hi', fromChat: true, target: 4 });
  tracker.setTarget(9);
  check('run tracker: remembers the run, who started it and its tab', tracker.running() && tracker.get().runId === 7 && tracker.get().fromChat === true && tracker.get().target === 9, JSON.stringify(tracker.get()));
  tracker.end();
  tracker.setTarget(3);
  check('run tracker: ends cleanly and ignores a late retarget', !tracker.running() && tracker.get() === null, JSON.stringify(tracker.get()));

  // The runtime: who hears what, and pinning, with stand-in tabs.
  const wcs = () => { const wc = new EventEmitter(); wc.sent = []; wc.send = (...a) => wc.sent.push(a); wc.isDestroyed = () => false; wc.mainFrame = { url: CHAT }; return wc; };
  const uiWc = wcs();
  const chatWc = wcs();
  let tabsList = [
    { id: 1, view: { webContents: wcs() }, viewedAt: 100, lastActiveAt: 50 },
    { id: 2, view: { webContents: wcs() }, viewedAt: 300, lastActiveAt: 90 },
  ];
  const opened = [];
  const ipc = { on() {}, handle() {} };
  const rt = chatPage.create({
    ipcMain: ipc, tabs: () => tabsList, alive: () => true, ui: () => uiWc,
    openTab: (url, opts) => { const t = { id: 50 + opened.length, view: { webContents: wcs() }, viewedAt: 0 }; opened.push({ url, opts }); tabsList = [...tabsList, t]; return t; },
    switchTab() {}, requestCloseTab() {}, managersOpen: () => 0, isPrivateSender: () => false, chatView: () => ({ items: [] }), agentOffLimits: () => false,
    tabInfo: (t) => ({ id: t.id, title: `tab ${t.id}`, url: '', favicon: null }),
  });
  check('chat runtime: with no chat page open nothing is broadcast (the sidebar behaves as before)', rt.surfaces().length === 0, String(rt.surfaces().length));
  const sidebarAsk = { sender: uiWc, senderFrame: { url: 'file:///x/index.html' } };
  check('chat runtime: a run from the sidebar is not pinned to a tab', rt.beginRun(sidebarAsk, { text: 'a', runId: 1, images: [] }) === false && rt.runTarget() === null, String(rt.runTarget()));
  rt.endRun();
  tabsList = [...tabsList, { id: 9, managerPage: 'chat', view: { webContents: chatWc }, viewedAt: 900 }];
  const pageAsk = { sender: chatWc, senderFrame: chatWc.mainFrame };
  check('chat runtime: the sidebar and every chat page are views of the one chat', rt.surfaces().length === 2 && rt.isChatSender(pageAsk) && !rt.isChatSender(sidebarAsk), String(rt.surfaces().length));
  check('chat runtime: a frame that is not the chat page\'s top frame (a subframe, another URL) is not trusted', !rt.isChatSender({ sender: chatWc, senderFrame: { url: CHAT } }) && !rt.isChatSender({ sender: chatWc, senderFrame: { url: 'https://x.test/' } }), 'trusted');
  check('chat runtime: the allowlist applies only to the chat page', rt.allows(pageAsk, 'agent:ask') && !rt.allows(pageAsk, 'settings:set-provider-key') && !rt.allows(sidebarAsk, 'agent:ask'), 'allows');
  const fromChat = rt.beginRun(pageAsk, { text: 'go', runId: 3, images: [{ media_type: 'image/png', data: 'AAA' }] });
  check('chat runtime: a run from the chat page works in the tab last looked at, never the chat tab', fromChat && rt.runTarget() === 2, String(rt.runTarget()));
  check('chat runtime: the sidebar hears a page run start (with its images), the page does not echo it', uiWc.sent.some(([c, p]) => c === 'chat:run-start' && p.runId === 3 && p.text === 'go' && p.images[0].data === 'AAA') && !chatWc.sent.some(([c]) => c === 'chat:run-start'), JSON.stringify(uiWc.sent));
  check('chat runtime: the page shows which tab it works in', chatWc.sent.some(([c, p]) => c === 'chat:target' && p.id === 2), JSON.stringify(chatWc.sent.map((s) => s[0])));
  rt.emit(chatWc, 'agent:event', { type: 'text', runId: 3 });
  check('chat runtime: a run\'s events reach both views', uiWc.sent.some(([c, p]) => c === 'agent:event' && p.type === 'text') && chatWc.sent.some(([c, p]) => c === 'agent:event' && p.type === 'text'), 'events');
  rt.retarget(1);
  check('chat runtime: switching tabs during a run re-pins it', rt.runTarget() === 1, String(rt.runTarget()));
  rt.endRun();
  check('chat runtime: after the run there is no pin', rt.runTarget() === null, String(rt.runTarget()));
  tabsList = tabsList.filter((t) => t.managerPage === 'chat');
  const alone = rt.beginRun(pageAsk, { text: 'again', runId: 4, images: [] });
  check('chat runtime: with no ordinary tab a run from the page opens one, out of sight', alone && opened.length === 1 && opened[0].opts.background === true && rt.runTarget() === 50, JSON.stringify(opened));
  rt.endRun();
  rt.broadcast('chat:sync', { view: { items: [] } }, chatWc);
  check('chat runtime: a chat switch reaches the other view, not the one that made it', uiWc.sent.some(([c]) => c === 'chat:sync') && !chatWc.sent.some(([c]) => c === 'chat:sync'), 'sync');
}


// ---- tab groups: incremental placement, proposals, undo (pure Node: tab-groups.js on plain arrays)
{
  const tg = require('../tab-groups');
  const { harness } = require('./topics-bench');
  const { sessions } = require('./topics-sessions');
  const recipes = ['Easy Banana Bread Recipe', 'Chocolate Chip Cookie Recipes', 'Classic Pancake Recipe'];
  const setup = (extra = []) => {
    const h = harness(tg, { withText: false });
    const tabs = recipes.map((title, i) => h.addTab({ title, url: `https://site${i}.example/${encodeURIComponent(title)}` }));
    for (const t of extra) tabs.push(h.addTab(t));
    return { h, tabs };
  };
  const gid = (t) => t.groupId || null;

  // A tab that loads later joins the group it fits, and stays loose when nothing fits.
  let { h, tabs } = setup();
  h.tg.organizeByTopic();
  const recipeGroup = gid(tabs[0]);
  check('groups: three recipe tabs form one group', recipeGroup && tabs.every((t) => gid(t) === recipeGroup), JSON.stringify(tabs.map(gid)));
  const cake = h.addTab({ title: 'Lemon Drizzle Cake Recipe', url: 'https://cakes.example/lemon-drizzle-cake-recipe' });
  const weather = h.addTab({ title: 'Weather forecast Boston', url: 'https://weather.example/boston' });
  h.tg.autoGroup();
  check('incremental: a new recipe tab joins the recipe group', gid(cake) === recipeGroup, String(gid(cake)));
  check('incremental: an unrelated tab stays loose', gid(weather) === null, String(gid(weather)));
  check('incremental: the placement is undoable, and the tab is then left alone', h.tg.canUndo() && h.tg.undoOrganize() && gid(cake) === null && (h.tg.autoGroup(), gid(cake) === null), String(gid(cake)));

  // Two related loose tabs form a group of their own; a third later joins it.
  const p1 = h.addTab({ title: 'Kyoto Temple Guide', url: 'https://travel.example/kyoto-temple-guide' });
  const p2 = h.addTab({ title: 'Best Kyoto Temples to Visit', url: 'https://other.example/best-kyoto-temples' });
  h.tg.autoGroup();
  check('incremental: two related loose tabs form a new group', gid(p1) && gid(p1) === gid(p2) && gid(p1) !== recipeGroup, `${gid(p1)} ${gid(p2)}`);
  const p3 = h.addTab({ title: 'Kyoto Temple Map', url: 'https://maps.example/kyoto-temple-map' });
  h.tg.autoGroup();
  check('incremental: a later tab joins that group', gid(p3) === gid(p1), `${gid(p3)} ${gid(p1)}`);

  // Manual placement, pins and the move cap are respected.
  ({ h, tabs } = setup());
  h.tg.organizeByTopic();
  const mine = h.addTab({ title: 'Lemon Tart Recipe', url: 'https://tarts.example/lemon-tart-recipe' });
  mine.userMoved = true;
  const placed = h.addTab({ title: 'Apple Pie Recipe', url: 'https://pies.example/apple-pie-recipe' });
  placed.userPlaced = true;
  const pin = h.addTab({ title: 'Sourdough Bread Recipe', url: 'https://bread.example/sourdough-bread-recipe' });
  pin.pinned = true;
  const capped = h.addTab({ title: 'Blueberry Muffin Recipe', url: 'https://muffins.example/blueberry-muffin-recipe' });
  capped.autoMoves = tg.MAX_AUTO_MOVES;
  h.tg.autoGroup();
  check('incremental: dragged, hand-placed, pinned and move-capped tabs are not grouped', [mine, placed, pin, capped].every((t) => gid(t) === null), JSON.stringify([mine, placed, pin, capped].map(gid)));

  // A grouped tab moves only for a clearly better group, once its title changes.
  ({ h, tabs } = setup([
    { title: 'Kyoto Temple Guide', url: 'https://travel.example/kyoto-temple-guide' },
    { title: 'Best Kyoto Temples to Visit', url: 'https://other.example/best-kyoto-temples' },
    { title: 'Kyoto Temple Map', url: 'https://maps.example/kyoto-temple-map' },
  ]));
  h.tg.organizeByTopic();
  const stray = h.addTab({ title: 'New Tab', url: 'https://travel.example/page' });
  h.tg.add(stray.id, gid(tabs[0]), { auto: true });
  stray.autoMoves = 1;
  h.tg.autoGroup();
  check('incremental: an untitled tab in a group stays where it is', gid(stray) === gid(tabs[0]), String(gid(stray)));
  stray.title = 'Kyoto Temple Opening Hours';
  h.tg.autoGroup();
  check('incremental: once titled, it moves to the group it fits', gid(stray) === gid(tabs[3]) && gid(stray) !== gid(tabs[0]), `${gid(stray)} ${gid(tabs[3])} ${gid(tabs[0])}`);
  stray.title = 'Kyoto Temple Tickets';
  h.tg.autoGroup();
  stray.title = 'Chocolate Chip Cookie Recipes Again';
  h.tg.autoGroup();
  check('incremental: moves per tab are capped', stray.autoMoves <= tg.MAX_AUTO_MOVES, String(stray.autoMoves));

  // placeTabs directly: unknown domains work from words alone.
  const e = (id, title, url) => ({ id, title, url, text: '', hint: '' });
  const zod = [e(1, 'Zod schema validation basics', 'https://zod.dev/basics'), e(2, 'Zod optional vs nullable', 'https://stackoverflow.com/q/1/zod-optional-nullable')];
  const bread = [e(3, 'Sourdough starter tips', 'https://bread.example/starter'), e(4, 'Sourdough bread recipe', 'https://bread.example/recipe')];
  const res = tg.placeTabs([{ entry: e(9, 'Zod refine and transform', 'https://newsite.example/zod-refine'), current: null }, { entry: e(10, 'Best hiking boots', 'https://boots.example/best'), current: null }], [{ id: 1, domain: null, members: zod }, { id: 2, domain: null, members: bread }]);
  check('placeTabs: a never-seen domain is placed by its words; an unrelated tab is not', res[0] === 1 && res[1] === null, JSON.stringify(res));

  // Proposals from a model are validated.
  const okIds = new Set([1, 2, 3, 4, 5, 6]);
  check('proposal: unknown and duplicate ids and singleton groups are dropped', JSON.stringify(tg.sanitizeProposal([{ name: 'A', tab_ids: [1, 2, 99, 2] }, { name: 'B', tab_ids: [2, 3] }, { name: 'Solo', tab_ids: [4] }, { name: 'C', tab_ids: [3, 4] }], okIds)) === JSON.stringify([{ name: 'A', ids: [1, 2] }, { name: 'C', ids: [3, 4] }]));
  check('proposal: garbage or one group holding nearly every tab is refused', tg.sanitizeProposal('nope', okIds) === null && tg.sanitizeProposal([{ name: 'All', tab_ids: [1, 2, 3, 4, 5, 6] }], okIds) === null && tg.sanitizeProposal([{ name: '', tab_ids: [1, 2] }], okIds) === null);
  const cut = tg.sanitizeProposal([{ name: '<b>Reading List Stuff Extra</b>', tab_ids: [1, 2] }], okIds);
  check('proposal: names are cut to 3 words and stripped of markup', cut?.[0].name === 'Reading List Stuff', JSON.stringify(cut));
  const many = Array.from({ length: 20 }, (_v, i) => ({ name: `G${i}`, tab_ids: [i * 2 + 1, i * 2 + 2] }));
  check('proposal: at most 8 groups', tg.sanitizeProposal(many, new Set(Array.from({ length: 40 }, (_v, i) => i + 1))).length === 8);
  const words = tg.pathWords('https://x.example/docs/react/hooks/use-state/3f9a8b7c1d2e4f5a6b7c?token=SECRET#frag');
  check('pathWords: path words only, no query, fragment, ids or tokens', words === 'react hooks state', words);

  // Organize with a proposal: merges into a same-named group, keeps pins out, and undoes.
  ({ h, tabs } = setup([{ title: 'Kyoto Temple Guide', url: 'https://travel.example/kyoto-temple-guide' }, { title: 'Best Kyoto Temples', url: 'https://other.example/best-kyoto-temples' }]));
  const pinnedTab = h.addTab({ title: 'Inbox', url: 'https://mail.example/inbox' });
  pinnedTab.pinned = true;
  const snap = () => h.tabs().map((t) => [t.id, t.groupId || null].join(':')).join();
  const before = snap();
  const n = h.tg.applyProposal([{ name: 'Baking', tab_ids: [tabs[0].id, tabs[1].id, pinnedTab.id] }, { name: 'baking', tab_ids: [tabs[2].id, tabs[3].id] }]);
  const names = h.tg.state().map((x) => x.name);
  check('AI organize: a group named like an existing one is merged, not duplicated; pinned tabs stay out', n === 2 && names.length === 1 && gid(pinnedTab) === null, JSON.stringify(names));
  check('AI organize: undo restores every tab', h.tg.undoOrganize() && snap() === before && h.tg.state().length === 0);
  h.tg.applyProposal(null);
  check('AI organize: no proposal falls back to the local topics', h.tg.state().length >= 1 && gid(pinnedTab) === null);
  check('undo works after the fallback too, and only once', h.tg.undoOrganize() && !h.tg.canUndo() && !h.tg.undoOrganize());

  // Organizing again keeps a group's colour and name.
  ({ h, tabs } = setup());
  h.tg.organizeByTopic();
  const first = h.tg.state()[0];
  h.tg.organizeByTopic();
  const second = h.tg.state()[0];
  check('organize again: same tabs keep the group name and colour', first.name === second.name && first.color === second.color, JSON.stringify([first, second]));

  // Two groups with one name become "X" and "X (2)".
  const dup = harness(tg, { withText: false });
  const dtabs = ['a', 'b', 'c', 'd'].map((k) => dup.addTab({ title: `Doc ${k}`, url: `https://${k}.example/${k}` }));
  dup.tg.create('Docs', [dtabs[0].id, dtabs[1].id]);
  dup.tg.applyProposal([{ name: 'Docs', tab_ids: [dtabs[2].id, dtabs[3].id] }]);
  check('groups: a proposal group named like an existing one joins it', dup.tg.state().filter((x) => x.name === 'Docs').length === 1);

  // Mixed sessions: the local organizer names project, doc and video groups sensibly.
  const hs = harness(tg, { withText: false });
  sessions[0].tabs.forEach((t) => hs.addTab(t));
  hs.tg.groupLoose();
  const gnames = hs.tg.state().map((x) => x.name);
  check('sessions: a repo\'s tabs are named for the repo, its docs for the library', gnames.includes('Lumen') && gnames.includes('Next.js'), JSON.stringify(gnames));
}

// ---- tab groups: merging groups with similar names
{
  const tg = require('../tab-groups');
  const { harness } = require('./topics-bench');
  const sim = tg.nameSimilarity;
  check('merge names: case, punctuation, plural and (2) are the same name', sim('React Docs', 'react docs') === 'exact' && sim('Recipes', 'Recipe') === 'exact' && sim('Docs (2)', 'Docs') === 'exact' && sim('Tokyo-Trip!', 'tokyo trip') === 'exact');
  check('merge names: one name inside the other as whole words', sim('Flights', 'Flights to Tokyo') === 'contain' && sim('Kyoto', 'Kyoto Travel Tabs') === 'contain');
  check('merge names: a typo apart', sim('Kubernetes', 'Kubernets') === 'close', String(sim('Kubernetes', 'Kubernets')));
  check('merge names: Java / JavaScript and unrelated names are not similar; a kind word (PRs) only makes names weakly similar', sim('Java', 'JavaScript') === null && sim('Lumen', 'Lumen PRs') === 'weak' && sim('Piano', 'Grand Prix') === null);

  const setup = () => {
    const h = harness(tg, { withText: false });
    const mk = (title, url) => h.addTab({ title, url });
    return { h, mk };
  };
  const gid = (t) => t.groupId || null;
  const names = (h) => h.tg.state().map((g) => g.name);

  // Same name twice, topic overlap: merged into the older group's id, more specific name.
  let { h, mk } = setup();
  const a = [mk('Flights to Tokyo', 'https://kayak.example/flights-tokyo'), mk('Tokyo flight deals', 'https://skyscanner.example/tokyo-flights')];
  const b = [mk('Tokyo hotels', 'https://booking.example/tokyo-hotels'), mk('Tokyo flights cheap', 'https://nerd.example/tokyo-flights')];
  const ga = h.tg.create('Flights', a.map((t) => t.id), { auto: true, color: 'blue' });
  const gb = h.tg.create('Flights to Tokyo', b.map((t) => t.id), { auto: true, color: 'red' });
  check('merge: "Flights" and "Flights to Tokyo" become one group (older id and colour, longer name)', h.tg.mergeGroups() === 1 && h.tg.state().length === 1 && names(h)[0] === 'Flights to Tokyo' && [...a, ...b].every((t) => gid(t) === ga.id) && h.tg.state()[0].color === 'blue' && !h.tg.groups.has(gb.id), JSON.stringify(h.tg.state()));
  check('merge: one undo reverts the whole pass', h.tg.undoOrganize() && h.tg.state().length === 2 && a.every((t) => gid(t) === ga.id) && b.every((t) => gid(t) === gb.id) && names(h).join() === 'Flights,Flights to Tokyo' && h.tg.state()[1].color === 'red');
  check('merge: nothing to merge records no undo', (h.tg.mergeGroups(), h.tg.undoOrganize()) && h.tg.mergeGroups() === 1 && h.tg.undoOrganize() && !h.tg.canUndo());

  // Not merged: distinct topics, "Java"/"JavaScript", kind qualifiers, unrelated tabs sharing one word.
  ({ h, mk } = setup());
  const j1 = [mk('Java streams', 'https://a.example/java-streams'), mk('Java records', 'https://b.example/java-records')];
  const j2 = [mk('JavaScript promises', 'https://c.example/promises'), mk('JavaScript closures', 'https://d.example/closures')];
  h.tg.create('Java', j1.map((t) => t.id), { auto: true });
  h.tg.create('JavaScript', j2.map((t) => t.id), { auto: true });
  check('merge: Java and JavaScript stay apart', h.tg.mergeGroups() === 0 && h.tg.state().length === 2);
  ({ h, mk } = setup());
  const c1 = [mk('Pull requests lumen', 'https://github.com/o/lumen/pulls'), mk('Fix flicker pull 46', 'https://github.com/o/lumen/pull/46')];
  const c2 = [mk('Sidebar issue', 'https://github.com/o/lumen/issues/41'), mk('Lumen readme', 'https://github.com/o/lumen')];
  h.tg.create('Lumen PRs', c1.map((t) => t.id), { auto: true });
  h.tg.create('Lumen', c2.map((t) => t.id), { auto: true });
  check('merge: "Lumen" and "Lumen PRs" stay apart on names alone', h.tg.mergeGroups() === 0);
  ({ h, mk } = setup());
  const w1 = [mk('Mitosis stages', 'https://a.example/mitosis'), mk('Cell division', 'https://b.example/cell-division')];
  const w2 = [mk('Hamlet essay', 'https://c.example/hamlet'), mk('Hamlet themes', 'https://d.example/themes')];
  h.tg.create('Study', w1.map((t) => t.id), { auto: true });
  h.tg.create('Study Guides', w2.map((t) => t.id), { auto: true });
  check('merge: weakly similar names with unrelated tabs stay apart', h.tg.mergeGroups() === 0);

  // User-named and user-made groups: only exact twins merge, and the user's name and colour win.
  ({ h, mk } = setup());
  const u1 = [mk('Kyoto guide', 'https://a.example/kyoto'), mk('Kyoto temples', 'https://b.example/temples')];
  const u2 = [mk('Kyoto map', 'https://c.example/map'), mk('Kyoto food', 'https://d.example/food')];
  const g1 = h.tg.create('Kyoto', u1.map((t) => t.id), { auto: true, color: 'green' });
  const g2 = h.tg.create('kyoto', u2.map((t) => t.id), { auto: true, color: 'pink' });
  g2.userNamed = true;
  g2.auto = false;
  check('merge: exact twins merge; the user-named group\'s name and colour survive, under the older id', h.tg.mergeGroups() === 1 && h.tg.state().length === 1 && names(h)[0] === 'kyoto' && h.tg.state()[0].color === 'pink' && h.tg.groups.has(g1.id) && h.tg.groups.get(g1.id).userNamed === true, JSON.stringify(h.tg.state()));
  ({ h, mk } = setup());
  const n1 = [mk('Kyoto guide', 'https://a.example/kyoto'), mk('Kyoto temples', 'https://b.example/temples')];
  const n2 = [mk('Kyoto map', 'https://c.example/map'), mk('Kyoto food', 'https://d.example/food')];
  h.tg.create('Kyoto', n1.map((t) => t.id), { auto: true });
  const mine = h.tg.create('Kyoto Trip', n2.map((t) => t.id)); // made by the user
  mine.userNamed = true;
  check('merge: a user-named group is not merged into a merely similar one', h.tg.mergeGroups() === 0 && h.tg.state().length === 2);

  // Pinned tabs never move; by-site groups are left alone.
  ({ h, mk } = setup());
  const p = [mk('Tokyo trip a', 'https://a.example/a'), mk('Tokyo trip b', 'https://b.example/b')];
  const q = [mk('Tokyo trip c', 'https://c.example/c'), mk('Tokyo trip d', 'https://d.example/d')];
  h.tg.create('Tokyo Trip', p.map((t) => t.id), { auto: true });
  h.tg.create('Tokyo Trip', q.map((t) => t.id), { auto: true });
  q[0].pinned = true;
  const gq = gid(q[0]);
  h.tg.mergeGroups();
  check('merge: a pinned tab is not moved into the merged group', gid(q[0]) === gq && gid(q[1]) === gid(p[0]));
  ({ h, mk } = setup());
  const s1 = [mk('a', 'https://one.example/a'), mk('b', 'https://one.example/b')];
  const s2 = [mk('c', 'https://two.example/c'), mk('d', 'https://two.example/d')];
  h.tg.create('Docs', s1.map((t) => t.id), { auto: true, domain: 'one.example' });
  h.tg.create('Docs', s2.map((t) => t.id), { auto: true, domain: 'two.example' });
  check('merge: by-site groups are left alone', h.tg.mergeGroups() === 0);

  // An organize action merges near-duplicate groups it just made (a model proposing "Recipes" and "Recipe").
  ({ h, mk } = setup());
  const r = ['Banana Bread Recipe', 'Cookie Recipes', 'Pancake Recipe', 'Muffin Recipe'].map((t, i) => mk(t, `https://r${i}.example/${i}`));
  const made = h.tg.applyProposal([{ name: 'Recipes', tab_ids: [r[0].id, r[1].id] }, { name: 'Recipe', tab_ids: [r[2].id, r[3].id] }]);
  check('organize: near-duplicate proposed groups merge, and undo reverts all of it', made === 1 && h.tg.state().length === 1 && r.every((t) => gid(t) === gid(r[0])) && h.tg.undoOrganize() && r.every((t) => gid(t) === null));

  // The continuous pass merges a group it just formed into a same-named one, and one undo puts it back.
  ({ h, mk } = setup());
  const k = [mk('Kyoto temple guide', 'https://a.example/kyoto-temple-guide'), mk('Best Kyoto temples', 'https://b.example/best-kyoto-temples')];
  h.tg.autoGroup();
  const first = gid(k[0]);
  const k2 = [mk('Kyoto temple hours', 'https://c.example/kyoto-temple-hours'), mk('Kyoto temple tickets', 'https://d.example/kyoto-temple-tickets')];
  h.tg.autoGroup();
  check('continuous: related tabs end up in one group, not two near-twins', first && k2.every((t) => gid(t) === first) && h.tg.state().length === 1, JSON.stringify(h.tg.state()));
}


// ---- the Windows swap helper's quit-apply mode (features/swap-helper.js)
async function swapHelperRuns() {
  const { swap } = require('../features/swap-helper');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-swaprun-unit-'));
  const mk = (rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
  const opts = (extra = {}) => ({ pid: 2 ** 22 + 1, dir: path.join(d, 'Lumen'), root: path.join(d, 'Lumen.update', 'files'), old: path.join(d, 'Lumen.old'), staging: path.join(d, 'Lumen.update'), exe: path.join(d, 'Lumen', 'Lumen.exe'), errFile: path.join(d, 'err.txt'), minBytes: 1, retryMs: 10, waitMs: 500, ...extra });
  const started = [];
  const start = (...a) => started.push(a);
  mk('Lumen/Lumen.exe', 'MZ old'); mk('Lumen.update/files/Lumen.exe', 'MZ new');
  const r1 = await swap(opts({ relaunch: false }), start);
  check('swap helper: quit-apply swaps the folders and starts nothing', r1 === 'swapped' && fs.readFileSync(path.join(d, 'Lumen', 'Lumen.exe'), 'utf8') === 'MZ new' && !fs.existsSync(path.join(d, 'Lumen.old')) && !fs.existsSync(path.join(d, 'Lumen.update')) && started.length === 0, `${r1} ${started.length}`);
  const r2 = await swap(opts({ relaunch: false }), start);
  check('swap helper: quit-apply with the staged folder already gone is a quiet no-op', r2 === 'noop' && !fs.existsSync(path.join(d, 'err.txt')) && started.length === 0, r2);
  mk('Lumen.update/files/Lumen.exe', 'MZ newer');
  const r3 = await swap(opts(), start);
  check('swap helper: the normal apply still starts the new exe', r3 === 'swapped' && started.length === 1 && started[0][0] === opts().exe, `${r3} ${started.length}`);
  mk('Lumen.update/files/Lumen.exe', 'tiny');
  const r4 = await swap(opts({ relaunch: false, minBytes: 1000 }), start);
  check('swap helper: quit-apply keeps the old version and writes the error file, without relaunching', r4 === 'kept' && fs.existsSync(path.join(d, 'err.txt')) && started.length === 1 && fs.readFileSync(path.join(d, 'Lumen', 'Lumen.exe'), 'utf8') === 'MZ newer', r4);
  fs.rmSync(d, { recursive: true, force: true });
}

// ---- screenshot and QR helpers (features/screenshot.js, features/qr.js)
{
  const shot = require('../features/screenshot');
  const qr = require('../features/qr');
  const when = new Date(2026, 8, 5, 7, 3, 9);
  check('screenshot: file name is Lumen <site> <timestamp>.png without www.', shot.fileNameFor('https://www.Example.com/a/b?x=1', when) === 'Lumen Example.com 2026-09-05 07.03.09.png'.replace('Example', 'example'), shot.fileNameFor('https://www.Example.com/a', when));
  check('screenshot: file name has no characters Windows refuses, and a fallback site', !/[/\\:*?"<>|]/.test(shot.fileNameFor('https://[::1]:8080/', when)) && /^Lumen page /.test(shot.fileNameFor('not a url', when)), shot.fileNameFor('https://[::1]:8080/', when));
  check('screenshot: an existing name gets (2), (3)', shot.uniquePath('/x', 'a.png', (f) => f === path.join('/x', 'a.png') || f === path.join('/x', 'a (2).png')) === path.join('/x', 'a (3).png'), '');
  const view = { width: 800, height: 600 };
  check('screenshot: a dragged rectangle is whole numbers inside the view', JSON.stringify(shot.normalizeRect({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, view)) === JSON.stringify({ x: 10, y: 21, width: 101, height: 50 }), JSON.stringify(shot.normalizeRect({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, view)));
  check('screenshot: a rectangle past the edge is clamped, a backwards drag is flipped', JSON.stringify(shot.normalizeRect({ x: 700, y: 500, width: 300, height: 300 }, view)) === JSON.stringify({ x: 700, y: 500, width: 100, height: 100 }) && JSON.stringify(shot.normalizeRect({ x: 200, y: 200, width: -50, height: -40 }, view)) === JSON.stringify({ x: 150, y: 160, width: 50, height: 40 }), '');
  check('screenshot: a stray click or NaN is not a selection', shot.normalizeRect({ x: 5, y: 5, width: 2, height: 200 }, view) === null && shot.normalizeRect({ x: NaN, y: 0, width: 10, height: 10 }, view) === null && shot.normalizeRect(null, view) === null, '');
  check('screenshot: DIP rectangles scale to image pixels and stay inside the image', JSON.stringify(shot.scaleRect({ x: 10, y: 20, width: 100, height: 50 }, 1.5, { width: 1200, height: 900 })) === JSON.stringify({ x: 15, y: 30, width: 150, height: 75 }) && JSON.stringify(shot.scaleRect({ x: 790, y: 590, width: 10, height: 10 }, 1.25, { width: 1000, height: 750 })) === JSON.stringify({ x: 988, y: 738, width: 12, height: 12 }), JSON.stringify(shot.scaleRect({ x: 790, y: 590, width: 10, height: 10 }, 1.25, { width: 1000, height: 750 })));
  check('screenshot: a full page under the cap is not cut', JSON.stringify(shot.capSize({ width: 1280, height: 5000.2 }, 1)) === JSON.stringify({ width: 1280, height: 5001, cut: false }), JSON.stringify(shot.capSize({ width: 1280, height: 5000.2 }, 1)));
  check('screenshot: a full page is cut at 16000 output pixels and says so', JSON.stringify(shot.capSize({ width: 1280, height: 30000 }, 2)) === JSON.stringify({ width: 1280, height: 8000, cut: true }) && shot.capSize({ width: 100, height: 16000 }, 1).cut === false, JSON.stringify(shot.capSize({ width: 1280, height: 30000 }, 2)));
  check('qr: only http(s) addresses, unaltered', qr.checkInput('https://a.example/x?y=1#z').text === 'https://a.example/x?y=1#z' && qr.checkInput('lumen://chat').error === 'scheme' && qr.checkInput('file:///C:/a').error === 'scheme' && qr.checkInput('javascript:alert(1)').error === 'scheme', '');
  const long = (n) => `https://a.example/${'x'.repeat(n - 18)}`;
  check('qr: 800 characters is fine, 801 warns, 2000 warns, 2001 is refused', qr.checkInput(long(800)).warn === null && qr.checkInput(long(801)).warn === 'long' && qr.checkInput(long(2000)).ok === true && qr.checkInput(long(2001)).error === 'too-long', '');
  check('qr: selected text is trimmed, 1 to 500 characters', qr.checkInput('  hi  ', 'text').text === 'hi' && qr.checkInput('   ', 'text').error === 'empty' && qr.checkInput('x'.repeat(500), 'text').ok && qr.checkInput('x'.repeat(501), 'text').error === 'too-long', '');
  const m = qr.makeMatrix('https://example.com/');
  check('qr: a short address makes a 25x25 (version 2) grid with the finder squares', m.size === 25 && m.rows.length === 25 && m.rows[0].startsWith('1111111') && m.rows[24].startsWith('1111111') && m.rows[0].endsWith('1111111'), `${m.size} ${m.rows[0]}`);
  check('qr: a 2000 character address still fits', qr.makeMatrix(long(2000)).size > 100, '');
  check('qr: text with non-Latin characters encodes', qr.makeMatrix('QR \u65e5\u672c\u8a9e \u2603').size >= 21, '');
  const bmp = qr.renderBitmap(m, 4, 4);
  check('qr: the bitmap is black on white with a quiet zone', bmp.width === (25 + 8) * 4 && bmp.buffer.length === bmp.width * bmp.height * 4 && bmp.buffer[0] === 255 && bmp.buffer[((4 * 4) * bmp.width + 4 * 4) * 4] === 0 && bmp.buffer[3] === 255, '');
  check('qr: saved file name names the site', qr.fileNameFor('https://www.example.com/a', when) === 'Lumen QR example.com 2026-09-05 07.03.09.png' && /^Lumen QR text /.test(qr.fileNameFor('hello', when)), qr.fileNameFor('https://www.example.com/a', when));
}

// ---- page translation: pure logic (features/translate.js)
(() => {
  const tr = require('../features/translate');
  const el = (tag, extra = {}, parent = null) => ({
    tagName: tag, parentElement: parent, isContentEditable: false, classList: { contains: (c) => (extra.classes || []).includes(c) },
    getAttribute: (n) => (extra.attrs || {})[n] ?? null, hasAttribute: (n) => n in (extra.attrs || {}),
  });
  const body = el('BODY');
  const skipped = (node) => tr.excludedElement(node);
  check('translate: plain text elements are translated', !skipped(el('P', {}, body)) && !skipped(el('A', {}, el('LI', {}, body))), '');
  check('translate: script, style, code, pre and form fields are skipped', ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'SELECT'].every((tag) => skipped(el(tag, {}, body))), '');
  check('translate: text inside code or pre is skipped at any depth', skipped(el('SPAN', {}, el('CODE', {}, el('P', {}, body)))) && skipped(el('B', {}, el('PRE', {}, body))), '');
  check('translate: translate="no" and class notranslate are skipped, with their descendants', skipped(el('P', { attrs: { translate: 'no' } }, body)) && skipped(el('SPAN', {}, el('DIV', { classes: ['notranslate'] }, body))) && !skipped(el('P', { attrs: { translate: 'yes' } }, body)), '');
  check('translate: editable areas and hidden elements are skipped', skipped(el('DIV', { attrs: { contenteditable: '' } }, body)) && skipped(el('DIV', { attrs: { contenteditable: 'true' } }, body)) && !skipped(el('DIV', { attrs: { contenteditable: 'false' } }, body)) && skipped(Object.assign(el('DIV', {}, body), { isContentEditable: true })) && skipped(el('DIV', { attrs: { hidden: '' } }, body)), '');
  check('translate: only text with a letter is sent', tr.translatableText('Hola mundo', el('P', {}, body)) && tr.translatableText('  ñandú ', el('P', {}, body)) && !tr.translatableText(' 12 . 34 ', el('P', {}, body)) && !tr.translatableText('   ', el('P', {}, body)) && !tr.translatableText('Hola', el('CODE', {}, body)), '');

  const items = Array.from({ length: 40 }, (_v, i) => ({ id: i + 1, text: `frase número ${i + 1} `.repeat(6).trim() }));
  const chunks = tr.chunkItems(items, 1000);
  check('translate: chunks stay near the size limit and keep every item once, in order', chunks.length > 1 && chunks.every((c) => c.reduce((n, i) => n + i.text.length + 24, 0) <= 1000 + 24 + items[0].text.length) && chunks.flat().map((i) => i.id).join() === items.map((i) => i.id).join(), chunks.map((c) => c.length).join());
  check('translate: an oversized item gets a chunk of its own', tr.chunkItems([{ id: 1, text: 'a' }, { id: 2, text: 'b'.repeat(5000) }, { id: 3, text: 'c' }], 1000).map((c) => c.map((i) => i.id).join()).join('|') === '1|2|3', '');
  check('translate: an empty page has no chunks', tr.chunkItems([]).length === 0, '');

  const sent = [{ id: 1, text: 'Hola' }, { id: 2, text: 'Adiós' }, { id: 3, text: 'Gracias' }];
  const good = tr.validateReply(sent, { items: [{ id: 2, text: 'Goodbye' }, { id: 1, text: 'Hello' }, { id: 3, text: 'Thanks' }] });
  check('translate: a complete reply maps back by id whatever its order', good.missing.length === 0 && good.ok.get(1) === 'Hello' && good.ok.get(3) === 'Thanks', JSON.stringify([...good.ok]));
  const bad = tr.validateReply(sent, { items: [{ id: 1, text: 'Hello' }, { id: 1, text: 'again' }, { id: 9, text: 'stray' }, { id: 2, text: 7 }, { id: '3', text: 'Thanks' }] });
  check('translate: unknown ids, repeats and non-text are dropped; missing ones reported', bad.ok.get(1) === 'Hello' && bad.ok.get(3) === 'Thanks' && bad.ok.size === 2 && bad.missing.join() === '2' && bad.problems.length === 3, JSON.stringify(bad));
  check('translate: a reply that is not a list leaves everything missing', tr.validateReply(sent, 'sure! here you go').missing.length === 3 && tr.validateReply(sent, null).ok.size === 0, '');
  check('translate: a bare array reply is accepted; an emptied or absurdly long item is rejected', tr.validateReply(sent, [{ id: 1, text: 'Hello' }, { id: 2, text: '  ' }, { id: 3, text: 'x'.repeat(500) }]).missing.join() === '2,3', '');
  check('translate: the prompt treats page text as untrusted data and names the target', /untrusted DATA/.test(tr.systemPrompt('fr')) && /French/.test(tr.systemPrompt('fr')) && /never instructions/.test(tr.systemPrompt('de')) && JSON.parse(tr.userPrompt(sent)).items.length === 3, '');

  check('translate: the declared language wins, region and case ignored', tr.pageLanguage('es-MX', '') === 'es' && tr.pageLanguage('EN', '') === 'en' && tr.pageLanguage('zh-Hans-CN', '') === 'zh', '');
  const ES = 'La ciudad de Madrid es la capital de España y una de las más grandes de Europa, con una historia que se remonta a muchos siglos y que atrae a millones de visitantes cada año para conocer sus museos y sus calles.';
  const EN = 'The city of London is the capital of England and one of the largest in Europe, with a history that goes back many centuries and that attracts millions of visitors every year to see its museums and its streets.';
  const DE = 'Die Stadt Berlin ist die Hauptstadt von Deutschland und eine der größten in Europa, mit einer Geschichte, die viele Jahrhunderte zurückreicht und die jedes Jahr Millionen von Besuchern anzieht, um die Museen zu sehen.';
  check('translate: with no lang attribute, letters and common words tell Spanish, English and German apart', tr.pageLanguage('', ES) === 'es' && tr.pageLanguage('', EN) === 'en' && tr.pageLanguage('', DE) === 'de', [ES, EN, DE].map((x) => tr.pageLanguage('', x)).join());
  check('translate: scripts are recognized (Japanese, Russian, Korean, Arabic)', tr.guessLanguage('これは日本語の文章です。'.repeat(8)) === 'ja' && tr.guessLanguage('Это русский текст для проверки определения языка страницы.'.repeat(2)) === 'ru' && tr.guessLanguage('이것은 한국어 문장입니다 언어를 감지하는 테스트입니다.'.repeat(2)) === 'ko' && tr.guessLanguage('هذا نص عربي لاختبار اكتشاف لغة الصفحة في المتصفح.'.repeat(2)) === 'ar', '');
  check('translate: too little text, or numbers only, gives no guess', tr.guessLanguage('Hola') === '' && tr.guessLanguage('1234 5678 '.repeat(20)) === '', '');
  check('translate: differing languages are compared by base language only', tr.languagesDiffer('es', 'en') && !tr.languagesDiffer('en-GB', 'en-US') && !tr.languagesDiffer('zh', 'zh-CN') && !tr.languagesDiffer('', 'en') && !tr.languagesDiffer('x-default', 'en'), '');
  const offer = (extra) => tr.shouldOffer({ url: 'https://example.es/a', pageLang: 'es', target: 'en', ...extra });
  check('translate: offered for a foreign page, never for the same language', offer({}) && !offer({ pageLang: 'en' }), '');
  check('translate: not offered when off, on a never-site (www ignored), in private, or on non-web pages', !offer({ offerOn: false }) && !offer({ never: ['example.es'] }) && !offer({ url: 'https://www.example.es/x', never: ['example.es'] }) && !offer({ isPrivate: true }) && !offer({ url: 'lumen://settings' }) && !offer({ url: 'file:///c:/a.html' }), '');
  check('translate: the target follows the setting, else the UI language, else English', tr.targetFor('', 'fr-CA') === 'fr' && tr.targetFor('de', 'fr') === 'de' && tr.targetFor('', 'zh_TW') === 'zh-TW' && tr.targetFor('', 'zh-CN') === 'zh-CN' && tr.targetFor('', 'xx') === 'en' && tr.targetFor('bogus', 'es') === 'es', '');

  const web = 'https://example.es/a';
  check('translate: the first send to a provider needs consent, then is remembered', JSON.stringify(tr.consentDecision({ url: web, consented: [], provider: 'openai' })) === '{"allow":true,"needsConsent":true,"remember":true}' && tr.consentDecision({ url: web, consented: ['openai'], provider: 'openai' }).needsConsent === false && tr.consentDecision({ url: web, consented: ['openai'], provider: 'groq' }).needsConsent === true, '');
  check('translate: nothing goes out from lumen://, file://, about: pages or with no provider', ['lumen://settings', 'file:///c:/a.html', 'about:blank', 'chrome://x', ''].every((url) => !tr.consentDecision({ url, consented: ['openai'], provider: 'openai' }).allow) && tr.consentDecision({ url: web, provider: '' }).reason === 'no-engine', '');
  check('translate: private windows refuse unless clicked, and then ask every time without remembering', tr.consentDecision({ url: web, isPrivate: true, explicit: false, consented: ['openai'], provider: 'openai' }).reason === 'private' && JSON.stringify(tr.consentDecision({ url: web, isPrivate: true, explicit: true, consented: ['openai'], provider: 'openai' })) === '{"allow":true,"needsConsent":true,"remember":false}', '');
  check('translate: settings values are cleaned', tr.cleanHosts(['WWW.Example.com', 'bad host', 'a.b', 'a.b']).join() === 'example.com,a.b' && tr.cleanHosts('x') === null && tr.cleanConsent(['openai', 'x y', 'google', 'openai']).join() === 'openai,google', '');
  const { DEFAULTS } = require('../settings-backend');
  check('translate: settings defaults: offer on, no consent, no sites, Lumen\'s language', DEFAULTS.translateOffer === true && DEFAULTS.translateConsent.length === 0 && DEFAULTS.translateNever.length === 0 && DEFAULTS.translateTarget === '', '');
})();
// ---- tab drag geometry (features/tab-drag-math.js)
{
  const { clampToDisplay, windowBoundsFor, stripHit } = require('../features/tab-drag-math');
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const strip = { key: 'w', bounds: { x: 100, y: 100, width: 800, height: 600 }, bottom: 40, tabs: [{ id: 1, mid: 100 }, { id: 2, mid: 300 }, { id: 3, mid: 500 }] };
  check('drag: the grabbed spot lands under the cursor', JSON.stringify(windowBoundsFor({ x: 500, y: 300 }, { x: 60, y: 14 }, { width: 900, height: 700 })) === JSON.stringify({ x: 440, y: 286, width: 900, height: 700 }));
  const clamped = clampToDisplay({ x: -2000, y: -50, width: 900, height: 700 }, area);
  check('drag: a window dragged off the left keeps 160px on the display and its top edge on it', clamped.x === -740 && clamped.y === 0 && clamped.width === 900, JSON.stringify(clamped));
  const low = clampToDisplay({ x: 5000, y: 5000, width: 900, height: 700 }, area);
  check('drag: dragged past the right and bottom edges it keeps a grabbable strip', low.x === 1760 && low.y === 1000, JSON.stringify(low));
  check('drag: a window inside the display is not moved', JSON.stringify(clampToDisplay({ x: 10, y: 20, width: 900, height: 700 }, area)) === JSON.stringify({ x: 10, y: 20, width: 900, height: 700 }));
  const at = (x, y) => stripHit({ x, y }, [strip]);
  check('drag: left of the first tab midpoint inserts before it', at(150, 120)?.beforeId === 1, JSON.stringify(at(150, 120)));
  check('drag: between two tabs inserts before the second', at(100 + 350, 120)?.beforeId === 3 && at(100 + 250, 120)?.beforeId === 2, JSON.stringify(at(450, 120)));
  check('drag: past the last tab midpoint appends (beforeId null)', at(100 + 700, 120)?.beforeId === null, JSON.stringify(at(800, 120)));
  check('drag: below the strip (page area) is not a hit', at(300, 100 + 40 + 20) === null && at(300, 100 + 40 + 6)?.key === 'w');
  check('drag: outside the window is not a hit', at(50, 120) === null && at(900, 120) === null && at(300, 90) === null);
  const other = { ...strip, key: 'v', bounds: { x: 1000, y: 100, width: 800, height: 600 } };
  check('drag: the first strip under the cursor wins', stripHit({ x: 1100, y: 120 }, [strip, other])?.key === 'v');
  check('drag: no strips, no hit', stripHit({ x: 1, y: 1 }, []) === null);
}

schedulerRuns().catch((err) => check('tool scheduler', false, err.stack)).then(fuseChecks).catch((err) => check('fuses: after-pack hook', false, err.stack)).then(pdfRuns).catch((err) => check('read_pdf text and permission', false, err.stack)).then(safeBrowsingRuns).catch((err) => check('Safe Browsing against a fake Google', false, err.stack)).then(speedRuns).catch((err) => check('sidebar speed checks', false, err.stack)).then(usageShareRuns).catch((err) => check('usage share checks', false, err.stack)).then(grokRuns).catch((err) => check('Grok Build runs against a fake grok', false, err.stack)).then(swapHelperRuns).catch((err) => check('swap helper quit-apply', false, err.stack)).then(chatPageRuns).catch((err) => check('lumen://chat', false, err.stack)).then(() => {
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
});
