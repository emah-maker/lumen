// Finding a tab the AI opened, plain Node: no Electron.
//   - a tab keeps the chat that opened it (fromChat), even after the user takes it over (ai-manners.js)
//   - tab search finds an AI tab by its chat's name, "@ai" keeps only the AI's tabs, and they come in sections by chat (tab-search-match.js)
//   - the command bar splits a query into words on spaces (it split on the letter "s") and finds an AI tab by "ai" or its chat's name
//   - the wiring: main sends each tab's chat, names a chat's group after it, answers the chat's Tabs list; the strings are in en.json
// The real-window side is test/e2e/ai-tab-finder.js.
const fs = require('fs');
const path = require('path');
const M = require('../../src/features/ai-manners');
const S = require('../../src/renderer/tab-search-match');
const C = require('../../src/renderer/command-bar-match');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

// ---- the chat a tab came from
{
  const tab = M.markOpened({ id: 1 }, { chatId: 'c1', runId: 4 }, 1000);
  check('mark: a tab the AI opened for a chat remembers that chat and when', tab.fromChat === 'c1' && tab.fromChatAt === 1000, JSON.stringify(tab));
  M.handOver(tab);
  check('mark: the user taking the tab over clears the AI mark but keeps the chat it came from', tab.openedBy === null && tab.fromChat === 'c1', JSON.stringify(tab));
  const loose = M.markOpened({ id: 2 }, { chatId: null, runId: null }, 1000);
  check('mark: a tab with no chat (an outside agent) has no chat to remember', loose.fromChat === undefined, JSON.stringify(loose));
  const restored = M.restoreMark({ id: 3 }, { chatId: 'c9', at: 500 });
  check('mark: a tab restored after a restart is back with its chat', restored.fromChat === 'c9' && restored.fromChatAt === 500, JSON.stringify(restored));
}

// ---- tab search: the chat's name, @ai, sections by chat
{
  const tabs = [
    { title: 'Kayak: flights', url: 'https://kayak.com/a', chat: 'Compare flights to Lisbon' },
    { title: 'Gmail', url: 'https://mail.google.com', chat: null },
    { title: 'TAP Air Portugal', url: 'https://flytap.com', chat: 'Compare flights to Lisbon' },
    { title: 'Recipe', url: 'https://food.com/pasta', chat: 'Dinner ideas' },
  ];
  check('search: a word of the chat\'s name finds the tabs it opened', S.rank('lisbon', tabs).map((t) => t.title).join('|') === 'Kayak: flights|TAP Air Portugal', S.rank('lisbon', tabs).map((t) => t.title).join('|'));
  check('search: letters scattered through a chat\'s name do not match (only a word or a piece of one)', S.rank('cmpl', tabs).length === 0, S.rank('cmpl', tabs).map((t) => t.title).join('|'));
  check('search: the title still beats the chat name', S.rank('flights', tabs)[0].title === 'Kayak: flights', S.rank('flights', tabs).map((t) => t.title).join('|'));
  check('search: a tab with no chat is matched as before', S.rank('gmail', tabs).map((t) => t.title).join('|') === 'Gmail');
  const q1 = S.parseQuery('@ai lisbon');
  check('@ai: "@ai lisbon" filters to the AI\'s tabs and searches "lisbon"', q1.aiOnly === true && q1.text === 'lisbon', JSON.stringify(q1));
  const q2 = S.parseQuery('trip @AI');
  check('@ai: at the end, in capitals', q2.aiOnly === true && q2.text === 'trip', JSON.stringify(q2));
  const q3 = S.parseQuery('me@ai.com');
  check('@ai: an address with "@ai" in it is not the filter', q3.aiOnly === false && q3.text === 'me@ai.com', JSON.stringify(q3));
  check('@ai: "@ai" alone lists every AI tab', S.parseQuery('@ai').aiOnly === true && S.parseQuery('@ai').text === '');
  const sections = S.byChat(tabs.filter((t) => t.chat !== null));
  check('sections: one per chat, in the order each first appears, tabs in their own order', sections.map((s) => `${s.chat}:${s.items.length}`).join('|') === 'Compare flights to Lisbon:2|Dinner ideas:1', JSON.stringify(sections));
  check('sections: an AI tab with no chat name gets a section of its own', S.byChat([{ chat: '' }, { chat: 'x' }, { chat: '' }]).map((s) => `${s.chat}:${s.items.length}`).join('|') === ':2|x:1');
}

