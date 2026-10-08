// delegate: read-only helpers that work side by side (ai/subagents.js, Agent.delegate in agent.js), their settings and sidebar
// button. Plain Node: no Electron, no network; the model and the tools are mocked.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const path = require('path');
const S = require('../src/ai/subagents');
const { Agent, requestFor, validateInput, EXTERNAL_TOOLS } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const use = (name, input, id = `u${Math.random().toString(36).slice(2, 8)}`) => ({ type: 'tool_use', id, name, input });
const reply = (content, usage = { input_tokens: 100, output_tokens: 10 }) => ({ content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', model: 'mock', usage });
const text = (t) => ({ type: 'text', text: t });

(async () => {
  // ---- the cheaper model, per provider
  check('model: Claude chats use Haiku, Haiku stays', S.helperModel('claude-opus-5-5') === 'claude-haiku-5-5' && S.helperModel('claude-fable-5-1') === 'claude-haiku-5-5' && S.helperModel('claude-haiku-5-5') === 'claude-haiku-5-5');
  check('model: OpenAI gets its mini, Gemini its flash', S.helperModel('openai:gpt-5.6') === 'openai:gpt-5.6-mini' && S.helperModel('openai:gpt-5.6-mini') === 'openai:gpt-5.6-mini' && S.helperModel('gemini:gemini-2.5-pro') === 'gemini:gemini-2.5-flash' && S.helperModel('gemini:gemini-2.5-flash') === 'gemini:gemini-2.5-flash');
  check('model: Grok and OpenRouter (no known cheaper one) and "same" keep the chat\'s model', S.helperModel('xai:grok-4') === 'xai:grok-4' && S.helperModel('openrouter:anthropic/claude-opus-5.5') === 'openrouter:anthropic/claude-opus-5.5' && S.helperModel('claude-opus-5-5', 'same') === 'claude-opus-5-5');

  // ---- the tasks
  const cleaned = S.cleanTasks({ tasks: [{ task: ' a ', urls: ['https://x.test', '', 5] }, { task: '' }, 'b', { task: 'c' }, { task: 'd' }, { task: 'e' }, { task: 'f' }] });
  check('tasks: blanks dropped, at most 5 kept and the rest counted', cleaned.tasks.length === 5 && cleaned.dropped === 1 && cleaned.tasks[0].task === 'a' && J(cleaned.tasks[0].urls) === '["https://x.test","5"]', J(cleaned));
  let thrown = '';
  try { S.cleanTasks({ tasks: [] }); } catch (e) { thrown = e.message; }
  check('tasks: none at all is an error the model can read', /needs tasks/.test(thrown), thrown);

  // ---- helpers side by side
  const exec = async (name) => { await sleep(100); return `<untrusted_page_content>${name} ok</untrusted_page_content>`; };
  const twoStep = async ({ messages }) => { await sleep(100); return messages.length === 1 ? reply([use('read_urls', { urls: ['https://a.test'] })]) : reply([text('answer')]); };
  {
    const t0 = Date.now();
    const results = await S.runHelpers({ tasks: ['one', 'two', 'three', 'four', 'five'].map((task) => ({ task, urls: [] })), turn: twoStep, exec, tools: [] });
    const took = Date.now() - t0;
    check('parallel: five helpers of ~300 ms each finish in about one helper\'s time, not five', took < 800 && results.every((r) => r.status === 'done' && r.text === 'answer' && r.steps === 2 && r.calls === 1), `${took} ms ${J(results.map((r) => r.status))}`);
  }

  // ---- caps
  {
    const calls = [];
    const greedy = async ({ noTools }) => { calls.push(noTools); return noTools ? reply([text('wrapped up')]) : reply([use('web_search', { query: `q${calls.length}` })]); };
    const r = await S.runHelper({ n: 1, task: 't', turn: greedy, exec: async () => 'r', tools: [], maxSteps: 3 });
    check('step cap: the last allowed turn has tools off and must answer', r.steps === 3 && calls.join() === 'false,false,true' && r.text === 'wrapped up' && r.status === 'done', J([r, calls]));
    const stuck = async ({ noTools }) => (noTools ? reply([text('gave up')]) : reply([use('web_search', { query: 'same' })]));
    const s = await S.runHelper({ n: 1, task: 't', turn: stuck, exec: async () => { throw new Error('nope'); }, tools: [], maxSteps: 40 });
    check('loop guard: a helper repeating one failing call is stopped early and told to wrap up', s.status === 'done' && s.steps < 12 && s.text === 'gave up', J(s));
  }
  {
    const hang = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const t0 = Date.now();
    const r = await S.runHelper({ n: 1, task: 't', turn: hang, exec, tools: [], timeMs: 80 });
    check('time cap: a helper that never answers is cut off and reported as timed out', r.status === 'timeout' && Date.now() - t0 < 500 && /ran out of time/.test(r.error), J(r));
    let n = 0;
    const slow = async ({ noTools }) => { n++; await sleep(60); return noTools ? reply([text('late answer')]) : reply([use('web_search', { query: `q${n}` })]); };
    const soft = await S.runHelper({ n: 1, task: 't', turn: slow, exec: async () => 'r', tools: [], timeMs: 400, maxSteps: 50 });
    check('time cap: past 75% of it the next turn is the tool-free answer, so a slow helper still reports', soft.status === 'done' && soft.text === 'late answer', J(soft));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const stopped = await S.runHelper({ n: 1, task: 't', turn: hang, exec, tools: [], signal: ctl.signal });
    check('stop: the user stopping the chat stops a helper', stopped.status === 'stopped', J(stopped));
  }

  // ---- no acting tools
  {
    const ran = [];
    const turn = async ({ messages }) => (messages.length === 1
      ? reply([use('click', { text: 'Buy now' }, 'c1'), use('type_text', { element_id: 1, text: 'x' }, 'c2'), use('open_tab', { url: 'https://x.test' }, 'c3'), use('run_script', { code: '1' }, 'c4'), use('read_urls', { urls: ['https://a.test'] }, 'c5')])
      : reply([text(`saw ${messages[2].content.filter((b) => b.is_error).length} refusals`)]));
    const r = await S.runHelper({ n: 1, task: 't', turn, exec: async (name) => { ran.push(name); return 'page'; }, tools: [] });
    check('read-only: click, type_text, open_tab and run_script are refused inside a helper and never run; reading still does', J(ran) === '["read_urls"]' && r.text === 'saw 4 refusals', J([ran, r]));
    check('read-only: the tool set is reading and search only', J([...S.HELPER_TOOLS].sort()) === '["analyze_posts","find_sources","read_urls","web_search"]');
  }

  // ---- one failure does not kill the others
  {
    const turn = async ({ messages }) => {
      if (/boom/.test(messages[0].content)) throw new Error('provider exploded');
      return reply([text(`done: ${messages[0].content.slice(6)}`)]);
    };
    const events = [];
    const results = await S.runHelpers({ tasks: [{ task: 'fine one', urls: [] }, { task: 'boom', urls: [] }, { task: 'fine two', urls: [] }], turn, exec, tools: [], onEvent: (e) => events.push(`${e.type}${e.n}${e.status ? `:${e.status}` : ''}`) });
    check('isolation: one helper failing leaves the others\' answers', J(results.map((r) => r.status)) === '["done","failed","done"]' && /fine one/.test(results[0].text) && /provider exploded/.test(results[1].error), J(results));
    check('progress: every helper reports start and done', ['start1', 'start2', 'start3', 'done1:done', 'done2:failed', 'done3:done'].every((e) => events.includes(e)), J(events));
    const body = S.formatResults(results, { dropped: 2, model: 'Haiku 5.5' });
    check('combined: one block, every helper numbered with its state, the dropped tasks named, all as untrusted content', /^<untrusted_page_content>/.test(body) && /Helper 1 \[done/.test(body) && /Helper 2 \[FAILED: provider exploded\]/.test(body) && /Helper 3 \[done/.test(body) && /Not run: 2 more tasks/.test(body) && /on Haiku 5.5/.test(body) && /nothing was clicked/.test(body), body);
  }

  // ---- the limiter keeps page reads bounded across helpers
  {
    const limited = S.createLimiter(3);
    let live = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => limited(1, async () => { live++; peak = Math.max(peak, live); await sleep(20); live--; })));
    check('limiter: no more reads in flight than the slots allow', peak === 3, String(peak));
  }

  // ---- Agent.delegate: approvals, usage, progress, the setting
  const tab = { id: 1, webContents: { id: 101, getURL: () => 'https://t.test/', isDestroyed: () => false } };
  const makeAgent = (extra = {}, model = 'claude-opus-5-5') => {
    const browser = { activeTab: () => tab, tabById: () => tab, listTabs: () => [], effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => '', maxSteps: () => 0, autoApprove: () => false, ...extra };
    const agent = new Agent(browser, () => null, () => ({ model }));
    agent.closeSignedInTabs = () => {};
    return agent;
  };
  const chatOf = (model = 'claude-opus-5-5') => { const m = []; m.settings = { model }; return m; };
  const inChat = (agent, chat, fn, signal = new AbortController().signal) => agent.inTask(1, signal, async () => {
    const events = [];
    await agent.ensureAllowed('delegate', (e) => events.push(e), signal, { input: {} });
    return { value: await fn(events), events };
  }, chat);
  {
    const agent = makeAgent();
    const used = [];
    agent.helperCall = async (model, { messages }) => { used.push(model); await sleep(60); return messages.length === 1 ? reply([use('read_urls', { urls: ['https://a.test/x'] })], { input_tokens: 1000, output_tokens: 100 }) : reply([text(`summary ${used.length}`)], { input_tokens: 1500, output_tokens: 50 }); };
    const ran = [];
    agent.execute = async (name, args) => { ran.push([name, args]); return `<untrusted_page_content>page</untrusted_page_content>`; };
    const chat = chatOf();
    const t0 = Date.now();
    const { value, events } = await inChat(agent, chat, () => agent.delegate({ tasks: [{ task: 'A' }, { task: 'B' }, { task: 'C' }] }));
    check('delegate: three helpers on the cheaper model run side by side and come back as one result', Date.now() - t0 < 400 && used.length === 6 && used.every((m) => m === 'claude-haiku-5-5') && /Helper 1 \[done/.test(value) && /Helper 3 \[done/.test(value) && /on Haiku 5.5/.test(value), `${Date.now() - t0} ms ${value}`);
    check('delegate: the tools a helper runs are the chat\'s own read_urls, with a page-size default and no sign-in', ran.length === 3 && ran.every(([n, a]) => n === 'read_urls' && a.max_chars === S.READ_CHARS && !a.as_user), J(ran));
    check('usage: the helpers\' tokens are summed into the chat\'s totals (6 turns, priced as Haiku)', chat.settings.usage.turns === 6 && chat.settings.usage.input === 7500 && chat.settings.usage.output === 450 && chat.settings.usage.cost > 0, J(chat.settings.usage));
    check('usage: the sidebar gets the new total as each helper turn lands', events.filter((e) => e.type === 'usage').length === 6);
    const tools = events.filter((e) => e.type === 'tool');
    check('progress: a step per helper showing its task, updated while it works, then marked done', tools.length === 3 && tools.every((e) => e.name === 'helper' && /^Helper \d: [ABC]$/.test(e.label)) && events.filter((e) => e.type === 'tool_update').some((e) => /reading pages/.test(e.label)) && events.filter((e) => e.type === 'tool_done' && e.ok).length === 3, J(events.filter((e) => e.type !== 'usage').map((e) => [e.type, e.label || e.ok])));
    check('taint: what helpers read marks the chat as having read page content', chat.tainted === true);
  }
  {
    const agent = makeAgent();
    agent.helperCall = async (model, { messages }) => (messages.length === 1 ? reply([use('click', { text: 'x' })]) : reply([text('could not')]));
    const ran = [];
    agent.execute = async (name) => { ran.push(name); return 'x'; };
    const { value } = await inChat(agent, chatOf(), () => agent.delegate({ tasks: [{ task: 'try clicking' }] }));
    check('delegate: a helper asking for click gets a refusal; nothing reaches the tab tools', ran.length === 0 && /could not/.test(value));
  }
  {
    const agent = makeAgent();
    agent.helperCall = async (model, { messages }) => (messages.length === 1 ? reply([use('read_urls', { urls: ['https://a.test'], as_user: true })]) : reply([text(`got ${messages[2].content[0].content}`)]));
    agent.execute = async () => { throw new Error('should not run'); };
    const { value } = await inChat(agent, chatOf(), () => agent.delegate({ tasks: [{ task: 'read my inbox' }] }));
    check('delegate: signed-in reads (as_user) are refused for helpers', /signed out only/.test(value), value);
  }
  {
    // approvals: a chat that has read a page needs the user's OK for each new site; a helper that has read one needs it for the next
    const agent = makeAgent();
    const cards = [];
    agent.askApproval = async (host) => { cards.push(host); return host !== 'blocked.test'; };
    agent.helperCall = async (model, { messages }) => {
      if (messages.length === 1) return reply([use('read_urls', { urls: [/blocked/.test(messages[0].content) ? 'https://blocked.test/p' : 'https://fresh.test/p'] })]);
      return reply([text(`saw: ${String(messages[2].content[0].content).slice(0, 60)}`)]);
    };
    agent.execute = async () => 'page text';
    const chat = chatOf();
    chat.tainted = true; // the chat has already read a page
    const { value } = await inChat(agent, chat, () => agent.delegate({ tasks: [{ task: 'allowed site' }, { task: 'blocked site' }] }));
    check('approval: in a chat that has read pages each new site goes through the usual card, once, and a "no" fails that read only', J(cards.sort()) === '["blocked.test","fresh.test"]' && /Helper 1 \[done/.test(value) && /did not allow opening blocked\.test/.test(value) && /Helper 2 \[done/.test(value), J([cards, value]));
    const clean = makeAgent();
    const asked = [];
    clean.askApproval = async (host) => { asked.push(host); return true; };
    clean.helperCall = agent.helperCall;
    clean.execute = async () => 'page text';
    await inChat(clean, chatOf(), () => clean.delegate({ tasks: [{ task: 'allowed site' }] }));
    check('approval: like the chat, a first read in a clean chat needs no card', asked.length === 0, J(asked));
    const hosts = new Set(['fresh.test']);
    const pre = makeAgent();
    const preAsked = [];
    pre.askApproval = async (host) => { preAsked.push(host); return true; };
    pre.helperCall = agent.helperCall;
    pre.execute = async () => 'page text';
    const preChat = chatOf();
    preChat.tainted = true;
    await pre.inTask(1, new AbortController().signal, async () => { await pre.ensureAllowed('delegate', () => {}, new AbortController().signal, { input: {}, hosts }); await pre.delegate({ tasks: [{ task: 'allowed site' }] }); }, preChat, null, { hosts });
    check('approval: a site the user already approved in this chat is not asked about again', preAsked.length === 0, J(preAsked));
  }
  {
    const agent = makeAgent();
    const used = [];
    agent.helperCall = async (model, { messages }) => { used.push(model); if (model === 'claude-haiku-5-5') throw Object.assign(new Error('model: claude-haiku-5-5 not found'), { status: 404 }); return reply([text('ok on own model')]); };
    const { value } = await inChat(agent, chatOf(), () => agent.delegate({ tasks: [{ task: 'A' }] }));
    check('fallback: a cheaper model the key cannot use falls back to the chat\'s own model', used.join() === 'claude-haiku-5-5,claude-opus-5-5' && /ok on own model/.test(value), J([used, value]));
    const same = makeAgent({ subagentModel: () => 'same' });
    const sameUsed = [];
    same.helperCall = async (model) => { sameUsed.push(model); return reply([text('x')]); };
    await inChat(same, chatOf(), () => same.delegate({ tasks: [{ task: 'A' }] }));
    check('setting: "same as the chat" uses the chat\'s own model', sameUsed.join() === 'claude-opus-5-5', J(sameUsed));
    const oa = makeAgent({}, 'openai:gpt-5.6');
    const oaUsed = [];
    oa.helperCall = async (model) => { oaUsed.push(model); return reply([text('x')]); };
    await inChat(oa, chatOf('openai:gpt-5.6'), () => oa.delegate({ tasks: [{ task: 'A' }] }));
    check('model: an OpenAI chat\'s helpers use the mini', oaUsed.join() === 'openai:gpt-5.6-mini', J(oaUsed));
  }
  {
    const agent = makeAgent();
    const ctl = new AbortController();
    agent.helperCall = (model, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const pending = inChat(agent, chatOf(), () => agent.delegate({ tasks: [{ task: 'A' }] }), ctl.signal);
    setTimeout(() => ctl.abort(), 40);
    let err = null;
    try { await pending; } catch (e) { err = e; }
    check('stop: stopping the chat while helpers work ends the delegate call', err !== null);
  }

  // ---- the tool in the request, and the setting that removes it
  {
    const chat = chatOf();
    const on = requestFor(chat.settings, chat);
    const off = requestFor(chat.settings, chat, undefined, { delegate: false });
    check('tool: offered by default, with the whole tool list still under budget', on.tools.some((t) => t.name === 'delegate') && JSON.stringify(on.tools).length < 15000, String(JSON.stringify(on.tools).length));
    check('setting off: the tool is not in the request', !off.tools.some((t) => t.name === 'delegate') && off.tools.length === on.tools.length - 1);
    check('tool: a short definition', JSON.stringify(on.tools.find((t) => t.name === 'delegate')).length < 700, String(JSON.stringify(on.tools.find((t) => t.name === 'delegate')).length));
    check('tool: input is checked like any other tool\'s', validateInput('delegate', { tasks: [{ task: 'x' }] }) === null && validateInput('delegate', {}) !== null && validateInput('delegate', { tasks: [{}] }) !== null && validateInput('delegate', { tasks: 'x' }) !== null);
    check('tool: not listed to MCP clients or the CLI engines (they have their own helpers)', !EXTERNAL_TOOLS.some((t) => t.name === 'delegate'));
    const agent = makeAgent();
    const live = { on: true };
    const withSetting = makeAgent({ subagents: () => live.on });
    check('setting: the agent reads it on every message (default on)', agent.subagentsOn() === true && withSetting.subagentsOn() === true && (live.on = false, withSetting.subagentsOn() === false) && (live.on = true, withSetting.subagentsOn() === true));
    const claudeParams = [];
    const wired = makeAgent({ subagents: () => live.on });
    wired.getClient = () => ({ beta: { messages: { stream: (params) => { claudeParams.push(params); return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => reply([text('hi')]) }; } } } });
    live.on = false;
    await wired.claudeTurn(chat, new AbortController().signal, () => {});
    live.on = true;
    await wired.claudeTurn(chat, new AbortController().signal, () => {});
    check('setting: the next claudeTurn offers the tool only while it is on', !claudeParams[0].tools.some((t) => t.name === 'delegate') && claudeParams[1].tools.some((t) => t.name === 'delegate'), J(claudeParams.map((p) => p.tools.length)));
  }

  // ---- lists, settings and the sidebar button
  {
    const lg = src('src/ai/loop-guard.js');
    const ag = src('src/ai/agent.js');
    check('lists: delegate is a parallel, static read; tab-free; leaves the tab snapshots alone', /STATIC_READS = new Set\(\['find_sources', 'delegate'/.test(lg) && /PARALLEL_READS = new Set\(\['find_sources', 'delegate'/.test(lg) && /TAB_FREE_TOOLS = new Set\(\['find_sources', 'research_board', 'delegate'/.test(ag) && /READ_ONLY = new Set\(\['find_sources', 'delegate'/.test(src('src/ai/snapshot.js')));
    check('lists: delegate itself is not a READING tool (the helpers\' own reads taint the chat)', !/const READING_TOOLS = new Set\([^)]*delegate/.test(ag));
    const en = JSON.parse(src('src/locales/en.json'));
    const keys = ['sidebar.helpers', 'sidebar.helpers.on', 'sidebar.helpers.off', 'tool.delegate', 'tool.helper', 'tool.helper.reading', 'tool.helper.searching', 'settings.ai.subagents', 'settings.ai.subagentsDesc', 'settings.ai.subagentModel', 'settings.ai.subagentModel.auto', 'settings.ai.subagentModel.same'];
    check('strings: the sidebar button, step labels and settings rows are in en.json', keys.every((k) => typeof en[k] === 'string' && en[k]), keys.filter((k) => !en[k]).join());
    const backend = src('src/settings/settings-backend.js');
    check('settings: aiSubagents defaults on, the model choice is auto | same, and a change reaches the sidebar through prefs:ui', /aiSubagents: true/.test(backend) && /aiSubagentModel: 'auto'/.test(backend) && /case 'aiSubagentModel': return pick\(value, \['auto', 'same'\]/.test(backend) && /helpers: p\.aiSubagents !== false/.test(backend) && /key === 'aiSubagents'/.test(backend));
    const main = src('src/main.js');
    check('wiring: main reads the one setting for the agent and answers the sidebar button; both preloads expose it', /subagents: \(\) => readSettings\(\)\.aiSubagents !== false/.test(main) && /ipcMain\.handle\('agent:helpers'/.test(main) && /aiSubagents: on/.test(main) && /helpers: \(on\) => ipcRenderer\.invoke\('agent:helpers'/.test(src('src/preload/preload.js')) && /helpers: \(on\) => ipcRenderer\.invoke\('agent:helpers'/.test(src('src/features/chat-preload.js')) && /agent:helpers/.test(src('src/preload/preload.bundle.js')));
    const html = src('src/renderer/index.src.html');
    const core = src('src/renderer/chat-core.js');
    check('sidebar: a compact Helpers button in the head, a pressed state, a tooltip, kept in sync with Settings both ways', /id="helpers-btn"/.test(html) && /aria-pressed="true"/.test(html.match(/id="helpers-btn"[^>]*>/)[0]) && /window\.assistant\.helpers\?\.\(!helpersOn\)/.test(core) && /addEventListener\('lumen:helpers'/.test(core) && /lumen:helpers/.test(src('src/renderer/ui-prefs.js')) && /sidebar\.helpers\.on/.test(core));
    const settings = src('src/renderer/settings.js');
    check('settings page: the toggle and model row, and it follows the sidebar button when the page regains focus', /toggle\('aiSubagents'/.test(settings) && /select\('aiSubagentModel'/.test(settings) && /fresh\.prefs\.aiSubagents !== st\.prefs\.aiSubagents/.test(settings));
    const bundle = src('src/renderer/ui.bundle.js');
    check('bundle: ui.bundle.js carries the button wiring', /window\.assistant\.helpers\?\.\(!helpersOn\)/.test(bundle) && /id="helpers-btn"/.test(src('src/renderer/index.html')));
    check('labels: the sidebar knows the delegate and helper steps', /delegate: \(i\) => t\('tool\.delegate'/.test(core) && /helper: \(i\) =>/.test(core));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
