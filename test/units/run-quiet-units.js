// Plain Node: [quiet run] a run that goes on after one of its turns ends keeps the chat quiet until it is over (renderer/run-quiet.js, wired in
// chat-core.js finishTurn / offerSkill / fileAgain and step-ui.js runGoesOn / fold): what that turn said folds into the card, a file written again
// is its card updated, the skill offer comes once per run at its end, and a turn inside the run gets no suggestions or Try again.
const fs = require('fs');
const path = require('path');
const Q = require('../../src/renderer/run-quiet');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');

// ---- status folding
check('a status line folds into the card', Q.interim("I've started three reviewers.\n\nI'll check back when they finish.") === "I've started three reviewers. I'll check back when they finish.");
check('words that ask the user stay in the chat', Q.interim('Which deck should I do first?') === '' && Q.interim('Should I keep going? ') === '' && Q.interim('**Want me to push it?**') === '');
check('a question in the middle is not the end: still folded', Q.interim('Why so slow? The PDF is big. Waiting on the agents.') !== '');
check('an approval waiting: the words stay in the chat', Q.interim('Running the build.', { waiting: true }) === '');
check('nothing said: nothing to fold', Q.interim('') === '' && Q.interim('   \n ') === '' && Q.interim(null) === '');
check('asks() reads the end only', Q.asks('Done. Anything else?') && !Q.asks('Done.') && Q.asks('Ready? (y/n)?'));

// ---- the final answer drops its status filler (the card said it)
const shot = 'Four agents are running. Three are building the 4.4, 4.6 and 6.1 decks, and one is doing the first review round on the existing 4.3 deck. I\'m waiting on their results before the next review rounds.\n\nStatus: the 4.4, 4.6 and 6.1 decks are being built and the 4.3 deck is in its first review. I\'ll start a fresh reviewer for each deck as it finishes.';
check('the screenshot\'s two paragraphs are all filler', Q.filler(shot) && Q.finalReply(shot) === shot, Q.finalReply(shot));
check('an answer with a "Status:" paragraph keeps only the answer', Q.finalReply('All four decks pass the bar: 4.3 10, 4.4 10, 4.6 10, 6.1 10.\n\nStatus: done.') === 'All four decks pass the bar: 4.3 10, 4.4 10, 4.6 10, 6.1 10.');
check('...and "**Status:**" too', Q.finalReply('The fix is in.\n\n**Status:** all agents finished.') === 'The fix is in.');
check('a closing "I\'ll … as it finishes" or "I\'m waiting on…" sentence goes, the rest of its paragraph stays', Q.finalReply('Here is the summary. I\'ll start a fresh reviewer for each deck as it finishes.') === 'Here is the summary.' && Q.finalReply('Deck 4.3 is at 9.6. I\'m waiting on the last reviewer.') === 'Deck 4.3 is at 9.6.');
check('a paragraph about agents still running goes', Q.finalReply('Two decks are done.\n\nThe reviewers are still running on the rest.') === 'Two decks are done.');
check('never empties a reply, never touches content', Q.finalReply('Status: done.') === 'Status: done.' && Q.finalReply('The status of the build is green.') === 'The status of the build is green.' && Q.finalReply('I\'ll explain how it works.') === 'I\'ll explain how it works.' && Q.finalReply('Done.\n\nUpdate: the API changed in v3.') === 'Done.\n\nUpdate: the API changed in v3.');
check('lists, code, headings and questions are content', Q.finalReply('Done.\n\n- Status: ok\n- Waiting on: none') === 'Done.\n\n- Status: ok\n- Waiting on: none' && Q.finalReply('Done.\n\n```\nStatus: x\n```') === 'Done.\n\n```\nStatus: x\n```' && Q.finalReply('Done.\n\n## Status: shipped') === 'Done.\n\n## Status: shipped' && Q.finalReply('Done.\n\nStatus: should I push it?') === 'Done.\n\nStatus: should I push it?');
check('bold in a kept sentence stays', Q.finalReply('**4.3** scores 10. I\'m waiting on nothing.') === '**4.3** scores 10.');
check('filler() is true only when everything is filler', Q.filler('Status: building.') && !Q.filler('Done.') && !Q.filler('') && !Q.filler('Done.\n\nStatus: x'));

