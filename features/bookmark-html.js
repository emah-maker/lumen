// Bookmarks as a Netscape bookmark file (bookmarks.html): the format every browser imports and
// exports. Lumen's bookmarks are flat, each with an optional one-level folder name, so export
// writes one <H3> per folder and import flattens nested folders to their innermost name.

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unescape = (s) => String(s)
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/gi, '&');

function toNetscape(list) {
  const line = (b, indent) => `${indent}<DT><A HREF="${escape(b.url)}">${escape(b.title || b.url)}</A>`;
  const out = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  for (const b of list.filter((x) => !x.folder)) out.push(line(b, '    '));
  for (const folder of [...new Set(list.filter((x) => x.folder).map((x) => x.folder))]) {
    out.push(`    <DT><H3>${escape(folder)}</H3>`, '    <DL><p>');
    for (const b of list.filter((x) => x.folder === folder)) out.push(line(b, '        '));
    out.push('    </DL><p>');
  }
  out.push('</DL><p>', '');
  return out.join('\n');
}

// Reads <A HREF> links in order, tracking the folder stack from <H3> headings and <DL>/</DL>.
// Only http(s) links are kept (no javascript:, place:, file: …). The top-level "bookmarks bar"
// folders that browsers add are not folders the user made, so their links go to the top level.
const ROOT_FOLDERS = /^(bookmarks bar|bookmarks toolbar|favorites bar|other bookmarks|bookmarks menu|mobile bookmarks)$/i;
function parseNetscape(html) {
  const out = [];
  const stack = [];
  let pending = null; // an <H3> seen, waiting for its <DL>
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>|<a\s[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>|<dl[^>]*>|<\/dl>/gi;
  for (let m; (m = re.exec(String(html)));) {
    const tag = m[0].slice(0, 3).toLowerCase();
    if (m[1] !== undefined) pending = unescape(m[1].replace(/<[^>]*>/g, '').trim());
    else if (tag === '<dl') { stack.push(pending); pending = null; }
    else if (tag === '</d') stack.pop();
    else if (m[2] !== undefined) {
      const url = unescape((m[3] ?? m[4] ?? m[5] ?? '').trim());
      if (!/^https?:\/\//i.test(url)) continue;
      const title = unescape(m[6].replace(/<[^>]*>/g, '').trim()).replace(/\s+/g, ' ');
      const folder = [...stack].reverse().find((f) => f && !ROOT_FOLDERS.test(f)) || null;
      out.push({ url, title: title || url, ...(folder ? { folder } : {}) });
    }
  }
  return out;
}

module.exports = { toNetscape, parseNetscape };
