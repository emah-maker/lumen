// Bookmark files (features/bookmark-html.js), plain Node: Chrome, Firefox and Edge exports (test/fixtures/bookmarks/) keep their
// folders inside folders, their order (links and folders mixed) and their empty folders; export writes the tree back and a file
// round-trips; importing into bookmarks you already have merges by folder and skips what is already bookmarked. Also the
// Bookmarks page's import and export (features/managers.js) over plain stores.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../../src/features/bookmark-html');
const BB = require('../../src/features/bookmark-bar');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const J = JSON.stringify;
const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'bookmarks', name), 'utf8');
const folderOf = (t, url) => t.list.find((b) => b.url === url)?.folder;
// The whole bar as plain text, to compare two { list, layout }: "News | [Work: Mail | [Projects: ...]] | ..."
const shape = (list, layout, p = '') => BB.childrenOf(list, layout, p)
  .map((c) => (c.type === 'link' ? `${c.title}<${c.url}>` : `[${c.name}: ${shape(list, layout, c.path)}]`)).join(' | ');
const imported = (html) => { const t = H.parseNetscapeTree(html); return H.mergeImport([], null, t); };

// ---- Chrome
{
  const t = H.parseNetscapeTree(fixture('chrome.html'));
  check('chrome: a folder three levels down keeps its whole path', folderOf(t, 'https://plan.example/q1') === 'Work/Projects/2026', J(t.list));
  check('chrome: links between folders keep their folder', folderOf(t, 'https://repo.example/lumen') === 'Work/Projects' && folderOf(t, 'https://mail.example/') === 'Work');
  check('chrome: the Bookmarks bar folder is Lumen\'s bar, not a folder', folderOf(t, 'https://news.example/') === undefined && !t.folders.some((p) => /bookmarks bar/i.test(p)), J(t.folders));
  check('chrome: other bookmarks (at the file\'s root) and Mobile bookmarks go on the bar', folderOf(t, 'https://other.example/') === undefined && folderOf(t, 'https://phone.example/') === undefined && !t.folders.includes('Mobile bookmarks'));
  check('chrome: a slash in a folder name stays one level', folderOf(t, 'https://soup.example/') === 'Recipes/Soups∕Stews', folderOf(t, 'https://soup.example/'));
  check('chrome: an empty folder is listed', t.folders.includes('Work/Empty'), J(t.folders));
  check('chrome: javascript: links are dropped, entities decoded', !t.list.some((b) => /^javascript:/.test(b.url)) && t.list.some((b) => b.url === 'https://shop.example/?a=1&b=2' && b.title === 'Shop & save'));
  const m = H.mergeImport([], null, t);
  check('chrome: the bar shows the file\'s order, folders and links mixed',
    shape(m.list, m.layout) === 'News<https://news.example/> | [Work: Mail<https://mail.example/> | [Projects: [2026: Q1 plan<https://plan.example/q1>] | Repo<https://repo.example/lumen>] | [Empty: ]] | Shop & save<https://shop.example/?a=1&b=2> | Other one<https://other.example/> | [Recipes: [Soups∕Stews: Soup<https://soup.example/>]] | Phone<https://phone.example/>',
    shape(m.list, m.layout));
  check('chrome: every link is imported', m.added === 8, m.added);
}

// ---- Firefox
{
  const t = H.parseNetscapeTree(fixture('firefox.html'));
  check('firefox: nested toolbar folders keep their path', folderOf(t, 'https://repo.example/lumen') === 'Work/Projects', J(t.list));
  check('firefox: a folder of yours called "Favorites bar" deep down stays a folder', folderOf(t, 'https://deep.example/') === 'Work/Projects/Favorites bar', folderOf(t, 'https://deep.example/'));
  check('firefox: a Bookmarks Menu folder is a folder on the bar', folderOf(t, 'https://blog.example/post?id=7') === 'Reading');
  check('firefox: Other Bookmarks (UNFILED) goes on the bar', folderOf(t, 'https://misc.example/') === undefined && !t.folders.some((p) => /other/i.test(p)), J(t.folders));
  check('firefox: place: links, <HR> and <DD> descriptions are skipped', !t.list.some((b) => /^place:/.test(b.url)) && t.list.find((b) => b.url === 'https://blog.example/post?id=7')?.title === 'A <great> post', J(t.list));
  const m = H.mergeImport([], null, t);
  check('firefox: order inside a folder: folder, link',
    BB.childrenOf(m.list, m.layout, 'Work').map((c) => c.key).join(' ') === 'f:Projects u:https://mail.example/', J(BB.childrenOf(m.list, m.layout, 'Work')));
}

