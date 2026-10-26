// Settings search (src/renderer/settings-search.js): word-start matching, synonyms and ranking. Plain Node.
const S = require('../../src/renderer/settings-search');
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

// "history" and "cache" mean the browsing-data row, not every row that merely says "clear" (a Widgets option once matched "clear history").
check("'clear history' does not match a row that only says clear (Widget cards)", S.score(q('clear history'), { label: 'Widget cards', titles: 'background home', search: 'how see-through the widget cards are. clear is as transparent as possible', keywords: 'clear frosted' }) === 0);
check("'clear history' still finds Clear browsing data", S.score(q('clear history'), { label: 'Clear browsing data', titles: 'browsing data', search: '' }) === 3);
check("'history' and 'cache' alone still find the browsing-data row", S.score(q('history'), { label: 'Clear browsing data', titles: 'browsing data' }) === 3 && S.score(q('cache'), { label: 'Clear browsing data', titles: 'browsing data' }) === 3);
{ // The new rows are found by the words people use (settings.js gives them these keywords).
  const row = (label, keywords) => ({ label, titles: 'x', search: '', keywords });
  check("'incognito', 'inprivate' and 'private browsing' find the Private windows row", ['incognito', 'inprivate', 'private browsing'].every((w) => S.score(q(w), row('Private windows (incognito)', 'incognito inprivate private browsing window')) >= 2));
  check("'sync' and 'phone' find the Sync across devices row", S.score(q('sync'), row('Sync across devices', 'sync account devices phone cloud')) === 3 && S.score(q('phone'), row('Sync across devices', 'sync account devices phone cloud')) === 2);
  check("'print' and 'printer' find the Printing row", S.score(q('print'), row('Printing', 'print printer pdf')) === 3 && S.score(q('printer'), row('Printing', 'print printer pdf')) === 2);
}
const fsx = require('fs'), pathx = require('path');
const settingsSrc = fsx.readFileSync(pathx.join(__dirname, '..', '..', 'src', 'renderer', 'settings.js'), 'utf8');
check('settings.js: a page shown in place while searching is ordered by its best row', /slot\.pane\.style\.order = searching \? String\(-\(slot\.best \|\| 0\)\)/.test(settingsSrc));
check('settings.js: the AI switches that were negatives are inverted switches over the same keys', ['aiHandsOff', 'aiStayOnMyTab', 'agentsNoAsk'].every((k) => new RegExp(`toggle\\('${k}'[^\\n]*invert: true`).test(settingsSrc)));
check('the no-results state has a suggestions block', settingsSrc.includes('no-results-suggest') && fsx.readFileSync(pathx.join(__dirname, '..', '..', 'src', 'renderer', 'settings.html'), 'utf8').includes('no-results-suggest'));

