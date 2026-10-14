// [hang recorder] The watchdog thread (features/hang-recorder.js): looks at main's heartbeat five times a second and, when it stops,
// writes what the breadcrumbs say to <userData>/diagnostics/hangs.jsonl with fs, from here, so it works while main is stuck.
const { workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const hr = require('./hang-recorder');

const { sab, file } = workerData;
const write = (entry) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* first line */ }
    fs.writeFileSync(file, hr.nextFile(text, entry, hr.MAX_LINES));
  } catch { /* a full disk or a locked file loses a line, nothing else */ }
};
const dog = hr.createWatchdog({ sab, sink: write, version: workerData.version });
setInterval(() => dog.tick(performance.now(), Date.now()), hr.POLL_MS);
