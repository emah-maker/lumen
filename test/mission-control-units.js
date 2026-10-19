// lumen://tasks' pure part (features/mission-control.js), no Electron: what goes in each section (needs you, running now,
// scheduled, recent), the order of each, the cap on Recent, which cards can be answered in place, and the page's requests
// checked before main.js acts on them.
const M = require('../src/features/mission-control');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const NOW = 1_800_000_000_000;
const MIN = 60000;

const task = (o) => ({ id: 't', title: 'Task', status: 'done', pending: [], schedule: { type: 'now' }, enabled: true, nextRun: null, runningSince: null, waitingSince: 0, currentStep: '', cost: '', routine: null, runs: [], ...o });

// ---- empty
const empty = M.aggregate({ now: NOW });
check('nothing in: four empty sections', ['needsYou', 'running', 'scheduled', 'recent'].every((k) => Array.isArray(empty[k]) && empty[k].length === 0) && empty.counts.needsYou === 0, JSON.stringify(empty));

// ---- needs you: every kind, oldest first, with the answers the card offers
const s1 = M.aggregate({
  now: NOW,
  chats: [{ chatId: 'c1', title: 'Find flights', running: true, startedAt: NOW - 5 * MIN, step: 'Reading kayak.com', approvals: [{ approvalId: 7, host: 'kayak.com', action: undefined }, { approvalId: 8, host: 'x.com', action: 'upload-pick' }] }],
  tasks: [task({ id: 't1', title: 'Check prices', status: 'waiting-approval', runningSince: NOW - 20 * MIN, waitingSince: NOW - 10 * MIN, pending: [{ approvalId: 1, host: 'shop.com', action: 'interact', title: 'The AI wants to buy' }], routine: { startUrl: '' } }),
    task({ id: 't2', title: 'Tool task', status: 'waiting-approval', runningSince: NOW - 3 * MIN, waitingSince: NOW - 2 * MIN, pending: [{ approvalId: 1, host: 'srv', action: 'tool' }] })],
  agents: [{ id: '42', clientName: 'Claude Code', since: NOW - 30 * MIN, canStop: true }],
  agentCards: [{ approvalId: 99, agentId: '42', clientName: 'Claude Code', host: 'github.com', action: 'interact', since: NOW - 40 * MIN }],
});
const needs = s1.needsYou;
check('every waiting card is listed: two chat, two task, one agent', needs.length === 5 && needs.filter((n) => n.kind === 'chat').length === 2 && needs.filter((n) => n.kind === 'task').length === 2 && needs.filter((n) => n.kind === 'agent').length === 1, JSON.stringify(needs));
check('oldest first: the agent card (40 min), the routine (10 min), the chat (5 min), the tool task (2 min)', needs[0].kind === 'agent' && needs[1].id === 't1' && needs[2].kind === 'chat' && needs[needs.length - 1].id === 't2', needs.map((n) => `${n.kind}:${n.id}`).join(','));
const chatCard = needs.find((n) => n.approvalId === 7);
check('a plain chat card (no action: interact) is answered with Allow / Deny', JSON.stringify(chatCard.choices) === '["allow","deny"]' && chatCard.action === 'interact' && chatCard.who === 'Find flights', JSON.stringify(chatCard));
check('a card that needs its own (choose a file) offers no answer here', needs.find((n) => n.approvalId === 8).choices.length === 0);
check('a task card on a site offers once / for this task / deny', JSON.stringify(needs.find((n) => n.id === 't1').choices) === '["once","site","deny"]');
check('a task card for a tool offers once / deny (no site to keep)', JSON.stringify(needs.find((n) => n.id === 't2').choices) === '["once","deny"]');
check('the routine card says it is a routine', needs.find((n) => n.id === 't1').routine === true);
check('the agent card names its client and window', needs[0].who === 'Claude Code' && needs[0].id === '42');

