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

const lastSnapshot = new Map(); // webContents id -> { url, lines }

// Re-reading an unchanged page costs a whole snapshot of tokens for nothing. Per tab we remember the
// last full read (URL, request shape, content fingerprint, and when); an identical read soon after
// gets one line back instead. "Soon" is a few tool calls: the API clears older tool results, and a
// model that can no longer see the earlier snapshot must get it again. Any tool that can change the
// page clears the cache, and the content itself is compared, so a stale hit can't happen.
const READ_ONLY = new Set(['read_page', 'find', 'screenshot', 'list_tabs', 'read_urls', 'read_tabs', 'web_search', 'read_pdf', 'get_console', 'get_network', 'analyze_posts']);
const FRESH_CALLS = 6;
class ReadCache {
  // acted: how many acting tools have run (batch's baseline reuse compares it, see batch below).
  // session: the CLI session the cache belongs to; entries are keyed by it, and reset() clears them.
  constructor() { this.tabs = new Map(); this.seq = 0; this.acted = 0; this.session = ''; }
  tick(name) { this.seq++; if (!READ_ONLY.has(name)) { this.acted++; this.tabs.clear(); } }
  // A model that no longer has the earlier read in its context (new CLI process or session, rewind,
  // engine reset, expired-session handoff) must get the page again, not "unchanged".
  clear() { this.tabs.clear(); lastSnapshot.clear(); }
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
const reads = new ReadCache();

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
  const push = (line) => {
    if (!line || seen.has(line) || NOISE_LINE.test(line)) return;
    if (size + line.length > opts.maxChars) { clipped = true; return; }
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
  const visit = (child) => {
    if (clipped) return;
    if (SKIP.has(child.tagName) || !visible(child)) return;
    const id = idOf.get(child);
    if (id) { push(describe(id, child)); return; }
    const h = /^H([1-6])$/.exec(child.tagName);
    if (h) { push(`${'#'.repeat(Number(h[1]))} ${clean(child.innerText).slice(0, 120)}`); return; }
    const mark = landmark(child);
    if (mark) push(mark);
    if (TEXT_BLOCKS.has(child.tagName)) {
      if (CELLS.has(child.tagName) && !child.shadowRoot && child.querySelector(NESTED)) { mixed(child); return; }
      const text = inline(child);
      if (text.length > 1) push(child.tagName === 'LI' ? `- ${text}` : text);
      return;
    }
    // A div/span that holds its own text (not just other blocks) is a text block too.
    const ownText = [...child.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1);
    if (ownText && !child.shadowRoot && !child.querySelector('p,li,h1,h2,h3,h4,h5,h6,table,ul,ol,form')) {
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

// read_page extract: tables, links or lists as JSON (what run_script was used for), optionally within a selector.
function extractData(opts) {
  const root = opts.selector ? document.querySelector(opts.selector) : document.body;
  if (!root) return { error: 'No element matches selector.' };
  const clean = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const shown = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const within = (sel) => [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)].filter(shown);
  let data;
  if (opts.kind === 'tables') {
    data = within('table').slice(0, 5).map((t) => ({
      caption: clean(t.caption && t.caption.innerText, 100),
      rows: [...t.rows].slice(0, 60).map((r) => [...r.cells].slice(0, 12).map((c) => clean(c.innerText, 120))),
    }));
  } else if (opts.kind === 'lists') {
    data = within('ul,ol').slice(0, 8).map((l) => [...l.children].slice(0, 40).map((li) => clean(li.innerText, 160)));
  } else {
    const seen = new Set();
    data = within('a[href]').map((a) => [clean(a.innerText || a.getAttribute('aria-label'), 100), a.href])
      .filter(([text, href]) => text && !seen.has(href) && seen.add(href)).slice(0, 80);
  }
  return { url: location.href, kind: opts.kind, data };
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
};
// Tools that can also report what changed on the page after they act (see observe).
const OBSERVE_TOOLS = new Set(['click', 'click_at', 'type_text', 'press_key']);

const SCREENSHOT_EXTRA = {
  max_width: { type: 'integer', description: 'Default 1024, max 1600.' },
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
    description: 'Several actions in one call, stopping at a failure: type{ref,text,enter?} click{ref|text} select{ref,text} press{key,modifiers?} wait_for{text|url|gone|network_idle} scroll{direction} hover{ref}.',
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
const { captureTab } = require('../features/tab-capture');
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
    maxChars: Math.min(Math.max(Number(input.max_chars) || 6000, 1000), 20000),
    blockChars: 280,
    startLine: input.start_line || 0,
    hrefs: Boolean(input.hrefs),
  }), 15000);
  if (inFrames && !input.start_line) result.lines.push(...await frameOutlines(agent, wc, input, h));
  const url = wc.getURL();
  const previous = lastSnapshot.get(wc.id);
  lastSnapshot.set(wc.id, { url, lines: result.lines, seq: reads.seq, acted: reads.acted });
  let body;
  if (input.since_last && previous && previous.url === url) {
    const before = new Set(previous.lines);
    const after = new Set(result.lines);
    const added = result.lines.filter((l) => !before.has(l));
    const removed = previous.lines.filter((l) => !after.has(l)).length;
    body = added.length || removed
      ? `Changes since your last read (+${added.length} / -${removed} lines):\n${added.join('\n')}`
      : 'No changes since your last read.';
  } else if (input.head) {
    // After navigate / open_tab: the title, URL and the top of the page, enough to see where it landed.
    body = pageHead(result.lines, result.totalLines, result.clipped);
  } else if (input.summary) {
    // After a batch lands on a new page: just its top, the model can read more if it needs to.
    body = `Now on a new page:\n${result.lines.slice(0, 12).join('\n')}\n… (${result.totalLines} lines; use find or read_page mode:"compact")`;
  } else {
    body = `${input.since_last && previous ? '(new page)\n' : ''}${result.lines.join('\n')}`;
    if (result.clipped) body += `\n… outline clipped at ${result.totalLines} lines (${result.elements} controls). Use find, or start_line:${result.startLine + result.lines.length}.`;
    const same = dedupe && !input.since_last && h.dedupe?.() ? reads.check(wc.id, url, `c|${input.start_line || 0}|${Boolean(input.hrefs)}`, body) : null;
    if (same) body = same;
  }
  return `<untrusted_page_content>\n${body}\n</untrusted_page_content>`;
}

