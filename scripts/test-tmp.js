// Shared by test-all.js, test-units.js and test-acceptance.js: every suite runs with its own TEMP folder (TEMP / TMP / TMPDIR),
// removed once the suite is over, so nothing a suite or the Lumen it launched makes in the temp folder outlives it, even when
// the suite fails, crashes or is killed on a timeout. (Before, throwaway profiles piled up in %TEMP%, each with a hard link to
// the user's real ~/.grok/auth.json.) test/_tmp-cleanup.js does the same from inside a suite for `node test/<name>.js`.
const fs = require('fs');
const os = require('os');
const path = require('path');

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch (err) { console.error(`could not remove ${dir}: ${err.message}`); }
}

// { env, done }: spread env into the suite's child env; call done() after it exits.
// (Nothing is ever removed from the shared temp folder by name: another run, or the Lumen the user is running, may own what matches. A run removes only the folder it made.)
function suiteTmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-${name.replace(/[^a-z0-9]/gi, '').slice(0, 10)}-`));
  return { env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir }, done() { removeDir(dir); } };
}

module.exports = { suiteTmp };