// ---- one run, one card, also when the chat is drawn again (the user's duplicate: "Files changed" card, a chat paragraph, then a "Computer" card
// repeating the skill chip, "4 things at once" and the review bar)
{
  const review = { bar: 10, title: 'Review', rounds: [{ round: 1, score: 8.3, met: false }] };
  const ask = { role: 'user', text: 'review the decks until they are good' };
  const t1 = { role: 'assistant', cards: true, tools: [{ name: 'Skill', label: 'Using review' }, { name: 'Agent', label: 'Build 4.6' }], text: 'Four agents are running.', interim: true, skills: [{ name: 'review', title: 'Review until it\'s good' }], review, agents: [{ id: 'a1', state: 'working' }], touched: [3], thinking: 'plan', thinkingMs: 1000 };
  const t2 = { role: 'assistant', cards: true, tools: [{ name: 'Agent', label: 'Fix 4.6' }], text: '4.6 scored 8.3/10 in round 1, and a fixer is working on it.', interim: true, skills: t1.skills, review, agents: [{ id: 'a1', state: 'done' }, { id: 'a2', state: 'working' }], touched: [3, 4] };
  const t3 = { role: 'assistant', cards: true, tools: [{ name: 'Bash', label: 'Creating pg' }], text: 'All four decks pass: 10/10.', skills: t1.skills, review: { ...review, rounds: [...review.rounds, { round: 2, score: 10, met: true }] }, agents: [{ id: 'a1', state: 'done' }, { id: 'a2', state: 'done' }], touched: [4, 5] };
  const items = [ask, t1, t2, t3];
  const { merged, earlier } = Q.oneCardPerRun(items);
  const one = merged.get(t3);
  check('a run with in-between text between its helper turns draws exactly one card', merged.size === 1 && earlier.size === 2 && earlier.has(t1) && earlier.has(t2) && !merged.has(t1) && !merged.has(t2), `${merged.size} ${earlier.size}`);
  check('...with every turn\'s steps, in order', JSON.stringify(one.tools.map((x) => x.label)) === JSON.stringify(['Using review', 'Build 4.6', 'Fix 4.6', 'Creating pg']), JSON.stringify(one.tools));
  check('...the last turn\'s agents, skill and review (once, not per turn)', one.agents.length === 2 && one.agents.every((a) => a.state === 'done') && one.review.rounds.length === 2 && one.skills[0].name === 'review');
  check('...the tabs it touched once each, its thinking together, the answer\'s text', JSON.stringify(one.touched) === '[3,4,5]' && one.thinking === 'plan' && one.thinkingMs === 1000 && one.text === 'All four decks pass: 10/10.');
  check('a message of the user\'s between two cards: two exchanges, two cards', Q.oneCardPerRun([ask, t1, { role: 'user', text: 'next' }, t3]).merged.size === 0);
  check('a message sent mid-run does not split the run\'s card', Q.oneCardPerRun([ask, t1, { role: 'user', text: 'also 6.2', steered: true }, t3]).merged.size === 1);
  check('one card turn: nothing to merge; text-only turns are not cards', Q.oneCardPerRun([ask, { role: 'assistant', text: 'hi' }, t3]).merged.size === 0 && Q.oneCardPerRun([]).merged.size === 0 && Q.oneCardPerRun(null).merged.size === 0);
}

// ---- file card dedupe
check('one key per path, whatever the slashes and case', Q.fileKey({ path: 'C:\\Decks\\4.2.pptx' }) === Q.fileKey({ path: 'c:/decks//4.2.PPTX' }));
check('different files, different keys', Q.fileKey({ path: 'C:/a/one.md' }) !== Q.fileKey({ path: 'C:/a/two.md' }));
check('a file with only a name keys by its name; none at all has no key', Q.fileKey({ name: 'notes.md' }) === 'notes.md' && Q.fileKey({}) === '' && Q.fileKey(null) === '');

