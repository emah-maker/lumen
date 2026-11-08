// Plain Node: [card tabs] the items a busy run works on, read off its agents' names (renderer/card-items.js), and when the Agents card switches to
// tabs (more than 3 agents, or two items or more with an id each). The tabs themselves: agents-card.js paintTabs, test/e2e/live-card-tabs.js.
const fs = require('fs');
const path = require('path');
const CI = require('../../src/renderer/card-items');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');
const key = (d) => CI.itemOf(d).key;

// The item an agent works on.
check('a section number is the item', key('Build 4.2 Gaussian elimination deck') === '4.2' && CI.itemOf('Build 4.2 deck').explicit === true);
check('its reviewer works on the same item (the round is not the item)', key('Review 4.2 deck round 2') === '4.2' && key('Rate 4.2 R3') === '4.2');
check('an issue number is the item', key('Fix #812 crash on open') === '#812');
check('a file name is the item', key('Write cp34.js') === 'cp34.js' && CI.itemOf('Polish Cover Letter.docx').label === 'Letter.docx');
check('no id: the name without its verb and round', key('Review cover letter round 2') === 'cover letter' && key('Build the cover letter') === 'cover letter' && CI.itemOf('Build cover letter').explicit === false);
check('a name that is only a verb has no item of its own', key('Explore') === '');

// Grouping.
const ag = [
  { id: 'a1', desc: 'Build 4.2 deck', state: 'done', startedAt: 1000, endedAt: 5000 },
  { id: 'a2', desc: 'Build 4.3 deck', state: 'working', startedAt: 2000 },
  { id: 'r1', desc: 'Review 4.2 deck round 1', state: 'done', summary: 'Score: 7.4/10. Tighten the examples.', startedAt: 5000, endedAt: 8000 },
  { id: 'r2', desc: 'Review 4.2 deck round 2', state: 'done', summary: 'Score: 8.6/10', startedAt: 8000, endedAt: 9000 },
];
const g = CI.group(ag);
check('agents group by item, in the order first heard', g.map((x) => x.key).join() === '4.2,4.3' && g[0].ids.join() === 'a1,r1,r2' && g[1].ids.join() === 'a2', JSON.stringify(g.map((x) => [x.key, x.ids])));
check('an item\'s score is its latest round', g[0].score === 8.6 && g[0].rounds.map((x) => x.score).join() === '7.4,8.6' && g[1].score === null);
check('an item works while any of its agents does; done when all are', g[0].state === 'done' && g[1].state === 'working');
check('an item\'s clock runs from its first agent to its last one ending', g[0].startedAt === 1000 && g[0].endedAt === 9000 && g[1].endedAt === null);
check('a reviewer still at work is a pending round', CI.group([{ id: 'r', desc: 'Review 4.2 round 3', state: 'working', startedAt: 1 }])[0].rounds[0]?.pending === true);
const failed = CI.group([{ id: 'x', desc: 'Build 5.1 deck', state: 'failed', startedAt: 1, endedAt: 2 }, { id: 'y', desc: 'Build 5.2 deck', state: 'done', startedAt: 1, endedAt: 2 }]);
check('an item whose agent failed needs the user (its tab gets a badge)', failed[0].state === 'failed' && failed[0].needsUser === true && failed[1].needsUser === false);
check('verb-only names stay apart, one item each', CI.group([{ id: 'p', desc: 'Explore', state: 'working' }, { id: 'q', desc: 'Explore', state: 'working' }]).length === 2);
check('bad input groups to nothing', CI.group(null).length === 0 && CI.group([null, { desc: 'no id' }]).length === 0);

// The threshold: a small run keeps one list.
const agent = (id, desc) => ({ id, desc, state: 'working', startedAt: 1 });
check('one agent: no tabs', CI.tabbed([agent('a', 'Build 4.2 deck')]) === false);
check('two agents on one item: no tabs', CI.tabbed([agent('a', 'Build 4.2 deck'), agent('b', 'Review 4.2 deck round 1')]) === false);
check('two unrelated helpers without ids: no tabs', CI.tabbed([agent('a', 'Search the docs'), agent('b', 'Run the tests')]) === false);
check('three agents without ids: no tabs', CI.tabbed([agent('a', 'Search the docs'), agent('b', 'Run the tests'), agent('c', 'Read the logs')]) === false);
check('two items with an id each: tabs', CI.tabbed([agent('a', 'Build 4.2 deck'), agent('b', 'Build 4.3 deck')]) === true);
check('one item, however many agents (a review loop of 5 rounds): no tabs', CI.tabbed([agent('w', 'Write cover letter'), ...[1, 2, 3, 4, 5].map((n) => agent(`r${n}`, `Review cover letter round ${n}`))]) === false);
check('more than 3 agents on two items or more: tabs, whatever their names', CI.tabbed(['a', 'b', 'c', 'd'].map((id) => agent(id, 'Explore'))) === true && CI.MAX_FLAT === 3);

// The wiring: card-items.js loads before agents-card.js on both pages, and the Agents card draws its tabs from it.
const core = read('src/renderer/chat-core.js');
check('the sidebar loads card-items.js before agents-card.js', /script\('card-items\.js'\)\)\.then\(\(\) => script\('agents-card\.js'\)\)/.test(core));
const page = read('src/renderer/chat-page.html');
check('the chat page loads card-items.js before agents-card.js', page.indexOf('<script src="card-items.js">') > -1 && page.indexOf('<script src="card-items.js">') < page.indexOf('<script src="agents-card.js">'));
const card = read('src/renderer/agents-card.js');
check('the Agents card repaints its tabs with its head, from window.cardItems', /paintTabs\(card\);\n {2}\}/.test(card) && /window\.cardItems/.test(card) && /role', 'tablist'/.test(card) && /role', 'tab'\)/.test(card) && /role', 'tabpanel'/.test(card));
check('arrow keys, Home and End move between tabs', /ArrowRight/.test(card) && /ArrowLeft/.test(card) && /'Home'/.test(card) && /'End'/.test(card));
const en = JSON.parse(read('src/locales/en.json'));
check('the tab strings exist', ['agents.tabs.label', 'agents.tabs.main', 'agents.tab.needs'].every((k) => typeof en[k] === 'string' && en[k]));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
