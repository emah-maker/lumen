// Screen recording, pure logic (features/screen-recorder.js): the file names, the sink that writes the pieces to "<name>.webm.part" and renames it at
// the end, and the controller's rules (who may capture and when, what happens on cancel / no microphone / Stop / the tab closing) against a fake window.
// No Electron window, no screen, no network. Runs on its own (npm run test:units picks up test/*-units.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const SR = require('../../src/features/screen-recorder');

let failed = 0;
const check = (label, ok, detail = '') => { if (!ok) { failed++; console.error(`FAIL ${label} ${detail}`); } else console.log(`ok   ${label}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-rec-units-'));

(async () => {
  // ---- names
  const date = new Date(2026, 9, 19, 14, 3, 5);
  check('name: a tab recording names the site and the time', SR.recordingName({ kind: 'tab', host: 'www.example.com', date }) === 'Lumen tab recording - example.com - 2026-10-19 14-03-05', SR.recordingName({ kind: 'tab', host: 'www.example.com', date }));
  check('name: a screen recording names just the time', SR.recordingName({ kind: 'screen', date }) === 'Lumen screen recording 2026-10-19 14-03-05');
  check('name: a tab with no address uses its title', /^Lumen tab recording - My Notes - /.test(SR.recordingName({ kind: 'tab', title: 'My Notes', date })));
  const nasty = SR.recordingName({ kind: 'tab', host: 'a<b>:c/d\\e|f?g*.test', date });
  check('name: nothing Windows refuses in a file name', !/[<>:"/\\|?*]/.test(nasty.replace(/(\d\d)-(\d\d)-(\d\d)$/, '')) && nasty.length < 120, nasty);
  check('name: a very long host is cut', SR.recordingName({ kind: 'tab', host: 'x'.repeat(300), date }).length < 120);

  // ---- free file names
  fs.writeFileSync(path.join(dir, 'a.webm'), 'x');
  check('free file: a taken name gets (1)', path.basename(SR.freeFile(dir, 'a')) === 'a (1).webm');
  fs.writeFileSync(path.join(dir, 'b.webm.part'), 'x');
  check('free file: a name being written counts as taken', path.basename(SR.freeFile(dir, 'b')) === 'b (1).webm');

  // ---- the sink
  const sink = SR.createSink(dir, 'clip');
  sink.write(Buffer.from([1, 2, 3]));
  sink.write(new Uint8Array([4, 5]).buffer);
  check('sink: pieces go to a .part file while recording', fs.existsSync(path.join(dir, 'clip.webm.part')) && !fs.existsSync(path.join(dir, 'clip.webm')));
  const done = sink.finish();
  check('sink: finish renames it and returns the path', done === path.join(dir, 'clip.webm') && fs.readFileSync(done).equals(Buffer.from([1, 2, 3, 4, 5])) && !fs.existsSync(`${done}.part`));
  const empty = SR.createSink(dir, 'empty');
  check('sink: nothing written means no file at all', empty.finish() === null && !fs.existsSync(path.join(dir, 'empty.webm')) && !fs.existsSync(path.join(dir, 'empty.webm.part')));
  const gone = SR.createSink(dir, 'gone');
  gone.write(Buffer.from([9]));
  gone.abort();
  check('sink: abort throws the pieces away', !fs.existsSync(path.join(dir, 'gone.webm.part')) && !fs.existsSync(path.join(dir, 'gone.webm')));
  const made = SR.createSink(path.join(dir, 'new', 'folder'), 'x');
  made.abort();
  check('sink: a missing Downloads folder is made', fs.existsSync(path.join(dir, 'new', 'folder')));

  // ---- the controller, against a fake recorder window
  const views = [];
  const frame = { isDestroyed: () => false };
  const tabWc = { isDestroyed: () => false, getURL: () => 'https://www.example.com/lecture', getTitle: () => 'Lecture', mainFrame: frame };
  const make = (script) => {
    const handlers = {};
    const calls = [];
    const wcFake = {
      isDestroyed: () => false, on() {}, setWindowOpenHandler() {},
      send: (channel, view) => { if (channel === 'screen-rec:view') views.push(view); },
      executeJavaScript: async (code) => { calls.push(code); return script(code, rec); },
    };
    const winFake = {
      webContents: wcFake, isDestroyed: () => false, isVisible: () => false, showInactive() {}, setAlwaysOnTop() {}, setContentProtection() {}, setOpacity() {}, setIgnoreMouseEvents() {}, setPosition() {}, setBounds() {},
      loadFile: async () => {}, on() {}, destroy() { winFake.destroyed = true; },
    };
    const added = [];
    const toasts = [];
    const shown = [];
    const rec = SR.createScreenRecorder({
      electron: {
        BrowserWindow: function () { return winFake; },
        screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
        ipcMain: { on: (channel, fn) => { handlers[channel] = fn; } },
        shell: { showItemInFolder: (f) => shown.push(f) },
      },
      preload: 'p.js', page: 'r.html', downloadDir: () => dir, addDownload: (f) => added.push(f), anchor: () => null,
      t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key), toast: (x) => toasts.push(x), hidden: true, now: () => date,
    });
    return { h: handlers, rec, calls, winFake, wcFake, added, toasts, shown, event: { sender: wcFake } };
  };

  // A tab recording that works: the tab is handed over only while starting, the pieces are written, Stop saves and lists the file.
  let during = null;
  const a = make((code, rec) => {
    if (code.startsWith('window.__rec.start')) {
      during = { streams: rec.takeDisplay({}, a.wcFake), permDisplay: rec.allowsPermission(a.wcFake, 'display-capture', { isMainFrame: true }), permMicOff: rec.allowsPermission(a.wcFake, 'media', { mediaTypes: ['audio'], isMainFrame: true }), stranger: rec.allowsPermission({}, 'display-capture', { isMainFrame: true }), strangerStreams: rec.takeDisplay({}, {}) };
      return { ok: true, mime: 'video/webm;codecs=vp9,opus' };
    }
    if (code === 'window.__rec.pause()' || code === 'window.__rec.resume()') return true;
    if (code === 'window.__rec.stop()') { setImmediate(() => { a.h['screen-rec:chunk'](a.event, new Uint8Array([7, 7, 7, 7]).buffer); a.h['screen-rec:done'](a.event, { bytes: 4 }); }); return true; }
    return null;
  });
  const started = await a.rec.start({ kind: 'tab', wc: tabWc, mic: false, sound: true });
  check('tab: starts', started.ok === true && a.rec.state().phase === 'recording' && /Lumen tab recording - example\.com - /.test(started.file), JSON.stringify(started));
  check('tab: the recorder window gets the tab and its sound, nothing else', during?.streams?.video === frame && during.streams.audio === frame, JSON.stringify(during?.streams));
  let silent = null;
  const b = make((code, r) => { if (code.startsWith('window.__rec.start')) { silent = r.takeDisplay({}, b.wcFake); return { ok: true }; } return true; });
  await b.rec.start({ kind: 'tab', wc: tabWc, sound: false });
  check('tab: with no sound asked, only the picture is handed over', silent?.video === frame && !('audio' in silent), JSON.stringify(silent));
  b.rec.shutdown();
  check('tab: the recorder window may capture the display while starting, but not the microphone unless asked', during?.permDisplay === true && during.permMicOff === false, JSON.stringify(during));
  check('tab: no other window gets the tab or the permission', during?.stranger === false && during.strangerStreams === null);
  check('tab: after starting it hands out nothing', a.rec.takeDisplay({}, a.wcFake) === null && a.rec.allowsPermission(a.wcFake, 'display-capture', { isMainFrame: true }) === false);
  check('tab: a second recording is refused while one runs', (await a.rec.start({ kind: 'tab', wc: tabWc })).error === 'busy');
  check('tab: the bar shows recording', views.at(-1)?.mode === 'recording', JSON.stringify(views.at(-1)));
  check('tab: pause and resume', (await a.rec.pause()) === true && a.rec.state().phase === 'paused' && (await a.rec.resume()) === true && a.rec.state().phase === 'recording');
  a.rec.press('stop');
  await new Promise((r) => setTimeout(r, 30));
  const savedPath = a.added[0];
  check('tab: Stop writes the file and lists it as a download', a.rec.state().phase === 'saved' && savedPath && fs.readFileSync(savedPath).equals(Buffer.from([7, 7, 7, 7])) && path.extname(savedPath) === '.webm', JSON.stringify(a.rec.state()));
  check('tab: the bar offers the saved file', views.at(-1)?.mode === 'saved' && /record\.saved/.test(views.at(-1).text));
  check('tab: Show in folder reveals that file', a.rec.showInFolder() === true && a.shown[0] === savedPath);
  a.rec.shutdown();

  // The microphone: allowed only while starting, only when switched on, only audio; a refusal ends the start cleanly with nothing left behind.
  let micAllowed = null;
  const m = make((code, rec) => { if (code.startsWith('window.__rec.start')) { micAllowed = { audio: rec.allowsPermission(m.wcFake, 'media', { mediaTypes: ['audio'], isMainFrame: true }), video: rec.allowsPermission(m.wcFake, 'media', { mediaTypes: ['video'], isMainFrame: true }), both: rec.allowsPermission(m.wcFake, 'media', { mediaTypes: ['audio', 'video'], isMainFrame: true }), frame: rec.allowsPermission(m.wcFake, 'media', { mediaTypes: ['audio'], isMainFrame: false }) }; return { ok: false, error: 'mic', name: 'NotAllowedError' }; } return true; });
  const before = fs.readdirSync(dir).length;
  const micRes = await m.rec.start({ kind: 'tab', wc: tabWc, mic: true });
  check('mic: switched on, the recorder window may ask for audio only', micAllowed?.audio === true && micAllowed.video === false && micAllowed.both === false && micAllowed.frame === false, JSON.stringify(micAllowed));
  check('mic: a refused microphone ends the start with its own error and no file', micRes.ok === false && micRes.error === 'mic' && m.rec.state().phase === 'idle' && fs.readdirSync(dir).length === before, JSON.stringify(micRes));
  check('mic: nothing is allowed once the start is over', m.rec.allowsPermission(m.wcFake, 'media', { mediaTypes: ['audio'], isMainFrame: true }) === false);

  // Cancelling the screen picker: no file, no error shown.
  const c = make((code) => (code.startsWith('window.__rec.start') ? { ok: false, error: 'cancelled', name: 'NotAllowedError' } : true));
  const cancelled = await c.rec.start({ kind: 'screen' });
  check('screen: the screen picker is left to main (the recorder hands out nothing for it)', cancelled.error === 'cancelled' && c.rec.state().phase === 'idle' && c.winFake.destroyed === true && c.toasts.length === 0);

  // The tab closes on its own: the page reports done, the pieces so far are kept.
  const d = make((code) => (code.startsWith('window.__rec.start') ? { ok: true, mime: 'video/webm' } : true));
  await d.rec.start({ kind: 'tab', wc: tabWc });
  d.h['screen-rec:chunk'](d.event, new Uint8Array([1, 2]).buffer);
  d.h['screen-rec:done'](d.event, { bytes: 2 });
  check('closing the tab keeps what was recorded', d.added.length === 1 && fs.readFileSync(d.added[0]).length === 2 && d.rec.state().phase === 'saved');
  // A message from any other page is ignored.
  const e = make((code) => (code.startsWith('window.__rec.start') ? { ok: true } : true));
  await e.rec.start({ kind: 'tab', wc: tabWc });
  e.h['screen-rec:chunk']({ sender: {} }, new Uint8Array([5]).buffer);
  e.h['screen-rec:done']({ sender: {} }, { bytes: 1 });
  check('another page cannot write to or end the recording', e.rec.state().phase === 'recording' && e.added.length === 0);
  // Nothing recorded: no empty file.
  e.h['screen-rec:done'](e.event, { bytes: 0 });
  check('a recording with no data saves no file and says so', e.added.length === 0 && e.rec.state().phase === 'idle' && e.toasts[0] === 'record.empty', JSON.stringify(e.toasts));
  // Quitting keeps what was written.
  const f = make((code) => (code.startsWith('window.__rec.start') ? { ok: true } : true));
  await f.rec.start({ kind: 'tab', wc: tabWc });
  f.h['screen-rec:chunk'](f.event, new Uint8Array([3, 3, 3]).buffer);
  f.rec.shutdown();
  check('quitting mid-recording keeps the file', f.added.length === 1 && fs.readFileSync(f.added[0]).length === 3);

  // ---- wiring
  const main = read('src/main.js');
  check('wiring: the recorder is loaded on first use, not at start-up', /let screenRec = null;/.test(main) && /screenRec \|\|= require\('\.\/features\/screen-recorder'\)/.test(main) && !/^(const|let) \w+ = require\('\.\/features\/screen-recorder'\)/m.test(main));
  check('wiring: the picker hands the recorder its own request first', /screenRec\.owns\(wc\)/.test(main) && /screenRec\?\.allowsPermission\(wc, permission, details\)/.test(main));
  check('wiring: the Record submenu is in the menu and on macOS', (main.match(/submenu: recordMenu\(/g) || []).length === 2);
  const en = JSON.parse(read('src/locales/en.json'));
  const used = new Set([...(main + read('src/features/screen-recorder.js')).matchAll(/\bt\('((?:record|menu)\.[A-Za-z.]+)'/g)].map((x) => x[1]));
  check('wiring: every record.* text exists', [...used].filter((k) => k.startsWith('record.') || k === 'menu.record').every((k) => en[k]), [...used].filter((k) => !en[k]).join(','));
  check('wiring: the page and its preload exist and the bar is not captured', fs.existsSync(path.join(__dirname, '../src/renderer/recorder.html')) && fs.existsSync(path.join(__dirname, '..', '..', 'src', 'preload', 'recorder-preload.js')) && /setContentProtection\(true\)/.test(read('src/features/screen-recorder.js')));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED` : '\nscreen-recorder units: all passed');
  process.exit(failed ? 1 : 0);
})();
