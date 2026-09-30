// "Claude · your account (Claude Code)": the sidebar engine that runs the user's own `claude` CLI.
// Offline checks always run; one real, cheap message runs when the CLI is installed (it uses the
// user's plan). Skipped gracefully without the CLI.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const { execFile } = require('child_process');
const { findClaude, buildArgs, stdinMessage, describeFailure, parseAuthStatus } = require('../src/ai/claude-code');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

  // Offline: the argv (never a shell string) and error mapping.
  const argv = buildArgs({ mcpConfig: '/tmp/x.json', sessionId: 'abc', resume: false, systemPrompt: 'S' });
  const flag = (f) => argv[argv.indexOf(f) + 1];
  check('argv: headless stream-json with partial messages', argv[0] === '-p' && flag('--output-format') === 'stream-json' && argv.includes('--verbose') && argv.includes('--include-partial-messages'), argv.join(' '));
  check('argv: input is stream-json (carries image blocks on stdin)', flag('--input-format') === 'stream-json', argv.join(' '));
  check('argv: no built-in tools, only mcp__lumen, no prompts', flag('--tools') === '' && flag('--allowedTools') === 'mcp__lumen' && flag('--permission-mode') === 'dontAsk' && argv.includes('--strict-mcp-config'), argv.join(' '));
  check('argv: new chat uses --session-id, follow-up uses --resume', flag('--session-id') === 'abc' && buildArgs({ mcpConfig: 'x', sessionId: 'abc', resume: true, systemPrompt: 'S' }).includes('--resume'), argv.join(' '));
  check('argv: the default pick passes no --model, a picked one passes --model <alias>', !argv.includes('--model') && buildArgs({ mcpConfig: 'x', sessionId: 'abc', resume: false, systemPrompt: 'S', model: 'sonnet' }).join(' ').includes('--model sonnet'), argv.join(' '));
  check('error: not logged in -> run claude, then /login', /run `claude` once, then type \/login/.test(describeFailure('Invalid API key · Please run /login').text), describeFailure('Invalid API key · Please run /login').text);
  check('error: usage limit is named', /usage limit/.test(describeFailure("Claude AI usage limit reached|1760000000").text), describeFailure('Claude AI usage limit reached').text);

  // Offline: the stdin JSONL line itself — text first, then image blocks in the Anthropic shape.
  const textOnly = stdinMessage('hello', []);
  check('stdin message: plain text has no image blocks', textOnly.type === 'user' && textOnly.parent_tool_use_id === null && textOnly.message.content.length === 1 && textOnly.message.content[0].text === 'hello', JSON.stringify(textOnly));
  const withImage = stdinMessage('what color is this?', [{ media_type: 'image/png', data: 'AAAA' }]);
  const kinds = withImage.message.content.map((b) => b.type);
  check('stdin message: [text, image] with the Anthropic base64 image shape', JSON.stringify(kinds) === '["text","image"]' && withImage.message.content[1].source.type === 'base64' && withImage.message.content[1].source.media_type === 'image/png' && withImage.message.content[1].source.data === 'AAAA', JSON.stringify(withImage));

  // Offline: parseAuthStatus (claude-code.js) on sample `claude auth status --json` outputs, so the
  // sign-in label is tested without needing a real login (or even the CLI) on the machine running tests.
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('auth status: subscription (claude.ai)', eq(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'enterprise' })), { signedIn: true, accountType: 'subscription', detail: 'enterprise' }), parseAuthStatus('{}'));
  check('auth status: subscription with no plan name', eq(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })), { signedIn: true, accountType: 'subscription', detail: null }));
  check('auth status: API key', eq(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'apiKey' })), { signedIn: true, accountType: 'apiKey', detail: null }));
  check('auth status: logged out', eq(parseAuthStatus(JSON.stringify({ loggedIn: false })), { signedIn: false, accountType: null, detail: null }));
  check('auth status: unparseable output -> unknown (older CLI, stray text)', eq(parseAuthStatus('command not found'), { signedIn: 'unknown', accountType: null, detail: null }));
  check('auth status: JSON missing loggedIn -> unknown', eq(parseAuthStatus(JSON.stringify({ ok: true })), { signedIn: 'unknown', accountType: null, detail: null }));

  const bin = await findClaude();
  if (!bin) {
    console.log('SKIP  real Claude Code run: the claude CLI is not installed');
    console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
    process.exit(failures ? 1 : 0);
  }
  console.log(`      using ${bin}`);

  // Live: the real `claude auth status --json` shape on this machine, parsed the same way the app
  // does. Logs only key names and the parsed label, never the raw output (which carries an email).
  {
    const stdout = await new Promise((resolve) => execFile(bin, ['auth', 'status', '--json'], { shell: false, windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : out)));
    if (stdout === null) {
      console.log('      `claude auth status` unsupported or failed on this CLI build (checkAuthStatus treats that as \'unknown\')');
    } else {
      let keys = [];
      try { keys = Object.keys(JSON.parse(stdout)); } catch {}
      const parsed = parseAuthStatus(stdout);
      console.log(`      real output keys: ${JSON.stringify(keys)}`);
      console.log(`      parsed: signedIn=${parsed.signedIn} accountType=${parsed.accountType} detail=${parsed.detail}`);
      check('auth status: real CLI output parses to a known signedIn value', [true, false, 'unknown'].includes(parsed.signedIn), JSON.stringify(parsed));
    }
  }

  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(800);

  // Picker: the Claude Code option (a lone group has no heading), picked.
  let ids = [];
  for (let i = 0; i < 20 && !ids.includes('claudecode:default'); i++) {
    await sleep(300);
    ids = await ui.$$eval('#model option', (os) => os.map((o) => o.value));
  }
  check('picker offers your own Claude Code', ids.includes('claudecode:default'), JSON.stringify(ids));
  const ccLabels = await ui.$$eval('#model option', (os) => os.filter((o) => o.value.startsWith('claudecode:')).map((o) => `${o.value}=${o.textContent}`));
  check('picker offers Claude Code\'s models too', ['claudecode:fable=Claude Code · Fable', 'claudecode:opus=Claude Code · Opus', 'claudecode:sonnet=Claude Code · Sonnet', 'claudecode:haiku=Claude Code · Haiku'].every((l) => ccLabels.includes(l)) && ccLabels[0] === 'claudecode:default=Claude Code', JSON.stringify(ccLabels));
  await ui.selectOption('#model', 'claudecode:default');
  await sleep(300);
  check('the toolbar keeps the Claude mark', (await ui.getAttribute('#toggle-sidebar', 'data-assistant')) === 'Claude', await ui.getAttribute('#toggle-sidebar', 'data-assistant'));

  await app.evaluate(() => global.__agent.execute('navigate', { url: 'https://example.com' }));
  await sleep(800);

  // One real message, through the sidebar UI like a user.
  await ui.evaluate(() => {
    window.__ccEvents = [];
    window.assistant.onEvent((e) => window.__ccEvents.push({ type: e.type, name: e.name, text: e.text }));
  });
  const t0 = Date.now();
  await ui.fill('#prompt', 'Use read_page and tell me the page title');
  await ui.press('#prompt', 'Enter');
  for (let i = 0; i < 400; i++) {
    await sleep(500);
    if (await ui.evaluate(() => window.__ccEvents.some((e) => e.type === 'done'))) break;
  }
  const events = await ui.evaluate(() => window.__ccEvents);
  const seconds = Math.round((Date.now() - t0) / 1000);
  const texts = events.filter((e) => e.type === 'text');
  const reply = texts.map((e) => e.text).join('');
  const errorsSeen = events.filter((e) => e.type === 'error').map((e) => e.text);
  console.log(`      real run: ${seconds}s, ${texts.length} text chunks, events: ${[...new Set(events.map((e) => e.type))].join(',')}`);
  console.log(`      reply: ${reply.slice(0, 160).replace(/\n/g, ' ')}`);
  check('the run finished without an error', events.some((e) => e.type === 'done') && !errorsSeen.length, errorsSeen.join(' | ') || 'no done event');
  check('streamed text arrived (several chunks)', texts.length >= 2 && /Example Domain/i.test(reply), `${texts.length} chunks: ${reply.slice(0, 200)}`);
  check('Claude Code called Lumen\'s read_page over MCP', events.some((e) => e.type === 'tool' && e.name === 'read_page'), JSON.stringify(events.filter((e) => e.type === 'tool')));
  const rows = await ui.evaluate(() => ({ steps: document.querySelectorAll('#messages .step:not(.mcp-step)').length, mcp: document.querySelectorAll('#messages .mcp-step').length, notices: [...document.querySelectorAll('#messages .notice')].map((n) => n.textContent) }));
  check('one step row per call, none duplicated as an external agent', rows.steps >= 1 && rows.mcp === 0 && !rows.notices.some((n) => /connected to Lumen|disconnected/.test(n)), JSON.stringify(rows));
  check('the reply shows in the chat', /Example Domain/i.test(await ui.evaluate(() => [...document.querySelectorAll('#messages .msg.assistant')].pop()?.textContent || '')), 'no reply bubble');
  const replyModel = await ui.evaluate(() => [...document.querySelectorAll('#messages .reply-model')].pop()?.textContent || '');
  check('the reply is labelled "Claude Code", not "Claude Claude Code"', replyModel === 'Claude Code', replyModel);
  const session = await app.evaluate(() => global.__agent.messages.settings?.ccSession || null);
  check('the Claude Code session is kept for follow-ups', /^[0-9a-f-]{36}$/.test(session || ''), session);
  await ui.click('#new-chat');
  await sleep(300);
  check('New chat clears the session', (await app.evaluate(() => global.__agent.messages.settings?.ccSession || null)) === null, 'still set');

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
