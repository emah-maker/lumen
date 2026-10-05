// Picture turns on Auto: how a message that holds pictures is routed (a simple question stays off the strongest model,
// a hard one and /think still reach it), when the page's text is not read first, and how old pictures leave the history.
// Plain Node: no Electron, no CLI, no network.
const A = require('../src/ai/auto-model');
const { isPictureQuestion, stubOldImages, OLD_IMAGE_NOTE } = require('../src/ai/loop-guard');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const cc = ['haiku', 'sonnet', 'opus'].map((m) => ({ id: `claudecode:${m}`, name: m, signedIn: true }));
const pick = (request, extra = {}) => A.route({ options: cc, request, scope: 'claudecode', ...extra });

// ---- routing
for (const prompt of ["what's in this picture?", 'read the grand total and ref code', 'The user attached the image(s) above without a message.', 'describe this screenshot']) {
  const d = pick({ prompt, imageCount: 1 });
  check(`a simple picture question never goes to the strongest tier: "${prompt.slice(0, 30)}"`, d.tier !== 'strong' && d.id !== 'claudecode:opus', d.id);
}
check('a picture question is answered in well under a second of routing (pure, no I/O)', (() => { const t = process.hrtime.bigint(); for (let i = 0; i < 200; i++) pick({ prompt: "what's in this picture?", imageCount: 2 }); return Number(process.hrtime.bigint() - t) / 1e6 < 500; })(), '');
check('a hard picture task still escalates', pick({ prompt: 'Debug why this stack trace happens and refactor the function across the codebase, step by step: root cause, then fix, then tests.', imageCount: 1 }).tier === 'strong', '');
check('/think on a picture asks for the strongest model', pick({ prompt: 'what is this?', imageCount: 1, hint: 'think' }).id === 'claudecode:opus', '');
check('/fast on a picture asks for the quickest model', pick({ prompt: 'what is this?', imageCount: 1, hint: 'fast' }).id === 'claudecode:haiku', '');
check('a chat already running on a stronger tier keeps it for a picture follow-up', pick({ prompt: 'and this one?', imageCount: 1, previousTier: 'strong', floorTier: 'strong', turns: 2 }).tier === 'strong', '');

// ---- no page read for a question about the attached picture
check('"what\'s in this picture?" with a picture needs no page text', isPictureQuestion("what's in this picture?", 1), '');
check('a picture sent without words needs no page text', isPictureQuestion('', 1), '');
check('"read the total" needs no page text', isPictureQuestion('read the total in this screenshot', 1), '');
check('without a picture it is not a picture question', !isPictureQuestion("what's in this picture?", 0), '');
check('words about the page or an action keep the page read', !isPictureQuestion('compare this with the page', 1) && !isPictureQuestion('click the login button in this picture', 1) && !isPictureQuestion('open https://x.test and compare', 1) && !isPictureQuestion('take a screenshot of my screen', 1), '');
check('a long brief keeps the page read', !isPictureQuestion('x'.repeat(300), 1), '');

// ---- old pictures leave the history
const img = (n) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `d${n}` } });
const user = (text, ...images) => ({ role: 'user', content: [...images, { type: 'text', text }] });
const asst = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const shot = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [img(9), { type: 'text', text: 'Screenshot' }] }] });
const chat = [user('one', img(1)), asst('a1'), user('two', img(2)), asst('a2'), user('three', img(3)), asst('a3'), user('four', img(4))];
const out = stubOldImages(chat);
const count = (msgs) => msgs.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'image').length : 0), 0);
check('only the newest two typed messages keep their pictures', count(out) === 2 && out[4].content[0].type === 'image' && out[6].content[0].type === 'image' && out[0].content[0].text === OLD_IMAGE_NOTE && out[2].content[0].text === OLD_IMAGE_NOTE, JSON.stringify(out.map((m) => m.content[0].type)));
check('the chat itself keeps its pictures (a copy is sent)', count(chat) === 4 && chat[0].content[0].type === 'image', '');
check('a chat of two typed messages keeps both pictures', count(stubOldImages(chat.slice(4))) === 2, '');
check('nothing to drop returns the same array', (() => { const small = [user('a', img(1)), asst('x'), user('b', img(2))]; return stubOldImages(small) === small; })(), '');
const withTools = [user('first', img(1)), { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} }] }, shot('t1'), asst('seen'), user('second', img(2)), asst('ok'), user('third')];
const out2 = stubOldImages(withTools);
check('screenshots the AI took earlier are dropped too', out2[2].content[0].content[0].text === OLD_IMAGE_NOTE && out2[2].content[0].content[1].text === 'Screenshot', JSON.stringify(out2[2]));
check('pictures in the current turn (before the next typed message) stay, tool screenshots included', (() => {
  const run = [user('old', img(1)), asst('a'), user('now'), { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'screenshot', input: {} }] }, shot('t2')];
  return count(stubOldImages(run)) === 1 && stubOldImages(run)[4].content[0].content[0].type === 'image';
})(), '');
check('the cut is stable while a turn goes on (same output for the same older history)', JSON.stringify(stubOldImages([...chat, asst('x')]).slice(0, 7)) === JSON.stringify(out), '');

if (failures) { console.log(`\n${failures} picture-speed check(s) failed`); process.exit(1); }
console.log('\nAll picture-speed checks passed');
