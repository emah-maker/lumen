// Finding OpenAI's Codex CLI however it was installed, and running it safely.
//
// Codex ships many ways: npm (`npm i -g @openai/codex`: a codex.cmd shim on Windows), a standalone
// codex.exe (GitHub releases, `winget install OpenAI.Codex`, scoop, the Microsoft Store alias), the VS Code /
// Cursor extension's bundled binary, the Codex desktop app, Homebrew (`brew install --cask codex`), cargo.
// Lumen is usually started from the Start menu / Finder, which does not hand it the shell's PATH, so
// this also reads the machine + user PATH from the registry (Windows) and asks the login shell (macOS/Linux).
//
// Everything that touches the machine goes through `seams` (fs, env, exec, registry, shell PATH) so
// test/codex-units.js can run every install layout without a real Codex.
//
//   locateCodex(options)         -> { found: true, command, args, env?, path, kind, version, source } | { found: false, ... }
//   buildInvocation(spec, argv)  -> { file, args, options } to hand to execFile / spawn, never through a shell string
//   installHint(platform)        -> the text shown when Codex isn't found
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const INSTALL_LINKS = {
  github: 'https://github.com/openai/codex/releases/latest',
  docs: 'https://developers.openai.com/codex/cli',
};

function installHint(platform = process.platform) {
  const how = platform === 'win32'
    ? 'winget install OpenAI.Codex  (or: npm install -g @openai/codex)'
    : platform === 'darwin'
      ? 'brew install --cask codex  (or: npm install -g @openai/codex)'
      : 'npm install -g @openai/codex  (or download it from the GitHub releases)';
  return `Codex CLI wasn't found. Install it with: ${how}, or download it from ${INSTALL_LINKS.github}. If it is installed somewhere unusual, choose "Locate codex…" and pick codex${platform === 'win32' ? '.exe' : ''}.`;
}

