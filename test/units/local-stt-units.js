// On-device voice input (src/ai/local-stt.js), pure Node: which computers it runs on, the pinned downloads, the silence
// gate, the transcript clean-up, and a whole install + transcription with an injected fetch, unzip and program (nothing
// reaches the network and no real program runs): the hash check, nothing left behind on a failed download, one download
// for parallel calls, progress, the temporary recording deleted after the run, and how failures read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const L = require('../../src/ai/local-stt');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`);
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A 16 kHz mono 16-bit WAV: `seconds` of a sine at `amp` (0..1), or silence.
function wav(seconds, amp = 0) {
  const n = Math.round(16000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * amp * 32767), 44 + i * 2);
  return b;
}

// A fetch serving `files` (url -> Buffer) in small chunks, counting calls.
function fakeFetch(files) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const data = files[url];
    if (data instanceof Error) throw data;
    if (!data) return { ok: false, status: 404, body: null };
    let at = 0;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { await new Promise((r) => setImmediate(r)); if (at >= data.length) return { done: true }; const value = data.subarray(at, at + 1000); at += 1000; return { done: false, value }; } }) } };
  };
  fn.calls = calls;
  return fn;
}

// A spawned program: records its arguments, checks the recording is there, prints `out` and exits with `code`.
function fakeSpawn({ out = '', code = 0, hang = false } = {}) {
  const runs = [];
  const fn = (exe, args, opts) => {
    const file = args[args.indexOf('-f') + 1];
    runs.push({ exe, args, opts, fileExisted: fs.existsSync(file), fileBytes: fs.existsSync(file) ? fs.readFileSync(file).length : 0 });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    if (!hang) setImmediate(() => { if (out) child.stdout.emit('data', Buffer.from(out)); if (code) child.stderr.emit('data', Buffer.from('error: failed to read audio\n')); child.emit('close', code); });
    runs.at(-1).child = child;
    return child;
  };
  fn.runs = runs;
  return fn;
}

