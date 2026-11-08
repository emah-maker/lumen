// [card tabs] The items a busy run works on, read off its agents' names, for the Agents card's tabs (agents-card.js): a main tab with a row per
// item, then a tab per item with its own agents and score. Pure: a plain script in the UI (window.cardItems, loaded with agents-card.js) and
// require()d by the tests.
//
//   itemOf(desc)     the item an agent works on: { key, label, explicit }. explicit when its name has an id ("Build 4.2 deck", "Fix #812",
//                    "Write cp34.js"); otherwise its name without the verb and the round ("Review cover letter round 2" -> "cover letter")
//   group(agents)    the agents ({ id, desc, state, summary, startedAt, endedAt }) as items, in the order first heard: { key, label, explicit, ids,
//                    state, score, rounds, startedAt, endedAt, needsUser }
//   tabbed(agents)   whether the card shows tabs: two items or more, and more than MAX_FLAT agents or an id on two items (a small run, or
//                    one item however many rounds it takes, keeps one list)
(function (root) {
  const MAX_FLAT = 3;
  const RT = () => (typeof module === 'object' && module.exports ? require('./review-track') : root.reviewTrack);
  const VERBS = /^(?:build|write|draft|make|create|fix|review|re-?review|rate|score|grade|critique|check|test|research|revise|improve|edit|update|polish|redo|rewrite|summari[sz]e|explore|find|investigate|plan|implement|run|verify)\b\s*/i;
  const ID = [
    /\b(\d{1,3}(?:\.\d{1,3})+)\b/, // a section or chapter number: 4.2, 3.1.4
    /(#\d{1,6})\b/, // an issue or PR
    /\b([\w-]{1,60}\.(?:js|ts|tsx|jsx|py|md|css|html|json|docx?|pptx?|xlsx?|pdf|txt|csv))\b/i, // a file
  ];
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function itemOf(desc) {
    const s = clean(desc);
    const bare = s.replace(/\bround\s*#?\s*\d{1,2}\b/gi, ' ').replace(/\bR\d{1,2}\b/g, ' ');
    for (const re of ID) {
      const m = bare.match(re);
      if (m) return { key: m[1].toLowerCase(), label: m[1], explicit: true };
    }
    let rest = clean(bare);
    for (let i = 0; i < 3 && VERBS.test(rest); i++) rest = rest.replace(VERBS, '');
    rest = clean(rest.replace(/^(?:the|a|an|of|for|on)\s+/i, '').replace(/[.:;,\-–]+$/, ''));
    return { key: rest.toLowerCase(), label: rest.slice(0, 40), explicit: false };
  }

  const ENDED = new Set(['done', 'failed', 'stopped']);
  function group(agents) {
    const out = new Map();
    for (const a of Array.isArray(agents) ? agents : []) {
      if (!a || typeof a.id !== 'string') continue;
      const it = itemOf(a.desc);
      const key = it.key || `agent:${a.id}`; // (a name that is only a verb: an item of its own)
      const g = out.get(key) || { key, label: it.label || clean(a.desc).slice(0, 40), explicit: it.explicit, ids: [], agents: [] };
      g.ids.push(a.id);
      g.agents.push(a);
      out.set(key, g);
    }
    const track = RT();
    return [...out.values()].map((g) => {
      let review = null;
      for (const a of g.agents) { const e = track?.fromAgent(a); if (e && !e.clear) review = track.merge(review, e); }
      const last = review ? track.latest(review) : null;
      const states = g.agents.map((a) => a.state);
      const state = states.includes('working') ? 'working' : states.includes('failed') ? 'failed' : states.every((x) => x === 'done') ? 'done' : 'stopped';
      const starts = g.agents.map((a) => a.startedAt).filter(Number.isFinite);
      const ends = g.agents.filter((a) => ENDED.has(a.state)).map((a) => a.endedAt).filter(Number.isFinite);
      return {
        key: g.key, label: g.label, explicit: g.explicit, ids: g.ids, state,
        score: last ? last.score : null, rounds: review ? review.rounds : [],
        startedAt: starts.length ? Math.min(...starts) : null,
        endedAt: state === 'working' || !ends.length ? null : Math.max(...ends),
        needsUser: state === 'failed', // (an item whose agent failed waits on the user: its tab says so)
      };
    });
  }

  function tabbed(agents) {
    const list = Array.isArray(agents) ? agents.filter((a) => a && typeof a.id === 'string') : [];
    const items = group(list);
    if (items.length < 2) return false;
    return list.length > MAX_FLAT || items.filter((g) => g.explicit).length >= 2;
  }

  const api = { MAX_FLAT, itemOf, group, tabbed };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.cardItems = api;
})(this);
