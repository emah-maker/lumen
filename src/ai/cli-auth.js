// Sign in to Claude with Anthropic's CLI (`ant auth login`) instead of pasting an API key.
// The CLI stores an OAuth profile under %APPDATA%\Anthropic (~/.config/anthropic elsewhere), and
// the Anthropic SDK picks that profile up automatically when no API key is configured.
// If `ant` isn't on PATH, it can be installed into the app's data folder from the official GitHub
// release, with the download checked against the release's SHA-256 checksums.
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Anthropic publishes checksums but no signatures or build attestations for the CLI, so the app
// pins a known-good version and its SHA-256 digests. A replaced release (checksums file included)
// is rejected; updating the CLI means updating this table in a new app version.
const PINNED_VERSION = '1.35.0';
const PINNED_SHA256 = {
  windows_amd64: 'd5285ebca93619c279113a726ca5d0e63379c5ebf8b02ecd79d36a094f10288c',
  windows_arm64: '5a439ccbdf38e86e7acb9c028aa1f533cf75718874860b428e87235a384fa12a',
  windows_386: '1fbf2e7b2d9f20976bc0d2ef5d525fdf375d6753c4499b5a11ff00a13337d2a0',
  macos_amd64: 'c0284fbbbaed8c4f2f4c53479f0b36530bad7c146434a0bf08cb3002779d465a',
  macos_arm64: '39cabc03346a84ee8ca7da2a754f4f0b1dd31cf86848a65fdcda7066955982ab',
  linux_amd64: 'a861a51f62f70f5f6a136dddffc9fe4d9708807a25a24595ce9d640d88361308',
  linux_arm64: '5e53cb7953a8f92fd5cee47960d520765a532f2bafa7c9ff4c4312045d1f6265',
};
const exeName = process.platform === 'win32' ? 'ant.exe' : 'ant';

