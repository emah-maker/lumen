// Starts Lumen without Playwright and drives its main process over the Node inspector (--inspect=0), for suites where Playwright's own Chromium
// switches and CDP attachment get in the way (they keep hidden pages 'visible': test/video-frames.js). Same contract as electron.launch's
// app.evaluate: evaluate((electron, arg) => ..., arg) runs in the main process. The caller sets the environment (a fresh profile, a private TEMP).
const { spawn } = require('child_process');
const path = require('path');

const electronPath = (root) => require(path.join(root, 'node_modules', 'electron')); // the path string

function launch({ root, env, extraArgs, timeout = 60000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath(root), [root, '--inspect=0', ...(extraArgs || [])], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let buf = ''; let ws = null; let id = 0; const pending = new Map();
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error('inspector did not start')); }, timeout);
    const send = (method, params) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
    const app = {
      pid: child.pid,
      evaluate: async (fn, arg) => {
        const expr = `(async () => { const electron = process.mainModule.require('electron'); return (${fn.toString()})(electron, ${JSON.stringify(arg === undefined ? null : arg)}); })()`;
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      close: () => new Promise((res) => {
        const done = () => { try { child.kill(); } catch { /* gone */ } res(); };
        child.once('exit', res); try { ws.close(); } catch { /* gone */ }
        app.evaluate((e) => { e.app.exit(0); }).catch(() => {}); setTimeout(done, 3000);
      }),
    };
    child.on('exit', () => { clearTimeout(timer); for (const p of pending.values()) p.rej(new Error('exited')); });
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const m = /ws:\/\/[^\s]+/.exec(buf);
      if (m && !ws) {
        ws = new WebSocket(m[0]);
        ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); const p = pending.get(msg.id); if (p) { pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result); } };
        ws.onopen = () => { clearTimeout(timer); resolve(app); };
        ws.onerror = () => {};
      }
    });
  });
}
module.exports = { launch };
