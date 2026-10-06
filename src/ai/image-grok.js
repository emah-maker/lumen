// Pictures from Grok Build's own image_gen / image_edit tools, through the user's own `grok` sign-in (their SuperGrok plan: no API key, no
// per-picture charge). One headless run per picture in a fresh temporary folder, with only that one tool allowed (no shell, no file
// tools, so nothing else can run), sandboxed to the folder. Grok writes the picture into its session folder (~/.grok/sessions/<folder>/
// <session>/images/N.jpg); that file is read back and the temporary folder removed. The user's sign-in is never read or copied here.
//
//   generate({ bin, prompt, source, signal, ... }) -> { images: [{ data (base64), alt }], model: 'image_gen' | 'image_edit', said }
//   findNewImage(home, since)                      the newest picture Grok wrote into its sessions folder after `since`

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: realSpawn } = require('child_process');
const genImages = require('../features/gen-images');

const TIMEOUT_MS = 180000;
const REFUSAL = /polic(?:y|ies)|moderat|safety|guideline|can(?:'|’)?t (?:create|generate|make|help)|cannot (?:create|generate|make|help)|unable to (?:create|generate|make)|not able to (?:create|generate|make)|decline|against my|violates?/i;

const grokHome = () => process.env.GROK_HOME || path.join(os.homedir(), '.grok');
const IMG = /\.(?:png|jpe?g|webp|gif)$/i;

// The newest picture under <home>/sessions/*/*/images written at or after `since` (ms). { file, mtimeMs } | null
function findNewImage(home, since, fsImpl = fs) {
  let best = null;
  const list = (dir) => { try { return fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  const root = path.join(home, 'sessions');
  for (const folder of list(root)) {
    if (!folder.isDirectory()) continue;
    for (const session of list(path.join(root, folder.name))) {
      if (!session.isDirectory()) continue;
      const dir = path.join(root, folder.name, session.name, 'images');
      for (const f of list(dir)) {
        if (!f.isFile() || !IMG.test(f.name)) continue;
        const file = path.join(dir, f.name);
        let st; try { st = fsImpl.statSync(file); } catch { continue; }
        if (st.mtimeMs >= since && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs };
      }
    }
  }
  return best;
}

// Runs `grok` once. bin: the grok executable (ai/grok-build.js findGrok). source: { buffer, mime } to edit. `spawn`, `home` and `tmpRoot` are
// there for tests.
// userData: Lumen's profile folder. With it the run gets a GROK_HOME of its own (<userData>/grok-image) that names no MCP servers and
// imports nothing from the user's other tools, with only the sign-in linked in (as ai/cli-json.js does for its one-shot answers).
// Without it Grok would read the user's own ~/.grok/config.toml and ~/.claude.json: their `lumen` MCP entry connects to Lumen as an
// outside agent (which opens an agent window for it) and their other servers slow the start. (`home` / `env` are for tests.)
const IMAGE_CONFIG = [
  '# Written by Lumen before each Grok Build picture (ai/image-grok.js). Edits are overwritten.',
  ...['claude', 'cursor'].flatMap((v) => [`[compat.${v}]`, ...['skills', 'rules', 'agents', 'mcps', 'hooks'].map((s) => `${s} = false`), '']),
  '[cli]', 'auto_update = false', '',
  '[marketplace]', 'default_skills_installs_purged = true', 'official_marketplace_auto_installed = true', '',
].join('\n');
const imageHomeFor = (userData) => path.join(userData, 'grok-image');

async function generate({ bin, prompt, source = null, signal, spawn = realSpawn, home = grokHome(), tmpRoot = os.tmpdir(), timeoutMs = TIMEOUT_MS, userData = null }) {
  if (!bin) throw Object.assign(new Error('Grok Build is not installed.'), { imageApi: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'lumen-grok-image-'));
  const tool = source ? 'image_edit' : 'image_gen';
  let env;
  let userHome = null;
  let authBefore = null;
  if (userData) {
    const gb = require('./grok-build');
    home = imageHomeFor(userData);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'config.toml'), IMAGE_CONFIG, { mode: 0o600 });
    userHome = gb.userGrokHome();
    try { authBefore = gb.linkAuth(userHome, home); } catch { /* no login shared: the run reports "not signed in" */ }
    env = { ...gb.buildEnv({ userData, home, dir }), RUST_LOG: 'off' };
  }
  try {
    let ask = String(prompt).replace(/[\r\n]+/g, ' ').slice(0, 2000);
    if (source) {
      const name = `source.${source.mime === 'image/jpeg' ? 'jpg' : source.mime.split('/')[1] || 'png'}`;
      fs.writeFileSync(path.join(dir, name), source.buffer);
      ask = `${name}: ${ask}`;
    }
    const since = Date.now() - 1000;
    const argv = ['--cwd', dir, '--permission-mode', 'acceptEdits', '--allow', tool, '--sandbox', 'workspace', '-p', `Use ${tool}: ${ask}. Do not run any other tool.`];
    const { code, out, err } = await new Promise((resolve, reject) => {
      let child;
      try { child = spawn(bin, argv, { shell: false, windowsHide: true, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) }); } catch (e) { reject(e); return; }
      let out = '';
      let err = '';
      const cap = (s) => s.slice(-20000);
      child.stdout?.on('data', (c) => { out = cap(out + c); });
      child.stderr?.on('data', (c) => { err = cap(err + c); });
      const stop = () => { try { child.kill(); } catch { /* gone */ } };
      const timer = setTimeout(() => { stop(); reject(Object.assign(new Error('Grok Build took too long to make the picture.'), { code: 'ETIMEDOUT', imageApi: true })); }, timeoutMs);
      const onAbort = () => { stop(); reject(Object.assign(new Error('Stopped by the user.'), { name: 'AbortError' })); };
      if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (c) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ code: c, out, err }); });
    });
    const found = findNewImage(home, since);
    const buffer = found ? fs.readFileSync(found.file) : null;
    if (buffer && buffer.length <= genImages.MAX_BYTES && genImages.sniff(buffer)) {
      return { images: [{ data: buffer.toString('base64'), alt: String(prompt).slice(0, 300) }], model: tool, said: '' };
    }
    const text = `${out}\n${err}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const line = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 400);
    const error = new Error(line || `Grok Build made no picture${code ? ` (exit ${code})` : ''}.`);
    error.imageApi = true;
    if (code === 0 && REFUSAL.test(line)) error.policy = true; // it answered in words instead of drawing: its own refusal
    throw error;
  } finally {
    if (userHome) { try { require('./grok-build').settleAuth(userHome, home, authBefore); } catch { /* the token copy-back is best effort */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
  }
}

module.exports = { generate, findNewImage, grokHome, imageHomeFor, IMAGE_CONFIG };
