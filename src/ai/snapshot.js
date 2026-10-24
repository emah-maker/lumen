// Token-efficient browsing tools for any AI (sidebar agent, MCP clients, OpenAI/Grok/Gemini).
//
// - read_page mode:"compact": an outline of the page (headings, landmarks, text blocks with
//   inline element refs like [12]Alan Turing, and controls like [5] button "Search") instead of
//   a JSON element dump plus raw text. Refs are the same ids click/type_text/fill_form use.
// - read_page since_last:true: only the lines that changed since the previous read.
// - find: the few elements and text snippets that match a query, instead of the whole page.
// - batch: several actions (type, click, press, select, wait_for, scroll, hover) in one call,
//   followed by a short diff of what changed.
// - screenshot: smaller default size and quality, optional region crop.
//
// Page scripts are written as real functions and serialized, so they need no escaping.


// Re-reading an unchanged page costs a whole snapshot of tokens for nothing. Per tab we remember the
// last full read (URL, request shape, content fingerprint, and when); an identical read soon after
// gets one line back instead. "Soon" is a few tool calls: the API clears older tool results, and a
// model that can no longer see the earlier snapshot must get it again. Any tool that can change the
// page clears the cache, and the content itself is compared, so a stale hit can't happen.
const READ_ONLY = new Set(['find_sources', 'delegate', 'read_page', 'find', 'screenshot', 'list_tabs', 'read_urls', 'read_tabs', 'web_search', 'read_pdf', 'analyze_posts', 'get_console', 'get_network', 'video_overview', 'video_frames', 'annotate']);
const FRESH_CALLS = 6;
class ReadCache {
  // acted: how many acting tools have run (batch's baseline reuse compares it, see batch below).
  // session: the CLI session the cache belongs to; entries are keyed by it, and reset() clears them.
  // snaps: webContents id -> { url, lines, seq, acted }, the last compact read of each tab (since_last diffs, batch baselines).
  constructor() { this.tabs = new Map(); this.snaps = new Map(); this.seq = 0; this.acted = 0; this.session = ''; }
  tick(name) { this.seq++; if (!READ_ONLY.has(name)) { this.acted++; this.tabs.clear(); } }
  // A model that no longer has the earlier read in its context (new CLI process or session, rewind,
  // engine reset, expired-session handoff) must get the page again, not "unchanged".
  clear() { this.tabs.clear(); this.snaps.clear(); }
  reset(session = '') { this.clear(); this.session = String(session || ''); }
  // Returns the short reply when this read repeats the last one, else remembers it and returns null.
  check(tabId, url, shape, content) {
    const key = `${this.session}|${tabId}`;
    const prev = this.tabs.get(key);
    const fingerprint = `${content.length}:${content}`;
    const same = Boolean(prev) && prev.url === url && prev.shape === shape && prev.fingerprint === fingerprint;
    const fresh = same && this.seq - prev.seq <= FRESH_CALLS;
    this.tabs.set(key, fresh ? prev : { url, shape, fingerprint, seq: this.seq });
    if (fresh) {
      return `Unchanged since your last read (${this.seq - prev.seq} calls ago): same URL and content, and the [ids] from that read are still valid. Act on it, use find for a detail, or read_page since_last:true after acting.`;
    }
    return null;
  }
}
// One cache per chat: two chats working at once each have a model that saw only its OWN reads, so chat A must never get
// "Unchanged since your last read" (or a since_last diff) for a read only chat B made, and B's new CLI session must not reset A's.
// `chatOf()` (set by agent.js) is the calling run's conversation (its messages array); runs with none (background tasks, outside
// MCP clients) share one cache, as every caller did before.
const sharedReads = new ReadCache();
const chatReads = new WeakMap();
let chatOf = () => null;
function currentReads() {
  const chat = chatOf();
  if (!chat || typeof chat !== 'object') return sharedReads;
  let cache = chatReads.get(chat);
  if (!cache) chatReads.set(chat, (cache = new ReadCache()));
  return cache;
}
const reads = {
  get seq() { return currentReads().seq; },
  get acted() { return currentReads().acted; },
  get session() { return currentReads().session; },
  tick: (name) => currentReads().tick(name),
  check: (...args) => currentReads().check(...args),
  clear: () => currentReads().clear(),
  reset: (session) => currentReads().reset(session),
  snaps: () => currentReads().snaps,
  setChatOf: (fn) => { chatOf = typeof fn === 'function' ? fn : () => null; },
};

// ---------------------------------------------------------------- page-side functions