// ---- running now: status first, then newest; elapsed and step
const run = s1.running;
check('running lists the chat, both tasks and the agent', run.length === 4, JSON.stringify(run));
check('all four wait for an OK, newest first', run.every((r) => r.status === 'waiting-approval') && run.map((r) => r.id).join(',') === 't2,c1,t1,42', run.map((r) => `${r.id}:${r.status}`).join(','));
check('a chat with a card waiting shows as waiting', run.find((r) => r.kind === 'chat').status === 'waiting-approval');
check('the agent with a card waiting shows as waiting, with its client', run.find((r) => r.kind === 'agent').status === 'waiting-approval' && run.find((r) => r.kind === 'agent').client === 'Claude Code');
const chatRun = run.find((r) => r.kind === 'chat');
check('a chat carries its step and elapsed time', chatRun.step === 'Reading kayak.com' && chatRun.elapsedMs === 5 * MIN && chatRun.canStop === true, JSON.stringify(chatRun));
const s2 = M.aggregate({ now: NOW, chats: [{ chatId: 'a', title: 'Old', running: true, startedAt: NOW - 9 * MIN }, { chatId: 'b', title: 'New', running: true, startedAt: NOW - MIN }, { chatId: 'q', title: 'Waiting turn', queued: true }],
  tasks: [task({ id: 'r', title: 'Busy', status: 'running', runningSince: NOW - 2 * MIN, currentStep: 'Clicking Buy', cost: '1.2k tokens · ~$0.01' }), task({ id: 'qq', status: 'queued' }), task({ id: 'd', status: 'done' })] });
check('same status: newest first; queued last', s2.running.map((r) => r.id).join(',') === 'b,r,a,q,qq', s2.running.map((r) => r.id).join(','));
const busy = s2.running.find((r) => r.id === 'r');
check('a task carries its current step and cost', busy.step === 'Clicking Buy' && busy.cost === '1.2k tokens · ~$0.01' && busy.elapsedMs === 2 * MIN, JSON.stringify(busy));
check('a finished task is not running', !s2.running.some((r) => r.id === 'd'));
check('a queued task has no elapsed time', s2.running.find((r) => r.id === 'qq').elapsedMs === 0);

// ---- scheduled: routines and repeating tasks, on and soonest first, off last
const s3 = M.aggregate({ now: NOW, tasks: [
  task({ id: 'later', title: 'B', routine: {}, schedule: { type: 'routine' }, nextRun: NOW + 60 * MIN }),
  task({ id: 'soon', title: 'A', routine: {}, schedule: { type: 'routine' }, nextRun: NOW + 5 * MIN }),
  task({ id: 'off', title: 'C', routine: {}, schedule: { type: 'routine' }, enabled: false, nextRun: NOW + MIN }),
  task({ id: 'every', title: 'D', schedule: { type: 'every', minutes: 30 }, nextRun: NOW + 30 * MIN }),
  task({ id: 'at', title: 'E', schedule: { type: 'at', at: NOW + 2 * MIN }, nextRun: NOW + 2 * MIN }),
  task({ id: 'once', title: 'F' }),
] });
check('scheduled: soonest first, off last, a one-off task not listed', s3.scheduled.map((x) => x.id).join(',') === 'at,soon,every,later,off', s3.scheduled.map((x) => x.id).join(','));
check('an off routine shows no next run', s3.scheduled.find((x) => x.id === 'off').nextRun === null && s3.scheduled.find((x) => x.id === 'off').enabled === false);
check('a one-time "at" task cannot be turned off here (the Tasks panel deletes it)', s3.scheduled.find((x) => x.id === 'at').canToggle === false && s3.scheduled.find((x) => x.id === 'soon').canToggle === true);

// ---- recent: task runs and finished chats, newest first, capped, a watch's checks left out
const runs = Array.from({ length: 40 }, (_, i) => ({ startedAt: NOW - (100 - i) * MIN - MIN, endedAt: NOW - (100 - i) * MIN, status: i % 2 ? 'done' : 'failed', summary: `run ${i}`, cost: 0.01, kind: 'run' }));
runs.push({ startedAt: NOW - 2 * MIN, endedAt: NOW - MIN, status: 'done', summary: 'checked', kind: 'watch' });
let done = [];
for (let i = 0; i < 30; i++) done = M.noteFinished(done, { chatId: `c${i}`, title: `Chat ${i}`, startedAt: NOW - (60 - i) * MIN - 30000, endedAt: NOW - (60 - i) * MIN, status: 'done', preview: 'x'.repeat(400) });
const s4 = M.aggregate({ now: NOW, tasks: [task({ id: 'h', title: 'History', runs })], chatsDone: done });
check(`recent is capped at ${M.RECENT_MAX}`, s4.recent.length === M.RECENT_MAX, s4.recent.length);
check('recent is newest first', s4.recent.every((r, i, a) => i === 0 || a[i - 1].endedAt >= r.endedAt));
check('a watched page\'s checks are not runs', !s4.recent.some((r) => r.preview === 'checked'));
check('the newest are the chats (they ended last), with duration and a clipped preview', s4.recent[0].kind === 'chat' && s4.recent[0].id === 'c29' && s4.recent[0].durationMs === 30000 && s4.recent[0].preview.length <= 160 && s4.recent[0].preview.endsWith('…'), JSON.stringify(s4.recent[0]));
check('a task run keeps its status, cost and summary', s4.recent.some((r) => r.kind === 'task' && r.status === 'failed' && r.cost === 0.01 && /^run \d+$/.test(r.preview)));
let many = [];
for (let i = 0; i < 80; i++) many = M.noteFinished(many, { chatId: `c${i}`, endedAt: i + 1 });
check('the finished-chat list keeps the newest 50', many.length === 50 && many[0].chatId === 'c79' && many[49].chatId === 'c30');