// ---------- seams ----------
const realSeams = () => ({
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  homedir: os.homedir(),
  // A file (a Windows app-execution alias is a reparse point that stat can refuse: lstat sees it).
  isFile: (p) => {
    try { return fs.statSync(p).isFile(); } catch {}
    try { const st = fs.lstatSync(p); return st.isFile() || st.isSymbolicLink(); } catch { return false; }
  },
  readdir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
  exec: (file, args, { timeout = 8000, env, windowsVerbatimArguments } = {}) => new Promise((resolve) => {
    try {
      execFile(file, args, { shell: false, windowsHide: true, timeout, env: env || process.env, maxBuffer: 1 << 20, ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (err) { resolve({ ok: false, code: -1, stdout: '', stderr: err.message }); }
  }),
});

// ---------- PATH ----------
// "%USERPROFILE%\bin;%SystemRoot%" with the variables filled in (unknown ones are left as they are).
function expandVars(text, env) {
  const lower = {};
  for (const [k, v] of Object.entries(env || {})) lower[k.toLowerCase()] = v;
  return String(text || '').replace(/%([^%;]+)%/g, (whole, name) => (lower[name.toLowerCase()] != null ? lower[name.toLowerCase()] : whole));
}
// `reg query` output: "    Path    REG_EXPAND_SZ    C:\a;%SystemRoot%\b"
function parseRegPath(out) {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(String(out || ''));
  return m ? m[1].trim() : '';
}
async function registryPath(seams) {
  const keys = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'];
  const parts = [];
  for (const key of keys) {
    const r = await seams.exec('reg', ['query', key, '/v', 'Path'], { timeout: 5000 });
    if (r.ok) parts.push(expandVars(parseRegPath(r.stdout), seams.env));
  }
  return parts.join(';');
}
// macOS / Linux: the login shell's PATH (what Terminal would give `codex`).
async function loginShellPath(seams) {
  const shell = seams.env.SHELL && path.isAbsolute(seams.env.SHELL) ? seams.env.SHELL : '/bin/zsh';
  const r = await seams.exec(shell, ['-ilc', 'printf "__LUMEN_PATH__%s__LUMEN_END__" "$PATH"'], { timeout: 5000 });
  return /__LUMEN_PATH__(.*?)__LUMEN_END__/s.exec(r.stdout || '')?.[1] || '';
}
const splitPath = (text, platform) => String(text || '').split(platform === 'win32' ? ';' : ':').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);

// ---------- candidates ----------
const join = (platform, ...parts) => (platform === 'win32' ? path.win32.join(...parts) : path.posix.join(...parts));
const exeNames = (platform) => (platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex']);
// Release assets keep their target triple in the name (codex-x86_64-pc-windows-msvc.exe, codex-aarch64-apple-darwin);
// winget / brew link them as plain `codex`.
const TRIPLE_NAME = /^codex-(x86_64|aarch64)-(pc-windows-msvc\.exe|apple-darwin|unknown-linux-(gnu|musl))$/i;
const HELPER = /sandbox|setup|command-runner|updater|uninstall/i;
const byVersionDesc = (a, b) => b.localeCompare(a, undefined, { numeric: true });

// Every plausible location, in the order they are tried: [{ file, source }].
// `dirs` are filled in by callers (PATH); the rest is the install layouts listed in the header.
function knownLocations(seams) {
  const { platform, env, homedir, readdir } = seams;
  const j = (...p) => join(platform, ...p);
  const out = [];
  const add = (file, source) => out.push({ file, source });
  const addDir = (dir, source, names = exeNames(platform)) => { for (const n of names) add(j(dir, n), source); };
  const addTriple = (dir, source) => { for (const f of readdir(dir)) if (TRIPLE_NAME.test(f) && !HELPER.test(f)) add(j(dir, f), source); };

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || j(homedir, 'AppData', 'Local');
    const roaming = env.APPDATA || j(homedir, 'AppData', 'Roaming');
    addDir(j(local, 'Microsoft', 'WinGet', 'Links'), 'winget');
    const pkgRoot = j(local, 'Microsoft', 'WinGet', 'Packages');
    for (const pkg of readdir(pkgRoot).filter((n) => /^OpenAI\.Codex/i.test(n)).sort(byVersionDesc)) { addDir(j(pkgRoot, pkg), 'winget'); addTriple(j(pkgRoot, pkg), 'winget'); }
    addDir(j(local, 'Microsoft', 'WindowsApps'), 'store'); // the Store app's execution alias
    for (const app of readdir(j(local, 'Programs')).filter((n) => /codex|openai/i.test(n))) {
      const base = j(local, 'Programs', app);
      for (const sub of ['', 'bin', 'resources', j('resources', 'bin'), j('app', 'resources'), j('app', 'resources', 'bin')]) { addDir(j(base, sub), 'app'); addTriple(j(base, sub), 'app'); }
    }
    for (const vendor of readdir(j(local, 'OpenAI'))) {
      const base = j(local, 'OpenAI', vendor);
      for (const sub of ['', 'bin', 'resources', j('resources', 'bin')]) { addDir(j(base, sub), 'app'); addTriple(j(base, sub), 'app'); }
    }
    addDir(j(local, 'OpenAI'), 'app');
    addDir(j(homedir, '.codex', 'bin'), 'standalone');
    addDir(j(homedir, '.cargo', 'bin'), 'cargo');
    addDir(j(homedir, 'scoop', 'shims'), 'scoop');
    if (env.SCOOP) addDir(j(env.SCOOP, 'shims'), 'scoop');
    if (env.SCOOP_GLOBAL) addDir(j(env.SCOOP_GLOBAL, 'shims'), 'scoop');
    if (env.ProgramData) addDir(j(env.ProgramData, 'scoop', 'shims'), 'scoop');
    addDir(j(roaming, 'npm'), 'npm');
    if (env.NPM_CONFIG_PREFIX) addDir(env.NPM_CONFIG_PREFIX, 'npm');
    if (env.npm_config_prefix) addDir(env.npm_config_prefix, 'npm');
    if (env.PNPM_HOME) addDir(env.PNPM_HOME, 'pnpm');
    addDir(j(local, 'pnpm'), 'pnpm');
    addDir(env.BUN_INSTALL ? j(env.BUN_INSTALL, 'bin') : j(homedir, '.bun', 'bin'), 'bun');
    addDir(env.VOLTA_HOME ? j(env.VOLTA_HOME, 'bin') : j(local, 'Volta', 'bin'), 'volta');
    const fnm = env.FNM_DIR || j(local, 'fnm');
    for (const v of readdir(j(fnm, 'node-versions')).sort(byVersionDesc)) addDir(j(fnm, 'node-versions', v, 'installation'), 'fnm');
    addDir(env.NVM_SYMLINK || 'C:\\nvm4w\\nodejs', 'nvm');
    addDir(j(env.ProgramFiles || 'C:\\Program Files', 'nodejs'), 'npm');
    extensionBinaries(seams, add);
    return out;
  }

  // macOS + Linux
  const bin = (d, source) => addDir(d, source);
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin']) bin(d, 'homebrew');
  if (platform === 'darwin') {
    for (const dir of [j(homedir, 'Applications'), '/Applications']) {
      for (const app of readdir(dir).filter((n) => /^Codex.*\.app$/i.test(n))) {
        for (const sub of [j('Contents', 'Resources'), j('Contents', 'Resources', 'bin'), j('Contents', 'MacOS'), j('Contents', 'Frameworks')]) { addDir(j(dir, app, sub), 'app'); addTriple(j(dir, app, sub), 'app'); }
      }
    }
    for (const root of ['/opt/homebrew/Caskroom/codex', '/usr/local/Caskroom/codex']) {
      for (const v of readdir(root).sort(byVersionDesc)) { addDir(j(root, v), 'homebrew'); addTriple(j(root, v), 'homebrew'); }
    }
  }
  bin(j(homedir, '.codex', 'bin'), 'standalone');
  bin(j(homedir, '.codex'), 'standalone');
  bin(j(homedir, '.local', 'bin'), 'standalone');
  bin(j(homedir, '.cargo', 'bin'), 'cargo');
  bin(env.BUN_INSTALL ? j(env.BUN_INSTALL, 'bin') : j(homedir, '.bun', 'bin'), 'bun');
  bin(env.VOLTA_HOME ? j(env.VOLTA_HOME, 'bin') : j(homedir, '.volta', 'bin'), 'volta');
  bin(env.PNPM_HOME || j(homedir, platform === 'darwin' ? j('Library', 'pnpm') : j('.local', 'share', 'pnpm')), 'pnpm');
  bin(j(homedir, '.npm-global', 'bin'), 'npm');
  if (env.NPM_CONFIG_PREFIX) bin(j(env.NPM_CONFIG_PREFIX, 'bin'), 'npm');
  for (const v of readdir(j(homedir, '.nvm', 'versions', 'node')).sort(byVersionDesc)) bin(j(homedir, '.nvm', 'versions', 'node', v, 'bin'), 'nvm');
  const fnmDir = env.FNM_DIR || (platform === 'darwin' ? j(homedir, 'Library', 'Application Support', 'fnm') : j(homedir, '.local', 'share', 'fnm'));
  for (const v of readdir(j(fnmDir, 'node-versions')).sort(byVersionDesc)) bin(j(fnmDir, 'node-versions', v, 'installation', 'bin'), 'fnm');
  if (platform === 'linux') bin('/usr/bin', 'system');
  extensionBinaries(seams, add);
  return out;
}

// The OpenAI extension for VS Code / Cursor / Windsurf bundles the binary: <editor>/extensions/openai.chatgpt-<ver>/bin/<os-arch>/codex[.exe]
function extensionBinaries(seams, add) {
  const { platform, homedir, readdir } = seams;
  const j = (...p) => join(platform, ...p);
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.vscode-oss']) {
    const root = j(homedir, editor, 'extensions');
    for (const ext of readdir(root).filter((n) => /^openai\.chatgpt-/i.test(n)).sort(byVersionDesc)) {
      const bins = j(root, ext, 'bin');
      for (const sub of readdir(bins)) add(j(bins, sub, exeNames(platform)[0]), 'extension');
      add(j(bins, exeNames(platform)[0]), 'extension');
    }
  }
}

// ---------- turning a found file into something runnable ----------
// A npm shim: codex.cmd next to node_modules/@openai/codex. The package's own bin is a small JS launcher that
// starts the native binary kept in the platform package's vendor folder; run that binary directly if it is
// there (no node, no cmd.exe), else the JS under node, else (last resort) cmd.exe.
function npmShimTarget(cmdPath, seams) {
  const { platform } = seams;
  const j = (...p) => join(platform, ...p);
  const dir = path.dirname(cmdPath);
  const pkgDir = j(dir, 'node_modules', '@openai', 'codex');
  const pkgJson = seams.readFile(j(pkgDir, 'package.json'));
  if (!pkgJson) return null;
  let pkg;
  try { pkg = JSON.parse(pkgJson); } catch { return null; }
  // The native binary: vendor/<triple>/codex/codex[.exe] inside the package or its optional platform package.
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const roots = [pkgDir, ...seams.readdir(j(pkgDir, 'node_modules', '@openai')).map((n) => j(pkgDir, 'node_modules', '@openai', n))];
  for (const root of roots) {
    for (const tri of seams.readdir(j(root, 'vendor'))) {
      for (const sub of [j('codex', exe), exe]) {
        const hit = j(root, 'vendor', tri, sub);
        if (seams.isFile(hit)) return { native: hit };
      }
    }
  }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && (pkg.bin.codex || Object.values(pkg.bin)[0]));
  const entry = bin && j(pkgDir, bin);
  return entry && seams.isFile(entry) ? { js: entry } : null;
}