// The first ~600 characters of an outline (whole lines), with a pointer to the rest.
const HEAD_CHARS = 600;
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
async function outline(agent, wc, h) {
  if (wc.isDestroyed() || agent.browser.aiOff?.(wc.getURL())) return '';
  try { return `
${await compact(agent, wc, { mode: 'compact', max_chars: 4000 }, h)}`; } catch { return ''; }
}

// The short head of the page after a navigation ('' when it can't be shown): navigate / open_tab return it by
// default (read:false opts out), so the model often needs no read_page step to see where it landed.
async function head(agent, wc, h) {
  if (wc.isDestroyed() || agent.browser.aiOff?.(wc.getURL())) return '';
  try { return `
${await compact(agent, wc, { mode: 'compact', max_chars: 1500, head: true }, h)}`; } catch { return ''; }
}

// True when the last compact read of this tab (same URL, few calls ago) is still the baseline for the
// acting tool now running: no acting tool since it (this tool's own tick is the one after).
function baselineKnown(wc) {
  const last = lastSnapshot.get(wc.id);
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
  const maxWidth = Math.min(Math.max(Number(input.max_width) || 1024, 320), 1600);
  const quality = Math.min(Math.max(Number(input.quality) || 60, 30), 90);
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
    const viewWidth = (await h.runScript(wc, 'innerWidth')) * wc.getZoomFactor();
    agent.screenshotScale = { wc, ratio: viewWidth / size.width };
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
  if (name === 'read_page' && input.extract) {
    const wc = agent.requireTab();
    const r = await h.runScript(wc, serialize(extractData, { kind: input.extract, selector: input.selector ? String(input.selector) : '' }), 15000);
    const json = JSON.stringify(r);
    return `<untrusted_page_content>
${json.length > 20000 ? `${json.slice(0, 20000)}
[truncated: ${json.length} chars; use selector]` : json}
</untrusted_page_content>`;
  }
  if (name === 'screenshot') return screenshot(agent, agent.requireTab(), input, h);
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

module.exports = { OBSERVE_TOOLS, observe, outline, head, pageHead, extractData, reads, ReadCache, extendTools, execute, ACTING, NEW_TOOLS, compactOutline, findMatches, registryScript };
