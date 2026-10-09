// Plain Node: what the AI button does when it opens the sidebar (renderer/sidebar-open.js, wired in renderer/app.js):
// start a new chat, reuse an empty one, or keep the chat that was open (setting off, or the open carries an intent).
const fs = require('fs');
const path = require('path');
const { sidebarOpenPlan } = require('../src/renderer/sidebar-open');
const { DEFAULTS, validate } = require('../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const plan = (o) => sidebarOpenPlan(o);

// the decision
check('on, chat has messages: a new chat', plan({ setting: true, empty: false }) === 'new');
check('on, chat already empty: reuse it (empty chats do not pile up)', plan({ setting: true, empty: true }) === 'reuse');
check('off, chat has messages: keep the chat as it was', plan({ setting: false, empty: false }) === 'keep');
check('off, chat empty: keep', plan({ setting: false, empty: true }) === 'keep');
check('an intent (a chat to show, Ask AI, an approval, an agent event) always keeps the chat, setting on', plan({ setting: true, empty: false, intent: true }) === 'keep' && plan({ setting: true, empty: true, intent: true }) === 'keep');
check('an intent keeps it with the setting off too', plan({ setting: false, intent: true }) === 'keep');
check('no arguments: the setting counts as on (the default), the chat as not empty... unless told', plan() === 'new' && plan({ empty: true }) === 'reuse');

// the setting
check('setting: on by default, a real on/off value', DEFAULTS.sidebarNewChat === true && validate('sidebarNewChat', false) === false && validate('sidebarNewChat', 'no') === null, JSON.stringify([DEFAULTS.sidebarNewChat, validate('sidebarNewChat', false), validate('sidebarNewChat', 'no')]));
const backend = read('src/settings/settings-backend.js');
check('setting: carried to the UI with the other preferences, and a change is pushed at once', /sidebarNewChat: p\.sidebarNewChat !== false/.test(backend) && /key === 'sidebarNewChat'\)/.test(backend));
check('setting: ui-prefs.js keeps it where app.js reads it', /window\.lumenSidebarNewChat = p\.sidebarNewChat !== false/.test(read('src/renderer/ui-prefs.js')));
const settings = read('src/renderer/settings.js');
const en = JSON.parse(read('src/locales/en.json'));
check('Settings > AI: a "Sidebar button starts a new chat" switch, placed before "One chat per tab", with a short description', settings.indexOf("toggle('sidebarNewChat'") > 0 && settings.indexOf("toggle('sidebarNewChat'") < settings.indexOf("toggle('oneChatPerTab'") && en['settings.ai.sidebarNewChat'] === 'Sidebar button starts a new chat' && en['settings.ai.sidebarNewChatDesc'].length < 130);

// the wiring: only the button and its shortcut ask; every other way to open the sidebar keeps its chat
const app = read('src/renderer/app.js');
check('app.js: the button and the Ctrl+J event both go through toggleSidebarByHand', /\$\('toggle-sidebar'\)\.onclick = \(\) => \{[\s\S]*?toggleSidebarByHand\(\);/.test(app) && /onToggleSidebar\(\(\) => toggleSidebarByHand\(\)\)/.test(app));
check('app.js: a new chat is only started when the sidebar is closed (opening), through the New chat button', /if \(opening\) \{[\s\S]*?sidebarOpenPlan\([\s\S]*?plan === 'new'\) \$\('new-chat'\)\.click\(\)/.test(app));
check('app.js: a run waiting for an OK counts as an intent', /dataset\.attention === 'approval'/.test(app) && /approval-pending/.test(app));
check('app.js: a notification, a chat to show and the "Ask AI" routes open the sidebar with showSidebar(true), never the toggle', /onOpenChat\?\.\(async[\s\S]*?showSidebar\(true\)/.test(app) && /needSidebar = \(\) => \{[^}]*showSidebar\(true\)/.test(app));
check('tasks and research panels open the sidebar without a new chat', /showSidebarFor/.test(read('src/renderer/tasks.js')) && /showSidebarFor/.test(read('src/renderer/research.js')) && /window\.showSidebarFor = /.test(app));
check('index.src.html loads sidebar-open.js before app.js', (() => { const h = read('src/renderer/index.src.html'); return h.indexOf('sidebar-open.js') > 0 && h.indexOf('sidebar-open.js') < h.indexOf('src="app.js"'); })());

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
