// OpenRouter's catalog (providers.openRouterCatalog): a stale copy beats an error, a hung request gives up.
// Plain node: node test/catalog-units.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); } };
const fresh = () => { delete require.cache[require.resolve('../providers')]; return require('../providers'); };
const file = (data) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cat-')), 'c.json'); fs.writeFileSync(f, JSON.stringify(data)); return f; };
const old = { fetchedAt: Date.now() - 3 * 24 * 3600e3, models: [{ id: 'a/b', name: 'A: B', tools: true }] };

(async () => {
  await check('offline with an old copy: the old copy', async () => {
    const P = fresh();
    const got = await P.openRouterCatalog({ cacheFile: file(old), fetchImpl: async () => { throw new Error('offline'); } });
    assert.strictEqual(got.models[0].id, 'a/b');
  });
  await check('HTTP error with an old copy: the old copy', async () => {
    const P = fresh();
    const got = await P.openRouterCatalog({ cacheFile: file(old), fetchImpl: async () => ({ ok: false, status: 503 }) });
    assert.strictEqual(got.models.length, 1);
  });
  await check('no copy at all: the error', async () => {
    const P = fresh();
    await assert.rejects(P.openRouterCatalog({ cacheFile: path.join(os.tmpdir(), `none-${Date.now()}.json`), fetchImpl: async () => ({ ok: false, status: 500 }) }));
  });
  await check('the request is given an abort signal (a hang gives up)', async () => {
    const P = fresh();
    let signal = null;
    await P.openRouterCatalog({ cacheFile: file(old), fetchImpl: async (_u, o) => { signal = o.signal; throw new Error('x'); } });
    assert.ok(signal && typeof signal.aborted === 'boolean');
  });
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})();
