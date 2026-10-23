// Pure unit test for the new tab page's "/" shortcut guard (features/widget-edit.js isSlashShortcut).
const WE = require('../../src/features/widget-edit');

let failed = 0;
const check = (label, ok) => { if (!ok) { failed++; console.error(`FAIL ${label}`); } else console.log(`ok   ${label}`); };

const body = { tagName: 'BODY', isContentEditable: false };
const textarea = { tagName: 'TEXTAREA' };
const input = { tagName: 'INPUT' };
const select = { tagName: 'SELECT' };
const editable = { tagName: 'DIV', isContentEditable: true };
const host = { tagName: 'MY-WIDGET', shadowRoot: { activeElement: input } };
const key = (target, extra = {}, path) => ({ key: '/', target, composedPath: () => path || [target, body], ...extra });

check('"/" on the page body focuses search', WE.isSlashShortcut(key(body), body));
check('"/" with nothing focused focuses search', WE.isSlashShortcut(key(body), null));
check('"/" in a textarea is ignored', !WE.isSlashShortcut(key(textarea), textarea));
check('"/" in an input is ignored', !WE.isSlashShortcut(key(input), input));
check('"/" in a select is ignored', !WE.isSlashShortcut(key(select), select));
check('"/" in a contenteditable is ignored', !WE.isSlashShortcut(key(editable), editable));
check('"/" in a shadow-DOM input is ignored (retargeted to the host, path has the input)', !WE.isSlashShortcut(key(host, {}, [input, host, body]), host));
check('"/" in a closed shadow root is ignored (focus chain says so)', !WE.isSlashShortcut(key(host, {}, [host, body]), host));
check('"/" in a shadow-DOM textarea found only by the path is ignored', !WE.isSlashShortcut(key({ tagName: 'X' }, {}, [textarea, { tagName: 'X' }]), body));
check('IME composition is ignored', !WE.isSlashShortcut(key(body, { isComposing: true }), body));
check('keyCode 229 is ignored', !WE.isSlashShortcut(key(body, { keyCode: 229 }), body));
for (const m of ['ctrlKey', 'metaKey', 'altKey']) check(`${m} held is ignored`, !WE.isSlashShortcut(key(body, { [m]: true }), body));
check('an already handled key is ignored', !WE.isSlashShortcut(key(body, { defaultPrevented: true }), body));
check('other keys are ignored', !WE.isSlashShortcut(key(body, { key: 'a' }), body));

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('all passed');