// Runs after read_page has built window.__claudeEls (same isolated world): outline with refs.
// opts.idBase: added to every ref (an embedded frame's ids, frames.js); opts.frame: no title line (the
// frame's label heads its lines instead).
function compactOutline(opts) {
  const reg = window.__claudeEls || [];
  const base = opts.idBase || 0;
  const idOf = new Map(reg.map((e, i) => [e.el, i + 1]));
  const ref = (id) => id + base;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // A password (or a field marked as one, even shown as text by a "show password" button): its value is never read out.
  const secretField = (el) => el.tagName === 'INPUT' && (String(el.type).toLowerCase() === 'password'
    || /password|one-time-code/i.test(el.getAttribute('autocomplete') || '') || /pass(word|wd|code)|pwd/i.test(`${el.name || ''} ${el.id || ''}`));
  const lines = [];
  const seen = new Set();
  let size = 0;
  let clipped = false;
  // Boilerplate every site repeats and no task needs: skip links, "Toggle … subsection" and "Hide Contents"
  // buttons, a bare "Main menu" / "Appearance" label. (The controls keep their refs: only the lines go.)
  const NOISE_LINE = /^(- )?(\[\d+\] (link|button) ")?(\[\d+\])?((skip|jump) to [^"]*|toggle [^"]* subsection|(hide|show) (contents|appearance|tools|sidebar|main menu)|main menu|move to sidebar|appearance)"?$/i;
  const NOISE_INLINE = / ?\[\d+\] button "(toggle [^"]* subsection|(hide|show) (contents|appearance|tools|sidebar))"/gi;
  // A nav, footer or sidebar is mostly a long list of links the task rarely needs: its first lines show, the rest is counted (the
  // refs stay valid: find reaches any of them). `cap` is the one being walked.
  const BOILER_LINES = 15;
  let cap = null;
  const push = (line) => {
    if (!line || seen.has(line) || NOISE_LINE.test(line)) return;
    if (size + line.length > opts.maxChars) { clipped = true; return; }
    if (cap) { if (cap.n >= BOILER_LINES) { cap.skipped++; return; } cap.n++; }
    seen.add(line);
    lines.push(line);
    size += line.length + 1;
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'contents') return true;
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  };
  const emitted = new Set();
  const kindOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (['checkbox', 'radio', 'range', 'date', 'time', 'color', 'file'].includes(t)) return t;
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      return t === 'search' ? 'searchbox' : 'textbox';
    }
    return el.isContentEditable ? 'textbox' : 'control';
  };
  const describe = (id, el) => {
    emitted.add(id);
    const entry = reg[id - 1];
    const label = clean(entry.label || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').slice(0, 70);
    let line = `[${ref(id)}] ${kindOf(el)} "${label}"`;
    if (el.tagName === 'SELECT') line += ` = "${clean(el.selectedOptions?.[0]?.text)}" options: ${[...el.options].slice(0, 8).map((o) => clean(o.text)).join(' | ')}`;
    else if ('value' in el && el.value && !secretField(el) && !['checkbox', 'radio', 'submit', 'button'].includes(el.type) && el.tagName !== 'BUTTON') line += ` = "${clean(el.value).slice(0, 60)}"`;
    if (el.checked) line += ' (checked)';
    if (el.disabled) line += ' (disabled)';
    if (opts.hrefs && el.tagName === 'A' && el.href) line += ` -> ${el.href.slice(0, 120)}`;
    return line;
  };
  const TEXT_BLOCKS = new Set(['P', 'LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION', 'LABEL', 'LEGEND', 'PRE']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'HEAD', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'PICTURE']);
  // Running text with inline refs: "Turing was an English [812]mathematician and …"
  const inlineOf = (nodes) => {
    let out = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out += child.nodeValue;
        else if (child.nodeType === 1 && !SKIP.has(child.tagName) && visible(child)) {
          const id = idOf.get(child);
          if (id && ['A', 'SUMMARY'].includes(child.tagName)) { emitted.add(id); out += `[${ref(id)}]${clean(child.innerText)}`; }
          else if (id) out += ` ${describe(id, child)} `;
          else walk(child);
        }
      }
    };
    for (const node of nodes) {
      if (node.nodeType === 3) out += node.nodeValue;
      else if (node.nodeType === 1 && !SKIP.has(node.tagName) && visible(node)) walk({ childNodes: [node] });
    }
    const text = clean(out.replace(NOISE_INLINE, ''));
    return text.length > opts.blockChars ? `${text.slice(0, opts.blockChars)}…` : text;
  };
  const inline = (block) => {
    if (block.tagName === 'PRE') { const t = String(block.innerText || '').trim(); return t.length > 2000 ? `${t.slice(0, 2000)}…` : t; }
    return inlineOf(block.childNodes);
  };
  const landmark = (el) => {
    const role = el.getAttribute('role');
    const map = { NAV: 'nav', MAIN: 'main', HEADER: 'header', FOOTER: 'footer', ASIDE: 'aside', FORM: 'form', DIALOG: 'dialog' };
    const name = map[el.tagName] || (['navigation', 'main', 'search', 'dialog', 'banner', 'contentinfo', 'complementary', 'form'].includes(role) ? role : null);
    if (!name) return null;
    const label = clean(el.getAttribute('aria-label') || '');
    return `[${name}${label ? `: ${label.slice(0, 40)}` : ''}]`;
  };
  // A web component's children are its open shadow root's; a slot's are the nodes assigned to it.
  const kids = (el) => {
    if (el.shadowRoot) return el.shadowRoot.children;
    if (el.tagName === 'SLOT') { const assigned = el.assignedElements({ flatten: true }); if (assigned.length) return assigned; }
    return el.children;
  };
  // A cell or list item that holds a table, list, heading or form is a layout container (Hacker News: the
  // whole page is one table cell, each story a row of a table inside it), not a text block: its own
  // text is one line, what it holds is walked as usual.
  const NESTED = 'table,ul,ol,dl,h1,h2,h3,h4,h5,h6,form';
  const CELLS = new Set(['LI', 'TD', 'TH', 'DD', 'DT']);
  const holdsStructure = (n) => n.nodeType === 1 && (n.matches(NESTED) || Boolean(n.querySelector(NESTED)));
  // The words of a cookie / consent banner are noise (its buttons keep their refs: "Accept" stays clickable).
  const CONSENT = '[id*=cookie i],[class*=cookie i],[aria-label*=cookie i],[id*=consent i],[class*=consent i],[aria-label*=consent i],[id*=gdpr i],[class*=gdpr i]';
  const inConsent = (el) => {
    try {
      const box = el.closest(CONSENT);
      return Boolean(box) && !['BODY', 'HTML', 'MAIN', 'ARTICLE'].includes(box.tagName) && String(box.innerText || '').length < 1500;
    } catch { return false; }
  };
  const visit = (child) => {
    if (clipped) return;
    if (SKIP.has(child.tagName) || !visible(child)) return;
    const id = idOf.get(child);
    if (id) { push(describe(id, child)); return; }
    const h = /^H([1-6])$/.exec(child.tagName);
    if (h) { push(`${'#'.repeat(Number(h[1]))} ${clean(child.innerText).slice(0, 120)}`); return; }
    const mark = landmark(child);
    if (mark) push(mark);
    if (mark && /^\[(nav|footer|aside|navigation|contentinfo|complementary)\b/.test(mark) && !cap) {
      cap = { n: 0, skipped: 0 };
      walk(child);
      const skipped = cap.skipped;
      cap = null;
      if (skipped) push(`… ${skipped} more lines in this ${mark.slice(1).split(/[:\]]/)[0]} (find reaches them)`);
      return;
    }
    if (TEXT_BLOCKS.has(child.tagName)) {
      if (CELLS.has(child.tagName) && !child.shadowRoot && child.querySelector(NESTED)) { mixed(child); return; }
      if (inConsent(child)) return;
      const text = inline(child);
      if (text.length > 1) push(child.tagName === 'LI' ? `- ${text}` : text);
      return;
    }
    // A div/span that holds its own text (not just other blocks) is a text block too.
    const ownText = [...child.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1);
    if (ownText && !child.shadowRoot && !child.querySelector('p,li,h1,h2,h3,h4,h5,h6,table,ul,ol,form')) {
      if (inConsent(child)) return;
      const text = inline(child);
      if (text.length > 1) push(text);
      return;
    }
    walk(child);
  };
  // The inline runs of a container cell become lines (the first of an LI is a bullet); what holds a table
  // or list is visited in its place.
  const mixed = (cell) => {
    let run = [];
    let first = true;
    const flush = () => {
      if (!run.length) return;
      const text = inlineOf(run);
      run = [];
      if (text.length > 1) { push(first && cell.tagName === 'LI' ? `- ${text}` : text); first = false; }
    };
    for (const n of cell.childNodes) {
      if (holdsStructure(n)) { flush(); visit(n); } else run.push(n);
    }
    flush();
  };
  const walk = (el) => {
    for (const child of kids(el)) visit(child);
  };
  if (!opts.frame) push(`${clean(document.title)} (${location.href.slice(0, 150)})`);
  walk(document.body || document.documentElement);
  // Controls the tree walk can't reach (shadow DOM, same-origin iframes).
  const rest = reg.map((e, i) => i + 1).filter((id) => !emitted.has(id) && reg[id - 1].el.isConnected);
  if (rest.length && !clipped) {
    push('[other controls]');
    for (const id of rest) push(describe(id, reg[id - 1].el));
  }
  if (opts.frame) return { lines, title: document.title, clipped, elements: reg.length };
  const start = Math.max(0, opts.startLine || 0);
  const shown = lines.slice(start);
  return { lines: shown, startLine: start, totalLines: lines.length, clipped, elements: reg.length };
}

