// Plain Node checks for the Safe Browsing list files (features/safe-browsing.js): the big-endian
// byte swap, loading a cache written in the old format, damaged/partial files, and the atomic async save.
// No Electron. Run from test/units.js (or on its own: node test/safe-browsing-units.js).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sb = require('../src/features/safe-browsing');

module.exports = async function safeBrowsingUnits(check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sb-units-'));
  const services = [];
  try {
    // The old writer, verbatim: writeUInt32BE per element. Checksum: sha256 of those bytes, base64.
    const oldBytes = (arr) => { const b = Buffer.alloc(arr.length * 4); for (let i = 0; i < arr.length; i++) b.writeUInt32BE(arr[i], i * 4); return b; };
    const oldSum = (arr) => crypto.createHash('sha256').update(oldBytes(arr)).digest('base64');
    const sample = Uint32Array.from([0, 1, 0x01020304, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff]);

    check('sb files: bytes are big-endian and identical to the old per-element writer', Buffer.compare(sb.prefixesToBytes(sample), oldBytes(sample)) === 0);
    check('sb files: reading them back round-trips, including values over 2^31', [...sb.prefixesFromBytes(oldBytes(sample))].join() === [...sample].join());
    check('sb files: the checksum matches the old format', sb.checksum(sample) === oldSum(sample) && sb.checksum(new Uint32Array(0)) === oldSum([]));
    const view = sample.subarray(2, 5); // a view with a byte offset
    check('sb files: a typed-array view with an offset is swapped correctly (and the source is untouched)', Buffer.compare(sb.prefixesToBytes(view), oldBytes([...view])) === 0 && sample[2] === 0x01020304);
    check('sb files: a partial file (length not a multiple of 4) is rejected', sb.prefixesFromBytes(Buffer.alloc(7)) === null);
    check('sb files: an empty file is an empty list', sb.prefixesFromBytes(Buffer.alloc(0)).length === 0);
    const big = new Uint32Array(100000).map((_v, i) => (i * 2654435761) >>> 0).sort();
    check('sb files: a large list round-trips and keeps its checksum', sb.checksum(sb.prefixesFromBytes(sb.prefixesToBytes(big))) === sb.checksum(big));

    // A cache written by the old code: se-4b.bin + state.json.
    const evilHash = sb.sha256('evil.example/phish');
    const se = Uint32Array.from([evilHash.readUInt32BE(0), 5, 99999]).sort();
    const writeOld = (d) => {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'se-4b.bin'), oldBytes(se));
      fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ lastUpdate: 1234, lists: { 'se-4b': { version: 'djE=', checksum: oldSum(se), due: 0 } } }));
    };
    const settings = { safeBrowsing: true };
    const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const make = (d, extra = {}) => {
      const s = sb.createSafeBrowsing({ readSettings: () => settings, apiKey: () => 'k', dir: () => d, fetch: down, isTab: () => true, warnUrl: 'file:///w', baseUrl: 'https://sb.test', ...extra });
      services.push(s);
      return s;
    };

    const d1 = path.join(dir, 'old');
    writeOld(d1);
    let changes = 0;
    const s1 = make(d1, { onChange: () => { changes++; } });
    check('sb load: status() is instant and starts the read in the background', s1.status().entries === 0);
    await s1.ready();
    check('sb load: a cache written in the old format loads', s1.status().entries === 3 && s1.status().lastUpdate === 1234, JSON.stringify(s1.status()));
    check('sb load: onChange fires once the stored lists are in', changes >= 1, String(changes));
    check('sb load: a loaded list is used by check() (prefix hit, Google unreachable: the page loads)', (await s1.check('http://evil.example/phish')) === null);
    check('sb load: ready() is one single load every time', s1.ready() === s1.ready());

    // Damaged and partial files: ignored, never thrown.
    const flip = path.join(dir, 'flip'); writeOld(flip);
    const fb = fs.readFileSync(path.join(flip, 'se-4b.bin')); fb[0] ^= 0xff; fs.writeFileSync(path.join(flip, 'se-4b.bin'), fb);
    const cut = path.join(dir, 'cut'); writeOld(cut);
    fs.writeFileSync(path.join(cut, 'se-4b.bin'), oldBytes(se).subarray(0, 10));
    const empty = path.join(dir, 'empty'); writeOld(empty);
    fs.writeFileSync(path.join(empty, 'se-4b.bin'), '');
    const nobin = path.join(dir, 'nobin'); writeOld(nobin); fs.rmSync(path.join(nobin, 'se-4b.bin'));
    const badJson = path.join(dir, 'badjson'); writeOld(badJson); fs.writeFileSync(path.join(badJson, 'state.json'), '{"lists": {"se-4b"');
    const nullJson = path.join(dir, 'nulljson'); writeOld(nullJson); fs.writeFileSync(path.join(nullJson, 'state.json'), 'null');
    const nodir = path.join(dir, 'does-not-exist');
    for (const [label, d] of [['a flipped byte (bad checksum)', flip], ['a truncated file', cut], ['an empty file', empty], ['a missing list file', nobin], ['corrupt state.json', badJson], ['state.json that is null', nullJson], ['no folder at all', nodir]]) {
      const s = make(d);
      let threw = null;
      try { await s.ready(); await s.check('http://evil.example/phish'); } catch (e) { threw = e; }
      check(`sb load: ${label} is ignored (no throw, list empty, refetched later)`, !threw && s.status().entries === 0, threw?.stack || JSON.stringify(s.status()));
    }

    // Save: async, atomic tmp+rename, in the old on-disk format, and no .tmp left behind.
    const encode = (vals) => { // Rice-encode sorted values (first value + deltas) with k = 28, as Google does
      const k = 28; const bits = [];
      for (let i = 1; i < vals.length; i++) {
        const delta = vals[i] - vals[i - 1];
        const q = Math.floor(delta / 2 ** k); const r = delta % 2 ** k;
        for (let j = 0; j < q; j++) bits.push(1);
        bits.push(0);
        for (let j = 0; j < k; j++) bits.push(Math.floor(r / 2 ** j) % 2);
      }
      const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
      bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i & 7); });
      return { firstValue: String(vals[0]), riceParameter: k, entriesCount: vals.length - 1, encodedData: bytes.toString('base64') };
    };
    const sorted = Uint32Array.from([7, 300, 0x80000001, 0xfffffff0]);
    const listFor = (name) => (name === 'se-4b' ? { name, version: 'djI=', partialUpdate: false, additionsFourBytes: encode([...sorted]), sha256Checksum: sb.checksum(sorted), minimumWaitDuration: '1800s' } : { name, version: 'djI=', partialUpdate: false, sha256Checksum: sb.checksum(new Uint32Array(0)), minimumWaitDuration: '1800s' });
    const fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ hashLists: new URL(url).searchParams.getAll('names').map(listFor) }) });
    const d2 = path.join(dir, 'save', 'nested');
    const s2 = make(d2, { fetch });
    await s2.refresh();
    const files = fs.readdirSync(d2).sort();
    check('sb save: the lists and state are written, with no .tmp left over', files.includes('se-4b.bin') && files.includes('state.json') && !files.some((f) => f.endsWith('.tmp')), files.join());
    check('sb save: the file is the old format (big-endian prefixes), checksum in state.json', Buffer.compare(fs.readFileSync(path.join(d2, 'se-4b.bin')), oldBytes(sorted)) === 0 && JSON.parse(fs.readFileSync(path.join(d2, 'state.json'), 'utf8')).lists['se-4b'].checksum === oldSum(sorted));
    const s3 = make(d2);
    await s3.ready();
    check('sb save: a fresh service loads what was saved', s3.status().entries === 4, JSON.stringify(s3.status()));

    // A save that cannot happen (the folder's parent is a file) never throws to the caller.
    const blocker = path.join(dir, 'blocker'); fs.writeFileSync(blocker, 'x');
    const s4 = make(path.join(blocker, 'sub'), { fetch });
    let saveThrew = null;
    try { await s4.refresh(); } catch (e) { saveThrew = e; }
    check('sb save: a failing save is swallowed and the lists stay usable in memory', !saveThrew && s4.status().entries === 4, saveThrew?.stack || JSON.stringify(s4.status()));
  } finally {
    for (const s of services) s.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
};

if (require.main === module) {
  let failed = 0;
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` -- ${detail || ''}`}`); if (!ok) failed++; };
  module.exports(check).then(() => process.exit(failed ? 1 : 0), (e) => { console.error(e); process.exit(1); });
}
