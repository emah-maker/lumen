// [desktop apps] The keys the AI may press (src/desktop/keys.js, reached through platforms.js): every refused shortcut stays refused in every
// spelling (aliases, case, spaces around "+", "-" separators, modifier order) on its own platform, and ordinary shortcuts still go through.
// The platform is pinned on purpose (backendFor('win32') / backendFor('darwin')); nothing here reads process.platform. Plain Node: nothing is sent.
require('../helpers/_tmp-cleanup');
const { backendFor } = require('../../src/desktop/platforms');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

const win = backendFor('win32');
const mac = backendFor('darwin');
const refusal = (backend, k) => { try { backend.parseKeys(k); return null; } catch (e) { return e.message; } };

// Every spelling of one chord: each modifier spelled each way x every modifier order x separator style x letter case.
const permutations = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
const CASES = [(s) => s, (s) => s.toUpperCase(), (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())];
const variants = (mods, keys) => {
  const out = new Set();
  const spelled = mods.reduce((acc, spellings) => acc.flatMap((p) => spellings.map((s) => [...p, s])), [[]]);
  for (const set of spelled) {
    for (const order of permutations(set)) {
      for (const key of keys) {
        for (const sep of ['+', ' + ', '-']) {
          for (const f of CASES) out.add(f([...order, key].join(sep)));
        }
      }
    }
  }
  return [...out];
};

const CTRL = ['ctrl', 'control'];
const ALT = ['alt', 'option', 'opt'];
const SHIFT = ['shift'];
const WINKEY = ['win', 'windows', 'super', 'meta', 'cmd', 'command'];
const CMD = ['cmd', 'command', 'meta'];
const ESC = ['esc', 'escape'];
const DEL = ['del', 'delete'];

// ---- Windows: every denylist entry, in every spelling
const WIN_DENIED = [
  ['alt+f4', [ALT], ['f4']],
  ['ctrl+alt+delete', [CTRL, ALT], DEL],
  ['ctrl+shift+esc (Task Manager)', [CTRL, SHIFT], ESC],
  ['ctrl+esc (Start menu)', [CTRL], ESC],
  ['alt+tab', [ALT], ['tab']],
  ['win+l', [WINKEY], ['l']],
  ['win+r', [WINKEY], ['r']],
  ['ctrl+win+d', [CTRL, WINKEY], ['d']],
];
for (const [label, mods, keys] of WIN_DENIED) {
  const all = variants(mods, keys);
  const leaked = all.filter((v) => !refusal(win, v));
  check(`windows: ${label} is refused in all ${all.length} spellings`, all.length >= 18 && !leaked.length, `leaked: ${leaked.slice(0, 5).join(' | ')}`);
}
// the reported bug: only the spelling "esc" was refused
check('windows: ctrl+shift+escape names the Task Manager, ctrl+escape the Start menu', /Task Manager/.test(refusal(win, 'ctrl+shift+escape')) && /Start menu/.test(refusal(win, 'ctrl+escape')));
check('windows: extra or repeated modifiers do not unlock a refused chord', ['ctrl+alt+shift+delete', 'alt+shift+f4', 'shift+ctrl+alt+Del', 'ctrl+ctrl+escape', 'ctrl+shift+alt+escape'].every((k) => refusal(win, k)));
check('windows: a refused chord inside a sequence is still refused', refusal(win, 'ctrl+a ctrl+shift+escape') && refusal(win, 'Ctrl + A  Ctrl + Shift + Escape') && refusal(win, 'enter alt-f4'));

