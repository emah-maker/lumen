// After the Windows build: list the win zip (and its sha512) in dist/latest.yml. electron-builder
// only lists the NSIS setup there, and features/zip-update.js checks a zip update against this file.
// The updater picks the NSIS entry by extension, so the extra entry doesn't affect setup installs.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function withZip(yml, name, sha512, size) {
  if (yml.includes(`url: ${name}`)) return yml;
  const entry = `  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\n`;
  if (!/^path:/m.test(yml)) throw new Error('latest.yml has no top-level path: line');
  return yml.replace(/^path:/m, `${entry}path:`);
}

function main(dist = path.join(__dirname, '..', 'dist')) {
  const zip = fs.readdirSync(dist).find((f) => /-win-x64\.zip$/.test(f));
  if (!zip) throw new Error(`no win zip in ${dist}`);
  const file = path.join(dist, zip);
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
  const yml = path.join(dist, 'latest.yml');
  fs.writeFileSync(yml, withZip(fs.readFileSync(yml, 'utf8'), zip, sha512, fs.statSync(file).size));
  console.log(`latest.yml now lists ${zip}`);
}

if (require.main === module) main(process.argv[2]);
module.exports = { withZip };
