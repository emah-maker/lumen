// Loaded in Lumen's main process before main.js by test/no-errors.js (through a tiny generated entry point): records every
// console.error/warn of main, uncaught exceptions and rejections, and every warning/error a web contents logs. Each event is
// appended as a JSON line to the file named by LUMEN_NOERR_LOG (main may quit before the test reads memory).
const fs = require('fs');
const util = require('util');
const { app } = require('electron');

const LOG = process.env.LUMEN_NOERR_LOG;
const push = (where, level, text, extra) => {
  const ev = { where, level, text: String(text).slice(0, 600), at: Date.now(), ...extra };
  try { fs.appendFileSync(LOG, `${JSON.stringify(ev)}\n`); } catch { /* the log is gone */ }
};
for (const level of ['error', 'warn']) {
  const orig = console[level];
  console[level] = function (...args) { push('main', level, util.format(...args)); return orig.apply(this, args); };
}
process.on('uncaughtExceptionMonitor', (err) => push('main', 'exception', (err && err.stack) || err));
process.on('unhandledRejection', (reason) => push('main', 'rejection', (reason && reason.stack) || reason));
app.on('web-contents-created', (_e, wc) => {
  const where = () => { try { return wc.getURL().replace(/[?#].*$/, '').slice(0, 120); } catch { return '?'; } };
  wc.on('console-message', (e) => {
    const lv = typeof e.level === 'number' ? ['verbose', 'info', 'warning', 'error'][e.level] : e.level;
    if (lv === 'warning' || lv === 'error') push('renderer', lv, e.message, { url: where(), kind: wc.getType() + '#' + wc.id, source: String(e.sourceId || '').slice(-80), line: e.lineNumber });
  });
  wc.on('render-process-gone', (_ev, details) => push('renderer', 'gone', JSON.stringify(details), { url: where() }));
  wc.on('preload-error', (_ev, p, err) => push('renderer', 'preload-error', (err && err.stack) || err, { url: where(), source: p }));
  wc.on('did-fail-load', (_ev, code, desc, url, isMain) => { if (code !== -3 && isMain) push('renderer', 'load-failed', `${code} ${desc} ${url}`, { url: where() }); });
});
// A trace of what each web contents did (not errors: test/no-errors.js leaves 'trace' lines out of its verdict, --keep copies them for a closer look).
app.on('web-contents-created', (_e, wc) => {
  const id = `${wc.getType()}#${wc.id}`;
  push('trace', 'created', id);
  wc.on('did-start-navigation', (d) => { if (d.isMainFrame) push('trace', 'nav', `${id} ${d.url.slice(0, 120)}`); });
  wc.on('destroyed', () => push('trace', 'destroyed', id));
});
