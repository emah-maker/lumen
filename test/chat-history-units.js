// A tab chat's history reaching its engine on every message, plain Node (no Electron, no network, no real CLI):
// each chat keeps its own Claude Code / Grok Build session (two chats sending at once never share or swap one),
// a resumed session is handed the turns another model answered meanwhile, a session the CLI no longer has is
// replaced at once by a new one handed the whole chat (compactly: its opening is never cut away), and a session
// that holds turns the chat no longer has is not resumed.
const { Agent, handoffTurns, missedItems } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const reply = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

// ---- the compact transcript
{
  const short = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }];
  check('handoff: a short chat goes whole', handoffTurns(short) === 'User: hi\n\nAssistant: hello', handoffTurns(short));
  const long = [];
  for (let i = 0; i < 60; i++) long.push({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i} ${'x'.repeat(1500)}` });
  const text = handoffTurns(long, 20000);
  check('handoff: a long chat keeps its opening exchange', text.startsWith('User: turn 0 ') && text.includes('Assistant: turn 1 '), text.slice(0, 80));
  check('handoff: ...and its newest turns', text.includes('turn 59 '), text.slice(-80));
  check('handoff: says how many were left out in between', /\[… \d+ messages left out …\]/.test(text), text.slice(3000, 3300));
  check('handoff: stays within its budget', text.length <= 20000, text.length);
  const huge = handoffTurns([{ role: 'user', text: 'y'.repeat(50000) }]);
  check('handoff: one very long turn is clipped', huge.length < 5000 && huge.endsWith('[…]'), huge.length);
  check('handoff: an image-only turn is named', handoffTurns([{ role: 'user', text: '', images: ['data:x'] }]) === 'User: (an image)');
}

// ---- what a resumed session missed
{
  const m = [user('a'), reply('A'), user('b'), reply('B'), user('now')];
  check('missed: nothing when the session saw everything before this message', missedItems(m, 4).length === 0);
  check('missed: the turns after the count', J(missedItems(m, 2).map((x) => x.text)) === J(['b', 'B']), J(missedItems(m, 2)));
  check('missed: an older chat with no count missed nothing', missedItems(m, undefined).length === 0);
}

// ---- the agent, with fake engines
const fakeBrowser = () => ({ activeTab: () => null, tabById: () => null, listTabs: () => [], effectiveModel: (x) => x, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0, autoModel: () => false });
const newAgent = () => {
  const agent = new Agent(fakeBrowser(), () => null, () => ({ model: 'claude-opus-5', pageContext: false }));
  agent.closeSignedInTabs = () => {};
  agent.newActionLog = () => ({});
  agent.undoSummary = () => null;
  return agent;
};
const chat = (model) => { const m = []; m.settings = { model, adhdMode: true }; return m; };
const run = async (agent, messages, text) => {
  const events = [];
  await agent.run(text, (e) => events.push(e), [], { messages });
  return events;
};

// A fake Claude Code: each call is recorded; a session it was told to forget answers "expired".
function fakeClaudeCode({ delay = () => 0, gone = new Set() } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    warm() {}, release() {},
    async run(opts) {
      const call = { sessionId: opts.sessionId, resume: opts.resume, prompt: opts.prompt };
      calls.push(call);
      await sleep(delay(call));
      if (opts.resume && gone.has(opts.sessionId)) return { text: '', sessionId: null, failed: true, expired: true };
      n++;
      return { text: `cc reply ${n}`, sessionId: opts.sessionId };
    },
  };
}

(async () => {
  // A Claude Code chat: its session id is kept with the chat and resumed on its next message.
  {
    const agent = newAgent();
    const cc = fakeClaudeCode();
    agent.engines = { claudecode: cc };
    const m = chat('claudecode:sonnet');
    await run(agent, m, 'first question');
    const s1 = m.settings.ccSession;
    await run(agent, m, 'second question');
    check('claude code: the second message resumes the chat\'s own session', Boolean(s1) && cc.calls[1].resume === true && cc.calls[1].sessionId === s1, J(cc.calls));
    check('claude code: the chat remembers how far its session has seen', m.settings.ccSeen === m.length && m.length === 4, J({ seen: m.settings.ccSeen, n: m.length }));

    // The chat goes on with an API model for a turn (pushed here as the API loop does), then back to Claude Code.
    m.push(user('<browser_state>x</browser_state>\n\nwhat about the API turn'), reply('an answer from the API model'));
    m.settings.model = 'claudecode:sonnet';
    await run(agent, m, 'third question');
    const third = cc.calls[2];
    check('claude code: back from another model it resumes the same session', third.resume === true && third.sessionId === s1, J(third));
    check('claude code: ...handed the turns it missed meanwhile', third.prompt.includes('what about the API turn') && third.prompt.includes('an answer from the API model') && third.prompt.indexOf('<earlier_conversation>') === 0, third.prompt.slice(0, 400));
    check('claude code: ...and not its own earlier turns again', !third.prompt.includes('first question') && !third.prompt.includes('cc reply 1'), third.prompt.slice(0, 400));
    await run(agent, m, 'fourth question');
    check('claude code: the next message carries nothing extra', !cc.calls[3].prompt.includes('<earlier_conversation>'), cc.calls[3].prompt.slice(0, 200));
  }

  // Two tab chats sending at the same time: each keeps its own session, whatever order the replies come back in.
  {
    const agent = newAgent();
    const cc = fakeClaudeCode({ delay: (call) => (call.prompt.includes('chat A') ? 40 : 5) });
    agent.engines = { claudecode: cc };
    const a = chat('claudecode:sonnet');
    const b = chat('claudecode:sonnet');
    // (One run at a time is runTask's rule today; the turns themselves are called side by side here, as parallel CLI chats will.)
    const turn = (m, text) => { m.push(user(text)); return agent.claudeCodeTurn(m, text, [], new AbortController().signal, () => {}, { userText: text }); };
    await Promise.all([turn(a, 'hello from chat A'), turn(b, 'hello from chat B')]);
    check('two chats: two different sessions', a.settings.ccSession && b.settings.ccSession && a.settings.ccSession !== b.settings.ccSession, J([a.settings.ccSession, b.settings.ccSession]));
    const firstA = cc.calls.find((c) => c.prompt.includes('chat A')).sessionId;
    const firstB = cc.calls.find((c) => c.prompt.includes('chat B')).sessionId;
    check('two chats: each kept the session its own message started', a.settings.ccSession === firstA && b.settings.ccSession === firstB, J({ a: a.settings.ccSession, firstA, b: b.settings.ccSession, firstB }));
    cc.calls.length = 0;
    await Promise.all([turn(a, 'again from chat A'), turn(b, 'again from chat B')]);
    const againA = cc.calls.find((c) => c.prompt.includes('again from chat A'));
    const againB = cc.calls.find((c) => c.prompt.includes('again from chat B'));
    check('two chats: each resumes its own session, never the other\'s', againA.resume && againA.sessionId === firstA && againB.resume && againB.sessionId === firstB, J(cc.calls));
    check('two chats: each chat\'s history holds only its own turns', a.every((x) => !J(x).includes('chat B')) && b.every((x) => !J(x).includes('chat A')), J({ a, b }));
  }

  // A session the CLI no longer has: a new one starts at once, handed the whole chat (its opening too).
  {
    const agent = newAgent();
    const gone = new Set();
    const cc = fakeClaudeCode({ gone });
    agent.engines = { claudecode: cc };
    const m = chat('claudecode:sonnet');
    await run(agent, m, 'my name is Ada and this is the very first thing I said');
    for (let i = 0; i < 12; i++) await run(agent, m, `filler message ${i} ${'z'.repeat(800)}`);
    const old = m.settings.ccSession;
    gone.add(old);
    cc.calls.length = 0;
    const events = await run(agent, m, 'what is my name?');
    const retry = cc.calls[1];
    check('expired: tried the old session, then a new one', cc.calls.length === 2 && cc.calls[0].sessionId === old && retry.resume === false && retry.sessionId !== old, J(cc.calls.map((c) => ({ s: c.sessionId, r: c.resume }))));
    check('expired: the new session is handed the opening of the chat (not only its last few thousand characters)', retry.prompt.includes('my name is Ada'), retry.prompt.slice(0, 300));
    check('expired: no error is shown', !events.some((e) => e.type === 'error'), J(events.filter((e) => e.type === 'error')));
    check('expired: the chat keeps the new session', m.settings.ccSession === retry.sessionId && m.settings.ccSeen === m.length, J(m.settings));
  }

  // A session that holds turns the chat no longer has (the chat was cut since): not resumed; the chat is handed over.
  {
    const agent = newAgent();
    const cc = fakeClaudeCode();
    agent.engines = { claudecode: cc };
    const m = chat('claudecode:sonnet');
    m.push(user('kept question'), reply('kept answer'));
    m.settings.ccSession = 'sess-old';
    m.settings.ccSeen = 6; // it saw more than the chat now holds
    await run(agent, m, 'next');
    check('reshaped: the old session is not resumed', cc.calls[0].resume === false && cc.calls[0].sessionId !== 'sess-old', J(cc.calls[0]));
    check('reshaped: the new session gets the chat so far', cc.calls[0].prompt.includes('kept question') && cc.calls[0].prompt.includes('kept answer'), cc.calls[0].prompt.slice(0, 300));
  }

  // A saved chat comes back with its session and count (they live in the chat's settings).
  {
    const agent = newAgent();
    const cc = fakeClaudeCode();
    agent.engines = { claudecode: cc };
    const m = chat('claudecode:sonnet');
    await run(agent, m, 'before the restart');
    const saved = JSON.parse(J(agent.snapshot(m)));
    const again = newAgent();
    again.engines = { claudecode: cc };
    again.restore(saved);
    await run(again, again.messages, 'after the restart');
    const last = cc.calls[cc.calls.length - 1];
    check('restart: the restored chat resumes its own session', last.resume === true && last.sessionId === m.settings.ccSession && !last.prompt.includes('<earlier_conversation>'), J(last).slice(0, 300));
  }

  // Grok Build: the same, through its own session (gbSession).
  {
    const agent = newAgent();
    const calls = [];
    const gone = new Set();
    agent.engines = {
      grokbuild: {
        prepare: async () => ({}),
        async run(opts) {
          calls.push({ sessionId: opts.sessionId, resume: opts.resume, quietExpired: opts.quietExpired, prompt: opts.prompt });
          if (opts.resume && gone.has(opts.sessionId)) {
            if (!opts.quietExpired) opts.emit({ type: 'error', text: 'session not found' });
            return { text: '', sessionId: null, failed: true, expired: Boolean(opts.quietExpired) };
          }
          return { text: `grok reply ${calls.length}`, sessionId: opts.sessionId };
        },
      },
    };
    const m = chat('grokbuild:default');
    await run(agent, m, 'grok first, remember the word PINEAPPLE');
    const s1 = m.settings.gbSession;
    m.push(user('asked an API model meanwhile'), reply('the API model answered'));
    await run(agent, m, 'grok second');
    check('grok: resumes the chat\'s own session', calls[1].resume === true && calls[1].sessionId === s1, J(calls[1]).slice(0, 200));
    check('grok: handed the turns it missed', calls[1].prompt.includes('asked an API model meanwhile') && !calls[1].prompt.includes('PINEAPPLE'), calls[1].prompt.slice(0, 300));
    check('grok: the count follows', m.settings.gbSeen === m.length, J({ seen: m.settings.gbSeen, n: m.length }));
    gone.add(m.settings.gbSession);
    calls.length = 0;
    const events = await run(agent, m, 'grok third');
    check('grok expired: a new session at once, handed the whole chat', calls.length === 2 && calls[1].resume === false && calls[1].sessionId !== s1 && calls[1].prompt.includes('PINEAPPLE'), J(calls.map((c) => ({ s: c.sessionId, r: c.resume }))));
    check('grok expired: no error is shown', !events.some((e) => e.type === 'error'), J(events.filter((e) => e.type === 'error')));
    check('grok expired: the chat keeps the new session', m.settings.gbSession === calls[1].sessionId, J(m.settings));
  }

  // Antigravity: back from another model, its conversation (agySession) is handed the turns it missed.
  {
    const agent = newAgent();
    const calls = [];
    agent.browser.antigravityFullAccess = () => false;
    agent.engines = {
      antigravity: {
        prepare: async () => ({}),
        async run(opts) {
          calls.push({ sessionId: opts.sessionId, prompt: opts.prompt });
          return { text: `agy reply ${calls.length}`, sessionId: opts.sessionId || 'agy-conv-1' };
        },
      },
    };
    const m = chat('antigravity:default');
    await run(agent, m, 'agy first, remember MANGO');
    check('antigravity: the chat keeps its conversation and count', m.settings.agySession === 'agy-conv-1' && m.settings.agySeen === m.length, J(m.settings));
    m.push(user('asked an API model about kiwis'), reply('the API model talked about kiwis'));
    await run(agent, m, 'agy second');
    check('antigravity: continues its own conversation', calls[1].sessionId === 'agy-conv-1', J(calls[1]).slice(0, 200));
    check('antigravity: handed the turns it missed, not its own again', calls[1].prompt.includes('asked an API model about kiwis') && calls[1].prompt.includes('the API model talked about kiwis') && !calls[1].prompt.includes('MANGO'), calls[1].prompt.slice(0, 300));
    await run(agent, m, 'agy third');
    check('antigravity: the next message carries nothing extra', !calls[2].prompt.includes('<earlier_conversation>') && m.settings.agySeen === m.length, calls[2].prompt.slice(0, 200));
  }

  // The catch-up names the model that wrote each missed reply, also after the chat is saved and reloaded.
  {
    const agent = newAgent();
    const cc = fakeClaudeCode();
    agent.engines = { claudecode: cc };
    const m = chat('claudecode:sonnet');
    await run(agent, m, 'first question');
    const snap = agent.snapshot(m);
    snap.messages.push({ role: 'user', content: [{ type: 'text', text: 'ask grok' }], author: null }, { role: 'assistant', content: [{ type: 'text', text: 'GROK SAID PINEAPPLE' }], author: 'grokbuild:default' },
      { role: 'user', content: [{ type: 'text', text: 'ask the api' }], author: null }, { role: 'assistant', content: [{ type: 'text', text: 'API SAID FIG' }], author: 'claude-sonnet-5' });
    const saved = JSON.parse(J(snap)); // as written to disk
    agent.restore(saved);
    const m2 = agent.messages;
    m2.settings.model = 'claudecode:sonnet';
    await run(agent, m2, 'What did Grok just answer?');
    const prompt = cc.calls[cc.calls.length - 1].prompt;
    check('handoff names Grok Build for its reply (after reload)', prompt.includes('Grok Build: GROK SAID PINEAPPLE'), prompt.slice(0, 500));
    check('handoff names an API model by its display name', prompt.includes('Sonnet 5: API SAID FIG'), prompt.slice(0, 500));
    check('handoff: the note says replies are labeled', /labeled with the model/.test(prompt), prompt.slice(0, 300));
    check('handoff: the label is not sent to the APIs', !J(agent.snapshot(m2).messages).includes('"by"'));
  }
  {
    const items = [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a', by: 'Antigravity' }, { role: 'assistant', text: 'b' }];
    const want = ['User: q', 'Antigravity: a', 'Assistant: b'].join('\n\n');
    check('handoff: labels by model, falls back to Assistant', handoffTurns(items) === want, handoffTurns(items));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
