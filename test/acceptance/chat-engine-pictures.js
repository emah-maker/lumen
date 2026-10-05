// ACCEPTANCE (feature: engine-images-inline). Run alone: node scripts/test-acceptance.js chat-engine-pictures
//
// A picture a CLI engine makes with its OWN tool (Grok Build's image_gen, full access on) is shown in the chat reply, not left as a
// file address: the real Agent and GrokBuildEngine with the fake CLI (test/acceptance/chat-harness.js). The fake saves a JPEG in
// its session folder under GROK_HOME, answers the tool call with the path, and replies only "images/1.jpg" (as the real grok does).
//  - full access on: an 'image' event with the file's name, and a generated_image block kept on the reply (saved in the chat's store).
//  - full access off: the same message shows no picture (the CLI could not have made one).
const path = require('path');
const { Agent } = require('../../src/ai/agent');
const gen = require('../../src/features/gen-images');
const H = require('./chat-harness');

const { check, chat, send, lastAssistant, errorsOf, finish, hardStop, agent, tmp } = H;
const J = JSON.stringify;
hardStop();

agent.execute = Agent.prototype.execute;
agent.imageStore = gen.createImageStore({ dir: path.join(tmp, 'pictures') });

(async () => {
  agent.browser.grokBuildFullAccess = () => true;
  const on = chat('grokbuild:default');
  const events = await send(on, 'RUN-PIC1 PICTOOL draw a cat', 1).done;
  const pic = events.find((e) => e.type === 'image');
  check('full access: the picture the CLI\'s image_gen saved is shown (an image event with its file name)', Boolean(pic) && pic.caption === '1.jpg' && pic.mime === 'image/jpeg', J(events.filter((e) => e.type !== 'text' && e.type !== 'thinking').slice(0, 8)));
  const reply = lastAssistant(on);
  const block = (reply?.content || []).find((b) => b.type === 'generated_image');
  check('full access: it is kept on the reply with the words, and saved in the chat\'s store', Boolean(block) && block.id === pic?.id && agent.imageStore.read(block.id)?.mime === 'image/jpeg' && (reply.content || []).some((b) => b.type === 'text' && /images\/1\.jpg/.test(b.text)), J(reply));
  check('full access: no error on the way', errorsOf(events).length === 0, J(errorsOf(events)));

  agent.browser.grokBuildFullAccess = () => false;
  const off = chat('grokbuild:default');
  const offEvents = await send(off, 'RUN-PIC2 PICTOOL draw a cat', 1).done;
  check('full access off: nothing from the CLI\'s folders is shown', !offEvents.some((e) => e.type === 'image') && !(lastAssistant(off)?.content || []).some((b) => b.type === 'generated_image'), J(offEvents.filter((e) => e.type === 'image')));

  await finish();
})().catch((err) => { console.error(err); process.exit(1); });
