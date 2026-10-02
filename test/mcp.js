// AI agents over MCP: start Lumen, then start the bridge exactly as a CLI agent would
// (`electron . --mcp`) and speak MCP over its stdio.
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('./settings-tab');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcp-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  const root = path.join(__dirname, '..');

  const app = await electron.launch({ args: [root], env });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await ui.waitForTimeout(500);

  // Off by default: a fresh profile refuses agents until the user turns it on (or adds an agent).
  const fresh = await ui.evaluate(() => window.assistant.mcpInfo());
  check('"Allow AI agents to connect" is off by default', fresh.enabled === false, JSON.stringify(fresh.enabled));
  const offFirst = spawn(require('electron'), [path.join(root, 'mcp.js')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const offFirstReply = await new Promise((resolve) => {
    let out = '';
    offFirst.stdout.on('data', (d) => { out += d; if (/\{.*\}\s*\n/.test(out)) resolve(out); });
    offFirst.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x' } } })}\n`);
    setTimeout(() => resolve(out || 'timeout'), 20000);
  });
  check('while off, an agent is told the setting is off (not that Lumen is missing)', /turned off in Lumen settings/.test(offFirstReply), offFirstReply);
  offFirst.kill();
  await ui.evaluate(() => window.assistant.setMcpEnabled(true));

  // The MCP bridge, launched like `claude mcp add lumen -- electron . --mcp` would.
  const bridge = spawn(require('electron'), [path.join(root, 'mcp.js')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let rawOut = '';
  bridge.stdout.on('data', (d) => { rawOut += d; });
  let stderr = '';
  bridge.stderr.on('data', (d) => { stderr += d; });
  let buffer = '';
  const waiting = new Map();
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let nextId = 1;
  const request = (method, params, timeout = 30000) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, resolve);
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), timeout);
  });
  const notify = (method, params) => bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const call = (name, args) => request('tools/call', { name, arguments: args }, 60000);
  const text = (r) => (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  // The settings panel shows ready-to-paste commands.
  const info = await ui.evaluate(() => window.assistant.mcpInfo());
  const claudeSnippet = info.snippets.find((s) => s.id === 'claude')?.text || '';
  check('settings give a Claude Code command (user scope)', claudeSnippet.includes('mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -- ') && claudeSnippet.includes('mcp.js'), claudeSnippet);
  if (process.platform === 'win32') {
    // PowerShell's claude.ps1 shim swallows "--"; claude.cmd and quoted paths work in PowerShell and cmd.
    check('Windows command uses claude.cmd with quoted paths', /^claude\.cmd mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -- "[^"]+" "[^"]+mcp\.js"$/.test(claudeSnippet), claudeSnippet);
  }
  const inSettings = await openSettingsTab(app);
  check('Settings offer an Add to Claude Code button', await inSettings("[...document.querySelectorAll('#ai-snippets button')].some((b) => b.textContent === 'Add to Claude Code')"), 'no button');
  await app.evaluate((_e, sid) => global.__agent.browser.closeTab(sid), inSettings.id);
  check('settings give Codex, Antigravity and generic configs', ['codex', 'antigravity', 'json'].every((id) => info.snippets.some((s) => s.id === id)), JSON.stringify(info.snippets.map((s) => s.id)));

  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '1.0' } });
  check('initialize: server info + tools capability + echoed version', init.result?.serverInfo?.name === 'lumen' && init.result.capabilities?.tools && init.result.protocolVersion === '2025-06-18', JSON.stringify(init));
  notify('notifications/initialized');
  const unknownVersion = await request('ping', {});
  check('ping answers', unknownVersion.result && Object.keys(unknownVersion.result).length === 0, JSON.stringify(unknownVersion));

  const list = await request('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name);
  check('tools/list includes navigate, read_page, click, web_search', ['navigate', 'read_page', 'click', 'fill_form', 'web_search'].every((n) => names.includes(n)), JSON.stringify(names));
  check('tools have inputSchema', list.result.tools.every((t) => t.inputSchema?.type === 'object'), 'missing inputSchema');
  // Connected but idle (an agent keeps its session open all day): the pill stays hidden until a tool call runs.
  await ui.waitForTimeout(1800);
  check('an idle connected agent does not show the "driven by" pill', !(await ui.evaluate(() => document.body.classList.contains('mcp-active'))), 'pill shown while idle');

  let r = await call('navigate', { url: 'https://example.com' });
  check('tools/call navigate', !r.result.isError && /Example Domain/.test(text(r)), JSON.stringify(r).slice(0, 300));
  r = await call('read_page', {});
  check('read_page returns the page', /Example Domain/.test(text(r)), text(r).slice(0, 200));
  r = await call('screenshot', {});
  const img = r.result.content.find((c) => c.type === 'image');
  check('screenshot returns an MCP image item', img && img.mimeType === 'image/jpeg' && img.data.length > 1000, JSON.stringify(r.result.content.map((c) => c.type)));
  r = await call('click', {});
  check('invalid input returns isError', r.result.isError === true && /one of: element_id, text/.test(text(r)), JSON.stringify(r));
  const unknown = await request('tools/call', { name: 'format_disk', arguments: {} });
  check('unknown tool is a JSON-RPC error', unknown.error?.code === -32602, JSON.stringify(unknown));

  // The user sees the agent: pill text + step rows in the sidebar.
  await ui.waitForTimeout(300);
  const pill = await ui.evaluate(() => ({ active: document.body.classList.contains('mcp-active'), text: document.querySelector('#agent-pill span:not(.agent-dot)')?.textContent }));
  check('pill says Lumen is being driven by Claude Code', pill.active && pill.text === 'Lumen is being driven by Claude Code', JSON.stringify(pill));
  const steps = await ui.$$eval('.mcp-step', (els) => els.map((e) => e.textContent));
  check('tool calls appear as sidebar steps', steps.some((s) => s.startsWith('Claude Code:')), JSON.stringify(steps));

  // Approval: with auto-approve off, a click shows the card; denying returns isError.
  await app.evaluate(() => { global.__agent.browser.autoApprove = () => false; });
  const clickPromise = call('click', { text: 'More information' });
  await ui.waitForSelector('.approval:not(.resolved)', { state: 'attached', timeout: 10000 }).catch(() => {});
  // An outside agent's card is quiet: it never opens the sidebar by itself (the AI button gets its badge); the user opens it to answer.
  check('an agent approval card does not open the sidebar', await ui.evaluate(() => document.body.classList.contains('sidebar-hidden') && document.getElementById('toggle-sidebar').classList.contains('approval-pending')), 'sidebar opened or no badge');
  await ui.evaluate(() => window.showSidebar(true));
  await ui.waitForSelector('.approval:not(.resolved)', { timeout: 10000 }).catch(() => {});
  const cardTitle = await ui.$eval('.approval:not(.resolved) .approval-title', (e) => e.textContent).catch(() => '');
  check('approval card names the external agent', cardTitle === 'An external agent (Claude Code) wants to interact with example.com', cardTitle);
  await ui.click('.approval:not(.resolved) .btn:not(.primary)');
  r = await clickPromise;
  check('denying the card returns isError to the agent', r.result.isError === true && /did not allow Claude Code/.test(text(r)), JSON.stringify(r));

  // Badge on the AI button while an approval waits and the sidebar is closed.
  const badge = await ui.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await showSidebar(false);
    await wait(700);
    showApproval(9999, 'badge.example');
    await wait(50);
    const on = document.getElementById('toggle-sidebar').classList.contains('approval-pending');
    resolveApproval(9999, false);
    await wait(50);
    const off = !document.getElementById('toggle-sidebar').classList.contains('approval-pending');
    await showSidebar(true);
    await wait(700);
    return { on, off };
  });
  check('pending approval badges the AI button while the sidebar is closed', badge.on && badge.off, JSON.stringify(badge));

  check('stdout carries only JSON-RPC lines (Node-mode bridge)', rawOut.split('\n').filter(Boolean).every((l) => l.startsWith('{')), JSON.stringify(rawOut.slice(0, 80)));

  // The `Lumen --mcp` fallback also answers (GUI Electron prints one blank line first on Windows).
  const legacy = spawn(require('electron'), [root, '--mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const legacyReply = await new Promise((resolve) => {
    let out = '';
    legacy.stdout.on('data', (d) => { out += d; if (/\{.*\}\s*\n/.test(out)) resolve(out); });
    legacy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy' } } })}\n`);
    setTimeout(() => resolve(out || 'timeout'), 20000);
  });
  check('`Lumen --mcp` fallback also works', /"id":7,"result"/.test(legacyReply), legacyReply.slice(0, 200));
  legacy.kill();

  // A connection without the token is refused.
  const channel = require('../src/automation/mcp').channelPath(profile);
  const refused = await new Promise((resolve) => {
    // Answer the challenge with a proof made from the wrong token.
    const s = net.connect(channel);
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      const m = buf.match(/"lumenChallenge":"([0-9a-f]+)"/);
      if (m && !s.__answered) {
        s.__answered = true;
        const bad = require('crypto').createHmac('sha256', 'wrong-token').update(m[1]).digest('hex');
        s.write(`${JSON.stringify({ lumenProof: bad })}\n`);
      }
    });
    let got = '';
    s.on('data', (d) => { got += d; });
    s.on('close', () => resolve(got));
    s.on('error', (e) => resolve(`error ${e.message}`));
    setTimeout(() => resolve(got || 'timeout'), 5000);
  });
  check('bridge channel refuses a wrong token', /"lumenAuth":"denied"/.test(refused), refused);
  check('the token is never sent over the channel', !refused.includes(fs.readFileSync(path.join(profile, 'mcp-token'), 'utf8')), 'token leaked');
  // The right proof (HMAC-SHA256 of the challenge with the token) is accepted.
  const accepted = await new Promise((resolve) => {
    const token = fs.readFileSync(path.join(profile, 'mcp-token'), 'utf8').trim();
    const s = net.connect(channel);
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      const m = buf.match(/"lumenChallenge":"([0-9a-f]+)"/);
      if (m && !s.__answered) {
        s.__answered = true;
        s.write(`${JSON.stringify({ lumenProof: require('../src/automation/mcp').proofFor(token, m[1]) })}\n`);
      }
      if (/"lumenAuth":"ok"/.test(buf)) { s.destroy(); resolve(buf); }
    });
    s.on('error', (e) => resolve(`error ${e.message}`));
    setTimeout(() => { s.destroy(); resolve(buf || 'timeout'); }, 5000);
  });
  check('bridge channel accepts the right HMAC proof', /"lumenAuth":"ok"/.test(accepted), accepted);
  const tokenFile = fs.readFileSync(path.join(profile, 'mcp-token'), 'utf8');
  check('token is random and stored in the profile', /^[0-9a-f]{48}$/.test(tokenFile), tokenFile.length);

  // Turning the setting off refuses new sessions.
  await ui.evaluate(() => window.assistant.setMcpEnabled(false));
  const off = spawn(require('electron'), [path.join(root, 'mcp.js')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const offReply = await new Promise((resolve) => {
    let out = '';
    off.stdout.on('data', (d) => { out += d; if (/\{.*\}\s*\n/.test(out)) resolve(out); });
    off.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x' } } })}\n`);
    setTimeout(() => resolve(out || 'timeout'), 20000);
  });
  check('with the setting off, initialize is refused', /turned off in Lumen settings/.test(offReply), offReply);
  off.kill();
  await ui.evaluate(() => window.assistant.setMcpEnabled(true));

  // Closing the bridge ends the session in the UI.
  bridge.stdin.end();
  await new Promise((r) => setTimeout(r, 1500));
  check('pill clears when the agent disconnects', !(await ui.evaluate(() => document.body.classList.contains('mcp-active'))), 'still active');

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
