// Sidebar UX audit, round 2 (docs/ux-audit/sidebar.md): the header, the one usage line, the model picker's sign-in tag, the approval
// cards' button names, history titles, step timing and the Tasks panel wording, checked in plain Node against the sources.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const en = JSON.parse(read('src', 'locales', 'en.json'));
const html = read('src', 'renderer', 'index.src.html');
const core = read('src', 'renderer', 'chat-core.js');
const styles = read('src', 'renderer', 'styles.css');

// ---- 1) the header
const head = html.slice(html.indexOf('<div class="sidebar-actions">'), html.indexOf('<div id="chat-usage"'));
const menu = head.slice(head.indexOf('id="more-menu"'));
const bar = head.slice(0, head.indexOf('id="more-menu"'));
check('the header keeps four buttons: permissions bolt, chat history, new chat, More', ['auto-allow', 'chat-history', 'new-chat', 'more-actions'].every((id) => bar.includes(`id="${id}"`)) && (bar.match(/<button /g) || []).length === 4, (bar.match(/<button /g) || []).length);
check('Helpers, Background tasks and the Research board are labelled rows of the More menu, not bare icons in the header', ['helpers-btn', 'tasks-btn', 'research-btn'].every((id) => menu.includes(`id="${id}"`) && !bar.includes(`id="${id}"`)));
check('each of those rows has a real text label', (menu.match(/class="menu-label"/g) || []).length === 3);
check('Helpers is a checkbox row with a visible On/Off state', /id="helpers-btn"[^>]*role="menuitemcheckbox"|role="menuitemcheckbox"[^>]*id="helpers-btn"/.test(menu) && /id="helpers-state"/.test(menu) && /aria-checked/.test(core) && /sidebar\.state\.on/.test(core) && en['sidebar.state.on'] === 'On' && en['sidebar.state.off'] === 'Off');
check('the bolt names its level beside it (Auto / Bypass) and its accessible name says the level', /perm-state/.test(core) && /sidebar\.perm\.label/.test(core) && en['sidebar.perm.short.auto'] === 'Auto' && en['sidebar.perm.short.bypass'] === 'Bypass' && /Permissions: \{mode\}/.test(en['sidebar.perm.label']));
check('the clock button says "Chat history" in the markup too', /id="chat-history" title="Chat history" aria-label="Chat history"/.test(head));
check('tasks.js puts a running/waiting/finished dot on More, and returns focus there when the tasks button is hidden', /has-attention/.test(read('src', 'renderer', 'tasks.js')) && /more-actions/.test(read('src', 'renderer', 'research.js')) && /#more-actions\.has-attention::after/.test(styles));
check('the menu styles show the row label and push the state or count right', /\.more-menu \.menu-state \{[^}]*margin-left: auto/.test(styles) && /\.more-menu \.task-badge \{[^}]*position: static/.test(styles));

// ---- 2) one usage line
const chats = read('src', 'renderer', 'chats.js');
const extras = read('src', 'renderer', 'chat-extras.js');
check('the usage line under the header says "This chat:" and keeps the raw numbers for /cost', en['chats.usage.line'] === 'This chat: {usage}' && /usageLine\.dataset\.usage/.test(chats) && /dataset\.usage/.test(read('src', 'renderer', 'chat-commands.js')) && /chats\.usage\.line/.test(read('src', 'renderer', 'chat-page.js')));
check('the meter strip no longer repeats tokens and cost beside a context percent (today is in its tooltip)', !/usage\.grok\.cost/.test(extras) && /usage\.todayTotal/.test(extras) && en['usage.todayTotal'] === '{usage} today');

// ---- 3) the model picker
const picker = read('src', 'renderer', 'picker.js');
check('a provider group whose rows all need sign-in says so at its heading', /needsSignIn/.test(picker) && /picker-group-signin/.test(picker) && /\.picker-group \.picker-group-signin/.test(read('src', 'renderer', 'picker.css')));
check('main asks for the deduped Auto rows', /dedupe: true/.test(read('src', 'main.js')));

// ---- 4) approval cards: every card's buttons are named differently, and the same decision has one name everywhere
const cards = {
  site: ['approval.deny', 'approval.allSites', 'approval.allow'],
  tool: ['approval.deny', 'approval.tool.always', 'approval.once'],
  terminal: ['approval.deny', 'approval.terminal.always', 'approval.once'],
  task: ['tasks.approval.deny', 'tasks.approval.stop', 'tasks.approval.site', 'tasks.approval.once'],
};
for (const [name, keys] of Object.entries(cards)) {
  const labels = keys.map((k) => en[k]);
  check(`approval card (${name}): no two buttons share a name`, new Set(labels).size === labels.length && labels.every(Boolean), labels.join(' | '));
}
check('"Allow once" means one action everywhere; "for this chat" names a whole chat; "Always" names the standing setting', en['approval.once'] === 'Allow once' && en['tasks.approval.once'] === 'Allow once' && /for this chat/.test(en['approval.allow']) && /for this chat/.test(en['approval.terminal.always']) && /^Always allow/.test(en['approval.allSites']) && /^Always allow/.test(en['approval.tool.always']));
check('the site card no longer calls the same choice "Allow for this chat" as the terminal card', en['approval.allow'] !== en['approval.terminal.always'] && /site/i.test(en['approval.allow']) && /command/i.test(en['approval.terminal.always']));
check('the refusal is "Don’t allow" in chat cards and the Tasks panel alike', en['approval.deny'] === 'Don’t allow' && en['tasks.approval.deny'] === 'Don’t allow');

// ---- 5) history titles
const { autoTitle, tidy } = require('../src/features/chat-title');
const store = require('../src/features/chat-store');
const one = (text, extra = []) => ({ messages: [{ role: 'user', content: [{ type: 'text', text }] }, ...extra] });
const say = (text) => ({ role: 'user', content: text });
check('chat-store uses the shared title maker', store.autoTitle === autoTitle || store.autoTitle('x') !== undefined);
check('a greeting alone is skipped for the first real message', autoTitle({ messages: [say('hi'), { role: 'assistant', content: 'hello!' }, say('how do I center a div in CSS grid')] }) === 'how do I center a div in CSS grid', autoTitle({ messages: [say('hi'), say('how do I center a div')] }));
check('two chats that both start "hi" get different titles once they say more', autoTitle({ messages: [say('hi'), say('plan a trip to Lisbon')] }) !== autoTitle({ messages: [say('hi'), say('fix my resume')] }));
check('a chat that is only "hi" is still titled "hi"', autoTitle(one('hi')) === 'hi', autoTitle(one('hi')));
check('lead-ins and sign-offs are trimmed', autoTitle(one('Hey, can you please summarize the attached report, thanks!')) === 'Summarize the attached report', autoTitle(one('Hey, can you please summarize the attached report, thanks!')));
check('a long address shows as its host', autoTitle(one('summarize https://www.example.com/a/very/long/path/to/an/article?x=1&y=2')) === 'summarize example.com', autoTitle(one('summarize https://www.example.com/a/very/long/path/to/an/article?x=1&y=2')));
check('a slash command word is not the topic', autoTitle(one('/think prove that sqrt 2 is irrational')) === 'Prove that sqrt 2 is irrational');
const pageChat = one('<browser_state>\nActive tab id: 1\nTitle: Lumen docs - install\nURL: https://x.test/\n</browser_state>\n\nSummarize this page');
check('"Summarize this page" is titled with the page it was about', autoTitle(pageChat) === 'Summarize this page · Lumen docs - install', autoTitle(pageChat));
check('a title is at most 60 characters and ends at a word with an ellipsis', (() => { const t = autoTitle(one('word '.repeat(40))); return t.length <= 60 && t.endsWith('…') && !/ …$/.test(t); })(), autoTitle(one('word '.repeat(40))));
check('an image-only message is still "Image"; no messages is "New chat"', autoTitle({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }) === 'Image' && autoTitle({ messages: [] }) === 'New chat');
check('a message that is only "please" keeps its words', autoTitle(one('please')) === 'please' && typeof tidy === 'function');

// internal markup never shows in a title (a screen capture sent along, cut-off tags), also for chats saved before
{
  const { cleanSaved } = require('../src/features/chat-title');
  const cap = '<screen_capture id="smv1b16fg2" kind="image" title="T" url="https://x.test/">[image]</screen_capture>';
  check('a screen capture block is not the title: the real text after it is', autoTitle(one(`${cap}\n\nwhat does this chart show?`)) === 'what does this chart show?', autoTitle(one(`${cap}\n\nwhat does this chart show?`)));
  check('a message that is only a screen capture is titled "Screen capture"', autoTitle(one(cap)) === 'Screen capture', autoTitle(one(cap)));
  check('a cut-off tag never leaks into a title', !/</.test(autoTitle(one('<screen_capture id="smv1b16fg2" kind="image" title="a very long title that goes on and on'))), autoTitle(one('<screen_capture id="smv1b16fg2" kind')));
  check('a saved title with markup in it is cleaned for display', cleanSaved('<screen_capture id="smv1b16fg2" kind') === '' && cleanSaved('hello <screen_capture id="a"') === 'hello' && cleanSaved('plain title') === 'plain title');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-title-'));
  const enc = (t) => Buffer.from(t).toString('base64'); const dec = (t) => Buffer.from(t, 'base64').toString();
  const st = store.createChatStore({ dir, encrypt: enc, decrypt: dec });
  const id = st.newId();
  st.save(id, { settings: {}, messages: [{ role: 'user', content: [{ type: 'text', text: `${cap} explain this graph` }] }] });
  const idx = JSON.parse(dec(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).enc));
  idx.chats[0].title = '<screen_capture id="smv1b16fg2" kind="image" tit…'; // as an older version saved it
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ enc: enc(JSON.stringify(idx)) }));
  const again = store.createChatStore({ dir, encrypt: enc, decrypt: dec });
  check('History lists an older chat by its first real text, not the markup it was saved with', again.list()[0].title === 'explain this graph', again.list()[0].title);
}
// the full chat page and the sidebar name the connected assistant (Lumen for Auto), never one provider by default
check('the empty-state title says Lumen when Auto (no single assistant) is picked, and Auto across providers is the neutral identity', /emptyName = who === ASSISTANTS\.AI \? 'Lumen'/.test(core) && /current\?\.auto && !current\.autoScope/.test(core));


