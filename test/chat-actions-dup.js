// Message actions on the chat page (lumen://chat), hidden window, a fake Claude client (no network, no key). A reply that is still
// thinking or streaming has no Regenerate / Retry buttons; a finished one has exactly one of each, below its text and clear of
// the thinking row; a chat reopened mid-run (its history ends on your message) does not keep the "reply stopped" row that
// holds those buttons; a handoff retry ("Trying another way...") does not double them. Run with LUMEN_TEST_BACKGROUND=1.
// [plan mode] Also: with the Plan chip on, the request offers propose_plan, the plan comes back as a card with Run plan / Edit /
// Keep planning, and Run plan sends the approved plan as a normal message with exactly its sites allowed for the chat.
// LUMEN_ACTIONS_SHOTS=<dir> saves a screenshot of the page at each stage.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-actions-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  const ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  await app.evaluate(() => {
    const fake = global.__fake = { n: 0, gate: null };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      fake.tools = (params?.tools || []).map((t) => t.name); // [plan mode]
      const proposing = fake.proposeNext && fake.tools.includes('propose_plan');
      fake.proposeNext = false;
      const text = proposing ? 'Here is my plan.' : `Reply ${++fake.n}.`;
      const content = proposing ? [{ type: 'text', text }, { type: 'tool_use', id: `toolu_plan${fake.n}`, name: 'propose_plan', input: { title: 'Check out', steps: ['Open the cart', 'Pay'], sites: ['shop.example.com'], risky_steps: [2] } }] : [{ type: 'text', text }];
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: proposing ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 1000, output_tokens: 200 } };
      return {
        async *[Symbol.asyncIterator]() { if (fake.gate) await fake.gate; yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } }; yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => message,
      };
    } } } });
  });
  const inPage = (code) => app.evaluate(async (_e, c) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    if (!t) return 'NO CHAT TAB';
    try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, code);
  // An event as main would send it to the page (the agent's own events; a handoff retry is main's 'retry' + 'tool' pair).
  const emit = async (event) => { const runId = await inPage('runId'); await app.evaluate((_e, ev) => { const t = global.__chatPage.tabs().find((x) => x.chat); global.__chatPage.contents(t.id).send('agent:event', ev); }, { ...event, runId }); };
  const shot = async (name) => {
    if (!process.env.LUMEN_ACTIONS_SHOTS) return;
    const b64 = await app.evaluate(async () => (await global.__chatPage.contents(global.__chatPage.tabs().find((x) => x.chat).id).capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(process.env.LUMEN_ACTIONS_SHOTS, `${name}.png`), Buffer.from(b64, 'base64'));
  };
  const state = () => inPage(`(() => {
    const q = (s) => document.querySelectorAll('#messages ' + s).length;
    const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b - 3 && b.t < a.b; // (3px: the buttons' box reaches into the bubble's padding, never onto the text)
    const actions = [...document.querySelectorAll('#messages .reply-regen, #messages .reply-retry, #messages .reply-copy')];
    const others = [...document.querySelectorAll('#messages .thinking, #messages .working, #messages .step, #messages .msg.user, #messages .msg.assistant p')];
    const overlaps = [];
    for (const a of actions) {
      const ra = box(a);
      if (!ra.r) continue;
      for (const o of others) { if (o.checkVisibility?.() === false) continue; if (!o.contains(a) && hit(ra, box(o))) overlaps.push(a.className + ' x ' + (o.className || o.tagName)); }
      for (const o of actions) { if (o !== a && hit(ra, box(o))) overlaps.push(a.className + ' x ' + o.className); }
    }
    return { regen: q('.reply-regen'), retry: q('.reply-retry'), only: q('.reply-actions-only'), running: document.getElementById('send').classList.contains('stop'), overlaps };
  })()`);

  // ---- a run that is still thinking when the chat page opens (history ends on your message, the run is live)
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await app.evaluate(() => { global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
  await ui.fill('#prompt', 'first question');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => document.getElementById('send').classList.contains('stop')));
  await ui.evaluate(() => document.getElementById('open-chat-page').click());
  await waitFor(async () => /first question/.test(await inPage("document.getElementById('messages')?.textContent || ''")));
  await waitFor(async () => (await state()).running);
  await sleep(600); // (the decorating observer)
  let s = await state();
  await shot('1-thinking');
  check('(a) a reply still thinking has no Regenerate or Retry buttons, and no "stopped" actions row', s.running && s.regen === 0 && s.retry === 0 && s.only === 0, JSON.stringify(s));
  await app.evaluate(() => global.__fake.release());
  await waitFor(async () => /Reply 1\./.test(await inPage("document.getElementById('messages').textContent")) && !(await state()).running);
  await sleep(600);
  s = await state();
  await shot('2-done');
  check('(b) once it finishes there is exactly one Regenerate and one Retry', s.regen === 1 && s.retry === 1 && s.only === 0, JSON.stringify(s));
  check('(d) the actions are clear of the text, the thinking row and each other', s.overlaps.length === 0, JSON.stringify(s.overlaps));
  const row = await inPage(`(() => {
    const r = (sel) => { const e = document.querySelector('#messages ' + sel); const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top), right: Math.round(b.right) }; };
    const retry = document.querySelector('#messages .reply-retry');
    return { copy: r('.reply-copy'), regen: r('.reply-regen'), retry: r('.reply-retry'), label: retry.getAttribute('aria-label'), icon: retry.innerHTML === document.querySelector('#messages .reply-regen').innerHTML };
  })()`);
  check('(e) Retry sits in the row with Regenerate and Copy (Copy, Regenerate, Retry from the right), same size, its own icon and tooltip', row.copy.w === row.retry.w && row.regen.w === row.retry.w && row.copy.h === row.retry.h && row.regen.h === row.retry.h && row.regen.top === row.retry.top && row.copy.top === row.retry.top && row.retry.right < row.regen.right && row.regen.right < row.copy.right && !row.icon && /another model/i.test(row.label), JSON.stringify(row));

  // ---- a handoff retry: main drops the first text and says "Trying another way...", then the second pass answers
  await app.evaluate(() => { global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
  await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'second question'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  await waitFor(async () => (await state()).running);
  await emit({ type: 'thinking', text: 'first pass' });
  await emit({ type: 'text', text: 'I could not do that, you do it.' });
  await emit({ type: 'retry' });
  await emit({ type: 'tool', name: 'retry', label: 'Trying another way...' });
  await emit({ type: 'thinking', text: 'second pass' });
  await sleep(600);
  s = await state();
  await shot('3-retrying');
  check('(a) while a handoff retry is thinking there are no action buttons', s.running && s.regen === 0 && s.retry === 0 && s.only === 0, JSON.stringify(s));
  await emit({ type: 'text', text: 'Done another way.' });
  await emit({ type: 'reply_complete' });
  await emit({ type: 'done' });
  await waitFor(async () => !(await state()).running);
  await sleep(600);
  s = await state();
  await shot('4-retried');
  check('(c) after a handoff retry there is still exactly one Regenerate and one Retry', s.regen === 1 && s.retry === 1 && s.only === 0, JSON.stringify(s));
  check('(d) and they are clear of the text, the thinking row and each other', s.overlaps.length === 0, JSON.stringify(s.overlaps));
  await app.evaluate(() => global.__fake.release());

  // ---- [plan mode] the Plan chip, a proposed plan's card, and Run plan
  await waitFor(async () => !(await state()).running);
  await app.evaluate(() => { global.__fake.gate = null; global.__fake.proposeNext = true; });
  await inPage(`(() => { document.getElementById('plan-chip').click(); const p = document.getElementById('prompt'); p.value = 'buy what is in my cart'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
  const card = await waitFor(async () => { const c = await inPage(`(() => { const c = document.querySelector('#messages .plan-card'); return c && !document.getElementById('send').classList.contains('stop') ? { steps: c.querySelectorAll('.plan-steps li').length, risky: c.querySelectorAll('[data-risky]').length, sites: c.querySelector('.plan-sites').textContent, buttons: [...c.querySelectorAll('.plan-actions button')].map((b) => b.textContent) } : null; })()`); return c && typeof c === 'object' ? c : null; }, 20000);
  const offered = await app.evaluate(() => global.__fake.tools || []);
  check('(plan) with the Plan chip on, the request offers propose_plan', offered.includes('propose_plan'), JSON.stringify(offered));
  check('(plan) the proposed plan shows as a card: steps, risky step, sites, Run plan / Edit / Keep planning', card && card.steps === 2 && card.risky === 1 && /shop\.example\.com/.test(card.sites) && card.buttons.join('|') === 'Run plan|Edit|Keep planning', JSON.stringify(card));
  await shot('5-plan');
  await inPage(`document.querySelector('#messages .plan-card .plan-run').click()`);
  await waitFor(async () => /Run this plan/.test(await inPage("[...document.querySelectorAll('#messages .msg.user')].pop()?.textContent || ''")) && !(await state()).running, 20000);
  const after = await app.evaluate(() => ({ tools: global.__fake.tools || [], hosts: [...global.__agent.approvedHosts] }));
  check('(plan) Run plan sends the plan as a normal message (no propose_plan offered) and allows exactly its site, for clicking and typing only', !after.tools.includes('propose_plan') && after.hosts.join() === 'interact:shop.example.com', JSON.stringify(after));
  check('(plan) the chip is off for the chat after Run plan', (await inPage(`document.getElementById('plan-chip').getAttribute('aria-pressed')`)) === 'false');

  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