// Matches for a query: controls by label, and text blocks (with nearby refs). One pass over
// text nodes, so it stays fast on very long pages.
function findMatches(opts) {
  const reg = window.__claudeEls || [];
  const base = opts.idBase || 0; // an embedded frame's ids (frames.js)
  const idOf = new Map(reg.map((e, i) => [e.el, i + 1 + base]));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const q = clean(opts.query).toLowerCase();
  const words = q.split(' ').filter(Boolean);
  // Word-start matching: "born" matches "Born" but not "Sherborne".
  const res = words.map((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}`, 'iu'));
  const phrase = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(q)}`, 'iu');
  const hit = (s) => phrase.test(s) || (words.length > 1 && res.every((re) => re.test(s)));
  const controls = [];
  reg.forEach((entry, i) => {
    const label = clean(entry.label);
    if (label && entry.el.isConnected && hit(label)) controls.push(`[${i + 1 + base}] ${entry.el.tagName.toLowerCase()}${entry.el.type && entry.el.type !== entry.el.tagName.toLowerCase() ? `:${entry.el.type}` : ''} "${label.slice(0, 80)}"`);
  });
  const BLOCK = 'p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,blockquote,figcaption,caption,label,pre,div,section,article';
  const texts = [];
  const used = new Set();
  // The document's text, then each open shadow root's (web components).
  const roots = [document.body || document.documentElement];
  const addShadows = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); addShadows(el.shadowRoot); } };
  addShadows(document);
  const nodes = function* () {
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node;
    }
  };
  const first = res[0] || phrase;
  for (const node of nodes()) {
    if (texts.length >= opts.max) break;
    if (!first.test(node.nodeValue)) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style,noscript,template') || !parent.getClientRects().length) continue;
    let block = parent.closest(BLOCK) || parent;
    // A table header or term alone ("Born") is useless without its value: widen to the row.
    if (block.tagName === 'TH' && block.parentElement) block = block.parentElement;
    let text = clean(block.innerText);
    if (block.tagName === 'DT' && block.nextElementSibling) text = `${text}: ${clean(block.nextElementSibling.innerText)}`;
    if (!hit(text) || used.has(block)) continue;
    // Link text inside a control that is already listed adds nothing.
    if (idOf.has(block) || (idOf.has(parent) && clean(parent.innerText) === text)) continue;
    used.add(block);
    const m = phrase.exec(text) || first.exec(text);
    const at = m ? m.index : 0;
    const from = Math.max(0, at - 100);
    const snippet = `${from > 0 ? '…' : ''}${text.slice(from, from + 260)}${from + 260 < text.length ? '…' : ''}`;
    const refs = [...block.querySelectorAll('*')].map((el) => idOf.get(el)).filter(Boolean).slice(0, 4);
    texts.push(`"${snippet}"${refs.length ? ` refs: ${refs.map((r) => `[${r}]`).join(' ')}` : ''}`);
  }
  // Mix both kinds so neither crowds out the other.
  const half = Math.ceil(opts.max / 2);
  const c = controls.slice(0, Math.max(half, opts.max - texts.length));
  const t = texts.slice(0, opts.max - c.length);
  return { matches: [...c, ...t], url: location.href, title: document.title };
}

// read_page extract: links or lists as JSON (what run_script was used for), optionally within a selector. Tables: extractTables below.
function extractData(opts) {
  const root = opts.selector ? document.querySelector(opts.selector) : document.body;
  if (!root) return { error: 'No element matches selector.' };
  const clean = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const shown = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const within = (sel) => [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)].filter(shown);
  let data;
  if (opts.kind === 'lists') {
    data = within('ul,ol').slice(0, 8).map((l) => [...l.children].slice(0, 40).map((li) => clean(li.innerText, 160)));
  } else {
    const seen = new Set();
    data = within('a[href]').map((a) => [clean(a.innerText || a.getAttribute('aria-label'), 100), a.href])
      .filter(([text, href]) => text && !seen.has(href) && seen.add(href)).slice(0, 80);
  }
  return { url: location.href, kind: opts.kind, data };
}

