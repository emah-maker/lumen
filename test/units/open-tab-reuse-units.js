// Plain Node: open_tab opens no tab it does not need (features/open-tab-reuse.js, wired in ai/agent.js reuseForOpenTab). No Electron.
const reuse = require('../../src/features/open-tab-reuse');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);
const { urlKey, wantsNewTab, decide } = reuse;

// ---- the same page
check('key: fragment, trailing slash, www, host case and default port do not make a different page', urlKey('https://WWW.Example.com:443/a/b/#top') === urlKey('https://example.com/a/b'), urlKey('https://WWW.Example.com:443/a/b/#top'));
check('key: tracking parameters are dropped, other parameters kept', urlKey('https://e.com/p?utm_source=x&id=2&fbclid=z') === urlKey('https://e.com/p?id=2') && urlKey('https://e.com/p?id=2') !== urlKey('https://e.com/p?id=3'));
check('key: parameter order does not matter', urlKey('https://e.com/?a=1&b=2') === urlKey('https://e.com/?b=2&a=1'));
check('key: another path, scheme or port is another page', urlKey('https://e.com/a') !== urlKey('https://e.com/b') && urlKey('http://e.com/a') !== urlKey('https://e.com/a') && urlKey('https://e.com:8443/a') !== urlKey('https://e.com/a'));
check('key: not an address gives no key', urlKey('') === '' && urlKey('not a url') === '' && urlKey(null) === '');

// ---- the user asked for a tab
check('new tab: "in a new tab", "another tab", "separate tab", "in tabs" ask for one', ['open it in a new tab', 'open this in another tab', 'put each in a separate tab', 'open them in tabs', 'open both side-by-side'].every(wantsNewTab));
check('new tab: ordinary requests do not', ['what is the weather in Boston', 'summarize this page', 'open the tabs list', 'compare the two tabs I have'].every((t) => !wantsNewTab(t)), 'a plain request matched');

// ---- the decision
const tabs = [{ id: 1, url: 'https://news.example.com/' }, { id: 2, url: 'https://docs.example.com/a?utm_medium=x' }, { id: 3, url: 'https://off.example.com/', off: true }, { id: 4, url: 'https://busy.example.com/', busy: true }];
const idle = { id: 9, alive: true, inFront: false, loading: false, audible: false };
check('decide: a page open in the user\'s tab is not opened again', J(decide({ url: 'https://docs.example.com/a', tabs })) === J({ action: 'existing', id: 2, mine: false }), J(decide({ url: 'https://docs.example.com/a', tabs })));
check('decide: the match ignores a #fragment and a trailing slash', decide({ url: 'https://news.example.com/#x', tabs }).action === 'existing');
check('decide: the chat\'s own tab holding the page is used, flagged as its own', J(decide({ url: 'https://own.example.com/', tabs: [...tabs, { id: 9, url: 'https://own.example.com' }], own: idle })) === J({ action: 'existing', id: 9, mine: true }));
check('decide: a tab with AI off or another chat\'s busy tab is never matched', decide({ url: 'https://off.example.com/', tabs }).action === 'open' && decide({ url: 'https://busy.example.com/', tabs }).action === 'open');
check('decide: the user asking for a new tab always opens one, even for an open page', decide({ url: 'https://news.example.com/', tabs, own: idle, explicit: true }).action === 'open');
check('decide: a new page with an idle own tab loads there', J(decide({ url: 'https://new.example.com/', tabs, own: idle })) === J({ action: 'reuse-own', id: 9 }));
check('decide: with no own tab a new page opens a tab', decide({ url: 'https://new.example.com/', tabs, own: null }).action === 'open');
check('decide: the own tab is left alone while loading, playing, or in front of the user', ['loading', 'audible', 'inFront'].every((k) => decide({ url: 'https://new.example.com/', tabs, own: { ...idle, [k]: true } }).action === 'open'));
check('decide: show:true or keep:true gets a tab of its own', decide({ url: 'https://new.example.com/', tabs, own: idle, show: true }).action === 'open' && decide({ url: 'https://new.example.com/', tabs, own: idle, keep: true }).action === 'open');
check('decide: a dead own tab is not reused', decide({ url: 'https://new.example.com/', tabs, own: { ...idle, alive: false } }).action === 'open');
check('decide: no address to compare still works', decide({ url: '', tabs, own: idle }).action === 'reuse-own');

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
