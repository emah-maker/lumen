// The bookmarks bar's model (features/bookmark-bar.js), plain Node: folder paths and nested folders, the bar's order (links and
// folders mixed), adding and moving by drag, rename, delete, Open all, the show modes and Ctrl+Shift+B, and that the bar's
// height in the stylesheet is the one main.js insets the new-tab page by.
'use strict';
const fs = require('fs');
const path = require('path');
const BB = require('../../src/features/bookmark-bar');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const J = JSON.stringify;
const keys = (list, layout, p = '') => BB.childrenOf(list, layout, p).map((c) => c.key);

const A = 'https://a.test/', B = 'https://b.test/', C = 'https://c.test/', D = 'https://d.test/';
const list0 = [{ url: A, title: 'A' }, { url: B, title: 'B', folder: 'Work' }, { url: C, title: 'C', folder: 'Work/Deep' }, { url: D, title: 'D' }];

// paths and folders
check('cleanPath trims and joins levels', BB.cleanPath(' a / b/ ') === 'a/b');
check('a typed folder name is one level', BB.cleanName('x/y') === 'x\u2215y' && BB.cleanName('  a   b ') === 'a b');
check('every folder above a bookmark exists', J([...BB.allFolders(list0, null)].sort()) === J(['Work', 'Work/Deep']));
check('the bar: links in list order, then folders', J(keys(list0, null)) === J(['u:' + A, 'u:' + D, 'f:Work']));
check('a nested folder is a child of its parent', J(keys(list0, null, 'Work')) === J(['u:' + B, 'f:Deep']));
const t = BB.tree(list0, null, { icon: (u) => (u === A ? 'data:x' : '') });
check('tree nests folders with their children', t[2].type === 'folder' && t[2].children[1].children[0].url === C && t[0].icon === 'data:x' && t[1].icon === '');

// order
let r = BB.move(list0, null, { key: 'f:Work', to: '', index: 0 });
check('dragging a folder to the front', r.ok && J(keys(r.list, r.layout)) === J(['f:Work', 'u:' + A, 'u:' + D]), J(keys(r.list, r.layout)));
r = BB.move(r.list, r.layout, { key: 'u:' + D, to: '', index: 1 });
check('reordering a link among folders', J(keys(r.list, r.layout)) === J(['f:Work', 'u:' + D, 'u:' + A]), J(keys(r.list, r.layout)));
check('a bookmark added elsewhere comes after the ordered ones', J(keys([...r.list, { url: 'https://e.test/' }], r.layout).slice(-1)) === J(['u:https://e.test/']));

// into folders
r = BB.move(list0, null, { key: 'u:' + A, to: 'Work/Deep', index: 0 });
check('dragging a link into a nested folder', r.ok && r.list.find((b) => b.url === A).folder === 'Work/Deep' && J(keys(r.list, r.layout, 'Work/Deep')) === J(['u:' + A, 'u:' + C]));
check('...and it leaves the bar', !keys(r.list, r.layout).includes('u:' + A));
r = BB.move(r.list, r.layout, { key: 'u:' + A, to: '' });
check('dragging it back out drops its folder', !('folder' in r.list.find((b) => b.url === A)) && keys(r.list, r.layout).includes('u:' + A));

// add
r = BB.addLink(list0, null, { url: 'https://new.test/', title: 'New', index: 1 });
check('a dropped link lands where it was dropped', r.added && keys(r.list, r.layout)[1] === 'u:https://new.test/');
r = BB.addLink(r.list, r.layout, { url: B, title: 'other', index: 0 });
check('dropping an address already bookmarked moves it, no duplicate', !r.added && r.list.filter((b) => b.url === B).length === 1 && keys(r.list, r.layout)[0] === 'u:' + B && r.list.find((b) => b.url === B).title === 'B');

