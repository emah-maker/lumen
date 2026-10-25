// Plain Node: what makes the chat page usable sooner at start-up (the wiring is timed by test/e2e/chat-tab-speed.js):
// the page's scripts are fetched together (preload hints), a saved session with a chat page in front opens it before the ad blocker's engine loads,
// and the chat list's dates use one Intl formatter per shape.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');

// ---- the chat page's scripts load in parallel: each <script src> has a preload hint in the head, and each hint has its script
const html = read('src/renderer/chat-page.html');
const head = html.slice(0, html.indexOf('</head>'));
const scripts = [...html.slice(html.indexOf('</head>')).matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const hints = [...head.matchAll(/<link rel="preload" as="script" href="([^"]+)" \/>/g)].map((m) => m[1]);
check('the page lists its scripts', scripts.length > 40, scripts.length);
check('every script has a preload hint (they were fetched one after another, ~2 ms each)', scripts.every((s) => hints.includes(s)), scripts.filter((s) => !hints.includes(s)).join());
check('and every hint is for a script the page runs (a stale hint downloads a file for nothing)', hints.every((h) => scripts.includes(h)), hints.filter((h) => !scripts.includes(h)).join());
check('the hints keep the script order', hints.join() === scripts.join(), '');

// ---- a session with the chat page in front does not wait for the ad blocker (its engine loads in one ~0.4 s block of the main process, which kept
// the window's page from committing), and loads it once that tab has loaded
const main = read('src/main.js');
const fn = main.slice(main.indexOf('function chatPageInFront()'), main.indexOf('function restoreSession('));
check('a session whose front tab is the chat page is told apart (new tab and chosen pages do not restore it)', fn.includes("['newtab', 'pages'].includes(settingsBackend.startupPlan().mode)") && fn.includes('isChatUrl(urls[Math.min(Math.max(0, saved.active || 0), urls.length - 1)])'), fn);
const ready = main.slice(main.indexOf('const chatFirst = chatPageInFront();'), main.indexOf("perf.mark('adblockReady')"));
check('with the chat page in front the ad blocker is not started with the window, and the tabs do not wait for it', ready.includes('const blocking = chatFirst ? null : startBlocker();') && ready.includes("atMost(fs.existsSync(path.join(app.getPath('userData'), 'adblock-engine.bin')) ? blocking : null)"), ready);
check('it is the first job of the start-up queue (after the first tab has loaded), and only then', main.includes("if (chatFirst) startup.add('ad blocker', startBlocker, { priority: 0 });"), '');
check('every other start still starts it with the window (right after the window and the extensions are asked for)', main.indexOf('createWindow(); //') < main.indexOf('const extending = setupExtensions()') && main.indexOf('const extending = setupExtensions()') < main.indexOf('const startBlocker = () => adblock.setup()') && main.includes("const startBlocker = () => adblock.setup().then(() => perf.mark('adblockSetup'))"), '');


// ---- the chat list's dates: same text as toLocale*String, from cached formatters
const items = read('src/renderer/chat-items.js');
check('chat-items.js no longer builds a formatter per row', !/toLocale(Time|Date)String/.test(items), '');
const d = new Date(2026, 2, 9, 14, 5);
const shapes = [{ hour: 'numeric', minute: '2-digit' }, { month: 'short', day: 'numeric' }, { month: 'short', day: 'numeric', year: 'numeric' }, { month: 'long', year: 'numeric' }];
check('an Intl formatter gives the same text as the toLocale call it replaced', shapes.every((o) => new Intl.DateTimeFormat([], o).format(d) === (o.hour ? d.toLocaleTimeString([], o) : d.toLocaleDateString([], o))), '');

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
