// [quiet run] A run that goes on after one of its turns ends (Claude Code's helpers, reviewers or agents still at work on the card) keeps the chat
// quiet until it is over: what that turn said is the card's status line, not a bubble; a file it writes again is the same card, updated; the
// "Save how I did this as a skill?" offer comes once, at the very end. Pure: a plain script in the UI (window.runQuiet, before chat-core.js) and
// require()d by the tests.
//
//   asks(text)                     whether the words ask the user something (they end on a question): those stay in the chat
//   interim(text, { waiting })     the words to fold into the card ('' when there are none, they ask the user, or an approval waits)
//   finalReply(text)               the final answer without its status filler: a paragraph that only says how the work stands ("Status: …",
//                                  "I'm waiting on…", "Four agents are running…") goes, as does a sentence that only promises to go on later
//                                  ("I'll start … as it finishes"); the card says all that. Never empties a reply: all filler comes back as it was.
//   fileKey(file)                  one key per file path ('C:\\a\\B.md' and 'c:/a/b.md' are one file)
//   offerGate()                    one skill offer per run: hold(run, offer) while it goes on, show(run, offer) at its end, release(run) the held
//                                  one; a run that showed one (whatever the user then picked) shows no other. run: any object (the run's card)
(function (root) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function asks(text) {
    const s = clean(text).replace(/[\s*_`)\]"'”’]+$/, '');
    return /\?$/.test(s);
  }

  function interim(text, { waiting = false } = {}) {
    const s = clean(text);
    if (!s || waiting || asks(s)) return '';
    return s;
  }

  // A paragraph that only reports progress: what it begins with says so. A list, code, a table, a quote or a heading is content, never filler.
  const LEADS = [
    /^(?:status|progress)\s*:/i, // ("Update: I found…" is often news, not status: kept)
    /^(?:i'?m|i am|we'?re|we are)\s+(?:now\s+|still\s+)?waiting\s+(?:on|for)\b/i,
    /^(?:still\s+)?waiting\s+(?:on|for)\b/i,
    /^(?:all\s+|the\s+)?(?:\w+\s+)?(?:agents?|helpers?|reviewers?|subagents?|workers?)\s+(?:are|is)\s+(?:still\s+|now\s+)?(?:running|working|in progress|under way|underway)\b/i,
  ];
  // A sentence that only waits, or promises to go on later ("I'll start a fresh reviewer for each deck as it finishes.").
  const LATER = /^(?:i'?ll|i will|we'?ll|i'?m going to)\b[^.!?]*\b(?:as (?:each|it|they|one|soon as)\b|once (?:each|it|they|all|the)\b|when (?:each|it|they|all|the)\b[^.!?]*\b(?:finish|finishes|done|complete|completes|ready|back)\b|in the background)/i;
  const WAIT = /^(?:i'?m|i am|we'?re|we are)\s+(?:now\s+|still\s+)?waiting\s+(?:on|for)\b/i;
  const waits = (s) => LATER.test(s) || WAIT.test(s);
  const sentences = (p) => p.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)\s*/g) || [p];
  const plain = (p) => p.replace(/\*\*|__/g, '').replace(/^[\s*_]+|[\s*_]+$/g, '');
  const structured = (p) => /^\s*(?:[-*+]\s|\d+[.)]\s|#|\||>)/m.test(p);
  function tidy(text) {
    const src = String(text || '');
    if (!src.trim() || src.includes('```')) return { kept: [src], cut: false };
    const kept = [];
    let cut = false;
    for (const p of src.split(/\r?\n[ \t]*\r?\n/)) {
      if (!p.trim()) continue;
      if (structured(p) || asks(p)) { kept.push(p); continue; }
      const body = plain(p).trim();
      if (LEADS.some((re) => re.test(body))) { cut = true; continue; }
      const parts = sentences(p.trim());
      const keep = parts.filter((x) => !waits(plain(x).trim()));
      if (keep.length === parts.length) { kept.push(p); continue; }
      cut = true;
      if (keep.length) kept.push(keep.join('').trim());
    }
    return { kept, cut };
  }
  function finalReply(text) {
    const { kept, cut } = tidy(text);
    return cut && kept.length ? kept.join('\n\n') : String(text || '');
  }
  const filler = (text) => { const { kept, cut } = tidy(text); return cut && !kept.length; };

  // One run is one card, also when a chat is drawn again. A run that went on (Claude Code's own turns after its background helpers) saved a turn
  // each, each with its steps and the card's agents, skills and review as they stood then: drawn as they are, that is a card per turn, each
  // repeating the review bar and the agents. The card turns of one exchange (no message of the user's between them; one sent mid-run does not
  // count) are one card: every turn's steps, the last turn's state, where the last turn is. Returns { merged: Map(last item -> the one card's
  // item), earlier: Set(the turns before it: no card, and no bubble unless they asked something) }.
  const isCardTurn = (it) => it && it.role === 'assistant' && it.cards === true && Array.isArray(it.tools) && it.tools.length > 0 && !it.generated?.length && !it.outFiles?.length;
  const union = (lists) => { const seen = new Set(); const out = []; for (const x of lists.flat()) { const k = JSON.stringify(x); if (!seen.has(k)) { seen.add(k); out.push(x); } } return out; };
  function oneCardPerRun(items) {
    const merged = new Map();
    const earlier = new Set();
    let group = [];
    const close = () => {
      if (group.length > 1) {
        const last = group[group.length - 1];
        const thinking = group.map((x) => x.thinking).filter(Boolean).join('\n\n');
        const thinkingMs = group.reduce((n, x) => n + (Number(x.thinkingMs) || 0), 0);
        const touched = union(group.map((x) => x.touched || []));
        const written = union(group.map((x) => x.written || []));
        merged.set(last, {
          ...last,
          tools: group.flatMap((x) => x.tools).slice(-60),
          ...(thinking ? { thinking } : {}), ...(thinkingMs ? { thinkingMs } : {}),
          ...(touched.length ? { touched } : {}), ...(written.length ? { written } : {}),
          thumb: last.thumb || [...group].reverse().find((x) => x.thumb)?.thumb,
          agents: last.agents || [...group].reverse().find((x) => x.agents)?.agents,
          skills: last.skills || group.find((x) => x.skills)?.skills,
          review: last.review || [...group].reverse().find((x) => x.review)?.review,
        });
        for (const g of group.slice(0, -1)) earlier.add(g);
      }
      group = [];
    };
    for (const it of Array.isArray(items) ? items : []) {
      if (it?.role === 'user' && !it.steered) close();
      else if (isCardTurn(it)) group.push(it);
    }
    close();
    return { merged, earlier };
  }

  function fileKey(file) {
    const p = String(file?.path || file?.name || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    return p.toLowerCase();
  }

  function offerGate() {
    const shown = new WeakSet();
    const held = new WeakMap();
    return {
      hold(run, offer) { if (run && offer && !shown.has(run)) held.set(run, offer); },
      show(run, offer) {
        if (!run || !offer || shown.has(run)) return null;
        shown.add(run);
        held.delete(run);
        return offer;
      },
      release(run) {
        const offer = run ? held.get(run) : null;
        if (!offer) return null;
        held.delete(run);
        if (shown.has(run)) return null;
        shown.add(run);
        return offer;
      },
      shown: (run) => Boolean(run) && shown.has(run),
    };
  }

  const api = { asks, interim, finalReply, filler, oneCardPerRun, fileKey, offerGate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.runQuiet = api;
})(this);
