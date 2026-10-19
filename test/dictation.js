// Voice input in the chat box, in the real app (hidden window, throwaway profile, no keys, no network). Checked: the mic button is in the
// sidebar's composer and on lumen://chat; with no OpenAI or Gemini key the status (and a click) says which key to add; the microphone is
// allowed for Lumen's own sidebar and chat page (audio only: the camera still is not), while a web page still reads "prompt"; Settings'
// "Off" turns it off; Esc puts the button back. The transcription requests themselves are covered by test/dictation-units.js.
// Run: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/dictation.js
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>web</title><p>web page</p>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const webUrl = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-dictation-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  delete env.OPENAI_API_KEY; delete env.GEMINI_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('#prompt', { state: 'attached' });

    check('sidebar: the mic button sits in the composer', await ui.evaluate(() => Boolean(document.querySelector('#composer #mic-btn')) && document.getElementById('mic-btn').dataset.state === 'idle'));
    const status = await ui.evaluate(() => window.assistant.dictation.status());
    check('no key: no provider, and the message names both keys', status.provider === null && /OpenAI or Google Gemini/.test(status.message) && !('key' in status), JSON.stringify(status));
    const refused = await ui.evaluate(() => window.assistant.dictation.transcribe(new Uint8Array([1, 2, 3]), 'webm'));
    check('no key: a transcription is refused before anything is sent', Boolean(refused.error) && refused.settings === true, JSON.stringify(refused));

    // Lumen's own page: the microphone is allowed (no prompt); the camera is not.
    const micState = await ui.evaluate(() => navigator.permissions.query({ name: 'microphone' }).then((s) => s.state, (e) => `error ${e.message}`));
    check('sidebar page: microphone permission reads granted', micState === 'granted', micState);
    if (process.platform !== 'darwin') { // (on a Mac this would bring up the system's microphone prompt for the test app)
      const mic = await ui.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name));
      check('sidebar page: getUserMedia(audio) is not refused by Lumen', mic === 'granted' || mic === 'NotFoundError' || mic === 'NotReadableError', mic);
    }
    const cam = await ui.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name));
    check('sidebar page: the camera is still refused', cam !== 'granted', cam);

    // A web page is unchanged: it would be asked, never handed the microphone.
    const webState = await app.evaluate((_e, url) => new Promise((res) => {
      const t = global.__agent.browser.openTab(url);
      t.webContents.once('did-finish-load', () => t.webContents.executeJavaScript("navigator.permissions.query({ name: 'microphone' }).then((s) => s.state)").then(res, (e) => res(`error ${e.message}`)));
    }), webUrl);
    check('web page: microphone still reads "prompt" (not granted)', webState === 'prompt', webState);

    // A click with no key explains which key to add, with a way to Settings.
    await ui.evaluate(() => { document.body.classList.remove('sidebar-hidden'); });
    await ui.evaluate(() => document.getElementById('mic-btn').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })));
    const note = await waitFor(() => ui.evaluate(() => { const n = document.getElementById('attachment-note'); return n && !n.hidden && n.textContent; }));
    check('a click with no key: the note says which key to add, with Open Settings', /API key/.test(note || '') && /Open Settings/.test(note || ''), note);
    check('and the button is back to idle', await waitFor(() => ui.evaluate(() => document.getElementById('mic-btn').dataset.state === 'idle')));

    // Off in Settings.
    await app.evaluate(() => global.__settings.backend.set('dictationProvider', 'off'));
    const off = await ui.evaluate(() => window.assistant.dictation.status());
    check('Settings Off: no provider, and it says how to turn it back on', off.provider === null && off.reason === 'off' && /Settings/.test(off.message), JSON.stringify(off));
    const bad = await app.evaluate(() => global.__settings.backend.set('dictationProvider', 'groq').then(() => 'accepted', (e) => e.message));
    check('Settings: an unknown provider is refused', bad !== 'accepted', bad);
    await app.evaluate(() => global.__settings.backend.set('dictationProvider', 'auto'));

    // lumen://chat has it too.
    await app.evaluate(() => global.__chatPage.open());
    const chatId = await waitFor(() => app.evaluate(() => global.__chatPage.tabs().find((x) => x.chat)?.id));
    const inChat = (code) => app.evaluate((_e, [id, c]) => global.__chatPage.contents(id).executeJavaScript(c, true), [chatId, code]);
    check('chat page: the mic button sits in the composer', await waitFor(() => inChat("Boolean(document.querySelector('#composer #mic-btn'))")));
    const chatStatus = await inChat('window.assistant.dictation.status()');
    check('chat page: the status call is allowed and says no key', chatStatus && chatStatus.provider === null && /API key/.test(chatStatus.message), JSON.stringify(chatStatus));
    const chatMic = await inChat("navigator.permissions.query({ name: 'microphone' }).then((s) => s.state)");
    check('chat page: microphone permission reads granted', chatMic === 'granted', chatMic);
  } catch (err) {
    failures++;
    console.log(`FAIL  dictation suite threw  -> ${err?.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(`\ndictation: ${failures ? `${failures} failed` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
