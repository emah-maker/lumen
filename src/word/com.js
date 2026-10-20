// [word] The Windows side: Word's COM automation through one hidden PowerShell (host.ps1), started on the first call and ended after a quiet
// spell, so nothing costs anything until the AI first uses the word tool. It reuses the desktop helper's process client (src/desktop/client.js:
// JSON lines over stdin / stdout, a time limit on every call, no shell, a script file named by its content, explicit powershell.exe through
// ai/cli-utils.js). A call is a command name and a plain object: nothing the AI or a document says is ever put into a script or a command line.
'use strict';

const path = require('path');

const SCRIPT = path.join(__dirname, 'host.ps1');
const IDLE_MS = 120e3;
const START_MS = 30e3; // PowerShell's own cold start can take a while on a busy machine
const CALL_MS = 40e3;
const LONG_MS = 90e3; // opening and saving big documents

// deps (tests pass fakes): client (a stand-in for the process client), platform, test ({ hidden, fresh, test }: the helper's test seam), spawn.
function createWordHost(deps = {}) {
  const platform = deps.platform || process.platform;
  let client = deps.client || null;
  const getClient = () => {
    if (client) return client;
    const lib = require('../desktop/client');
    const seam = deps.test ? { LUMEN_WORD_TEST: '1', ...(deps.test.hidden ? { LUMEN_WORD_HIDDEN: '1' } : {}), ...(deps.test.fresh ? { LUMEN_WORD_NEW: '1' } : {}) } : {};
    const realSpawn = deps.spawn || ((...a) => require('../ai/cli-utils').spawn(...a));
    client = lib.createClient({
      platform,
      idleMs: IDLE_MS, startMs: START_MS, testRun: false,
      scriptFile: () => lib.scriptFile({ script: SCRIPT, name: 'word' }),
      spawn: (file, args, opts) => realSpawn(file, args, { ...opts, env: { ...process.env, ...(opts?.env || {}), ...seam } }),
    });
    return client;
  };
  let installed = null; // cached answer of the first status call

  async function call(cmd, args = {}, ms = CALL_MS) {
    if (platform !== 'win32') throw Object.assign(new Error('Using Word works on Windows for now.'), { unavailable: true });
    return getClient().call(cmd, args, { timeoutMs: ms });
  }

  return {
    // { installed, running } (the helper starts for this; PowerShell's cold start is the only cost)
    async status() { const r = await call('status'); installed = r.installed === true; return { installed, running: r.running === true }; },
    installed: () => installed,
    list: () => call('list'),
    open: (a) => call('open', a, LONG_MS),
    new: (a) => call('new', a, LONG_MS),
    read: (a) => call('read', a),
    insert: (a) => call('insert', a),
    replace: (a) => call('replace', a),
    style: (a) => call('style', a),
    table: (a) => call('table', a, LONG_MS),
    image: (a) => call('image', a, LONG_MS),
    comment: (a) => call('comment', a),
    track: (a) => call('track', a),
    save: (a) => call('save', a, LONG_MS),
    saveAs: (a) => call('save_as', a, LONG_MS),
    show: (a) => call('show', a),
    frame: (a) => call('frame', a, 15e3), // the card's live picture of Word's window
    peek: (a) => call('peek', a), // the paragraphs around the last change, for the page preview
    raw: call,
    alive: () => Boolean(client?.alive?.()),
    stop: () => { try { client?.stop?.(); } catch { /* not running */ } },
    destroy: () => { try { client?.destroy?.(); } catch { /* not running */ } },
  };
}

module.exports = { createWordHost, SCRIPT, IDLE_MS };
