// Pictures from Antigravity (agy), through the user's own Google sign-in (no API key). One headless run per picture in a fresh
// temporary folder: `agy --sandbox --mode accept-edits --add-dir <folder> --print-timeout 3m -p "Generate an image: … Save to <file>."`,
// never --always-approve or --dangerously-skip-permissions. The run gets a home of its own (<userData>/antigravity-image, like the one-shot
// home in ai/cli-json.js): a settings.json that denies commands, URLs and MCP tools and trusts only the temporary folder, and no
// mcp_config.json, so the user's own servers (Lumen's among them) are not started. The sign-in stays in the OS keyring. The picture is
// read back from the folder (it must exist and be a real png/jpeg/webp/gif) and the folder removed.
//
//   generate({ bin, prompt, source, signal, userData, ... }) -> { images: [{ data (base64), alt }], model: 'agy', said }
//   findImage(dir)                                           the newest picture file in dir (agy may pick another name or type)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: realSpawn, killTree } = require('./cli-utils');
const genImages = require('../features/gen-images');

const TIMEOUT_MS = 200000; // a little past --print-timeout, so agy's own limit ends the run first
const PRINT_TIMEOUT = '3m';
const REFUSAL = /polic(?:y|ies)|moderat|safety|guideline|can(?:'|’)?t (?:create|generate|make|help)|cannot (?:create|generate|make|help)|unable to (?:create|generate|make)|not able to (?:create|generate|make)|decline|against my|violates?/i;
const NOT_SIGNED_IN = /not (logged|signed) in|please (log|sign) ?in|sign[- ]?in required|unauthenticated|not authenticated|authentication (failed|required)|login required/i;
const IMG = /\.(?:png|jpe?g|webp|gif)$/i;

const imageHomeFor = (userData) => path.join(userData, 'antigravity-image');
const imageSettings = (provider, folder) => ({
  ...(provider ? { modelProvider: provider } : {}), enableTelemetry: false, trustedWorkspaces: [folder], enableTerminalSandbox: true,
  permissions: { allow: [], ask: [], deny: ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] },
});

// The newest picture file directly in dir (the source picture of an edit excluded). { file, mtimeMs } | null
function findImage(dir, skip = null) {
  let best = null;
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!IMG.test(n) || n === skip) continue;
    const file = path.join(dir, n);
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs };
  }
  return best;
}

// The argv for one picture (exported for tests; never joined into a shell string).
function buildArgs({ prompt, dir, out }) {
  return ['--sandbox', '--mode', 'accept-edits', '--add-dir', dir, '--print-timeout', PRINT_TIMEOUT, '-p', `Generate an image: ${prompt}. Save to ${out}. Do not run any other tool.`];
}

// bin: the agy executable (ai/antigravity.js findAgy; LUMEN_AGY_BIN in tests). source: { buffer, mime } to edit. userData: Lumen's
// profile folder (the run's own home). spawn, tmpRoot, timeoutMs, env are there for tests.
async function generate({ bin, prompt, source = null, signal, userData = null, spawn = realSpawn, tmpRoot = os.tmpdir(), timeoutMs = TIMEOUT_MS, env = null }) {
  if (!bin) throw Object.assign(new Error('Antigravity is not installed.'), { imageApi: true });
  const ag = require('./antigravity');
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'lumen-agy-image-'));
  let runEnv = env;
  if (!runEnv && userData) {
    const home = imageHomeFor(userData);
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(imageSettings(ag.userProvider(), dir), null, 2), { mode: 0o600 });
    fs.rmSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), { force: true }); // no MCP servers, not even Lumen's
    runEnv = ag.buildEnv({ home });
  }
  try {
    let ask = String(prompt).replace(/[\r\n]+/g, ' ').replace(/"/g, '\'').slice(0, 2000);
    let sourceName = null;
    if (source) {
      sourceName = `source.${source.mime === 'image/jpeg' ? 'jpg' : source.mime.split('/')[1] || 'png'}`;
      fs.writeFileSync(path.join(dir, sourceName), source.buffer);
      ask = `edit ${path.join(dir, sourceName)}: ${ask}`;
    }
    const out = path.join(dir, 'picture.png');
    const argv = buildArgs({ prompt: ask, dir, out });
    const { code, stdout, stderr } = await new Promise((resolve, reject) => {
      let child;
      try { child = spawn(bin, argv, { shell: false, windowsHide: true, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], ...(runEnv ? { env: runEnv } : {}) }); } catch (e) { reject(e); return; }
      let so = '';
      let se = '';
      const cap = (s) => s.slice(-20000);
      child.stdout?.on('data', (c) => { so = cap(so + c); });
      child.stderr?.on('data', (c) => { se = cap(se + c); });
      let closed = false;
      let stopping = false;
      // Stopped (timeout, Stop): the process tree is ended and its exit waited for (3 s at most), so the temp folder is free to remove.
      const stop = (err) => {
        stopping = true;
        try { killTree(child); } catch { try { child.kill(); } catch { /* gone */ } }
        if (closed) { reject(err); return; }
        const give = setTimeout(() => reject(err), 3000);
        child.once('close', () => { clearTimeout(give); reject(err); });
      };
      const timer = setTimeout(() => stop(Object.assign(new Error('Antigravity took too long to make the picture.'), { code: 'ETIMEDOUT', imageApi: true })), timeoutMs);
      const onAbort = () => { clearTimeout(timer); stop(Object.assign(new Error('Stopped by the user.'), { name: 'AbortError' })); };
      if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (c) => { closed = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (!stopping) resolve({ code: c, stdout: so, stderr: se }); });
    });
    const found = findImage(dir, sourceName);
    const buffer = found ? fs.readFileSync(found.file) : null;
    if (buffer && buffer.length <= genImages.MAX_BYTES && genImages.sniff(buffer)) {
      return { images: [{ data: buffer.toString('base64'), alt: String(prompt).slice(0, 300) }], model: 'agy', said: '' };
    }
    const text = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const line = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 400);
    const error = new Error(NOT_SIGNED_IN.test(text) ? 'Antigravity is not signed in.' : line || `Antigravity made no picture${code ? ` (exit ${code})` : ''}.`);
    error.imageApi = true;
    if (NOT_SIGNED_IN.test(text)) error.status = 401; // fallback.classify: "not signed in or key rejected", the next provider is asked
    else if (code === 0 && REFUSAL.test(line)) error.policy = true; // it answered in words instead of drawing: its own refusal
    throw error;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
  }
}

module.exports = { generate, findImage, buildArgs, imageHomeFor, imageSettings, PRINT_TIMEOUT };
