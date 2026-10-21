// "What is the answer for number 4" with a page in front of the user (plain Node): the words that point at an item of the page (screen-intent.js),
// the local file the user asks about is shared once and never asks twice or with a page that is not theirs (screen-context.js), and the part of a
// PDF that goes along with the message (pdf-text.js windowAround: the page on screen and its neighbours, bounded).
const { wantsScreen } = require('../../src/ai/screen-intent');
const sc = require('../../src/ai/screen-context');
const pdfText = require('../../src/features/pdf-text');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const J = JSON.stringify;

// ---- words
const ITEM_ASKS = [
  'what is the answer for number 4', 'what is the answer to number 4', "what's the answer to question 4?", 'what is the answer for #4', 'what is the answer to 4b',
  'solve number 4', 'solve question 3', 'explain question 3', 'explain number 2 to me', 'answer question 5', 'answer #4', 'do problem 2', 'can you do number 4 for me?',
  'help me with question 5b', 'walk me through problem 7', 'how do I solve number 6', 'what does question 2 ask', 'what is question 2 asking', 'q3 answer', 'check my work on number 4',
  'grade exercise 2', 'what is the solution to part 3',
];
for (const t of ITEM_ASKS) check(`with a page open, "${t}" points at it`, wantsScreen(t, { hasPage: true }).screen, J(wantsScreen(t, { hasPage: true })));
// (a few of these also work on their own words; the bare item references do not: with nothing open they are about the chat)
for (const t of ['solve number 4', 'explain question 3', 'do problem 2', 'help me with question 5b', 'answer #4', 'q3 answer']) {
  check(`with no page open, "${t}" is an ordinary message`, !wantsScreen(t).screen && !wantsScreen(t, { hasPage: false }).screen, J(wantsScreen(t)));
}
const NOT_ITEMS = ['I like number 4', 'what is number 4', 'thanks for number 4', 'number 4 is wrong, try again', 'write a poem about question 4 of life', 'my favourite is #4', 'what is the number 4 bus route in Boston'];
for (const t of NOT_ITEMS) check(`"${t}" is not about the page, even with one open`, !wantsScreen(t, { hasPage: true }).screen, J(wantsScreen(t, { hasPage: true })));
// the existing rules are unchanged by hasPage
for (const t of ['what is this', 'solve this', 'this is wrong, try again', 'make this shorter', 'tell me a joke']) {
  check(`"${t}": the same with or without a page`, wantsScreen(t, { hasPage: true }).screen === wantsScreen(t).screen, t);
}

// ---- the file in front of the user: one decision, from the user's own message
const LOCAL = 'lumen-pdf://app/viewer.html?u=' + encodeURIComponent('file:///C:/Users/me/Downloads/DiffEq_Midterm1_Practice_Test.pdf#page=3');
const WEB = 'https://example.com/quiz';
const base = { text: 'what is the answer for number 4', vision: true };
{
  const first = sc.plan({ ...base, url: LOCAL });
  check('a local PDF: "what is the answer for number 4" captures it, asking once for that file', first.capture && first.ask === true && first.local?.name === 'DiffEq_Midterm1_Practice_Test.pdf', J(first));
  const again = sc.plan({ ...base, url: LOCAL, shared: true });
  check('a local PDF the user already shared: captured, no card', again.capture && !again.ask, J(again));
  const solve = sc.plan({ ...base, url: LOCAL, text: 'solve number 4', shared: true });
  check('"solve number 4" on a local PDF: captured', solve.capture && /item/.test(solve.why), J(solve));
  check('"solve number 4" on a web page: captured under that site\'s rules', sc.plan({ ...base, url: WEB, text: 'solve number 4' }).capture);
  check('"solve number 4" with the AI turned off for the site: nothing', !sc.plan({ ...base, url: WEB, text: 'solve number 4', aiOff: true }).capture);
  check('"solve number 4" with AI off for local files: nothing, and it says so', (() => { const p = sc.plan({ ...base, url: LOCAL, text: 'solve number 4', aiOff: true }); return !p.capture && p.why === 'local-off' && /turned off AI for local files/.test(sc.refusal(p)); })());
  check('"solve number 4" in a private window: nothing', !sc.plan({ ...base, url: WEB, text: 'solve number 4', privateWindow: true }).capture);
  check('"solve number 4" with "attach the current page" off: nothing', !sc.plan({ ...base, url: WEB, text: 'solve number 4', pageContext: false }).capture);
  check('"solve number 4" on a checkout page: nothing', !sc.plan({ ...base, url: 'https://shop.example.com/checkout', text: 'solve number 4' }).capture);
  check('"solve number 4" on the new tab page: nothing captured, and no refusal (there is no page to point at)', (() => { const p = sc.plan({ ...base, url: 'about:blank', text: 'solve number 4' }); return !p.capture && sc.refusal(p) === ''; })());
  check('"solve number 4" on a settings page: nothing', !sc.plan({ ...base, url: 'file:///C:/app/src/renderer/settings.html', text: 'solve number 4' }).capture);
  check('"solve number 4" with the camera turned off for the message: nothing, nothing asked', (() => { const p = sc.plan({ ...base, url: LOCAL, text: 'solve number 4', mode: 'off' }); return !p.capture && !p.ask; })());
}

