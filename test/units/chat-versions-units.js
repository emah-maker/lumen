// Message details and versions of a chat (plain Node): a chat saved by an older Lumen opens exactly as before and is saved
// back without any new field; regenerate and edit keep the earlier answers as versions, the chosen one is the chat that
// goes on, and everything survives a save and a load. Every folder is a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent, transcriptFor } = require('../../src/ai/agent');
const { createChatStore } = require('../../src/features/chat-store');
const branches = require('../../src/features/chat-branches');
const compactLib = require('../../src/features/chat-compact');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = (v) => JSON.stringify(v);

const fakeBrowser = () => ({ activeTab: () => null, tabById: () => null, listTabs: () => [], effectiveModel: (x) => x, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0, autoModel: () => false });
const newAgent = () => new Agent(fakeBrowser(), () => null, () => ({ model: 'claude-opus-5', pageContext: false }));
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const reply = (text, author = 'claude-opus-5') => ({ role: 'assistant', content: [{ type: 'text', text }], author });
const texts = (agent) => agent.messages.map((m) => m.content[0].text);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-versions-'));
const enc = (t) => Buffer.from(t).toString('base64');
const dec = (b) => Buffer.from(b, 'base64').toString();
const store = createChatStore({ dir: path.join(root, 'chats'), encrypt: enc, decrypt: dec });
const ID = 'a'.repeat(16);

// ---- a chat saved before this existed
{
  const old = {
    settings: { model: 'claude-opus-5', usage: { input: 5 } },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }], author: null },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'navigate', input: { url: 'https://a.test' } }], author: 'claude-opus-5' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '(result not saved between sessions)' }], author: null },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }], author: 'claude-opus-5' },
      { role: 'user', content: [{ type: 'text', text: 'second' }], author: null },
      { role: 'assistant', content: [{ type: 'text', text: 'again' }], author: null },
    ],
  };
  check('old chat: saves', store.save(ID, old) === true);
  const loaded = store.load(ID);
  check('old chat: loads unchanged from the store', J(loaded) === J(old));
  const agent = newAgent();
  agent.restore(loaded);
  check('old chat: every message is there', agent.messages.length === 6, agent.messages.length);
  const items = agent.transcript();
  check('old chat: shows its turns', J(items.map((i) => [i.role, i.text])) === J([['user', 'first'], ['assistant', 'done'], ['user', 'second'], ['assistant', 'again']]), J(items.map((i) => i.text)));
  check('old chat: the step count is kept', items[1].steps === 1, J(items[1]));
  check('old chat: no versions, time or thinking invented', !items.some((i) => i.versions || i.at || i.thinking || i.tools || i.feedback), J(items));
  check('old chat: the model of a reply is known from its author', items[1].model === 'claude-opus-5' && items[3].model === undefined, J(items.map((i) => i.model)));
  const back = agent.snapshot();
  check('old chat: saved back with no new field', J(back) === J(old), J(back).slice(0, 300));
  const dangling = agent.snapshot();
  check('old chat: no forks field', !('forks' in dangling));
}

// ---- unreadable extras never stop a chat from opening
{
  const agent = newAgent();
  const messy = { settings: null, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], meta: 'oops' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }], meta: { at: 'x', thinking: 5, tools: 3, feedback: 'meh' } }], forks: [{ at: 'x' }, { at: 0, cur: 0, tails: [null] }, { at: 0, cur: 1, tails: [{ messages: [] }, null] }, 7] };
  agent.restore(messy);
  check('messy extras: the chat opens', agent.messages.length === 2 && agent.transcript().length === 2);
  check('messy extras: nothing made up from them', !agent.transcript().some((i) => i.at || i.thinking || i.tools || i.feedback));
  check('messy extras: a fork that is whole is kept', agent.messages.forks?.length === 1 && agent.messages.forks[0].at === 0, J(agent.messages.forks));
}

