// Bookmarks as a Netscape bookmark file (bookmarks.html): the format every browser imports and exports.
// Lumen's folders are paths ("Work/Projects", features/bookmark-bar.js), so export writes a folder inside a folder as an <H3>
// inside the parent's <DL>, and import keeps the whole folder tree. The bar's order (settings.bookmarkLayout: links and folders
// mixed) goes out in the file's order and comes back from it, and empty folders survive both ways.
// Export puts everything in a "Bookmarks bar" folder marked PERSONAL_TOOLBAR_FOLDER, as Chrome, Edge and Firefox write theirs,
// so those browsers put it on their own bar; import takes that folder (and the browsers' other root folders) as Lumen's bar.

const BB = require('./bookmark-bar');

const MAX_DEPTH = 24; // as deep as the bar draws (bookmark-bar.js tree)

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescape = (s) => String(s)
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/gi, '&');

// `layout` (optional) is settings.bookmarkLayout: it gives the order and the empty folders.
function toNetscape(list, layout) {
  const out = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    '    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>',
    '    <DL><p>',
  ];
  const walk = (folder, depth) => {
    const indent = '    '.repeat(depth + 2);
    for (const c of BB.childrenOf(list, layout, folder)) {
      if (c.type === 'link') { out.push(`${indent}<DT><A HREF="${escape(c.url)}">${escape(c.title || c.url)}</A>`); continue; }
      out.push(`${indent}<DT><H3>${escape(c.name)}</H3>`, `${indent}<DL><p>`);
      if (depth < MAX_DEPTH) walk(c.path, depth + 1);
      out.push(`${indent}</DL><p>`);
    }
  };
  walk('', 0);
  out.push('    </DL><p>', '</DL><p>', '');
  return out.join('\n');
}

// The folders browsers keep at the top of their own tree. They are not folders the person made, so what they hold goes on
// Lumen's bar. Only at the top: a folder of the person's own called "Favorites bar" deeper down stays a folder.
const ROOT_FOLDERS = /^(bookmarks bar|bookmarks toolbar|favorites bar|favourites bar|other bookmarks|other favorites|other favourites|bookmarks menu|mobile bookmarks)$/i;
const ROOT_ATTR = /\b(PERSONAL_TOOLBAR_FOLDER|UNFILED_BOOKMARKS_FOLDER)\s*=\s*["']?true/i;

// Reads the file in order, tracking folders from <H3> headings and <DL>/</DL>. Only http(s) links are kept (no javascript:,
// place:, file: ...), each address once (the first). Returns
//   list:    [{ url, title, folder? }]   folder is a path, "Recipes/Soups"
//   folders: every folder path in the file, in order (empty ones too)
//   order:   { path: ['u:' + url | 'f:' + name, ...] }  each folder's children as the file lists them ('' is the bar)
function parseNetscapeTree(html) {
  const list = [];
  const seen = new Set();
  const folders = [];
  const order = {};
  const push = (path, key) => { const o = (order[path] ||= []); if (!o.includes(key)) o.push(key); };
  // Each open <DL> is a level: { path } where path is the Lumen folder it fills ('' for the bar), or null for the file's own root.
  const stack = [];
  let pending = null; // an <H3> seen, waiting for its <DL>: { name, root }
  const current = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i] !== null) return stack[i]; return ''; };
  const re = /<h3([^>]*)>([\s\S]*?)<\/h3>|<a\s[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>|<dl[^>]*>|<\/dl>/gi;
  for (let m; (m = re.exec(String(html)));) {
    const tag = m[0].slice(0, 3).toLowerCase();
    if (m[2] !== undefined) {
      const name = BB.cleanName(unescape(m[2].replace(/<[^>]*>/g, '')));
      const atTop = stack.every((s) => s === null);
      pending = { name, root: atTop && (ROOT_ATTR.test(m[1]) || ROOT_FOLDERS.test(name)) };
    } else if (tag === '<dl') {
      if (!pending) { stack.push(stack.length ? current() : null); continue; } // a list with no heading: the file's root, or more of the same folder
      const parent = current();
      let path;
      if (pending.root || !pending.name) path = parent;
      else if (parent.split(BB.SEP).filter(Boolean).length >= MAX_DEPTH) path = parent; // too deep: kept in the deepest folder
      else {
        path = parent ? `${parent}${BB.SEP}${pending.name}` : pending.name;
        push(parent, BB.folderKey(pending.name));
        if (!folders.includes(path)) folders.push(path);
      }
      stack.push(path);
      pending = null;
    } else if (tag === '</d') {
      stack.pop();
      pending = null;
    } else if (m[3] !== undefined) {
      const url = unescape((m[4] ?? m[5] ?? m[6] ?? '').trim());
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      const title = unescape(m[7].replace(/<[^>]*>/g, '').trim()).replace(/\s+/g, ' ');
      const folder = current();
      list.push({ url, title: title || url, ...(folder ? { folder } : {}) });
      push(folder, BB.linkKey(url));
    }
  }
  return { list, folders, order };
}

const parseNetscape = (html) => parseNetscapeTree(html).list;

// Adds what a file holds to the bookmarks and the bar's layout. An address already bookmarked stays where it is; a folder that is
// already there gets the new links (after what it had). `parsed` is parseNetscapeTree's result with addresses already checked
// (managers.js). Returns { list, layout, added } (added: how many bookmarks are new).
function mergeImport(list0, layout0, parsed) {
  const list = (Array.isArray(list0) ? list0 : []).slice();
  const layout = BB.cleanLayout(layout0);
  const known = new Set(list.map((b) => b.url));
  const had = BB.allFolders(list, layout);
  const added = new Set();
  for (const b of parsed.list) {
    if (known.has(b.url)) continue;
    known.add(b.url);
    added.add(b.url);
    list.push(b);
  }
  // A folder that is empty in the file is kept (made on the bar); one that held only links already bookmarked is not made.
  const filled = new Set();
  for (const b of parsed.list) for (let p = b.folder || ''; p; p = BB.parentOf(p)) filled.add(p);
  const empty = parsed.folders.filter((p) => !filled.has(p) && !had.has(p) && !parsed.folders.some((q) => q.startsWith(p + BB.SEP) && filled.has(q)));
  const folders = [...new Set([...layout.folders, ...empty])];
  const now = BB.allFolders(list, { ...layout, folders });
  const order = { ...layout.order };
  for (const [path, keys] of Object.entries(parsed.order)) {
    if (path && !now.has(path)) continue;
    const fresh = keys.filter((k) => (k.startsWith('u:') ? added.has(k.slice(2)) : now.has(path ? `${path}${BB.SEP}${k.slice(2)}` : k.slice(2))));
    const before = had.has(path) || path === '' ? BB.childrenOf(list0, layout0, path).map((c) => c.key) : [];
    const extra = fresh.filter((k) => !before.includes(k));
    if (extra.length) order[path] = [...before, ...extra];
  }
  return { list, layout: { folders, order }, added: added.size, emptyAdded: empty.length };
}

module.exports = { toNetscape, parseNetscape, parseNetscapeTree, mergeImport };
