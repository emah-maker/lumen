// On-device speech to text for voice input (ai/dictation.js): whisper.cpp's command-line program and a small Whisper
// model, both downloaded on first use into <userData>/speech-to-text and checked against pinned SHA-256 hashes before
// they are kept. No key, no account, and the audio never leaves the computer.
//
// Why whisper.cpp: Windows' own recognizers don't fit (System.Speech's dictation is far less accurate than Whisper, and
// Windows.Media.SpeechRecognition's free dictation goes to Microsoft's online service and reads only the live microphone);
// Chromium's SpeechRecognition needs Google's key; a WASM Whisper (transformers.js) would add tens of MB to every install
// and run several times slower. whisper.cpp's prebuilt Windows program is 9 MB, the base model 60 MB, and a 5-second
// clip takes about a second on a laptop CPU. It runs as a child process only while it transcribes, so it costs nothing
// at startup and holds no memory between recordings. Prebuilt programs exist for Windows (x64, arm64) only; elsewhere
// this engine reports itself unsupported and voice input uses an API key if there is one.
//
// The program reads the recording from a file (its stdin mode prints nothing on Windows): the WAV goes into a private
// temporary folder, is read once, and the folder is deleted as soon as the text is back (and any leftovers on next use).
//
// Plain Node: fetch, spawn and the folders are injected, so test/units/local-stt-units.js runs it without Electron.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BUILD_TAG = 'b5454'; // github.com/ggml-org/whisper.cpp/releases/tag/b5454
const RELEASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD_TAG}/`;
const BUILDS = {
  'win32-x64': { name: 'whisper-bin-x64.zip', size: 8928640, sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' },
  'win32-arm64': { name: 'whisper-bin-win-cpu-arm64.zip', size: 4371193, sha256: '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d' },
};
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/';
const MODELS = {
  en: { name: 'ggml-base.en-q5_1.bin', size: 59721011, sha256: '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f' },
  multi: { name: 'ggml-base-q5_1.bin', size: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' },
};
const EXE = 'whisper-cli.exe';
const RUN_TIMEOUT_MS = 90000; // two minutes of speech takes ~10 s on a laptop CPU
const STALL_MS = 30000; // a download with no new bytes for this long is abandoned
// Whisper invents words for silence ("you", "Thank you."), so a recording this quiet throughout is not transcribed: the
// loudest 30 ms of it must reach about -46 dBFS. The chat box's recorder has auto gain on, so speech is far above this.
const SILENCE_RMS = 0.005;
// The languages Whisper knows (its ISO 639-1 codes): the UI language is passed when it is one, else Whisper detects it.
const WHISPER_LANGS = new Set('af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo yue zh'.split(' '));

const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
const supported = (platform, arch) => Boolean(BUILDS[platformKey(platform, arch)]);
// The UI locale ('en-US', 'fr', ...) -> which model and which -l argument.
function languageFor(locale) {
  const base = String(locale || 'en').toLowerCase().split(/[-_]/)[0] || 'en';
  if (base === 'en') return { model: 'en', lang: 'en' };
  return { model: 'multi', lang: WHISPER_LANGS.has(base) ? base : 'auto' };
}

// A 16-bit PCM WAV -> { seconds, peakRms } (the loudest 30 ms frame), or null when it isn't one.
function wavLevel(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let rate = 0;
  let bits = 0;
  let channels = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 24 <= buf.length) { channels = buf.readUInt16LE(at + 10); rate = buf.readUInt32LE(at + 12); bits = buf.readUInt16LE(at + 22); }
    if (id === 'data') {
      if (bits !== 16 || !rate || !channels) return null;
      const end = Math.min(buf.length, at + 8 + size);
      const samples = Math.floor((end - at - 8) / 2);
      const frame = Math.max(1, Math.round(rate * channels * 0.03));
      let peak = 0;
      for (let f = 0; f < samples; f += frame) {
        let sum = 0;
        const n = Math.min(frame, samples - f);
        for (let i = 0; i < n; i++) { const v = buf.readInt16LE(at + 8 + (f + i) * 2) / 32768; sum += v * v; }
        peak = Math.max(peak, Math.sqrt(sum / n));
      }
      return { seconds: samples / channels / rate, peakRms: peak };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

// whisper-cli's stdout -> the words: one line, without the [BLANK_AUDIO] / (music) / [Applause] tags it adds.
function cleanText(out) {
  return String(out || '')
    .replace(/\[[^\]\n]{0,40}\]|\((?:[^)\n]{0,40})\)|\*[^*\n]{0,40}\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function runArgs({ model, file, lang, threads }) {
  return ['-m', model, '-f', file, '-l', lang, '-t', String(threads), '-nt', '-np'];
}

const fail = (key, params = {}) => ({ error: { key, params } });
const short = (err) => String(err?.message || err || '').slice(0, 120);

// deps: { dir, platform?, arch?, fetchImpl, spawnImpl?, tmpdir?, extract?(zip, into) -> Promise, cpus?, builds?, models? (tests: small files) }
function createLocalStt({
  dir, platform = process.platform, arch = process.arch, fetchImpl, spawnImpl = (...a) => require('child_process').spawn(...a),
  tmpdir = os.tmpdir(), extract = extractZip, cpus = () => os.cpus().length, stallMs = STALL_MS, runTimeoutMs = RUN_TIMEOUT_MS,
  builds = BUILDS, models = MODELS,
}) {
  const build = builds[platformKey(platform, arch)] || null;
  const binDir = path.join(dir, `whisper-${BUILD_TAG}`);
  const marker = path.join(binDir, 'lumen-ok.json'); // written last: the folder is complete
  const modelPath = (m) => path.join(dir, models[m].name);
  const jobs = new Map(); // 'bin' | model id -> Promise
  const listeners = new Set();
  let progress = { done: 0, total: 0 };
  const parts = new Map(); // part -> { done, total } while downloading

  const report = () => {
    let done = 0;
    let total = 0;
    for (const p of parts.values()) { done += p.done; total += p.total; }
    const step = (p) => (p.total ? Math.floor((p.done * 100) / p.total) : -1);
    const changed = step({ done, total }) !== step(progress) || total !== progress.total || done === total;
    progress = { done, total };
    if (!changed) return; // (listeners hear each whole percent, not every network chunk)
    for (const fn of listeners) { try { fn({ phase: 'download', done, total }); } catch { /* a listener's problem */ } }
  };

  const exePath = () => {
    try { const m = JSON.parse(fs.readFileSync(marker, 'utf8')); return m?.exe ? path.join(binDir, m.exe) : null; } catch { return null; }
  };
  const modelOk = (m) => { try { return fs.statSync(modelPath(m)).size === models[m].size; } catch { return false; } };
  const installed = (m) => Boolean(build && exePath() && modelOk(m));
  // Bytes still to download for model m (0 when ready).
  const bytesNeeded = (m) => (!build ? 0 : (exePath() ? 0 : build.size) + (modelOk(m) ? 0 : models[m].size));

  // One file: streamed to <dest>.part with its hash checked as it arrives, renamed into place only when it matches.
  async function download(url, file, dest, key) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const ctrl = new AbortController();
    let timer = null;
    let stalled = false;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ctrl.abort(); }, stallMs); };
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(part, 'w');
    let size = 0;
    parts.set(key, { done: 0, total: file.size });
    try {
      arm();
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        size += value.length;
        if (size > file.size) throw new Error('larger than expected');
        hash.update(value);
        fs.writeSync(fd, value);
        parts.set(key, { done: size, total: file.size });
        report();
      }
      fs.closeSync(fd);
      if (size !== file.size) throw new Error(`${size} of ${file.size} bytes`);
      if (hash.digest('hex') !== file.sha256) throw new Error('checksum mismatch');
      fs.renameSync(part, dest);
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* closed */ }
      try { fs.rmSync(part, { force: true }); } catch { /* gone */ }
      throw stalled ? new Error('the download stalled') : err;
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }

  async function installBin() {
    if (exePath()) return;
    const zip = path.join(dir, build.name);
    const staging = `${binDir}.part-${process.pid}-${Date.now()}`;
    try {
      await download(RELEASE + build.name, build, zip, 'bin');
      fs.mkdirSync(staging, { recursive: true });
      await extract(zip, staging);
      const found = findFile(staging, EXE);
      if (!found) throw new Error(`${EXE} is not in the download`);
      fs.writeFileSync(path.join(staging, 'lumen-ok.json'), JSON.stringify({ exe: path.relative(staging, found), build: BUILD_TAG }));
      fs.rmSync(binDir, { recursive: true, force: true });
      fs.renameSync(staging, binDir);
    } finally {
      fs.rmSync(zip, { force: true });
      fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  // Everything model m needs, downloaded once; parallel calls share the work.
  function install(m) {
    if (!build) return Promise.reject(new Error('unsupported'));
    if (installed(m)) return Promise.resolve();
    const once = (key, fn) => {
      if (!jobs.has(key)) jobs.set(key, fn().finally(() => { jobs.delete(key); if (!jobs.size) parts.clear(); })); // (the bar keeps counting both files until both are done)
      return jobs.get(key);
    };
    return Promise.all([
      once('bin', installBin),
      modelOk(m) ? null : once(m, () => download(MODEL_BASE + models[m].name, models[m], modelPath(m), m)),
    ]).then(() => undefined);
  }

  // Leftover temporary folders of a run that never finished (a crash, a kill).
  function sweep() {
    try {
      for (const name of fs.readdirSync(tmpdir)) {
        if (name.startsWith('lumen-stt-')) fs.rmSync(path.join(tmpdir, name), { recursive: true, force: true });
      }
    } catch { /* nothing to sweep */ }
  }

  function run(exe, args) {
    return new Promise((resolve) => {
      let out = '';
      let errOut = '';
      let child;
      try {
        child = spawnImpl(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) { resolve({ code: -1, out: '', err: short(err) }); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ code: -1, timedOut: true, out, err: errOut }); }, runTimeoutMs);
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { if (errOut.length < 4000) errOut += d; });
      child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out, err: short(err) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err: errOut }); });
    });
  }

  // { audio: 16 kHz mono 16-bit WAV (Buffer), locale } -> { text } or { error: { key, params } }. Never throws.
  async function transcribe({ audio, locale }) {
    if (!build) return fail('dictation.error.localUnsupported');
    if (!Buffer.isBuffer(audio) || !audio.length) return fail('dictation.error.empty');
    const level = wavLevel(audio);
    if (!level) return fail('dictation.error.audioLocal', { detail: 'not a WAV recording' });
    if (level.peakRms < SILENCE_RMS) return { text: '' }; // (silence: nothing to transcribe, and nothing invented)
    const { model, lang } = languageFor(locale);
    try { await install(model); } catch (err) { return fail('dictation.error.localDownload', { detail: short(err) }); }
    const exe = exePath();
    if (!exe) return fail('dictation.error.localDownload', { detail: 'incomplete install' });
    sweep();
    let tmp = null;
    try {
      tmp = fs.mkdtempSync(path.join(tmpdir, 'lumen-stt-'));
      const file = path.join(tmp, 'speech.wav');
      fs.writeFileSync(file, audio, { mode: 0o600 });
      const threads = Math.max(2, Math.min(8, Math.floor(cpus() / 2)));
      const r = await run(exe, runArgs({ model: modelPath(model), file, lang, threads }));
      if (r.timedOut) return fail('dictation.error.localTimeout');
      if (r.code !== 0) return fail('dictation.error.localRun', { detail: short(String(r.err || '').trim().split(/\r?\n/).pop() || `exit ${r.code}`) });
      return { text: cleanText(r.out) };
    } catch (err) {
      return fail('dictation.error.localRun', { detail: short(err) });
    } finally {
      if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* swept next time */ } }
    }
  }

  // The download starts in the background (the mic was pressed): it runs while the user speaks.
  function prepare(locale) {
    if (!build) return;
    install(languageFor(locale).model).catch(() => { /* reported by transcribe */ });
  }
  const onProgress = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const status = (locale) => {
    const m = languageFor(locale).model;
    return { supported: Boolean(build), ready: installed(m), bytesNeeded: bytesNeeded(m), downloading: jobs.size > 0, progress };
  };

  return { status, install: (locale) => install(languageFor(locale).model), prepare, transcribe, onProgress, dir };
}

function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === name.toLowerCase()) return p;
    }
  }
  return null;
}

// Windows 10 and 11 ship bsdtar, which reads zip files; the System32 copy is used so nothing on PATH stands in for it.
function extractZip(zip, into) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(tar, ['-xf', zip, '-C', into], { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip failed (${code})`))));
  });
}

module.exports = { createLocalStt, supported, platformKey, languageFor, wavLevel, cleanText, runArgs, findFile, BUILDS, MODELS, BUILD_TAG, RELEASE, MODEL_BASE, SILENCE_RMS };
