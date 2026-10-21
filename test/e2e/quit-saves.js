// What Lumen keeps survives a quit right after a change (hidden). A chat message and an open page, then the app quits at once (no
// wait for the debounced saves), and the same profile is opened again: the chat and the tab must both be there. Quitting runs the
// before-quit writes first and the quit deadline (features/quit-guard.js) only after them.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..', '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  timeout: 90000,
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Fixture ${req.url.slice(1)}</title><body><p>fixture ${req.url}</p></body>`); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-quitsaves-'));
  const TEXT = 'remember this sentence across the quit';

  let app = await launch(profile);
  let ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  await app.evaluate(() => {
    global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Noted.' }], usage: { input_tokens: 10, output_tokens: 5 } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Noted.' } }; }, finalMessage: async () => message };
    } } } });
  });
  await app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
  }, `${base}/kept`);
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.fill('#prompt', TEXT);
  await ui.press('#prompt', 'Enter');
  await waitFor(async () => /Noted\./.test(await ui.evaluate(() => document.getElementById('messages').textContent)));
  const proc = app.process();
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  app.evaluate(({ app: a }) => a.quit()).catch(() => {}); // at once: nothing waits for a debounced save
  await Promise.race([exited, sleep(60000)]);
  check('the first Lumen exited', proc.exitCode !== null || Boolean(proc.signalCode), 'still running after 60 s');

  app = await launch(profile);
  ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  const chatHas = () => app.evaluate((_e, text) => {
    const store = global.__chats.store();
    return store.list().some((c) => { try { return JSON.stringify(store.load(c.id)).includes(text); } catch { return false; } });
  }, TEXT);
  check('the chat written just before the quit is in the chat store', Boolean(await waitFor(chatHas)), 'not found');
  check('the page that was open comes back', Boolean(await waitFor(async () => (await app.evaluate(() => global.__chatPage.tabs())).some((t) => /\/kept$/.test(t.url)))), JSON.stringify(await app.evaluate(() => global.__chatPage.tabs()).catch(() => null)));
  check('the settings file is whole (parses, has the session)', (() => { try { return Boolean(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).session); } catch (err) { return false; } })(), 'settings.json');

  try { await app.close(); } catch { /* already gone */ }
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