// ---- regenerate keeps the first answer
const chatOf = (...turns) => { const a = newAgent(); a.restore({ settings: { model: 'claude-opus-5' }, messages: turns }); return a; };
{
  const agent = chatOf(user('q1'), reply('a1'), user('q2'), reply('a2 v1'));
  check('regenerate: the last exchange is taken back', agent.rewindUser(1, 'q2').result === 'rewound' && J(texts(agent)) === J(['q1', 'a1']), J(texts(agent)));
  agent.messages.push(user('q2'), reply('a2 v2'));
  let items = agent.transcript();
  check('regenerate: the message shows two versions, the second live', J(items[2].versions) === J({ at: 2, n: 2, cur: 2, same: true }), J(items[2]));
  check('regenerate: earlier turns show none', !items[0].versions);
  check('switch: to the first version', agent.switchVersion(2, 0) === true && J(texts(agent)) === J(['q1', 'a1', 'q2', 'a2 v1']), J(texts(agent)));
  items = agent.transcript();
  check('switch: the view follows', items[2].versions.cur === 1 && items[3].text === 'a2 v1', J(items[2]));
  agent.messages.push(user('q3'), reply('a3'));
  check('switch: the chat goes on from the chosen version', J(texts(agent)) === J(['q1', 'a1', 'q2', 'a2 v1', 'q3', 'a3']));
  check('switch: back to the second version drops the later turns from view', agent.switchVersion(2, 1) && J(texts(agent)) === J(['q1', 'a1', 'q2', 'a2 v2']), J(texts(agent)));
  check('switch: and they are back with the first', agent.switchVersion(2, 0) && J(texts(agent)) === J(['q1', 'a1', 'q2', 'a2 v1', 'q3', 'a3']), J(texts(agent)));
  check('switch: an unknown version or place changes nothing', !agent.switchVersion(2, 5) && !agent.switchVersion(0, 1) && !agent.switchVersion(2, 0));
  // a third roll
  agent.switchVersion(2, 1);
  agent.rewindUser(1, 'q2');
  agent.messages.push(user('q2'), reply('a2 v3'));
  check('regenerate again: three versions', agent.transcript()[2].versions.n === 3 && agent.transcript()[2].versions.cur === 3);
  check('regenerate again: the first is still whole, later turns and all', agent.switchVersion(2, 0) && J(texts(agent)) === J(['q1', 'a1', 'q2', 'a2 v1', 'q3', 'a3']), J(texts(agent)));
}

// ---- edit an earlier message: the old branch is kept (with its own versions inside)
{
  const agent = chatOf(user('q1'), reply('a1'), user('q2'), reply('a2'), user('q3'), reply('a3'));
  agent.rewindUser(2, 'q3');
  agent.messages.push(user('q3'), reply('a3 v2')); // a fork at 4
  const r = agent.rewindUser(1, 'q2'); // edit q2: q3 and its two versions go with the old branch
  check('edit: an earlier message can be taken back', r.result === 'rewound' && J(r.versions) === J({ at: 2, n: 2, cur: 2 }), J(r));
  check('edit: the old branch leaves the live chat', J(texts(agent)) === J(['q1', 'a1']) && !agent.messages.forks.some((f) => f.at === 4), J(agent.messages.forks));
  agent.messages.push(user('q2 edited'), reply('a2 edited'));
  const items = agent.transcript();
  check('edit: the edited message carries the switcher, and it is not a plain regenerate', J(items[2].versions) === J({ at: 2, n: 2, cur: 2, same: false }), J(items[2]));
  check('edit: switching back brings the old branch, nested versions included', agent.switchVersion(2, 0) && J(texts(agent)) === J(['q1', 'a1', 'q2', 'a2', 'q3', 'a3 v2']) && agent.transcript()[4].versions.n === 2, J(texts(agent)));
  check('edit: the nested version still switches', agent.switchVersion(4, 0) && texts(agent).pop() === 'a3');
  check('edit: a wrong text or place changes nothing', agent.rewindUser(1, 'not it').result === 'absent' && agent.rewindUser(9, '').result === 'absent' && agent.messages.length === 6);
}

