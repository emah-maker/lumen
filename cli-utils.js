// Shared by every place that shells out to a user-installed CLI (claude-code.js, grok-build.js,
// features/ai-agents.js's "Add to <agent>" buttons): finding a binary on PATH and stopping a child
// process tree. Kept pure and CLI-agnostic — install hints, auth parsing, argv shape, etc. stay in
// each engine, since those really do differ per CLI.
const { spawn, execFile } = require('child_process');
const fs = require('fs');

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Where on PATH a command lives (`where` on Windows, `which` elsewhere). Never a shell.
function lookup(name) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [name], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? [] : String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
}

// Stop a CLI child (and whatever it spawned under it, e.g. an MCP bridge) started with detached:true
// (POSIX) — taskkill /T on Windows since detached there doesn't give a killable process group.
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

module.exports = { exists, lookup, killTree };
