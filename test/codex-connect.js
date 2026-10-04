// Settings → AI → "Add to Codex CLI", in the real app against a stand-in `codex` (a .cmd on Windows, a script elsewhere; it is not
// npm's shim, so on Windows it also exercises the cmd.exe route) and a throwaway CODEX_HOME: nothing of the real ~/.codex or
// the installed Codex is touched, and no model call exists to make. Offline.
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('./settings-tab');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = path.join(__dirname, '..');
  // Quitting can take a while on a busy machine; past 40 s the process is ended (the checks are done by then).
  const closeApp = (a) => Promise.race([a.close(), sleep(40000).then(() => { try { a.process().kill(); } catch {} })]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-codex-e2e-'));
  const profile = path.join(dir, 'profile');
  const codexHome = path.join(dir, 'codex-home');
  const logFile = path.join(dir, 'calls.log');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '# the user\'s own settings\nmodel = "gpt-5-codex"\n\n[tui]\nnotifications = true\n');

  // The stand-in: logs every call, answers --version and `login status`, says no to `mcp get`, and `mcp add` writes the entry like Codex does.
  const win = process.platform === 'win32';
  const stub = path.join(dir, win ? 'codex.cmd' : 'codex');
  const adder = path.join(dir, 'add.js');
  fs.writeFileSync(adder, `const fs=require('fs');const a=process.argv.slice(2);const i=a.indexOf('--');const c=a.slice(i+1);fs.appendFileSync(${JSON.stringify(path.join(codexHome, 'config.toml'))},'\\n[mcp_servers.lumen]\\ncommand = '+JSON.stringify(c[0])+'\\nargs = ['+c.slice(1).map((x)=>JSON.stringify(x)).join(', ')+']\\n');console.log('Added global MCP server lumen.');`);
  fs.writeFileSync(stub, win
    ? `@echo off\r\necho %* >> "${logFile}"\r\nif "%1"=="--version" (echo codex-cli 9.9.9 & exit /b 0)\r\nif "%1"=="login" (echo Logged in using ChatGPT & exit /b 0)\r\nif "%1"=="mcp" if "%2"=="get" (echo No MCP server named lumen 1>&2 & exit /b 1)\r\nif "%1"=="mcp" if "%2"=="add" (set ELECTRON_RUN_AS_NODE=1& "${process.execPath}" "${adder}" %*& exit /b 0)\r\nexit /b 0\r\n`
    : `#!/bin/sh\necho "$@" >> "${logFile}"\ncase "$1" in\n  --version) echo "codex-cli 9.9.9"; exit 0;;\n  login) echo "Logged in using ChatGPT"; exit 0;;\n  mcp) if [ "$2" = get ]; then echo "No MCP server named lumen" >&2; exit 1; fi\n       if [ "$2" = add ]; then ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${adder}" "$@"; exit $?; fi;;\nesac\nexit 0\n`, { mode: 0o755 });

  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, CODEX_HOME: codexHome, LUMEN_CODEX_BIN: stub, ELECTRON_RUN_AS_NODE: undefined };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const inSettings = await openSettingsTab(app);

  const read = (id) => inSettings(`(() => { const s = document.querySelector('[data-snippet="${id}"]'); return s && { text: s.textContent, button: [...s.querySelectorAll('button')].map((b) => b.textContent + (b.disabled ? '(disabled)' : '')) }; })()`);
  let row = null;
  for (let i = 0; i < 60 && !(row && /Codex 9\.9\.9/.test(row.text)); i++) { await sleep(250); row = await read('codex'); }
  check('the Codex row shows what was found: version, signed in with ChatGPT, not connected yet', row && /Codex 9\.9\.9 · signed in with ChatGPT · not connected to Lumen yet/.test(row.text), row && row.text);
  check('the row offers Add and "Locate codex…"', row && row.button.includes('Add to Codex CLI') && row.button.includes('Locate codex…'), JSON.stringify(row && row.button));

  await inSettings("[...document.querySelectorAll('[data-snippet=\"codex\"] button')].find((b) => b.textContent === 'Add to Codex CLI').click()");
  for (let i = 0; i < 60 && !(row && /Added/.test(row.text)); i++) { await sleep(250); row = await read('codex'); }
  const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  check('the click ran `codex mcp add lumen --env ELECTRON_RUN_AS_NODE=1 -- <Lumen> <mcp.js>` (paths with spaces intact)', /mcp add lumen --env ELECTRON_RUN_AS_NODE=1 -- /.test(calls) && /mcp\.js/.test(calls), calls);
  check('the page says it was added, and the user\'s own config is intact', row && /Added/.test(row.text) && config.startsWith('# the user\'s own settings\nmodel = "gpt-5-codex"') && /\[mcp_servers\.lumen\]/.test(config), (row && row.text) + config);
  const first = (config.match(/\[mcp_servers\.lumen\]/g) || []).length;
  await inSettings("[...document.querySelectorAll('[data-snippet=\"codex\"] button')].find((b) => /^Add|Added|Already/.test(b.textContent))?.click()");
  await sleep(1500);
  const again = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  check('clicking again does not add a second entry', (again.match(/\[mcp_servers\.lumen\]/g) || []).length === first && first === 1, again);
  check('connecting turned "Allow AI agents to connect" on', await inSettings("document.getElementById('ai-mcp')?.checked === true"), '');

  const withTimeouts = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  check('the entry Codex\'s `mcp add` wrote got Lumen\'s timeouts (startup 30 s, tool call 600 s: Codex\'s own are 10 s and 60 s)', /startup_timeout_sec = 30/.test(withTimeouts) && /tool_timeout_sec = 600/.test(withTimeouts) && (withTimeouts.match(/\[mcp_servers\.lumen\]/g) || []).length === 1, withTimeouts);

  // ---- Part 1, end to end: a Codex-style client starts the server exactly as config.toml says, in the restricted environment Codex
  // gives an MCP server (its default variables plus the entry's own `env`), and lists and calls Lumen's tools on this running Lumen.
  {
    const cfg = require('../src/ai/codex-config');
    const http = require('http');
    const { spawn } = require('child_process');
    const page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Codex fixture page</title><body><h1>Hello from the fixture</h1></body>'); });
    await new Promise((r) => page.listen(0, '127.0.0.1', r));
    const entry = cfg.inspect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), { command: '', args: [], env: {} });
    const keep = ['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES', 'PROGRAMDATA', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TZ'];
    const codexEnv = { ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ...entry.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile }; // (the last two only point the test build at the throwaway profile)
    const child = spawn(entry.command, entry.args, { env: codexEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    const waiting = new Map();
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch { /* a log line */ } } });
    let nextId = 0;
    const ask = (method, params, ms = 30000) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); setTimeout(() => reject(new Error(`timeout: ${method}; stderr: ${err}`)), ms); });
    try {
      const init = await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.130.0' } }, 40000);
      check('Codex-style start: the command from config.toml runs in Codex\'s restricted environment, finds the running Lumen and initializes', init.result?.serverInfo?.name === 'lumen' && init.result.protocolVersion === '2025-06-18', JSON.stringify(init).slice(0, 300) + err);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const list = await ask('tools/list', {});
      const tools = list.result?.tools || [];
      check('Codex lists Lumen\'s tools (navigate, read_page, ...), each with a plain object schema Codex can pass on', ['navigate', 'read_page', 'click', 'list_tabs', 'screenshot'].every((n) => tools.some((t) => t.name === n)) && tools.every((t) => t.inputSchema?.type === 'object' && !JSON.stringify(t.inputSchema).includes('$ref')), JSON.stringify(tools.map((t) => t.name)));
      check('read-only tools carry readOnlyHint, so Codex does not ask before each; acting tools do not', tools.find((t) => t.name === 'read_page')?.annotations?.readOnlyHint === true && !tools.find((t) => t.name === 'click')?.annotations, '');
      const url = `http://127.0.0.1:${page.address().port}/`;
      const nav = await ask('tools/call', { name: 'navigate', arguments: { url } }, 60000);
      const navText = (nav.result?.content || []).map((c) => c.text || '').join('\n');
      check('Codex calls navigate on Lumen', !nav.result?.isError && /Codex fixture page|Hello from the fixture/.test(navText), JSON.stringify(nav).slice(0, 300));
      const read = await ask('tools/call', { name: 'read_page', arguments: {} }, 60000);
      const readText = (read.result?.content || []).map((c) => c.text || '').join('\n');
      check('Codex calls read_page and reads the page', !read.result?.isError && /Hello from the fixture/.test(readText), readText.slice(0, 300));
      const pill = await ui.evaluate(() => ({ active: document.body.classList.contains('mcp-active'), text: document.querySelector('#agent-pill span:not(.agent-dot)')?.textContent }));
      check('the "driven by" pill names Codex', pill.active && pill.text === 'Lumen is being driven by Codex', JSON.stringify(pill));
      const steps = await ui.$$eval('.mcp-step', (els) => els.map((e) => e.textContent));
      check('the calls show in the sidebar as Codex\'s steps', steps.some((x) => x.startsWith('Codex:')), JSON.stringify(steps));
    } catch (e) {
      check('Codex-style session against the running Lumen', false, e.message);
    } finally {
      try { child.kill(); } catch { /* gone */ }
      page.close();
    }
    // The gate: with "Allow AI agents to connect" off, Codex gets a startup error that names the setting.
    await ui.evaluate(() => window.assistant.setMcpEnabled(false));
    const off = spawn(entry.command, entry.args, { env: codexEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const offReply = await new Promise((resolve) => { let o = ''; off.stdout.on('data', (d) => { o += d; if (/\n/.test(o)) resolve(o); }); off.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client' } } })}\n`); setTimeout(() => resolve(o || 'timeout'), 30000); });
    check('with "Allow AI agents to connect" off, Codex\'s connection is refused with the setting named', /Allow AI agents to connect|turned off/.test(offReply), offReply);
    try { off.kill(); } catch { /* gone */ }
    await ui.evaluate(() => window.assistant.setMcpEnabled(true));
  }

  // Not found: nothing on this fake machine
  await closeApp(app);
  const env2 = { ...env, LUMEN_CODEX_BIN: path.join(dir, 'missing', 'codex.exe') };
  const app2 = await electron.launch({ args: [root], env: env2 });
  const ui2 = await app2.firstWindow();
  await ui2.waitForSelector('.tab');
  const inSettings2 = await openSettingsTab(app2);
  const read2 = () => inSettings2("(() => { const s = document.querySelector('[data-snippet=\"codex\"]'); return s && { text: s.textContent, button: [...s.querySelectorAll('button')].map((b) => b.textContent) }; })()");
  let none = null;
  for (let i = 0; i < 80 && !(none && /wasn.t found|did not run|not there/.test(none.text)); i++) { await sleep(250); none = await read2(); }
  // (a machine that has a real Codex somewhere else would be found: only then is this check meaningful)
  if (none && /Codex \d/.test(none.text)) console.log('SKIP  not-found view (a real Codex is installed on this computer)');
  else check('with no Codex: an actionable row (install links and "Locate codex…"), not a silent failure', none && /Codex wasn.t found/.test(none.text) && none.button.includes('Download Codex') && none.button.includes('Locate codex…'), none && JSON.stringify(none));
  await closeApp(app2);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