const configDir = () => process.env.ANTHROPIC_CONFIG_DIR
  || (process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Anthropic') : path.join(os.homedir(), '.config', 'anthropic'));

// Environment for the CLI: an API key would shadow the profile, so leave keys out.
function cliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function run(file, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { env: cliEnv(), timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Anthropic's CLI prints "ant version 1.35.0"; Apache Ant (also "ant" on PATH) prints something else.
async function isAnthropicCli(file) {
  const base = path.basename(file).toLowerCase();
  if (process.platform === 'win32' ? base !== 'ant.exe' : base !== 'ant') return false; // not ant.bat / ant.cmd / others
  const v = await run(file, ['--version'], 8000);
  return v.ok && /^ant version \d+\.\d+/m.test(v.stdout);
}

// Anthropic's `ant` on PATH, else the copy installed into binDir.
async function findAnt(binDir) {
  const local = path.join(binDir, exeName);
  if (fs.existsSync(local) && await isAnthropicCli(local)) return local;
  const probe = await run(process.platform === 'win32' ? 'where' : 'which', ['ant'], 5000);
  for (const candidate of (probe.ok ? probe.stdout.split(/\r?\n/) : []).map((l) => l.trim()).filter(Boolean)) {
    if (fs.existsSync(candidate) && await isAnthropicCli(candidate)) return candidate;
  }
  return null;
}

// Asks the CLI itself whether the active profile has usable credentials (catches expired logins).
async function verifyLogin(ant) {
  const status = await run(ant, ['auth', 'status'], 15000);
  if (!status.ok) return false;
  const text = status.stdout + status.stderr;
  // `ant auth status` prints a "Credentials" section; when signed out it holds only a
  // "(profile … not configured …)" note. Signed in means that section has real content.
  const section = text.match(/^Credentials\s*$([\s\S]*?)(?:^\S|$(?![\s\S]))/m)?.[1] || '';
  const lines = section.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  return !lines.some((l) => /not configured|expired|invalid|no credentials|run `ant auth login`/i.test(l));
}

function platformKey() {
  const osName = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch];
  const key = osName && arch ? `${osName}_${arch}` : null;
  if (!key || !PINNED_SHA256[key]) throw new Error(`No Anthropic CLI build for ${process.platform}/${process.arch}.`);
  return key;
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'lumen-browser' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Installs the pinned `ant` into binDir. Returns its path.
async function installAnt(binDir) {
  const key = platformKey();
  const name = `ant_${PINNED_VERSION}_${key}.${key.startsWith('linux') ? 'tar.gz' : 'zip'}`;
  const suffix = key.startsWith('linux') ? '.tar.gz' : '.zip';
  const archive = await download(`https://github.com/anthropics/anthropic-cli/releases/download/v${PINNED_VERSION}/${name}`);
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== PINNED_SHA256[key]) throw new Error('The Anthropic CLI download does not match the version this app trusts. Nothing was installed.');
  const asset = { name };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ant-'));
  try {
    const file = path.join(work, asset.name);
    fs.writeFileSync(file, archive);
    const extract = process.platform === 'win32'
      ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${work.replace(/'/g, "''")}' -Force`], 60000)
      : await run(suffix.endsWith('.zip') ? 'unzip' : 'tar', suffix.endsWith('.zip') ? ['-o', file, '-d', work] : ['-xzf', file, '-C', work], 60000);
    if (!extract.ok) throw new Error(`Could not unpack the Anthropic CLI: ${extract.stderr.trim() || extract.code}`);
    const found = [work, ...fs.readdirSync(work).map((n) => path.join(work, n))].map((d) => path.join(d, exeName)).find((p) => fs.existsSync(p));
    if (!found) throw new Error('The Anthropic CLI archive did not contain the program.');
    fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(binDir, exeName);
    fs.copyFileSync(found, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
    const check = await run(target, ['--version'], 15000);
    if (!check.ok) throw new Error('The Anthropic CLI was installed but Windows would not run it.');
    return target;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Which profile the CLI uses, and whether it has credentials. The model picker asks on every
// settings read, and each answer reads two files, so it's kept for two seconds; sign-in and
// sign-out here clear it (freshProfileState), so they show at once.
let profileCache = null;
function profileState() {
  if (profileCache && Date.now() - profileCache.at < 2000) return profileCache.state;
  const state = readProfileState();
  profileCache = { at: Date.now(), state };
  return state;
}
function freshProfileState() {
  profileCache = null;
  return profileState();
}
function readProfileState() {
  const dir = configDir();
  let profile = process.env.ANTHROPIC_PROFILE || 'default';
  try {
    const active = fs.readFileSync(path.join(dir, 'active_config'), 'utf8').trim();
    if (active && !process.env.ANTHROPIC_PROFILE) profile = active;
  } catch {
    // No active profile set: the CLI falls back to "default".
  }
  const credentials = path.join(dir, 'credentials', `${profile}.json`);
  // Signed in only when the file holds a token (not just exists).
  let hasToken = false;
  try {
    const data = JSON.parse(fs.readFileSync(credentials, 'utf8'));
    // The exact field names are the CLI's business; an empty or placeholder file doesn't count.
    hasToken = Boolean(data && typeof data === 'object' && Object.values(data).some((v) => v && (typeof v !== 'string' || v.length > 8)));
  } catch {
    hasToken = false;
  }
  return { profile, signedIn: hasToken, configDir: dir };
}

// Opens the browser sign-in and waits for it to finish. The CLI itself waits up to 5 minutes; this
// gives up a little after that, and cancelLogin() (the Cancel button) ends it at once.
const LOGIN_TIMEOUT_MS = 6 * 60 * 1000;
let loginChild = null;
let loginCancelled = false;
function login(ant) {
  return new Promise((resolve) => {
    const child = spawn(ant, ['auth', 'login'], { env: cliEnv(), windowsHide: true });
    loginChild = child;
    loginCancelled = false;
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, LOGIN_TIMEOUT_MS);
    const done = (result) => { clearTimeout(timer); if (loginChild === child) loginChild = null; resolve(result); };
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', (err) => done({ ok: false, message: err.message }));
    child.on('close', (code) => {
      if (loginCancelled) return done({ ok: false, cancelled: true, message: 'Sign-in was canceled.' });
      if (timedOut) return done({ ok: false, message: 'Sign-in timed out. Try again.' });
      done({ ok: code === 0 && freshProfileState().signedIn, message: output.trim().split(/\r?\n/).slice(-3).join(' ') });
    });
  });
}

function cancelLogin() {
  if (!loginChild) return false;
  loginCancelled = true;
  loginChild.kill();
  return true;
}

async function logout(ant) {
  const result = await run(ant, ['auth', 'logout'], 15000);
  profileCache = null;
  return { ok: result.ok, message: (result.stdout + result.stderr).trim() };
}

module.exports = { findAnt, installAnt, profileState, freshProfileState, login, cancelLogin, logout, verifyLogin, configDir, PINNED_VERSION };