// ---- Edge
{
  const t = H.parseNetscapeTree(fixture('edge.html'));
  check('edge: the Favorites bar folder is Lumen\'s bar', folderOf(t, 'https://weather.example/') === undefined && !t.folders.some((p) => /favorites/i.test(p)), J(t.folders));
  check('edge: four levels of folders', folderOf(t, 'https://temples.example/kyoto') === 'Travel/Japan/Kyoto' && folderOf(t, 'https://rail.example/') === 'Travel/Japan', J(t.list));
  check('edge: folders are listed parent first', J(t.folders) === J(['Travel', 'Travel/Japan', 'Travel/Japan/Kyoto']), J(t.folders));
}

// ---- export, and round trips
for (const name of ['chrome.html', 'firefox.html', 'edge.html']) {
  const a = imported(fixture(name));
  const html = H.toNetscape(a.list, a.layout);
  const b = imported(html);
  check(`${name}: export then import gives the same bar back (order, nesting, empty folders)`, shape(a.list, a.layout) === shape(b.list, b.layout), `${shape(a.list, a.layout)}\n${shape(b.list, b.layout)}`);
  check(`${name}: export then import gives the same bookmarks back`, J(a.list) === J(b.list), J(b.list));
  check(`${name}: exporting the re-import writes the same file`, H.toNetscape(b.list, b.layout) === html);
}
{
  const a = imported(fixture('chrome.html'));
  const html = H.toNetscape(a.list, a.layout);
  check('export: a Netscape file with the bar as PERSONAL_TOOLBAR_FOLDER, as browsers write it', /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/.test(html) && /<DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar<\/H3>/.test(html), html.slice(0, 400));
  check('export: a folder inside a folder is an <H3> inside its parent\'s <DL>', /<H3>Projects<\/H3>\s*<DL><p>\s*<DT><H3>2026<\/H3>\s*<DL><p>\s*<DT><A HREF="https:\/\/plan\.example\/q1">Q1 plan<\/A>\s*<\/DL><p>/.test(html), html);
  check('export: no folder is written as a path', !/<H3>[^<]*\/[^<]*<\/H3>/.test(html), html);
  check('export: an empty folder is written', /<H3>Empty<\/H3>\s*<DL><p>\s*<\/DL><p>/.test(html), html);
  const opens = (html.match(/<DL><p>/g) || []).length; const closes = (html.match(/<\/DL><p>/g) || []).length;
  check('export: every <DL> is closed', opens === closes, `${opens} vs ${closes}`);
  check('export: without a layout, links in list order then folders, nested', /<H3>Work<\/H3>[\s\S]*<H3>Deep<\/H3>[\s\S]*c\.test/.test(H.toNetscape([{ url: 'https://c.test/', title: 'C', folder: 'Work/Deep' }, { url: 'https://a.test/', title: 'A' }])));
  check('export: escapes titles, addresses and folder names', H.toNetscape([{ url: 'https://x.test/?a=1&b=2', title: 'A & <b> "q"', folder: 'R&D' }]).includes('<H3>R&amp;D</H3>')
    && H.toNetscape([{ url: 'https://x.test/?a=1&b=2', title: 'A & <b> "q"' }]).includes('HREF="https://x.test/?a=1&amp;b=2">A &amp; &lt;b&gt; &quot;q&quot;</A>'));
}

