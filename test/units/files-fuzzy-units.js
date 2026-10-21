// Files fuzzy ranking (features/files-fuzzy.js), plain Node: the order the picker and find_file show results in.
require('../helpers/_tmp-cleanup');
const { matchText, rank } = require('../../src/features/files-fuzzy');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const E = (name, folder = 'C:\\Users\\me\\Documents') => ({ name, path: `${folder}\\${name}` });
const names = (query, items, opts) => rank(query, items, opts).map((r) => r.item.name);

const items = [
  E('Chapter 4 slides.pptx'), E('Chapter 4 notes.docx'), E('Chapter 14 slides.pptx'), E('chapter4-slides-old.pptx', 'D:\\Archive'),
  E('Budget 2026.xlsx'), E('Resume final.pdf'), E('ME2350 Lecture 3.pdf'), E('Screenshot 2026-10-08.png'), E('slides.txt'), E('unrelated.md'),
];

check('every word must match: "chapter 4 slides" finds the slide decks, not the notes', names('chapter 4 slides', items).every((n) => /slides/.test(n)) && names('chapter 4 slides', items).length >= 3, names('chapter 4 slides', items).join());
check('the exact name ranks first', names('chapter 4 slides', items)[0] === 'Chapter 4 slides.pptx', names('chapter 4 slides', items).join());
check('a whole word beats a part of one: "4" ranks chapter 4 above chapter 14', names('chapter 4', items).indexOf('Chapter 4 notes.docx') < names('chapter 4', items).indexOf('Chapter 14 slides.pptx'), names('chapter 4', items).join());
check('a name that starts with the query ranks above one that merely holds it', names('slides', items)[0] === 'slides.txt', names('slides', items).join());
check('letters in order match: "c4s" finds Chapter 4 slides', names('c4s', items).includes('Chapter 4 slides.pptx'), names('c4s', items).join());
check('case does not matter, and neither do separators', names('CHAPTER4SLIDES', items).includes('Chapter 4 slides.pptx') && names('chapter 4 SLIDES', items)[0] === 'Chapter 4 slides.pptx' && names('me2350', items)[0] === 'ME2350 Lecture 3.pdf', names('CHAPTER4SLIDES', items).join());
check('a word missing from the name can be found in the folder, for less', names('archive slides', items)[0] === 'chapter4-slides-old.pptx', names('archive slides', items).join());
check('nothing matching gives nothing', rank('zebra', items).length === 0, '');
check('an empty query keeps everything (the picker\'s first screen)', rank('', items, { limit: 100 }).length === items.length, '');
check('the bonus lifts a pinned or recent file above an equal match', names('slides', [E('slides a.pptx'), E('slides b.pptx')], { bonus: (x) => (x.name === 'slides b.pptx' ? 50 : 0) })[0] === 'slides b.pptx', '');
check('the limit', rank('c', items, { limit: 2 }).length === 2, '');

const m = matchText('slides', 'Chapter 4 slides.pptx');
check('positions point at the matched letters, for highlighting', JSON.stringify(m.positions) === JSON.stringify([10, 11, 12, 13, 14, 15]) && 'Chapter 4 slides.pptx'.slice(10, 16) === 'slides', JSON.stringify(m));
const sub = matchText('c4s', 'Chapter 4 slides.pptx');
check('subsequence positions are in order and inside the name', sub && sub.positions.length === 3 && sub.positions.every((p, i) => i === 0 || p > sub.positions[i - 1]) && sub.positions[2] < 21, JSON.stringify(sub));

check('loose: a description with one wrong word still finds it (the AI\'s lookups)', names('my chapter 4 slides please', items, { loose: true })[0] === 'Chapter 4 slides.pptx' && names('my chapter 4 slides please', items).length === 0, names('my chapter 4 slides please', items, { loose: true }).join());
check('loose: more matched words rank higher', names('budget resume', items, { loose: true }).length === 2, names('budget resume', items, { loose: true }).join());

// Speed: 20k names, a three-word query, well under a frame.
const big = Array.from({ length: 20000 }, (_, i) => E(`report-${i}-final-v${i % 7}.docx`, `D:\\Work\\Project ${i % 50}`));
const t0 = process.hrtime.bigint();
rank('report final 77', big);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
check('20,000 names rank in well under 100 ms (they run in the worker, never on main)', ms < 100, `${ms.toFixed(1)} ms`);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
