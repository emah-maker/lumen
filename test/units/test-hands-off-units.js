// [test background] src/test-mode.js handsOff: with LUMEN_TEST_BACKGROUND a test run must never take the foreground from the app the
// person is using. focusApp (a routine opened, a sign-in ending) called app.focus({ steal: true }), which on Windows pulled the keyboard
// and mouse into an off-screen test window. Plain Node: stand-in app and BrowserWindow. Also: scripts/test/test-all.js clears this
// checkout's leftover Electron processes after each suite, and main.js installs the guard only in a background test run.
const fs = require('fs');
const path = require('path');
const { handsOff } = require('../../src/test-mode');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

{
  const calls = [];
  const app = { focus: (o) => calls.push(['app.focus', o]) };
  class BrowserWindow {
    focus() { calls.push(['focus']); }
    moveTop() { calls.push(['moveTop']); }
    show() { calls.push(['show']); }
    showInactive() { calls.push(['showInactive']); }
  }
  check('installs with an app and BrowserWindow', handsOff({ app, BrowserWindow }) === true);
  const w = new BrowserWindow();
  app.focus({ steal: true });
  w.focus();
  w.moveTop();
  check('app.focus({ steal: true }), window focus and moveTop take nothing', calls.length === 0, JSON.stringify(calls));
  w.show();
  check('show() shows the window without activating it (showInactive)', JSON.stringify(calls) === JSON.stringify([['showInactive']]), JSON.stringify(calls));
  check('nothing happens without an app or BrowserWindow', handsOff({}) === false && handsOff({ app }) === false);
}

{
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  check('main.js installs it only in a background test run, at startup', /if \(TEST && process\.env\.LUMEN_TEST_BACKGROUND\) require\('\.\/test-mode'\)\.handsOff\(\{ app, BrowserWindow \}\)/.test(main.slice(0, 4000)));
  const all = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'test', 'test-all.js'), 'utf8');
  check('test-all.js clears leftover Electron after every Electron suite, matching only this checkout\'s node_modules/electron', /finally \{ killStrays\(\); \}/.test(all) && /'node_modules', 'electron', 'dist'/.test(all) && /StartsWith\(/.test(all));
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
