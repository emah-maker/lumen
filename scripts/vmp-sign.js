// Widevine VMP-sign an unpacked Windows build directory: `node scripts/vmp-sign.js dist/win-unpacked`.
//
// The same signing scripts/after-pack.js does while packaging, run on its own for a SignPath build:
// castlabs wants VMP signing AFTER Authenticode on Windows (the .sig covers the exe's final bytes), and
// Lumen.exe is Authenticode-signed by SignPath after electron-builder's afterPack hook has run. The
// release workflow therefore sets LUMEN_DEFER_VMP=1 for the first pass and calls this once the signed
// Lumen.exe is back in the directory. Like the hook, a failure is a warning, not an error: the build
// ships without a VMP signature (production DRM may not play) rather than not at all. Pass --require to
// fail instead.
const fs = require('fs');
const path = require('path');
const { vmpSign } = require('./after-pack');

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir || !fs.existsSync(path.join(dir, 'Lumen.exe'))) {
  console.error('usage: node scripts/vmp-sign.js [--require] <win-unpacked directory containing Lumen.exe>');
  process.exit(2);
}
const signed = vmpSign(path.resolve(dir)) === true;
if (!signed && args.includes('--require')) process.exit(1);