// read_page extract:"tables": every table of the page, whole. Runs in the page (serialized, async): <table> and div role="table" / "grid"
// / "treegrid" (rows role="row", cells role="cell" | "gridcell" | "columnheader" | "rowheader"), in open shadow roots and same-origin
// frames, collapsed or hidden ones too (a closed <details> or display:none section still has its text), and rows a virtualized grid
// only draws near its scroll position (the table's scroll container is stepped through, then put back). Returns every row;
// formatTables below pages them out. opts: { selector } to look inside one element.
async function extractTables(opts) {
  const MAX_TABLES = 40, MAX_ROWS = 5000, MAX_TOTAL = 20000, CELL = 300, MS = 6000;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const cut = { cells: 0, rows: false, tables: false };
  const cellText = (c) => { const t = clean(c.innerText || c.textContent); if (t.length <= CELL) return t; cut.cells++; return `${t.slice(0, CELL)}…`; };
  const TABLE = 'table,[role=table],[role=grid],[role=treegrid]';
  const CELLS = '[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]';
  const scope = opts.selector ? document.querySelector(opts.selector) : null;
  if (opts.selector && !scope) return { error: 'No element matches selector.' };
  const roots = [];
  const addRoot = (r, depth) => {
    roots.push(r);
    for (const el of r.querySelectorAll('*')) {
      if (el.shadowRoot) addRoot(el.shadowRoot, depth);
      else if ((el.tagName === 'IFRAME' || el.tagName === 'FRAME') && depth < 3) { try { const d = el.contentDocument; if (d && d.documentElement) addRoot(d, depth + 1); } catch {} }
    }
  };
  addRoot(scope || document, 0);
  const found = [];
  for (const r of roots) { if (r.matches && r.matches(TABLE)) found.push(r); found.push(...r.querySelectorAll(TABLE)); }
  const upTo = (el, sel) => { for (let n = el.parentElement; n; n = n.parentElement) if (n.matches(sel)) return n; return null; };
  const rowsOf = (t) => (t.tagName === 'TABLE' ? [...t.rows] : [...t.querySelectorAll('[role=row]')].filter((r) => upTo(r, TABLE) === t));
  const cellsOf = (r) => {
    if (r.tagName === 'TR') return [...r.cells];
    const own = [...r.querySelectorAll(CELLS)].filter((c) => upTo(c, '[role=row],tr') === r);
    return own.length ? own : [...r.children];
  };
  const isHead = (r, cells) => (r.tagName === 'TR' ? (r.parentElement && r.parentElement.tagName === 'THEAD') || cells.every((c) => c.tagName === 'TH') : cells.length > 0 && cells.every((c) => c.getAttribute('role') === 'columnheader'));
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const scrollerOf = (t) => {
    for (let n = t; n; n = n.parentElement || (n.getRootNode() && n.getRootNode().host) || null) {
      if (n.nodeType !== 1) continue;
      const s = n.ownerDocument.defaultView.getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
    }
    return null;
  };
  const headingBefore = (t) => {
    const root = t.getRootNode();
    let best = null;
    for (const h of root.querySelectorAll ? root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]') : []) { if (h.compareDocumentPosition(t) & 4) best = h; else break; }
    return best ? clean(best.innerText || best.textContent).slice(0, 100) : '';
  };
  // What is written just above the table inside the nearest container that has any text besides it ("Problem 2", "Table A-3").
  const nearText = (t) => {
    const mine = clean(t.textContent);
    const own = mine.slice(0, 40);
    let n = t;
    for (let i = 0; i < 6 && n.parentElement; i++) {
      n = n.parentElement;
      const all = clean(n.textContent);
      if (all.length > mine.length + 3) { const at = own ? all.indexOf(own) : -1; return (at > 0 ? all.slice(Math.max(0, at - 160), at) : all.slice(0, 160)).trim(); }
    }
    return '';
  };
  const out = [];
  let total = 0;
  for (const t of found) {
    if (out.length >= MAX_TABLES) { cut.tables = true; break; }
    const probe = rowsOf(t);
    if (probe.length < 2 && !t.hasAttribute('aria-rowcount')) continue; // one row: layout, not data
    const state = { items: [], seen: new Set(), header: null, started: false };
    const grab = () => {
      for (const r of rowsOf(t)) {
        if (state.items.length >= MAX_ROWS || total + state.items.length >= MAX_TOTAL) { cut.rows = true; return; }
        const cells = cellsOf(r);
        if (!cells.length) continue;
        const texts = cells.map(cellText);
        if (isHead(r, cells)) { if (!state.header) state.header = texts; continue; }
        if (!texts.some(Boolean)) continue;
        const at = r.getAttribute('aria-rowindex');
        const key = at ? `i${at}` : texts.join('\u0001');
        if (state.started && state.seen.has(key)) continue; // a later look at rows already taken (a virtualized grid draws them again)
        state.seen.add(key);
        state.items.push({ at: at ? Number(at) : null, texts });
      }
    };
    const declared = Number(t.getAttribute('aria-rowcount')) || 0;
    let sc = scrollerOf(t);
    const drawn = probe.reduce((n, r) => n + r.getBoundingClientRect().height, 0);
    const sparse = declared > probe.length + 1 || Boolean(sc && sc.scrollHeight > sc.clientHeight * 1.5 && drawn < sc.scrollHeight * 0.7);
    let scrolled = false;
    if (sparse) {
      sc = sc || t.ownerDocument.scrollingElement;
      if (sc) {
        scrolled = true;
        const home = sc.scrollTop;
        const t0 = Date.now();
        sc.scrollTop = 0;
        await wait(60);
        grab();
        state.started = true;
        for (let i = 0; i < 400 && Date.now() - t0 < MS; i++) {
          const before = sc.scrollTop;
          sc.scrollTop = before + Math.max(60, sc.clientHeight * 0.8);
          await wait(50);
          if (sc.scrollTop === before) break;
          grab();
          if (declared && state.items.length >= declared) break;
        }
        sc.scrollTop = home;
      }
    }
    if (!scrolled) grab();
    if (!state.items.length) continue;
    if (state.items.every((x) => x.at !== null)) state.items.sort((a, b) => a.at - b.at);
    total += state.items.length;
    const labelled = (t.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => { const r = t.getRootNode(); const e = r.getElementById && r.getElementById(id); return e ? clean(e.textContent) : ''; }).join(' ');
    out.push({
      caption: clean((t.caption && (t.caption.innerText || t.caption.textContent)) || t.getAttribute('aria-label') || labelled || t.title).slice(0, 120),
      heading: headingBefore(t),
      near: nearText(t),
      hidden: !(t.offsetWidth || t.offsetHeight || t.getClientRects().length) || Boolean(upTo(t, 'details:not([open])')) || (typeof t.checkVisibility === 'function' && !t.checkVisibility()),
      scrolled,
      header: state.header,
      rows: state.items.map((x) => x.texts),
    });
  }
  return { url: location.href, tables: out, cut };
}

