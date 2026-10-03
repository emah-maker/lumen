// The AI SDKs use Electron's net.fetch (net-fetch.js), so they follow Lumen's proxy setting like the
// browser does. Node's fetch ignored it: on a network that needs a proxy the browser loaded
// openrouter.ai while the OpenRouter/OpenAI/Grok/Gemini engines got "connection error".
// A fake proxy plays the providers: Lumen is pointed at it, and the SDK calls must arrive there.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

(async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (/^http:\/\/openai\.test\/v1\/models/.test(req.url)) return res.end(JSON.stringify({ object: 'list', data: [] }));
    if (/^http:\/\/openrouter\.test\/api\/v1\/key/.test(req.url)) return res.end(JSON.stringify({ data: { label: 'x' } }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-netfetch-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile }, colorScheme: null });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const out = await app.evaluate(async ({ session }, port) => {
      const providers = global.__providers;
      await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${port}` });
      providers.PROVIDERS.openai.baseURL = 'http://openai.test/v1';
      providers.PROVIDERS.openrouter.baseURL = 'http://openrouter.test/api/v1';
      const orKey = await providers.checkKey('openrouter', 'test-key');
      const oaKey = await providers.checkKey('openai', 'test-key');
      return { orKey, oaKey };
    }, port);
    check('OpenRouter key check goes through Lumen\'s proxy and succeeds', out.orKey?.ok === true && seen.some((s) => /openrouter\.test\/api\/v1\/key/.test(s)), JSON.stringify({ out, seen }));
    check('an OpenAI-SDK call (models list) goes through Lumen\'s proxy and succeeds', out.oaKey?.ok === true && seen.some((s) => /openai\.test\/v1\/models/.test(s)), JSON.stringify({ out, seen }));
  } finally {
    await app.close().catch(() => {});
    proxy.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
