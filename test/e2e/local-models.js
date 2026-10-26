// Local AI (Ollama / LM Studio) in the real app, against a fake Ollama on 127.0.0.1 (no real network): Settings → AI → AI providers →
// Local (switch, Detect, the models list with what each can do, an address that isn't on this computer asks first), the models in
// the picker, a full chat turn (streamed text + a tool call that runs), the plain-chat fallback for a model without tools, and a
// stopped server: the chat stays local (it is never handed to a cloud model).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('../helpers/settings-tab');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(60); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

  // Fake Ollama: model list, capabilities, and streaming chat completions (a tool call first, then text).
  const requests = [];
  const json = (res, obj, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ url: req.url, body: parsed });
      if (req.url === '/api/tags') return json(res, { models: [{ name: 'llama3.2:latest' }, { name: 'toolless:latest' }, { name: 'chatty:latest' }] });
      if (req.url === '/api/show') return json(res, { capabilities: parsed.model === 'llama3.2:latest' ? ['completion', 'tools'] : parsed.model === 'chatty:latest' ? ['completion', 'tools'] : ['completion'] });
      if (req.url !== '/v1/chat/completions') return json(res, { error: 'not found' }, 404);
      if (parsed.model === 'toolless:latest' && parsed.tools) return json(res, { error: { message: 'registry.ollama.ai/library/toolless:latest does not support tools' } }, 400);
      res.setHeader('Content-Type', 'text/event-stream');
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const wantsTool = parsed.model === 'llama3.2:latest' && parsed.tools && !parsed.messages.some((m) => m.role === 'tool');
      if (wantsTool) {
        chunk({ role: 'assistant', content: 'Let me look. ' });
        chunk({ tool_calls: [{ index: 0, id: 'call_local1', type: 'function', function: { name: 'read_page', arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: `Local answer from ${parsed.model}.` });
        chunk({}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chats = () => requests.filter((r) => r.url === '/v1/chat/completions');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-local-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  app.process().stderr?.on('data', (d) => { const t = String(d); if (/Error|Uncaught|exception/i.test(t) && !/MaxListeners/.test(t)) console.log(`  [main stderr] ${t.trim().slice(0, 400)}`); });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  // A cloud model must never be asked for anything in this suite: count its calls.
  await app.evaluate(() => { global.__cloudCalls = 0; global.__agent.getClient = () => { global.__cloudCalls++; throw new Error('the cloud client was used'); }; });

  // ---- Settings → AI → AI providers → Local
  const inSettings = await openSettingsTab(app, 'providers');
  await waitFor(() => inSettings("Boolean(document.getElementById('local-detect'))"));
  check('the Local block shows an unchecked switch, Ollama, and its usual address', (await inSettings("(() => { const s = (id) => document.getElementById(id); return JSON.stringify([s('local-enabled').checked, s('local-flavor').value, s('local-url').value, s('local-url').placeholder]); })()")) === JSON.stringify([false, 'ollama', 'http://127.0.0.1:11434', 'http://127.0.0.1:11434']));
  const none = await ui.evaluate(async () => (await window.assistant.getSettings()).models.filter((m) => /^local:/.test(m.id)).length);
  check('nothing from Local is in the model menu while it is off', none === 0, none);
  await inSettings("(() => { const f = document.getElementById('local-flavor'); f.value = 'lmstudio'; f.dispatchEvent(new Event('change')); })()");
  await waitFor(async () => (await inSettings("document.getElementById('local-url').value")) === 'http://127.0.0.1:1234/v1');
  check('choosing LM Studio fills its usual address', (await inSettings("document.getElementById('local-url').value")) === 'http://127.0.0.1:1234/v1');
  await inSettings("(() => { const f = document.getElementById('local-flavor'); f.value = 'ollama'; f.dispatchEvent(new Event('change')); })()");
  await waitFor(async () => (await inSettings("document.getElementById('local-url').value")) === 'http://127.0.0.1:11434');

  // An address that is not on this computer asks first, and nothing is sent to it.
  await inSettings("(() => { const u = document.getElementById('local-url'); u.value = 'http://192.0.2.9:11434'; document.getElementById('local-detect').click(); })()");
  await waitFor(() => inSettings("Boolean(document.getElementById('local-confirm'))"));
  check('an address off this computer asks before Detect uses it', Boolean(await inSettings("document.getElementById('local-confirm')")) && /isn’t on this computer/.test(await inSettings("document.getElementById('local-status').textContent")), await inSettings("document.getElementById('local-status').textContent"));
  const savedRemote = await app.evaluate(() => { global.__settingsFlush?.(); return null; }).then(() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).localAI; } catch { return undefined; } });
  check('…and nothing was saved for it', !savedRemote || !savedRemote.confirmedHost, JSON.stringify(savedRemote));

  // The fake Ollama: Detect lists what is installed and what each can do.
  await inSettings(`(() => { document.getElementById('local-url').value = ${JSON.stringify(base)}; document.getElementById('local-detect').click(); })()`);
  await waitFor(async () => (await inSettings("document.querySelectorAll('#local-models .item').length")) === 3);
  const listed = await inSettings("[...document.querySelectorAll('#local-models .item')].map((i) => i.dataset.model + '=' + i.querySelector('.note').textContent).join(';')");
  check('Detect lists the installed models with what each can do', listed === 'llama3.2:latest=Can use tools;toolless:latest=Chat only;chatty:latest=Can use tools', listed);
  check('Detect says what it found', /Found 3 models on Ollama/.test(await inSettings("document.getElementById('local-status').textContent")), await inSettings("document.getElementById('local-status').textContent"));
  check('Detect read the server\'s own list and asked for no key', requests.some((r) => r.url === '/api/tags') && requests.filter((r) => r.url === '/api/show').length === 3);

  // Switch it on: the models join the picker, and the one without tools says so.
  await inSettings("document.getElementById('local-enabled').click()");
  const entries = await waitFor(async () => { const m = await ui.evaluate(async () => (await window.assistant.getSettings()).models.filter((x) => /^local:/.test(x.id))); return m.length === 3 ? m : null; });
  check('the models appear in the model menu under Local', entries && entries.every((m) => m.group === 'Local') && entries.map((m) => m.id).join() === 'local:llama3.2:latest,local:toolless:latest,local:chatty:latest', JSON.stringify(entries));
  check('the model without tools is badged "chat only"', entries && entries.find((m) => m.id === 'local:toolless:latest').badges.includes('chat only') && !entries.find((m) => m.id === 'local:llama3.2:latest').badges.includes('chat only'), JSON.stringify(entries));
  const stored = await app.evaluate(() => { global.__settingsFlush?.(); return null; }).then(() => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')));
  check('it is saved as a setting with no key', stored.localAI?.enabled === true && stored.localAI.url === base && !(stored.keys && stored.keys.local), JSON.stringify(stored.localAI));
  check('Local has no row among the API keys', !(await inSettings("Boolean(document.querySelector('#ai-keys [data-provider=local]'))")));
  await app.evaluate((_e, sid) => global.__agent.browser.closeTab(sid), inSettings.id);

  // ---- A full turn on a tool-capable local model: streamed text, a tool call that runs, the final reply.
  await ui.evaluate(() => { document.getElementById('toggle-sidebar').click(); });
  await sleep(500);
  const groups = await ui.$$eval('#model optgroup', (gs) => gs.map((g) => g.label));
  check('the picker has a Local group', groups.includes('Local'), JSON.stringify(groups));
  check('Auto does not list Local', !(await ui.$$eval('#model option', (os) => os.map((o) => o.value))).includes('local:auto'));
  await ui.selectOption('#model', 'local:llama3.2:latest');
  await sleep(300);
  await ui.fill('#prompt', 'What is this page?');
  await ui.press('#prompt', 'Enter');
  await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 20000 }).catch(() => {});
  const reply = await ui.evaluate(() => [...document.querySelectorAll('.msg.assistant')].map((e) => e.textContent).join(' | '));
  check('the reply streams into the sidebar', /Local answer from llama3\.2:latest/.test(reply), reply);
  check('the tool step ran', (await ui.locator('.step').count()) >= 1, await ui.locator('.step').count());
  const first = chats()[0]?.body;
  check('the request was streamed, with tools, to the local server', first && first.stream === true && first.tools?.some((t) => t.function.name === 'read_page'), JSON.stringify(first).slice(0, 300));
  check('the tool result went back as a tool message', chats().some((r) => r.body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_local1')));

  // ---- A model without tools: the same chat, as plain chat, and it says so.
  await app.evaluate(() => { global.__agent.reset(); });
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await ui.selectOption('#model', 'local:toolless:latest');
  await ui.fill('#prompt', 'hello');
  await ui.press('#prompt', 'Enter');
  await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 20000 }).catch(() => {});
  const plain = await ui.evaluate(() => document.getElementById('messages')?.textContent || document.body.textContent);
  check('a model without tools answers as plain chat and the chat says so', /Local answer from toolless:latest/.test(plain) && /Browser actions need a tool-capable local model/.test(plain), plain.slice(-400));
  const toolless = chats().filter((r) => r.body.model === 'toolless:latest');
  check('no tools were sent to it', toolless.length >= 1 && toolless.every((r) => !r.body.tools), JSON.stringify(toolless.map((r) => Boolean(r.body.tools))));

  // ---- A stopped server: the chat says so and stays local.
  await new Promise((r) => server.close(r));
  await app.evaluate(() => { global.__agent.reset(); });
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await ui.selectOption('#model', 'local:chatty:latest');
  await ui.fill('#prompt', 'anyone there?');
  await ui.press('#prompt', 'Enter');
  await ui.waitForSelector('.error', { timeout: 20000 }).catch(() => {});
  const err = await ui.locator('.error').last().innerText().catch(() => '');
  check('a stopped server is explained in plain words', /Couldn’t reach your local AI server/.test(err), err);
  check('the chat was not handed to a cloud model', (await app.evaluate(() => global.__cloudCalls)) === 0 && (await ui.evaluate(async () => (await window.assistant.getSettings()).model)) === 'local:chatty:latest');

  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
