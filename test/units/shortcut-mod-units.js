// browser/shortcut-mod.js: on macOS, Control is the text-editing key (Ctrl+A/E/P/N/F/B in text boxes) and never a Lumen shortcut.
const { shortcutMod } = require('../../src/browser/shortcut-mod');

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; };
const press = (key, mods = {}) => ({ type: 'keyDown', key, control: false, meta: false, alt: false, shift: false, ...mods });

check('macOS: Ctrl+P, Ctrl+N, Ctrl+A, Ctrl+E, Ctrl+F, Ctrl+B are not shortcuts (they move the caret)', ['p', 'n', 'a', 'e', 'f', 'b', 'k'].every((k) => !shortcutMod(press(k, { control: true }), 'darwin')));
check('macOS: Cmd+P, Cmd+N, Cmd+T are shortcuts', ['p', 'n', 't'].every((k) => shortcutMod(press(k, { meta: true }), 'darwin')));
check('macOS: Ctrl+Tab and Ctrl+Page Up/Down still switch tabs', ['Tab', 'PageUp', 'PageDown'].every((k) => shortcutMod(press(k, { control: true }), 'darwin')));
check('Windows and Linux: Ctrl+P is a shortcut', shortcutMod(press('p', { control: true }), 'win32') && shortcutMod(press('p', { control: true }), 'linux'));
check('no modifier: not a shortcut', !shortcutMod(press('p'), 'darwin') && !shortcutMod(press('p'), 'win32'));
check('macOS: Ctrl+Shift+Tab and Ctrl+Shift+Page Up/Down are shortcuts too (shift does not change the key)', ['Tab', 'PageUp', 'PageDown'].every((k) => shortcutMod(press(k, { control: true, shift: true }), 'darwin')));
check('Windows: Ctrl+Shift+Tab and Ctrl+Shift+T are shortcuts (the key reads Tab / T, lowercased for matching)', shortcutMod(press('Tab', { control: true, shift: true }), 'win32') && shortcutMod(press('T', { control: true, shift: true }), 'win32') && 'T'.toLowerCase() === 't');
{
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  check('Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+Shift+T are one handleShortcut line each, with Shift choosing the direction', main.includes("mod && key === 'tab') cycleTab(input.shift ? -1 : 1)") && main.includes("mod && input.shift && key === 't') reopenLastClosed()"));
  check('every contents that can hold the keyboard (window UI, tabs, the Downloads panel) routes keys to handleShortcut', main.includes("downloadsView.webContents.on('before-input-event', (event, input) => handleShortcut(event, input))") && main.includes("w.webContents.on('before-input-event', (event, input) => handleShortcut(event, input))"));
}

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
