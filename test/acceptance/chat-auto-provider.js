// ACCEPTANCE (feature: provider Auto, docs/auto-model.md). Run alone: node scripts/test-acceptance.js chat-auto-provider
//
// A chat on a CLI engine's own Auto ('claudecode:auto', 'grokbuild:auto') with the real Agent, the real engines and the real
// router (ai/auto-model.js, scoped to the engine), and fake CLIs (test/acceptance/chat-harness.js). What each CLI is really
// asked for, and what happens to a warm process when Auto picks another model:
//  - the CLI gets the concrete model as --model (a quick message: the small one; a hard one: a strong one), never "auto";
//  - a second message that Auto sends to the same model goes to the same warm Claude Code process (no new start);
//  - a message Auto sends to a different model never lands on the process that was started for another one: a new process
//    starts with the new --model and the old one ends;
//  - the chat's pick stays the engine's Auto between messages; /think asks for the strongest and /fast for the quickest.
const H = require('./chat-harness');
const A = require('../../src/ai/auto-model');
const { claudeCodeOptions, grokBuildOptions } = require('../../src/features/ai-agents');

const { check, chat, send, until, readLog, lastAssistant, turnText, live } = H;
const J = (v) => JSON.stringify(v);
const as = (chatId) => ({ meta: { chatId } });
const HEAVY = ['Refactor the checkout flow across the codebase and debug why the cart total is wrong after a coupon is applied.', '1. Investigate the root cause in cart.js and pricing.js', '2. Design a fix that handles concurrent updates', '3. Write tests, then migrate the old orders', '4. Also make sure the API docs stay accurate'].join('\n');
const starts = (role) => readLog().filter((e) => e.ev === 'start' && e.role === role);
const ran = (marker) => readLog().find((e) => e.ev === 'msg' && e.marker === marker) || null;

const options = [...claudeCodeOptions({ signedIn: true }), ...grokBuildOptions({ signedIn: true, models: ['grok-4.7', 'grok-4.7-build-fast'] })];
const routed = [];
H.agent.browser.autoRoute = ({ request, last, scope, allowEngines }) => { const d = A.route({ options, request, last, scope, allowEngines }); routed.push({ scope, id: d.id }); return d; };

async function claudeSuite() {
  const M = chat('claudecode:auto');
  const r1 = send(M, 'hi RUN-PA1', 1, as('pa-A'));
  await Promise.race([r1.done, H.sleep(20000)]);
  const s1 = starts('claude');
  check('Claude Code Auto, a quick message: the CLI is started with --model haiku', s1.length === 1 && s1[0].model === 'haiku', J(s1));
  check('the chat is on the engine\'s Auto (the pick), with the concrete model answering', M.settings.autoFrom === 'claudecode:auto' && M.settings.model === 'claudecode:haiku' && M.settings.autoLast?.scope === 'claudecode', J(M.settings));
  check('the reply arrives and a notice names the model and why (naming the provider)', /reply from RUN-PA1/.test(turnText(lastAssistant(M))) && r1.events.some((e) => e.type === 'auto' && e.model === 'claudecode:haiku' && /^Auto \(Claude Code\): Haiku for /.test(e.reason)), J(r1.events.filter((e) => e.type === 'auto')));
  const pid1 = s1[0]?.pid;

  const r2 = send(M, 'hello RUN-PA2', 1, as('pa-A'));
  await Promise.race([r2.done, H.sleep(20000)]);
  check('the next quick message goes to the same warm process (same model: nothing restarted)', starts('claude').length === 1 && ran('RUN-PA2')?.pid === pid1, J({ starts: starts('claude').length, pid: ran('RUN-PA2')?.pid, pid1 }));

  const r3 = send(M, `${HEAVY}\nRUN-PA3`, 1, as('pa-A'));
  await Promise.race([r3.done, H.sleep(20000)]);
  const s3 = starts('claude');
  const p3 = ran('RUN-PA3');
  check('a hard message goes to a stronger model: the same warm process is switched to it (set_model), not replaced', s3.length === 1 && p3?.pid === pid1 && ['opus', 'fable'].includes(p3?.model) && readLog().some((e) => e.ev === 'set_model' && e.pid === pid1 && ['opus', 'fable'].includes(e.model)), J({ s3, p3 }));
  check('the process is still the one kept for the chat', live.has(pid1), J([...live.keys()]));
  check('the chat is still on the engine\'s Auto after the change of model', M.settings.autoFrom === 'claudecode:auto' && /^claudecode:(opus|fable)$/.test(M.settings.model) && /reply from RUN-PA3/.test(turnText(lastAssistant(M))), J(M.settings));

  const N = chat('claudecode:auto');
  const r4 = send(N, '/think hi RUN-PA4', 2, as('pa-B'));
  await Promise.race([r4.done, H.sleep(20000)]);
  const think = starts('claude').find((s) => s.pid === ran('RUN-PA4')?.pid);
  check('/think within the engine\'s Auto: its strongest model (and the command is not sent)', ['opus', 'fable'].includes(think?.model) && !/\/think/.test(ran('RUN-PA4')?.prompt || ''), J({ think, prompt: ran('RUN-PA4')?.prompt }));
  const O = chat('claudecode:auto');
  const r5 = send(O, `/fast ${HEAVY}\nRUN-PA5`, 3, as('pa-C'));
  await Promise.race([r5.done, H.sleep(20000)]);
  const fast = starts('claude').find((s) => s.pid === ran('RUN-PA5')?.pid);
  check('/fast within the engine\'s Auto: its quickest model, even for a hard message', fast?.model === 'haiku', J(fast));
  check('no CLI was ever asked for a model called "auto"', readLog().filter((e) => e.ev === 'start').every((e) => e.model !== 'auto'), J(starts('claude')));
}

async function grokSuite() {
  const M = chat('grokbuild:auto');
  const r1 = send(M, 'hi RUN-PG1', 1, as('pg-A'));
  await Promise.race([r1.done, H.sleep(20000)]);
  const s1 = starts('grok').find((s) => s.pid === ran('RUN-PG1')?.pid);
  check('Grok Build Auto, a quick message: grok is started with --model grok-4.7-build-fast', s1?.model === 'grok-4.7-build-fast', J(starts('grok')));
  check('the chat is on the engine\'s Auto, answered by the concrete model', M.settings.autoFrom === 'grokbuild:auto' && M.settings.model === 'grokbuild:grok-4.7-build-fast' && /reply from RUN-PG1/.test(turnText(lastAssistant(M))), J(M.settings));
  const r2 = send(M, `${HEAVY}\nRUN-PG2`, 1, as('pg-A'));
  await Promise.race([r2.done, H.sleep(20000)]);
  const s2 = starts('grok').find((s) => s.pid === ran('RUN-PG2')?.pid);
  check('a hard message goes to the strong model, in a new session (a Grok session stays on its model)', s2?.model === 'grok-4.7' && s2.session !== s1?.session && !s2.resume && /reply from RUN-PG2/.test(turnText(lastAssistant(M))), J({ s1, s2 }));
  check('the chat stays on the engine\'s Auto', M.settings.autoFrom === 'grokbuild:auto' && M.settings.model === 'grokbuild:grok-4.7', J(M.settings));
  check('every message was routed inside its own engine', routed.every((r) => r.scope === 'claudecode' || r.scope === 'grokbuild') && routed.length >= 7, J(routed));
  check('no CLI was ever asked for a model called "auto"', readLog().filter((e) => e.ev === 'start').every((e) => e.model !== 'auto'), J(starts('grok')));
}

(async () => {
  H.hardStop(110000);
  await claudeSuite();
  await grokSuite();
  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