// ---- where tasks came from: Telegram, a routine's web link or new email
const s5 = M.aggregate({ now: NOW, tasks: [
  task({ id: 'tg', title: 'From the phone', via: 'telegram', status: 'waiting-approval', runningSince: NOW - MIN, pending: [{ approvalId: 3, host: 'a.com', action: 'open' }] }),
  task({ id: 'hook', title: 'Hooked', routine: {}, schedule: { type: 'routine', repeat: 'webhook' }, status: 'running', runningSince: NOW - MIN, trigger: 'webhook',
    runs: [{ startedAt: NOW - 9 * MIN, endedAt: NOW - 8 * MIN, status: 'done', summary: 'ok', kind: 'run' }, { startedAt: NOW - 30 * MIN, endedAt: NOW - 29 * MIN, status: 'done', summary: 'clock', kind: 'run' }],
    history: [{ startedAt: NOW - 9 * MIN, trigger: 'email' }, { startedAt: NOW - 30 * MIN, trigger: 'schedule' }] }),
  task({ id: 'mail', title: 'Mail', routine: {}, schedule: { type: 'routine', repeat: 'email', minutes: 10 } }),
] });
check('a Telegram task and its card say where they came from', s5.needsYou[0].via === 'telegram' && s5.running.find((r) => r.id === 'tg').via === 'telegram');
check('a routine started by its web link says so while it runs', s5.running.find((r) => r.id === 'hook').trigger === 'webhook');
check('Recent names the trigger of each run, and none for the clock', s5.recent.find((r) => r.preview === 'ok').trigger === 'email' && s5.recent.find((r) => r.preview === 'clock').trigger === null);
check('Scheduled says a routine runs on its web link or on new email', s5.scheduled.find((x) => x.id === 'hook').on === 'webhook' && s5.scheduled.find((x) => x.id === 'mail').on === 'email', JSON.stringify(s5.scheduled));
check('an event routine has no clock time to show', s5.scheduled.find((x) => x.id === 'mail').nextRun === null);

// ---- a card's details: shown whole, else Go to only
const longArgs = `line one\n  indented two\n${'x'.repeat(1490)}`;
const s6 = M.aggregate({ now: NOW, chats: [{ chatId: 'c', title: 'Mail', running: true, startedAt: NOW, approvals: [
  { approvalId: 1, host: 'srv', action: 'tool', title: 'Send it', args: 'to: a@b.c\n\nbody:\n  hello', tainted: true },
  { approvalId: 2, host: 'srv', action: 'tool', title: 'Long', args: `${longArgs}MORE` },
  { approvalId: 3, host: 'gmail', action: 'tool', title: 'Claude wants to: send an email', args: 'to: x', tainted: false, noAlways: true, note: 'connector' },
  { approvalId: 4, host: 'memory', action: 'tool', title: 'Remember this?', args: 'likes tea', tainted: true, noAlways: true, noBypass: true },
] }] });
const card = (id) => s6.needsYou.find((n) => n.approvalId === id);
check('the details are shown whole, line breaks and indentation kept', card(1).detail === 'to: a@b.c\n\nbody:\n  hello' && card(1).cut === false, JSON.stringify(card(1).detail));
check('a card whose run read page content says so', card(1).tainted === true && card(4).tainted === true && card(3).tainted === false);
check('a plain card shown whole can be answered here', JSON.stringify(card(1).choices) === '["allow","deny"]');
check(`details up to ${M.ARGS_MAX} characters are kept; longer ones are cut and get Go to only`, card(2).detail.length === M.ARGS_MAX && card(2).cut === true && card(2).choices.length === 0, `${card(2).detail.length} ${card(2).choices}`);
check('a connector write (note) gets Go to only', card(3).choices.length === 0 && card(3).guarded === true);
check('a memory note (noBypass) gets Go to only', card(4).choices.length === 0 && card(4).guarded === true);
check('a task card already cut by the Tasks panel (argsCut) gets Go to only', M.choicesFor('task', M.cardText({ action: 'tool', args: 'x', argsCut: true })).length === 0);
check('a query card shows its query', M.cardText({ action: 'open', query: 'cheap flights' }).detail === 'cheap flights');

