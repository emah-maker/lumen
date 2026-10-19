// Plain Node: the toolbar's "<AI> is using this tab" pill belongs to the tab the task works in (renderer/agent-pill.js,
// wired in renderer/chat-core.js renderWorkingIn and styles.css). It used to show on every tab while a task ran.
const fs = require('fs');
const path = require('path');
const { pillState } = require('../src/renderer/agent-pill');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

const inTab = { id: 3, front: true };
const away = { id: 3, front: false };
check('nothing running: no pill', pillState({ running: false, target: inTab }).visible === false && pillState({ running: false, target: away }).visible === false);
check('running in the tab in front: pill, "using this tab"', (() => { const s = pillState({ running: true, target: inTab }); return s.visible && !s.away && s.textKey === 'agent.usingTab'; })());
check('running in another tab: no pill on this one', (() => { const s = pillState({ running: true, target: away }); return !s.visible && s.away; })());
check('switching tabs follows: away, back to front, away again', [away, inTab, away].map((t) => pillState({ running: true, target: t }).visible).join() === 'false,true,false');
check('run start, target not told yet: counts as the tab in front', pillState({ running: true, target: null }).visible === true);
check('run ended: target dropped, pill gone', pillState({ running: false, target: null }).visible === false);
check('an outside agent\'s pill is not hidden by a task in another tab', pillState({ running: true, target: away, mcpActive: true }).visible === true);

// The wiring: the page toggles agent-away from the helper, and the stylesheet hides the pill under it.
const core = read('src/renderer/chat-core.js');
check('chat-core toggles agent-away from pillState', /agentPill\.pillState\(\{ running, target: agentTarget \}\)/.test(core) && /toggle\('agent-away', state\.away\)/.test(core));
check('styles hide the pill when away (not for an outside agent)', /body\.agent-active\.agent-away:not\(\.mcp-active\) \.agent-pill \{ display: none; \}/.test(read('src/renderer/styles.css')));
check('both pages load agent-pill.js before chat-core.js', ['src/renderer/index.src.html', 'src/renderer/chat-page.html'].every((f) => { const h = read(f); return h.indexOf('<script src="agent-pill.js">') > -1 && h.indexOf('<script src="agent-pill.js">') < h.indexOf('<script src="chat-core.js">'); }));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
