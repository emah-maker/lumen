// Opening a finished download (features/downloads.js act 'open'), plain Node with fake Electron pieces: a double-click on a
// panel row sends Open twice before the panel closes, and the file must open once. A later Open, or another file, still opens.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDownloads } = require('../../src/features/downloads');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-dl-open-'));
const a = path.join(dir, 'notes.pdf');
const b = path.join(dir, 'other.pdf');
fs.writeFileSync(a, 'a');
fs.writeFileSync(b, 'b');
const opened = [];
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
const downloads = createDownloads({
  app: { getPath: () => dir, getFileIcon: () => Promise.reject(new Error('no icon')) },
  shell: { openPath: (file) => { opened.push(file); return Promise.resolve(''); } },
  win: () => null, ui: () => null, panel: () => null, downloadDir: () => dir, askWhereToSave: () => false,
});
const idA = downloads.addFile(a);
const idB = downloads.addFile(b);

downloads.act(idA, 'open');
now += 200;
downloads.act(idA, 'open'); // the second click of a double-click
check('a double-click opens the file once', opened.length === 1, JSON.stringify(opened));
downloads.act(idB, 'open');
check('another file opens right away', opened.length === 2 && opened[1] === b, JSON.stringify(opened));
downloads.act(idA, 'open');
check('going back to the first file opens it again', opened.length === 3, JSON.stringify(opened));
now += 2000;
downloads.act(idA, 'open');
check('the same file opens again a moment later', opened.length === 4, JSON.stringify(opened));

Date.now = realNow;
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
