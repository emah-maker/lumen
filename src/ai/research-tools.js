// The AI's research tools, Electron-free so test/research-units.js runs them in plain Node:
//   find_sources    scholarly search + snowballing (ai/scholar.js) with quality labels; results get ids S1, S2, ... per chat
//   research_board  the chat's source list (ai/research-board.js): add, pin a verified quote, star, remove, list, cite
// agent.js wires the second one to the chat (settings.research) and to the sidebar panel; find_sources works for every engine.
// Both only ever talk to public scholarly APIs or the chat's own board: no tabs are driven, nothing is sent but the AI's query.
const scholar = require('./scholar');
const board = require('./research-board');
const citations = require('./citations');
const quality = require('./source-quality');

const STYLE_ENUM = [...citations.STYLES, ...citations.EXPORTS];

const FIND_SOURCES_TOOL = {
  name: 'find_sources',
  description: 'Search scholarly databases (OpenAlex, Crossref, Semantic Scholar, arXiv, PubMed): DOI, open-access PDF, citations, retraction flag. related+doi: who cites a paper, or its references.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      from_year: { type: 'integer' },
      to_year: { type: 'integer' },
      open_access: { type: 'boolean' },
      limit: { type: 'integer' },
      related: { type: 'string', enum: ['cited_by', 'references'] },
      doi: { type: 'string' },
    },
  },
};

const BOARD_TOOL = {
  name: 'research_board',
  description: 'The chat\'s source list. add: ids from find_sources, or url ("current": this tab) with title/authors/year/venue you read. quote: pin an exact quote of source n (checked against pages you read). Also star, remove, list, cite (style). Cite [[n]](url).',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'quote', 'star', 'remove', 'list', 'cite'] },
      ids: { type: 'array', items: { type: 'string' } },
      n: { type: 'integer' },
      url: { type: 'string' },
      title: { type: 'string' },
      authors: { type: 'array', items: { type: 'string' } },
      year: { type: 'integer' },
      venue: { type: 'string' },
      doi: { type: 'string' },
      quote: { type: 'string' },
      page: { type: 'integer' },
      style: { type: 'string', enum: STYLE_ENUM },
    },
    required: ['action'],
  },
};

// ---------- the chat's state ----------

const MAX_FOUND = 300;
// Records find_sources returned in this chat, by id: `chat.researchFound` (a plain property of the messages array: not saved).
function foundOf(chat) {
  if (!chat) return { next: 1, byId: new Map() };
  if (!chat.researchFound) chat.researchFound = { next: 1, byId: new Map() };
  return chat.researchFound;
}
function remember(found, work) {
  const dup = [...found.byId.entries()].find(([, w]) => (work.doi && w.doi === work.doi) || (!work.doi && !w.doi && scholar.normTitle(w.title) === scholar.normTitle(work.title)));
  if (dup) { found.byId.set(dup[0], { ...dup[1], ...work }); return dup[0]; }
  const id = `S${found.next++}`;
  found.byId.set(id, work);
  if (found.byId.size > MAX_FOUND) found.byId.delete(found.byId.keys().next().value);
  return id;
}

// The board of a chat (settings.research), normalised on first use. `create`: an empty chat has no settings yet; the caller
// supplies them. Returns null when there is nowhere to keep one (no chat, e.g. an outside MCP client).
const checked = new WeakSet();
function boardOf(chat, { create = null } = {}) {
  if (!chat) return null;
  if (!chat.settings) { if (!create) return null; chat.settings = create(); }
  const s = chat.settings;
  // A board that came from disk (a restored chat) is cleaned once per process; ours are marked, so later calls are free.
  if (!s.research || !checked.has(s.research)) { s.research = board.normalizeBoard(s.research); checked.add(s.research); }
  return s.research;
}

// ---------- find_sources ----------

async function findSources(input, { chat = null, signal, fetchImpl, limiter, sleep, now } = {}) {
  const deps = { fetchImpl, signal, limiter, sleep, now };
  const int = (v) => (Number.isInteger(v) && v > 1000 && v < 3000 ? v : undefined);
  const params = { limit: input.limit, from_year: int(input.from_year), to_year: int(input.to_year), open_access: input.open_access === true };
  let out;
  if (input.related) {
    if (!input.doi) throw new Error('related needs doi: the paper to start from (find it first, then pass its DOI).');
    out = await scholar.related({ doi: input.doi, kind: input.related, limit: input.limit }, deps);
  } else {
    if (!String(input.query ?? '').trim()) throw new Error('find_sources needs a query, or related + doi.');
    out = await scholar.find({ query: input.query, ...params }, deps);
  }
  const found = foundOf(chat);
  const ids = out.results.map((w) => remember(found, w));
  return scholar.describe(out.results, ids, out);
}

// ---------- research_board ----------

const num = (id) => Number(String(id).replace(/^\[|\]$/g, '').replace(/^[a-z]/i, ''));
const line = (s) => {
  const who = s.authors.slice(0, 2).map((a) => a.literal || a.family).join(', ') + (s.authors.length > 2 ? ' et al.' : '');
  return `[${s.n}] ${s.title}${who ? ` — ${who}` : ''}${s.year ? ` (${s.year})` : ''} ${quality.shortLabel(s)}${s.retracted ? ' WARNING: this work is retracted, do not rely on it.' : ''}`;
};

