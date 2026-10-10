// Settings search (src/renderer/settings-search.js): word-start matching, synonyms and ranking. Plain Node.
const S = require('../src/renderer/settings-search');
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail ?? ''}`}`); if (!ok) failures++; };

const q = S.parse;
check('parse: lower-cases and splits on spaces', JSON.stringify(q('  Dark  MODE ')) === '["dark","mode"]');
check('parse: empty query has no words', q('   ').length === 0 && q(undefined).length === 0);

check('a word matches at a word start', S.matchesAll('dark mode for all websites', q('mode')));
check('a word does not match in the middle of one', !S.matchesAll('model picker', q('odel')) && !S.matchesAll('gemini', q('mini')));
check('every word has to match', S.matchesAll('block third-party cookies', q('block cookies')) && !S.matchesAll('block third-party cookies', q('block proxy')));
check('punctuation counts as a word break', S.matchesAll('third-party cookies', q('party')));

check('synonym: night finds dark', S.matchesAll('theme: light, dark or system', q('night')));
check('synonym: adblock finds trackers', S.matchesAll('show ads and trackers blocked', q('adblock')));
check('synonym: vpn finds proxy', S.matchesAll('proxy mode and rules', q('vpn')));
check('synonym words are still matched at word starts', !S.matchesAll('abdarkened', q('night')));
check('a word with no synonym only matches itself', !S.matchesAll('dark mode', q('zebra')));
check('no synonym points back at itself in a loop of nonsense', Object.entries(S.SYNONYMS).every(([k, v]) => !v.includes(k)));

const widgetsLink = 'widgets weather, calendar, tasks, headlines, music, mail and more, as cards on the new-tab page. weather calendar todoist clock rss spotify gmail slack github stocks crypto tradingview chart notes countdown timer pomodoro ai status claude grok gemini custom recipe embed';
check('adblock does not match the Widgets page', S.score(q('adblock'), { label: 'Widgets', titles: 'widgets home', search: widgetsLink }) === 0);
check('adblock finds the blocker and its site list', S.score(q('adblock'), { label: 'Block ads and trackers', titles: 'ads and trackers privacy and security', search: 'block ads and trackers' }) === 3 && S.score(q('adblock'), { label: 'Sites allowed to show ads', titles: 'ads and trackers', search: '' }) >= 2);

const row = { label: 'Theme', titles: 'appearance', search: 'theme lumen follows this light dark system' };
check('score: label hit is 3', S.score(q('theme'), row) === 3);
check('score: title hit is 2', S.score(q('lumen'), { label: 'Theme', titles: 'lumen appearance', search: 'theme' }) === 2);
check('score: description or option hit is 1', S.score(q('follows'), row) === 1);
check('score: the names of a row\'s choices count as 2 (night -> dark)', S.score(q('night'), { ...row, keywords: 'system light dark' }) === 2);
check('score: a synonym that is only in the helper text is 1', S.score(q('night'), row) === 1);
check('score: no match is 0', S.score(q('zebra'), row) === 0);
check('score: no words is 0', S.score([], row) === 0);
check('ranking: label beats description', S.score(q('proxy'), { label: 'Proxy', titles: 'advanced', search: 'proxy' }) > S.score(q('proxy'), { label: 'Network', titles: 'advanced', search: 'network proxy rules' }));

// Real-world searches that used to find nothing sensible.
check("'dark mode' finds the Theme row (mode means theme, dark is one of its choices)", S.score(q('dark mode'), { label: 'Theme', titles: 'appearance', search: 'theme', keywords: 'system light dark' }) === 2);
check("'default search' finds the search engine picker by its keywords", S.score(q('default search'), { label: 'Search engine used in the address bar', titles: 'search engine general', search: 'x', keywords: 'default search engine google bing duckduckgo' }) >= 2);
check("'bluetooth' and 'pop-ups' find Site permissions through their keywords", S.score(q('bluetooth'), { label: 'Site permissions', titles: 'privacy', keywords: 'usb bluetooth hid' }) === 2 && S.score(q('popups'), { label: 'Site permissions', titles: 'privacy', keywords: 'popups pop-ups' }) === 2);
check("'mic' finds a microphone row", S.matchesAll('camera and microphone', q('mic')) && S.matchesAll('camera and microphone', q('webcam')));
check("'certificate' finds the secure-connections row through its keywords", S.score(q('certificate'), { label: 'Always use secure connections', titles: 'privacy', keywords: 'https only ssl tls certificate' }) === 2);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