// ---- versions survive a save and a load
{
  const agent = chatOf(user('q1'), reply('a1'));
  agent.setFeedback(0, 'up');
  agent.rewindUser(0, 'q1');
  agent.messages.push(user('q1'), reply('a1 v2'));
  agent.stampMessages(agent.messages, 0, { at: 1700000000000, thinking: 'hmm', thinkingMs: 1500, tools: [{ label: 'Opened a.test', name: 'navigate', input: { url: 'https://a.test' }, ok: true }], auto: { label: 'Haiku', reason: 'short' } });
  check('save: a chat with versions is saved', store.save(ID, agent.snapshot()) === true);
  const reopened = newAgent();
  reopened.restore(store.load(ID));
  check('load: the live version is the chat', J(texts(reopened)) === J(['q1', 'a1 v2']), J(texts(reopened)));
  const items = reopened.transcript();
  check('load: its details are back (time, thinking, steps, Auto, model)', items[1].at === 1700000000000 && items[1].thinking === 'hmm' && items[1].thinkingMs === 1500 && items[1].tools[0].name === 'navigate' && items[1].auto.label === 'Haiku', J(items[1]));
  check('load: the other version is still there, with its thumb', reopened.switchVersion(0, 0) && reopened.transcript()[1].feedback === 'up', J(reopened.transcript()));
  check('load: and the switch back works', reopened.switchVersion(0, 1) && texts(reopened)[1] === 'a1 v2');
  check('save: the user messages got their time too', items[0].at === 1700000000000 && typeof items[0].id === 'string', J(items[0]));
}

// ---- the thumb
{
  const agent = chatOf(user('q1'), reply('a1'), user('q2'), reply('mid'), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] }, reply('final'));
  check('thumb: set on the reply that closes the exchange', agent.setFeedback(1, 'down') && agent.transcript().find((i) => i.text === 'final').feedback === 'down');
  check('thumb: only that one', !agent.transcript().some((i) => i.text === 'mid' && i.feedback));
  check('thumb: taken back', agent.setFeedback(1, null) && !agent.transcript().some((i) => i.feedback));
  check('thumb: an unknown message is refused', agent.setFeedback(7, 'up') === false);
}

// ---- /compact moves the places along
{
  const agent = chatOf(user('q1'), reply('a1'), user('q2'), reply('a2'), user('q3'), reply('a3'));
  agent.rewindUser(2, 'q3');
  agent.messages.push(user('q3'), reply('a3 v2'));
  agent.rewindUser(0, 'q1'); // fork at 0 (holds the fork at 4 inside its tail)
  agent.messages.push(user('q1'), reply('a1'), user('q2'), reply('a2'), user('q3'), reply('a3 v2'));
  agent.switchVersion(0, 0); // back: forks 0 and 4 live again
  const m = agent.messages;
  m.settings = { model: 'claude-opus-5' };
  compactLib.applySummary(m, 2, 'summary', []);
  check('compact: a version inside the replaced turns goes', !m.forks.some((f) => f.at === 0));
  check('compact: one after them moves up with its message', m.forks.length === 1 && m.forks[0].at === 2 && m[2].content[0].text === 'q3', J(m.forks.map((f) => f.at)));
}

// ---- an empty or summary-carrying first exchange keeps nothing odd
{
  const agent = chatOf(user('only'));
  check('rewind of an unanswered message: nothing to keep but the message', agent.rewindUser(0, 'only').result === 'rewound' && !agent.messages.forks?.length || agent.messages.forks?.length === 1);
  const none = chatOf();
  check('rewind of an empty chat is absent', none.rewindUser(0, '').result === 'absent');
  check('the old rewind of the last exchange still works, and keeps no version', (() => { const a = chatOf(user('q'), reply('a')); return a.rewindLast('q') === 'rewound' && a.messages.length === 0 && !a.messages.forks; })());
}

// ---- helpers
{
  check('meta is bounded', branches.cleanMeta({ thinking: 'x'.repeat(50000), tools: new Array(200).fill({ label: 'l'.repeat(500) }) }).thinking.length === 20000);
  check('meta: only known fields come through', J(branches.cleanMeta({ evil: 1, feedback: 'up' })) === J({ feedback: 'up' }));
  check('meta: nothing at all is null', branches.cleanMeta({ nope: 1 }) === null && branches.cleanMeta('x') === null);
  check('transcriptFor of a plain list still works with no forks', transcriptFor([user('a'), reply('b')]).length === 2);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nAll chat-versions checks passed');
process.exit(failures ? 1 : 0);
