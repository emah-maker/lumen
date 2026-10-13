// Opening an empty chat (a new tab, "New chat", a tab with no chat of its own) while ANOTHER chat works must not stop that chat's run.
// Agent.reset() used to call stop(), whose "[stop always works]" fallback aborts the only live run when the open conversation is not
// the one running: with a single chat working, a tab switch that landed on an empty chat ended it with "Stopped.". Plain Node.
const { Agent } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const live = () => ({ controller: new AbortController(), promise: null, hosts: new Set(), settling: false });
const agent = () => new Agent({ noTabReason: () => 'x', activeTab: () => null }, () => null, () => ({ model: 'claude-opus-5' }));

{
  // Chat A is open and working; the user opens an empty chat (switchChat detaches a running chat: the run goes on).
  const a = agent();
  const runA = live();
  a.runs.set(a.messages, runA);
  a.detach();
  check('detach leaves the running chat alone', !runA.controller.signal.aborted);
}
{
  // Chat B (open, idle) is replaced by another empty chat while chat A works elsewhere: only B's own run (none) is stopped.
  const a = agent();
  const other = [];
  const runA = live();
  a.runs.set(other, runA);
  a.reset();
  check('reset of an idle open chat does not stop another chat\'s run', !runA.controller.signal.aborted);
  check('... and the open conversation is a fresh empty one', Array.isArray(a.messages) && a.messages.length === 0 && a.messages !== other);
}
{
  // The open chat's own run is still stopped by reset().
  const a = agent();
  const own = live();
  a.runs.set(a.messages, own);
  a.reset();
  check('reset stops the open chat\'s own run', own.controller.signal.aborted);
}
{
  // Stop (the button) still ends the only live run when the open conversation was swapped under it.
  const a = agent();
  const runA = live();
  a.runs.set([], runA);
  a.stop();
  check('stop() still ends the only live run when the open conversation was swapped', runA.controller.signal.aborted);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
