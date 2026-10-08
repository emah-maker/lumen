// Pure unit test for features/tab-snapshots.js: the privacy exclusions, the LRU and size cap, age, clearing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/features/tab-snapshots');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) { failed++; console.error(`FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
}

// ---- who never gets a picture ----
const skip = (url, o) => S.skipReason(url, o);
check('plain page is fine', skip('https://example.com/article/1') === null);
check('http is fine', skip('http://example.com/') === null);
check('private window', skip('https://example.com/', { isPrivate: true }) === 'private');
check('research tab', skip('https://example.com/', { isolated: true }) === 'isolated');
check('Lumen page', skip('https://example.com/', { managerPage: 'chat' }) === 'internal' && skip('lumen://newtab') === 'internal' && skip('file:///C:/a.html') === 'internal' && skip('about:blank') === 'internal');
check('not an address', skip('nonsense') === 'address');
check('credentials in the address', skip('https://user:pw@example.com/') === 'credentials');
for (const u of ['https://login.example.com/', 'https://accounts.google.com/signin', 'https://secure.bank.example/x', 'https://www.paypal.com/myaccount', 'https://checkout.shop.com/', 'https://pay.example.org/', 'https://online.chase.com/', 'https://sso.corp.example.com/', 'https://bankofamerica.com/']) {
  check(`sensitive host ${u}`, /sensitive-host/.test(skip(u) || ''), String(skip(u)));
}
for (const u of ['https://example.com/login', 'https://example.com/users/sign-in', 'https://example.com/checkout/step2', 'https://example.com/account/settings', 'https://example.com/payment', 'https://example.com/oauth/authorize?x=1', 'https://example.com/reset-password']) {
  check(`sensitive path ${u}`, skip(u) === 'sensitive-path', String(skip(u)));
}
for (const u of ['https://example.com/?token=abc', 'https://example.com/cb?code=1&state=2', 'https://example.com/#access_token=zzz', 'https://example.com/x?session=1']) {
  check(`token in ${u}`, skip(u) === 'token', String(skip(u)));
}
check('a path that merely contains the word', skip('https://example.com/blog/accounting-tips') === null && skip('https://example.com/blog/login-fatigue') === null);
check('extra hosts', skip('https://mybank.example.net/', { extraHosts: ['mybank.example.net'] }) === 'sensitive-host');
check('the page probe is valid script', (() => { try { new Function(`return ${S.PAGE_PROBE}`); return true; } catch { return false; } })());

// ---- the store ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-snaps-'));
const jpeg = (n, fill = 1) => Buffer.alloc(n, fill);
try {
  let t = 1_000_000;
  const store = S.createSnapshotStore({ dir: path.join(dir, 'a'), maxBytes: 10_000, now: () => t });
  check('key ignores the fragment', store.key('https://x.com/a#1') === store.key('https://x.com/a#2') && store.key('https://x.com/a') !== store.key('https://x.com/b'));
  check('key is not the address', !store.key('https://x.com/a').includes('x.com'));
  check('put/get roundtrip', store.put('https://x.com/a', jpeg(1000, 7), { w: 960, h: 600, x: 3, y: 400 }) && (() => { const g = store.get('https://x.com/a'); return g && g.jpeg.length === 1000 && g.jpeg[0] === 7 && g.w === 960 && g.y === 400 && g.x === 3; })());
  check('peek reads the scroll without the picture', store.peek('https://x.com/a')?.y === 400 && store.peek('https://x.com/zzz') === null);
  check('has', store.has('https://x.com/a') && !store.has('https://x.com/b'));
  check('rejects empty and non-buffers', !store.put('https://x.com/e', Buffer.alloc(0)) && !store.put('https://x.com/e', 'str'));
  check('rejects one over 2 MB', !store.put('https://x.com/big', jpeg(S.MAX_ENTRY_BYTES + 1)));

  // size cap, least recently used out
  for (let i = 0; i < 6; i++) { t += 1000; store.put(`https://x.com/p${i}`, jpeg(2000, i + 1)); }
  const st = store.stats();
  check('stays under the cap', st.bytes <= 10_000, JSON.stringify(st));
  check('the oldest went', !store.has('https://x.com/p0') && !store.has('https://x.com/a'));
  check('the newest stay', store.has('https://x.com/p5') && store.has('https://x.com/p4'));

  // a read counts as a use
  const s2 = S.createSnapshotStore({ dir: path.join(dir, 'b'), maxBytes: 7000, now: () => t });
  t += 1000; s2.put('https://y.com/1', jpeg(2000));
  t += 1000; s2.put('https://y.com/2', jpeg(2000));
  t += 1000; s2.put('https://y.com/3', jpeg(2000));
  t += 1000; s2.get('https://y.com/1'); // 1 is now the most recent
  t += 1000; s2.put('https://y.com/4', jpeg(2000));
  check('LRU: the one read survives, the least recently used goes', s2.has('https://y.com/1') && !s2.has('https://y.com/2'), JSON.stringify(['1', '2', '3', '4'].map((n) => s2.has(`https://y.com/${n}`))));

  // age
  const s3 = S.createSnapshotStore({ dir: path.join(dir, 'c'), maxBytes: 1e6, maxAgeMs: 1000, now: () => t });
  s3.put('https://z.com/old', jpeg(100));
  t += 1500;
  check('too old is not shown (and is removed)', s3.get('https://z.com/old') === null && !s3.has('https://z.com/old'));
  s3.put('https://z.com/n', jpeg(100)); t += 1500; s3.put('https://z.com/m', jpeg(100)); s3.prune();
  check('prune drops the too old', !s3.has('https://z.com/n') && s3.has('https://z.com/m'));

  // forget / clear
  s3.put('https://z.com/f', jpeg(100));
  s3.forget('https://z.com/f');
  check('forget removes one', !s3.has('https://z.com/f') && s3.has('https://z.com/m'));
  const removed = s3.clear();
  check('clear removes all and the folder', removed >= 1 && s3.stats().count === 0 && !fs.existsSync(path.join(dir, 'c')));
  check('usable after a clear', s3.put('https://z.com/again', jpeg(100)) && s3.has('https://z.com/again'));
  check('get of a missing one', s3.get('https://nope.example/') === null);
  check('survives a folder that was never made', S.createSnapshotStore({ dir: path.join(dir, 'never') }).stats().count === 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('tab-snapshots units OK');
