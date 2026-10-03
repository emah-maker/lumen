// Codex CLI, plain Node (no Electron, no real Codex, nothing read from the real ~/.codex or the registry):
//  - finding it however it was installed (npm shim, standalone .exe, WinGet link and package, Store alias and package, an app folder,
//    the VS Code extension, scoop, cargo, Homebrew, an app bundle, a path the user picked) against a fake machine, and not found;
//  - running it safely (.exe straight, .cmd only through cmd.exe with checked arguments);
//  - config.toml: the lumen entry added / updated / left alone without touching the rest of the file, with a backup;
//  - what Codex reports about usage (rollout token_count events, exec turn.completed), scanning session logs, the limit state;
//  - the Settings button end to end (found, already connected, stale, added by the CLI, an old CLI, failure text, Locate...);
//  - how Lumen's usage store and the sidebar/status surfaces take Codex's numbers.
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-codex-'));

const locate = require('../src/ai/codex-locate');
const cfg = require('../src/ai/codex-config');
const cu = require('../src/ai/codex-usage');

// ---------- a fake machine ----------
// files: { absolute path: contents }; versions: { path: output of --version } (default "codex-cli 0.130.0"); a file listed in `broken` fails to run.
function machine({ platform = 'win32', files = {}, env = {}, home, registry = {}, shellPath = '', broken = [], versions = {}, appx = '' } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const norm = (p) => (platform === 'win32' ? String(p).toLowerCase() : String(p));
  const table = new Map(Object.entries(files).map(([k, v]) => [norm(k), { path: k, text: v }]));
  const calls = [];
  const kids = (dir) => {
    const prefix = norm(P.join(dir, 'x')).slice(0, -1);
    const out = new Set();
    for (const { path: full } of table.values()) if (norm(full).startsWith(prefix)) out.add(full.slice(P.join(dir, 'x').length - 1).split(/[\\/]/)[0]);
    return [...out];
  };
  const seams = {
    platform, arch: 'x64', env, homedir: home || (platform === 'win32' ? 'C:\\Users\\u' : '/Users/u'), electronPath: platform === 'win32' ? 'C:\\Lumen\\Lumen.exe' : '/Applications/Lumen.app/Contents/MacOS/Lumen',
    isFile: (p) => table.has(norm(p)),
    readdir: kids,
    readFile: (p) => (table.get(norm(p))?.text ?? null),
    realpath: (p) => p,
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file === 'reg') { const key = args[1]; return registry[key] ? { ok: true, code: 0, stdout: `\r\n${key}\r\n    Path    REG_EXPAND_SZ    ${registry[key]}\r\n`, stderr: '' } : { ok: false, code: 1, stdout: '', stderr: 'not found' }; }
      if (/powershell/i.test(file)) return { ok: true, code: 0, stdout: appx, stderr: '' };
      if (/zsh|bash|sh$/.test(file) && args[0] === '-ilc') return { ok: true, code: 0, stdout: `motd\n__LUMEN_PATH__${shellPath}__LUMEN_END__`, stderr: '' };
      const real = args[0] && /\.js$/.test(args[0]) ? args[0] : file; // node mode: the script is what is run
      if (/--version"?$/.test(args[args.length - 1])) {
        if (broken.some((b) => norm(b) === norm(real))) return { ok: false, code: 1, stdout: '', stderr: 'access denied' };
        const out = versions[real] ?? 'codex-cli 0.130.0';
        return { ok: true, code: 0, stdout: `${out}\n`, stderr: '' };
      }
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  };
  return { seams, calls };
}
const find = (m, extra = {}) => locate.locateCodex({ seams: m.seams, ...extra });
const W = 'C:\\Users\\u\\AppData\\Local';
const R = 'C:\\Users\\u\\AppData\\Roaming';
const winEnv = (PATH = 'C:\\Windows\\System32') => ({ PATH, LOCALAPPDATA: W, APPDATA: R, SystemRoot: 'C:\\Windows' });

