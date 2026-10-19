// Sidebar wording and layout rules from the UX audit (docs/ux-audit/sidebar.md), checked against the sources in plain Node.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const en = JSON.parse(read('src', 'locales', 'en.json'));
const core = read('src', 'renderer', 'chat-core.js');

check('the "always allow" approval button says what it covers', en['approval.allSites'] === 'Always allow, any site', en['approval.allSites']);
check('its second click says to confirm', /confirm/i.test(en['approval.allSites.confirm']), en['approval.allSites.confirm']);
check('the page chip button is an action ("Turn off AI here"), not a state', en['context.aiOff'] === 'Turn off AI here' && en['context.aiOn'] === 'Turn on AI here', `${en['context.aiOff']} / ${en['context.aiOn']}`);
check('the stop button names its shortcut', /Esc/.test(en['composer.stop']), en['composer.stop']);
check('the clock button says history', /history/i.test(en['sidebar.chats']), en['sidebar.chats']);
for (const k of ['slash.think.description', 'slash.deep.description', 'slash.fast.description']) check(`${k} says it needs Auto`, /needs auto/i.test(en[k]) && en[k].length < 80, en[k]);
check('a chain of fallback notices keeps only the newest', /querySelectorAll\('\.notice\[data-fallback\]'\)/.test(core) && /notice\.dataset\.fallback = '1'/.test(core));
check('slash and model descriptions wrap to two lines instead of one cut-off line', /line-clamp: 2/.test(read('src', 'renderer', 'slash.css')) && /line-clamp: 2/.test(read('src', 'renderer', 'picker.css')));
check('starter chips look like buttons (border, pointer, focus ring)', /\.chip \{[^}]*border: 0\.5px solid[^}]*cursor: pointer/.test(read('src', 'renderer', 'styles.css')) && /\.chip:focus-visible/.test(read('src', 'renderer', 'styles.css')));
process.exit(failures ? 1 : 0);