// ---- Windows: ordinary keys still go
const send = (k) => { try { return win.parseKeys(k).seq; } catch (e) { return `ERR ${e.message}`; } };
check('windows: ctrl+c, Ctrl+Shift+T, CONTROL-v still pass', send('ctrl+c') === '^c' && send('Ctrl+Shift+T') === '^+t' && send('CONTROL-v') === '^v', [send('ctrl+c'), send('Ctrl+Shift+T'), send('CONTROL-v')].join());
check('windows: escape alone, ESC, return, del and Delete alone are allowed', send('escape') === '{ESC}' && send('ESC') === '{ESC}' && send('return') === '{ENTER}' && send('del') === '{DEL}' && send('Delete') === '{DEL}');
check('windows: only the listed chords are refused (ctrl+alt+t, ctrl+f4, f4, shift+delete, ctrl+delete pass)', send('ctrl+alt+t') === '^%t' && send('ctrl+f4') === '^{F4}' && send('f4') === '{F4}' && send('shift+delete') === '+{DEL}' && send('ctrl+delete') === '^{DEL}');
check('windows: spaces around "+" make one chord ("ctrl + s"); a space still separates keys ("ctrl+a ctrl+c")', send('ctrl + s') === '^s' && send('ctrl+a ctrl+c') === '^a^c');
check('windows: ctrl++ (zoom in) sends a literal plus, and so do Ctrl + +, ctrl+plus, shift++ and a bare +; ctrl+- and ctrl+minus send a minus', send('ctrl++') === '^{+}' && send('Ctrl + +') === '^{+}' && send('ctrl+plus') === '^{+}' && send('shift++') === '+{+}' && send('+') === '{+}' && send('ctrl+-') === '^-' && send('ctrl+minus') === '^-', [send('ctrl++'), send('Ctrl + +'), send('+')].join());
check('windows: the literal "+" is no way past the list (win++ and alt+tab-style chords with it stay refused)', refusal(win, 'win++') && refusal(win, 'cmd++') && refusal(win, 'ctrl+alt++delete'));
check('windows: nonsense is still refused (empty, "ctrl+", "ctrl+blorp", "blorp+s", fn, cmd)', refusal(win, '') && refusal(win, 'ctrl+') && refusal(win, 'ctrl+blorp') && refusal(win, 'blorp+s') && refusal(win, 'fn+a') && refusal(win, 'cmd+c'));

// ---- macOS
const MAC_DENIED = [
  ['cmd+q', [CMD], ['q']],
  ['shift+cmd+q', [CMD, SHIFT], ['q']],
  ['ctrl+cmd+q', [CMD, CTRL], ['q']],
  ['option+cmd+esc (Force Quit)', [CMD, ALT], ESC],
  ['cmd+tab', [CMD], ['tab']],
  ['cmd+`', [CMD], ['`']],
  ['cmd+space', [CMD], ['space', 'spacebar']],
  ['ctrl+space', [CTRL], ['space', 'spacebar']],
  ['ctrl+arrows (Spaces)', [CTRL], ['up', 'down', 'left', 'right']],
  ['option+cmd+d', [CMD, ALT], ['d']],
  ['fn / globe', [['fn', 'globe']], ['a']],
];
for (const [label, mods, keys] of MAC_DENIED) {
  const all = variants(mods, keys);
  const leaked = all.filter((v) => !refusal(mac, v));
  check(`mac: ${label} is refused in all ${all.length} spellings`, all.length >= 9 && !leaked.length, `leaked: ${leaked.slice(0, 5).join(' | ')}`);
}
check('mac: function keys with a modifier, and f3 / f11, are refused in every spelling', ['cmd+f1', 'ctrl+F5', 'Option-f6', 'shift+f2', 'F3', 'f11', 'F11'].every((k) => refusal(mac, k)));
check('mac: the Windows key spellings are refused (there is none; use cmd)', ['win+r', 'windows+r', 'super+r'].every((k) => /use cmd/.test(refusal(mac, k) || '')));

const code = (k) => { try { return JSON.stringify(mac.parseKeys(k).chords); } catch (e) { return `ERR ${e.message}`; } };
check('mac: cmd+c, Command+Shift+T, meta+v still pass', code('cmd+c') === '[{"mods":["command"],"key":"c"}]' && code('Command+Shift+T') === '[{"mods":["command","shift"],"key":"t"}]' && code('meta+v') === '[{"mods":["command"],"key":"v"}]', code('Command+Shift+T'));
check('mac: escape alone, return, del, f5 alone, cmd+option+i and ctrl+tab are allowed', /53/.test(code('escape')) && /36/.test(code('return')) && /117/.test(code('del')) && /96/.test(code('f5')) && !/ERR/.test(code('cmd+option+i')) && !/ERR/.test(code('ctrl+tab')));
check('mac: ctrl++ and cmd++ (zoom in) are reachable, cmd+minus sends a minus', code('ctrl++') === '[{"mods":["control"],"key":"+"}]' && code('cmd++') === '[{"mods":["command"],"key":"+"}]' && code('cmd + +') === '[{"mods":["command"],"key":"+"}]' && code('cmd+minus') === '[{"mods":["command"],"key":"-"}]');
check('mac: a refused chord inside a sequence is still refused', refusal(mac, 'cmd+a Command + Q') && refusal(mac, 'cmd+c ctrl+cmd+Q'));

// ---- both platforms read the same alias list
check('both platforms refuse the Esc chords under every spelling of Esc', ['esc', 'escape', 'ESCAPE'].every((e) => refusal(win, `ctrl+shift+${e}`) && refusal(mac, `cmd+option+${e}`)));

console.log(failures ? `\n${failures} FAILED` : '\nAll desktop key tests passed');
process.exit(failures ? 1 : 0);