// The text of an extractTables result: a list of the tables, then rows as a markdown table, within `budget` characters.
// A table is never cut without a line saying which rows came and the exact call for the rest (table:N text_offset:ROW).
// `table`: a number (as listed) or words from its caption, heading or the text above it; `offset`: the first row to show (0-based).
const TABLES_BUDGET = 20000;
function formatTables(result, { table, offset, budget = TABLES_BUDGET } = {}) {
  if (result?.error) return result.error;
  const tables = result?.tables || [];
  const notes = [];
  if (result?.cut?.tables) notes.push('Only the first 40 tables were read; pass selector to look inside one part of the page.');
  if (result?.cut?.rows) notes.push('Very long tables were read only up to 5000 rows each (20000 in all).');
  if (result?.cut?.cells) notes.push(`${result.cut.cells} cells held more than 300 characters; those are cut at 300.`);
  if (!tables.length) return 'No tables found on this page (looked at <table>, role="table"/"grid", shadow roots and same-origin frames; a table inside another site\'s frame cannot be read here). Try read_page mode:"full" or screenshot.';
  const labelOf = (t) => t.caption || t.heading || (t.near ? `…${t.near.slice(-60)}` : '') || '(untitled)';
  const cols = (t) => Math.max(t.header ? t.header.length : 0, ...t.rows.slice(0, 50).map((r) => r.length));
  const flags = (t) => `${t.hidden ? ' (collapsed or hidden on the page)' : ''}${t.scrolled ? ' (rows loaded by scrolling it)' : ''}`;
  const list = tables.map((t, i) => `[${i + 1}] ${labelOf(t)}: ${t.rows.length} rows x ${cols(t)} columns${flags(t)}`);
  const rowLine = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, '¦')).join(' | ')} |`;
  const from = Math.max(0, Math.floor(Number(offset)) || 0);
  let pick = null;
  if (table !== undefined && table !== null && String(table).trim() !== '') {
    const q = String(table).trim().toLowerCase();
    if (/^\d+$/.test(q)) pick = tables[Number(q) - 1] ? [Number(q) - 1] : [];
    else pick = tables.map((_, i) => i).filter((i) => `${tables[i].caption} ${tables[i].heading} ${tables[i].near}`.toLowerCase().includes(q));
    if (!pick.length) return `No table matches ${JSON.stringify(String(table).slice(0, 60))}. Tables on the page:\n${list.join('\n')}`;
  } else if (from > 0 || tables.length === 1) pick = [0];
  const show = (i, room, start) => { // one table's rows from `start` while they fit: { text, end }
    const t = tables[i];
    const lines = [];
    if (t.header) lines.push(rowLine(t.header), rowLine(t.header.map(() => '---')));
    let used = lines.join('\n').length;
    let end = start;
    while (end < t.rows.length) {
      const line = rowLine(t.rows[end]);
      if (end > start && used + line.length + 1 > room) break;
      lines.push(line);
      used += line.length + 1;
      end++;
    }
    return { text: lines.join('\n'), end };
  };
  const rest = (i, start, end) => `[table ${i + 1}: rows ${start + 1}-${end} of ${tables[i].rows.length}; call read_page extract:"tables" table:${i + 1} text_offset:${end} for the rest]`;
  const parts = [];
  if (pick) {
    const i = pick[0];
    const start = Math.min(from, tables[i].rows.length);
    const { text, end } = show(i, budget, start);
    parts.push(`Table [${i + 1}] ${labelOf(tables[i])} (${tables[i].rows.length} rows${start ? `, from row ${start + 1}` : ''})${flags(tables[i])}:`, text);
    parts.push(end < tables[i].rows.length ? rest(i, start, end) : `[end of table ${i + 1}: rows ${start + 1}-${end} of ${tables[i].rows.length}]`);
    if (pick.length > 1) parts.push(`Also matching: ${pick.slice(1).map((j) => `[${j + 1}]`).join(' ')}; use table:N.`);
    else if (tables.length > 1) parts.push(`Other tables:\n${list.filter((_, j) => j !== i).join('\n')}`);
  } else {
    parts.push(`Tables on the page:\n${list.join('\n')}`);
    let room = budget;
    const skipped = [];
    tables.forEach((t, i) => {
      if (room < 300) { skipped.push(i); return; }
      const { text, end } = show(i, room, 0);
      room -= text.length + 200;
      parts.push(`Table [${i + 1}] ${labelOf(t)}${flags(t)}:`, text);
      if (end < t.rows.length) { parts.push(rest(i, 0, end)); room = 0; }
    });
    if (skipped.length) parts.push(`Not shown, no room: ${skipped.map((j) => `[${j + 1}]`).join(' ')}; call read_page extract:"tables" table:N for each.`);
  }
  if (notes.length) parts.push(notes.join(' '));
  return parts.join('\n');
}

const serialize = (fn, arg) => `(${fn.toString()})(${JSON.stringify(arg)})`;

// ---------------------------------------------------------------- tool definitions

const READ_PAGE_EXTRA = {
  mode: { type: 'string', enum: ['compact', 'full', 'outline', 'site'] },
  structured: { type: 'boolean' }, // full: JSON-LD, meta tags, embedded data (named in the tool description)
  since_last: { type: 'boolean', description: 'compact: only changes since your last read.' },
  start_line: { type: 'integer', description: 'compact: continue a clipped outline.' },
  hrefs: { type: 'boolean', description: 'compact: add link URLs.' },
  elements: { type: 'boolean', description: 'full: list the elements.' },
  extract: { type: 'string', enum: ['tables', 'links', 'lists'] },
  selector: { type: 'string', description: 'CSS scope for extract.' },
  table: { type: 'string' }, // extract tables: one table by number or caption words (named in the tool description)
};
// Tools that can also report what changed on the page after they act (see observe).
const OBSERVE_TOOLS = new Set(['click', 'click_at', 'type_text', 'press_key']);

const SCREENSHOT_EXTRA = {
  max_width: { type: 'integer', description: 'Default 720, max 1600.' },
  quality: { type: 'integer', description: '30-90, default 60.' },
  region: {
    type: 'object',
    description: 'Crop, page CSS px (no click_at).',
    properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
    required: ['x', 'y', 'width', 'height'],
  },
};

const NEW_TOOLS = [
  {
    name: 'find',
    description: 'Find text in the active tab: [id] refs and snippets.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, max: { type: 'integer', description: 'Default 8.' } },
      required: ['query'],
    },
  },
  {
    name: 'batch',
    description: 'Several actions, stopping at a failure: type{ref,text,enter?} click{ref|text} select{ref,text} press{key,modifiers?} wait_for{text|url|gone|network_idle} scroll{direction} hover{ref}.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              do: { type: 'string', enum: ['type', 'click', 'select', 'press', 'wait_for', 'scroll', 'hover'] },
              ref: { type: 'integer' },
              text: { type: 'string' },
              url: { type: 'string' },
              gone: { type: 'string' },
              network_idle: { type: 'boolean' },
              enter: { type: 'boolean' },
              key: { type: 'string' },
              modifiers: { type: 'array', items: { type: 'string' } },
              direction: { type: 'string', enum: ['up', 'down'] },
            },
            required: ['do'],
          },
        },
      },
      required: ['steps'],
    },
  },
];

// Description overrides. The short descriptions (which already name the options added here) now live in
// agent.js's TOOLS, so there is one copy of each; read_pdf's is shared with features/pdf-text.js.
const pdfText = require('../features/pdf-text');
const { captureTab, captureJpeg } = require('../features/tab-capture');
const TRIMMED = {
  read_pdf: pdfText.READ_PDF_DESCRIPTION,
};

// Adds the new tools and options to the agent's TOOLS array (called once at load, before the
// derived tool lists are built).
function extendTools(TOOLS) {
  for (const tool of TOOLS) {
    if (tool.name === 'read_page') Object.assign(tool.input_schema.properties, READ_PAGE_EXTRA);
    if (tool.name === 'screenshot') tool.input_schema.properties = { ...tool.input_schema.properties, ...SCREENSHOT_EXTRA };
    if (TRIMMED[tool.name]) tool.description = TRIMMED[tool.name];
    const props = tool.input_schema.properties;
    if (OBSERVE_TOOLS.has(tool.name)) props.observe = { type: 'boolean' };
    if (tool.name === 'navigate') Object.assign(props, { read: { type: 'boolean' }, wait_for: { type: 'string' } });
    if (tool.name === 'open_tab') props.read = { type: 'boolean' };
  }
  TOOLS.push(...NEW_TOOLS.map((tool) => ({ ...tool, eager_input_streaming: true })));
}

// batch changes pages, so it needs the same per-site OK as click/type (and each step is checked again).
const ACTING = ['batch'];

// ---------------------------------------------------------------- execution

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const pageReading = require('./page-reading'); // mode "outline"
const frames = require('./frames');
const annotate = require('./annotate'); // shotScaleOf: what a screenshot's pixels are in page px

// read_page's registry pass alone: the same walk and labels that build window.__claudeEls (so ids
// match what click / type_text resolve), without the page's full innerText and the element list it
// returns. Cut from page-scripts.js readPage at the line that stores the registry; if that line
// ever moves, the full read runs instead. Cached per readPage source.
const REGISTRY_MARK = 'window.__claudeEls = registry;';
const registryCache = new Map(); // readPage options -> { src, script }
// opts: readPage's ({ frames: false } in a page whose embedded frames frames.js reads, and in each frame).
function registryScript(scripts, opts = {}) {
  const src = scripts.readPage(0, 0, opts);
  const key = JSON.stringify(opts);
  if (registryCache.get(key)?.src === src) return registryCache.get(key).script;
  const at = src.indexOf(REGISTRY_MARK);
  const script = at < 0 || !src.includes('accessibleName') ? src
    : `${src.slice(0, at)}${REGISTRY_MARK}
    registry.forEach((entry) => { entry.label = accessibleName(entry.el).slice(0, 80); });
    return { totalElements: registry.length };
  })()`;
  registryCache.set(key, { src, script });
  return script;
}

// dedupe: a read the model asked for itself (read_page), in the sidebar's own chat (h.dedupe): an
// identical read soon after the last one gets the short "unchanged" line (ReadCache).
async function compact(agent, wc, input, h, { dedupe = false } = {}) {
  const inFrames = frames.available(wc); // embedded frames are outlined each in its own frame (below)
  await h.runScript(wc, registryScript(h.scripts, { frames: !inFrames })); // builds the element registry the refs point into
  const result = await h.runScript(wc, serialize(compactOutline, {
    maxChars: Math.min(Math.max(Number(input.max_chars) || DEFAULT_OUTLINE_CHARS, 1000), 20000),
    blockChars: 280,
    startLine: input.start_line || 0,
    hrefs: Boolean(input.hrefs),
  }), 15000);
  if (inFrames && !input.start_line) result.lines.push(...await frameOutlines(agent, wc, input, h));
  const url = wc.getURL();
  const snaps = reads.snaps();
  const previous = snaps.get(wc.id);
  snaps.set(wc.id, { url, lines: result.lines, seq: reads.seq, acted: reads.acted });
  let body;
  if (input.since_last && previous && previous.url === url) {
    const before = new Set(previous.lines);
    const after = new Set(result.lines);
    const added = result.lines.filter((l) => !before.has(l));
    const removed = previous.lines.filter((l) => !after.has(l)).length;
    const shownAdded = added.length > DIFF_LINES ? [...added.slice(0, DIFF_LINES), `… ${added.length - DIFF_LINES} more added lines (read_page or find)`] : added;
    body = added.length || removed
      ? `Changes since your last read (+${added.length} / -${removed} lines):\n${shownAdded.join('\n')}`
      : 'No changes since your last read.';
  } else if (input.head) {
    // After navigate / open_tab: the title, URL and the top of the page, enough to see where it landed.
    body = input.noTitle ? pageHead(result.lines.slice(1), result.totalLines - 1, result.clipped) : pageHead(result.lines, result.totalLines, result.clipped);
  } else if (input.summary) {
    // After a batch lands on a new page: just its top, the model can read more if it needs to.
    body = `Now on a new page:\n${result.lines.slice(0, 12).join('\n')}\n… (${result.totalLines} lines; use find or read_page mode:"compact")`;
  } else {
    body = `${input.since_last && previous ? '(new page)\n' : ''}${(input.noTitle ? result.lines.slice(1) : result.lines).join('\n')}`;
    if (result.clipped) body += `\n… outline clipped at ${result.totalLines} lines (${result.elements} controls). Use find, or start_line:${result.startLine + result.lines.length}.`;
    const same = dedupe && !input.since_last && h.dedupe?.() ? reads.check(wc.id, url, `c|${input.start_line || 0}|${Boolean(input.hrefs)}`, body) : null;
    if (same) body = same;
  }
  return `<untrusted_page_content>\n${body}\n</untrusted_page_content>`;
}

// The first ~600 characters of an outline (whole lines), with a pointer to the rest.
const HEAD_CHARS = 600;
const DEFAULT_OUTLINE_CHARS = 4000; // a compact read's default cap (~1,000 tokens); a clipped outline says how to continue (start_line) and find reaches the rest
const DIFF_LINES = 25; // a diff longer than this lists its first lines and counts the rest
function pageHead(lines, total, clipped = false) {
  const out = [];
  let size = 0;
  for (const line of lines) {
    if (out.length && size + line.length + 1 > HEAD_CHARS) break;
    out.push(line.length > HEAD_CHARS ? `${line.slice(0, HEAD_CHARS)}…` : line);
    size += line.length + 1;
  }
  const more = out.length < total || clipped;
  return `${out.join('\n')}${more ? '\n… (more: read_page mode:"compact", or find)' : ''}`;
}

// The embedded frames' outlines, each headed by its label, refs naming the frame (frames.js).
const FRAME_OUTLINE_CHARS = 3000;
const FRAMES_OUTLINE_CHARS = 8000;
async function frameOutlines(agent, wc, input, h) {
  const allow = (url) => !agent.browser.aiOff?.(url);
  const { frames: list, aiOff } = await frames.list(wc, { allow });
  const registry = registryScript(h.scripts, { frames: false });
  const read = await frames.each(wc, list, (frame) => `(() => { ${registry}; return ${serialize(compactOutline, {
    maxChars: FRAME_OUTLINE_CHARS, blockChars: 280, hrefs: Boolean(input.hrefs), frame: true, idBase: frames.encodeId(frame.n, 0),
  })}; })()`, 5000);
  const lines = [];
  let room = FRAMES_OUTLINE_CHARS;
  for (const { frame, value } of read) {
    if (!value?.lines?.length || room <= 0) continue;
    lines.push(frames.labelOf(frame, value.title));
    for (const line of value.lines) {
      if (room - line.length < 0) { lines.push('… (frame outline clipped; use find)'); break; }
      lines.push(frames.defang(line));
      room -= line.length + 1;
    }
  }
  if (aiOff) lines.push(`(${aiOff} embedded frame${aiOff === 1 ? '' : 's'} on a site where the user turned AI off: not read)`);
  return lines;
}

// The page's outline after a navigation (navigate / open_tab read:true), or '' when it can't be shown.
// noTitle: navigate's own line already says the title and address, so the outline's first line (the same two) is left out.
async function outline(agent, wc, h, { noTitle = false } = {}) {
  if (wc.isDestroyed() || agent.browser.aiOff?.(wc.getURL())) return '';
  try { return `
