// Nothing an AI engine does may pop a window up on the user's screen, or make Lumen treat its own engine as an outside agent.
// Plain Node: no Electron, no network, no CLI.
//  - Grok Build's one-shot picture run (ai/image-grok.js) runs in a GROK_HOME of Lumen's own: with the user's ~/.grok it loaded their
//    `lumen` MCP entry, which connected to Lumen as an outside agent and opened an agent window for it;
//  - every process an engine or one-shot starts is started with windowsHide: true (no console window);
//  - the picture path never opens the picture (shell.openPath / openExternal) nor makes a window or a tab.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = JSON.stringify;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const SRC = path.join(__dirname, '..', 'src');

(async () => {
  // ---- 1. the one-shot picture run does not read the user's Grok / Claude setup
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sbu-'));
    const userHome = path.join(tmp, 'user-grok');
    fs.mkdirSync(userHome, { recursive: true });
    fs.writeFileSync(path.join(userHome, 'auth.json'), '{"fake":true}');
    fs.writeFileSync(path.join(userHome, 'config.toml'), '[mcp_servers.lumen]\ncommand = "lumen-bridge"\n');
    process.env.GROK_HOME = userHome; // the user's own ~/.grok, as findGrok / userGrokHome see it
    const userData = path.join(tmp, 'profile');
    const imageGrok = require('../src/ai/image-grok');
    let seen = null;
    const { EventEmitter } = require('events');
    const spawn = (_bin, argv, opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      seen = { argv, opts, config: fs.readFileSync(path.join(opts.env.GROK_HOME, 'config.toml'), 'utf8'), authLinked: fs.existsSync(path.join(opts.env.GROK_HOME, 'auth.json')) };
      setImmediate(() => {
        const dir = path.join(opts.env.GROK_HOME, 'sessions', 'f', 's', 'images');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '1.png'), PNG);
        child.emit('close', 0);
      });
      return child;
    };
    const made = await imageGrok.generate({ bin: 'grok', prompt: 'a red fox', tmpRoot: tmp, spawn, userData });
    check('picture run: made and read back from its own home', made.images.length === 1 && made.images[0].data === PNG.toString('base64'), J(made));
    check('picture run: GROK_HOME is Lumen\'s own folder, never the user\'s ~/.grok', seen && path.resolve(seen.opts.env.GROK_HOME) === path.resolve(imageGrok.imageHomeFor(userData)) && path.resolve(seen.opts.env.GROK_HOME) !== path.resolve(userHome), seen?.opts.env.GROK_HOME);
    check('picture run: its config names no MCP server and imports none of the user\'s tools', seen && !/\[mcp_servers/.test(seen.config) && /\[compat\.claude\][\s\S]*mcps = false/.test(seen.config) && /\[compat\.cursor\][\s\S]*mcps = false/.test(seen.config), seen?.config);
    check('picture run: the sign-in is still there (linked into its home)', seen?.authLinked === true, J(seen && seen.authLinked));
    check('picture run: the process is started hidden, with only image_gen allowed', seen?.opts.windowsHide === true && seen.argv[seen.argv.indexOf('--allow') + 1] === 'image_gen', J(seen?.opts));
    check('picture run: Grok\'s imports of Claude / Cursor MCP servers are off in its environment too', seen?.opts.env.GROK_CLAUDE_MCPS_ENABLED === '0' && seen.opts.env.GROK_CURSOR_MCPS_ENABLED === '0', J(seen?.opts.env && { c: seen.opts.env.GROK_CLAUDE_MCPS_ENABLED, u: seen.opts.env.GROK_CURSOR_MCPS_ENABLED }));
    check('picture run: the user\'s own config is untouched', fs.readFileSync(path.join(userHome, 'config.toml'), 'utf8').includes('lumen-bridge'));
  }

  // ---- 2. every process an engine or one-shot starts is hidden
  {
    // Calls that must pass windowsHide: true. (Not covered: a launcher that must show Lumen itself, the macOS-only helpers, a fork with no console.)
    const OK_WITHOUT = new Set(['automation/mcp.js', 'automation/launcher.js', 'features/swap-helper.js', 'features/updates.js', 'features/translate-local.js', 'browser/importer.js']);
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/vendor|renderer|assets|locales/.test(e.name)) walk(p); } else if (e.name.endsWith('.js') && !e.name.endsWith('.bundle.js')) files.push(p); } };
    walk(path.join(SRC, 'ai')); walk(path.join(SRC, 'features')); walk(path.join(SRC, 'automation')); walk(path.join(SRC, 'browser'));
    const callRe = /(?<![\w.$])(?:this\.|engine\.|seams\.|child_process\.|require\('child_process'\)\.|cp\.)?(spawn|spawnSync|execFile|execFileSync)\(/g;
    const bad = [];
    let seenCalls = 0;
    for (const file of files) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(callRe)) {
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        if (/\b(?:function|async)\s+$|=>\s*$|const\s+\w+\s*=\s*$/.test(before)) continue; // a definition, not a call
        if (/^\s*\/\//.test(text.slice(text.lastIndexOf('\n', m.index) + 1, m.index))) continue; // a comment
        let depth = 0; let i = m.index + m[0].length - 1; const start = i;
        for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; }
        const call = text.slice(start, i + 1);
        seenCalls++;
        if (/windowsHide:\s*true/.test(call) || /windowsHide/.test(call) && /\.\.\./.test(call)) continue;
        if (OK_WITHOUT.has(rel)) continue;
        bad.push(`${rel}:${text.slice(0, m.index).split('\n').length} ${call.slice(0, 90).replace(/\s+/g, ' ')}`);
      }
    }
    check('every spawn / execFile in the engines and one-shots passes windowsHide: true', seenCalls > 15 && bad.length === 0, J({ seenCalls, bad }));
  }

  // ---- 3. the picture path never opens the picture or makes a window or a tab
  {
    const files = ['ai/image-grok.js', 'ai/image-router.js', 'features/gen-images.js', 'ai/agy-tools.js'].filter((f) => fs.existsSync(path.join(SRC, f)));
    const hits = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      for (const re of [/openPath/, /openExternal/, /showItemInFolder/, /new BrowserWindow/, /createWindow/, /openTab\(/, /agentWindows/, /shell\./]) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    check('the picture path (image-grok, image-router, gen-images) never opens a file, a window or a tab', files.length >= 3 && hits.length === 0, J(hits));
  }

  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