// folders
r = BB.newFolder(list0, null, { parent: '', name: 'Work', index: 0 });
check('a new folder with a taken name gets (2)', r.path === 'Work (2)' && keys(r.list, r.layout)[0] === 'f:Work (2)');
check('an empty folder stays', BB.allFolders(r.list, r.layout).has('Work (2)'));
r = BB.newFolder(r.list, r.layout, { parent: 'Work (2)', name: '' });
check('a folder inside a folder', r.path === 'Work (2)/New folder' && keys(r.list, r.layout, 'Work (2)')[0] === 'f:New folder');

r = BB.renameFolder(list0, BB.move(list0, null, { key: 'f:Work', to: '', index: 0 }).layout, 'Work', 'Jobs');
check('rename moves every bookmark under it', r.ok && r.list.find((b) => b.url === B).folder === 'Jobs' && r.list.find((b) => b.url === C).folder === 'Jobs/Deep');
check('...and keeps its place on the bar', keys(r.list, r.layout)[0] === 'f:Jobs', J(keys(r.list, r.layout)));
check('...and its own order', J(keys(r.list, r.layout, 'Jobs')) === J(['u:' + B, 'f:Deep']));
r = BB.move(list0, null, { key: 'f:Work', to: 'Work/Deep' });
check('a folder cannot go into itself', !r.ok && r.error === 'into-itself');
r = BB.move(list0, null, { key: 'f:Work/Deep', to: '', index: 0 });
check('a nested folder dragged onto the bar', r.ok && r.list.find((b) => b.url === C).folder === 'Deep' && keys(r.list, r.layout)[0] === 'f:Deep');

r = BB.removeFolder(list0, null, 'Work');
check('deleting a folder takes what is in it', r.ok && r.list.length === 2 && r.removed.length === 2 && !BB.allFolders(r.list, r.layout).size);

// links
r = BB.updateLink(list0, null, { url: A, newUrl: 'https://a2.test/', title: 'A2' });
check('editing a link keeps its place', r.ok && keys(r.list, r.layout)[0] === 'u:https://a2.test/' && r.list[0].title === 'A2');
check('editing to an address already bookmarked is refused', BB.updateLink(list0, null, { url: A, newUrl: B }).error === 'duplicate');
r = BB.updateLink(list0, null, { url: A, folder: 'Work' });
check('editing the folder moves it', r.list.find((b) => b.url === A).folder === 'Work' && keys(r.list, r.layout, 'Work').includes('u:' + A));
r = BB.removeLink(list0, null, D);
check('delete a link', r.ok && !r.list.some((b) => b.url === D));
check('Open all walks nested folders in order', J(BB.linksIn(list0, null, 'Work')) === J([B, C]));

// modes
check('default mode is the new-tab page only', BB.cleanMode(undefined) === 'newtab' && BB.cleanMode('junk') === 'newtab');
check('shown on the new-tab page by default', BB.shownFor('newtab', { newTab: true }) && !BB.shownFor('newtab', { newTab: false }));
check('always / never', BB.shownFor('always', {}) && !BB.shownFor('never', { newTab: true }));
check('Ctrl+Shift+B toggles always and new-tab only', BB.toggled('newtab') === 'always' && BB.toggled('always') === 'newtab' && BB.toggled('never') === 'always');
check('only new-tab-only mode insets the new-tab page', BB.newTabInset('newtab') === BB.BAR_HEIGHT && BB.newTabInset('always') === 0 && BB.newTabInset('never') === 0);
check('junk in the layout is dropped', J(BB.cleanLayout({ folders: ['a', 5, ' a '], order: { x: ['u:1', 'bad', 3] } })) === J({ folders: ['a'], order: { x: ['u:1'] } }));

// the stylesheet's height is the model's
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'bookmarks-bar.css'), 'utf8');
const m = css.match(/--bookmarks-bar-h:\s*(\d+)px/);
check('bookmarks-bar.css --bookmarks-bar-h matches BAR_HEIGHT', m && Number(m[1]) === BB.BAR_HEIGHT, m && m[1]);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
