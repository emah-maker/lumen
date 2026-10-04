// ACCEPTANCE (feature: image-gen-routing). Run alone: node scripts/test-acceptance.js chat-image-routing
//
// Any chat engine can get a picture made by another AI. The real Agent, ai-agents.js MCP entry and engines, with fake CLIs
// (test/acceptance/chat-harness.js) and FAKE image providers (no network, no key, no real generation):
//  - Claude Code (a CLI over MCP) calls Lumen's generate_image: a connected provider makes it, it shows in the chat with
//    "Made with <provider · model>", the model is told only that it was made.
//  - an outage on the first provider moves on to the next; a content-policy refusal does not (its words are the answer).
//  - "draw a cat" typed to Claude Code never reaches the CLI: it is routed straight to a provider.
//  - Settings > AI > Image generation: a chosen provider is the only one asked; off asks nobody; nothing unconnected is ever asked.
const fs = require('fs');
const path = require('path');
const { Agent } = require('../../src/ai/agent');
const gen = require('../../src/features/gen-images');
const H = require('./chat-harness');

const { check, chat, send, until, msgOf, release, gate, toolCall, textOf, errorsOf, finish, hardStop, agent, tmp } = H;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const png = PNG.toString('base64');
const J = JSON.stringify;
hardStop();

// ---- fakes: the real execute (the harness stubs it), a picture store, two connected providers, no Grok Build
agent.execute = Agent.prototype.execute;
agent.imageStore = gen.createImageStore({ dir: path.join(tmp, 'pictures') });
const keys = new Set(['openai', 'gemini']);
agent.getKey = (p) => (keys.has(p) ? `fake-key-${p}` : null);
agent.engines.grokbuild.status = async () => ({ installed: false, signedIn: false });
let setting = 'auto';
let excluded = [];
agent.browser.imageGen = () => setting;
agent.browser.autoExcluded = () => excluded;
const asked = [];
const provider = (name, behave) => async (a) => { asked.push({ name, prompt: a.prompt }); return behave(a); };
const fine = (model) => async () => ({ images: [{ data: png, alt: '' }], model, said: '' });
const policy = (msg) => Object.assign(new Error(msg), { status: 400, code: 'moderation_blocked' });
const down = () => Object.assign(new Error('429 You exceeded your current quota'), { status: 429 });
const fakes = (over = {}) => {
  agent.imageBackendOverrides = {
    openai: provider('openai', fine('gpt-image-1')),
    gemini: provider('gemini', fine('gemini-2.5-flash-image')),
    xai: provider('xai', fine('grok-2-image')),
    openrouter: provider('openrouter', fine('or-image')),
    ...over,
  };
  asked.length = 0;
};

