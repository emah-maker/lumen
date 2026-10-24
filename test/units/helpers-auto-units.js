// Helpers: Off | Auto | On. Auto lists the delegate tool only for a request with several independent parts (ai/helpers-auto.js), decided locally with
// no model call, and the setting an older Lumen saved (true / false) keeps meaning On / Off. Plain Node: no Electron, no network.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const A = require('../../src/ai/helpers-auto');
const { Agent, requestFor } = require('../../src/ai/agent');
const backend = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

// ---- the setting: Off | Auto | On, and the true / false of older versions
check('mode: true and "on" are on, false and "off" are off', A.modeOf(true) === 'on' && A.modeOf('on') === 'on' && A.modeOf(false) === 'off' && A.modeOf('off') === 'off');
check('mode: nothing saved, "auto" and junk are auto (the default for a new install)', A.modeOf(undefined) === 'auto' && A.modeOf(null) === 'auto' && A.modeOf('auto') === 'auto' && A.modeOf('maybe') === 'auto' && A.modeOf(1) === 'auto');
check('settings migration: a saved true / false stays On / Off; a value nobody saved is Auto; junk is refused', backend.validate('aiSubagents', true) === 'on' && backend.validate('aiSubagents', false) === 'off'
  && backend.validate('aiSubagents', 'auto') === 'auto' && backend.validate('aiSubagents', 'on') === 'on' && backend.validate('aiSubagents', 'off') === 'off' && backend.validate('aiSubagents', 'sometimes') === null && backend.DEFAULTS.aiSubagents === 'auto');

// ---- the check: example requests -> helpers or not
const YES = [
  'Apply to these 10 jobs for me',
  'Research the top 5 laptops under $1000 and compare them',
  'For each of these companies, find the CEO and the headcount: Stripe, Notion, Figma, Linear',
  'Compare prices for the Sony WH-1000XM5 across several stores',
  'Summarize these three articles for me: https://a.example.com/x https://b.example.com/y https://c.example.com/z',
  'Read all of these papers and tell me what each one concludes',
  'Check these 8 websites for a pricing page and list the plans',
  'Compare Notion, Obsidian, and Roam Notes for note taking',
  'Look up reviews from multiple sources on the new Pixel',
  'Please use helpers to research this in parallel',
  'Find the opening hours of these restaurants at the same time',
  'Go through every one of the companies on my list and check their careers pages',
  'Research the history of the Roman Empire from several sources and write a report',
  'Here are my targets:\n- Stripe\n- Notion\n- Figma\n- Linear\nfind their careers pages',
  'Compare https://a.example.com and https://b.example.com on price',
  'Fill in the same form on 4 different sites',
  'Check each tab for broken links',
];
const NO = [
  'hi',
  'thanks!',
  'What does this page say?',
  'Summarize this article',
  'What is the capital of France?',
  'Open youtube.com',
  'Click the login button',
  'Explain what a closure is in JavaScript',
  'Translate this paragraph into Spanish',
  'Fix the typo in my second sentence',
  'Search for the weather in Boston',
  'Can you give me 3 tips for studying?',
  'Make this email sound more polite',
  'Scroll down and tell me the price',
  'Rewrite my cover letter for a mechanical engineering internship',
  '',
];
for (const t of YES) check(`yes: ${JSON.stringify(t).slice(0, 70)}`, A.judge(t).offer === true, A.judge(t).why);
for (const t of NO) check(`no: ${JSON.stringify(t).slice(0, 70)}`, A.judge(t).offer === false, A.judge(t).why);
check('a long paste is not read for list-like words past its first part', A.judge(`Summarize this. ${'lorem ipsum '.repeat(200)}\n- a\n- b\n- c\nread the sources`).offer === false);

// ---- the conversation: only the user's words count, and Auto stays on once it was on (a changing tool list would break the prompt cache)
const user = (content) => ({ role: 'user', content });
const asst = (content) => ({ role: 'assistant', content });
check('messages: a plain question does not offer it', A.wantsHelpers([user('What is a monad?')]) === false);
check('messages: a request with several parts does', A.wantsHelpers([user('Apply to these 10 jobs')]) === true);
check('messages: text blocks count too; images and tool results do not', A.wantsHelpers([user([{ type: 'text', text: 'Apply to these 10 jobs' }])]) === true
  && A.wantsHelpers([user([{ type: 'tool_result', tool_use_id: 'x', content: 'Apply to these 10 jobs' }])]) === false);
