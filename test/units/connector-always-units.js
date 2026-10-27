// "Always allow" for connector actions that only add something: which actions are marked, the setting's validation, the pure decision,
// and the agent's gate (an always-allowed add skips its card with a visible step; a tainted chat, a send and any other write still ask).
const registry = require('../../src/features/connectors/registry');
const always = require('../../src/features/connectors/always');
const settingsBackend = require('../../src/settings/settings-backend');
const agentLib = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };

const EXPECTED = [
  'calendar:create_event', 'docs:create', 'drive:create_folder', 'gmail:create_draft', 'gtasks:add_task',
  'mscal:create_event', 'notion:create_page', 'outlook:create_draft', 'sheets:create', 'todoist:add_task',
];

(async () => {
  console.log('--- which actions are marked');
  const keys = always.addsKeys(registry.CONNECTORS).sort();
  const writes = registry.CONNECTORS.flatMap((d) => Object.entries(d.actions || {}).filter(([, a]) => a.write).map(([n, a]) => ({ key: `${d.id}:${n}`, name: n, a })));
  check('the adds are exactly the ten that only make something new', JSON.stringify(keys) === JSON.stringify(EXPECTED), JSON.stringify(keys));
  check('every adds action is a write and none is gated (a send)', writes.filter((w) => w.a.adds).every((w) => w.a.write && !w.a.gated), '');
  check('no send, edit, append, move, copy, trash, share, upload or complete is marked', writes.filter((w) => w.a.adds).every((w) => !/send|update|rename|move|copy|trash|share|upload|append|complete|comment|issue/.test(w.name)), JSON.stringify(keys));
  check('gmail send is gated and not an add', registry.get('gmail').actions.send.gated === true && !registry.get('gmail').actions.send.adds, '');

  console.log('--- the setting');
  const v = (x) => settingsBackend.validate('connectorAlways', x);
  check('a clean list is kept, deduped', JSON.stringify(v(['todoist:add_task', 'todoist:add_task', 'gtasks:add_task'])) === JSON.stringify(['todoist:add_task', 'gtasks:add_task']), JSON.stringify(v(['todoist:add_task', 'todoist:add_task'])));
  check('bad entries are dropped (not a string, wrong shape, uppercase, path-like)', JSON.stringify(v(['x', 5, null, 'A:b', 'a:b:c', '../a:b', 'todoist:add_task'])) === JSON.stringify(['todoist:add_task']), JSON.stringify(v(['x', 5, 'A:b', 'todoist:add_task'])));
  check('a value that is not a list is refused', v('todoist:add_task') === null && v({}) === null, JSON.stringify(v('todoist:add_task')));
  check('the list is bounded', v(Array.from({ length: 500 }, (_, i) => `app${i}:act`)).length <= 200, '');

  console.log('--- the decision');
  const add = registry.get('todoist').actions.add_task;
  const mark = registry.get('github').actions.comment;
  const list = ['todoist:add_task'];
  const d = (extra) => always.alwaysDecision({ app: 'todoist', name: 'add_task', action: add, list, ...extra });
  check('an add offers Always, and skips once listed', d({ list: [] }).offer && !d({ list: [] }).skip && d({}).skip, JSON.stringify(d({})));
  check('a tainted chat neither offers nor skips', !d({ tainted: true }).offer && !d({ tainted: true }).skip, JSON.stringify(d({ tainted: true })));
  check('a send neither offers nor skips', !d({ sending: true }).offer && !d({ sending: true }).skip, '');
  const dm = always.alwaysDecision({ app: 'github', name: 'comment', action: mark, list: ['github:comment'] });
  check('a write that is not an add never offers or skips, even if listed', !dm.offer && !dm.skip, JSON.stringify(dm));

  console.log('--- the agent');
  registry.setConnected(['todoist', 'github']);
  const events = [];
  const saved = [];
  const browser = {
    connectors: {
      hasAny: () => true, isWrite: (i) => registry.get(i.app).actions[i.action].write,
      describeWrite: async () => ({ title: 'Add a task: Milk', detail: 'Task: Milk', fixed: 'Todoist', fields: [{ key: 'content', label: 'Task', value: 'Milk', max: 500 }], names: {} }),
      defs: () => [], call: async () => 'ok',
      alwaysList: () => saved.slice(), addAlways: (k) => { if (!saved.includes(k)) saved.push(k); },
    },
    bypassPermissions: () => false, autoApprove: () => false,
  };
  const agent = new agentLib.Agent(browser, () => null, () => ({}));
  const gate = (extra = {}) => ({ emit: (e) => events.push(e), signal: new AbortController().signal, who: 'Claude', external: false, noAsk: false, run: {}, ...extra });
  const task = (c) => ({ app: 'todoist', action: 'add_task', args: { content: c } });
  const wait = () => new Promise((r) => setTimeout(r, 20));
  const cardOf = () => events.find((e) => e.type === 'approval');

  let p = agent.allowConnector(task('One'), gate()); await wait();
  check('an add shows the card with Always offered and says what it is for', cardOf() && cardOf().noAlways !== true && cardOf().alwaysFor?.action === 'Add a task' && cardOf().alwaysFor.app === 'Todoist' && cardOf().noBypass === true, JSON.stringify(cardOf()));
  agent.resolveApproval(cardOf().approvalId, { edits: { content: 'Milk and eggs' }, always: true });
  await p;
  check('Always with edits stores the key', saved.length === 1 && saved[0] === 'todoist:add_task', JSON.stringify(saved));

  events.length = 0;
  const second = task('Two');
  await agent.allowConnector(second, gate());
  check('the next same add runs with no card and a visible step', !cardOf() && events.some((e) => e.name === 'auto_allowed' && /Add a task/.test(e.label)), JSON.stringify(events));
  check('...and is granted to run', Boolean(await agent.runConnector(second)), '');

  events.length = 0;
  p = agent.allowConnector(task('Three'), gate({ run: { tainted: true } })); await wait();
  check('a chat that read a page still asks, with no Always button', cardOf() && !events.some((e) => e.name === 'auto_allowed') && cardOf().noAlways === true && !cardOf().alwaysFor, JSON.stringify(events));
  agent.resolveApproval(cardOf().approvalId, 'always');
  await p.catch(() => {});
  check('an always answer in a chat that read a page is not stored', saved.length === 1, JSON.stringify(saved));

  events.length = 0;
  p = agent.allowConnector({ app: 'github', action: 'comment', args: { repo: 'ada/notes', number: 7, body: 'x' } }, gate()); await wait();
  check('a write that only changes things has no Always button', cardOf() && cardOf().noAlways === true && !cardOf().alwaysFor, JSON.stringify(cardOf()));
  agent.resolveApproval(cardOf().approvalId, 'always');
  await p;
  check('an always answer to it is not stored', saved.length === 1, JSON.stringify(saved));

  const got = await new Promise((resolve) => { agent.pendingApprovals.set(99, resolve); agent.resolveApproval(99, { edits: { a: 'b' }, always: true }); });
  check('resolveApproval keeps always alongside edits', got.always === true && got.edits.a === 'b', JSON.stringify(got));

  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(1); });