${await compact(agent, wc, { mode: 'compact', max_chars: 4000, noTitle }, h)}`; } catch { return ''; }
}

// The short head of the page after a navigation ('' when it can't be shown): navigate / open_tab return it by
// default (read:false opts out), so the model often needs no read_page step to see where it landed.
async function head(agent, wc, h, { noTitle = false } = {}) {
  if (wc.isDestroyed() || agent.browser.aiOff?.(wc.getURL())) return '';
  try { return `
${await compact(agent, wc, { mode: 'compact', max_chars: 1500, head: true, noTitle }, h)}`; } catch { return ''; }
}

// True when the last compact read of this tab (same URL, few calls ago) is still the baseline for the
// acting tool now running: no acting tool since it (this tool's own tick is the one after).
function baselineKnown(wc) {
  const last = reads.snaps().get(wc.id);
  return Boolean(last) && last.url === wc.getURL() && last.acted === reads.acted - 1 && reads.seq - last.seq <= FRESH_CALLS;
}

// Runs an acting tool and appends what changed on the page (the batch diff), so no read_page follows.
async function observe(agent, run, h) {
  const can = (wc) => !wc.isDestroyed() && !agent.browser.aiOff?.(wc.getURL());
  const before = agent.requireTab();
  if (can(before) && !baselineKnown(before)) await compact(agent, before, { mode: 'compact' }, h).catch(() => {}); // the baseline
  const result = await run();
  if (typeof result !== 'string') return result;
  const tab = agent.requireTab();
  if (!can(tab)) return result;
  const diff = await compact(agent, tab, { mode: 'compact', since_last: true, summary: true }, h).catch(() => '');
  return `${result}
