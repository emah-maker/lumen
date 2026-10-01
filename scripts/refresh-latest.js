// After the Setup exe has been Authenticode-signed (SignPath, docs/windows-signing.md): bring the update
// info back in line with the files that will actually be published. electron-builder wrote latest.yml
// (sha512 and size of the Setup exe) and the Setup exe's .blockmap while the exe was still unsigned;
// signing appends a signature, so both are stale. Installed copies check a downloaded update against
// this sha512 (src/features/zip-update.js, electron-updater), so a stale value would reject the release.
//
// Usage: node scripts/refresh-latest.js [dist]  (run before scripts/add-zip-to-latest.js)
// Every `url:` entry whose file is in dist gets its sha512 and size recomputed, the top-level `sha512:`
// follows the file named by `path:`, and each .exe's .blockmap is rebuilt with electron-builder's own
// builder. Entries without a file in dist are left alone; `check()` reports any entry that disagrees.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha512Of = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

// Pure: yml text + a lookup for { sha512, size } by file name (or null) -> the corrected text.
function refreshYml(yml, lookup) {
  let out = yml.replace(/^( {2}- url: (.+)\n {4}sha512: ).+(\n {4}size: ).+$/gm, (whole, a, name, b) => {
    const info = lookup(name.trim());
    return info ? `${a}${info.sha512}${b}${info.size}` : whole;
  });
  const p = /^path: (.+)$/m.exec(out);
  const top = p && lookup(p[1].trim());
  if (top) out = out.replace(/^sha512: .+$/m, `sha512: ${top.sha512}`);
  return out;
}

// Names listed in the yml whose recorded sha512 or size differs from the file in dist.
function mismatches(yml, lookup) {
  const bad = [];
  for (const m of yml.matchAll(/^ {2}- url: (.+)\n {4}sha512: (.+)\n {4}size: (.+)$/gm)) {
    const info = lookup(m[1].trim());
    if (info && (info.sha512 !== m[2].trim() || String(info.size) !== m[3].trim())) bad.push(m[1].trim());
  }
  return bad;
}

const lookupIn = (dist) => (name) => {
  const file = path.join(dist, name);
  return fs.existsSync(file) ? { sha512: sha512Of(file), size: fs.statSync(file).size } : null;
};

async function main(dist = path.join(__dirname, '..', 'dist')) {
  const ymlFile = path.join(dist, 'latest.yml');
  const lookup = lookupIn(dist);
  const before = fs.readFileSync(ymlFile, 'utf8');
  const stale = mismatches(before, lookup);
  fs.writeFileSync(ymlFile, refreshYml(before, lookup));
  console.log(`latest.yml: ${stale.length ? `refreshed ${stale.join(', ')}` : 'already matched the files'}`);
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
  for (const exe of fs.readdirSync(dist).filter((f) => /\.exe$/i.test(f) && fs.existsSync(path.join(dist, `${f}.blockmap`)))) {
    await buildBlockMap(path.join(dist, exe), 'gzip', path.join(dist, `${exe}.blockmap`));
    console.log(`${exe}.blockmap rebuilt`);
  }
}

if (require.main === module) main(process.argv[2]).catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { refreshYml, mismatches };
