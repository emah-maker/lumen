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