check('messages: the assistant\'s own words never count', A.wantsHelpers([user('hi'), asst('I can apply to these 10 jobs for each of the sites')]) === false);
check('messages: it stays on for the rest of the chat once a request asked for it', A.wantsHelpers([user('Compare these 5 laptops'), asst('ok'), user('thanks'), asst('sure'), user('and the cheapest?')]) === true);
check('messages: a chat with no such request never gets it', A.wantsHelpers([user('hi'), asst('hello'), user('what is 2+2')]) === false);
check('offered(): Off never, On always, Auto by the messages', A.offered('off', [user('Apply to these 10 jobs')]) === false && A.offered(false, [user('Apply to these 10 jobs')]) === false
  && A.offered('on', [user('hi')]) === true && A.offered(true, [user('hi')]) === true && A.offered('auto', [user('hi')]) === false && A.offered(undefined, [user('Apply to these 10 jobs')]) === true);

(async () => {
// ---- the agent: the tool list of the request follows the setting
{
  const tab = { id: 1, webContents: { id: 101, getURL: () => 'https://t.test/', isDestroyed: () => false } };
  const makeAgent = (setting) => {
    const browser = { activeTab: () => tab, tabById: () => tab, listTabs: () => [], effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => '', maxSteps: () => 0, autoApprove: () => false, ...(setting === 'unset' ? {} : { subagents: () => setting }) };
    return new Agent(browser, () => null, () => ({ model: 'claude-opus-5-5' }));
  };
  const chatOf = (...texts) => { const m = texts.map((t) => user(t)); m.settings = { model: 'claude-opus-5-5' }; return m; };
  const listed = (agent, chat) => requestFor(chat.settings, chat, undefined, { delegate: agent.helpersOffered(chat) }).tools.some((t) => t.name === 'delegate');
  const simple = chatOf('What does this page say?');
  const multi = chatOf('Apply to these 10 jobs');
  const auto = makeAgent('auto');
  const fresh = makeAgent('unset');
  check('agent: no saved setting is Auto: not offered for a simple message, offered for a multi-part one', fresh.subagentsMode() === 'auto' && !listed(fresh, simple) && listed(fresh, multi));
  check('agent: Auto, same', auto.subagentsMode() === 'auto' && !listed(auto, simple) && listed(auto, multi));
  check('agent: On offers it for every message', makeAgent('on').subagentsMode() === 'on' && listed(makeAgent('on'), simple) && listed(makeAgent(true), simple));
  check('agent: Off never offers it, even for a multi-part request', makeAgent('off').subagentsMode() === 'off' && !listed(makeAgent('off'), multi) && !listed(makeAgent(false), multi));
  check('agent: the CLI engines\' helpers are on in Auto and On, off only in Off', auto.subagentsOn() && makeAgent('on').subagentsOn() && !makeAgent('off').subagentsOn() && !makeAgent(false).subagentsOn());
  check('agent: the Auto chip: the delegate step says it was Auto\'s choice; On and Off-free modes keep the old wording',
    (await auto.describeStep('delegate', { tasks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }] })) === 'Auto: using 3 helpers'
    && (await makeAgent('on').describeStep('delegate', { tasks: [{ task: 'a' }, { task: 'b' }] })) === 'Handing 2 jobs to helpers');
  check('agent: helpers still cap at 5 per call and run read-only (limits unchanged)', require('../../src/ai/subagents').MAX_TASKS === 5 && [...require('../../src/ai/subagents').HELPER_TOOLS].sort().join() === 'analyze_posts,find_sources,read_urls,web_search');
  check('request: the tool definition stays short and says when to use it', (() => { const d = requestFor(simple.settings, simple).tools.find((t) => t.name === 'delegate'); return JSON.stringify(d).length < 700 && /3\+ items/.test(d.description); })());
}

// ---- the sidebar row and the Settings select say all three
{
  const en = JSON.parse(src('src/locales/en.json'));
  const keys = ['sidebar.helpers.auto', 'sidebar.helpers.on', 'sidebar.helpers.off', 'sidebar.state.auto', 'sidebar.state.on', 'sidebar.state.off', 'settings.ai.subagents.auto', 'settings.ai.subagents.on', 'settings.ai.subagents.off'];
  check('strings: Off / Auto / On are in en.json', keys.every((k) => typeof en[k] === 'string' && en[k]), keys.filter((k) => !en[k]).join());
  const core = src('src/renderer/chat-core.js');
  check('sidebar: the row cycles Auto -> On -> Off and follows Settings', /HELPERS_NEXT = \{ auto: 'on', on: 'off', off: 'auto' \}/.test(core) && /helpersModeOf\(e\.detail\)/.test(core));
  check('settings page: a three-way select, not a switch', /select\('aiSubagents'[\s\S]{0,900}\['auto', 'on', 'off'\]/.test(src('src/renderer/settings.js')));
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
