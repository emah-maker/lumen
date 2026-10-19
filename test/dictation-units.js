// Voice input in the chat box (src/ai/dictation.js), pure Node: which provider is used, the request each one gets (with an
// injected fetch: nothing reaches the network), how failures read, the message when no key is set, the microphone rule for
// Lumen's own pages, and that main, the preloads, the pages and the docs are wired up.
const fs = require('fs');
const path = require('path');
const D = require('../src/ai/dictation');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`);
};
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// A fetch that records its calls and answers from a list.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.body === undefined) throw new Error('no json'); return a.body; } };
  };
  fn.calls = calls;
  return fn;
}
const audio = () => Buffer.from('fake-audio-bytes');

(async () => {
  // ---- provider choice
  {
    const both = (p) => p === 'openai' || p === 'gemini';
    const geminiOnly = (p) => p === 'gemini';
    const none = () => false;
    check('auto: OpenAI first when both keys are set', D.choose('auto', both).provider === 'openai');
    check('auto: Gemini when only it has a key', D.choose('auto', geminiOnly).provider === 'gemini');
    check('auto: nothing without a key, and it says which keys would do', D.choose('auto', none).provider === null && D.choose('auto', none).reason === 'no-key' && D.choose('auto', none).need.join() === 'openai,gemini');
    check('openai chosen but no OpenAI key: not silently Gemini', D.choose('openai', geminiOnly).provider === null && D.choose('openai', geminiOnly).need.join() === 'openai');
    check('gemini chosen and set', D.choose('gemini', both).provider === 'gemini');
    check('off: never a provider, even with keys', D.choose('off', both).provider === null && D.choose('off', both).reason === 'off');
    check('an unknown or missing setting reads as auto', D.choose(undefined, both).provider === 'openai' && D.choose('groq', geminiOnly).provider === 'gemini');
    check('settings choices', D.SETTINGS.join() === 'auto,openai,gemini,off');
  }

  // ---- the no-key message
  {
    const any = D.unavailableMessage(D.choose('auto', () => false));
    check('no key at all: names both providers', any.key === 'dictation.needAnyKey' && any.params.providers === 'OpenAI or Google Gemini', JSON.stringify(any));
    const one = D.unavailableMessage(D.choose('gemini', () => false));
    check('one provider chosen: names that one', one.key === 'dictation.needKey' && one.params.provider === 'Google Gemini', JSON.stringify(one));
    check('turned off: says so', D.unavailableMessage(D.choose('off', () => true)).key === 'dictation.off');
    check('a usable provider: no message', D.unavailableMessage(D.choose('auto', () => true)) === null);
    const en = JSON.parse(read('src/locales/en.json'));
    check('every message key is in en.json', ['dictation.needAnyKey', 'dictation.needKey', 'dictation.off'].every((k) => typeof en[k] === 'string') && /Settings/.test(en['dictation.needKey']));
  }

  // ---- the requests
  {
    const { url, init } = D.buildRequest({ provider: 'openai', key: 'sk-test', audio: audio(), format: 'webm', boundary: 'BOUND' });
    const body = init.body.toString('latin1');
    check('OpenAI: POST to /v1/audio/transcriptions', url === 'https://api.openai.com/v1/audio/transcriptions' && init.method === 'POST');
    check('OpenAI: bearer key in the header', init.headers.Authorization === 'Bearer sk-test');
    check('OpenAI: multipart with the boundary', init.headers['content-type'] === 'multipart/form-data; boundary=BOUND' && body.endsWith('--BOUND--\r\n'));
    check('OpenAI: gpt-4o-mini-transcribe by default', /name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n/.test(body));
    check('OpenAI: the file part is WebM with the audio bytes', /name="file"; filename="speech.webm"\r\nContent-Type: audio\/webm\r\n\r\nfake-audio-bytes\r\n/.test(body), body);
    check('OpenAI: JSON response asked for', /name="response_format"\r\n\r\njson\r\n/.test(body));
    const g = D.buildRequest({ provider: 'gemini', key: 'g-test', audio: audio(), format: 'wav', model: 'gemini-3.8-flash' });
    const gb = JSON.parse(g.init.body);
    check('Gemini: generateContent on the model', g.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    check('Gemini: key in x-goog-api-key, not the URL', g.init.headers['x-goog-api-key'] === 'g-test' && !/key=/.test(g.url));
    check('Gemini: verbatim prompt + inline WAV audio', gb.contents[0].parts[0].text === D.PROMPT && /verbatim/.test(D.PROMPT) && gb.contents[0].parts[1].inline_data.mime_type === 'audio/wav' && Buffer.from(gb.contents[0].parts[1].inline_data.data, 'base64').toString() === 'fake-audio-bytes');
    check('Gemini: temperature 0', gb.generationConfig.temperature === 0);
    check('Gemini: a Flash model from the key\'s list', D.geminiModel(['gemini-3.1-pro-preview', 'gemini-3.8-flash-lite', 'gemini-3.8-flash']) === 'gemini-3.8-flash');
    check('Gemini: a known Flash model when the list is empty', /flash/.test(D.geminiModel(undefined)));
    check('formats: WebM to OpenAI, WAV to Gemini', D.FORMATS.openai === 'webm' && D.FORMATS.gemini === 'wav');
    let threw = false;
    try { D.buildRequest({ provider: 'xai', key: 'k', audio: audio(), format: 'webm' }); } catch { threw = true; }
    check('no request for a provider without transcription', threw);
  }

  // ---- responses
  check('OpenAI response: the text, trimmed', D.parseResponse('openai', { text: '  hello there \n' }) === 'hello there');
  check('Gemini response: the parts joined', D.parseResponse('gemini', { candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }] }) === 'hello world');
  check('Gemini response with nothing said: empty', D.parseResponse('gemini', { candidates: [{ content: { parts: [] } }] }) === '' && D.parseResponse('gemini', {}) === '');

  // ---- transcribe with an injected fetch
  {
    const f = fakeFetch([{ status: 200, body: { text: 'Open my calendar' } }]);
    const r = await D.transcribe({ provider: 'openai', key: 'k', audio: audio(), format: 'webm', fetchImpl: f });
    check('transcribe: OpenAI text comes back', r.text === 'Open my calendar' && f.calls.length === 1, JSON.stringify(r));
    check('transcribe: the request carries an abort signal (timeout)', f.calls[0].init.signal && typeof f.calls[0].init.signal.aborted === 'boolean');

    const f2 = fakeFetch([{ status: 404, body: { error: { code: 'model_not_found', message: 'The model does not exist' } } }, { status: 200, body: { text: 'from whisper' } }]);
    const r2 = await D.transcribe({ provider: 'openai', key: 'k', audio: audio(), format: 'webm', fetchImpl: f2 });
    check('transcribe: a key without gpt-4o-mini-transcribe falls back to whisper-1', r2.text === 'from whisper' && /whisper-1/.test(f2.calls[1].init.body.toString()), JSON.stringify(r2));

    const f3 = fakeFetch([{ status: 200, body: { candidates: [{ content: { parts: [{ text: 'hola' }] } }] } }]);
    const r3 = await D.transcribe({ provider: 'gemini', key: 'k', audio: audio(), format: 'wav', models: ['gemini-3.8-flash'], fetchImpl: f3 });
    check('transcribe: Gemini text comes back, one request', r3.text === 'hola' && f3.calls.length === 1 && /gemini-3\.8-flash/.test(f3.calls[0].url));

    const r4 = await D.transcribe({ provider: 'openai', key: 'k', audio: Buffer.alloc(0), format: 'webm', fetchImpl: fakeFetch([{ status: 200, body: {} }]) });
    check('transcribe: an empty recording is not sent', r4.error?.key === 'dictation.error.empty');
    const big = fakeFetch([{ status: 200, body: {} }]);
    const r5 = await D.transcribe({ provider: 'openai', key: 'k', audio: Buffer.alloc(D.MAX_BYTES + 1), format: 'webm', fetchImpl: big });
    check('transcribe: an over-size recording is refused before sending', r5.error?.key === 'dictation.error.tooLong' && big.calls.length === 0);

    const r6 = await D.transcribe({ provider: 'gemini', key: 'k', audio: audio(), format: 'wav', fetchImpl: fakeFetch([new Error('getaddrinfo ENOTFOUND')]) });
    check('transcribe: a network failure reads as one, not a throw', r6.error?.key === 'dictation.error.network' && r6.error.params.provider === 'Google Gemini');

    const hang = (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
    const r7 = await D.transcribe({ provider: 'openai', key: 'k', audio: audio(), format: 'webm', fetchImpl: hang, timeoutMs: 30 });
    check('transcribe: a provider that never answers times out', r7.error?.key === 'dictation.error.timeout');

    const r8 = await D.transcribe({ provider: 'openai', key: 'k', audio: audio(), format: 'webm', fetchImpl: fakeFetch([{ status: 401, body: { error: { message: 'Incorrect API key provided' } } }]) });
    check('transcribe: a bad key is not retried with whisper-1', r8.error?.key === 'dictation.error.key');
  }

  // ---- error mapping
  {
    check('401 -> key', D.mapError('openai', 401, null).key === 'dictation.error.key');
    check('Gemini 400 API_KEY_INVALID -> key', D.mapError('gemini', 400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }).key === 'dictation.error.key');
    check('429 -> quota', D.mapError('openai', 429, { error: { code: 'insufficient_quota' } }).key === 'dictation.error.quota');
    check('Gemini RESOURCE_EXHAUSTED -> quota', D.mapError('gemini', 400, { error: { status: 'RESOURCE_EXHAUSTED' } }).key === 'dictation.error.quota');
    check('413 -> too long', D.mapError('openai', 413, null).key === 'dictation.error.tooLong');
    check('400 -> the audio', D.mapError('openai', 400, { error: { message: 'Invalid file format.' } }).key === 'dictation.error.audio');
    check('503 -> unavailable', D.mapError('gemini', 503, null).key === 'dictation.error.unavailable');
    const other = D.mapError('openai', 418, null);
    check('anything else: provider and status', other.key === 'dictation.error.other' && other.params.status === '418' && other.params.provider === 'OpenAI');
    const en = JSON.parse(read('src/locales/en.json'));
    const used = new Set([...read('src/ai/dictation.js').matchAll(/'(dictation\.[\w.]+)'/g), ...read('src/renderer/dictation.js').matchAll(/'(dictation\.[\w.]+)'/g), ...read('src/main.js').matchAll(/'(dictation\.[\w.]+)'/g)].map((m) => m[1]));
    const missing = [...used].filter((k) => typeof en[k] !== 'string');
    check('every dictation.* string used is in en.json', used.size > 15 && !missing.length, missing.join(', '));
  }

  // ---- the microphone rule for Lumen's own pages
  {
    const own = (u) => u === 'file:///lumen/renderer/index.html' || u === 'file:///lumen/renderer/chat-page.html';
    const base = { permission: 'media', mediaTypes: ['audio'], requestingUrl: 'file:///lumen/renderer/index.html', pageUrl: 'file:///lumen/renderer/index.html', isMainFrame: true, isOwnView: true, isOwnPage: own };
    check('mic: the sidebar\'s own page, audio only: allowed', D.ownPageMic(base) === true);
    check('mic: the chat page: allowed', D.ownPageMic({ ...base, requestingUrl: 'file:///lumen/renderer/chat-page.html', pageUrl: 'file:///lumen/renderer/chat-page.html' }) === true);
    check('mic: the camera is never included', D.ownPageMic({ ...base, mediaTypes: ['audio', 'video'] }) === false && D.ownPageMic({ ...base, mediaTypes: ['video'] }) === false);
    check('mic: a web page is never allowed this way', D.ownPageMic({ ...base, requestingUrl: 'https://example.com/', pageUrl: 'https://example.com/' }) === false);
    check('mic: an unknown frame (isMainFrame missing) is not', D.ownPageMic({ ...base, isMainFrame: undefined }) === false && D.ownPageMic({ ...base, isMainFrame: null }) === false);
    check('mic: a frame inside an own page is not', D.ownPageMic({ ...base, isMainFrame: false }) === false && D.ownPageMic({ ...base, requestingUrl: 'file:///lumen/renderer/canvas-frame.html' }) === false);
    check('mic: a view that is not Lumen\'s own is not', D.ownPageMic({ ...base, isOwnView: false }) === false);
    check('mic: other permissions are not', D.ownPageMic({ ...base, permission: 'geolocation' }) === false);
  }

  // ---- wiring
  {
    const main = read('src/main.js');
    check('main: both channels are UI-only and handled', /'dictation:status', 'dictation:transcribe'/.test(main) && /ipcMain\.handle\('dictation:status'/.test(main) && /ipcMain\.handle\('dictation:transcribe'/.test(main));
    check('main: the permission handler checks ownPageMic before anything else asks', /if \(ownPageMic\(wc, permission, details\)\) return callbackAsked\(true\)/.test(main));
    check('main: the recording buffer is cleared after the call, and never written to disk', /audio\.fill\(0\)/.test(main) && !/writeFile[^\n]*audio/.test(main));
    const cp = require('../src/features/chat-page');
    check('chat page: both channels allowed', cp.CHAT_IPC.has('dictation:status') && cp.CHAT_IPC.has('dictation:transcribe'));
    check('preloads: the sidebar and the chat page expose dictation, no key', /dictation: \{ status: .*transcribe: /.test(read('src/preload/preload.js')) && /dictation: \{ status: .*transcribe: /.test(read('src/features/chat-preload.js')));
    const r = read('src/renderer/dictation.js');
    check('renderer: MediaRecorder + getUserMedia, audio only', /new MediaRecorder\(/.test(r) && /getUserMedia\(\{ audio: /.test(r) && !/video:/.test(r));
    check('renderer: no storage of the audio', !/localStorage|indexedDB|sessionStorage|caches\./.test(r));
    check('renderer: loaded by the sidebar and the chat page', /src="dictation\.js"/.test(read('src/renderer/index.src.html')) && /src="dictation\.js"/.test(read('src/renderer/chat-page.html')));
    check('renderer: the size cap is checked before the recording is sent', /bytes\.byteLength > \(s\.status\.maxBytes/.test(r) && /maxBytes: dictationLib\.MAX_BYTES/.test(main));
    check('renderer: Esc cancels, in the capture phase', /e\.key !== 'Escape'/.test(r) && /stopImmediatePropagation/.test(r));
    const src = read('src/features/shortcuts-help.js');
    check('shortcuts sheet: mod+shift+space listed once, no clash', (src.match(/'mod\+shift\+space'/g) || []).length === 1);
    const backend = read('src/settings/settings-backend.js');
    check('settings: defaults auto / off', /dictationProvider: 'auto'/.test(backend) && /dictationAutoSend: false/.test(backend));
    const docs = read('docs/settings.md');
    check('docs: both settings have rows', /`dictationProvider`/.test(docs) && /`dictationAutoSend`/.test(docs));
    check('privacy: PRIVACY.md says where the audio goes', /voice input/i.test(read('PRIVACY.md')));
  }

  console.log(`\ndictation-units: ${failures ? `${failures} failed` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
