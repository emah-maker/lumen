// [usage] Settings → AI → Usage and → AI providers must agree on whether Claude Code is installed (audit #40: Usage said
// "Claude Code is not installed" while AI providers had found it). Both now ask ai/claude-code.js resolveClaude(). Plain Node, no CLI.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const cc = require('../../src/ai/claude-code');
const { createUsage } = require('../../src/features/usage');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-resolve-'));
  const fake = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(fake, '');
  const gone = path.join(dir, 'not-here');
  const newEngine = () => new cc.ClaudeCodeEngine({ userData: dir, mcpCommand: () => ({ command: 'x', args: [] }), ensureServer: () => {} });
  const keep = process.env.LUMEN_CLAUDE_BIN;

  try {
    // Nothing on disk: both say "not installed".
    process.env.LUMEN_CLAUDE_BIN = gone;
    check('no CLI: a plain look finds nothing', (await cc.resolveClaude()) === null);
    let engine = newEngine();
    check('no CLI: the engine\'s detect and resolveClaude agree (null)', (await engine.detect()) === null && (await cc.resolveClaude(engine)) === null);

    // The AI providers page cached "not found" at startup; the CLI is there now. Usage must not keep saying "not installed",
    // and the page must then agree on the next look.
    process.env.LUMEN_CLAUDE_BIN = fake;
    check('CLI installed after a cached miss: resolveClaude finds it', (await cc.resolveClaude(engine)) === fake);
    check('...and the engine remembers it, so AI providers shows the same path', (await engine.detect()) === fake && engine.bin === fake);

    // The page found it (cached); a flaky look-up must not make Usage say "not installed" while the file is still there.
    process.env.LUMEN_CLAUDE_BIN = gone;
    engine = newEngine();
    engine.bin = fake;
    check('cached path still on disk: resolveClaude returns that same path', (await cc.resolveClaude(engine)) === fake);

    // The path was deleted: both notice.
    fs.unlinkSync(fake);
    check('cached path deleted: resolveClaude refreshes and finds nothing', (await cc.resolveClaude(engine)) === null && engine.bin === null);
    fs.writeFileSync(fake, '');

    // Usage itself, fed by resolveClaude(engine) the way main.js does: the engine has the CLI, so Usage never says "not installed";
    // with nothing there it does, and the same engine says so too.
    const usageFor = (eng) => createUsage({ app: { getPath: () => dir }, showBars: () => false, cooling: () => ({}), claudeBin: () => cc.resolveClaude(eng) });
    process.env.LUMEN_CLAUDE_BIN = process.execPath; // (a runnable stand-in: it fails on the arguments, which is all Usage needs to see)
    engine = newEngine();
    engine.bin = process.execPath;
    const found = await usageFor(engine).planUsage({ refresh: true });
    check('CLI found: Usage does not say Claude Code is not installed', !/not installed/i.test(found.reason || ''), found.reason);
    process.env.LUMEN_CLAUDE_BIN = gone;
    engine = newEngine();
    const absent = await usageFor(engine).planUsage({ refresh: true });
    check('no CLI: Usage says so, as AI providers does', absent.available === false && /not installed/i.test(absent.reason) && (await engine.status()).installed === false, absent.reason);

    // And main.js really wires Usage this way (not a private look-up of its own).
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
    const wired = main.match(/const usage = createUsage\(\{[^\n]*claudeBin: ([^\n]*?), grokSession/);
    check('main.js gives Usage claudeBin from resolveClaude with the shared engine', Boolean(wired) && /resolveClaude\(agent\.engines\?\.claudecode\)/.test(wired[1]), wired && wired[1]);
  } finally {
    if (keep === undefined) delete process.env.LUMEN_CLAUDE_BIN; else process.env.LUMEN_CLAUDE_BIN = keep;
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