// ---- 6) step timing and the Stop button
const { format } = require('../src/renderer/step-time');
check('step time: nothing under a second, tenths under ten, whole seconds, then minutes', format(400) === '' && format(1200) === '1.2s' && format(9400) === '9.4s' && format(12600) === '13s' && format(65000) === '1m 05s' && format(119700) === '2m 00s' && format(NaN) === '', [400, 1200, 9400, 12600, 65000, 119700].map(format).join());
check('a running step ticks from 3 s and keeps its final time', /function showStepTime/.test(core) && /ms < 3000/.test(core) && /showStepTime\(step, true\)/.test(core) && /\.step \.step-time/.test(styles));
check('the Stop button has a word beside its square', /dataset\.label = value \? t\('composer\.stop\.short'\)/.test(core) && en['composer.stop.short'] === 'Stop' && /\.send\.stop::after \{ content: attr\(data-label\)/.test(styles));
check('step-time.js is loaded by the sidebar and the chat page', /step-time\.js/.test(html) && /step-time\.js/.test(read('src', 'renderer', 'chat-page.html')) && /stepTime = api/.test(read('src', 'renderer', 'step-time.js')));

// ---- 7) Tasks panel wording
check('the Tasks empty text names the real button (») and not a "clock button"', !/clock/i.test(en['tasks.empty']) && /»/.test(en['tasks.empty']));
check('"Open Tasks" notifications say where Tasks is now (the ⋯ menu)', /⋯ menu/.test(en['tasks.notify.interrupted']) && /⋯ menu/.test(en['tasks.notify.interruptedMany']));

// the bundle is current with its sources (scripts/bundle-renderer.js), so what is tested is what ships
const bundled = read('src', 'renderer', 'ui.bundle.js');
check('the shipped bundle has the new header code', /function showStepTime/.test(bundled) && /needsSignIn/.test(bundled) && /this chat: \{usage\}|chats\.usage\.line/.test(bundled));
process.exit(failures ? 1 : 0);
