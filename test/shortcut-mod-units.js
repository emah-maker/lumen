// browser/shortcut-mod.js: on macOS, Control is the text-editing key (Ctrl+A/E/P/N/F/B in text boxes) and never a Lumen shortcut.
const { shortcutMod } = require('../src/browser/shortcut-mod');

let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; };
const press = (key, mods = {}) => ({ type: 'keyDown', key, control: false, meta: false, alt: false, shift: false, ...mods });

check('macOS: Ctrl+P, Ctrl+N, Ctrl+A, Ctrl+E, Ctrl+F, Ctrl+B are not shortcuts (they move the caret)', ['p', 'n', 'a', 'e', 'f', 'b', 'k'].every((k) => !shortcutMod(press(k, { control: true }), 'darwin')));
check('macOS: Cmd+P, Cmd+N, Cmd+T are shortcuts', ['p', 'n', 't'].every((k) => shortcutMod(press(k, { meta: true }), 'darwin')));
check('macOS: Ctrl+Tab and Ctrl+Page Up/Down still switch tabs', ['Tab', 'PageUp', 'PageDown'].every((k) => shortcutMod(press(k, { control: true }), 'darwin')));
check('Windows and Linux: Ctrl+P is a shortcut', shortcutMod(press('p', { control: true }), 'win32') && shortcutMod(press('p', { control: true }), 'linux'));
check('no modifier: not a shortcut', !shortcutMod(press('p'), 'darwin') && !shortcutMod(press('p'), 'win32'));

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('all passed');
