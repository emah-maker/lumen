// Pictures from Antigravity (agy), through the user's own Google sign-in (no API key). One headless run per picture in a fresh
// temporary folder: `agy --sandbox --mode accept-edits --add-dir <folder> --print-timeout 3m --output-format stream-json
// --disable-slash-commands -p "Use your generate_image tool once …"`, never --always-approve or --dangerously-skip-permissions. The run
// gets a home of its own (<userData>/antigravity-image, like the one-shot home in ai/cli-json.js): a settings.json that denies commands,
// URLs and MCP tools and trusts only the temporary folder, and no mcp_config.json, so the user's own servers (Lumen's among them) are
// not started. The sign-in stays in the OS keyring.
//
// WHERE THE PICTURE IS (agy 1.5.1, read from a real run's transcript and log, 2026-11-05): agy's generate_image (run by an image
// subagent) saves into the conversation's artifact folder, <HOME>/.gemini/antigravity-cli/brain/<conversation id>/picture_<n>.jpg, never
// to a path the prompt names, and the run cannot copy it out (commands are denied). So the picture is looked for there, in the
// conversation the stream's init event names, and in any path the reply names, as well as in the temporary folder. Lumen watches for
// it while agy runs and ends the run as soon as a whole picture is there: agy otherwise goes on for about a minute more (its reply,
// the subagent shutting down) before it exits. The conversation's artifact folder and the temporary folder are removed afterwards.
//
//   generate({ bin, prompt, source, signal, userData, onProgress, ... }) -> { images: [{ data (base64), alt }], model: 'agy', said }
//   findImage(dir)                                                       the newest picture file in dir (agy may pick another name or type)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: realSpawn, killTree } = require('./cli-utils');
const genImages = require('../features/gen-images');

const TIMEOUT_MS = 200000; // a little past --print-timeout, so agy's own limit ends the run first
const PRINT_TIMEOUT = '3m';
const POLL_MS = 250; // how often the artifact folders are looked at while agy runs
const REFUSAL = /polic(?:y|ies)|moderat|safety|guideline|can(?:'|’)?t (?:create|generate|make|help)|cannot (?:create|generate|make|help)|unable to (?:create|generate|make)|not able to (?:create|generate|make)|decline|against my|violates?/i;
const NOT_SIGNED_IN = /not (logged|signed) in|please (log|sign) ?in|sign[- ]?in required|unauthenticated|not authenticated|authentication (failed|required)|login required/i;
const IMG = /\.(?:png|jpe?g|webp|gif)$/i;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

const imageHomeFor = (userData) => path.join(userData, 'antigravity-image');
const brainOf = (home) => path.join(home, '.gemini', 'antigravity-cli', 'brain');
// (no unsandboxed(*): agy 1.5 ignores that rule with a warning on stderr; command(*) covers it)
const imageSettings = (provider, folder) => ({
  ...(provider ? { modelProvider: provider } : {}), enableTelemetry: false, trustedWorkspaces: [folder], enableTerminalSandbox: true,
  permissions: { allow: [], ask: [], deny: ['command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] },
});

// The newest picture file directly in dir (the source picture of an edit excluded, and none older than `since`). { file, mtimeMs, size } | null
function findImage(dir, skip = null, since = 0) {
  let best = null;
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (!IMG.test(n) || n === skip) continue;
    const file = path.join(dir, n);
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (st.isFile() && st.mtimeMs >= since && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs, size: st.size };
  }
  return best;
}

// The artifact folders this run may have written to: the conversation's (when known), else any made since the run started.
function artifactDirs(brain, conversation, since) {
  if (conversation && SAFE_ID.test(conversation)) return [path.join(brain, conversation)];
  let names;
  try { names = fs.readdirSync(brain); } catch { return []; }
  const out = [];
  for (const n of names) { try { const st = fs.statSync(path.join(brain, n)); if (st.isDirectory() && st.mtimeMs >= since) out.push(path.join(brain, n)); } catch { /* gone */ } }
  return out;
}

// Picture paths named in agy's reply ("…/picture_1.jpg", file:///C:/…/picture_1.jpg), inside the allowed folders only.
function namedImages(text, roots) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?:file:\/\/\/?)?((?:[A-Za-z]:[\\/]|\/)[^\s"'<>()[\]|*?]+?\.(?:png|jpe?g|webp|gif))/gi)) {
    let p = m[1];
    try { p = decodeURIComponent(p); } catch { /* as written */ }
    p = path.resolve(p);
    if (roots.some((r) => p.toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep))) out.push(p);
  }
  return out;
}

