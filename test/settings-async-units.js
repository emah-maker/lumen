// The session's background save (settings-file.js writeJsonAtomicAsync). Plain node: node test/settings-async-units.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sf = require('../src/settings/settings-file');

(async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sa-')), 'settings.json');
  sf.writeJsonAtomic(file, { v: 1 });
  await sf.writeJsonAtomicAsync(file, { v: 2 });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2, 'an async write lands');
  assert.strictEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).v, 1, 'the previous good file is kept');
  await sf.writeJsonAtomicAsync(file, { v: 3 }, () => false);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2, 'a write that is no longer the latest never lands');
  assert.ok(!fs.existsSync(`${file}.tmp-async`), 'no temp file is left behind');
  const a = sf.writeJsonAtomicAsync(file, { v: 4 });
  const b = sf.writeJsonAtomicAsync(file, { v: 5 });
  await Promise.all([a, b]);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).v, 5, 'writes land in order');
  console.log('all passed');
})().catch((e) => { console.log(`FAIL  ${e.message}`); process.exit(1); });
