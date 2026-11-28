// cli-utils killTree on Windows: taskkill /T stops a CLI child and what it started; when taskkill cannot start, or starts and fails
// (exits non-zero: on a busy machine it can fail as it starts, with no 'error' event), the child itself is still stopped.
// A warm CLI process used to live on after its chat was deleted, and past Lumen's quit (test/acceptance/chat-warm-per-chat.js
// under release load). Plain Node: fake children and a fake taskkill.
const { EventEmitter } = require('events');
const { killTree } = require('../../src/ai/cli-utils');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const child = () => Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, killed: false, kills: 0, kill() { this.kills++; this.killed = true; this.exitCode = 1; return true; } });
const taskkill = (behave) => {
  const calls = [];
  const run = (bin, args) => { const p = new EventEmitter(); calls.push([bin, args]); setImmediate(() => behave(p)); return p; };
  return { run, calls };
};
const tick = () => new Promise((r) => setImmediate(() => setImmediate(r)));

(async () => {
  {
    const c = child(); const tk = taskkill((p) => { c.exitCode = 1; p.emit('exit', 0); });
    killTree(c, { run: tk.run, platform: 'win32' });
    await tick();
    check('taskkill /T /F is asked for the child\'s pid', tk.calls.length === 1 && tk.calls[0][0] === 'taskkill' && tk.calls[0][1].join(' ') === '/pid 4242 /T /F', JSON.stringify(tk.calls));
    check('when taskkill succeeds the child is not killed a second time', c.kills === 0, String(c.kills));
  }
  {
    const c = child(); const tk = taskkill((p) => p.emit('exit', 3221225794)); // (0xC0000142: the process could not start properly)
    killTree(c, { run: tk.run, platform: 'win32' });
    await tick();
    check('a taskkill that exits non-zero while the child still runs: the child is killed itself', c.kills === 1, String(c.kills));
  }
  {
    const c = child(); const tk = taskkill((p) => { c.exitCode = 0; p.emit('exit', 128); }); // ("not found": it had exited already)
    killTree(c, { run: tk.run, platform: 'win32' });
    await tick();
    check('a child that exited meanwhile is left alone (taskkill "not found")', c.kills === 0, String(c.kills));
  }
  {
    const c = child(); const tk = taskkill((p) => p.emit('error', new Error('spawn taskkill ENOENT')));
    killTree(c, { run: tk.run, platform: 'win32' });
    await tick();
    check('a taskkill that cannot start: the child is killed itself', c.kills === 1, String(c.kills));
  }
  {
    const c = child();
    killTree(c, { run: () => { throw new Error('EAGAIN'); }, platform: 'win32' });
    check('a spawn that throws: the child is killed itself', c.kills === 1, String(c.kills));
  }
  {
    const c = Object.assign(child(), { exitCode: 0 }); const tk = taskkill((p) => p.emit('exit', 0));
    killTree(c, { run: tk.run, platform: 'win32' });
    check('a child that already exited asks for no taskkill', tk.calls.length === 0, JSON.stringify(tk.calls));
  }
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
