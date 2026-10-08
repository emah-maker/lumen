// The screen-intent detector (src/ai/screen-intent.js), plain Node: which messages point at what the user is looking at.
const { wantsScreen } = require('../src/ai/screen-intent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const J = JSON.stringify;

const POSITIVE = [
  'what is this', "what's this?", 'whats this', 'explain this', 'explain this to me', 'solve this', 'fix this', 'fix this error',
  'what am I looking at', 'what am i looking at?', 'what is on my screen', 'look at my screen', 'take a screenshot', 'screenshot this',
  'is this a scam?', 'is this legit', 'is this right?', 'is this safe to click', 'what does this mean', 'what does this error mean',
  'summarize this page', 'summarise this', 'translate this', 'read this for me', 'describe this image', 'what is this chart showing',
  'explain this graph', 'what is this video about', 'solve this problem', 'answer this question', 'help me with this', 'help me understand this',
  'what is this error', 'why am I getting this error', 'what should I do here', 'what do I click here', "what's going on here",
  'look at this', 'see this', 'check this out', 'what is the thing on screen', 'the thing on my screen is broken, why', 'tell me about this page',
  'what is on this page', 'can you see this?', 'do you see what I see', 'what do you see', 'is this email a scam', 'reply to this email',
  'who is this', 'where is this photo from', 'what is in this picture', 'debug this', 'proofread this', 'what is this table saying',
  'analyze this chart', 'what is this popup asking', 'how do I fill out this form', 'what does this button do', 'rewrite this paragraph',
  'what is the answer to this question', 'explain what I am looking at', 'what is this code doing', 'explain this code', 'what is this website',
  'is this product worth it', 'compare the prices on this page', 'can you read the text in this image', 'what are these numbers', 'is this a good deal',
];
const NEGATIVE = [
  'this is wrong, try again', 'this is wrong', "this isn't what I asked for", 'this is great, thanks', 'this works now', 'this still does not work',
  'that is wrong', "that's not right", 'thanks', 'thank you!', 'ok', 'continue', 'go on', 'try again', 'no, shorter please', 'make this shorter',
  'make it more formal', 'write a poem about autumn', 'what is the capital of France', 'how do I center a div in CSS', 'tell me a joke',
  'translate hello to Spanish', 'summarize the French Revolution', 'explain how photosynthesis works', 'what is 17 times 23', 'who wrote Hamlet',
  'this seems too long', 'this looks good to me', 'I like this', 'this helped a lot', 'yes, do that', 'that worked', 'rewrite it in Python',
  'add this to the list', 'what time is it in Tokyo', 'open github.com', 'search for cheap flights to Rome', 'how are you today', 'can you help me write an email',
  'give me three ideas for a birthday gift', 'why is the sky blue', 'what does the word ephemeral mean', 'make this bulleted', 'shorten this please',
  'this is not helpful', 'this is too complicated', 'remind me what you said earlier', 'explain recursion', 'fix the bug in my sort function',
  'I think this is a good plan', 'how do I take a screenshot on a Mac', 'do this in Rust instead', 'write this in Python', "you're wrong", 'that makes sense', 'that is what I wanted', 'now do the same for Python',
];

for (const p of POSITIVE) { const r = wantsScreen(p); check(`fires: ${p}`, r.screen === true, `${r.score} ${r.reason}`); }
for (const p of NEGATIVE) { const r = wantsScreen(p, { lastTurns: [{ role: 'user', text: 'write a function' }, { role: 'assistant', text: 'Here is the function: ```js\nfunction f() {}\n```' }] }); check(`quiet: ${p}`, r.screen === false, `${r.score} ${r.reason}`); }
for (const p of NEGATIVE) { const r = wantsScreen(p); check(`quiet (fresh chat): ${p}`, r.screen === false, `${r.score} ${r.reason}`); }

// The reason is readable and the result always has the same shape.
{
  const r = wantsScreen('explain this error');
  check('result shape', typeof r.screen === 'boolean' && typeof r.reason === 'string' && r.reason.length > 0 && typeof r.score === 'number', J(r));
  check('empty and non-strings are quiet', !wantsScreen('').screen && !wantsScreen(null).screen && !wantsScreen(undefined).screen && !wantsScreen(42).screen);
  check('slash commands are quiet', !wantsScreen('/compact what is this').screen && !wantsScreen('/image a screenshot of a cat').screen);
  check('a long essay is about its own words', !wantsScreen(`what is this ${'word '.repeat(200)}`).screen);
}
// Context moves a borderline phrase, not a clear one.
{
  const after = { lastTurns: [{ role: 'user', text: 'what is 2+2' }, { role: 'assistant', text: '4' }] };
  check('"is this right?" straight after an answer is about the answer', !wantsScreen('is this right?', after).screen);
  check('"is this right?" on a fresh chat points at the page', wantsScreen('is this right?').screen);
  check('"explain this error" still fires after an answer', wantsScreen('explain this error', after).screen);
  check('"what is this chart" still fires after an answer', wantsScreen('what is this chart', after).screen);
  check('a bare "explain this" still fires after an answer', wantsScreen('explain this', after).screen);
  check('selected text is what "this" means', !wantsScreen('what does this mean', { hasSelection: true }).screen);
  check('selected text does not hide a visual noun', wantsScreen('what is this chart', { hasSelection: true }).screen);
  check('selected text does not hide "my screen"', wantsScreen('what is on my screen', { hasSelection: true }).screen);
}
// Speed: it runs on every keystroke.
{
  const started = process.hrtime.bigint();
  for (let i = 0; i < 2000; i++) wantsScreen(POSITIVE[i % POSITIVE.length]);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  check('2000 checks in well under a second', ms < 500, `${ms.toFixed(0)} ms`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
