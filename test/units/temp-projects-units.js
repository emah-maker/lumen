// [temp projects] Temporary projects and the project page's views: the store's `temporary` flag (features/chat-store.js), the date a
// temporary project goes as the list says it (renderer/chat-projects.js expiresText), and the wiring in main.js (the sweep, the
// one-click create, `expires` in the list and the page), the preload, the rail and the page (the notice, Overview / Memory / Settings).
// Plain Node: the sweep itself runs in test/e2e/temp-projects.js.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createChatStore } = require('../../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

// ---- the store
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-temp-projects-'));
  const enc = (t) => Buffer.from(t).toString('base64');
  const dec = (b) => Buffer.from(b, 'base64').toString();
  let clock = 1000;
  const store = createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => ++clock });
  const p = store.saveProject({ name: 'Quick project', temporary: true });
  check('store: a project can be made temporary', p.temporary === true && store.projects()[0].temporary === true);
  const edited = store.saveProject({ id: p.id, name: 'Quick project', instructions: 'Short answers.' });
  check('store: an edit that does not name it keeps it temporary', edited.temporary === true);
  const kept = store.saveProject({ id: p.id, name: 'Quick project', temporary: false });
  check('store: Keep as project (temporary: false) makes it an ordinary project', !('temporary' in kept) && !store.projects()[0].temporary);
  const plain = store.saveProject({ name: 'Plain' });
  check('store: an ordinary project has no flag', !('temporary' in plain));
}

// ---- the date it goes
{
  const sandbox = { window: { chatTr: null }, document: {}, localStorage: { getItem: () => null, setItem() {} } };
  vm.runInNewContext(src('src/renderer/chat-projects.js'), sandbox);
  const { expiresText } = sandbox.window.chatProjects;
  const now = new Date(2026, 10, 5, 15, 0).getTime();
  check('expires: today / tomorrow / a date', expiresText(new Date(2026, 10, 5, 23, 0).getTime(), now) === 'Deleted today unless you keep it'
    && expiresText(new Date(2026, 10, 6, 1, 0).getTime(), now) === 'Deleted tomorrow unless you keep it'
    && /^Deleted .*12.* unless you keep it$/.test(expiresText(new Date(2026, 10, 12, 9, 0).getTime(), now)), expiresText(new Date(2026, 10, 12, 9, 0).getTime(), now));
  check('expires: a date already past says today', expiresText(now - 3 * 86400000, now) === 'Deleted today unless you keep it');
}

// ---- wiring
{
  const main = src('src/main.js');
  check('main: a week after last use, its newest chat counting', /const TEMP_PROJECT_MS = 7 \* 24 \* 60 \* 60 \* 1000;/.test(main) && /for \(const c of list\) if \(c\.project === p\.id && Number\(c\.updated\) > used\)/.test(main));
  check('main: the sweep deletes like Delete project, skips projects with a chat working and an index it can\'t trust', /deleteProject\(p\.id\)/.test(main) && /!busy\.has\(p\.id\)/.test(main) && /if \(!chats\(\)\.trusted\(\)\) return 0;/.test(main));
  check('main: the sweep runs soon after start and every hour on the shared scheduler', /setTimeout\(\(\) => sweepTempProjects\(\), 45000\)/.test(main) && /scheduler\.every\('temp-projects', 60 \* 60 \* 1000/.test(main));
  check('main: Delete project and the sweep share one function', /ipcMain\.handle\('chats:project-delete', \(_e, id\) => deleteProject\(String\(id\)\)\);/.test(main));
  check('main: the one-click create has no folder and a name with the day', /ipcMain\.handle\('chats:project-temp-new'/.test(main) && /saveProject\(\{ name, temporary: true \}\)/.test(main) && /Quick project, \$\{day\}/.test(main));
  check('main: the list and the page carry `expires`', /withExpiry\(withFolderState\(p\), list\)/.test(main) && /const projectPage = \(p\) => withDrive\(withLinkIcons\(withFolderState\(p\.temporary && !p\.expires \? withExpiry\(p\) : p\)\)\)/.test(main));
  check('main: the flag and temp-new handlers take (event, ...) as their only callback', /ipcMain\.handle\('chats:project-flag', \(_e, id, key, on\) =>/.test(main) && /ipcMain\.handle\('chats:project-temp-new', \(\) =>/.test(main));
  check('main: save passes `temporary` through', /typeof p\?\.temporary === 'boolean' \? \{ temporary: p\.temporary \}/.test(main));
  check('channels: on the UI list and the chat page\'s, and in the preload', /'chats:project-temp-new'/.test(main) && /'chats:project-temp-new'/.test(src('src/features/chat-page.js')) && /newTempProject: \(\) => ipcRenderer\.invoke\('chats:project-temp-new'\)/.test(src('src/features/chat-preload.js')));
  const rail = src('src/renderer/chat-projects.js');
  check('rail: a New temporary project button, a Temp mark and Keep as project in the menu', /cp-pj-temp-new/.test(rail) && /cp-pj-temp'/.test(rail) && /p\.temporary && onKeep/.test(rail));
  const pageSrc = src('src/renderer/chat-project-page.js');
  check('page: the notice for a temporary or archived project, with Keep / Move out of archive', /pjp-notice/.test(pageSrc) && /pjp-keep/.test(pageSrc) && /pjp-unarchive/.test(pageSrc));
  check('page: Overview / Memory / Settings tabs, arrow keys move between them', /\['overview', .*\['memory', .*\['settings', /.test(pageSrc) && /role', 'tablist'/.test(pageSrc) && /ArrowRight/.test(pageSrc));
  check('page: the Settings view has the project card (keep, pin, archive, export, delete) and the instructions, defaults, permissions and folder', /projectCard\(\), instructionsCard\(page\.data\), defaultsCard\(page\.data\), permissionsCard\(page\.data\), folderCard\(page\.data\)/.test(pageSrc) && ['pjp-pin', 'pjp-archive', 'pjp-delete'].every((k) => pageSrc.includes(k)));
  const chatPage = src('src/renderer/chat-page.js');
  check('chat page: the rail and the page get onTemp / onKeep / keep / flag', /onTemp: \(\) => newTempProject\(\)/.test(chatPage) && /onKeep: \(p\) => keepProject\(p\)/.test(chatPage) && /keep: \(p\) => keepProject\(p\), flag: \(p, key, on\) => flagProject\(p, key, on\)/.test(chatPage));
  const en = JSON.parse(src('src/locales/en.json'));
  check('strings: in en.json', ['projectws.temp.new', 'projectws.temp.keep', 'projectws.temp.expires', 'projectws.view.memory', 'projectws.view.settings', 'projectws.archived.note'].every((k) => typeof en[k] === 'string'));
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