${diff}`;
}

async function screenshot(agent, wc, input, h) {
  const maxWidth = Math.min(Math.max(Number(input.max_width) || 720, 320), 1600);
  const quality = Math.min(Math.max(Number(input.quality) || 60, 30), 90);
  if (!input.region) {
    const shot = await captureJpeg(wc, { maxWidth, quality });
    if (shot) {
      const size = { width: shot.width, height: shot.height };
      const view = await h.runScript(wc, '({ innerWidth, innerHeight, scrollX, scrollY })');
      agent.screenshotScale = { wc, ...annotate.shotScaleOf(view, size, wc.getZoomFactor()) };
      return [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.data } },
        { type: 'text', text: `Screenshot of ${wc.getURL()}, ${size.width}x${size.height} px. Use these coordinates with click_at.` },
      ];
    }
  }
  let image;
  if (input.region) {
    const z = wc.getZoomFactor();
    const r = input.region;
    image = await captureTab(wc, { x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.max(1, Math.round(r.width * z)), height: Math.max(1, Math.round(r.height * z)) });
  } else {
    image = await captureTab(wc); // a tab behind another one too (features/tab-capture.js)
  }
  if (image.getSize().width > maxWidth) image = image.resize({ width: maxWidth });
  const size = image.getSize();
  if (input.region) {
    agent.screenshotScale = null; // a crop can't be mapped back for click_at
  } else {
    const view = await h.runScript(wc, '({ innerWidth, innerHeight, scrollX, scrollY })');
    agent.screenshotScale = { wc, ...annotate.shotScaleOf(view, size, wc.getZoomFactor()) };
  }
  return [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toJPEG(quality).toString('base64') } },
    { type: 'text', text: `Screenshot of ${wc.getURL()}, ${size.width}x${size.height} px.${input.region ? ' Region crop (click_at unavailable).' : ' Use these coordinates with click_at.'}` },
  ];
}

async function batch(agent, wc, input, h) {
  const steps = Array.isArray(input.steps) ? input.steps.slice(0, 12) : [];
  if (!steps.length) throw new Error('batch needs at least one step.');
  // The baseline the closing diff compares with (as observe takes): without it the diff was against
  // whatever was read last, often another page, and said "Now on a new page" after a same-page batch.
  // A recent compact read of this same tab and URL with no acting tool since (this batch's own tick
  // is the one after it) is that baseline already: its registry still holds the ids, so no second read.
  if (!baselineKnown(wc) && !wc.isDestroyed() && !agent.browser.aiOff?.(wc.getURL())) await compact(agent, wc, { mode: 'compact' }, h).catch(() => {});
  const startHost = hostOf(wc.getURL());
  const report = [];
  for (const [i, step] of steps.entries()) {
    agent.stopCheck(); // Stop ends the batch before the next step
    const n = `${i + 1}.`;
    try {
      let tool;
      switch (step.do) {
        case 'type': tool = ['type_text', { element_id: step.ref, text: step.text ?? '', press_enter: Boolean(step.enter) }]; break;
        case 'select': tool = ['type_text', { element_id: step.ref, text: step.text ?? '' }]; break;
        case 'click': tool = ['click', step.ref ? { element_id: step.ref } : { text: step.text }]; break;
        case 'press': tool = ['press_key', { key: step.key, ...(step.modifiers ? { modifiers: step.modifiers } : {}) }]; break;
        case 'wait_for': tool = ['wait_for', { ...(step.text !== undefined ? { text: step.text } : {}), ...(step.url !== undefined ? { url: step.url } : {}), ...(step.gone !== undefined ? { gone: step.gone } : {}), ...(step.network_idle === true ? { network_idle: true } : {}), seconds: 10 }]; break;
        case 'scroll': tool = ['scroll', { direction: step.direction || 'down' }]; break;
        case 'hover': tool = ['hover', { element_id: step.ref }]; break;
        default: throw new Error(`Unknown step "${step.do}".`);
      }
      // The OK for the batch was for the site it started on; each step is asked about where it runs.
      await agent.allowStep(...tool);
      const result = await agent.execute(...tool);
      report.push(`${n} ${String(result).split('\n')[0].slice(0, 160)}`);
    } catch (err) {
      if (agent.signalAborted()) throw err; // Stop is not a failed step
      report.push(`${n} FAILED: ${err.message}`);
      report.push(`Stopped at step ${i + 1} of ${steps.length}; later steps did not run. Refs may be stale: use the page state below (or find), then retry from this step, using click text where you can.`);
      break;
    }
    // A step that lands on another site ends the batch: the new site needs its own look (and OK).
    const now = agent.requireTab();
    if (hostOf(now.getURL()) !== startHost) {
      if (i < steps.length - 1) report.push(`Stopped after step ${i + 1}: now on ${now.getURL()}. Check the page before continuing.`);
      break;
    }
  }
  const tab = agent.requireTab();
  const diff = await compact(agent, tab, { mode: 'compact', since_last: true, summary: true }, h).catch(() => '');
  return `${report.join('\n')}\n${diff}`;
}

// Handles the efficient tools; returns undefined for everything else.
async function execute(agent, name, input, h) {
  reads.tick(name);
  if (name === 'read_page' && (input.mode === 'compact' || input.since_last)) return compact(agent, agent.requireTab(), input, h, { dedupe: true });
  if (name === 'read_page' && input.mode === 'outline') return pageReading.readOutline((code, ms) => h.runScript(agent.requireTab(), code, ms)); // headings, links by region, next page (page-outline.js)
  if (name === 'read_page' && input.extract === 'tables') {
    const wc = agent.requireTab();
    const r = await h.runScript(wc, serialize(extractTables, { selector: input.selector ? String(input.selector) : '' }), 25000);
    return `<untrusted_page_content>\n${formatTables(r, { table: input.table, offset: input.text_offset })}\n</untrusted_page_content>`;
  }
  if (name === 'read_page' && input.extract) {
    const wc = agent.requireTab();
    const r = await h.runScript(wc, serialize(extractData, { kind: input.extract, selector: input.selector ? String(input.selector) : '' }), 15000);
    const json = JSON.stringify(r);
    return `<untrusted_page_content>