(async () => {
  // ---------- locating: Windows ----------
  let m = machine({ files: { 'C:\\tools\\codex.exe': '' }, env: winEnv('C:\\Windows\\System32;C:\\tools') });
  let hit = await find(m);
  check('standalone codex.exe on PATH: run directly, no shell, no node', hit.found && hit.command === 'C:\\tools\\codex.exe' && hit.args.length === 0 && hit.kind === 'exe' && hit.version === '0.130.0', JSON.stringify(hit));

  const shim = `${R}\\npm`;
  m = machine({ files: { [`${shim}\\codex.cmd`]: '', [`${shim}\\node_modules\\@openai\\codex\\package.json`]: '{"bin":{"codex":"bin/codex.js"}}', [`${shim}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '' }, env: winEnv(`C:\\Windows;${shim}`) });
  hit = await find(m);
  check('npm shim (codex.cmd): the package\'s own launcher runs under node mode, never the .cmd (Node refuses .cmd without a shell)', hit.found && hit.kind === 'npm' && hit.command === 'C:\\Lumen\\Lumen.exe' && hit.env.ELECTRON_RUN_AS_NODE === '1' && hit.args[0].endsWith('bin\\codex.js') && hit.source === 'path', JSON.stringify(hit));
  m = machine({ files: { [`${shim}\\codex.cmd`]: '', [`${shim}\\node_modules\\@openai\\codex\\package.json`]: '{"bin":"bin/codex.js"}', [`${shim}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '', 'C:\\Program Files\\nodejs\\node.exe': '' }, env: winEnv(`C:\\Windows;${shim};C:\\Program Files\\nodejs`) });
  hit = await find(m);
  check('npm shim with node on PATH: runs the launcher with that node', hit.found && hit.command === 'C:\\Program Files\\nodejs\\node.exe' && !hit.env, JSON.stringify(hit));
  const vendor = `${shim}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe`;
  m = machine({ files: { [`${shim}\\codex.cmd`]: '', [`${shim}\\node_modules\\@openai\\codex\\package.json`]: '{"bin":{"codex":"bin/codex.js"}}', [`${shim}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '', [vendor]: '' }, env: winEnv(`${shim}`) });
  hit = await find(m);
  check('npm shim with the native binary in its vendor folder: that binary is run directly', hit.found && hit.command === vendor && hit.args.length === 0, JSON.stringify(hit));
  m = machine({ files: { [`${shim}\\codex.cmd`]: '' }, env: winEnv(`${shim}`) });
  hit = await find(m);
  check('an unrecognised .cmd falls back to cmd.exe (checked arguments only)', hit.found && hit.viaCmd === true && hit.command === `${shim}\\codex.cmd`, JSON.stringify(hit));

  m = machine({ files: { 'C:\\tools\\bin\\codex.exe': '' }, env: winEnv('C:\\Windows'), registry: { 'HKCU\\Environment': 'C:\\tools\\bin;%USERPROFILE%\\x', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment': '%SystemRoot%\\system32' } });
  m.seams.env.USERPROFILE = 'C:\\Users\\u';
  hit = await find(m);
  check('started from the Start menu (no shell PATH): the registry\'s user PATH is read and found there', hit.found && hit.command === 'C:\\tools\\bin\\codex.exe' && m.calls.some((c) => c[0] === 'reg' && c[2] === 'HKCU\\Environment'), JSON.stringify(hit));
  check('registry PATH values expand %VARS%, and unknown ones stay', locate.expandVars('%USERPROFILE%\\bin;%NOPE%\\x', { UserProfile: 'C:\\U' }) === 'C:\\U\\bin;%NOPE%\\x' && locate.parseRegPath('    Path    REG_SZ    C:\\a;C:\\b\r\n') === 'C:\\a;C:\\b', '');

  m = machine({ files: { [`${W}\\Microsoft\\WinGet\\Links\\codex.exe`]: '' }, env: winEnv() });
  hit = await find(m);
  check('WinGet link (not on PATH yet)', hit.found && hit.source === 'winget' && hit.command.endsWith('WinGet\\Links\\codex.exe'), JSON.stringify(hit));
  m = machine({ files: { [`${W}\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe\\codex-x86_64-pc-windows-msvc.exe`]: '', [`${W}\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe\\codex-windows-sandbox-setup.exe`]: '' }, env: winEnv() });
  hit = await find(m);
  check('WinGet package folder: the release asset named with its target triple (never the sandbox helper)', hit.found && /codex-x86_64-pc-windows-msvc\.exe$/.test(hit.command), JSON.stringify(hit));
  m = machine({ files: { [`${W}\\Microsoft\\WindowsApps\\codex.exe`]: '' }, env: winEnv() });
  hit = await find(m);
  check('Microsoft Store app execution alias', hit.found && hit.source === 'store', JSON.stringify(hit));
  m = machine({ files: { 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__abc\\app\\resources\\codex.exe': '' }, env: winEnv(), appx: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__abc\r\n' });
  hit = await find(m);
  check('Store package found by Get-AppxPackage when no alias exists', hit.found && hit.source === 'store' && m.calls.some((c) => /powershell/i.test(c[0])), JSON.stringify(hit));
  m = machine({ files: { [`${W}\\Programs\\Codex\\resources\\codex.exe`]: '' }, env: winEnv() });
  hit = await find(m);
  check('desktop app folder under %LOCALAPPDATA%\\Programs', hit.found && hit.source === 'app', JSON.stringify(hit));
  m = machine({ files: { 'C:\\Users\\u\\.vscode\\extensions\\openai.chatgpt-0.4.9\\bin\\windows-x86_64\\codex.exe': '', 'C:\\Users\\u\\.vscode\\extensions\\openai.chatgpt-0.4.10\\bin\\windows-x86_64\\codex.exe': '' }, env: winEnv() });
  hit = await find(m);
  check('VS Code extension\'s bundled binary (newest version first)', hit.found && hit.source === 'extension' && hit.command.includes('0.4.10'), JSON.stringify(hit));
  for (const [label, file, source] of [['cargo', 'C:\\Users\\u\\.cargo\\bin\\codex.exe', 'cargo'], ['scoop', 'C:\\Users\\u\\scoop\\shims\\codex.exe', 'scoop'], ['~/.codex/bin', 'C:\\Users\\u\\.codex\\bin\\codex.exe', 'standalone'], ['bun', 'C:\\Users\\u\\.bun\\bin\\codex.exe', 'bun'], ['OpenAI folder', `${W}\\OpenAI\\Codex\\codex.exe`, 'app']]) {
    hit = await find(machine({ files: { [file]: '' }, env: winEnv() }));
    check(`known folder: ${label}`, hit.found && hit.source === source && hit.command === file, JSON.stringify(hit));
  }
  m = machine({ files: { 'C:\\Users\\u\\.codex\\bin\\codex.exe': '', 'D:\\picked\\codex.exe': '' }, env: winEnv() });
  hit = await find(m, { custom: 'D:\\picked\\codex.exe' });
  check('a path the user picked wins over everything else', hit.found && hit.source === 'custom' && hit.command === 'D:\\picked\\codex.exe', JSON.stringify(hit));
  hit = await find(m, { custom: 'D:\\gone\\codex.exe' });
  check('a picked path that no longer exists falls back to the search', hit.found && hit.source === 'standalone', JSON.stringify(hit));
  m = machine({ files: { 'C:\\tools\\codex.exe': '' }, env: winEnv('C:\\tools'), versions: { 'C:\\tools\\codex.exe': 'Codex Editor 1.2.3' } });
  hit = await find(m);
  check('a different program called codex (its --version is not Codex\'s) is not accepted', !hit.found && /did not run/.test(hit.reason), JSON.stringify(hit));
  m = machine({ files: { 'C:\\tools\\codex.exe': '' }, env: winEnv('C:\\tools'), broken: ['C:\\tools\\codex.exe'] });
  hit = await find(m);
  check('a codex that fails to start says why', !hit.found && /access denied/.test(hit.reason) && /winget/.test(hit.hint), JSON.stringify(hit));
  m = machine({ files: {}, env: winEnv() });
  hit = await find(m);
  check('not found: an install hint (winget, npm, the releases page) and the links for buttons', !hit.found && /winget install OpenAI\.Codex/.test(hit.hint) && /npm install -g @openai\/codex/.test(hit.hint) && /Locate codex/.test(hit.hint) && hit.links.github.startsWith('https://github.com/openai/codex'), JSON.stringify(hit));
  m = machine({ files: { 'C:\\a\\codex.exe': '', 'C:\\b\\codex.exe': '' }, env: winEnv('C:\\a;C:\\b'), broken: ['C:\\a\\codex.exe'] });
  hit = await find(m);
  check('PATH order, and a broken first hit does not hide a working second one', hit.found && hit.command === 'C:\\b\\codex.exe', JSON.stringify(hit));
  m = machine({ files: { 'C:\\z\\codex.exe': '', 'C:\\z\\codex.cmd': '' }, env: winEnv('C:\\z') });
  check('.exe is preferred over .cmd in the same folder', (await find(m)).command === 'C:\\z\\codex.exe', '');

  // ---------- locating: macOS / Linux ----------
  const mac = (files, extra = {}) => machine({ platform: 'darwin', files, env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, ...extra });
  hit = await find(mac({ '/opt/homebrew/bin/codex': '' }));
  check('Homebrew cask (/opt/homebrew/bin), though a GUI app\'s PATH lacks it', hit.found && hit.command === '/opt/homebrew/bin/codex' && hit.source === 'homebrew', JSON.stringify(hit));
  m = mac({ '/Users/u/.volta/bin/codex': '' }, { shellPath: '/Users/u/.volta/bin:/usr/bin' });
  hit = await find(m);
  check('the login shell\'s PATH is asked (how Terminal would find it)', hit.found && hit.source === 'path' && m.calls.some((c) => c[1] === '-ilc'), JSON.stringify(hit));
  hit = await find(mac({ '/Applications/Codex.app/Contents/Resources/codex': '' }));
  check('the Codex.app bundle\'s embedded binary', hit.found && hit.source === 'app', JSON.stringify(hit));
  hit = await find(mac({ '/opt/homebrew/Caskroom/codex/0.130.0/codex-aarch64-apple-darwin': '' }));
  check('Homebrew Caskroom asset named with its target', hit.found && /Caskroom/.test(hit.command), JSON.stringify(hit));
  hit = await find(mac({ '/Users/u/.codex/bin/codex': '' }));
  check('~/.codex/bin', hit.found && hit.source === 'standalone', JSON.stringify(hit));
  hit = await find(mac({ '/Users/u/.nvm/versions/node/v22.1.0/bin/codex': '' }));
  check('nvm global bin (not on a GUI PATH)', hit.found && hit.source === 'nvm', JSON.stringify(hit));
  hit = await find(mac({ '/Users/u/Library/pnpm/codex': '' }));
  check('pnpm global dir on macOS', hit.found && hit.source === 'pnpm', JSON.stringify(hit));
  hit = await find(mac({ '/Users/u/.vscode/extensions/openai.chatgpt-0.4.1/bin/macos-aarch64/codex': '' }));
  check('Cursor/VS Code extension binary on macOS', hit.found && hit.source === 'extension', JSON.stringify(hit));
  hit = await find(mac({}));
  check('macOS not found: brew hint', !hit.found && /brew install --cask codex/.test(hit.hint), JSON.stringify(hit));
  let lin = machine({ platform: 'linux', files: { '/home/u/.npm-global/lib/node_modules/@openai/codex/bin/codex.js': '', '/home/u/.npm-global/bin/codex': '' }, home: '/home/u', env: { PATH: '/usr/bin' } });
  lin.seams.realpath = (p) => (p === '/home/u/.npm-global/bin/codex' ? '/home/u/.npm-global/lib/node_modules/@openai/codex/bin/codex.js' : p);
  hit = await find(lin);
  check('a POSIX npm symlink to the package\'s .js runs under node mode (no node on a GUI PATH)', hit.found && hit.kind === 'npm' && hit.args[0].endsWith('codex.js') && hit.env.ELECTRON_RUN_AS_NODE === '1', JSON.stringify(hit));

  // ---------- running it ----------
  let inv = locate.buildInvocation({ command: 'C:\\tools\\codex.exe', args: [] }, ['mcp', 'add', 'lumen', '--', 'C:\\Program Files\\Lumen\\Lumen.exe', 'C:\\x\\mcp.js']);
  check('an .exe is run with an argv array and no shell, spaces kept as they are', inv.file === 'C:\\tools\\codex.exe' && inv.args[4] === 'C:\\Program Files\\Lumen\\Lumen.exe' && inv.options.shell === false && !inv.options.windowsVerbatimArguments, JSON.stringify(inv));
  inv = locate.buildInvocation({ command: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd', args: [], viaCmd: true }, ['mcp', 'add', 'lumen', '--', 'C:\\Program Files\\Lumen\\Lumen.exe']);
  check('a .cmd goes through cmd.exe /d /s /c with the whole line quoted', /cmd(\.exe)?$/i.test(inv.file) && inv.args.slice(0, 3).join(' ') === '/d /s /c' && inv.args[3].startsWith('"') && inv.args[3].includes('"C:\\Program Files\\Lumen\\Lumen.exe"') && inv.options.windowsVerbatimArguments === true && inv.options.shell === false, JSON.stringify(inv));
  let threw = 0;
  for (const bad of ['a&calc', 'x"y', '%PATH%', 'a|b', 'a^b', 'a>b', 'line\nbreak']) { try { locate.buildInvocation({ command: 'C:\\n\\codex.cmd', args: [], viaCmd: true }, [bad]); } catch { threw++; } }
  check('through cmd.exe, an argument with cmd syntax is refused, never escaped', threw === 7, String(threw));
  check('the node-mode launcher keeps its script ahead of the arguments and passes its env', JSON.stringify(locate.buildInvocation({ command: 'E.exe', args: ['x.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }, ['--version']).args) === '["x.js","--version"]' && locate.buildInvocation({ command: 'E.exe', args: ['x.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }, []).options.envExtra.ELECTRON_RUN_AS_NODE === '1', '');

  // ---------- config.toml ----------
  const want = { command: 'C:\\Users\\u\\AppData\\Local\\Programs\\Lumen\\Lumen.exe', args: ['C:\\Users\\u\\AppData\\Local\\Programs\\Lumen\\resources\\app\\mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
  let r = cfg.mergeLumen('', want);
  check('empty file: the entry in the README\'s shape, paths as literal strings', r.changed && r.state === 'absent' && r.text === `[mcp_servers.lumen]\ncommand = 'C:\\Users\\u\\AppData\\Local\\Programs\\Lumen\\Lumen.exe'\nargs = ['C:\\Users\\u\\AppData\\Local\\Programs\\Lumen\\resources\\app\\mcp.js']\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`, JSON.stringify(r.text));
  const user = `# my codex config\nmodel = "gpt-5-codex"   # keep\napproval_policy = "on-request"\n\n[profiles.fast]\nmodel = "o4-mini"\n\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n\n[mcp_servers.docs.env]\nTOKEN = "secret-not-ours"\n\n[tui]\nnotifications = true\n`;
  r = cfg.mergeLumen(user, want);
  check('existing content is kept byte for byte; the entry is appended after a blank line', r.changed && r.text.startsWith(user.replace(/\n+$/, '\n\n')) && r.text.endsWith("env = { ELECTRON_RUN_AS_NODE = \"1\" }\n"), JSON.stringify(r.text.slice(-300)));
  const again = cfg.mergeLumen(r.text, want);
  check('merging again changes nothing (idempotent)', !again.changed && again.state === 'same' && again.text === r.text, again.state);
  check('state of that file: same; of the user\'s file: absent', cfg.inspect(r.text, want).state === 'same' && cfg.inspect(user, want).state === 'absent', '');
  const stale = `model = "x"\n\n[mcp_servers.lumen]\n# added by hand\nstartup_timeout_sec = 30\ncommand = 'C:\\Old\\Lumen.exe'\nargs = [\n  'C:\\Old\\mcp.js',\n]\n\n[mcp_servers.lumen.env]\nELECTRON_RUN_AS_NODE = "1"\nMY_FLAG = "yes"\n\n[tui]\nnotifications = true\n`;
  r = cfg.mergeLumen(stale, want);
  check('a moved Lumen is stale, and the update rewrites only command/args/env', cfg.inspect(stale, want).state === 'stale' && r.changed && r.state === 'stale' && r.text.includes(`command = 'C:\\Users\\u\\AppData\\Local\\Programs\\Lumen\\Lumen.exe'`) && !r.text.includes('C:\\Old') && !/\[mcp_servers\.lumen\.env\]/.test(r.text), r.text);
  check('...keeping the user\'s other keys on the entry, the comment, other env variables and the next table', r.text.includes('# added by hand') && r.text.includes('startup_timeout_sec = 30') && /env = \{[^}]*MY_FLAG = 'yes'|env = \{[^}]*MY_FLAG = "yes"/.test(r.text) && r.text.includes('[tui]\nnotifications = true') && r.text.startsWith('model = "x"\n\n[mcp_servers.lumen]'), r.text);
  check('...and the result reads as the same entry', cfg.inspect(r.text, want).state === 'same', cfg.inspect(r.text, want).state);
  const crlf = '[tui]\r\nnotifications = true\r\n';
  r = cfg.mergeLumen(crlf, want);
  check('CRLF files stay CRLF', r.text.includes('\r\n[mcp_servers.lumen]\r\ncommand') && !/[^\r]\n/.test(r.text), JSON.stringify(r.text));
  check('"enabled = false" is reported, not overridden', cfg.inspect(`[mcp_servers.lumen]\ncommand = '${want.command}'\nargs = ['${want.args[0]}']\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nenabled = false\n`, want).state === 'disabled', '');
  check('basic-string quoting with backslashes and quotes round-trips', (() => { const w = { command: 'C:\\a\'b\\L.exe', args: ['x "y"'], env: { ELECTRON_RUN_AS_NODE: '1' } }; const t = cfg.mergeLumen('', w).text; return cfg.inspect(t, w).state === 'same' && t.includes('"'); })(), '');
  for (const [label, text] of [['an inline mcp_servers table', 'mcp_servers = { lumen = { command = "x" } }\n'], ['dotted keys', 'mcp_servers.lumen.command = "x"\n'], ['an inline lumen', '[mcp_servers]\nlumen = { command = "x" }\n'], ['a duplicated entry', '[mcp_servers.lumen]\ncommand="a"\n[mcp_servers.lumen]\ncommand="b"\n']]) {
    const x = cfg.mergeLumen(text, want);
    check(`a form it cannot edit safely is refused untouched: ${label}`, x.state === 'unsupported' && !x.changed && x.text === text, x.state);
  }
  check('a [[mcp_servers]]-like array of tables or other servers named lumen-x do not count as lumen', cfg.inspect('[mcp_servers.lumen-x]\ncommand = "a"\n', want).state === 'absent', '');

  const home = path.join(tmp, 'codex-home');
  const file = path.join(home, 'config.toml');
  check('CODEX_HOME decides the folder; else ~/.codex', cfg.configPath({ CODEX_HOME: home }, '/h') === file && cfg.configPath({}, path.join(tmp, 'h')) === path.join(tmp, 'h', '.codex', 'config.toml'), '');
  let w = cfg.applyToFile(file, want);
  check('no config.toml yet: it is created (folder too), nothing to back up', w.ok && w.changed && !w.backup && fs.readFileSync(file, 'utf8').startsWith('[mcp_servers.lumen]'), JSON.stringify(w));
  fs.writeFileSync(file, user);
  w = cfg.applyToFile(file, want, { now: () => new Date('2026-10-03T10:00:00Z') });
  const siblings = fs.readdirSync(home);
  check('an existing file is backed up first, byte for byte, then replaced', w.ok && w.changed && path.basename(w.backup) === 'config.toml.lumen-20261003T100000.bak' && fs.readFileSync(w.backup, 'utf8') === user && fs.readFileSync(file, 'utf8').startsWith(user.replace(/\n+$/, '\n\n')) && !siblings.some((n) => n.endsWith('-tmp')), JSON.stringify(siblings));
  w = cfg.applyToFile(file, want);
  check('already current: not rewritten and no new backup', w.ok && !w.changed && fs.readdirSync(home).filter((n) => n.endsWith('.bak')).length === 1, JSON.stringify(w));
  fs.writeFileSync(file, 'mcp_servers = {}\n');
  w = cfg.applyToFile(file, want);
  check('an unsupported file is not written, and the error says what to do', !w.ok && /by hand/.test(w.error) && fs.readFileSync(file, 'utf8') === 'mcp_servers = {}\n', JSON.stringify(w));
  for (let i = 0; i < 5; i++) { fs.writeFileSync(file, `model = "m${i}"\n`); cfg.applyToFile(file, { ...want, command: `C:\\L${i}.exe` }, { now: () => new Date(Date.UTC(2026, 9, 3, 10, 0, i)) }); }
  check('only the newest three backups are kept', fs.readdirSync(home).filter((n) => n.endsWith('.bak')).length === 3, fs.readdirSync(home).join());
  check('a file that is not there reads as absent', cfg.stateOfFile(path.join(tmp, 'nope', 'config.toml'), want).state === 'absent', '');

  // ---------- usage: what Codex reports ----------
  const AT = '2026-10-03T14:00:00.000Z';
  const NOWMS = Date.parse(AT) + 60e3;
  const reset5 = Math.floor((Date.parse(AT) + 2 * 3600e3) / 1000);
  const resetW = Math.floor((Date.parse(AT) + 4 * 86400e3) / 1000);
  const tc = (extra = {}, ts = AT) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 30000, cached_input_tokens: 24000, output_tokens: 1200, reasoning_output_tokens: 300, total_tokens: 31200 }, last_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 5200 }, model_context_window: 272000 }, rate_limits: { limit_id: 'codex', primary: { used_percent: 41.6, window_minutes: 300, resets_at: reset5 }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: resetW }, plan_type: 'plus', rate_limit_reached_type: null }, ...extra } });
  let ev = cu.fromRolloutLine(tc());
  check('rollout token_count: totals split into input / cached / output (input includes cached: no double count)', ev.total.inputTokens === 6000 && ev.total.cacheReadTokens === 24000 && ev.total.outputTokens === 1200 && ev.total.reasoningTokens === 300 && ev.last.outputTokens === 200 && ev.contextWindow === 272000 && ev.total.costUSD === 0, JSON.stringify(ev));
  check('rollout token_count: the 5-hour and weekly windows, reset times in ms, plan', ev.limits.primary.percent === 41.6 && ev.limits.primary.minutes === 300 && ev.limits.primary.resetsAt === reset5 * 1000 && ev.limits.secondary.minutes === 10080 && ev.limits.planType === 'plus' && ev.limits.reached === false, JSON.stringify(ev.limits));
  const older = cu.fromRolloutLine(tc({ rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 600 }, secondary: null } }));
  check('an older build\'s resets_in_seconds is counted from the event time', older.limits.primary.resetsAt === Date.parse(AT) + 600e3 && older.limits.secondary === null, JSON.stringify(older.limits));
  check('an API-key run (rate_limits null) has tokens and no limits; not a token_count is ignored', cu.fromRolloutLine(tc({ rate_limits: null })).limits === null && cu.fromRolloutLine({ type: 'event_msg', payload: { type: 'agent_message', message: 'secret' } }) === null && cu.fromRolloutLine({ type: 'response_item' }) === null && cu.fromRolloutLine(null) === null, '');
  check('a window at 100% (or a reached type) is the limit-reached state, with its reset time', (() => { const l = cu.fromRolloutLine(tc({ rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: reset5 }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: resetW }, rate_limit_reached_type: 'rate_limit_reached' } })).limits; const lr = cu.limitReached(l, NOWMS); return l.reached && lr && lr.resetsAt === reset5 * 1000 && cu.limitReached(l, reset5 * 1000 + 1) === null && cu.limitReached(ev.limits, NOWMS) === null; })(), '');
  const winds = cu.windowsOf(ev.limits);
  check('windows are told apart by their length, whichever of primary / secondary', winds.fiveHour.minutes === 300 && winds.weekly.minutes === 10080 && cu.windowsOf({ primary: { percent: 5, minutes: 10080 }, secondary: null }).weekly.minutes === 10080 && cu.windowsOf({ primary: { percent: 5, minutes: 10080 }, secondary: null }).fiveHour === null && cu.windowsOf(null).fiveHour === null, JSON.stringify(winds));
  const turn = cu.fromExecEvent({ type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 } });
  check('exec --json turn.completed -> Lumen\'s usage record shape (and no price is invented)', turn.usage.inputTokens === 315 && turn.usage.cacheReadTokens === 24448 && turn.usage.outputTokens === 122 && turn.usage.costUSD === 0, JSON.stringify(turn));
  check('exec --json: other events are ignored; a failed turn carries its message, and a usage-limit one a reset time', cu.fromExecEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }) === null && (() => { const f = cu.fromExecEvent({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 3 hours 20 minutes." } }); return /usage limit/.test(f.error) && Math.abs(f.limit.resetsAt - Date.now() - 200 * 60000) < 5000; })() && cu.fromExecEvent({ type: 'error', message: 'network down' }).limit === null, '');

  // scanning session logs in a temp CODEX_HOME
  const ch = path.join(tmp, 'scan-home');
  const day = (d) => path.join(ch, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const nowDate = new Date(NOWMS);
  fs.mkdirSync(day(nowDate), { recursive: true });
  const prompt = 'PRIVATE PROMPT TEXT api_key=sk-secret';
  const rollout = [{ timestamp: AT, type: 'session_meta', payload: { id: 'abc', cwd: 'C:\\secret\\project' } }, { timestamp: AT, type: 'event_msg', payload: { type: 'user_message', message: prompt } }, tc({}, AT), { timestamp: AT, type: 'response_item', payload: { type: 'message', content: [{ text: 'x'.repeat(300000) }] } }];
  fs.writeFileSync(path.join(day(nowDate), 'rollout-2026-10-03T14-00-00-aaaa.jsonl'), `${rollout.map((o) => JSON.stringify(o)).join('\n')}\n`);
  fs.writeFileSync(path.join(day(nowDate), 'notes.txt'), 'not a rollout');
  const scan = cu.scanSessions({ home: ch, now: NOWMS });
  check('a session log: totals (cache-split), the newest windows, read from the tail past a huge reply line', scan.sessions === 1 && scan.week.tokens === 31200 - 300 + 300 - 0 && scan.today.sessions === 1 && scan.limits.primary.percent === 41.6 && scan.limits.at === Date.parse(AT) && scan.limits.primary.expired === false, JSON.stringify(scan));
  check('privacy: the scan result holds only numbers and a plan word (no prompt, path, id or file name)', !JSON.stringify(scan).includes('PRIVATE') && !JSON.stringify(scan).includes('secret') && !JSON.stringify(scan).includes('rollout') && !JSON.stringify(scan).includes('abc'), JSON.stringify(scan));
  const later = cu.scanSessions({ home: ch, now: NOWMS + 3 * 3600e3 });
  check('a window whose reset time has passed is marked expired (no stale percentage presented as current)', later.limits.primary.expired === true && later.limits.secondary.expired === false, JSON.stringify(later.limits));
  check('no ~/.codex at all: an empty scan, no throw', cu.scanSessions({ home: path.join(tmp, 'none'), now: NOWMS }).sessions === 0, '');
  const old = new Date(NOWMS - 20 * 86400e3);
  fs.mkdirSync(day(old), { recursive: true });
  fs.writeFileSync(path.join(day(old), 'rollout-old.jsonl'), `${JSON.stringify(tc({}, '2026-09-13T10:00:00.000Z'))}\n`);
  check('sessions older than the 7 days are not counted', cu.scanSessions({ home: ch, now: NOWMS }).sessions === 1, '');

  // sign-in
  fs.writeFileSync(path.join(ch, 'auth.json'), '{"tokens":{"access_token":"SECRET-TOKEN-VALUE"}}');
  const ran = [];
  let ls = await cu.loginState({ home: ch, run: async (a) => { ran.push(a.join(' ')); return { ok: true, stdout: 'Logged in using ChatGPT\n', stderr: '' }; } });
  check('sign-in: `codex login status` says logged in with ChatGPT', ls.signedIn === true && ls.method === 'chatgpt' && ran[0] === 'login status', JSON.stringify(ls));
  ls = await cu.loginState({ home: ch, run: async () => ({ ok: false, stdout: '', stderr: 'Not logged in' }) });
  check('sign-in: "Not logged in" is signed out even though an auth.json exists', ls.signedIn === false, JSON.stringify(ls));
  ls = await cu.loginState({ home: ch, run: async () => ({ ok: false, stdout: '', stderr: "error: unrecognized subcommand 'login status'" }) });
  check('sign-in: an old CLI without `login status` falls back to the file\'s presence (contents never read)', ls.signedIn === true && ls.fromFile && !JSON.stringify(ls).includes('SECRET'), JSON.stringify(ls));
  ls = await cu.loginState({ home: path.join(tmp, 'none'), run: async () => ({ ok: false, stdout: '', stderr: 'weird' }) });
  check('sign-in: nothing to go on is "unknown", not a guess', ls.signedIn === null, JSON.stringify(ls));

  // ---------- Lumen's usage store ----------
  const U = require('../src/features/usage');
  const cs = U.codexSummary(scan, NOWMS);
  check('usage summary for Codex: windows, plan, tokens; no cost field', cs.available && cs.hasLimits && cs.planType === 'plus' && cs.fiveHour.percent === 41.6 && cs.weekly.percent === 12 && !cs.reached && cs.week.tokens > 0 && !('costUSD' in cs), JSON.stringify(cs));
  const none = U.codexSummary({ sessions: 2, today: {}, week: {}, limits: null }, NOWMS);
  check('no plan data (API-key sign-in): says so instead of inventing numbers', !none.hasLimits && /not reported plan limits|API-key/.test(none.note) && none.fiveHour === null, JSON.stringify(none));
  const bar = U.barFor('codex', { codex: cs });
  check('sidebar-style bar for Codex: a plan meter on the 5-hour window with the weekly beside it', bar.kind === 'plan' && Math.round(bar.percent) === 42 && bar.resetsAt === reset5 * 1000 && Math.round(bar.weekly.percent) === 12, JSON.stringify(bar));
  const hitScan = { ...scan, limits: { ...scan.limits, primary: { ...scan.limits.primary, percent: 100 } } };
  const barHit = U.barFor('codex', { codex: U.codexSummary(hitScan, NOWMS) });
  check('limit reached: the bar is the limit state with the reset time', barHit.kind === 'limit' && barHit.level === 'high' && barHit.resetsAt === reset5 * 1000, JSON.stringify(barHit));
  check('no reading: no bar (never a made-up percentage)', U.barFor('codex', { codex: U.codexSummary({ sessions: 1, limits: null }, NOWMS) }) === null && U.barFor('codex', {}) === null, '');
  const ud = path.join(tmp, 'userdata');
  fs.mkdirSync(ud, { recursive: true });
  let scanCalls = 0;
  let clockNow = NOWMS;
  const mk = () => U.createUsage({ app: { getPath: () => ud }, claudeBin: async () => null, now: () => clockNow, codexScan: async () => { scanCalls++; return scan; }, codexInstalled: () => true });
  const usage = mk();
  usage.load();
  let sum = await usage.summary();
  check('summary() carries Codex\'s section and its bar, scanning the logs once per 20 seconds', sum.codex.fiveHour.percent === 41.6 && sum.bars.codex.kind === 'plan' && (await usage.summary(), scanCalls === 1), JSON.stringify(sum.codex));
  check('the home status card\'s glance has the Codex 5-hour reading, and a limit when one is reached', usage.glance(NOWMS).codexMeter.percent === 41.6 && usage.glance(NOWMS).codexLimit === null, '');
  await new Promise((res) => setTimeout(res, 900));
  const saved = JSON.parse(fs.readFileSync(path.join(ud, 'usage.json'), 'utf8'));
  check('persisted in usage.json as numbers only (same store, same privacy)', saved.codex && saved.codex.scan.limits.primary.percent === 41.6 && !JSON.stringify(saved).includes('PRIVATE') && !JSON.stringify(saved).includes('secret') && !/[A-Za-z]:\\\\/.test(JSON.stringify(saved.codex)), JSON.stringify(saved.codex).slice(0, 400));
  const reloaded = mk();
  reloaded.load();
  check('a restart keeps the last Codex reading', reloaded.glance(NOWMS).codexMeter?.percent === 41.6, '');
  usage.record('codex', { usage: cu.fromExecEvent({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } }).usage, rateLimit: cu.limitsOf({ primary: { used_percent: 100, window_minutes: 300, resets_at: reset5 } }) });
  sum = await usage.summary();
  check('a Lumen-driven Codex turn is counted as Codex (tokens, no cost) and cannot move Claude\'s 5-hour meter', sum.lumen.byEngine.codex.turns === 1 && sum.lumen.byEngine.codex.costUSD === 0 && sum.meter === null && sum.codex.reached, JSON.stringify({ e: sum.lumen.byEngine, m: sum.meter }));
  usage.clear();
  check('clearing the usage log clears the Codex reading too', usage.glance(NOWMS).codexMeter === null, '');

  // ---------- the Settings button, end to end ----------
  const { createCodexConnect } = require('../src/features/codex-connect');
  const cHome = path.join(tmp, 'connect-home');
  fs.mkdirSync(cHome, { recursive: true });
  const cfgFile = path.join(cHome, 'config.toml');
  const lumenCmd = () => ({ command: 'C:\\Lumen\\Lumen.exe', args: ['C:\\Lumen\\resources\\app\\mcp.js'] });
  const harness = ({ files = { 'C:\\tools\\codex.exe': '' }, cli = {}, settings = {}, sender = true, pick } = {}) => {
    const handlers = {};
    const state = { settings: { ...settings }, connected: [], ran: [] };
    const mach = machine({ files, env: winEnv('C:\\tools') });
    const connect = createCodexConnect({
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
      readSettings: () => state.settings, writeSettings: (s) => { state.settings = s; },
      mcpCommand: lumenCmd, connected: (id) => state.connected.push(id), isSettingsSender: () => sender, pickFile: pick,
      seams: mach.seams, env: { CODEX_HOME: cHome }, homedir: path.join(tmp, 'h'),
      execFile: (file, args, opts, cb) => {
        state.ran.push({ file, args, opts });
        const argv = args.join(' ');
        const answer = Object.entries(cli).find(([k]) => argv.startsWith(k))?.[1] ?? { err: 'unexpected', stderr: `unexpected ${argv}` };
        if (argv === '--version') { cb(null, 'codex-cli 0.130.0\n', ''); return; }
        cb(answer.err ? new Error(answer.err) : null, answer.stdout || '', answer.stderr || '');
      },
    });
    return { connect, handlers, state, mach };
  };
  fs.rmSync(cfgFile, { force: true });
  let h = harness({ cli: { 'mcp get': { err: 'no such server', stderr: 'No MCP server named lumen' }, 'mcp add': { stdout: 'Added global MCP server lumen.' } } });
  let res = await h.connect.add();
  const addRun = h.state.ran.find((x) => x.args[0] === 'mcp' && x.args[1] === 'add');
  check('Add (standalone codex.exe, not in config): `codex mcp add lumen --env … -- <Lumen> <mcp.js>` as an argv array, no shell', res.ok && !res.already && addRun.file === 'C:\\tools\\codex.exe' && addRun.args.join('|') === 'mcp|add|lumen|--env|ELECTRON_RUN_AS_NODE=1|--|C:\\Lumen\\Lumen.exe|C:\\Lumen\\resources\\app\\mcp.js' && addRun.opts.shell === false && h.state.connected[0] === 'codex', JSON.stringify({ res, addRun }));
  fs.writeFileSync(cfgFile, `[mcp_servers.lumen]\ncommand = '${lumenCmd().command}'\nargs = ['${lumenCmd().args[0]}']\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`);
  h = harness();
  res = await h.connect.add();
  check('Add when config.toml already has the current entry: "Already connected", no CLI call to add', res.ok && res.already && res.text === 'Already connected' && !h.state.ran.some((x) => x.args.includes('add')), JSON.stringify(res));
  fs.writeFileSync(cfgFile, `# mine\n[mcp_servers.lumen]\ncommand = 'C:\\Old\\Lumen.exe'\nargs = ['C:\\Old\\mcp.js']\n`);
  h = harness();
  res = await h.connect.add();
  const after = fs.readFileSync(cfgFile, 'utf8');
  check('Add when Lumen moved: the entry is updated in place, a backup kept, the comment kept', res.ok && /Updated Lumen/.test(res.text) && /backup: config\.toml\.lumen-/.test(res.text) && after.startsWith('# mine\n') && after.includes('C:\\Lumen\\Lumen.exe') && !after.includes('C:\\Old') && fs.readdirSync(cHome).some((n) => n.endsWith('.bak')), res.text + after);
  fs.writeFileSync(cfgFile, 'model = "x"\n');
  h = harness({ cli: { 'mcp get': { err: 'x' }, 'mcp add': { err: 'Command failed', stderr: '\u001b[31merror: unrecognized subcommand \'add\'\u001b[0m\n\nUsage: codex [OPTIONS]\n' } } });
  res = await h.connect.add();
  check('Add with an old CLI (no `mcp add`): the entry is written to config.toml with a backup', res.ok && /Added to .*config\.toml/.test(res.text) && cfg.stateOfFile(cfgFile, { ...lumenCmd(), env: { ELECTRON_RUN_AS_NODE: '1' } }).state === 'same' && fs.readFileSync(cfgFile, 'utf8').startsWith('model = "x"\n'), res.text);
  fs.writeFileSync(cfgFile, 'mcp_servers = {}\n');
  h = harness({ cli: { 'mcp get': { err: 'x' }, 'mcp add': { err: 'Command failed', stderr: 'Error: config.toml is read-only (managed by your organisation)\nline2\nline3\nline4\n' } } });
  res = await h.connect.add();
  check('Add that fails: the real stderr, trimmed to its last lines, not a generic message', !res.ok && /managed by your organisation/.test(res.text) && !/\u001b/.test(res.text) && res.text.length <= 300, res.text);
  h = harness({ files: {} });
  res = await h.connect.add();
  check('Add with no Codex: not found, the install hint with winget/npm/releases, links for the buttons', !res.ok && res.notFound && /winget install OpenAI\.Codex/.test(res.text) && /Locate codex/.test(res.text) && /github\.com\/openai\/codex/.test(res.links.github), JSON.stringify(res));
  fs.writeFileSync(cfgFile, `[mcp_servers.lumen]\ncommand = '${lumenCmd().command}'\nargs = ['${lumenCmd().args[0]}']\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nenabled = false\n`);
  h = harness();
  res = await h.connect.add();
  check('Add when Lumen is switched off in Codex\'s config: tells the user, does not flip it', !res.ok && /enabled = false/.test(res.text), res.text);
  // the .cmd route through cmd.exe passes the Lumen path with spaces intact
  fs.rmSync(cfgFile, { force: true });
  const sp = `${R}\\npm`;
  h = harness({ files: { [`${sp}\\codex.cmd`]: '' }, cli: { 'mcp get': { err: 'x' }, 'mcp add': { stdout: 'ok' } } });
  h.mach.seams.env.PATH = sp;
  res = await h.connect.add();
  const cmdRun = h.state.ran.find((x) => /mcp add/.test(x.args.join(' ')));
  check('Add with only an unrecognised codex.cmd: via cmd.exe /d /s /c, verbatim line, still no shell option', res.ok && /cmd(\.exe)?$/i.test(cmdRun.file) && cmdRun.opts.windowsVerbatimArguments === true && cmdRun.opts.shell === false && cmdRun.args[3].includes('mcp add lumen'), JSON.stringify(cmdRun));

  // status: found / signed in / connected
  fs.writeFileSync(path.join(cHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-DO-NOT-LEAK"}');
  fs.rmSync(cfgFile, { force: true });
  h = harness({ cli: { 'login status': { stdout: 'Logged in using ChatGPT\n' } } });
  let st = await h.handlers['codex:status']({}, true);
  check('status: installed, version, where, signed in with ChatGPT, not connected yet', st.installed && st.version === '0.130.0' && st.path === 'C:\\tools\\codex.exe' && st.signedIn === true && st.method === 'chatgpt' && st.connected === 'absent' && !JSON.stringify(st).includes('sk-DO-NOT-LEAK'), JSON.stringify(st));
  check('status feeds the sidebar/status-card facts (installed, signedIn)', h.connect.state().installed === true && h.connect.state().signedIn === true, JSON.stringify(h.connect.state()));
  h = harness({ cli: { 'login status': { err: 'exit 1', stderr: 'Not logged in' } } });
  st = await h.handlers['codex:status']({}, true);
  check('status: not signed in', st.installed && st.signedIn === false, JSON.stringify(st));
  h = harness({ files: {} });
  st = await h.handlers['codex:status']({}, true);
  check('status: not installed carries the hint and links, never throws', !st.installed && /winget/.test(st.hint) && st.links.docs, JSON.stringify(st));
  // Locate…
  h = harness({ files: {}, sender: false, pick: async () => 'D:\\x\\codex.exe' });
  let denied = false;
  try { await h.handlers['codex:locate']({}); } catch { denied = true; }
  check('"Locate codex…" answers only the Settings page', denied, '');
  h = harness({ files: { 'D:\\codex-custom\\codex.exe': '', 'D:\\other\\notcodex.exe': '' }, pick: async () => 'D:\\codex-custom\\codex.exe' });
  st = await h.handlers['codex:locate']({});
  check('Locate: a file that answers --version as Codex is used and the path saved in settings', st.installed && st.source === 'custom' && st.custom === true && h.state.settings.codexPath === 'D:\\codex-custom\\codex.exe', JSON.stringify(st));
  st = await h.handlers['codex:locate']({}, true);
  check('Locate: "use automatic detection" forgets the saved path', h.state.settings.codexPath === undefined && !st.custom, JSON.stringify(st));
  h = harness({ files: { 'D:\\other\\notcodex.exe': '' }, pick: async () => 'D:\\other\\notcodex.exe' });
  h.mach.seams.exec = async (file, args) => (args[args.length - 1] === '--version' ? { ok: true, code: 0, stdout: 'something else 1.0\n', stderr: '' } : { ok: false, code: 1, stdout: '', stderr: '' });
  st = await h.handlers['codex:locate']({});
  check('Locate: a file that is not Codex is refused and nothing is saved', /Nothing was saved/.test(st.rejected) && h.state.settings.codexPath === undefined, JSON.stringify(st));
  h = harness({ files: {}, pick: async () => null });
  st = await h.handlers['codex:locate']({});
  check('Locate: cancelling the picker changes nothing', st.canceled === true && h.state.settings.codexPath === undefined, JSON.stringify(st));

  // ---------- the wiring ----------
  const agents = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'ai-agents.js'), 'utf8');
  check('ai-agents.js: the Codex button uses codex-connect, not the npm-only finder; the terminal snippet no longer assumes codex.cmd', /codexConnect\.add\(\)/.test(agents) && !/findCli\('codex'/.test(agents) && !/'codex\.cmd' : 'codex'/.test(agents), '');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check('main.js: codex: channels are Settings-page-only (PRIVILEGED_IPC)', /PRIVILEGED_IPC = \/\^\([^)]*\bcodex\b/.test(mainSrc), '');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nAll Codex checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