(async () => {
  // ---- Claude Code asks for a picture over MCP
  {
    fakes();
    const messages = chat('claudecode:default');
    const run = send(messages, 'RUN-IMG HOLD-IMG please make something nice', 1);
    const m = await until(() => msgOf('RUN-IMG'), 15000);
    const out = m?.token ? await toolCall(m.token, 'generate_image', { prompt: 'a lighthouse at dawn, watercolor' }) : null;
    const text = (out?.content || []).map((c) => c.text || '').join(' ');
    check('Claude Code: its generate_image call is accepted', out && !out.isError, J(out));
    check('Claude Code: a connected provider made it (Gemini first: the API keys go in a fixed order), asked with the model\'s prompt', J(asked) === J([{ name: 'gemini', prompt: 'a lighthouse at dawn, watercolor' }]), J(asked));
    check('Claude Code: the model is told who made it and that it is shown (never the picture)', /made with Gemini · gemini-2\.5-flash-image/i.test(text) && /shown to the user/.test(text) && !text.includes(png), text);
    release('IMG');
    const events = await run.done;
    const pic = events.find((e) => e.type === 'image');
    check('Claude Code: the picture is shown in the chat with a "Made with" credit', pic && pic.credit === 'Gemini · gemini-2.5-flash-image' && /^[0-9a-f]{16}|^0~|~/.test(pic.id), J(events.filter((e) => e.type === 'image')));
    const last = [...messages].reverse().find((x) => x.role === 'assistant');
    check('Claude Code: the picture is kept on the reply, with its credit (it survives reopening the chat)', (last?.content || []).some((b) => b.type === 'generated_image' && b.credit === 'Gemini · gemini-2.5-flash-image'), J(last));
    check('Claude Code: the picture is saved in the chat\'s picture store', pic && agent.imageStore.read(pic.id)?.buffer.equals(PNG));
  }

  // ---- an outage: the next provider answers
  {
    fakes({ gemini: provider('gemini', async () => { throw down(); }) });
    const messages = chat('claudecode:default');
    const run = send(messages, 'RUN-OUT HOLD-OUT something', 1);
    const m = await until(() => msgOf('RUN-OUT'), 15000);
    const out = m?.token ? await toolCall(m.token, 'generate_image', { prompt: 'a red fox' }) : null;
    const text = (out?.content || []).map((c) => c.text || '').join(' ');
    check('an out-of-usage provider hands on: OpenAI answers and is the one named', !out?.isError && /made with OpenAI/i.test(text) && J(asked.map((a) => a.name)) === J(['gemini', 'openai']), J({ asked, text }));
    release('OUT');
    const events = await run.done;
    check('the chat\'s picture says OpenAI made it', events.some((e) => e.type === 'image' && /^OpenAI/.test(e.credit)), J(events.filter((e) => e.type === 'image')));
  }

  // ---- a refusal is the answer: nobody else is asked
  {
    fakes({ gemini: provider('gemini', async () => { throw policy('Your request was rejected by the safety system.'); }) });
    const messages = chat('claudecode:default');
    const run = send(messages, 'RUN-REF HOLD-REF something', 1);
    const m = await until(() => msgOf('RUN-REF'), 15000);
    const out = m?.token ? await toolCall(m.token, 'generate_image', { prompt: 'something not allowed' }) : null;
    const text = (out?.content || []).map((c) => c.text || '').join(' ');
    check('a provider that refuses on content grounds: the tool reports its words and who said them', out?.isError === true && /Gemini declined this picture: Your request was rejected by the safety system/.test(text), J(out));
    check('the refusal is not retried on another provider', J(asked.map((a) => a.name)) === J(['gemini']), J(asked));
    release('REF');
    const events = await run.done;
    check('no picture appears for a refused request', !events.some((e) => e.type === 'image'));
  }

  // ---- "draw a cat" typed to Claude Code goes straight to a provider, the CLI is not started
  {
    fakes();
    const before = fs.readFileSync(H.LOG, 'utf8').split('\n').filter(Boolean).length;
    const messages = chat('claudecode:default');
    const events = await send(messages, 'draw a cat on a windowsill', 1).done;
    const pic = events.find((e) => e.type === 'image');
    const after = fs.readFileSync(H.LOG, 'utf8').split('\n').filter(Boolean).length;
    check('"draw a cat": routed to a connected provider and shown with its credit', pic?.credit === 'Gemini · gemini-2.5-flash-image' && asked[0]?.prompt === 'draw a cat on a windowsill', J({ events: events.map((e) => e.type), asked }));
    check('"draw a cat": no "can\'t make pictures" notice, no error, and the CLI never ran', !events.some((e) => e.type === 'notice' || e.type === 'error') && after === before, J({ errors: errorsOf(events), before, after }));
    check('"draw a cat": the chat history holds the picture reply', messages.at(-1)?.role === 'assistant' && messages.at(-1).content.some((b) => b.type === 'generated_image'), J(messages.at(-1)));
  }

  // ---- the setting
  {
    setting = 'openai';
    fakes();
    let events = await send(chat('claudecode:default'), 'draw a dog', 1).done;
    check('a chosen provider (OpenAI) is the only one asked, though Gemini comes first in Automatic', J(asked.map((a) => a.name)) === J(['openai']) && events.some((e) => e.type === 'image' && /^OpenAI/.test(e.credit)), J(asked));

    setting = 'xai';
    fakes();
    events = await send(chat('claudecode:default'), 'draw a dog', 1).done;
    check('a chosen provider that is not connected (no Grok key): nothing is asked, no silent switch to another', asked.length === 0 && !events.some((e) => e.type === 'image') && /Grok is chosen for pictures/.test(textOf(events)), J({ asked, events: events.map((e) => e.type), text: textOf(events) }));

    setting = 'auto';
    excluded = ['gemini'];
    fakes();
    await send(chat('claudecode:default'), 'draw a dog', 1).done;
    check('providers turned off for Auto are skipped in Automatic', J(asked.map((a) => a.name)) === J(['openai']), J(asked));
    excluded = [];

    keys.clear();
    fakes();
    events = await send(chat('claudecode:default'), 'draw a dog', 1).done;
    check('no provider connected: nothing is called (no key is ever assumed) and the user is told', asked.length === 0 && events.some((e) => e.type === 'notice' && /can't make pictures/.test(e.text)), J({ asked, events: events.map((e) => `${e.type}:${e.text || ''}`.slice(0, 80)) }));
    keys.add('openai'); keys.add('gemini');

    setting = 'off';
    fakes();
    events = await send(chat('claudecode:default'), 'draw a dog', 1).done;
    check('off: nothing is routed anywhere', asked.length === 0 && !events.some((e) => e.type === 'image'), J(asked));
    const messages = chat('claudecode:default');
    const run = send(messages, 'RUN-OFF HOLD-OFF something', 1);
    const m = await until(() => msgOf('RUN-OFF'), 15000);
    const out = m?.token ? await toolCall(m.token, 'generate_image', { prompt: 'a cat' }) : null;
    check('off: the generate_image tool refuses with a line the model can pass on', out?.isError === true && /turned off/.test((out.content || []).map((c) => c.text).join(' ')) && asked.length === 0, J(out));
    release('OFF');
    await run.done;
    setting = 'auto';
  }

  void gate;
  finish();
})().catch((e) => { console.error(e); H.check('suite ran to the end', false, e.message); finish(); });
