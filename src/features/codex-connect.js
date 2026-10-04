// Settings → AI → "Add to Codex CLI" and the Codex row's status: Codex is found however it was installed
// (ai/codex-locate.js: npm, standalone .exe, winget, Store alias, Homebrew, an app bundle, a path the user picked),
// connected by `codex mcp add` (or, for an older CLI and for a moved Lumen, by merging one entry into
// config.toml with a backup: ai/codex-config.js), and its sign-in is asked of the CLI itself.
// Lumen never reads auth.json's contents; it only learns whether the CLI says it is logged in.
//
// deps: { ipcMain, readSettings, writeSettings, mcpCommand, connected(id), isSettingsSender(event), pickFile?, seams? (tests),
//         platform?, env?, homedir?, execFile? }
const os = require('os');
const path = require('path');
const { execFile: realExecFile } = require('child_process');
const locate = require('../ai/codex-locate');
const config = require('../ai/codex-config');
const codexUsage = require('../ai/codex-usage');

function createCodexConnect(deps) {
  const { ipcMain, readSettings, writeSettings } = deps;
  const env = () => deps.env || process.env;
  const home = () => deps.homedir || os.homedir();
  const exec = deps.execFile || realExecFile;
  let found = false;
  let signedIn = 'unknown'; // true | false | 'unknown'
  let lookup = null;

  function find(refresh = false) {
    if (!refresh && lookup) return lookup;
    lookup = locate.locateCodex({ custom: readSettings().codexPath || null, seams: deps.seams }).then((info) => {
      found = Boolean(info.found);
      return info;
    }, (err) => { found = false; return { found: false, reason: err.message, hint: locate.installHint(), links: locate.INSTALL_LINKS }; });
    return lookup;
  }

  // Runs the found codex with argv: an array, never a shell string; a .cmd shim only through cmd.exe, with checked arguments.
  const runner = (spec) => (argv) => new Promise((resolve) => {
    let inv;
    try { inv = locate.buildInvocation(spec, argv); } catch (err) { resolve({ ok: false, out: err.message, stdout: '', stderr: err.message }); return; }
    const childEnv = { ...env(), ...(inv.options.envExtra || {}) };
    exec(inv.file, inv.args, { shell: false, windowsHide: true, timeout: 30000, cwd: home(), env: childEnv, ...(inv.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) }, (err, stdout, stderr) => {
      const clean = (t) => String(t || '').replace(/\x1b\[[0-9;]*m/g, '');
      resolve({ ok: !err, stdout: clean(stdout), stderr: clean(stderr), out: `${clean(stdout)}${clean(stderr)}`.trim() });
    });
  });
  const codexHome = () => config.codexHome(env(), home());
  const configFile = () => config.configPath(env(), home());
  // The first lines of a failure's output, for the user (ANSI already removed): the error comes first, clap's usage text after it is dropped.
  const trimmed = (text) => String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^(usage:|for more information|tip:)/i.test(l)).slice(0, 3).join(' ').slice(0, 300);
  // Codex stops a stdio server that has not started in 10 s and a tool call that has not answered in 60 s (config.toml's defaults):
// Lumen's bridge may have to start Lumen, and its approval card waits for the user, so both are raised (ai/codex-config.js).
const TIMEOUTS = { startup_timeout_sec: 30, tool_timeout_sec: 600 };
const desired = () => { const { command, args } = deps.mcpCommand(); return { command, args, env: { ELECTRON_RUN_AS_NODE: '1' }, timeouts: TIMEOUTS }; };

  async function status(refresh) {
    const spec = await find(refresh);
    const state = config.stateOfFile(configFile(), desired());
    if (!spec.found) {
      signedIn = 'unknown';
      return { installed: false, signedIn: 'unknown', connected: state.state, reason: spec.reason || null, hint: spec.hint, links: spec.links, custom: Boolean(readSettings().codexPath) };
    }
    const login = await codexUsage.loginState({ home: codexHome(), run: runner(spec) });
    signedIn = login.signedIn === null ? 'unknown' : login.signedIn;
    return { installed: true, path: spec.path, version: spec.version, source: spec.source, signedIn, method: login.method || null, connected: state.state, custom: spec.source === 'custom', links: locate.INSTALL_LINKS };
  }

  // The one-click button.
  async function add() {
    const spec = await find(true);
    if (!spec.found) return { ok: false, notFound: true, text: [spec.reason, spec.hint].filter(Boolean).join(' '), links: spec.links };
    const run = runner(spec);
    const want = desired();
    const { command, args } = want;
    const file = configFile();
    const st = config.stateOfFile(file, want);
    const done = (text, extra = {}) => { deps.connected('codex'); return { ok: true, text, ...extra }; };
    if (st.state === 'same') return done('Already connected', { already: true });
    if (st.state === 'disabled') return { ok: false, text: `Lumen is in Codex's config (${file}) but switched off with enabled = false. Remove that line to use it.` };
    const wroteText = (verb, w) => `${verb} ${file}${w.backup ? ` (backup: ${path.basename(w.backup)})` : ''}. Start a new Codex session to use Lumen.`;
    if (st.state === 'stale') { // Lumen moved or was updated since it was added
      const wrote = config.applyToFile(file, want);
      return wrote.ok ? done(wroteText('Updated Lumen’s entry in', wrote)) : { ok: false, text: wrote.error };
    }
    // absent (or a file we can't edit): the CLI knows every config layer (CODEX_HOME, managed config), so it goes first.
    const got = await run(['mcp', 'get', 'lumen']);
    if (got.ok && got.out.includes(args[0])) return done('Already connected', { already: true });
    const added = await run(['mcp', 'add', 'lumen', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', command, ...args]);
    if (added.ok) {
      // `codex mcp add` writes no timeouts: the entry it made gets them (a failure here leaves a working entry on Codex's defaults).
      const raised = config.applyToFile(file, want);
      return done(raised.ok && raised.changed ? wroteText('Added to', raised) : 'Added. Start a new Codex session to use Lumen.');
    }
    if (st.state !== 'absent') return { ok: false, text: trimmed(added.out) || 'Codex could not add Lumen.' };
    // An older CLI without `mcp add`: write the entry ourselves (a backup of config.toml is kept).
    const wrote = config.applyToFile(file, want);
    if (wrote.ok) return done(wroteText('Added to', wrote));
    return { ok: false, text: `${trimmed(added.out) || 'Codex could not add Lumen.'} ${wrote.error || ''}`.trim() };
  }

  async function pick(event) {
    if (deps.pickFile) return deps.pickFile();
    const { dialog, BrowserWindow } = require('electron');
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender) || undefined, {
      title: 'Locate codex', properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Codex', extensions: ['exe', 'cmd', 'bat'] }, { name: 'All files', extensions: ['*'] }] : undefined,
    });
    return r.canceled ? null : r.filePaths[0];
  }
  // "Locate codex…": the user picks the file; it is kept only if it answers --version as Codex. clear = forget the saved path.
  async function locatePicked(event, clear) {
    if (!deps.isSettingsSender?.(event)) throw new Error('Not allowed');
    if (clear) { const next = { ...readSettings() }; delete next.codexPath; writeSettings(next); return status(true); }
    const picked = await pick(event);
    if (!picked) return { ...(await status(false)), canceled: true };
    const tried = await locate.locateCodex({ custom: picked, seams: deps.seams, skipSlow: true });
    if (!tried.found || tried.source !== 'custom') return { ...(await status(false)), rejected: `That file didn’t answer "--version" like Codex${tried.reason ? ` (${tried.reason})` : ''}. Nothing was saved.` };
    writeSettings({ ...readSettings(), codexPath: picked });
    return status(true);
  }

  ipcMain?.handle('codex:status', (_e, refresh) => status(Boolean(refresh)).then((r) => { try { deps.onStatus?.(r); } catch { /* optional */ } return r; }).catch((err) => ({ installed: false, signedIn: 'unknown', reason: err.message, hint: locate.installHint(), links: locate.INSTALL_LINKS })));
  ipcMain?.handle('codex:locate', (e, clear) => locatePicked(e, Boolean(clear)));

  return { find, status, add, locatePicked, state: () => ({ installed: found, signedIn }), codexHome };
}

module.exports = { createCodexConnect };