// ---- command bar
{
  const items = [
    { id: 'tab:1', group: 'tab', title: 'Kayak', url: 'https://kayak.com', keywords: 'ai Compare flights to Lisbon' },
    { id: 'tab:2', group: 'tab', title: 'Gmail', url: 'https://mail.google.com' },
    { id: 'tab:3', group: 'tab', title: 'Settings of mine', url: 'https://example.com/settings' },
  ];
  const rows = (q) => C.search(q, items).filter((r) => r.group === 'tab').map((r) => r.id).join(',');
  check('command bar: a word of the chat\'s name finds the tab the AI opened for it', rows('lisbon') === 'tab:1', rows('lisbon'));
  check('command bar: "ai" finds the AI\'s tabs (and, as before, a title with "ai" in it)', rows('ai').split(',').includes('tab:1') && !rows('ai').split(',').includes('tab:3'), rows('ai'));
  check('command bar: two words are two words (the query was split on the letter "s")', rows('flights lisbon') === 'tab:1' && rows('settings mine') === 'tab:3', `${rows('flights lisbon')} / ${rows('settings mine')}`);
  check('command bar: a word with an "s" in it is not cut in two', C.score('settings', items[2]) > C.score('ettings', items[2]), `${C.score('settings', items[2])} vs ${C.score('ettings', items[2])}`);
}

// ---- wiring (source checks)
{
  const main = read('src/main.js');
  check('main: every tab in the strip\'s state says which chat opened it (aiChat), awake or asleep', (main.match(/aiChat: t\.fromChat != null \? aiChatTitle\(t\.fromChat\) : null/g) || []).length === 2);
  check('main: the AI tabs group is one per chat, named after it', /function aiGroup\(cid = null\)/.test(main) && /made\.aiChat = cid;/.test(main) && /t\('tabs\.aiGroupFor'/.test(main));
  check('main: a chat\'s group follows its title when a run ends', /aiTabsKeepLinked\(runId, run\.reply\); aiGroupsRename\(\);/.test(main));
  check('main: a closed tab stays in its chat\'s list (closeTab notes it)', /noteChatTabClosed\(tab\);/.test(main));
  check('main: the chat\'s Tabs list answers on chat:ai-tabs, allowed for the sidebar and the chat page', /ipcMain\.handle\('chat:ai-tabs'/.test(main) && /'agent:ai-tabs-undo', 'chat:ai-tabs',/.test(main) && /'chat:ai-tabs'/.test(read('src/features/chat-page.js')));
  check('main: the Hide AI tabs menu has "Find a tab the AI opened…" last, opening tab search filtered', /t\('sidebar\.hideAiTabs\.menu\.find'\), click: \(\) => \{ ui\(\)\?\.focus\(\); ui\(\)\?\.send\('tabsearch:open', \{ ai: true \}\)/.test(main));
  check('preloads: the sidebar and the chat page both have assistant.chatTabs', /chatTabs: \(chatId\) => ipcRenderer\.invoke\('chat:ai-tabs', chatId\)/.test(read('src/preload/preload.js')) && /chatTabs: \(chatId\) => ipcRenderer\.invoke\('chat:ai-tabs', chatId\)/.test(read('src/features/chat-preload.js')));
  check('bundles: the built preload and UI bundle carry the change', read('src/preload/preload.bundle.js').includes("'chat:ai-tabs'") && read('src/renderer/ui.bundle.js').includes('chat-ai-tabs-pop') && read('src/renderer/ui.bundle.js').includes('tab-search-ai-filter'));
  const en = JSON.parse(read('src/locales/en.json'));
  const want = ['tabs.aiGroupFor', 'tabs.aiOpenedFor', 'tabSearch.ai', 'tabSearch.aiChat', 'tabSearch.aiFilter', 'tabSearch.aiFilter.title', 'tabSearch.fromChat', 'tabSearch.fromAi', 'sidebar.hideAiTabs.menu.find',
    'chat.aiTabs.list', 'chat.aiTabs.list.open', 'chat.aiTabs.list.closed', 'chat.aiTabs.list.empty', 'chat.aiTabs.button.one', 'chat.aiTabs.button.other', 'chat.aiTabs.button.none', 'chat.aiTabs.tag.front', 'chat.aiTabs.tag.yours', 'chat.aiTabs.tag.kept'];
  const missing = want.filter((k) => !(k in en));
  check('strings: every new string is in locales/en.json', missing.length === 0, missing.join(', '));
  check('strings: the group label keeps the chat name and the placeholder', en['tabs.aiGroupFor'].includes('{task}') && en['tabSearch.aiChat'].includes('{chat}'));
  const extras = read('src/renderer/chat-extras.js');
  check('chat: the Tabs list draws each tab as a tab chip (switches to it, or opens a closed one again)', /window\.tabRef\.chip\(\{ id: item\.id \}\)/.test(extras));
  const css = read('src/renderer/extras.css');
  const block = css.slice(css.indexOf('[ai tab finder]'));
  check('style: the Tabs list uses the theme\'s tokens, no colors of its own', block.length > 100 && !/#[0-9a-f]{3,6}\b|rgb\((?!0,0,0)/i.test(block.replace(/rgba\(0,0,0,\.32\)/g, '')), block.match(/#[0-9a-f]{3,6}\b/gi)?.join(','));
}

process.exit(failures ? 1 : 0);
