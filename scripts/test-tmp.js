// Shared by test-all.js, test-units.js and test-acceptance.js: every suite runs with its own TEMP folder (TEMP / TMP / TMPDIR),
// removed once the suite is over, so nothing a suite or the Lumen it launched makes in the temp folder outlives it, even when
// the suite fails, crashes or is killed on a timeout. (Before, throwaway profiles piled up in %TEMP%, each with a hard link to
// the user's real ~/.grok/auth.json.) test/_tmp-cleanup.js does the same from inside a suite for `node test/<name>.js`.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Folders the suites make that an interrupted run may leave in the real temp folder, by name. Lumen's own
// temp folders (lumen-cc-*, lumen-cc1-*, lumen-usage-*, cb-ant-*, cb-import-*, the compile cache) are not matched: a Lumen
// the user is running may hold them.
const TEST_PROFILE = /^(claude-browser-test-|playwright-artifacts-|cb-(?!ant-[A-Za-z0-9]{6}$|import-)|lumen-(?!cc-|cc1-|usage-(?!test)|compile-cache|apple-music-art))/;

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch (err) { console.error(`could not remove ${dir}: ${err.message}`); }
}

// Leftovers in the real temp folder created at or after `since` that look like a test's.
function removeTestProfiles(since) {
  const tmp = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return; }
  for (const name of names) {
    if (!TEST_PROFILE.test(name)) continue;
    const dir = path.join(tmp, name);
    try { if (fs.statSync(dir).mtimeMs >= since) removeDir(dir); } catch { /* gone already */ }
  }
}

// { env, done }: spread env into the suite's child env; call done() after it exits.
function suiteTmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-${name.replace(/[^a-z0-9]/gi, '').slice(0, 10)}-`));
  const started = Date.now();
  return { env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir }, done() { removeDir(dir); removeTestProfiles(started); } };
}

module.exports = { suiteTmp, removeTestProfiles, TEST_PROFILE };