${json.length > 20000 ? `${json.slice(0, 20000)}
[truncated: ${json.length} chars; use selector]` : json}
</untrusted_page_content>`;
  }
  if (name === 'screenshot') return screenshot(agent, agent.screenshotWc ? agent.screenshotWc(input) : agent.requireTab(), input, h);
  if (name === 'find') {
    const wc = agent.requireTab();
    const inFrames = frames.available(wc);
    const max = Math.min(Math.max(Number(input.max) || 8, 1), 20);
    await h.runScript(wc, registryScript(h.scripts, { frames: !inFrames })); // the refs it returns point into this registry
    const r = await h.runScript(wc, serialize(findMatches, { query: String(input.query || ''), max }));
    if (inFrames && r.matches.length < max) { // and in the embedded frames, each in its own registry
      const { frames: list } = await frames.list(wc, { allow: (url) => !agent.browser.aiOff?.(url) });
      const registry = registryScript(h.scripts, { frames: false });
      const read = await frames.each(wc, list, (frame) => `(() => { ${registry}; return ${serialize(findMatches, { query: String(input.query || ''), max, idBase: frames.encodeId(frame.n, 0) })}; })()`, 5000);
      for (const { frame, value } of read) {
        for (const m of value?.matches || []) if (r.matches.length < max) r.matches.push(`${frames.defang(m)} (in ${frames.labelOf(frame, value.title)})`);
      }
    }
    if (!r.matches.length) return `No matches for "${input.query}" on ${r.url}.`;
    return `<untrusted_page_content>\n${r.matches.join('\n')}\n</untrusted_page_content>`;
  }
  if (name === 'batch') return batch(agent, agent.requireTab(), input, h);
  return undefined;
}

module.exports = { OBSERVE_TOOLS, observe, outline, head, pageHead, extractData, extractTables, formatTables, reads, ReadCache, extendTools, execute, ACTING, NEW_TOOLS, compactOutline, findMatches, registryScript };
