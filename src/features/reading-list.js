// The reading list ("Save for later"): pages the user set aside to read later, in <userData>/reading-list.json.
// Pure: no Electron. The file is read once, synchronously (it is small), and written in the background with a temp file and a rename,
// so a crash in the middle of a write never leaves half a file. Only what the list shows is kept: the address, the title, when it was
// saved and when it was read. Never a page's text.
//
//   create({ file, fs, now, cap, delay })
//   .add({ url, title })   -> { ok, added, item }      saving a page that is already listed puts it back on top as unread
//   .list({ filter })      -> items, newest first ('unread' hides the read ones; default 'all')
//   .has(url)  .get(url)  .unread()  .count()
//   .markRead(url, read = true) -> bool    .markAllRead() -> how many changed
//   .remove(url) -> bool   .restore(item) puts a removed item back (Undo)
//   .onChange(fn)          fn() runs after every change
//   .flush()  .flushSync()  write now (flushSync is for quitting)
// toolText(input, { store, tab, hidden }) is the AI's reading_list tool (ai/agent.js).
const nodeFs = require('fs');
const path = require('path');

const MAX_TITLE = 300;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
// The address a page is kept under: web pages only, without the #fragment (the same article is one entry).
function keyOf(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

let tmpSeq = 0; // shared by every store in the process, so two stores on one file never pick the same temp name
function create({ file, fs = nodeFs, now = () => Date.now(), cap = 1000, delay = 400 } = {}) {
  let items = []; // newest first
  let timer = null;
  let dirty = false;
  let writing = Promise.resolve();
  const listeners = new Set();

  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const seen = new Set();
    for (const e of Array.isArray(data?.items) ? data.items : []) {
      const url = keyOf(e?.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      items.push({ url, title: clean(e.title).slice(0, MAX_TITLE) || hostOf(url) || url, savedAt: num(e.savedAt), readAt: num(e.readAt) });
    }
    items.sort((a, b) => b.savedAt - a.savedAt);
  } catch (err) {
    items = [];
    if (err?.code !== 'ENOENT') { // unreadable or not JSON: keep it aside so the next write does not destroy it
      try { fs.renameSync(file, `${file}.damaged-${Date.now()}`); } catch { /* nothing to keep */ }
    }
  }

  const view = (e) => ({ ...e, host: hostOf(e.url), read: e.readAt > 0 });
  const find = (url) => { const k = keyOf(url); return k ? items.find((e) => e.url === k) : undefined; };
  const body = () => JSON.stringify({ version: 1, items: items.map(({ url, title, savedAt, readAt }) => ({ url, title, savedAt, readAt })) });

  async function writeNow() {
    clearTimeout(timer); timer = null;
    if (!dirty) { await writing; return; } // (a write already under way: flush() still waits for it to land)
    dirty = false;
    const text = body();
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    writing = writing.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(tmp, text, 'utf8');
        await fs.promises.rename(tmp, file); // atomic on one volume: a reader sees the old file or the new one, never a part
      } catch {
        dirty = true; // try again at the next change; the list in memory is still right
        await fs.promises.unlink(tmp).catch(() => {}); // (awaited: flush() resolves with no temp file left behind)
      }
    });
    await writing;
  }
  function changed() {
    dirty = true;
    for (const fn of listeners) { try { fn(); } catch { /* a listener's own error */ } }
    clearTimeout(timer);
    timer = setTimeout(() => { writeNow().catch(() => {}); }, delay);
    timer.unref?.();
  }

  const store = {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    add({ url, title } = {}) {
      const key = keyOf(url);
      if (!key) return { ok: false, added: false, error: 'Only web pages (http or https) can be saved.' };
      const name = clean(title).slice(0, MAX_TITLE);
      const had = find(key);
      if (had) { // saved again: back on top, unread, with the newer title if there is one
        items = items.filter((e) => e !== had);
        had.savedAt = now(); had.readAt = 0;
        if (name) had.title = name;
        items.unshift(had);
        changed();
        return { ok: true, added: false, item: view(had) };
      }
      const item = { url: key, title: name || hostOf(key) || key, savedAt: now(), readAt: 0 };
      items.unshift(item);
      if (items.length > cap) items = items.slice(0, cap);
      changed();
      return { ok: true, added: true, item: view(item) };
    },
    list({ filter = 'all' } = {}) { return items.filter((e) => filter !== 'unread' || !e.readAt).map(view); },
    has: (url) => Boolean(find(url)),
    get: (url) => { const e = find(url); return e ? view(e) : null; },
    unread: () => items.reduce((n, e) => n + (e.readAt ? 0 : 1), 0),
    count: () => items.length,
    markRead(url, read = true) {
      const e = find(url);
      if (!e || Boolean(e.readAt) === Boolean(read)) return false;
      e.readAt = read ? now() : 0;
      changed();
      return true;
    },
    markAllRead() {
      let n = 0;
      for (const e of items) if (!e.readAt) { e.readAt = now(); n++; }
      if (n) changed();
      return n;
    },
    remove(url) {
      const e = find(url);
      if (!e) return false;
      items = items.filter((x) => x !== e);
      changed();
      return true;
    },
    // Undo of a removal: the page goes back where its saved date puts it.
    restore(item) {
      const url = keyOf(item?.url);
      if (!url || find(url)) return false;
      items.push({ url, title: clean(item.title).slice(0, MAX_TITLE) || hostOf(url) || url, savedAt: num(item.savedAt) || now(), readAt: num(item.readAt) });
      items.sort((a, b) => b.savedAt - a.savedAt);
      changed();
      return true;
    },
    flush: () => writeNow(),
    flushSync() {
      if (!dirty) return;
      clearTimeout(timer); timer = null;
      dirty = false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
        fs.writeFileSync(tmp, body(), 'utf8');
        fs.renameSync(tmp, file);
      } catch { dirty = true; }
    },
    pending: () => dirty,
  };
  return store;
}

// ---- the AI's reading_list tool ----
// input: { action: 'save' | 'list' | 'remove', url?, all? }. tab: { url, title } of the tab the AI works in. Returns the text for the model.
const MAX_LISTED = 30;
function toolText(input, { store, tab = null, hidden = () => false } = {}) {
  const action = String(input?.action || 'list');
  if (action === 'save') {
    const url = input.url || tab?.url;
    const title = !input.url || keyOf(input.url) === keyOf(tab?.url) ? tab?.title : '';
    const r = store.add({ url, title });
    if (!r.ok) throw new Error(r.error);
    return r.added ? `Saved “${r.item.title}” to the reading list.` : `“${r.item.title}” was already on the reading list; it is back at the top, unread.`;
  }
  if (action === 'remove') {
    const url = input.url || tab?.url;
    return store.remove(url) ? 'Removed it from the reading list.' : 'That page is not on the reading list.';
  }
  if (action !== 'list') throw new Error('action is save, list or remove.');
  const all = input.all === true;
  const rows = store.list({ filter: all ? 'all' : 'unread' }).filter((e) => !hidden(e.url)); // (a site the user turned AI off on is not listed)
  if (!rows.length) return all ? 'The reading list is empty.' : 'Nothing unread on the reading list.';
  const lines = rows.slice(0, MAX_LISTED).map((e, i) => `${i + 1}. ${e.title} (${e.host})${all && e.read ? ' [read]' : ''} ${e.url}`);
  return `${rows.length} ${all ? 'saved' : 'unread'}${rows.length > MAX_LISTED ? `, first ${MAX_LISTED}` : ''}:\n${lines.join('\n')}`;
}

module.exports = { create, keyOf, hostOf, toolText, MAX_TITLE };
