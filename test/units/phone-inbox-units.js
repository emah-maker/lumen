// [phone files] The phone inbox (features/phone-inbox.js), plain Node in a temporary folder: names are cleaned and never
// overwrite, empty and oversized files are refused, programs are flagged risky, and on macOS a saved file is marked
// quarantined. Also: the AI's "phone" folder name (device-access.js) points at the inbox.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../../src/features/phone-inbox');
const D = require('../../src/features/device-access');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-phone-'));
const dir = path.join(root, 'Downloads', P.FOLDER);
const marks = [];
const inbox = P.createPhoneInbox({ dir, platform: 'darwin', now: () => 1_800_000_000_000, setXattr: (file, name, value) => marks.push({ file, name, value }) });

const a = inbox.save({ name: 'photo.jpg', mime: 'image/jpeg', data: Buffer.from('one') });
check('a file is saved in the inbox folder (made when missing)', a.path === path.join(dir, 'photo.jpg') && fs.readFileSync(a.path, 'utf8') === 'one');
const b = inbox.save({ name: 'photo.jpg', data: Buffer.from('two') });
const c = inbox.save({ name: 'photo.jpg', data: Buffer.from('three') });
check('the same name never overwrites: photo (2).jpg, photo (3).jpg', b.name === 'photo (2).jpg' && c.name === 'photo (3).jpg' && fs.readFileSync(a.path, 'utf8') === 'one');
const evil = inbox.save({ name: '../../etc/passwd', data: Buffer.from('x') });
check('a name with folders in it stays inside the inbox', path.dirname(evil.path) === dir && evil.name === 'passwd', evil.path);
const odd = inbox.save({ name: 'a\u0000b:c?.txt', data: Buffer.from('x') });
check('control characters and reserved marks are replaced', !/[\u0000:?]/.test(odd.name), odd.name);
const long = inbox.save({ name: `${'n'.repeat(300)}.pdf`, data: Buffer.from('x') });
check('a very long name is cut, keeping its extension', long.name.length <= 120 && long.name.endsWith('.pdf'));
check('an empty file is refused', /empty/.test(throws(() => inbox.save({ name: 'e.txt', data: Buffer.alloc(0) })) || ''));
check('a file over the limit is refused', /too big/.test(throws(() => inbox.save({ name: 'b.bin', data: Buffer.alloc(P.MAX_SAVE_BYTES + 1) })) || ''));
check('on macOS each saved file is marked quarantined', marks.length === 6 && marks.every((m) => m.name === 'com.apple.quarantine' && /^0081;[0-9a-f]+;Lumen;$/.test(m.value)), JSON.stringify(marks[0]));
const quiet = P.createPhoneInbox({ dir, platform: 'linux', setXattr: () => marks.push('x') });
quiet.save({ name: 'l.txt', data: Buffer.from('x') });
check('…and not elsewhere', marks.length === 6);

check('programs and scripts are risky; pictures and documents are not', P.isRisky('setup.exe') && P.isRisky('Run.command') && P.isRisky('x.app') && P.isRisky('a.sh') && !P.isRisky('photo.jpg') && !P.isRisky('Lease.pdf'));
check('a saved program says it is risky', inbox.save({ name: 'tool.pkg', data: Buffer.from('x') }).risky === true);
check('uniqueName counts up from 2', P.uniqueName('a.txt', (n) => ['a.txt', 'a (2).txt'].includes(n)) === 'a (3).txt');
const recent = inbox.listRecent(3);
check('listRecent: the newest first, at most the limit', recent.length === 3 && recent.every((r) => r.path.startsWith(dir)));
check('listRecent of a missing folder is empty', P.createPhoneInbox({ dir: path.join(root, 'nope') }).listRecent().length === 0);

const home = path.join(root, 'home');
check('the AI\'s "phone" folder is Downloads/From phone', D.resolvePath('phone', { home }) === path.join(home, 'Downloads', 'From phone'), D.resolvePath('phone', { home }));

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