// ---- temporary chats: named as one, without their words; their cards get Go to only
const s7 = M.aggregate({ now: NOW, chats: [{ chatId: 'tmp', temporary: true, title: 'secret plans', step: 'Reading secret.com', running: true, startedAt: NOW - MIN, approvals: [{ approvalId: 9, host: 'secret.com', action: 'interact', title: 'Interact with secret.com?', args: 'private words' }] }] });
const tmpRun = s7.running[0];
const tmpCard = s7.needsYou[0];
check('a temporary chat runs with no title or step', tmpRun.temporary === true && tmpRun.title === '' && tmpRun.step === '', JSON.stringify(tmpRun));
check('its card has no host, title or details, and no answers', tmpCard.temporary === true && tmpCard.who === '' && tmpCard.host === '' && tmpCard.title === '' && tmpCard.detail === '' && tmpCard.choices.length === 0, JSON.stringify(tmpCard));
check('nothing of its words is anywhere in the page data', !/secret|private/.test(JSON.stringify(s7)));
check('choicesFor refuses any answer for a temporary chat', M.choicesFor('chat', M.cardText({ action: 'interact', host: 'a.com' }), { temporary: true }).length === 0);

// ---- task cards go through the same gate: only plain ones are answered here
for (const action of ['upload-pick', 'upload', 'app', 'content-loss', 'file']) {
  check(`a task's ${action} card gets Go to only`, M.choicesFor('task', M.cardText({ action, host: 'a.com' })).length === 0);
}
const s8 = M.aggregate({ now: NOW, tasks: [task({ id: 'u', status: 'waiting-approval', runningSince: NOW, pending: [{ approvalId: 5, host: 'a.com', action: 'upload-pick' }, { approvalId: 6, host: 'a.com', action: 'tool', args: 'x', note: 'connector' }] })] });
check('in the page data too: a task\'s upload-pick and connector cards have no answers', s8.needsYou.every((n) => n.choices.length === 0), JSON.stringify(s8.needsYou.map((n) => n.choices)));

// ---- the page's requests
const ok = (r) => M.cleanRequest(r);
check('answer a chat card', JSON.stringify(ok({ op: 'answer', kind: 'chat', id: 'c1', approvalId: 7, choice: 'allow' })) === '{"op":"answer","kind":"chat","id":"c1","approvalId":7,"choice":"allow"}');
check('answer an agent card (no id needed)', ok({ op: 'answer', kind: 'agent', approvalId: 99, choice: 'deny' })?.approvalId === 99);
check('a task answer must be once / site / deny', ok({ op: 'answer', kind: 'task', id: 't', approvalId: 1, choice: 'allow' }) === null && ok({ op: 'answer', kind: 'task', id: 't', approvalId: 1, choice: 'site' })?.choice === 'site');
check('a chat answer cannot be "always" (no new powers)', ok({ op: 'answer', kind: 'chat', id: 'c', approvalId: 1, choice: 'always' }) === null);
check('unknown ops and kinds are refused', ok({ op: 'delete', kind: 'task', id: 't' }) === null && ok({ op: 'stop', kind: 'window', id: '1' }) === null && ok(null) === null && ok('stop') === null);
check('a bad approval id is refused', ok({ op: 'answer', kind: 'chat', id: 'c', approvalId: 'x', choice: 'allow' }) === null);
check('toggle is for tasks only and carries on as a boolean', ok({ op: 'toggle', kind: 'task', id: 't', on: 'yes' })?.on === false && ok({ op: 'toggle', kind: 'chat', id: 'c', on: true }) === null);
check('stop and go to need an id', ok({ op: 'stop', kind: 'chat' }) === null && ok({ op: 'goto', kind: 'agent', id: 3 })?.id === '3');

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