// ---- the part of a PDF that goes along
const page = (n, chars) => `P${n} ` + 'x'.repeat(chars - 4);
const shortPages = Array.from({ length: 13 }, (_, i) => page(i + 1, 1200));
{
  const w = pdfText.windowAround(shortPages, 3);
  check('the page on screen and the next one go along (a question split over the break)', J(w.pages) === '[3,4]' || J(w.pages) === '[2,3,4]', J(w.pages));
  check('...in page order, each under its own "Page N of 13" marker', /--- Page 3 of 13 ---[\s\S]*--- Page 4 of 13 ---/.test(w.text) && w.text.indexOf('P3 ') < w.text.indexOf('P4 '), w.text.slice(0, 120));
  check('...with the page on screen named, and the text bounded', w.current === 3 && w.text.length <= pdfText.WINDOW_CHARS && w.truncated, J({ c: w.current, len: w.text.length }));
  const tight = pdfText.windowAround(shortPages, 3, { maxChars: 2600 });
  check('a smaller budget keeps the page on screen first, then the next', J(tight.pages) === '[3,4]', J(tight.pages));
  const last = pdfText.windowAround(shortPages, 13);
  check('on the last page: it and the one before', J(last.pages) === '[12,13]', J(last.pages));
  const first = pdfText.windowAround(shortPages, 1);
  check('on the first page: it and the next', J(first.pages) === '[1,2]' || J(first.pages) === '[1,2,3]', J(first.pages));
  const huge = pdfText.windowAround([page(1, 500), page(2, 20000), page(3, 500)], 2);
  check('a page over the budget alone is cut, and its neighbours are left out rather than cut in the middle', J(huge.pages) === '[2]' && huge.text.length <= pdfText.WINDOW_CHARS + 60, J({ p: huge.pages, len: huge.text.length }));
  check('a page that is a scan says so', /no text on this page/.test(pdfText.windowAround(['', '', ''], 2).text));
  check('a page number past the end or below 1 is clamped', pdfText.windowAround(shortPages, 99).current === 13 && pdfText.windowAround(shortPages, 0).current === 1 && pdfText.windowAround(shortPages, 'x').current === 1);
  const roomy = pdfText.windowAround(Array.from({ length: 5 }, (_, i) => page(i + 1, 800)), 3);
  check('short pages: both neighbours go along', J(roomy.pages) === '[2,3,4]', J(roomy.pages));
}
check('the page of a viewer address (#page=3 inside u=)', pdfText.pageFromAddress(LOCAL) === 3, String(pdfText.pageFromAddress(LOCAL)));
check('the page of a plain PDF address', pdfText.pageFromAddress('file:///a.pdf#zoom=100&page=7') === 7 && pdfText.pageFromAddress('file:///a.pdf') === 0);
for (const t of ['summarize this pdf', 'give me an overview', 'what is this document about', 'list all the questions', 'how many pages is it', 'tl;dr']) check(`"${t}" wants the document as a whole`, pdfText.wantsWholeDocument(t), t);
for (const t of ['what is the answer for number 4', 'solve this', 'explain question 3', 'what does this say']) check(`"${t}" is about the part in front`, !pdfText.wantsWholeDocument(t), t);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