async function nodeCommand(seams) {
  // Prefer a real node on PATH; with none, Lumen's own Electron in Node mode runs the script.
  const names = seams.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of seams.searchDirs || []) for (const n of names) { const f = join(seams.platform, dir, n); if (seams.isFile(f)) return { command: f, args: [] }; }
  return { command: seams.electronPath || process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// { command, args, env?, kind } for a file, or null when it cannot be run.
async function specFor(file, seams) {
  const ext = path.extname(file).toLowerCase();
  if (seams.platform === 'win32') {
    if (ext === '.exe') return { command: file, args: [], kind: 'exe' };
    if (ext === '.cmd' || ext === '.bat') {
      const target = npmShimTarget(file, seams);
      if (target?.native) return { command: target.native, args: [], kind: 'npm' };
      if (target?.js) { const node = await nodeCommand(seams); return { ...node, args: [target.js], kind: 'npm' }; }
      return { command: file, args: [], kind: 'cmd', viaCmd: true }; // run through cmd.exe, see buildInvocation
    }
    return null;
  }
  const real = seams.realpath(file);
  if (/\.(c|m)?js$/i.test(real)) { const node = await nodeCommand(seams); return { ...node, args: [real], kind: 'npm' }; }
  return { command: file, args: [], kind: 'exe' };
}

// How to run `spec` with `argv`. cmd.exe is only used for a .cmd/.bat we could not resolve any other way,
// and every argument must then be free of characters cmd.exe treats as syntax (the arguments are Lumen's own
// fixed words and paths, never page or model text); otherwise it is refused rather than escaped.
const CMD_UNSAFE = /["%^&|<>!\r\n\0]/;
function buildInvocation(spec, argv = []) {
  if (!spec?.command) throw new Error('No Codex command.');
  const all = [...(spec.args || []), ...argv];
  if (!spec.viaCmd) return { file: spec.command, args: all, options: { shell: false, windowsHide: true, ...(spec.env ? { envExtra: spec.env } : {}) } };
  const parts = [spec.command, ...all];
  if (parts.some((p) => CMD_UNSAFE.test(String(p)))) throw new Error('That argument cannot be passed safely through cmd.exe. Install Codex as a standalone codex.exe instead (winget install OpenAI.Codex).');
  const quote = (p) => (/[\s()]/.test(p) || p === '' ? `"${p}"` : p);
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${parts.map((p) => quote(String(p))).join(' ')}"`], options: { shell: false, windowsHide: true, windowsVerbatimArguments: true } };
}

const VERSION_RE = /codex(?:-cli)?[ \t]+v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/i;
// `codex --version` -> "codex-cli 0.130.0". Anything else on that command (a different "codex" tool) is not accepted.
async function verify(spec, seams) {
  let inv;
  try { inv = buildInvocation(spec, ['--version']); } catch (err) { return { ok: false, error: err.message }; }
  const env = inv.options.envExtra ? { ...seams.env, ...inv.options.envExtra } : undefined;
  const r = await seams.exec(inv.file, inv.args, { timeout: 8000, env, windowsVerbatimArguments: inv.options.windowsVerbatimArguments });
  const text = `${r.stdout}\n${r.stderr}`;
  const m = r.ok ? VERSION_RE.exec(text) : null;
  return m ? { ok: true, version: m[1] } : { ok: false, error: (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0].slice(0, 160) };
}

// ---------- the search ----------
// options: { custom (a path the user picked), seams (tests) , skipSlow (no AppX query) }
async function locateCodex(options = {}) {
  const seams = { ...realSeams(), ...(options.seams || {}) };
  const { platform, env } = seams;
  const tried = [];
  const seen = new Set();
  const key = (f) => (platform === 'win32' ? f.toLowerCase() : f);
  let failure = null;

  const attempt = async (file, source) => {
    if (!file || seen.has(key(file))) return null;
    seen.add(key(file));
    if (!seams.isFile(file)) return null;
    tried.push(file);
    const spec = await specFor(file, seams);
    if (!spec) return null;
    const v = await verify(spec, seams);
    if (!v.ok) { failure ||= { file, error: v.error }; return null; }
    return { found: true, ...spec, path: file, source, version: v.version };
  };

  // 1. the path the user chose, then the override the tests and power users set
  for (const [file, source] of [[options.custom, 'custom'], [env.LUMEN_CODEX_BIN, 'env']]) {
    if (!file) continue;
    const hit = await attempt(file, source);
    if (hit) return hit;
  }

  // 2. PATH: this process's, plus the registry's / login shell's (a GUI launch lacks them)
  const dirs = [];
  const addDirs = (text) => { for (const d of splitPath(text, platform)) if (!dirs.some((x) => key(x) === key(d))) dirs.push(d); };
  addDirs(env.PATH || env.Path || '');
  const extra = platform === 'win32' ? await registryPath(seams).catch(() => '') : await loginShellPath(seams).catch(() => '');
  addDirs(extra);
  seams.searchDirs = dirs;
  for (const d of dirs) for (const n of exeNames(platform)) {
    const hit = await attempt(join(platform, d, n), 'path');
    if (hit) return hit;
  }

  // 3. where each installer puts it
  for (const { file, source } of knownLocations(seams)) {
    const hit = await attempt(file, source);
    if (hit) return hit;
  }

  // 4. the Microsoft Store package, by name (slow: only when nothing else answered)
  if (platform === 'win32' && !options.skipSlow) {
    const r = await seams.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage -Name "*Codex*").InstallLocation'], { timeout: 12000 });
    const roots = r.ok ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z]:\\/i.test(l)) : [];
    for (const root of roots) for (const sub of ['', 'app', 'bin', 'resources', 'app\\resources']) {
      const hit = await attempt(join(platform, root, sub, 'codex.exe'), 'store');
      if (hit) return hit;
    }
  }

  return {
    found: false,
    reason: failure ? `Found ${failure.file} but it did not run: ${failure.error}` : options.custom ? `The Codex you chose (${options.custom}) is not there any more.` : null,
    custom: Boolean(options.custom),
    hint: installHint(platform),
    links: INSTALL_LINKS,
  };
}

module.exports = { locateCodex, buildInvocation, installHint, specFor, verify, knownLocations, parseRegPath, expandVars, splitPath, registryPath, loginShellPath, npmShimTarget, INSTALL_LINKS, VERSION_RE };
