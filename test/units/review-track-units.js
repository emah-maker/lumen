// [review loop] The live score track of one review-skill run (renderer/review-track.js): reading a reviewer agent's round and score, merging rounds
// (the AI's review_round wins over a score read off a reviewer, a pending round never replaces a score), the trend and when the loop is over; the
// engine telling the card each reviewer's round as it happens (ai/claude-code.js sayAgent); and the Agents card (renderer/agents-card.js) showing
// a reviewer's score beside Done, and an agent that ended in this window as it ended when the chat is drawn again from an older save (not Stopped).
// The whole run in one card across rounds and turns is test/e2e/review-loop-card.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const RT = require('../../src/renderer/review-track');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

// ---- which agents are reviewers, and of which round
check('a reviewer agent: its round from its name', RT.roundOfAgent('Review cover letter round 3') === 3 && RT.roundOfAgent('Round 2 reviewer') === 2 && RT.roundOfAgent('Rate the deck (round 1)') === 1 && RT.roundOfAgent('Score slides, R4') === 4);
check('...any other agent is none, a word that only contains "rate" too', RT.roundOfAgent('Generate round 2 images') === 0 && RT.roundOfAgent('Fix round 2 issues') === 0 && RT.roundOfAgent('Review the code') === 0 && RT.roundOfAgent('') === 0 && RT.roundOfAgent(undefined) === 0);

// ---- the score in a reviewer's answer
const scores = [
  ['Score: 8.4/10. Top fixes: ...', 8.4],
  ['I would rate it 7 out of 10.', 7],
  ['It is still below the bar of 9/10. Overall: 8.6/10', 8.6],
  ['Below the bar of 9/10; the letter is a 7.5/10 now', 7.5],
  ['Rating - 9.2', 9.2],
  ['**Score: 9/10** (meets the bar)', 9],
  ['8.25/10', 8.3],
];
for (const [text, want] of scores) check(`score read from ${JSON.stringify(text)}`, RT.scoreIn(text) === want, RT.scoreIn(text));
check('...none when it gives none, or a number past 10', RT.scoreIn('Looks good, a few fixes.') === null && RT.scoreIn('') === null && RT.scoreIn('Score: 12/10') === null && RT.scoreIn('score: 85%') === null);

// ---- a reviewer agent's state as a round
check('a reviewer at work is a pending round', JSON.stringify(RT.fromAgent({ desc: 'Review cover letter round 2', state: 'working' })) === JSON.stringify({ type: 'review', round: 2, pending: true, derived: true }));
check('...done with a score: its score', RT.fromAgent({ desc: 'Review cover letter round 2', state: 'done', summary: 'Score: 8.4/10' })?.score === 8.4);
check('...stopped, failed, or done without a score: the pending chip goes', RT.fromAgent({ desc: 'Review round 2', state: 'stopped' })?.clear === true && RT.fromAgent({ desc: 'Review round 2', state: 'done', summary: 'fine' })?.clear === true);
check('...any other agent: nothing', RT.fromAgent({ desc: 'Edit the letter', state: 'done', summary: '9/10' }) === null);

