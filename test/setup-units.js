// First run and default browser (features/setup.js): who sees the welcome, how it ends, and reading Windows' choice.
const assert = require('assert');
const { create, progIdIs, PROG_ID } = require('../features/setup');

function make({ fresh, settings = {} }) {
  let s = { ...settings };
  const setup = create({
    app: { isDefaultProtocolClient: () => false },
    shell: { openExternal: async () => {} },
    readSettings: () => ({ ...s }),
    writeSettings: (next) => { s = { ...next }; },
    importer: { detectBrowsers: () => [{ id: 'chrome', label: 'Chrome' }] },
    importBrowser: (id) => { if (id !== 'chrome') throw new Error('No such browser'); return { label: 'Chrome', bookmarks: 1, history: 2 }; },
    freshInstall: () => fresh,
  });
  return { setup, get: () => s };
}

(async () => {
  // A fresh install sees the welcome, and again after a quit halfway, until it's done.
  const a = make({ fresh: true });
  assert.strictEqual(a.setup.welcomePending(), true);
  assert.strictEqual(a.get().welcome, 'pending');
  assert.strictEqual(a.setup.welcomePending(), true, 'still pending on the next launch');
  a.setup.welcomeDone();
  assert.strictEqual(a.get().welcome, 'done');
  assert.strictEqual(a.setup.welcomePending(), false);

  // Someone who already used Lumen never sees it.
  const b = make({ fresh: false, settings: { model: 'x' } });
  assert.strictEqual(b.setup.welcomePending(), false);
  assert.strictEqual(b.get().welcome, undefined, 'nothing written for existing users');

  // Import answers the page (no dialog), failures included.
  assert.deepStrictEqual(await a.setup.importFrom('chrome'), { ok: true, label: 'Chrome', bookmarks: 1, history: 2 });
  assert.deepStrictEqual(await a.setup.importFrom('nope'), { ok: false, error: 'No such browser' });

  // Windows' answer to `reg query … /v ProgId`.
  const out = (id) => `\r\nHKEY_CURRENT_USER\\Software\\...\\UserChoice\r\n    ProgId    REG_SZ    ${id}\r\n\r\n`;
  assert.strictEqual(progIdIs(out(PROG_ID), PROG_ID), true);
  assert.strictEqual(progIdIs(out('ChromeHTML'), PROG_ID), false);
  assert.strictEqual(progIdIs(out(`${PROG_ID}Old`), PROG_ID), false, 'the whole value, not a prefix');
  assert.strictEqual(progIdIs(null, PROG_ID), false);

  console.log('setup units: all passed');
})().catch((err) => { console.error(err); process.exit(1); });
