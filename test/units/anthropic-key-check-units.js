// Saving an Anthropic key checks it first, like the other providers (providers.checkKey with a stubbed fetch; no network):
// a valid key passes, a rejected one (401/403) is refused with a reason, and a network failure or provider trouble is "couldn't check" (saved anyway).
const providers = require('../../src/ai/providers');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

(async () => {
  let seen = null;
  const reply = (status) => async (url, init) => { seen = { url, init }; return { status, ok: status >= 200 && status < 300 }; };
  const ok = await providers.checkKey('anthropic', 'sk-ant-good', { fetchImpl: reply(200) });
  check('valid key: ok, asked GET /v1/models with x-api-key and anthropic-version', ok.ok === true && /^https:\/\/api\.anthropic\.com\/v1\/models/.test(seen.url) && seen.init.headers['x-api-key'] === 'sk-ant-good' && !!seen.init.headers['anthropic-version'] && !!seen.init.signal, JSON.stringify(ok));
  const bad = await providers.checkKey('anthropic', 'sk-ant-typo', { fetchImpl: reply(401) });
  check('401: rejected, with a message the settings page shows', bad.ok === false && /Anthropic didn't accept that key/.test(bad.message), JSON.stringify(bad));
  check('403: rejected too', (await providers.checkKey('anthropic', 'k', { fetchImpl: reply(403) })).ok === false, '');
  const net = await providers.checkKey('anthropic', 'k', { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  check('network error: could not be checked (null), so the key is saved with a note', net.ok === null, JSON.stringify(net));
  const timeout = await providers.checkKey('anthropic', 'k', { fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
  check('timeout: could not be checked (null)', timeout.ok === null, JSON.stringify(timeout));
  check('provider trouble (500, 429): could not be checked (null)', (await providers.checkKey('anthropic', 'k', { fetchImpl: reply(500) })).ok === null && (await providers.checkKey('anthropic', 'k', { fetchImpl: reply(429) })).ok === null, '');
  check('other providers keep their own message', (await providers.checkKey('openrouter', 'k', { fetchImpl: reply(401) })).message === "OpenRouter didn't accept that key. Check it and try again.", '');

  console.log(failures ? `\n${failures} anthropic-key-check failure(s)` : '\nall anthropic-key-check checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
