// The secret box (features/secret-box.js) in the real app: values saved by Lumen before Electron 45 (one keychain blob each: an
// API key in settings.json, passwords.bin, memory.json) read back on the first start after the update, before any store is
// opened; the key is sealed by the keychain in secret-box.key and the same key opens again after a restart; and the deprecated
// synchronous safeStorage calls are never used (Electron prints a deprecation line for each one it sees).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const launch = async (profile, stderr) => {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  if (stderr) app.process().stderr.on('data', (d) => stderr.push(String(d)));
  await (await app.firstWindow()).waitForSelector('.tab');
  return app;
};

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-secret-box-'));
  const stderr = [];

  // 1. Old-format values, made the way Lumen 0.5.106 and earlier wrote them (one keychain blob each; encryptStringAsync writes the
  //    same "v10" format as the old encryptString, so the suite itself needs no deprecated call).
  let app = await launch(profile);
  const made = await app.evaluate(async ({ app: electronApp, safeStorage }) => {
    const enc = async (text) => (await safeStorage.encryptStringAsync(text)).toString('base64');
    return {
      userData: electronApp.getPath('userData'),
      available: await safeStorage.isAsyncEncryptionAvailable(),
      openai: await enc('sk-openai-saved-before-the-update'),
      memory: await enc(JSON.stringify({ entries: [{ id: 'm1', text: 'Prefers metric units', kind: 'note', created: 1, updated: 1 }] })),
      passwords: await enc(JSON.stringify({ version: 1, entries: [{ id: 'p1', origin: 'https://example.com', username: 'me', password: 'hunter2' }] })),
    };
  });
  check('OS encryption is available for this test', made.available, 'unavailable');
  await app.close();
  const ud = made.userData;
  const settings = JSON.parse(fs.readFileSync(path.join(ud, 'settings.json'), 'utf8'));
  settings.keys = { ...(settings.keys || {}), openai: made.openai };
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(ud, 'memory.json'), JSON.stringify({ enc: made.memory }));
  fs.writeFileSync(path.join(ud, 'passwords.bin'), Buffer.from(made.passwords, 'base64'));
  const keyBefore = fs.readFileSync(path.join(ud, 'secret-box.key'));
  check('the first start made secret-box.key, sealed by the keychain (not the key itself)', keyBefore.subarray(0, 3).toString('latin1') === 'v10', keyBefore.subarray(0, 3));

  // 2. The next start reads them, synchronously, at once (warmed before the window opened)
  app = await launch(profile, stderr);
  const read = await app.evaluate(({ app: electronApp }) => {
    const fsm = process.mainModule.require('fs');
    const p = process.mainModule.require('path');
    const ud2 = electronApp.getPath('userData');
    const box = global.__secretBox;
    const s = JSON.parse(fsm.readFileSync(p.join(ud2, 'settings.json'), 'utf8'));
    const tryRead = (fn) => { try { return fn(); } catch (e) { return `ERR ${e.message}`; } };
    return {
      ready: box.isReady(), available: box.available(),
      openai: tryRead(() => box.decrypt(s.keys.openai)),
      memory: tryRead(() => JSON.parse(box.decrypt(JSON.parse(fsm.readFileSync(p.join(ud2, 'memory.json'), 'utf8')).enc)).entries[0].text),
      password: tryRead(() => JSON.parse(box.decrypt(fsm.readFileSync(p.join(ud2, 'passwords.bin')))).entries[0].password),
      fresh: box.encrypt('written by this version'),
    };
  });
  check('the secret box is open once the window is up', read.ready && read.available, JSON.stringify(read));
  check('an API key saved before the update reads back', read.openai === 'sk-openai-saved-before-the-update', read.openai);
  check('memory.json saved before the update reads back', read.memory === 'Prefers metric units', read.memory);
  check('passwords.bin saved before the update reads back', read.password === 'hunter2', read.password);
  check('the key file was not replaced', fs.readFileSync(path.join(ud, 'secret-box.key')).equals(keyBefore));
  await app.close();

  // 3. A restart opens the same key: what this version wrote still reads
  app = await launch(profile, stderr);
  const again = await app.evaluate((_e, enc) => { try { return global.__secretBox.decrypt(enc); } catch (e) { return `ERR ${e.message}`; } }, read.fresh);
  check('a value written by this version reads after a restart', again === 'written by this version', again);
  await app.close();

  const deprecated = stderr.join('').split(/\r?\n/).filter((l) => /safeStorage\.(encryptString|decryptString|isEncryptionAvailable)' is deprecated/.test(l));
  check('Lumen never used the deprecated synchronous safeStorage calls (no deprecation line)', deprecated.length === 0, deprecated.join(' | '));

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
