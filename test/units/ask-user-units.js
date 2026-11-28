// [ask options] ask_user: the AI asks with a card of clickable answers (ai/ask-user.js rules, Agent.askUserTool / answerAsk in agent.js, the
// CLI engines' extra in features/ai-agents.js, the saved cards in chat-branches.js, the card in renderer/ask-card.js). Plain Node: no
// Electron, no network; the card runs against a small DOM stub.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('../../src/ai/ask-user');
const agentLib = require('../../src/ai/agent');
const branches = require('../../src/features/chat-branches');
const planMode = require('../../src/ai/plan-mode');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

const GRAD = { question: 'What month in 2029 do you expect to graduate?', header: 'Graduation', options: ['May 2029', 'December 2029', 'August 2029'] };
const WHICH = { question: 'Which application did you mean?', options: ['Northport', 'Waltham'] };

(async () => {
  // ---- the schema and its checks
  const v = A.validateAsk({ questions: [GRAD, { ...WHICH, multi_select: true }] });
  check('valid: two questions with their options, header and multi', v.questions?.length === 2 && v.questions[0].header === 'Graduation' && v.questions[0].options.map((o) => o.label).join('|') === 'May 2029|December 2029|August 2029' && v.questions[1].multi === true && v.questions[0].multi === false, J(v));
  check('valid: an option with a description keeps it', A.validateAsk({ questions: [{ question: 'Q?', options: [{ label: 'A', description: 'the first' }, 'B'] }] }).questions?.[0].options[0].description === 'the first');
  check('valid: duplicate options and an "Other" option are dropped (the card has its own Other box)', A.validateAsk({ questions: [{ question: 'Q?', options: ['Yes', 'yes', 'No', 'Other'] }] }).questions?.[0].options.length === 2);
  check('invalid: fewer than two options', /at least 2/.test(A.validateAsk({ questions: [{ question: 'Q?', options: ['Only'] }] }).error));
  check('invalid: more than six options', /more than 6/.test(A.validateAsk({ questions: [{ question: 'Q?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }] }).error));
  check('invalid: more than four questions', /at most 4/.test(A.validateAsk({ questions: Array.from({ length: 5 }, () => WHICH) }).error));
  check('invalid: no question text', /no question/.test(A.validateAsk({ questions: [{ question: ' ', options: ['a', 'b'] }] }).error));
  check('invalid: not an object', Boolean(A.validateAsk(null).error) && Boolean(A.validateAsk({ questions: [] }).error));
  check('long text is cut to the limits', A.validateAsk({ questions: [{ question: 'x'.repeat(900), options: ['y'.repeat(300), 'b'] }] }).questions[0].options[0].label.length === A.LIMITS.option);
  check('the tool: name, required questions, 2-6 string options', A.ASK_TOOL.name === 'ask_user' && J(A.ASK_TOOL.input_schema.required) === '["questions"]' && A.ASK_TOOL.input_schema.properties.questions.items.properties.options.minItems === 2 && A.ASK_TOOL.input_schema.properties.questions.items.properties.options.maxItems === 6);
  check('the tool tells the model to use it instead of a list in prose', /instead of writing questions as a list/.test(A.ASK_TOOL.description));
  check('agent validateInput knows ask_user (MCP calls are checked against it)', agentLib.validateInput('ask_user', { questions: [GRAD] }) === null && /questions/.test(agentLib.validateInput('ask_user', {}) || '') && /must be/.test(agentLib.validateInput('ask_user', { questions: [{ question: 'Q', options: 'a, b' }] }) || ''));

  // ---- answers and what the model reads back
  const qs = v.questions;
  check('answers: one pick per single question, several for a multi one', J(A.checkAnswers(qs, [['May 2029'], ['Northport', 'Waltham']])) === '[["May 2029"],["Northport","Waltham"]]');
  check('answers: two picks on a single question are refused', A.checkAnswers(qs, [['May 2029', 'August 2029'], ['Waltham']]) === null);
  check('answers: an unanswered question is refused', A.checkAnswers(qs, [['May 2029'], []]) === null && A.checkAnswers(qs, [['May 2029']]) === null);
  check('answers: an Other text is taken as typed', J(A.checkAnswers(qs, [['  June   2029 '], ['Waltham']])) === '[["June 2029"],["Waltham"]]');
  const text = A.answerText(qs, [['May 2029'], ['Waltham']]);
  check('result: each question with its answer, and go on', /The user answered:/.test(text) && /1\. What month in 2029 do you expect to graduate\? → May 2029/.test(text) && /2\. Which application did you mean\? → Waltham/.test(text) && /Go on with the task/.test(text), text);
  check('message form: just the answers (a card whose run has ended sends this)', A.answerText([qs[1]], [['Waltham']], { message: true }) === 'Which application did you mean? → Waltham');

  // ---- kept with the reply
  let asks = A.merge(undefined, { type: 'ask', askId: 'ask-1', questions: qs });
  asks = A.merge(asks, { type: 'ask_done', askId: 'ask-1', answers: [['May 2029'], ['Waltham']] });
  asks = A.merge(asks, { type: 'ask', askId: 'ask-1', questions: qs }); // (no double)
  check('merge: a card, then its answers; the same id once', asks.length === 1 && J(asks[0].answers) === '[["May 2029"],["Waltham"]]', J(asks));
  const meta = branches.cleanMeta({ id: 'abc', asks: [...asks, { id: 'bad', questions: [{ question: 'Q', options: ['one'] }] }, { id: 'open', questions: [WHICH] }] });
  check('saved: a valid answered card and an open one are kept, a broken one is left out', meta.asks?.length === 2 && J(meta.asks[0].answers) === '[["May 2029"],["Waltham"]]' && meta.asks[0].questions[1].multi === true && !meta.asks[1].answers, J(meta?.asks));
  check('saved: answers that do not fit the card are dropped', !branches.cleanMeta({ asks: [{ id: 'x', questions: [WHICH], answers: [['Northport', 'Waltham']] }] }).asks[0].answers);
  check('saved chat items carry the cards (transcript meta -> history item)', /if \(meta\.asks\) out\.asks = meta\.asks;/.test(src('src/ai/agent.js')) && /asks: info\.asks/.test(src('src/ai/agent.js')));

  // ---- offered where someone can answer
  const req = agentLib.requestFor({ model: 'claude-opus-5-5' }, [{ role: 'user', content: 'hi' }], undefined, { ask: true });
  check('API request: ask_user is in the tools when offered', req.tools.some((t) => t.name === 'ask_user'));
  check('API request: not without it', !agentLib.requestFor({ model: 'claude-opus-5-5' }, [{ role: 'user', content: 'hi' }]).tools.some((t) => t.name === 'ask_user'));
  check('plan mode: asking only reads, so it is allowed while planning', planMode.planToolError('ask_user') === null);
  const browser = { activeTab: () => null, tabById: () => null, listTabs: () => [] };
  const agent = new agentLib.Agent(browser, () => null, () => ({ model: 'claude-opus-5-5' }));
  check('offered to the sidebar agent', agent.askOffered() === true);
  check('not offered to a background task (nobody watches it)', new agentLib.Agent({ ...browser, background: true }, () => null, () => ({})).askOffered() === false);
  check('CLI engines: ask_user is an extra of every sidebar run (Claude Code, Codex, Grok Build, Antigravity)', agent.cliAskToolDefs().map((t) => t.name).join() === 'ask_user' && /askTools: \(\) => agent\.cliAskToolDefs\(\)/.test(src('src/main.js')));
  const aiAgents = src('src/features/ai-agents.js');
  check('CLI engines: runTools and toolsMissing both list it', (aiAgents.match(/deps\.askTools\?\.\(chat\)/g) || []).length === 2);
  check('the call goes through execute', /case 'ask_user': return this\.askUserTool\(input\);/.test(src('src/ai/agent.js')));

  // ---- the run waits on the card, then goes on with the pick
  const runAsk = (input, { answer, abort, waitMs } = {}) => {
    const ctrl = new AbortController();
    const events = [];
    if (waitMs) agent.askWaitMs = waitMs; else delete agent.askWaitMs;
    return agent.inTask(1, ctrl.signal, async () => {
      await agent.ensureAllowed('ask_user', (e) => events.push(e), ctrl.signal, { input, hosts: new Set() });
      const p = agent.askUserTool(input);
      p.catch(() => {}); // (read below; a bad input rejects before the wait)
      await sleep(10);
      const card = events.find((e) => e.type === 'ask');
      if (answer) events.answered = agent.answerAsk(card?.askId, answer);
      if (abort) ctrl.abort();
      let value = null;
      let error = null;
      try { value = await p; } catch (e) { error = e; }
      return { value, error, events, card };
    }, [], null, { hosts: new Set() });
  };
  const r1 = await runAsk({ questions: [GRAD, WHICH] }, { answer: [['May 2029'], ['Waltham']] });
  check('a card event goes to the chat with the checked questions', r1.card && /^ask-/.test(r1.card.askId) && r1.card.questions.length === 2, J(r1.events));
  check('the pick is taken and the tool result carries it', r1.events.answered === true && /→ May 2029/.test(r1.value) && /→ Waltham/.test(r1.value), r1.value || r1.error);
  check('ask_done with the answers follows (the card shows them; main keeps them with the reply)', r1.events.some((e) => e.type === 'ask_done' && e.askId === r1.card.askId && J(e.answers) === '[["May 2029"],["Waltham"]]'));
  check('a second answer to the same card is not taken', agent.answerAsk(r1.card.askId, [['May 2029'], ['Waltham']]) === false);
  const r2 = await runAsk({ questions: [WHICH] }, { answer: [['Somewhere else']] });
  check('an Other text is a fine answer', /→ Somewhere else/.test(r2.value), r2.value);
  const r3 = await runAsk({ questions: [WHICH] }, { answer: [['Northport', 'Waltham']], abort: true }); // (then stopped: the card would wait out its time)
  check('a pick that does not fit is refused and the card keeps waiting', r3.events.answered === false);
  const r4 = await runAsk({ questions: [WHICH] }, { abort: true });
  check('Stop ends the wait (the card stays, its pick becomes the next message)', Boolean(r4.error) && r4.events.some((e) => e.type === 'ask_done' && e.stopped === true), J(r4.events));
  const r5 = await runAsk({ questions: [WHICH] }, { waitMs: 60 });
  check('no answer in time: the model is told to stop and wait for the next message', /has not answered yet/.test(r5.value) && r5.events.some((e) => e.type === 'ask_done' && e.waiting === true), r5.value);
  check('the wait is under Codex\'s 600 s MCP tool timeout', A.WAIT_MS < 600000);
  const bad = await runAsk({ questions: [{ question: 'Q?', options: ['one'] }] });
  check('a bad input is an error for the model, and no card is shown', /at least 2/.test(bad.error?.message || '') && !bad.card);
  check('outside a run with a chat (no gate) it says so', await agent.askUserTool({ questions: [WHICH] }).then(() => false, (e) => /Nobody can answer/.test(e.message)));

  // ---- main and the renderer
  const main = src('src/main.js');
  check('main: agent:ask-answer hands the picks to the agent and is a UI channel', /ipcMain\.handle\('agent:ask-answer'.*agent\.answerAsk\(/.test(main) && /'agent:approve', 'agent:ask-answer'/.test(main) && /'agent:approve', 'agent:ask-answer'/.test(src('src/features/chat-page.js')));
  check('main: the reply keeps its cards (trackRunDetails, saved with the run)', /d\.asks = require\('\.\/ai\/ask-user'\)\.merge\(d\.asks, msg\)/.test(main) && /asks: d\.asks\?\.length \? d\.asks : undefined/.test(main));
  check('preload: askAnswer invokes it', /askAnswer: \(askId, answers\) => ipcRenderer\.invoke\('agent:ask-answer'/.test(src('src/preload/preload.js')));
  const core = src('src/renderer/chat-core.js');
  check('chat-core: the card and its rules load with the first card, not with the window', /script\('\.\.\/ai\/ask-user\.js'\)/.test(core) && /script\('ask-card\.js'\)/.test(core) && !/ask-card\.js|ask-user\.js/.test(src('src/renderer/index.src.html')) && !/ask-card\.js/.test(src('src/renderer/chat-page.html')));
  check('chat-core: a reopened chat draws its cards (answered, or open on the last reply)', /item\.asks/.test(core) && /live: raw === historyLast \|\| item === historyLast/.test(core));

  // ---- the card (a small DOM stub)
  const doc = makeDom();
  const sent = [];
  const asked = [];
  let taken = true;
  const win = { askUser: A, assistant: { askAnswer: async (id, answers) => { asked.push({ id, answers }); return taken; } }, ask: (t) => sent.push(t), t: (k) => k };
  const sandbox = { window: win, document: doc, isImeEnter: (e) => Boolean(e.isComposing), console };
  vm.createContext(sandbox);
  vm.runInContext(src('src/renderer/ask-card.js'), sandbox);
  const C = win.askCard;
  check('renderer: window.askCard.card', typeof C?.card === 'function');

  const one = C.card({ askId: 'ask-9', questions: [{ question: WHICH.question, options: [{ label: 'Northport' }, { label: 'Waltham' }] }] });
  const chips = one.querySelectorAll('.ask-opt[data-label]');
  check('card: a group named for screen readers, a fieldset with its question as legend', one.getAttribute('role') === 'group' && Boolean(one.getAttribute('aria-label')) && one.querySelectorAll('fieldset').length === 1 && one.querySelector('legend').textContent.includes('Which application'));
  check('card: one chip per option plus Other…, all buttons with aria-pressed', chips.length === 2 && one.querySelector('.ask-other-btn') && chips.every((b) => b.tagName === 'BUTTON' && b.getAttribute('aria-pressed') === 'false'));
  check('card: one question, one pick: no Send button shown (the click sends)', one.querySelector('.ask-actions').hidden === true);
  chips[1].click();
  await sleep(0);
  check('click: the pick goes to the waiting run', asked.length === 1 && asked[0].id === 'ask-9' && J(asked[0].answers) === '[["Waltham"]]', J(asked));
  check('click: the card shows what was picked and takes no more clicks', one.classList.contains('answered') && chips[1].getAttribute('aria-pressed') === 'true' && chips.every((b) => b.disabled) && /Waltham/.test(one.querySelector('.ask-status').textContent) && one.querySelector('.ask-status').getAttribute('role') === 'status');
  chips[0].click();
  await sleep(0);
  check('click: a second click does nothing', asked.length === 1);

  const two = C.card({ askId: 'ask-10', questions: [GRAD, { ...WHICH, multi_select: true }] });
  const send = two.querySelector('.ask-send');
  check('card: two questions show Send, off until each has an answer', two.querySelector('.ask-actions').hidden === false && send.disabled === true);
  const [g, w] = two.querySelectorAll('fieldset');
  g.querySelectorAll('.ask-opt[data-label]')[0].click();
  check('card: half answered, Send still off', send.disabled === true);
  w.querySelectorAll('.ask-opt[data-label]')[0].click();
  w.querySelectorAll('.ask-opt[data-label]')[1].click();
  check('card: a multi question takes several picks', w.querySelectorAll('.ask-opt[data-label]').every((b) => b.getAttribute('aria-pressed') === 'true') && send.disabled === false);
  g.querySelectorAll('.ask-opt[data-label]')[1].click();
  check('card: a single question keeps one pick (the new one)', g.querySelectorAll('.ask-opt[data-label]').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.label).join() === 'December 2029');
  taken = false; // (the run stopped waiting)
  send.click();
  await sleep(0);
  check('Send: the run is no longer waiting, so the picks go as the next message', sent.length === 1 && sent[0] === '1. What month in 2029 do you expect to graduate? → December 2029\n2. Which application did you mean? → Northport, Waltham', J(sent));

  const other = C.card({ askId: 'ask-11', questions: [GRAD] });
  taken = true;
  const ob = other.querySelector('.ask-other-btn');
  ob.click();
  const input = other.querySelector('input');
  check('Other…: opens a labelled text box', other.querySelector('.ask-other').hidden === false && ob.getAttribute('aria-expanded') === 'true' && Boolean(input.getAttribute('aria-label')));
  input.value = 'June 2029';
  input.dispatch('keydown', { key: 'Enter', isComposing: true });
  await sleep(0);
  check('Other…: the Enter that picks an IME text does not send', !other.classList.contains('answered'));
  input.dispatch('keydown', { key: 'Enter' });
  await sleep(0);
  check('Other…: Enter sends the typed answer', asked.at(-1)?.id === 'ask-11' && J(asked.at(-1).answers) === '[["June 2029"]]' && /Other: June 2029|ask\.card\.otherPicked/.test(ob.textContent), J(asked.at(-1)));

  const keys = C.card({ askId: 'ask-12', questions: [GRAD] });
  const kc = keys.querySelectorAll('.ask-opt');
  doc.activeElement = kc[0];
  keys.querySelector('.ask-options').dispatch('keydown', { key: 'ArrowRight' });
  check('keyboard: arrow keys move between a question\'s chips', doc.activeElement === kc[1]);
  keys.querySelector('.ask-options').dispatch('keydown', { key: 'End' });
  check('keyboard: End goes to the last chip (Other…)', doc.activeElement === kc[kc.length - 1]);

  const saved = C.card({ askId: '', questions: [WHICH], answers: [['Waltham']] });
  check('reopened chat: an answered card is drawn answered', saved.classList.contains('answered') && saved.querySelectorAll('.ask-opt[data-label]')[1].getAttribute('aria-pressed') === 'true' && saved.querySelectorAll('button').every((b) => b.disabled));
  const old = C.card({ askId: '', questions: [WHICH], live: false });
  check('reopened chat: an unanswered card above later messages is shown, not clickable', old.dataset.state === 'unanswered' && old.querySelectorAll('button').every((b) => b.disabled));
  const open = C.card({ askId: '', questions: [WHICH], live: true });
  const before = sent.length;
  open.querySelectorAll('.ask-opt[data-label]')[0].click();
  await sleep(0);
  check('reopened chat: an open card on the last reply sends its pick as the next message', sent.length === before + 1 && sent.at(-1) === 'Which application did you mean? → Northport');
  const live = C.card({ askId: 'ask-13', questions: [WHICH] });
  live.answer([['Northport']]);
  check('ask_done from main marks a live card answered', live.classList.contains('answered'));
  check('card CSS uses theme tokens and the accent only (no colour literals)', !/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(src('src/renderer/ask-card.css')) && /var\(--accent\)/.test(src('src/renderer/ask-card.css')));

  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

// A DOM just big enough for ask-card.js: elements with classes, attributes, dataset, children, click/keydown, and simple selectors
// (.class, tag, [attr], :not(:disabled), and comma lists; descendants by a space).
function makeDom() {
  const doc = { activeElement: null };
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.dataset = {}; this.listeners = {}; this._text = ''; this.hidden = false; this.disabled = false; this.className = ''; this.value = ''; }
    get classList() { const self = this; const list = () => self.className.split(/\s+/).filter(Boolean); return { add: (...c) => { self.className = [...new Set([...list(), ...c])].join(' '); }, remove: (...c) => { self.className = list().filter((x) => !c.includes(x)).join(' '); }, contains: (c) => list().includes(c), toggle: (c, on) => { if (on ?? !list().includes(c)) self.classList.add(c); else self.classList.remove(c); } }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? Object.assign(new El('#text'), { _text: k }) : k; n.parent = this; this.children.push(n); } }
    get textContent() { return this.tagName === '#TEXT' ? this._text : this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children = []; this._text = String(v); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatch(type, props = {}) { const e = { type, preventDefault() {}, ...props }; for (const fn of this.listeners[type] || []) fn(e); }
    click() { if (this.disabled) return; if (this.onclick) this.onclick({}); this.dispatch('click'); }
    focus() { doc.activeElement = this; }
    all() { return this.children.flatMap((c) => (c.tagName === '#TEXT' ? [] : [c, ...c.all()])); }
    matches(sel) {
      return sel.split(',').map((s) => s.trim()).some((one) => {
        let s = one;
        let ok = true;
        s = s.replace(/:not\(:disabled\)/g, () => { ok = ok && !this.disabled; return ''; });
        s = s.replace(/\[([\w-]+)\]/g, (_m, a) => { ok = ok && (a.startsWith('data-') ? a.slice(5).replace(/-(\w)/g, (_x, c) => c.toUpperCase()) in this.dataset : a in this.attrs); return ''; });
        s = s.replace(/\.([\w-]+)/g, (_m, c) => { ok = ok && this.classList.contains(c); return ''; });
        if (s.trim()) ok = ok && this.tagName === s.trim().toUpperCase();
        return ok;
      });
    }
    querySelectorAll(sel) { return this.all().filter((n) => n.matches(sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  doc.createElement = (tag) => new El(tag);
  return doc;
}