// ---- merging rounds: one run, three rounds, live
let r = null;
r = RT.merge(r, { round: 1, score: 7.6, bar: 9, title: 'Divergent cover letter', fixes: ['Open with the role'] });
check('round 1 reported: the bar, the title, a score below the bar', r.bar === 9 && r.title === 'Divergent cover letter' && r.rounds.length === 1 && r.rounds[0].score === 7.6 && !r.rounds[0].met);
r = RT.merge(r, RT.fromAgent({ desc: 'Review cover letter round 2', state: 'working' }));
check('round 2 reviewing: a pending chip after R1', r.rounds.map((x) => (x.pending ? '…' : x.score)).join(' ') === '7.6 …' && !RT.over(r));
r = RT.merge(r, RT.fromAgent({ desc: 'Review cover letter round 2', state: 'working' }));
check('...the same round again stays one chip', r.rounds.length === 2);
r = RT.merge(r, RT.fromAgent({ desc: 'Review cover letter round 2', state: 'done', summary: 'Score: 8.4/10' }));
check('round 2 answered: its score at once (no review_round yet), trend +0.8', r.rounds[1].score === 8.4 && !r.rounds[1].pending && RT.trend(r) === 0.8 && RT.latest(r).round === 2);
r = RT.merge(r, { round: 2, score: 8.5, bar: 9, fixes: ['Cut the last line'] });
check("...the AI's own review_round wins over the read score", r.rounds[1].score === 8.5 && r.rounds[1].derived === false && r.rounds[1].fixes[0] === 'Cut the last line');
r = RT.merge(r, { round: 2, score: 8.1, derived: true });
check('...and a read score never overwrites it', r.rounds[1].score === 8.5);
r = RT.merge(r, { round: 2, pending: true, derived: true });
check('...nor does a pending round', r.rounds[1].score === 8.5 && !r.rounds[1].pending);
r = RT.merge(r, { round: 3, pending: true, derived: true });
check('round 3 reviewing: the loop is not over', !RT.over(r) && r.rounds.length === 3);
r = RT.merge(r, { round: 3, score: 9.1, derived: true });
check('round 3 meets the bar: met, over, trend +0.6', r.rounds[2].met && RT.over(r) && RT.trend(r) === 0.6, JSON.stringify(r));
check('rounds kept in order whatever order they come in', RT.merge(RT.merge(null, { round: 2, score: 8, bar: 9 }), { round: 1, score: 7, bar: 9 }).rounds.map((x) => x.round).join() === '1,2');
check('a derived round with no bar known uses the skill default (9)', RT.merge(null, { round: 1, score: 9, derived: true }).rounds[0].met && RT.barOf(RT.merge(null, { round: 1, score: 9, derived: true })) === 9);
const five = [1, 2, 3, 4, 5].reduce((acc, n) => RT.merge(acc, { round: n, score: 6 + n * 0.2, bar: 9.5 }), null);
check('the last round (5) below the bar: over', RT.over(five) && !RT.latest(five).met);
check('a clear removes only a pending chip', RT.merge(RT.merge(null, { round: 1, pending: true }), { round: 1, clear: true }).rounds.length === 0 && RT.merge(RT.merge(null, { round: 1, score: 7, bar: 9 }), { round: 1, clear: true }).rounds.length === 1);
check('bad rounds are ignored', RT.merge(null, { round: 0, score: 7 }).rounds.length === 0 && RT.merge(null, { round: 'x', score: 7 }).rounds.length === 0 && RT.merge(null, { round: 1, score: 11 }).rounds.length === 0);
const s = RT.saved(RT.merge(RT.merge(null, { round: 1, score: 7.6, bar: 9 }), { round: 2, pending: true }));
check('what is saved with the reply: scored rounds only', s && s.rounds.length === 1 && s.bar === 9 && RT.saved(RT.merge(null, { round: 1, pending: true })) === null, JSON.stringify(s));

// ---- the engine: each reviewer agent's round reaches the card as it happens
const { ClaudeCodeEngine } = require('../../src/ai/claude-code');
const engine = new ClaudeCodeEngine({ userData: fs.mkdtempSync(path.join(require('os').tmpdir(), 'rvt-')), mcpCommand: () => ({ command: process.execPath, args: ['-e', ''], env: {} }), ensureServer: () => {}, keepAlive: false, spawn: () => { throw new Error('no spawn'); } });
const sent = [];
const proc = { turn: {}, sink: { emit: (e) => sent.push(e) } };
engine.sayAgent(proc, { id: 'T2', desc: 'Review cover letter round 2', state: 'working', startedAt: 1 });
engine.sayAgent(proc, { id: 'T2', desc: 'Review cover letter round 2', state: 'done', summary: 'Score: 8.4/10. Fixes: ...', startedAt: 1, endedAt: 2 });
engine.sayAgent(proc, { id: 'T9', desc: 'Tighten paragraph 2', state: 'done', summary: 'Done', startedAt: 1, endedAt: 2 });
check('the engine sends a reviewer\'s round: pending, then its score', sent.filter((e) => e.type === 'review').map((e) => (e.pending ? 'pending' : e.score)).join() === 'pending,8.4', JSON.stringify(sent));
check('...and every agent\'s own state as before, none for a worker', sent.filter((e) => e.type === 'agent').length === 3 && sent.filter((e) => e.type === 'review').length === 2);