// Runs one research_board call. deps: { chat, board (the chat's board), changed(board), capture(): raw page facts | null (the task's tab),
// hidden(source): AI must not see it (AI off for its site), cite? }. Returns the tool's text.
async function boardTool(input, deps) {
  const { chat, changed = () => {}, capture, hidden = () => false } = deps;
  const b = deps.board;
  if (!b) throw new Error('The research board is not available here (it belongs to a sidebar chat).');
  const found = foundOf(chat);
  const visible = (s) => !hidden(s);
  const done = (text) => { changed(b); return text; };
  switch (input.action) {
    case 'add': {
      const lines = [];
      const records = [];
      for (const id of Array.isArray(input.ids) ? input.ids.slice(0, 20) : []) {
        const w = found.byId.get(String(id).trim().toUpperCase().replace(/^\[|\]$/g, ''));
        if (!w) { lines.push(`Unknown id ${id}: it must be an S-number find_sources returned in this chat.`); continue; }
        records.push(w);
      }
      if (input.url || input.title || input.doi) {
        if (String(input.url).toLowerCase() === 'current') {
          const raw = capture ? await capture() : null;
          if (!raw) throw new Error('There is no page in this tab to add.');
          const pm = require('./page-meta');
          const meta = pm.fromRaw(raw);
          records.push({ ...meta, title: input.title || meta.title, ...(input.authors?.length ? { authors: input.authors } : {}) });
        } else {
          records.push({ title: input.title, url: input.url, doi: input.doi, authors: input.authors, year: input.year, venue: input.venue, accessed: new Date().toISOString().slice(0, 10) });
        }
      }
      if (!records.length && !lines.length) throw new Error('add needs ids from find_sources, or url / title / doi.');
      for (const r of records) {
        try {
          const { source, added } = board.addSource(b, r, { by: 'ai' });
          lines.push(`${added ? 'Added' : 'Already on the board'}: ${line(source)}${source.url ? `\n   cite as [[${source.n}]](${source.url})` : ''}`);
        } catch (err) { lines.push(`Not added: ${err.message}`); }
      }
      return done(lines.join('\n'));
    }
    case 'quote': {
      const s = board.byNumber(b, input.n);
      if (!s) throw new Error(`No source [${input.n}] on the board. Add it first.`);
      if (!visible(s)) throw new Error(`The user turned off AI on this source's site.`);
      const text = String(input.quote ?? '').trim();
      if (!text) throw new Error('quote needs the exact words.');
      const check = board.verifyQuote(text, s.url, board.collectTexts(chat), { doi: s.doi });
      const page = input.page || check.page || null;
      const link = board.fragmentUrl(s.url, text, { page });
      const { added } = board.addQuote(b, s.n, { text, page, heading: check.heading, url: link, verified: check.verified }, { by: 'ai' });
      const state = check.verified === true ? `verified in the text I read${page ? ` (page ${page})` : ''}${check.heading ? ` under "${check.heading}"` : ''}`
        : check.verified === false ? 'NOT FOUND in the page text I read: it is marked unverified. Fix the wording from the source or drop the claim; never present it as a quote.'
          : 'unverified (I have not read this source in this chat): read it, then quote again to verify.';
      return done(`${added ? 'Pinned' : 'Already pinned'} on [${s.n}]: ${state}.${link ? `\nLink to the passage: ${link}` : ''}`);
    }
    case 'star': {
      const s = board.updateSource(b, input.n, { starred: true }, { by: 'ai' });
      if (!s) throw new Error(`No source [${input.n}].`);
      return done(`Starred [${s.n}].`);
    }
    case 'remove': {
      if (!board.removeSource(b, input.n, { by: 'ai' })) throw new Error(`No source [${input.n}].`);
      return done(`Removed [${input.n}].`);
    }
    case 'list': {
      const list = { ...b, sources: b.sources.map((s) => (visible(s) ? s : { ...s, title: '(hidden: the user turned off AI on this site)', authors: [], note: '', quotes: [], url: '', abstract: '' })) };
      return `<untrusted_page_content>\n${board.summary(list)}\n</untrusted_page_content>`;
    }
    case 'cite': {
      const style = STYLE_ENUM.includes(input.style) ? input.style : 'apa';
      const wanted = Array.isArray(input.ids) && input.ids.length ? input.ids.map(num) : b.sources.map((s) => s.n);
      const chosen = wanted.map((n) => board.byNumber(b, n)).filter((s) => s && visible(s));
      if (!chosen.length) throw new Error('Nothing to cite: add the source to the board first (research_board add).');
      const out = citations.bibliography(chosen, style);
      return `${citations.STYLE_NAMES[style]}, ${out.count} source${out.count === 1 ? '' : 's'} (titles are used as the database gave them: check capitalisation and journal abbreviations against your style guide):\n${out.markdown}`;
    }
    default: throw new Error('action must be add, quote, star, remove, list or cite.');
  }
}

module.exports = { FIND_SOURCES_TOOL, BOARD_TOOL, findSources, boardTool, boardOf, foundOf, remember, STYLE_ENUM };