(async () => {
  // ---- where it runs, and what it downloads
  check('Windows x64 and arm64 are supported', L.supported('win32', 'x64') && L.supported('win32', 'arm64'));
  check('macOS and Linux are not (no prebuilt program): the key engines are used there', !L.supported('darwin', 'arm64') && !L.supported('linux', 'x64'));
  const pinned = [...Object.values(L.BUILDS), ...Object.values(L.MODELS)];
  check('every download has a SHA-256 and a size', pinned.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 1e6));
  check('the program comes from a fixed whisper.cpp release', /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b\d+\/$/.test(L.RELEASE));
  check('the models come from a fixed Hugging Face commit, not main', /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/[0-9a-f]{40}\/$/.test(L.MODEL_BASE));
  check('the models are the small base ones (~60 MB)', Object.values(L.MODELS).every((m) => /^ggml-base/.test(m.name) && m.size < 70e6));

  // ---- language
  check('English UI: the English model, -l en', JSON.stringify(L.languageFor('en-US')) === '{"model":"en","lang":"en"}' && L.languageFor('').model === 'en');
  check('French UI: the multilingual model, -l fr', JSON.stringify(L.languageFor('fr-CA')) === '{"model":"multi","lang":"fr"}');
  check('a language Whisper lacks: it detects the language', L.languageFor('xx-YY').lang === 'auto');

  // ---- the silence gate and the clean-up
  check('silence: a level of 0', L.wavLevel(wav(1)).peakRms === 0 && Math.abs(L.wavLevel(wav(1)).seconds - 1) < 0.01);
  check('speech-loud audio: well above the gate', L.wavLevel(wav(1, 0.2)).peakRms > L.SILENCE_RMS * 10);
  check('very quiet hiss: under the gate', L.wavLevel(wav(1, 0.003)).peakRms < L.SILENCE_RMS);
  check('not a WAV: null', L.wavLevel(Buffer.from('webm-bytes-not-a-wav-file-at-all-really-not-a-wav')) === null && L.wavLevel(null) === null);
  check('transcript: tags dropped, one line', L.cleanText(' [BLANK_AUDIO]\r\n Open my calendar.\r\n (music) and *laughs* tomorrow\n') === 'Open my calendar. and tomorrow');
  check('transcript of only tags: empty', L.cleanText('[BLANK_AUDIO]\n') === '');
  const args = L.runArgs({ model: 'm.bin', file: 'a.wav', lang: 'en', threads: 4 });
  check('program arguments: model, file, language, threads, text only', args.join(' ') === '-m m.bin -f a.wav -l en -t 4 -nt -np');

  // ---- install + transcribe with fakes
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-stt-units-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-stt-units-tmp-'));
  try {
    const zipBytes = Buffer.from('fake zip '.repeat(500));
    const modelBytes = Buffer.from('fake model '.repeat(800));
    const builds = { 'win32-x64': { name: 'whisper-bin-x64.zip', size: zipBytes.length, sha256: sha(zipBytes) } };
    const models = { en: { name: 'ggml-base.en-q5_1.bin', size: modelBytes.length, sha256: sha(modelBytes) }, multi: { name: 'ggml-base-q5_1.bin', size: 5, sha256: '0'.repeat(64) } };
    const urls = { [L.RELEASE + builds['win32-x64'].name]: zipBytes, [L.MODEL_BASE + models.en.name]: modelBytes };
    let extracts = 0;
    const extract = async (zip, into) => { extracts++; if (!fs.readFileSync(zip).equals(zipBytes)) throw new Error('wrong zip'); fs.mkdirSync(path.join(into, 'Release'), { recursive: true }); fs.writeFileSync(path.join(into, 'Release', 'whisper-cli.exe'), 'exe'); };
    const make = (over = {}) => L.createLocalStt({ dir: path.join(root, over.sub || 'a'), platform: 'win32', arch: 'x64', fetchImpl: over.fetch || fakeFetch(urls), spawnImpl: over.spawn || fakeSpawn({ out: ' Hello there.\r\n' }), tmpdir: tmp, extract, cpus: () => 16, builds, models, stallMs: 2000, runTimeoutMs: over.runTimeoutMs || 5000 });

    const fetchA = fakeFetch(urls);
    const spawnA = fakeSpawn({ out: ' [BLANK_AUDIO]\r\n Hello there.\r\n' });
    const a = make({ fetch: fetchA, spawn: spawnA });
    check('before: supported, not ready, both files to download', a.status('en').supported && !a.status('en').ready && a.status('en').bytesNeeded === zipBytes.length + modelBytes.length);
    const seen = [];
    a.onProgress((p) => seen.push(p));
    const [r1, r2] = await Promise.all([a.transcribe({ audio: wav(1, 0.2), locale: 'en-US' }), a.transcribe({ audio: wav(1, 0.2), locale: 'en-US' })]);
    check('the text comes back, cleaned', r1.text === 'Hello there.' && r2.text === 'Hello there.', JSON.stringify([r1, r2]));
    check('two recordings at once: each file downloaded once, unzipped once', fetchA.calls.length === 2 && extracts === 1, JSON.stringify(fetchA.calls));
    check('progress: reported, rising to the total of both files', seen.length > 5 && seen.at(-1).done === seen.at(-1).total && seen.at(-1).total === zipBytes.length + modelBytes.length, JSON.stringify(seen.at(-1)));
    check('after: ready, nothing to download, the zip and partial files gone', a.status('en').ready && a.status('en').bytesNeeded === 0 && !fs.readdirSync(path.join(root, 'a')).some((n) => /\.zip$|\.part/.test(n)), fs.readdirSync(path.join(root, 'a')).join());
    const run = spawnA.runs[0];
    check('the program got the recording as a file, the English model, 8 threads, no window', run.fileExisted && run.fileBytes === wav(1, 0.2).length && run.args.includes(path.join(root, 'a', models.en.name)) && run.args[run.args.indexOf('-t') + 1] === '8' && run.opts.windowsHide === true);
    check('the program is the one from the download', run.exe === path.join(root, 'a', `whisper-${L.BUILD_TAG}`, 'Release', 'whisper-cli.exe'));
    check('the temporary recording is deleted after the run', !fs.readdirSync(tmp).some((n) => n.startsWith('lumen-stt-')), fs.readdirSync(tmp).join());
    await a.transcribe({ audio: wav(1, 0.2), locale: 'en-US' });
    check('next time: no download at all', fetchA.calls.length === 2 && extracts === 1);

    // silence: nothing runs, nothing downloads, nothing invented
    const fetchS = fakeFetch(urls);
    const spawnS = fakeSpawn({ out: ' you\n' });
    const s = make({ sub: 's', fetch: fetchS, spawn: spawnS });
    const rs = await s.transcribe({ audio: wav(2), locale: 'en' });
    check('silence: empty text, no program run, no download', rs.text === '' && spawnS.runs.length === 0 && fetchS.calls.length === 0, JSON.stringify(rs));

    // a leftover from a crash is swept
    fs.mkdirSync(path.join(tmp, 'lumen-stt-crashed'));
    fs.writeFileSync(path.join(tmp, 'lumen-stt-crashed', 'speech.wav'), 'old');
    await a.transcribe({ audio: wav(1, 0.2), locale: 'en' });
    check('a temporary recording left by a crash is deleted on the next use', !fs.existsSync(path.join(tmp, 'lumen-stt-crashed')));

    // a corrupted download is refused and leaves nothing
    const bad = make({ sub: 'bad', fetch: fakeFetch({ ...urls, [L.MODEL_BASE + models.en.name]: Buffer.from('X'.repeat(modelBytes.length)) }) });
    const rb = await bad.transcribe({ audio: wav(1, 0.2), locale: 'en' });
    check('a download that doesn\'t match its hash: refused, said plainly', rb.error?.key === 'dictation.error.localDownload' && /checksum/.test(rb.error.params.detail), JSON.stringify(rb));
    check('…and nothing of the bad model is left on disk', !fs.readdirSync(path.join(root, 'bad')).some((n) => n.startsWith('ggml-')), fs.readdirSync(path.join(root, 'bad')).join());
    const big = make({ sub: 'big', fetch: fakeFetch({ ...urls, [L.MODEL_BASE + models.en.name]: Buffer.concat([modelBytes, Buffer.from('extra')]) }) });
    check('a download larger than pinned: refused', (await big.transcribe({ audio: wav(1, 0.2), locale: 'en' })).error?.key === 'dictation.error.localDownload');
    const off = make({ sub: 'off', fetch: fakeFetch({ ...urls, [L.MODEL_BASE + models.en.name]: new Error('getaddrinfo ENOTFOUND') }) });
    const ro = await off.transcribe({ audio: wav(1, 0.2), locale: 'en' });
    check('offline on first use: a download error naming the cause', ro.error?.key === 'dictation.error.localDownload' && /ENOTFOUND/.test(ro.error.params.detail), JSON.stringify(ro));
    const notFound = make({ sub: 'nf', fetch: fakeFetch({ [L.MODEL_BASE + models.en.name]: modelBytes }) });
    check('a missing release file: HTTP 404 in the message', /404/.test((await notFound.transcribe({ audio: wav(1, 0.2), locale: 'en' })).error?.params?.detail || ''));

    // the program failing
    const crash = make({ sub: 'a', spawn: fakeSpawn({ code: 3 }) });
    const rc = await crash.transcribe({ audio: wav(1, 0.2), locale: 'en' });
    check('the program fails: its last error line in the message', rc.error?.key === 'dictation.error.localRun' && /failed to read audio/.test(rc.error.params.detail), JSON.stringify(rc));
    const hangSpawn = fakeSpawn({ hang: true });
    const hang = make({ sub: 'a', spawn: hangSpawn, runTimeoutMs: 50 });
    const rh = await hang.transcribe({ audio: wav(1, 0.2), locale: 'en' });
    check('the program hangs: stopped, and a timeout message', rh.error?.key === 'dictation.error.localTimeout' && hangSpawn.runs[0].child.killed === true, JSON.stringify(rh));
    check('…and its temporary recording is still deleted', !fs.readdirSync(tmp).some((n) => n.startsWith('lumen-stt-')));
    const throwing = make({ sub: 'a', spawn: () => { throw new Error('spawn EACCES'); } });
    check('the program can\'t start: a run error, not a throw', (await throwing.transcribe({ audio: wav(1, 0.2), locale: 'en' })).error?.key === 'dictation.error.localRun');

    // input it can't use, and computers it can't run on
    check('not a WAV: refused before anything runs', (await a.transcribe({ audio: Buffer.from('x'.repeat(100)), locale: 'en' })).error?.key === 'dictation.error.audioLocal');
    check('nothing recorded: empty error', (await a.transcribe({ audio: Buffer.alloc(0), locale: 'en' })).error?.key === 'dictation.error.empty');
    const mac = L.createLocalStt({ dir: path.join(root, 'mac'), platform: 'darwin', arch: 'arm64', fetchImpl: fakeFetch({}), tmpdir: tmp });
    check('macOS: unsupported, never downloads', mac.status('en').supported === false && (await mac.transcribe({ audio: wav(1, 0.2), locale: 'en' })).error?.key === 'dictation.error.localUnsupported');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- every message key it uses exists
  {
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'locales', 'en.json'), 'utf8'));
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ai', 'local-stt.js'), 'utf8');
    const used = [...new Set((src.match(/'dictation\.[a-zA-Z.]+'/g) || []).map((k) => k.slice(1, -1)))];
    const missing = used.filter((k) => typeof en[k] !== 'string');
    check('every dictation.* message used is in en.json', used.length >= 5 && !missing.length, missing.join(', '));
  }

  console.log(`\nlocal-stt-units: ${failures ? `${failures} failed` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
