// /btw: a side question answered beside the running task (ai/btw.js, Agent.btw in agent.js, the "/btw" command and its cards in
// renderer/chat-commands.js, the IPC in main.js). Plain Node: no Electron, no network; the model is mocked and the sidebar's DOM is a stub.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const B = require('../src/ai/btw');
const providers = require('../src/ai/providers');
const { Agent } = require('../src/ai/agent');
const slashMatch = require('../src/renderer/slash-match');
const { describeUsage } = require('../src/features/chat-usage');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const reply = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

const OPTIONS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', group: 'Claude', provider: 'Claude' },
  { id: 'openai:gpt-5.6', label: 'GPT-5.6', group: 'OpenAI', provider: 'OpenAI' },
  { id: 'xai:grok-4', label: 'Grok 4', group: 'xAI', provider: 'xAI' },
  { id: 'claudecode:default', label: 'Claude Code', provider: 'Claude Code' },
  { id: 'codex:default', label: 'Codex', provider: 'Codex' },
];

(async () => {
  // ---- the question, the tab, the request
  check('question: /btw and the spaces after it come off', B.parseQuestion('/btw  what was that? ') === 'what was that?' && B.parseQuestion('/BTW x') === 'x' && B.parseQuestion('  ') === '' && B.parseQuestion('/btwx') === '/btwx');
  check('url: query, fragment and sign-in parts are left out; odd schemes are not sent', B.plainUrl('https://u:p@a.test/p?token=1#x') === 'https://a.test/p' && B.plainUrl('javascript:alert(1)') === '' && B.plainUrl('nonsense') === '');
  const built = B.buildMessages({ transcript: 'User: hi\n\nAssistant: hello', tab: { title: 'Docs\nPage', url: 'https://a.test/x?secret=1' }, question: 'what was that' });
  const text = built[0].content;
  check('request: one user message with the chat so far, the tab and the question; no tools field of any kind', built.length === 1 && /<conversation_so_far>\nUser: hi/.test(text) && /Title: Docs Page/.test(text) && /URL: https:\/\/a\.test\/x\n/.test(text) && !/secret/.test(text) && /Side question: what was that$/.test(text), text);
  check('request: no tab is said, not guessed', /<current_tab>\(none\)<\/current_tab>/.test(B.buildMessages({ question: 'q' })[0].content));

  // ---- which model answers
  check('plan: an API chat uses its provider\'s cheaper sibling', B.plan({ chatModel: 'claude-opus-5-5', options: OPTIONS }).model === 'claude-haiku-4-5' && B.plan({ chatModel: 'openai:gpt-5.6', options: OPTIONS }).model === 'openai:gpt-5.6-mini' && B.plan({ chatModel: 'xai:grok-4', options: OPTIONS }).model === 'xai:grok-4');
  check('plan: "same model" keeps the chat\'s own', B.plan({ chatModel: 'claude-opus-5-5', options: OPTIONS, mode: 'same' }).model === 'claude-opus-5-5');
  let p = B.plan({ chatModel: 'claudecode:default', defaultModel: 'openai:gpt-5.6', options: OPTIONS });
  check('plan: Claude Code falls back to its own vendor\'s API model first, cheaper sibling', p.model === 'claude-haiku-4-5' && p.engine === 'claudecode:default' && p.viaDefault === false, J(p));
  p = B.plan({ chatModel: 'codex:default', defaultModel: 'xai:grok-4', options: OPTIONS });
  check('plan: Codex falls back to OpenAI', p.model === 'openai:gpt-5.6-mini' && p.engine === 'codex:default' && !p.viaDefault, J(p));
  p = B.plan({ chatModel: 'antigravity:default', defaultModel: 'xai:grok-4', options: OPTIONS });
  check('plan: an engine whose vendor is not connected uses the default API model', p.own === 'xai:grok-4' && p.viaDefault === true, J(p));
  p = B.plan({ chatModel: 'grokbuild:default', defaultModel: 'gemini:gemini-2.5-pro', options: OPTIONS.filter((o) => o.id !== 'xai:grok-4') });
  check('plan: ... a default that is not connected is skipped for any connected one', p.own === 'claude-opus-5-5' && p.viaDefault === true, J(p));
  p = B.plan({ chatModel: 'antigravity:default', defaultModel: 'claudecode:default', options: OPTIONS });
  check('plan: ... a default that is itself an engine is skipped', p.own === 'claude-opus-5-5' && p.viaDefault === true && p.engine === 'antigravity:default', J(p));
  check('plan: only engines connected -> no model', B.plan({ chatModel: 'claudecode:default', defaultModel: 'claudecode:default', options: OPTIONS.filter((o) => /^(claudecode|codex):/.test(o.id)) }) === null);

  // ---- run(): mocked model
  {
    const calls = [];
    const call = async (model, args) => { calls.push({ model, ...args }); args.onText('Hel'); args.onText('lo'); return { content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 10, output_tokens: 2 } }; };
    const chunks = [];
    const usage = [];
    const r = await B.run({ chatModel: 'claude-opus-5-5', options: OPTIONS, transcript: 'User: hi', tab: null, question: '/btw hi?', call, onText: (c) => chunks.push(c), onUsage: (m, model) => usage.push(model) });
    check('run: streams the text, answers, reports usage once on the model that answered', r.ok && r.text === 'Hello' && chunks.join('') === 'Hello' && r.model === 'claude-haiku-4-5' && J(usage) === '["claude-haiku-4-5"]', J(r));
    check('run: the model call gets a system prompt and messages only (no tools)', calls.length === 1 && Object.keys(calls[0]).sort().join() === 'messages,model,onText,signal,system' && /no tools/i.test(calls[0].system), J(Object.keys(calls[0])));
    const refusing = []; // the cheaper model is not on this key: the chat's own, once
    const r2 = await B.run({ chatModel: 'claude-opus-5-5', options: OPTIONS, question: 'q', call: async (model) => { refusing.push(model); if (model === 'claude-haiku-4-5') throw Object.assign(new Error('model not found'), { status: 404 }); return { content: [{ type: 'text', text: 'ok' }], usage: null }; } });
    check('run: a refused cheaper model falls back to the chat\'s own', r2.ok && J(refusing) === '["claude-haiku-4-5","claude-opus-5-5"]' && r2.model === 'claude-opus-5-5', J(r2));
    const r3 = await B.run({ chatModel: 'claude-opus-5-5', options: OPTIONS, question: 'q', call: async () => { throw new Error('boom\nstack'); } });
    check('run: an error is a result, never a throw', r3.ok === false && r3.error === 'boom', J(r3));
    check('run: nothing typed / nothing connected are results too', (await B.run({ chatModel: 'x', question: '/btw ', call })).error === 'empty' && (await B.run({ chatModel: 'claudecode:default', defaultModel: '', options: [], question: 'q', call })).error === 'no-provider');
    const ac = new AbortController();
    const slow = B.run({ chatModel: 'claude-opus-5-5', options: OPTIONS, question: 'q', signal: ac.signal, call: (m, a) => new Promise((_, rej) => a.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    ac.abort();
    check('run: dismissing the card cancels the call', (await slow).error === 'stopped');
    const late = await B.run({ chatModel: 'claude-opus-5-5', options: OPTIONS, question: 'q', timeMs: 30, call: (m, a) => new Promise((_, rej) => a.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    check('run: a hard time limit', late.error === 'timeout');
  }

  // ---- Agent.btw beside a task in flight
  const fakeBrowser = (extra = {}) => ({ activeTab: () => null, tabById: () => null, listTabs: () => [], effectiveModel: (x) => x, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0, fallbackOptions: () => OPTIONS, ...extra });
  const textStream = (message, onStart = () => {}) => ({ async *[Symbol.asyncIterator]() { await onStart(); yield { type: 'content_block_start', content_block: { type: 'text' } }; yield { type: 'content_block_delta', delta: { type: 'text_delta', text: message.content[0].text } }; }, finalMessage: async () => message });
  {
    const requests = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const client = { beta: { messages: { stream: (params) => {
      requests.push(params);
      const isBtw = /Side question:/.test(J(params.messages));
      const message = { role: 'assistant', model: params.model, content: [{ type: 'text', text: isBtw ? 'It was the pricing page.' : 'Task done.' }], stop_reason: 'end_turn', usage: { input_tokens: isBtw ? 100 : 40, output_tokens: isBtw ? 7 : 5 } };
      return textStream(message, isBtw ? () => {} : () => gate); // the main task is held until released
    } } } };
    const agent = new Agent(fakeBrowser(), () => client, () => ({ model: 'claude-opus-5-5' }));
    agent.closeSignedInTabs = () => {};
    agent.newActionLog = () => ({});
    agent.undoSummary = () => null;
    const events = [];
    const done = new Promise((resolve) => agent.run('open the pricing page and summarize it', (e) => { events.push(e); if (e.type === 'done') resolve(); }));
    for (let i = 0; i < 200 && !requests.length; i++) await sleep(10);
    const chat = agent.messages;
    check('setup: the main task is in flight (its request is out, held)', requests.length === 1 && !events.some((e) => e.type === 'done'));
    const historyBefore = J(chat);
    const usageBefore = chat.settings.usage?.turns || 0;
    const streamed = [];
    const usageEvents = [];
    const t0 = Date.now();
    const r = await agent.btw({ messages: chat, tab: { title: 'Pricing', url: 'https://a.test/pricing?x=1' }, question: '/btw which page was that?', signal: new AbortController().signal, onText: (c) => streamed.push(c), emit: (e) => usageEvents.push(e) });
    check('btw: answered while the main task is still held (it did not wait for it, stop it or queue)', r.ok && r.text === 'It was the pricing page.' && streamed.join('') === 'It was the pricing page.' && !events.some((e) => e.type === 'done') && Date.now() - t0 < 2000, J(r));
    const btwReq = requests.find((q) => /Side question:/.test(J(q.messages)));
    check('btw: one request, on the cheaper sibling, with no tools and no tool_choice', requests.length === 2 && btwReq.model === 'claude-haiku-4-5' && btwReq.tools === undefined && btwReq.tool_choice === undefined && typeof btwReq.system === 'string', J(Object.keys(btwReq)));
    check('btw: the request holds the chat so far and the tab, not the main prompt\'s tools or page text', /open the pricing page/.test(J(btwReq.messages)) && /Title: Pricing/.test(J(btwReq.messages)) && !/browser_state/.test(J(btwReq)), J(btwReq.messages).slice(0, 300));
    check('btw: the chat\'s history is untouched while it runs', J(chat) === historyBefore || (J(chat.slice(0, 1)) === J(JSON.parse(historyBefore).slice(0, 1)) && !J(chat).includes('which page was that')));
    check('btw: its tokens join the chat\'s usage totals and the sidebar is told', chat.settings.usage.turns === usageBefore + 1 && chat.settings.usage.input >= 100 && chat.settings.usage.output >= 7 && usageEvents.some((e) => e.type === 'usage' && e.usage.turns === usageBefore + 1), J(chat.settings.usage));
    release();
    await done;
    const after = J(chat);
    check('btw: after the task ends, the question and the answer are in no message the model will see again', !after.includes('which page was that') && !after.includes('It was the pricing page'), after.slice(0, 300));
    check('btw: the main task finished normally (not stopped, no error, no loop-guard notice)', events.some((e) => e.type === 'text' && /Task done/.test(e.text)) && !events.some((e) => e.type === 'error' || (e.type === 'notice' && /Stopped|stuck|repeat/i.test(e.text))), J(events.map((e) => e.type)));
    check('btw: the usage line counts both calls', describeUsage(chat.settings.usage).includes('tokens') && chat.settings.usage.turns === usageBefore + 2, J(chat.settings.usage));
  }

  // ---- other providers, through providers.streamTurn, still without tools
  {
    const seen = [];
    const realStream = providers.streamTurn;
    providers.streamTurn = async (args) => { seen.push(args); args.emit({ type: 'text_block' }); args.emit({ type: 'text', text: 'From OpenAI.' }); return { content: [{ type: 'text', text: 'From OpenAI.' }], stop_reason: 'end_turn', model: `openai:${args.model}`, usage: { prompt_tokens: 50, completion_tokens: 4 } }; };
    try {
      const agent = new Agent(fakeBrowser(), () => null, () => ({ model: 'claudecode:default' }), (provider) => (provider === 'openai' ? 'sk-test' : null));
      const chat = [user('hello'), reply('hi there')];
      chat.settings = { model: 'openai:gpt-5.6' };
      const chunks = [];
      const r = await agent.btw({ messages: chat, question: 'what did I say first?', onText: (c) => chunks.push(c) });
      check('openai: streamed, on the mini sibling, with no tools (tools empty, noTools set)', r.ok && chunks.join('') === 'From OpenAI.' && seen.length === 1 && seen[0].model === 'gpt-5.6-mini' && J(seen[0].tools) === '[]' && seen[0].noTools === true, J(seen.map((s) => [s.model, s.tools, s.noTools])));
      check('openai: usage counted, history unchanged', chat.settings.usage.turns === 1 && chat.length === 2, J(chat.settings.usage));
      const none = new Agent(fakeBrowser(), () => null, () => ({ model: 'openai:gpt-5.6' }), () => null);
      const c2 = [user('x')];
      c2.settings = { model: 'openai:gpt-5.6' };
      const r2 = await none.btw({ messages: c2, question: 'q' });
      check('openai: no API key is a clear error in the result', r2.ok === false && /Add your OpenAI API key/.test(r2.error), J(r2));

      // an engine chat: Claude Code is not asked; its vendor's API model answers and the result says so
      const client = { beta: { messages: { stream: (params) => { seen.push({ anthropic: params }); const message = { content: [{ type: 'text', text: 'From Haiku.' }], usage: { input_tokens: 9, output_tokens: 3 } }; return textStream(message); } } } };
      const eng = new Agent(fakeBrowser(), () => client, () => ({ model: 'claudecode:default' }));
      const c3 = [user('fix the build'), reply('on it')];
      c3.settings = { model: 'claudecode:default', ccSession: 'abc' };
      const r3 = await eng.btw({ messages: c3, question: 'what did I ask?' });
      const anth = seen.find((s) => s.anthropic)?.anthropic;
      check('engine: a Claude Code chat is answered by Claude Haiku over the API, no tools, no engine process', r3.ok && r3.text === 'From Haiku.' && anth?.model === 'claude-haiku-4-5' && anth.tools === undefined && r3.engine === 'claudecode:default' && r3.viaDefault === false, J(r3));
      check('engine: the result names who answered and which engine was not asked', r3.name === 'Claude Haiku 4.5' && r3.engineName === 'Claude Code', J([r3.name, r3.engineName]));
      check('engine: the chat\'s Claude Code session and history are untouched', c3.settings.ccSession === 'abc' && c3.length === 2 && c3.settings.usage.turns === 1);
      const lone = new Agent(fakeBrowser({ fallbackOptions: () => OPTIONS.filter((o) => /^(claudecode|codex):/.test(o.id)) }), () => null, () => ({ model: 'claudecode:default' }));
      const c4 = [user('x')];
      c4.settings = { model: 'claudecode:default' };
      check('engine: with no API model connected the result says no-provider', (await lone.btw({ messages: c4, question: 'q' })).error === 'no-provider');
    } finally { providers.streamTurn = realStream; }
  }

  // ---- the slash menu and the card (renderer/chat-commands.js on a stub DOM)
  {
    const registered = new Map();
    const els = new Map();
    class El {
      constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.handlers = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.value = ''; this.classList = { add: (c) => { this.className += ` ${c}`; }, remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); }, contains: (c) => this.className.split(/\s+/).includes(c) }; this.scrollTop = 0; this.scrollHeight = 0; }
      append(...n) { this.children.push(...n); }
      prepend(...n) { this.children.unshift(...n); }
      remove() { this.removed = true; for (const parent of allEls) parent.children = parent.children.filter((c) => c !== this); }
      setAttribute(k, v) { this.attrs[k] = v; }
      removeAttribute(k) { delete this.attrs[k]; }
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
      focus() { this.focused = true; }
      click() { for (const h of this.handlers.click || []) h(); }
    }
    const allEls = [];
    const make = (tag) => { const e = new El(tag); allEls.push(e); return e; };
    const byId = (id) => { if (!els.has(id)) els.set(id, make('div')); return els.get(id); };
    const document = { getElementById: byId, createElement: make };
    const calls = [];
    const finishers = [];
    const assistant = { btw: (id, q) => { calls.push({ id, q }); return new Promise((r) => { finishers.push(r); }); }, btwCancel: (id) => calls.push({ cancel: id }), onBtw: (cb) => { assistant.emit = cb; }, onSync: () => {} };
    const window = { slashCommands: { register: (c) => { registered.set(c.name, c); }, list: () => [...registered.values()] }, assistant, t: (key) => key, renderMarkdown: (s) => `<p>${s}</p>` };
    const ctx = vm.createContext({ window, document, setTimeout, console, shownChatId: 'c1' });
    vm.runInContext(src('src/renderer/chat-commands.js'), ctx);
    const cmd = registered.get('btw');
    check('menu: /btw is registered with a one-line description and an argument field', cmd && cmd.takesInput === true && cmd.description && !/\n/.test(cmd.description) && cmd.hint, J(cmd));
    check('menu: typing /bt finds it', slashMatch.rank([...registered.values()], 'bt')[0]?.name === 'btw' && slashMatch.parse('/btw what now', (n) => registered.has(n)).kind === 'chip');
    const en = JSON.parse(src('src/locales/en.json'));
    const keys = ['slash.btw', 'slash.btw.description', 'slash.btw.hint', 'btw.tag', 'btw.thinking', 'btw.dismiss', 'btw.needQuestion', 'btw.noProvider', 'btw.timeout', 'btw.failed', 'btw.via', 'btw.via.engine', 'btw.via.engineDefault'];
    check('strings: every /btw string is in locales/en.json', keys.every((k) => typeof en[k] === 'string' && en[k]), keys.filter((k) => !en[k]).join());
    check('menu: the description in en.json is what the menu shows (the code\'s fallback is the same text)', cmd.description === en['slash.btw.description']);
    const asked = [];
    const empty = cmd.run({ input: '', ask: (t) => asked.push(t) });
    check('run: no question says what to type and sends nothing', empty.ok === false && /\/btw/.test(empty.message) && !calls.length);
    const tray = byId('composer').children.find((c) => c.className.includes('btw-tray'));
    const r = cmd.run({ input: 'what was that link?', ask: (t) => asked.push(t) });
    check('run: sends the question to main as a side call, never through the chat\'s ask/queue', r.ok && calls.length === 1 && calls[0].q === 'what was that link?' && /^btw-/.test(calls[0].id) && asked.length === 0);
    check('card: it shows at once with a spinner, labelled btw, in the tray above the composer text', tray && !tray.hidden && tray.children.length === 1 && tray.children[0].children[1].className.includes('btw-waiting') && tray.children[0].children[0].children[0].textContent === 'btw', J(tray?.children.length));
    const card = tray.children[0];
    assistant.emit({ id: calls[0].id, type: 'text', text: 'Part ' });
    assistant.emit({ id: calls[0].id, type: 'text', text: 'one.' });
    check('card: streamed text appears as it arrives', card.children[1].textContent === 'Part one.' && !card.children[1].className.includes('btw-waiting'));
    const r2 = cmd.run({ input: 'and another?', ask: () => {} });
    check('card: several can be open at once', r2.ok && tray.children.length === 2 && calls.length === 2);
    finishers[0]({ ok: true, text: 'Part one.', name: 'Claude Haiku 4.5', engineName: 'Claude Code', engine: 'claudecode:default', viaDefault: false });
    await sleep(5);
    check('card: when done it renders the answer and says which model answered, and why not the engine', card.children[1].innerHTML === '<p>Part one.</p>' && /Answered by Claude Haiku 4\.5, not Claude Code/.test(card.children[2].textContent) && card.children[2].hidden === false, J([card.children[1].innerHTML, card.children[2].textContent]));
    // dismiss: the close button cancels one still running and removes the card; Esc in the empty composer takes the newest
    const second = tray.children[1];
    const closeBtn = second.children[0].children[2];
    check('card: × is a labelled button', closeBtn.attrs['aria-label'] && closeBtn.textContent === '×');
    closeBtn.click();
    check('card: × dismisses it and cancels the call in flight', tray.children.length === 1 && calls.some((c) => c.cancel === calls[1].id));
    const prompt = byId('prompt');
    let prevented = 0;
    for (const h of prompt.handlers.keydown || []) h({ key: 'Escape', target: prompt, isComposing: false, preventDefault: () => { prevented++; }, stopImmediatePropagation: () => { prevented++; } });
    check('card: Esc in an empty composer dismisses the newest card (and is not also Stop)', tray.children.length === 0 && tray.hidden === true && prevented >= 2);
    for (const h of prompt.handlers.keydown || []) h({ key: 'Escape', target: prompt, isComposing: false, preventDefault: () => { prevented += 10; }, stopImmediatePropagation: () => { prevented += 10; } });
    check('card: with no card left Esc is untouched (it stops a running reply as before)', prevented < 10);
    cmd.run({ input: 'fails', ask: () => {} });
    finishers[2]({ ok: false, error: 'no-provider' });
    await sleep(5);
    check('card: no provider is said in plain words', /No API model is connected/.test(byId('composer').children[0].children.at(-1).children[1].textContent), J(byId('composer').children[0].children.map((c) => c.children[1]?.textContent)));
  }

  // ---- the wiring (main.js, preloads, chat page, skills)
  {
    const main = src('src/main.js');
    check('wiring: main answers agent:btw with a call that never goes through agent.run or the chat\'s run slots', /ipcMain\.handle\('agent:btw'/.test(main) && !/agent:btw'[\s\S]{0,2600}?(agent\.run\(|runSlots\.request|chatRuns\.set)/.test(main.slice(main.indexOf("ipcMain.handle('agent:btw'"), main.indexOf("ipcMain.on('agent:btw-cancel'"))));
    check('wiring: both channels are in UI_ONLY_IPC and the chat page\'s list; both preloads expose btw', /UI_ONLY_IPC[\s\S]{0,1500}'agent:btw', 'agent:btw-cancel'/.test(main) && /'agent:btw', 'agent:btw-cancel'/.test(src('src/features/chat-page.js')) && /agent:btw'/.test(src('src/preload/preload.js')) && /agent:btw'/.test(src('src/preload/preload.bundle.js')) && /agent:btw'/.test(src('src/features/chat-preload.js')));
    check('wiring: the sidebar bundle carries the command', /name: 'btw'/.test(src('src/renderer/ui.bundle.js')));
    check('wiring: a skill cannot take the name', /RESERVED = new Set\([^)]*'btw'/.test(src('src/features/skills.js')));
    check('wiring: the main loop and its prompt never mention /btw (it adds nothing to the main prompt)', !/btw/i.test(src('src/ai/loop-guard.js')));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