// The prompt agy gets: one tool, once, nothing else; the picture is left where agy saves it.
function askFor(prompt, sourceFile = null) {
  const what = sourceFile ? `edit the image ${sourceFile} as follows: ${prompt}` : `make this picture: ${prompt}`;
  return `Use your generate_image tool once to ${what}. Leave the image where generate_image saves it (do not copy, move or convert it) and use no other tool. Then reply with only the image's full path.`;
}

// The argv for one picture (exported for tests; never joined into a shell string).
function buildArgs({ prompt, dir }) {
  return ['--sandbox', '--mode', 'accept-edits', '--add-dir', dir, '--print-timeout', PRINT_TIMEOUT, '--output-format', 'stream-json', '--disable-slash-commands', '-p', prompt];
}

// bin: the agy executable (ai/antigravity.js findAgy; LUMEN_AGY_BIN in tests). source: { buffer, mime } to edit. userData: Lumen's
// profile folder (the run's own home). onProgress(text): a line for the card while it runs. spawn, tmpRoot, timeoutMs, env, pollMs are
// there for tests.
async function generate({ bin, prompt, source = null, signal, userData = null, onProgress = null, spawn = realSpawn, tmpRoot = os.tmpdir(), timeoutMs = TIMEOUT_MS, env = null, pollMs = POLL_MS }) {
  if (!bin) throw Object.assign(new Error('Antigravity is not installed.'), { imageApi: true });
  const ag = require('./antigravity');
  const progress = (text) => { try { onProgress?.(text); } catch { /* cosmetic */ } };
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'lumen-agy-image-'));
  let runEnv = env;
  let home = null;
  if (!runEnv && userData) {
    home = imageHomeFor(userData);
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify(imageSettings(ag.userProvider(), dir), null, 2), { mode: 0o600 });
    fs.rmSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), { force: true }); // no MCP servers, not even Lumen's
    runEnv = ag.buildEnv({ home });
  } else if (runEnv?.HOME) home = runEnv.HOME;
  const brain = home ? brainOf(home) : null;
  const since = Date.now() - 1000; // (a coarse file clock)
  let conversation = null;
  try {
    let sourceName = null;
    if (source) {
      sourceName = `source.${source.mime === 'image/jpeg' ? 'jpg' : source.mime.split('/')[1] || 'png'}`;
      fs.writeFileSync(path.join(dir, sourceName), source.buffer);
    }
    const ask = askFor(String(prompt).replace(/[\r\n]+/g, ' ').replace(/"/g, '\'').slice(0, 2000), sourceName ? path.join(dir, sourceName) : null);
    const argv = buildArgs({ prompt: ask, dir });
    progress('Starting Antigravity…');
    // A picture that is there and whole: a real png/jpeg/webp/gif, not still growing (the same size twice in a row).
    const seen = new Map();
    const look = (text = '') => {
      const roots = [dir, ...(brain ? [brain] : [])];
      const found = [findImage(dir, sourceName, since), ...(brain ? artifactDirs(brain, conversation, since).map((d) => findImage(d, null, since)) : []), ...namedImages(text, roots).map((f) => { try { const st = fs.statSync(f); return { file: f, mtimeMs: st.mtimeMs, size: st.size }; } catch { return null; } })].filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      if (!found || found.size <= 0 || found.size > genImages.MAX_BYTES) return null;
      const steady = seen.get(found.file) === found.size;
      seen.set(found.file, found.size);
      if (!steady) return null;
      let buffer;
      try { buffer = fs.readFileSync(found.file); } catch { return null; }
      return genImages.sniff(buffer) ? buffer : null;
    };
    const { code, text, stderr, picture } = await new Promise((resolve, reject) => {
      let child;
      try { child = spawn(bin, argv, { shell: false, windowsHide: true, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], ...(runEnv ? { env: runEnv } : {}) }); } catch (e) { reject(e); return; }
      let buf = '';
      let said = ''; // the reply's text (stream-json text deltas, or plain lines from an agy without it)
      let result = null;
      let se = '';
      const cap = (s) => s.slice(-20000);
      let drawing = false;
      const line = (l) => {
        let msg;
        try { msg = JSON.parse(l); } catch { said = cap(`${said}${l}\n`); return; }
        if (msg?.event === 'init' && typeof msg.conversation_id === 'string') conversation = msg.conversation_id;
        const su = msg?.event === 'step_update' ? msg.step_update : null;
        if (su?.conversation_id && !conversation) conversation = su.conversation_id;
        if (su && !drawing && (su.tool_name || su.step_type === 'tool')) { drawing = true; progress('Antigravity is drawing your picture…'); }
        if (su?.step_type === 'agent_response' && su.text_delta) said = cap(said + su.text_delta);
        if (msg?.event === 'result' && msg.result) { result = msg.result; if (typeof result.conversation_id === 'string') conversation ||= result.conversation_id; }
      };
      child.stdout?.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) line(l); }
      });
      child.stderr?.on('data', (c) => { se = cap(se + c); });
      let closed = false;
      let settled = false;
      let stopping = false; // ended by Lumen: the exit is waited for, and the reason Lumen ended it is the outcome
      const done = (fn) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll); signal?.removeEventListener('abort', onAbort); fn(); };
      const replyText = () => `${said}${result ? `\n${result.error || ''}\n${result.response || ''}` : ''}`;
      // Ended early (the picture is there, a timeout, Stop): the process tree is ended and its exit waited for (3 s at most), so the
      // temp folder is free to remove.
      const stop = (fn) => {
        stopping = true;
        try { killTree(child); } catch { try { child.kill(); } catch { /* gone */ } }
        if (closed) { done(fn); return; }
        const give = setTimeout(() => done(fn), 3000);
        child.once('close', () => { clearTimeout(give); done(fn); });
      };
      const timer = setTimeout(() => stop(() => reject(Object.assign(new Error('Antigravity took too long to make the picture.'), { code: 'ETIMEDOUT', imageApi: true }))), timeoutMs);
      const poll = setInterval(() => {
        if (settled) return;
        const got = look(replyText());
        if (got) { clearInterval(poll); progress('Saving the picture…'); stop(() => resolve({ code: 0, text: replyText(), stderr: se, picture: got })); }
      }, pollMs);
      const onAbort = () => stop(() => reject(Object.assign(new Error('Stopped by the user.'), { name: 'AbortError' })));
      if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
      child.on('error', (e) => done(() => reject(e)));
      child.on('close', (c) => {
        closed = true;
        if (buf.trim()) line(buf.trim());
        if (!stopping) done(() => resolve({ code: c, text: replyText(), stderr: se, picture: null }));
      });
    });
    let buffer = picture;
    if (!buffer) { look(text); buffer = look(text); } // after the exit: whatever it saved (looked at twice: the size must hold)
    if (buffer) return { images: [{ data: buffer.toString('base64'), alt: String(prompt).slice(0, 300) }], model: 'agy', said: '' };
    const all = `${text}\n${stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const last = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 400);
    const error = new Error(NOT_SIGNED_IN.test(all) ? 'Antigravity is not signed in.' : last || `Antigravity made no picture${code ? ` (exit ${code})` : ''}.`);
    error.imageApi = true;
    if (NOT_SIGNED_IN.test(all)) error.status = 401; // fallback.classify: "not signed in or key rejected", the next provider is asked
    else if (code === 0 && REFUSAL.test(last)) error.policy = true; // it answered in words instead of drawing: its own refusal
    throw error;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
    if (brain && conversation && SAFE_ID.test(conversation)) { try { fs.rmSync(path.join(brain, conversation), { recursive: true, force: true }); } catch { /* agy may still hold it */ } }
  }
}

module.exports = { generate, findImage, namedImages, artifactDirs, askFor, buildArgs, imageHomeFor, imageSettings, PRINT_TIMEOUT, POLL_MS };
