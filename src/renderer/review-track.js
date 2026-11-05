// [review loop] The score track of one review loop (the "review" skill, features/skills.js), as one card shows it live: the rounds, each with its
// score once its reviewer is back (a pending chip while it reviews), the bar, the latest score and how it moved. Pure: a plain script in the UI
// (window.reviewTrack, loaded with step-ui.js) and require()d by the engine (ai/claude-code.js) and the tests.
//
//   roundOfAgent(desc)      the round a reviewer agent works on, from its name ("Review cover letter round 3" -> 3); 0 for any other agent
//   scoreIn(text)           the score out of 10 in a reviewer's answer ("Score: 8.4/10", "I'd rate it 7 out of 10"); null when it gives none
//   fromAgent(snap)         a reviewer agent's state (cc-helpers.js snapshot) as a round of the track: pending while it works, its score when it is
//                           done, gone when it failed or was stopped without one; null for any other agent
//   merge(review, event)    one event into the track ({ bar, title, rounds }); a round the AI reported (review_round) is never overwritten by one
//                           read from a reviewer's answer, and a pending round never replaces a score
//   latest / trend / over   the newest score, the change since the round before it, and whether the loop has ended (bar met, or the last round)
(function (root) {
  const MAX_ROUNDS = 5; // (ai/agent.js MAX_REVIEW_ROUNDS)
  const DEFAULT_BAR = 9; // (the skill's bar when the user names none)
  const tenth = (n) => Math.round(n * 10) / 10;
  const inRange = (n) => Number.isFinite(n) && n >= 0 && n <= 10;

  function roundOfAgent(desc) {
    const s = String(desc || '');
    if (!/\b(?:review\w*|rat(?:e|es|ed|ing|er)|scor\w*|grad(?:e|er|ing)|critique|judge)\b/i.test(s)) return 0; // (whole words: "generate" is no rating)
    const m = s.match(/\bround\s*#?\s*(\d{1,2})\b/i) || s.match(/\bR(\d{1,2})\b/);
    const n = m ? Number(m[1]) : 0;
    return n >= 1 && n <= 50 ? n : 0;
  }

  const NUM = '(\\d{1,2}(?:\\.\\d+)?)';
  const OF_TEN = `${NUM}\\s*(?:\\/|out of)\\s*10\\b`;
  function scoreIn(text) {
    const s = String(text || '').slice(0, 4000);
    if (!s) return null;
    const pick = (re) => { const m = s.match(re); const n = m ? Number(m[1]) : NaN; return inRange(n) ? tenth(n) : null; };
    // A score said as one ("Score: 8.4/10", "rated 7 out of 10", "Overall 8/10") first, then any x/10 that is not the bar, then "Score: 8.4".
    const named = pick(new RegExp(`\\b(?:score[sd]?|rating|rated?|grade|overall|final|verdict|give it|gives it|i'd give)\\b[^0-9\\n]{0,24}${OF_TEN}`, 'i'));
    if (named !== null) return named;
    for (const m of s.matchAll(new RegExp(OF_TEN, 'gi'))) {
      const before = s.slice(Math.max(0, m.index - 16), m.index);
      if (/\b(?:bar|target|goal|aim|reach|above|below|meets?|of at least)\b[^0-9]*$/i.test(before)) continue; // ("below the bar of 9/10")
      const n = Number(m[1]);
      if (inRange(n)) return tenth(n);
    }
    return pick(new RegExp(`\\b(?:score|rating)\\s*[:=–-]\\s*${NUM}\\b(?!\\s*%)`, 'i'));
  }

  function fromAgent(snap) {
    const round = roundOfAgent(snap?.desc);
    if (!round) return null;
    if (snap.state === 'working') return { type: 'review', round, pending: true, derived: true };
    const score = snap.state === 'done' ? scoreIn(snap.summary) : null;
    if (score !== null) return { type: 'review', round, score, derived: true };
    return { type: 'review', round, clear: true, derived: true }; // (failed, stopped, or done without a score: the AI's own review_round says it, if anything)
  }

  function merge(review, event) {
    const r = review && typeof review === 'object' ? review : { bar: null, title: '', rounds: [] };
    if (!Array.isArray(r.rounds)) r.rounds = [];
    const roundNo = Math.round(Number(event?.round));
    if (!Number.isInteger(roundNo) || roundNo < 1 || roundNo > 50) return r;
    if (Number.isFinite(event.bar) && event.bar > 0 && event.bar <= 10) r.bar = tenth(event.bar);
    if (event.title) r.title = String(event.title).replace(/\s+/g, ' ').trim().slice(0, 80);
    const at = r.rounds.findIndex((x) => x.round === roundNo);
    const old = at >= 0 ? r.rounds[at] : null;
    if (event.clear) { if (old && old.pending) r.rounds.splice(at, 1); return r; }
    if (event.pending) { if (!old) r.rounds.push({ round: roundNo, score: null, met: false, fixes: [], pending: true, derived: true }); }
    else if (inRange(Number(event.score))) {
      if (old && event.derived && !old.derived && !old.pending) return r; // (the AI's own report of the round stands)
      const score = tenth(Number(event.score));
      const fixes = Array.isArray(event.fixes) ? event.fixes.map(String).slice(0, 5) : old?.fixes || [];
      const next = { round: roundNo, score, met: false, fixes, pending: false, derived: event.derived === true };
      if (at >= 0) r.rounds[at] = next; else r.rounds.push(next);
    } else return r;
    r.rounds.sort((a, b) => a.round - b.round);
    const bar = barOf(r);
    for (const x of r.rounds) x.met = !x.pending && x.score !== null && x.score >= bar - 1e-9;
    if (r.rounds.length > 20) r.rounds.splice(0, r.rounds.length - 20);
    return r;
  }

  const barOf = (r) => (Number.isFinite(r?.bar) && r.bar > 0 ? r.bar : DEFAULT_BAR);
  const scored = (r) => (Array.isArray(r?.rounds) ? r.rounds.filter((x) => !x.pending && x.score !== null) : []);
  function latest(r) { const s = scored(r); return s.length ? s[s.length - 1] : null; }
  function trend(r) { const s = scored(r); return s.length < 2 ? null : tenth(s[s.length - 1].score - s[s.length - 2].score); }
  function over(r, max = MAX_ROUNDS) {
    const last = latest(r);
    if (!last) return false;
    if (r.rounds.some((x) => x.pending && x.round > last.round)) return false; // (a later round is being reviewed)
    return last.met || last.round >= max;
  }
  // What the track saves with the reply: the scored rounds only (a pending chip means nothing in a chat opened later).
  function saved(r) { const rounds = scored(r).map(({ round, score, met, derived }) => ({ round, score, met, ...(derived ? { derived: true } : {}) })); return rounds.length ? { bar: barOf(r), title: r.title || '', rounds } : null; }

  const api = { MAX_ROUNDS, DEFAULT_BAR, roundOfAgent, scoreIn, fromAgent, merge, barOf, latest, trend, over, saved };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.reviewTrack = api;
})(this);