// ---- importing into what you have
{
  const list = [{ url: 'https://mine.test/', title: 'Mine' }, { url: 'https://mail.example/', title: 'My mail' }, { url: 'https://w.test/', title: 'W', folder: 'Work' }];
  const layout = { folders: [], order: { '': ['f:Work', 'u:https://mine.test/', 'u:https://mail.example/'] } };
  const t = H.parseNetscapeTree(fixture('chrome.html'));
  const m = H.mergeImport(list, layout, t);
  check('merge: an address you already have stays where it is, with its title', m.list.filter((b) => b.url === 'https://mail.example/').length === 1 && m.list.find((b) => b.url === 'https://mail.example/').title === 'My mail' && !m.list.find((b) => b.url === 'https://mail.example/').folder);
  check('merge: the bar keeps its order, new things come after', J(BB.childrenOf(m.list, m.layout, '').slice(0, 3).map((c) => c.key)) === J(['f:Work', 'u:https://mine.test/', 'u:https://mail.example/']), J(BB.childrenOf(m.list, m.layout, '').map((c) => c.key)));
  check('merge: a folder of the same name gets the new links after its own', J(BB.childrenOf(m.list, m.layout, 'Work').map((c) => c.key)) === J(['u:https://w.test/', 'f:Projects', 'f:Empty']), J(BB.childrenOf(m.list, m.layout, 'Work').map((c) => c.key)));
  check('merge: counts only the new bookmarks', m.added === 7, m.added);
  const again = H.mergeImport(m.list, m.layout, t);
  check('merge: importing the same file twice adds nothing and changes no order', again.added === 0 && again.emptyAdded === 0 && shape(again.list, again.layout) === shape(m.list, m.layout));
  const dupOnly = H.mergeImport([{ url: 'https://soup.example/', title: 'S' }], null, H.parseNetscapeTree(fixture('chrome.html')));
  check('merge: a folder whose links you all have already is not made empty', !dupOnly.layout.folders.includes('Recipes') && !dupOnly.layout.folders.includes('Recipes/Soups∕Stews'), J(dupOnly.layout.folders));
}

// ---- odd files
{
  let deep = '<DL><p>';
  for (let i = 0; i < 40; i++) deep += `<DT><H3>L${i}</H3><DL><p>`;
  deep += '<DT><A HREF="https://bottom.test/">Bottom</A>';
  for (let i = 0; i < 40; i++) deep += '</DL><p>';
  deep += '</DL><p>';
  const t = H.parseNetscapeTree(deep);
  check('odd: a folder deeper than the bar draws is kept at the deepest level', folderOf(t, 'https://bottom.test/').split('/').length === 24, folderOf(t, 'https://bottom.test/'));
  const dup = H.parseNetscapeTree('<DL><p><DT><A HREF="https://d.test/">One</A><DT><H3>F</H3><DL><p><DT><A HREF="https://d.test/">Two</A></DL><p></DL><p>');
  check('odd: an address twice in one file is kept once, the first', dup.list.length === 1 && dup.list[0].title === 'One' && !dup.list[0].folder);
  const noRoot = H.parseNetscapeTree('<DT><H3>Loose</H3><DL><p><DT><A HREF="https://l.test/">L</A></DL><p><DT><A HREF=https://bare.test/>Bare</A>');
  check('odd: a file without the outer <DL>, and an unquoted address', folderOf(noRoot, 'https://l.test/') === 'Loose' && noRoot.list.some((b) => b.url === 'https://bare.test/'), J(noRoot.list));
  check('odd: parseNetscape still returns the plain list', J(H.parseNetscape(fixture('edge.html'))) === J(H.parseNetscapeTree(fixture('edge.html')).list));
}

// ---- the Bookmarks page: import and export through managers.js
{
  const { createManagers } = require('../../src/features/managers');
  const store = { list: [{ url: 'https://have.test/', title: 'Have' }], layout: undefined };
  const m = createManagers({
    ipcMain: { handle() {} }, dialog: {}, hostOf: (u) => new URL(u).hostname, win: () => null, tabs: () => [], alive: () => false,
    openTab() {}, switchTab() {}, bookmarks: () => store.list,
    saveBookmarks: (list, layout) => { store.list = list; if (layout) store.layout = layout; },
    bookmarkLayout: () => store.layout, bookmarksChanged() {}, readingList: () => null, readingIcon: () => '', downloads: {}, openFolder() {},
  });
  const added = m.importHtml(fixture('edge.html'));
  check('page: importing keeps the nested folders', added === 4 && store.list.find((b) => b.url === 'https://temples.example/kyoto')?.folder === 'Travel/Japan/Kyoto', J(store.list));
  check('page: importing writes the file\'s order to the bar', J(BB.childrenOf(store.list, store.layout, 'Travel/Japan').map((c) => c.key)) === J(['f:Kyoto', 'u:https://rail.example/']), J(store.layout));
  const html = m.exportHtml();
  check('page: export writes the nested folders', /<H3>Travel<\/H3>\s*<DL><p>\s*<DT><H3>Japan<\/H3>\s*<DL><p>\s*<DT><H3>Kyoto<\/H3>/.test(html), html);
  check('page: a second import of the same file adds nothing', m.importHtml(fixture('edge.html')) === 0);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
