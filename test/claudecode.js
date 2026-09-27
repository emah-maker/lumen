// "Claude · your account (Claude Code)": the sidebar engine that runs the user's own `claude` CLI.
// Offline checks always run; one real, cheap message runs when the CLI is installed (it uses the
// user's plan). Skipped gracefully without the CLI.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const { findClaude, buildArgs, describeFailure } = require('../claude-code');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

  // Offline: the argv (never a shell string) and error mapping.
  const argv = buildArgs({ mcpConfig: '/tmp/x.json', sessionId: 'abc', resume: false, systemPrompt: 'S' });
  const flag = (f) => argv[argv.indexOf(f) + 1];
  check('argv: headless stream-json with partial messages', argv[0] === '-p' && flag('--output-format') === 'stream-json' && argv.includes('--verbose') && argv.includes('--include-partial-messages'), argv.join(' '));
  check('argv: no built-in tools, only mcp__lumen, no prompts', flag('--tools') === '' && flag('--allowedTools') === 'mcp__lumen' && flag('--permission-mode') === 'dontAsk' && argv.includes('--strict-mcp-config'), argv.join(' '));
  check('argv: new chat uses --session-id, follow-up uses --resume', flag('--session-id') === 'abc' && buildArgs({ mcpConfig: 'x', sessionId: 'abc', resume: true, systemPrompt: 'S' }).includes('--resume'), argv.join(' '));
  check('error: not logged in -> run claude, then /login', /run `claude` once, then type \/login/.test(describeFailure('Invalid API key · Please run /login').text), describeFailure('Invalid API key · Please run /login').text);
  check('error: usage limit is named', /usage limit/.test(describeFailure("Claude AI usage limit reached|1760000000").text), describeFailure('Claude AI usage limit reached').text);

  const bin = await findClaude();
  if (!bin) {
    console.log('SKIP  real Claude Code run: the claude CLI is not installed');
    console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
    process.exit(failures ? 1 : 0);
  }
  console.log(`      using ${bin}`);

  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(800);

  // Picker: "Your Claude account" group, the note under it when picked.
  let groups = [];
  for (let i = 0; i < 20 && !groups.includes('Your Claude account'); i++) {
    await sleep(300);
    groups = await ui.$$eval('#model optgroup', (gs) => gs.map((g) => g.label));
  }
  check('picker has a "Your Claude account" group', groups.includes('Your Claude account'), JSON.stringify(groups));
  await ui.selectOption('#model', 'claudecode:default');
  await sleep(300);
  check('the note shows under the picker', await ui.isVisible('#cc-note') && /Uses your Claude Code login/.test(await ui.textContent('#cc-note')), 'hidden');
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
