// Plain Node checks (no Electron window): address bar URL-or-search detection, the crash-safe
// settings file, Safari import, the Grok Build engine's argv/env/home, and both CLI engines' model
// choice (--model in the argv, `grok models` parsing, the picker entries).
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
]) check(`"${input}" opens ${want}`, resolveInput(input, 'google') === want, resolveInput(input, 'google'));
for (const input of ['node.js', 'next.js', 'notes.txt', 'a.b', 'hello', 'next.js docs', 'user@example.com', 'javascript:alert(1);a.com', 'JavaScript:void(0)']) {
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
  check('Grok Build allows only Lumen MCP tools and search_tool, not use_tool itself', JSON.stringify(allows) === JSON.stringify(['lumen__*', 'search_tool']) && !argv.includes('use_tool'), JSON.stringify(allows));
  check('Grok Build denies the terminal and runs under dontAsk', argv.includes('run_terminal_command') && argv[argv.indexOf('--permission-mode') + 1] === 'dontAsk', argv.join(' '));

  const env = gb.buildEnv({ userData: gbData, base: { PATH: 'x', GROK_HOME: '/users/real/.grok', GROK_CLAUDE_MCPS_ENABLED: '1', GROK_CONFIG: '{}', ELECTRON_RUN_AS_NODE: '1' } });
  check('Grok Build GROK_HOME is Lumen\'s own folder under userData, not the user\'s', env.GROK_HOME === path.join(gbData, 'grok-home') && env.GROK_HOME === gb.grokHomeFor(gbData), env.GROK_HOME);
  check('Grok Build turns off its Claude/Cursor imports in the env (beats config.toml)', env.GROK_CLAUDE_MCPS_ENABLED === '0' && env.GROK_CURSOR_MCPS_ENABLED === '0' && env.GROK_CLAUDE_HOOKS_ENABLED === '0', JSON.stringify(env));
  check('Grok Build env drops config overlays and ELECTRON_RUN_AS_NODE', !('GROK_CONFIG' in env) && !('ELECTRON_RUN_AS_NODE' in env) && env.PATH === 'x', JSON.stringify(env));

  const toml = gb.grokConfig({ command: 'C:\\Lumen\\Lumen.exe', args: ['C:\\Lumen\\mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1', LUMEN_ENGINE: 'tag123' } });
  const servers = [...toml.matchAll(/^\[mcp_servers\.([^\].]+)\]$/gm)].map((m) => m[1]);
  check('Grok Build config.toml has only the lumen MCP server', JSON.stringify(servers) === '["lumen"]', JSON.stringify(servers));
  check('Grok Build config.toml carries the run tag and escapes Windows paths', toml.includes('"LUMEN_ENGINE" = "tag123"') && toml.includes('command = "C:\\\\Lumen\\\\Lumen.exe"'), toml);
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
  check('picker: every Grok Build entry is labelled unsafe and experimental', gbOpts.every((o) => /\(unsafe, experimental\)$/.test(o.label) && /unsafe, experimental/.test(o.detail) && o.group === 'Your Grok account') && gbOpts[0].label === 'Grok Build (unsafe, experimental)' && gbOpts[3].label === 'Grok Build · grok-4.6 (unsafe, experimental)', JSON.stringify(gbOpts.map((o) => o.label)));
  const kept = grokBuildOptions({ signedIn: 'unknown', models: [], saved: 'grokbuild:grok-4.6' });
  check('picker: a saved Grok Build model stays offered when grok models gave no list', JSON.stringify(kept.map((o) => o.id)) === '["grokbuild:default","grokbuild:grok-4.6"]', JSON.stringify(kept.map((o) => o.id)));
  check('picker: only the default when nothing is listed or saved (old settings keep working)', JSON.stringify(grokBuildOptions({ saved: 'grokbuild:default' }).map((o) => o.id)) === '["grokbuild:default"]' && grokBuildOptions({ saved: 'grokbuild:--x' }).length === 1 && grokBuildOptions({ saved: 'claude-opus-5' }).length === 1, 'options');
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
