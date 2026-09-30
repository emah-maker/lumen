// A small, safe RSS 2.0 / Atom reader for the Feed headlines widget (features/widgets.js), with no
// dependencies. It is a scanner, not a full XML parser, and it is built to be fed hostile input:
//   - entities: only the five predefined ones and numeric references are decoded, once. A DOCTYPE is
//     skipped and a custom <!ENTITY> is refused outright, so nothing can expand (no billion laughs,
//     no external entities) and nothing is ever fetched.
//   - limits: input size, tag length, nesting depth, element count, items, and the length of every
//     string it returns. Work is linear in the input (no backtracking patterns on the raw text).
//   - output: plain strings and numbers. Titles have markup stripped; a link must be http(s) (a
//     relative one is resolved against the feed's own address), without credentials.
// parseFeed(xml, { base, max }) -> { title, items: [{ title, url, time }] } or throws an Error whose
// message is meant for the user.

const MAX_INPUT = 1.5e6; // characters read
const MAX_TAG = 4000; // characters in one tag
const MAX_DEPTH = 24;
const MAX_ELEMENTS = 20000;
const MAX_TEXT = 4000; // characters kept per element
const MAX_ITEMS = 50;
const TITLE_MAX = 200;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// One pass over the five predefined entities and numeric references; anything else is left as text.
function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] !== '#') return NAMED[e];
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
    return String.fromCodePoint(cp);
  });
}
// Text for display: markup removed (also markup that arrived escaped), control characters and runs
// of white space collapsed, cut to `max`.
function plain(raw, max = TITLE_MAX) {
  let s = typeof raw === 'string' ? raw : '';
  for (let pass = 0; pass < 2; pass++) {
    s = s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^<>]{0,2000}>/g, ' ');
    if (pass === 0) s = decode(s);
  }
  return decode(s).replace(/<[^<>]{0,2000}>/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---- the scanner: text -> a tree of { name, attrs, text, kids } ----
function attrsOf(s) {
  const attrs = {};
  const re = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  let n = 0;
  while ((m = re.exec(s)) && n++ < 20) attrs[m[1]] = decode(m[2] ?? m[3] ?? '');
  return attrs;
}
function scan(xml) {
  const root = { name: '#root', attrs: {}, text: '', kids: [] };
  const stack = [root];
  let elements = 0;
  let i = 0;
  const n = xml.length;
  const addText = (t) => {
    const top = stack[stack.length - 1];
    if (top.text.length < MAX_TEXT) top.text += t.slice(0, MAX_TEXT - top.text.length);
  };
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { addText(decode(xml.slice(i))); break; }
    if (lt > i) addText(decode(xml.slice(i, lt)));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      addText(xml.slice(lt + 9, end < 0 ? n : end));
      if (end < 0) break;
      i = end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) break;
      i = end + 2;
    } else if (xml.startsWith('<!', lt)) {
      // A DOCTYPE (possibly with an internal subset in [ ]). Custom entities are the way in for
      // expansion attacks, so a document that declares one is refused; the rest is skipped.
      const bracket = xml.indexOf('[', lt);
      const gt = xml.indexOf('>', lt);
      let end = gt;
      if (bracket >= 0 && (gt < 0 || bracket < gt)) {
        end = xml.indexOf(']>', bracket);
        end = end < 0 ? -1 : end + 1;
        if (end < 0) throw new Error('That isn’t a feed Lumen can read.');
      }
      const decl = xml.slice(lt, end < 0 ? n : end + 1);
      if (/<!ENTITY/i.test(decl)) throw new Error('That feed declares its own entities, which Lumen doesn’t allow.');
      if (end < 0) break;
      i = end + 1;
    } else {
      // A tag: find its closing '>' (a '>' inside a quoted attribute value doesn't count).
      let j = lt + 1;
      let quote = '';
      while (j < n && j - lt < MAX_TAG) {
        const ch = xml[j];
        if (quote) { if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === '>' || ch === '<') break; // a '<' outside quotes can't be inside a tag
        j++;
      }
      if (j >= n || xml[j] !== '>') { i = lt + 1; addText('<'); continue; } // a stray '<'
      const body = xml.slice(lt + 1, j);
      i = j + 1;
      if (body[0] === '/') {
        const name = body.slice(1).trim();
        for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
        continue;
      }
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
      if (!m) continue;
      if (++elements > MAX_ELEMENTS) throw new Error('That feed is too big.');
      const selfClosing = /\/\s*$/.test(m[2]);
      const node = { name: m[1], attrs: m[2].length > 1 ? attrsOf(m[2]) : {}, text: '', kids: [] };
      const top = stack[stack.length - 1];
      if (top.kids.length < 500) top.kids.push(node);
      if (!selfClosing) {
        if (stack.length > MAX_DEPTH) throw new Error('That feed is nested too deeply.');
        stack.push(node);
      }
    }
  }
  return root;
}

