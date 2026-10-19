// Files indexer (features/files-index.js + files-index-worker.js) on a real worker thread, plain Node: depth 4, the entry cap,
// links and credential files left out, fuzzy search over what is indexed, Find it for a moved file, the slow scan.
require('./_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIndexer } = require('../src/features/files-index');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-files-index-'));
const put = (rel, data = 'x') => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setInterval(() => {}, 1000); // (the indexer's worker is unref'd, as in Lumen where the app keeps the loop alive)

(async () => {
  const course = path.join(root, 'Course');
  put('Course/Chapter 4 slides.pptx', 'deck');
  put('Course/Week 1/notes.txt');
  put('Course/a/b/c/d/deep4.txt');
  put('Course/a/b/c/d/e/deep5.txt');
  put('Course/.hidden/secret.txt');
  put('Course/.env', 'KEY=1');
  put('Course/node_modules/pkg/index.js');
  put('Course/server.pem', 'k');
  const ix = createIndexer({ every: 50 });
  const res = await ix.index(course);
  check('index: files down to depth 4', res.count === 3 && !res.truncated, JSON.stringify(res));
  ix.setRoots([course]);
  await sleep(300);
  const hits = await ix.search('chapter 4 slides');
  check('search: finds a file in a pinned folder, with its size and time', hits.length === 1 && hits[0].name === 'Chapter 4 slides.pptx' && hits[0].size === 4 && hits[0].mtime > 0 && hits[0].root === course, JSON.stringify(hits));
  check('search: not the folders that are never walked, nor credential files', (await ix.search('secret')).length === 0 && (await ix.search('index')).length === 0 && (await ix.search('pem')).length === 0 && (await ix.search('env')).length === 0, '');
  check('search: nothing deeper than depth 4', (await ix.search('deep5')).length === 0 && (await ix.search('deep4')).length === 1, '');
  const dropped = put('Course/dropped later.txt');
  await sleep(250);
  check('the 10-minute re-index (here 50 ms) picks up a new file', (await ix.search('dropped later')).length === 1, '');
  fs.unlinkSync(dropped);
  check('a file that vanished since the walk is not returned', (await ix.search('dropped later')).length === 0, '');
  check('no pinned folders, no search', await createIndexer().search('x').then((r) => r.length === 0), '');

  // the cap
  for (let i = 0; i < 30; i++) put(`Big/f${i}.txt`);
  const capped = await ix.index(path.join(root, 'Big')); // (the default cap is 20,000: reach the worker's own check with a direct small walk)
  check('index: counts what it found', capped.count === 30, JSON.stringify(capped));
  const scanned = await ix.scan({ roots: [path.join(root, 'Big')], query: 'f7', cap: 10 });
  check('scan: a cap stops the walk', scanned.length <= 10, JSON.stringify(scanned));

  // Find it: the file moved to a sibling folder, or was renamed with the same size
  const old = path.join(root, 'Course', 'Old', 'Chapter 4 slides.pptx');
  const found = await ix.find({ path: old, size: 4 });
  check('find: a moved file with the same name is a candidate (its old folder is gone)', found.some((c) => c.path === path.join(course, 'Chapter 4 slides.pptx')), JSON.stringify(found));
  put('Course/Week 1/Chapter 4 slides (copy).pptx', 'deck');
  const similar = await ix.find({ path: path.join(course, 'Old', 'Chapter 4 slides final.pptx'), size: 4 });
  check('find: the same size and a similar name is a candidate too', similar.some((c) => /\(copy\)/.test(c.name)) && similar.every((c) => c.size === 4), JSON.stringify(similar));
  const none = await ix.find({ path: path.join(course, 'Old', 'Budget.xlsx'), size: 4 });
  check('find: nothing alike, nothing offered', none.length === 0, JSON.stringify(none));

  // the slow scan, counted
  const before = ix.stats.scan;
  const slow = await ix.scan({ roots: [root], query: 'chapter 4 slides' });
  check('scan: a fresh walk finds it, and is counted', slow.length >= 1 && /Chapter 4 slides/.test(slow[0].name) && ix.stats.scan === before + 1, JSON.stringify(slow));

  ix.close();
  await sleep(50);
  check('close ends the worker and later calls start a new one', (await ix.index(course)).count > 0, JSON.stringify(await ix.index(course)));
  ix.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
