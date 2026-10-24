// The files that hold secrets or a safety limit: connectors.json (sign-ins), external-apps.json (app tokens) and
// gmail-send-log.json (what the AI sent, and the 10-an-hour limit). Each is written tmp + rename, an unreadable file is
// kept (with a copy set aside) and never replaced by a start-up save, the send limit fails closed, and the send log is sealed.
// Plain Node; every folder is a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const service = require('../../src/features/connectors/service');
const { createExternalApps } = require('../../src/features/external-apps');
const { createLog, SendError } = require('../../src/features/gmail-send');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-secretstores-'));
const asides = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.corrupt-`));
const quiet = (fn) => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };
const quietAsync = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const GARBAGE = '{ not json, half writ';
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
// A crash between "temp file written" and "renamed over the real file": the real file must be untouched.
async function crashing(fn) {
  const real = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('power loss'); };
  try { return await fn(); } catch { return undefined; } finally { fs.fsyncSync = real; }
}

const fakeSecrets = { available: () => true, encrypt: (s) => `x${Buffer.from(s).reverse().toString('base64')}`, decrypt: (s) => { if (!s.startsWith('x')) throw new Error('not sealed'); return Buffer.from(s.slice(1), 'base64').reverse().toString(); } };
const noKeychain = { available: () => false, encrypt: () => { throw new Error('no keychain'); }, decrypt: () => { throw new Error('no keychain'); } };

(async () => {
  // ---- connectors.json
  {
    const dir = tmp(); const file = path.join(dir, 'connectors.json');
    let svc = service.create({ userData: dir, secrets: fakeSecrets });
    check('connectors: no file is a fresh start: nothing connected, nothing set aside', !svc.hasAny() && asides(file).length === 0 && !fs.existsSync(file));
    fs.writeFileSync(file, JSON.stringify({ version: 1, connected: { canvas: { config: { domain: 'school.instructure.com' } } } }));
    svc = service.create({ userData: dir, secrets: fakeSecrets });
    check('connectors: a good file is read back', svc.hasAny() && svc.connectedIds().includes('canvas'));
    const before = fs.readFileSync(file, 'utf8');
    await crashing(() => svc.disconnect('canvas'));
    check('connectors: a crash in the middle of a write leaves the old file whole', fs.readFileSync(file, 'utf8') === before && JSON.parse(fs.readFileSync(file, 'utf8')).connected.canvas, fs.readFileSync(file, 'utf8'));
    for (const f of leftovers(dir)) fs.rmSync(path.join(dir, f), { force: true });
    svc = service.create({ userData: dir, secrets: fakeSecrets });
    await svc.disconnect('canvas');
    check('connectors: a normal write goes through a temp file that is renamed away, and keeps the previous file as .bak', !JSON.parse(fs.readFileSync(file, 'utf8')).connected.canvas && leftovers(dir).length === 0 && fs.existsSync(`${file}.bak`));

    // unreadable
    fs.writeFileSync(file, GARBAGE);
    const signedOut = { sessionFetch: async () => new Response('', { status: 401 }), testLoopback: true, endpoints: () => ({ canvas: 'http://127.0.0.1:9' }) };
    svc = quiet(() => service.create({ userData: dir, secrets: fakeSecrets, ...signedOut }));
    check('connectors: a garbled file loads as nothing connected, but is kept and a copy is set aside', !svc.hasAny() && fs.readFileSync(file, 'utf8') === GARBAGE && asides(file).length === 1 && fs.readFileSync(path.join(dir, asides(file)[0]), 'utf8') === GARBAGE);
    quiet(() => service.create({ userData: dir, secrets: fakeSecrets }));
    check('connectors: starting again with the same bad file makes no second copy', asides(file).length === 1);
    // The user's own change may replace it (the copy is the way back).
    await svc.connect('canvas', { domain: 'school.instructure.com' }); // (signed out: saved anyway, the user signs in later)
    const after = fs.readFileSync(file, 'utf8');
    check('connectors: the user\'s own Connect then saves, and the old bytes are still in the copy', after !== GARBAGE && fs.readFileSync(path.join(dir, asides(file)[0]), 'utf8') === GARBAGE, after);
  }

  // ---- external-apps.json
  {
    const dir = tmp(); const file = path.join(dir, 'external-apps.json');
    const key = crypto.randomBytes(32);
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(s, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
      decryptString: (b) => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); },
    };
    const timers = [];
    const mk = () => createExternalApps({ file, tokenDir: path.join(dir, 'tokens'), safeStorage: storage, setTimer: (fn) => { const t = { fn, unref() {} }; timers.push(t); return t; }, clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } });
    let ext = mk();
    check('external apps: no file is a fresh start', ext.list().length === 0 && asides(file).length === 0 && !fs.existsSync(file));
    ext.add({ name: 'Cursor', app: 'cursor' });
    ext.add({ name: 'VS Code', app: 'vscode' });
    check('external apps: a write leaves no temp file and a restart reads both apps', leftovers(dir).length === 0 && mk().list().length === 2 && fs.existsSync(`${file}.bak`));
    const good = fs.readFileSync(file, 'utf8');
    quiet(() => { const real = fs.fsyncSync; fs.fsyncSync = () => { throw new Error('power loss'); }; try { ext.add({ name: 'Another', app: 'other' }); } catch { /* the add reports it */ } finally { fs.fsyncSync = real; } });
    check('external apps: a crash in the middle of a write leaves the old file whole', fs.readFileSync(file, 'utf8') === good && mk().list().length === 2);
    for (const f of leftovers(dir)) fs.rmSync(path.join(dir, f), { force: true });

    fs.writeFileSync(file, GARBAGE);
    ext = quiet(() => mk());
    check('external apps: a garbled file loads as no apps, is kept and a copy is set aside', ext.list().length === 0 && fs.readFileSync(file, 'utf8') === GARBAGE && asides(file).length === 1);
    ext.flush();
    check('external apps: the quiet "last used" save never writes over it', fs.readFileSync(file, 'utf8') === GARBAGE);
    quiet(() => mk());
    check('external apps: a second start makes no second copy', asides(file).length === 1);
    ext.add({ name: 'Cursor', app: 'cursor' });
    check('external apps: the user adding an app then saves, with the old bytes kept in the copy', fs.readFileSync(file, 'utf8') !== GARBAGE && fs.readFileSync(path.join(dir, asides(file)[0]), 'utf8') === GARBAGE && mk().list().length === 1);
  }

  // ---- gmail-send-log.json
  {
    const dir = tmp(); const file = path.join(dir, 'gmail-send-log.json');
    const clock = { t: 1_800_000_000_000 };
    const mk = (secrets = fakeSecrets) => createLog({ file, now: () => clock.t, secrets });
    let log = mk();
    check('send log: no file is a fresh start with room to send', (() => { log.room(); return log.list().length === 0 && asides(file).length === 0 && !fs.existsSync(file); })());
    for (let i = 0; i < 3; i++) log.record({ to: 'jane@x.org', subject: 'Running a bit late', via: 'card' });
    const text = fs.readFileSync(file, 'utf8');
    check('send log: the file is sealed: no address or subject in it', !/jane@x\.org|Running a bit late|"to"|"subject"/.test(text) && JSON.parse(text).version === 2 && typeof JSON.parse(text).sealed === 'string', text);
    check('send log: it reads back after a restart, so the count carries over', mk().recent() === 3 && mk().list()[0].to === 'jane@x.org');
    check('send log: a write leaves no temp file', leftovers(dir).length === 0);
    await crashing(() => log.record({ to: 'a@x.org', subject: 's', via: 'card' }));
    check('send log: a crash in the middle of a write leaves the old file whole', fs.readFileSync(file, 'utf8') === text);
    fs.writeFileSync(file, text);

    // an older plain log is read, then sealed
    const plain = JSON.stringify({ version: 1, sends: [{ at: clock.t - 1000, to: 'old@x.org', subject: 'Plain subject', via: 'card' }] });
    fs.writeFileSync(file, plain);
    log = mk();
    const migrated = fs.readFileSync(file, 'utf8');
    check('send log: an older plain log is still counted', log.recent() === 1 && log.list()[0].subject === 'Plain subject');
    check('send log: ...and is sealed in place on read (no plain text left)', !/old@x\.org|Plain subject/.test(migrated) && mk().list()[0].to === 'old@x.org', migrated);
    check('send log: ...and no plain copy is left beside it (.bak)', !fs.readdirSync(dir).some((f) => f.startsWith('gmail-send-log') && /old@x\.org|Plain subject/.test(fs.readFileSync(path.join(dir, f), 'utf8'))), fs.readdirSync(dir).join(', '));
    check('send log: no keychain: a plain log is read and not rewritten, a new send is kept in memory only', (() => { fs.writeFileSync(file, plain); const l = mk(noKeychain); l.record({ to: 'b@x.org', subject: 's', via: 'card' }); return l.recent() === 2 && fs.readFileSync(file, 'utf8') === plain; })());

    // the hourly limit
    fs.rmSync(file, { force: true });
    log = mk();
    for (let i = 0; i < 10; i++) log.record({ to: 'jane@x.org', subject: `s${i}`, via: 'card' });
    check('send log: the 11th send in the hour is refused', (() => { try { log.room(); } catch (e) { return e instanceof SendError && /at most 10 emails an hour/.test(e.message); } return false; })());
    clock.t += 3601e3;
    check('send log: an hour later there is room again', (() => { try { log.room(); return true; } catch { return false; } })());

    // unreadable: fail closed
    fs.writeFileSync(file, GARBAGE);
    log = quiet(() => mk());
    let refused = '';
    try { log.room(); } catch (e) { refused = e instanceof SendError ? e.message : ''; }
    check('send log: an unreadable log refuses to send (fails closed) with a plain message, instead of resetting the limit to zero', /can’t read its list of sent emails/.test(refused) && /Nothing was sent/.test(refused) && log.unreadable(), refused);
    check('send log: ...and a recorded send is refused too, and the file is untouched with a copy set aside', throws(() => log.record({ to: 'a@x.org', subject: 's', via: 'card' })) && fs.readFileSync(file, 'utf8') === GARBAGE && asides(file).length === 1);
    // sealed, but the keychain is gone or changed: also unreadable, also closed, also kept
    fs.rmSync(file, { force: true });
    log = mk(); log.record({ to: 'a@x.org', subject: 's', via: 'card' });
    const sealedText = fs.readFileSync(file, 'utf8');
    const wrongKey = quiet(() => mk({ available: () => true, encrypt: fakeSecrets.encrypt, decrypt: () => { throw new Error('keychain changed'); } }));
    check('send log: a sealed log that can\'t be opened fails closed and stays as it is', throws(() => wrongKey.room()) && fs.readFileSync(file, 'utf8') === sealedText);
    const noKey = quiet(() => mk(noKeychain));
    check('send log: a sealed log with no keychain at all fails closed too', throws(() => noKey.room()) && fs.readFileSync(file, 'utf8') === sealedText);
  }

  // ---- through the connector service: the send log is read with the same safe reader
  {
    const dir = tmp(); const file = path.join(dir, 'gmail-send-log.json');
    fs.writeFileSync(file, GARBAGE);
    const svc = service.create({ userData: dir, secrets: fakeSecrets });
    const rows = quiet(() => svc.sendLog());
    check('connector service: an unreadable send log lists as empty, with a copy set aside and the original kept', rows.length === 0 && asides(file).length === 1 && fs.readFileSync(file, 'utf8') === GARBAGE);
    await quietAsync(async () => {});
  }

  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