// ---- the Agents card: a reviewer's score beside Done; drawn again from an older save, an agent that ended here is not Stopped
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this._text = ''; this.className = ''; this.hidden = false; this.parent = null; this.listeners = {}; }
  get classList() { const self = this; const set = () => new Set(String(self.className).split(/\s+/).filter(Boolean)); return { add: (...c) => { const x = set(); c.forEach((v) => x.add(v)); self.className = [...x].join(' '); }, remove: (...c) => { const x = set(); c.forEach((v) => x.delete(v)); self.className = [...x].join(' '); }, toggle: (c, on) => { const x = set(); if (on ?? !x.has(c)) x.add(c); else x.delete(c); self.className = [...x].join(' '); }, contains: (c) => set().has(c) }; }
  set innerHTML(v) { this._html = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(k, f) { this.listeners[k] = f; }
  append(...n) { for (const c of n) { if (typeof c === 'object') c.parent = this; this.children.push(c); } }
  get isConnected() { return true; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  all(cls) { const out = []; const walk = (e) => { if (e.classList?.contains?.(cls)) out.push(e); (e.children || []).forEach(walk); }; walk(this); return out; }
  querySelector() { return null; }
}
const sandbox = { document: { createElement: (t) => new El(t), querySelectorAll: () => [] }, setInterval: () => 1, clearInterval() {}, console };
sandbox.window = sandbox;
sandbox.t = (k, v = {}) => ({ 'agents.score': `${v.score}/10`, 'agents.state.done': 'Done', 'agents.state.stopped': 'Stopped', 'agents.state.working': 'Working' }[k] || k);
sandbox.reviewTrack = RT;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'agents-card.js'), 'utf8'), sandbox, { filename: 'agents-card.js' });
const AC = sandbox.agentsCard;
const turn = { cards: [] };
let placed = null;
const r2 = { id: 'T2', desc: 'Review cover letter round 2', background: true, state: 'working', startedAt: Date.now() - 5000 };
const r3 = { id: 'T3', desc: 'Review cover letter round 3', background: true, state: 'working', startedAt: Date.now() - 3000 };
AC.update(turn, { type: 'agent', ...r2 }, (n) => { placed = n; });
AC.update(turn, { type: 'agent', ...r3 }, () => {});
AC.update(turn, { type: 'agent', ...r2, state: 'done', summary: 'Score: 8.4/10. Fixes: open with the role.', endedAt: Date.now() }, () => {});
const rowOf = (card, i) => card.all('ag-row')[i];
const scoreOf = (row) => row.all('ag-score')[0];
check("a reviewer's row shows its score beside Done", scoreOf(rowOf(placed, 0)).hidden === false && scoreOf(rowOf(placed, 0)).textContent === '8.4/10' && rowOf(placed, 0).dataset.state === 'done', JSON.stringify(rowOf(placed, 0).dataset));
check('...one still reviewing shows none, and is working', scoreOf(rowOf(placed, 1)).hidden === true && rowOf(placed, 1).dataset.state === 'working');
// The chat drawn again from the save made when the first turn ended (both agents working then): round 2 ended since (Done, its score), round 3 works on.
const redrawn = AC.restore([r2, r3]);
check('drawn again from an older save: an agent that ended here is Done with its score, not Stopped', rowOf(redrawn, 0).dataset.state === 'done' && scoreOf(rowOf(redrawn, 0)).textContent === '8.4/10', JSON.stringify(rowOf(redrawn, 0).dataset));
check('...and one still working here is working, not Stopped', rowOf(redrawn, 1).dataset.state === 'working');
const cold = AC.restore([{ id: 'T7', desc: 'Review round 1', state: 'working', startedAt: 1 }]);
check('...an agent never heard here (a chat reopened after a restart) is Stopped, as before', rowOf(cold, 0).dataset.state === 'stopped');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall review-track units passed');
process.exit(failures ? 1 : 0);