// ---- one skill offer per run
const gate = Q.offerGate();
const run = {};
const o1 = { token: 't1' };
const o2 = { token: 't2' };
gate.hold(run, o1);
gate.hold(run, o2);
check('offers for turns inside the run wait; none shows yet', !gate.shown(run));
check('the run ends: the newest held offer shows, once', gate.release(run) === o2 && gate.release(run) === null && gate.shown(run));
check('...and a later offer for the same run does not show (No thanks or not)', gate.show(run, { token: 't3' }) === null);
const run2 = {};
check('a run that never went on: its offer shows at once, and only once', gate.show(run2, o1) === o1 && gate.show(run2, o2) === null);
const run3 = {};
check('nothing held: release shows nothing', gate.release(run3) === null && !gate.shown(run3));
check('bad input does nothing', gate.show(null, o1) === null && gate.release(null) === null && (gate.hold(null, o1), true));

// ---- the wiring
const core = read('src/renderer/chat-core.js');
const finish = core.slice(core.indexOf('function finishTurn('), core.indexOf('\n}\n', core.indexOf('function finishTurn(')));
check('finishTurn asks the card whether the run goes on', /const goesOn = [^\n]*window\.stepUI\?\.runGoesOn\?\.\(turn\)/.test(finish));
check('...folds what the turn said into the card, its bubble out of sight', /runQuiet\.interim\(turn\.textSource, \{ waiting: approvals\.size > 0 \}\)/.test(finish) && /window\.stepUI\.fold\(turn, folded\); foldBubble\(turn\);/.test(finish) && /\.msg\.run-folded \{ display: none; \}/.test(read('src/renderer/styles.css')));
check('...no Try again row and no reply suggestions for a turn inside the run', /if \(!goesOn && !turn\.failed/.test(finish) && /const clean = !goesOn &&/.test(finish));
check('...a turn that ends the run drops the folded words before it, and its skill offer shows', /if \(!goesOn\) \{ dropFolded\(turn\); if \(!early\) releaseOffer\(turn\); \}/.test(finish));
check('...every block it said since its last step folds, not just the last one', /if \(folded\) for \(const el of blocksBefore\) el\.remove\(\);/.test(finish));
check('...words streamed into the card come back as the answer when the run is over (or they ask)', /if \(!folded && turn\.text\?\.dataset\.liveFold\) \{ turn\.text\.hidden = false;/.test(finish));
check('...the final answer of a run with a card drops its status filler', /if \(!goesOn && !turn\.failed && turn\.cards\?\.length && window\.runQuiet && turn\.text\)/.test(finish) && /window\.runQuiet\.finalReply\(turn\.textSource\)/.test(finish) && /window\.runQuiet\.filler\(el\.source/.test(finish));
const textCase = core.slice(core.indexOf("    case 'text': {"), core.indexOf("    case 'retry':"));
check('words that stream while the run goes on are the card\'s live line, never a bubble', /approvals\.size === 0 && window\.stepUI\?\.runGoesOn\?\.\(turn\)\) \{ turn\.text\.hidden = true; turn\.text\.classList\.add\('run-folded'\)/.test(textCase) && /window\.stepUI\?\.narrate\(turn, paras\[paras\.length - 1\]/.test(textCase));
const toolCase = core.slice(core.indexOf("    case 'tool': {"), core.indexOf("    case 'desktop_card':"));
check('all the blocks said before a step move into the card (any engine)', /const said = \[\.\.\.\(turn\.saidBlocks \|\| \[\]\)/.test(toolCase) && /for \(const el of said\) el\.remove\(\);/.test(toolCase) && /\(turn\.saidBlocks \|\|= \[\]\)\.push\(turn\.text\)/.test(core));
const draw = core.slice(core.indexOf('function drawItems('), core.indexOf('function renderLatest('));
check('a chat drawn again shows no bubble for an interim turn (unless it asks), and the answer without filler', /if \(item\.interim && !window\.runQuiet\?\.asks\(item\.text\)/.test(draw) && /window\.runQuiet\.finalReply\(item\.text\)/.test(draw) && /!items\[lastIndex\]\.interim\)/.test(core));
check('a chat drawn again draws one card per run: the earlier turns draw nothing (a question still shows), the last the merged card', /const oneRun = window\.runQuiet\?\.oneCardPerRun/.test(draw) && /if \(oneRun\.earlier\.has\(raw\)\) \{\s*\/\/[^\n]*\n\s*if \(raw\.text && window\.runQuiet\.asks\(raw\.text\)\)[^\n]*\n\s*continue;/.test(draw) && /const item = oneRun\.merged\.get\(raw\) \|\| raw;/.test(draw));
// ---- the card holds its height while it works: its lines are clamped, and the agents list scrolls inside a set height
const css = read('src/renderer/step-ui.css');
check('the card\'s say line is two lines, filled or not; its live lines one line each with an ellipsis', /\.act-say \{[^}]*-webkit-line-clamp: 2;/.test(css) && /\.card-steady \.act-say \{ min-height: 2lh; \}/.test(css) && /\.card-steady :is\(\.act-sub, \.act-status-text[^)]*\)[^{]*\{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/.test(css));
check('the agents (and a tabbed card\'s items) are at most four rows tall while it works: more scroll inside, the card does not grow', /\.card-steady :is\(\.ag-list, \.ag-items\) \{ max-height: calc\(4 \* var\(--ag-row-h\) \+ 3 \* var\(--sp-3\)\); overflow-y: auto;/.test(css) && /\.card-steady \{ --ag-row-h: calc\(/.test(css));
const main = read('src/main.js');
check('main marks a turn interim when its run goes on (helpers, agents), and the turn before a follow-up', /function runGoesOnAfter\(run\)/.test(main) && /if \(done\) info\.interim = !run\.error && !run\.stopped && runGoesOnAfter\(run\);/.test(main) && /agent\.stampMessages\(run\.messages, run\.startLen, \{ interim: true \}\)/.test(main) && /\(run\.liveHelpers \|\|= new Set\(\)\)\.add\(msg\.id\)/.test(main));
const over = core.slice(core.indexOf('function runOver('), core.indexOf('function releaseOffer('));
check('a run that ends on its last agent: its newest folded words are the answer (shown, with suggestions), then its offer', /bubble\.hidden = false;/.test(over) && /lumen:reply-done/.test(over) && /releaseOffer\(t\);/.test(over));
check('a skill offer goes through the gate', /if \(event\.type === 'skill_offer'\) \{[^\n]*offerSkill\(event\)/.test(core) && /skillOffers\.hold\(runOf\(t\), event\)/.test(core));
check('the last agent or helper of a run that ended ends it', /if \(t !== turn\) runOver\(t\)/.test(core) && /case 'helper': window\.stepUI\?\.helper\(t, event\); runOver\(t\);/.test(core));
check('a file written again updates its card (live and late)', (core.match(/if \(fileAgain\(event\.file, cardEl\)\)/g) || []).length === 2 && (core.match(/fileShown\(event\.file, bubble\)/g) || []).length === 2);
const step = read('src/renderer/step-ui.js');
check('step-ui says whether a run goes on, and shows the folded line while it does', /function runGoesOn\(turn\)/.test(step) && /function fold\(turn, text\)/.test(step) && /const saying = \(state === 'working' \|\| state === 'helper'\)/.test(step) && /runGoesOn, fold \};/.test(step));
check('both pages load run-quiet.js before chat-core.js', ['src/renderer/index.src.html', 'src/renderer/chat-page.html'].every((f) => { const h = read(f); return h.indexOf('<script src="run-quiet.js">') > -1 && h.indexOf('<script src="run-quiet.js">') < h.indexOf('<script src="chat-core.js">'); }));
const en = JSON.parse(read('src/locales/en.json'));
check('the update strings exist', typeof en['aifile.updated'] === 'string' && en['aifile.updatedTag'] === 'Updated');
check('the updated card flashes (and not with reduced motion)', /\.msg\.ai-files\.ai-file-updated > \.ai-file \{ animation: ai-file-updated/.test(read('src/renderer/styles.css')));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