// ---- The ranking table: query -> the rows that are found (best first), over rows shaped like the real ones. ----
{
  const AI = 'AI';
  const R = (label, group, cat, desc = '', keywords = '', sub = '') => ({ label, group, cat, sub, search: `${label} ${desc}`.toLowerCase(), keywords });
  const rows = [
    R('Model', 'Assistant', AI, 'Which AI answers in the sidebar'),
    R('Short, focused answers', 'Assistant', AI, 'Asks the AI for brief replies'),
    R('Asking before it acts', 'Agents and tools', AI, 'The AI agent asks before it clicks or types in a tab'),
    R('Allow AI agents to connect', 'Agents and tools', AI, 'Lets an outside agent use Lumen through MCP'),
    R('Status', 'Claude Code', AI, 'Found at C:/claude.exe', '', 'AI providers'),
    R('Offer in the model menu', 'Claude Code', AI, 'Shows Claude Code and its models in every model picker', '', 'AI providers'),
    R('Status', 'Grok Build', AI, 'Found at C:/grok.exe', '', 'AI providers'),
    R('Offer in the model menu', 'Grok Build', AI, 'Shows Grok Build and its models in every model picker', '', 'AI providers'),
    R('Translate with', 'Language', 'General', 'Pages are translated by Lumen using an AI model'),
    R('Show the AI read-only button in the address bar', 'Toolbar', 'Appearance', 'Ask the AI about a page'),
    R('Save passwords', 'Passwords', 'Privacy and security', 'Offers to save a password when you sign in', 'autofill auto fill sign-in login logins credentials keychain'),
    R('Unload inactive tabs', 'Page unloading', 'Tabs', 'Closes the page of a background tab to free its memory', 'unload sleep memory ram tabs master on off enable energy power saver saving'),
    R('Unload after', 'Page unloading', 'Tabs', 'How long a background tab can go unused', 'unload sleep memory ram tabs minutes'),
    R('Tabs playing audio or video', 'Page unloading', 'Tabs', 'A tab that is playing sound or video stays loaded.', 'unload sleep memory ram tabs music sound mute muted media playing'),
    R('Allow automation tools (Chrome DevTools Protocol)', 'Automation', 'Advanced', 'For Playwright and other CDP tools', 'developer developers devtools debugging remote debugging cdp playwright puppeteer'),
    R('Default for new sites', 'Site settings', 'Privacy and security', 'Ask shows a prompt the first time a site asks', 'camera microphone location notifications clipboard permission ask block', 'Site permissions'),
  ];
  // "Label|Group" of every row the query finds, best first.
  const hits = (query) => { const sc = S.rank(S.parse(query), rows); return rows.map((r, i) => [r, sc[i]]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([r]) => `${r.label}|${r.group}`); };
  // Every `want` prefix is found and no `not` prefix is.
  const ranks = (name, query, want, not = []) => {
    const got = hits(query);
    check(name, want.every((w) => got.some((g) => g.startsWith(w))) && not.every((n) => !got.some((g) => g.startsWith(n))), `${query}: ${got.join(' ; ')}`);
  };

  ranks("'agents' finds the rows about agents, not every row of the AI page", 'agents', ['Asking before it acts', 'Allow AI agents to connect'], ['Model|', 'Short, focused', 'Status', 'Offer in']);
  check("the page's own name ('ai and agents') still lists the whole page", hits('ai and agents').length === rows.filter((r) => r.cat === AI).length, hits('ai and agents').join(' ; '));
  check("a page's first word names the page, its last word does not", S.categoryHit(S.parse('ai'), AI) && S.categoryHit(S.parse('ai agents'), AI) && !S.categoryHit(S.parse('agents'), AI) && S.categoryHit(S.parse('privacy'), 'Privacy and security') && !S.categoryHit(S.parse('security'), 'Privacy and security'));
  check("a longer query is not a near match ('privacy settings' is not the Privacy page)", !S.categoryHit(S.parse('privacy settings'), 'Privacy and security'));
  ranks("'claude' finds Claude Code's rows and only those", 'claude', ['Status|Claude Code', 'Offer in the model menu|Claude Code'], ['Model|', 'Translate with', 'Show the AI', 'Status|Grok', 'Offer in the model menu|Grok']);
  ranks("'grok' finds Grok Build's rows and not Claude Code's", 'grok', ['Status|Grok Build', 'Offer in the model menu|Grok Build'], ['Model|', 'Translate with', 'Show the AI', 'Status|Claude', 'Offer in the model menu|Claude']);
  check("'claude' and 'grok' do not return the same rows", hits('claude').join() !== hits('grok').join());
  check("a plural also finds its singular ('agents' -> agent, 'cookies' -> cookie)", S.matchesAll('the ai agent asks', S.parse('agents')) && S.matchesAll('block third-party cookie', S.parse('cookies')));
  check("'autofill' finds Save passwords first", hits('autofill')[0]?.startsWith('Save passwords'), hits('autofill').join(' ; '));
  ranks("'mute' finds the tabs-playing-sound row", 'mute', ['Tabs playing audio or video']);
  ranks("'energy' finds Unload inactive tabs, not every unload row", 'energy', ['Unload inactive tabs'], ['Unload after']);
  ranks("'developer' finds the automation (DevTools) row", 'developer', ['Allow automation tools']);
  ranks("'notification' and 'notifications' find the permissions row that sets them", 'notification', ['Default for new sites']);
  ranks("'notifications' finds it too", 'notifications', ['Default for new sites']);
  check('a query nothing answers finds nothing', hits('zebra crossing').length === 0);
  check('rank(): no words rank nothing', S.rank([], rows).every((s) => s === 0));
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

