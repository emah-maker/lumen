// [run replay] features/run-replay.js: what a running reply has shown, kept for a chat opened again mid-run.
const { createRunLog, SKIP } = require('../../src/features/run-replay');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

const log = createRunLog();
log.push({ type: 'text', text: 'Reading.' });
log.push({ type: 'tool', id: 't1', name: 'read_page', input: {} });
log.push({ type: 'thumb', data: 'frame-1' });
log.push({ type: 'tool_done', id: 't1', ok: true });
log.push({ type: 'approval', approvalId: 'a1' });
log.push({ type: 'status', text: 'Starting…' });
log.push({ type: 'thumb', data: 'frame-2' });
log.push({ type: 'review', round: 1 });
log.push(null); log.push({ text: 'no type' });
const ev = log.events();
check('events kept in order; approvals, status lines and odd values left out', ev.map((e) => e.type).join() === 'text,tool,tool_done,review,thumb', ev.map((e) => e.type).join());
check('only the newest picture of the tab, last', ev.filter((e) => e.type === 'thumb').length === 1 && ev[ev.length - 1].data === 'frame-2');
check('the ones never replayed include done, reply_complete and the send countdown', ['done', 'reply_complete', 'send_pending', 'approval', 'followup_start'].every((t) => SKIP.has(t)));
log.reset();
check('reset (a new turn of the run): nothing kept', log.events().length === 0 && log.size() === 0);

const small = createRunLog({ maxEvents: 3, maxChars: 10000 });
for (let i = 0; i < 6; i++) small.push({ type: 'tool', id: `t${i}` });
check('a long run keeps its newest events (count)', small.events().map((e) => e.id).join() === 't3,t4,t5', small.events().map((e) => e.id).join());
const sized = createRunLog({ maxEvents: 100, maxChars: 200 });
for (let i = 0; i < 5; i++) sized.push({ type: 'text', text: 'x'.repeat(60), i });
check('a long run keeps its newest events (size)', sized.events().length >= 1 && sized.events().length < 5 && sized.events().at(-1).i === 4, sized.events().length);
sized.push({ type: 'text', text: 'y'.repeat(500) });
check('one event bigger than the whole budget is dropped, not the rest', sized.events().at(-1).i === 4);

console.log(failures ? `\n${failures} failed` : '\nall run-replay checks passed');
process.exit(failures ? 1 : 0);