// ---- reading the tree ----
const kid = (node, name) => node.kids.find((k) => k.name === name);
const kids = (node, name) => node.kids.filter((k) => k.name === name);
const textOf = (node, name) => (kid(node, name)?.text ?? '');

// An address from a feed -> an http(s) address string, or ''. Relative addresses use `base`.
function linkUrl(value, base) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 2000 || /[\s"'<>\\\u0000-\u001f]/.test(raw)) return '';
  try {
    const u = new URL(raw, base || undefined);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname || u.username || u.password) return '';
    return u.href;
  } catch { return ''; }
}
function timeOf(value, now) {
  const t = typeof value === 'string' && value.length < 100 ? Date.parse(value.trim()) : NaN;
  // A date more than a day ahead is a wrong clock or a trick to stay on top: no time is shown.
  return Number.isFinite(t) && t > 0 && t < now + 86400e3 ? t : 0;
}
function atomLink(entry, base) {
  const links = kids(entry, 'link');
  const pick = links.find((l) => (!l.attrs.rel || l.attrs.rel === 'alternate') && (!l.attrs.type || /html/i.test(l.attrs.type))) || links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate');
  return linkUrl(pick?.attrs.href, base);
}

function parseFeed(xml, { base, max = 30, now = Date.now() } = {}) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('The feed was empty.');
  if (/^\s*(<!doctype html|<html)/i.test(xml)) throw new Error('That address is a web page, not a feed.');
  const tree = scan(xml.length > MAX_INPUT ? xml.slice(0, MAX_INPUT) : xml);
  const limit = Math.max(1, Math.min(MAX_ITEMS, Math.floor(max) || 30));
  const items = [];
  let title;
  const push = (t, url, time) => {
    const headline = plain(t);
    if (headline && items.length < limit) items.push({ title: headline, url, time });
  };
  const rss = tree.kids.find((k) => k.name === 'rss');
  const rdf = tree.kids.find((k) => k.name === 'rdf:RDF' || k.name === 'RDF');
  const atom = tree.kids.find((k) => k.name === 'feed');
  if (rss || rdf) {
    const channel = rss ? kid(rss, 'channel') : kid(rdf, 'channel');
    if (!channel && !rdf) throw new Error('That feed has no channel.');
    title = plain(channel ? textOf(channel, 'title') : '', 80);
    for (const it of (rss ? kids(channel, 'item') : kids(rdf, 'item'))) {
      let url = linkUrl(textOf(it, 'link'), base);
      if (!url) { const g = kid(it, 'guid'); if (g && g.attrs.isPermaLink !== 'false') url = linkUrl(g.text, base); }
      push(textOf(it, 'title'), url, timeOf(textOf(it, 'pubDate') || textOf(it, 'dc:date'), now));
    }
  } else if (atom) {
    title = plain(textOf(atom, 'title'), 80);
    for (const e of kids(atom, 'entry')) {
      push(textOf(e, 'title'), atomLink(e, base), timeOf(textOf(e, 'published') || textOf(e, 'updated'), now));
    }
  } else {
    throw new Error('That isn’t an RSS or Atom feed.');
  }
  if (!items.length) throw new Error('That feed has no headlines.');
  return { title, items };
}

// Well-known feeds for Settings' picker. Each address answered with a real feed when this list was
// written; the Bloomberg ones are the final address (feeds.bloomberg.com/... redirects to it).
const PRESETS = [
  { id: 'bloomberg-markets', name: 'Bloomberg Markets', url: 'https://www.bloomberg.com/feeds/markets/news.rss' },
  { id: 'bloomberg-technology', name: 'Bloomberg Technology', url: 'https://www.bloomberg.com/feeds/technology/news.rss' },
  { id: 'bloomberg-politics', name: 'Bloomberg Politics', url: 'https://www.bloomberg.com/feeds/politics/news.rss' },
  { id: 'hn', name: 'Hacker News', url: 'https://news.ycombinator.com/rss' },
  { id: 'hn-frontpage', name: 'Hacker News (hnrss.org)', url: 'https://hnrss.org/frontpage' },
  { id: 'npr', name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
];
const presetFor = (id) => PRESETS.find((p) => p.id === id) || null;

module.exports = { PRESETS, presetFor, parseFeed, plain, decode, linkUrl, MAX_INPUT, MAX_ITEMS };
