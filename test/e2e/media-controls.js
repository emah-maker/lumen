// Media controls (features/media-hub.js, preload/media-hub-preload.js, renderer/media-hub.js): the toolbar's media button shows while a
// tab plays, its pop-up lists each playing tab with the page's Media Session title, artist and artwork (else the tab's title), play/pause,
// previous/next when the page set them, mute, and a click that goes to the tab; the media keys go to the last tab to start playing.
// The fixture pages play a generated tone (a WAV made in the page), served from a local server. Test runs are silent (--mute-audio), so
// Chromium never reports the tabs as audible: everything here comes from the pages' own media elements. The media keys are never
// registered in a test run (they are the whole computer's), so the key presses go through mediaHub.mediaKey, the function they call.
// Windows are hidden, the profile is a temp folder.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node scripts/test/e2e-lock.js run --owner media-controls -- node test/e2e/media-controls.js
/* global lastTabState */
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

let giveUp = async (why) => { console.log(`FAIL  ${why}`); process.exit(1); };
(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let step = 'starting'; let app = null; let ui = null;
  const bound = (p, what, ms = 20000) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s: ${what} (step: ${step})`)), ms); })]).finally(() => clearTimeout(t)); };
  giveUp = async (why) => {
    console.log(`FAIL  ${why}`);
    if (app) { try { app.process().kill(); } catch {} }
    process.exit(1);
  };
  const watchdog = setTimeout(() => giveUp(`the whole suite took longer than 240s (step: ${step})`), 240000); watchdog.unref();

  // A one-second 440 Hz tone, looped, made in the page. ?session=1 also sets the Media Session: title, artist, artwork and previous/next.
  const page = (q) => {
    const session = q.searchParams.get('session') === '1';
    const video = q.searchParams.get('video') === '1';
    return `<!doctype html><title>${q.searchParams.get('t') || 'Tone page'}</title><body>
<script>
function wav() {
  const rate = 8000, n = rate, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
window.__prev = 0; window.__next = 0;
const el = document.createElement(${video ? "'video'" : "'audio'"});
el.loop = true; el.src = wav(); ${video ? 'el.muted = true;' : ''}
document.body.append(el);
window.__el = el;
${session ? `navigator.mediaSession.metadata = new MediaMetadata({ title: 'Test Tone', artist: 'Lumen Band', album: 'Sine Waves', artwork: [{ src: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 8 8%22%3E%3Crect width=%228%22 height=%228%22 fill=%22%23e33%22/%3E%3C/svg%3E', sizes: '96x96', type: 'image/svg+xml' }] });
navigator.mediaSession.setActionHandler('previoustrack', () => { window.__prev++; });
navigator.mediaSession.setActionHandler('nexttrack', () => { window.__next++; });` : ''}
</script>`;
  };
  const server = http.createServer((q, r) => { const u = new URL(q.url, 'http://x'); r.setHeader('Content-Type', 'text/html'); r.end(u.pathname === '/plain' ? '<title>Plain page</title><p>quiet</p>' : page(u)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-media-controls-'));
  app = await bound(electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile } }), 'launching the app', 60000);
  ui = await bound(app.firstWindow(), 'the first window', 30000);
  await ui.waitForSelector('.tab', { timeout: 30000 });
  for (const target of [app, ui]) { const ev = target.evaluate.bind(target); target.evaluate = (f, a) => bound(ev(f, a), `${target === app ? 'main' : 'renderer'} call`); }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));

  const open = (u) => { step = `opening ${u}`; return app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u, { background: true }); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 6000); }); return t.id; }, u); };
  const inPage = (id, code) => app.evaluate(({ webContents }, [id, code]) => {
    const wc = webContents.getAllWebContents().find((w) => { try { return w.__lumenTabId === id; } catch { return false; } });
    return wc ? wc.executeJavaScript(code, true) : Promise.resolve('no tab');
  }, [id, code]);
  const list = () => app.evaluate(() => global.__mediaHub.list());
  const until = async (what, fn, ms = 8000) => { step = what; const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

  // Find each tab's page from main (openTab returns the tab; its webContents carries the id for inPage above).
  await app.evaluate(() => { const orig = global.__agent.browser.openTab; global.__agent.browser.openTab = (...a) => { const t = orig(...a); try { t.webContents.__lumenTabId = t.id; } catch {} return t; }; });

  check('the media button is hidden while nothing plays', await ui.evaluate(() => document.getElementById('media-btn').hidden), 'shown');

  const a = await open(`${base}/a?session=1&t=Session%20page`);
  const b = await open(`${base}/b?t=Plain%20tone`);
  const c = await open(`${base}/c?video=1&t=Muted%20video`);
  const d = await open(`${base}/plain`);

  step = 'playing the session page';
  await inPage(a, 'window.__el.play().then(() => "ok", (e) => String(e))');
  let rows = await until('the session page listed', async () => { const l = await list(); return l.find((x) => x.id === a && x.playing) ? l : null; });
  const ra = rows?.find((x) => x.id === a);
  check('a playing tab is listed', Boolean(ra), JSON.stringify(rows));
  check('its Media Session title and artist are used', ra?.title === 'Test Tone' && ra?.artist === 'Lumen Band', JSON.stringify(ra));
  check('its Media Session artwork is used', /^data:image\/svg\+xml/.test(ra?.artwork || ''), ra?.artwork);
  check('previous and next show because the page set them', ra?.canPrev === true && ra?.canNext === true, JSON.stringify(ra));
  check('the media button shows while it plays', await until('the button', () => ui.evaluate(() => !document.getElementById('media-btn').hidden)), 'hidden');
  check('the media button has an accessible name', await ui.evaluate(() => document.getElementById('media-btn').getAttribute('aria-label') === 'Media controls'), 'no name');

  step = 'playing the plain tone and a muted video';
  await inPage(b, 'window.__el.play().then(() => "ok", (e) => String(e))');
  await inPage(c, 'window.__el.play().then(() => "ok", (e) => String(e))');
  rows = await until('both tones listed', async () => { const l = await list(); return l.filter((x) => x.playing).length >= 2 ? l : null; });
  const rb = rows?.find((x) => x.id === b);
  check('a page with no Media Session is listed under its tab title', rb?.title === 'Plain tone' && rb?.artist === '', JSON.stringify(rb));
  check('no previous/next for a page that has none', rb && !rb.canPrev && !rb.canNext, JSON.stringify(rb));
  check('the last tab to start playing is first', rows?.[0]?.id === b, JSON.stringify(rows?.map((x) => x.id)));
  await sleep(400);
  check('a muted video is not listed', !(await list()).some((x) => x.id === c), JSON.stringify(await list()));
  check('a tab playing nothing is not listed', !(await list()).some((x) => x.id === d), 'listed');

  step = 'media keys';
  await app.evaluate(() => global.__mediaHub.mediaKey('MediaPlayPause'));
  check('the play/pause key pauses the last-played tab', await until('b paused', () => inPage(b, 'window.__el.paused')), 'still playing');
  check('...and leaves the other one playing', await inPage(a, '!window.__el.paused'), 'a paused');
  rows = await until('b listed as paused', async () => { const l = await list(); return l.find((x) => x.id === b && !x.playing) ? l : null; });
  check('a paused tab stays listed so it can be resumed', Boolean(rows), JSON.stringify(await list()));
  await app.evaluate(() => global.__mediaHub.mediaKey('MediaPlayPause'));
  check('the play/pause key again resumes it', await until('b playing', () => inPage(b, '!window.__el.paused')), 'still paused');
  await app.evaluate(() => global.__mediaHub.mediaKey('MediaPlayPause'));
  await until('b paused again', () => inPage(b, 'window.__el.paused'));
  // The next-track key goes to the last tab that started playing (b): it has no handler, so nothing happens in a.
  await app.evaluate(() => global.__mediaHub.mediaKey('MediaNextTrack'));
  await sleep(300);
  check('the next-track key does not reach a tab that did not play last', (await inPage(a, 'window.__next')) === 0, 'a got it');
  await inPage(a, 'window.__el.pause()'); await until('a paused', () => inPage(a, 'window.__el.paused')); await sleep(400);
  await inPage(a, 'window.__el.play().then(() => "ok")'); // a starts playing again: now it is the last played
  await until('a first', async () => (await list())[0]?.id === a);
  await app.evaluate(() => global.__mediaHub.mediaKey('MediaNextTrack'));
  check('the next-track key calls the page\'s own handler on the last-played tab', await until('a next', async () => (await inPage(a, 'window.__next')) === 1), await inPage(a, 'window.__next'));
  await app.evaluate(() => global.__mediaHub.mediaKey('MediaPreviousTrack'));
  check('the previous-track key calls the page\'s handler', await until('a prev', async () => (await inPage(a, 'window.__prev')) === 1), await inPage(a, 'window.__prev'));

  step = 'the pop-up';
  await ui.click('#media-btn');
  await until('the panel open', () => ui.evaluate(() => !document.getElementById('media-panel')?.hidden));
  const pop = await ui.evaluate(() => {
    const p = document.getElementById('media-panel');
    const rows = [...p.querySelectorAll('.media-row')];
    const named = [...p.querySelectorAll('button')].every((x) => (x.getAttribute('aria-label') || '').trim().length > 0);
    const r0 = rows[0];
    return {
      role: p.getAttribute('role'), label: p.getAttribute('aria-label'), expanded: document.getElementById('media-btn').getAttribute('aria-expanded'),
      rows: rows.map((r) => ({ id: Number(r.dataset.id), title: r.querySelector('.media-title').textContent, sub: r.querySelector('.media-sub')?.textContent || '', ctls: [...r.querySelectorAll('.media-ctl')].map((x) => x.dataset.ctl), img: r.querySelector('.media-art img')?.getAttribute('src') || '' })),
      named, focusInPanel: p.contains(document.activeElement),
      bg: getComputedStyle(p).backgroundColor, token: getComputedStyle(document.documentElement).getPropertyValue('--surface-raised').trim(),
      firstFocus: document.activeElement?.dataset.ctl, firstRowId: Number(r0?.dataset.id),
    };
  });
  check('the pop-up is a named dialog and the button says it is open', pop.role === 'dialog' && pop.label && pop.expanded === 'true', JSON.stringify(pop));
  check('the pop-up lists the two tones, newest first, and not the muted video', pop.rows.map((r) => r.id).join() === `${a},${b}`, JSON.stringify(pop.rows));
  const pa = pop.rows.find((r) => r.id === a);
  check('the session row shows title, artist and artwork', pa?.title === 'Test Tone' && pa?.sub === 'Lumen Band' && /^data:image/.test(pa?.img || ''), JSON.stringify(pa));
  check('the session row has previous, play/pause, next and mute', pa?.ctls.join() === 'prev,playpause,next,mute', JSON.stringify(pa));
  check('the plain row has play/pause and mute only', pop.rows.find((r) => r.id === b)?.ctls.join() === 'playpause,mute', JSON.stringify(pop.rows));
  check('every control has an accessible name', pop.named, 'unnamed button');
  check('the focus goes into the pop-up, on the first row\'s play/pause', pop.focusInPanel && pop.firstFocus === 'playpause', JSON.stringify(pop));
  check('the pop-up uses the theme\'s raised surface', pop.bg && pop.token && pop.bg !== 'rgba(0, 0, 0, 0)', `${pop.bg} vs ${pop.token}`);

  if (process.env.MEDIA_SHOT) { await sleep(300); await ui.screenshot({ path: process.env.MEDIA_SHOT, clip: await ui.evaluate(() => { const r = document.getElementById('media-panel').getBoundingClientRect(); return { x: Math.max(0, r.left - 40), y: 0, width: r.width + 80, height: r.bottom + 20 }; }) }); } // (a picture of the pop-up, to look at)
  step = 'pop-up controls';
  const clickCtl = (id, ctl) => ui.evaluate(([id, ctl]) => document.querySelector(`#media-panel .media-row[data-id="${id}"] [data-ctl="${ctl}"]`)?.click(), [id, ctl]);
  await clickCtl(a, 'next');
  check('Next in the pop-up calls the page\'s handler', await until('next 2', async () => (await inPage(a, 'window.__next')) === 2), await inPage(a, 'window.__next'));
  await clickCtl(a, 'prev');
  check('Previous in the pop-up calls the page\'s handler', await until('prev 2', async () => (await inPage(a, 'window.__prev')) === 2), await inPage(a, 'window.__prev'));
  await clickCtl(a, 'playpause');
  check('Pause in the pop-up pauses the page', await until('a paused', () => inPage(a, 'window.__el.paused')), 'still playing');
  check('the row redraws as paused (a Play button)', await until('row paused', () => ui.evaluate((id) => /^Play /.test(document.querySelector(`#media-panel .media-row[data-id="${id}"] [data-ctl="playpause"]`)?.getAttribute('aria-label') || ''), a)), 'still Pause');
  await clickCtl(a, 'playpause');
  check('Play in the pop-up resumes the page', await until('a playing', () => inPage(a, '!window.__el.paused')), 'still paused');
  await clickCtl(a, 'mute');
  const mutedTab = () => ui.evaluate((id) => lastTabState.tabs.find((t) => t.id === id)?.muted, a);
  check('Mute in the pop-up mutes the tab', await until('a muted', mutedTab), 'not muted');
  check('the mute button says it is pressed', await until('pressed', () => ui.evaluate((id) => document.querySelector(`#media-panel .media-row[data-id="${id}"] [data-ctl="mute"]`)?.getAttribute('aria-pressed') === 'true', a)), 'not pressed');

  step = 'keyboard';
  await ui.evaluate((id) => document.querySelector(`#media-panel .media-row[data-id="${id}"] [data-ctl="playpause"]`)?.focus(), a);
  await ui.keyboard.press('ArrowDown');
  check('↓ moves to the same control on the next row', await ui.evaluate((id) => document.activeElement?.closest('.media-row')?.dataset.id === String(id) && document.activeElement?.dataset.ctl === 'playpause', b), await ui.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)));
  await ui.keyboard.press('ArrowDown');
  check('↓ on the last row wraps to the first', await ui.evaluate((id) => document.activeElement?.closest('.media-row')?.dataset.id === String(id), a), 'no wrap');
  await ui.keyboard.press('Escape');
  check('Esc closes the pop-up and gives the focus back to the button', await ui.evaluate(() => document.getElementById('media-panel').hidden && document.activeElement?.id === 'media-btn' && document.getElementById('media-btn').getAttribute('aria-expanded') === 'false'), 'still open');

  step = 'the speaker on the tab';
  const speaker = () => ui.evaluate((id) => { const s = document.querySelector(`#tabs .tab[data-id="${id}"] .tab-audio`); return s ? { muted: s.classList.contains('muted'), label: s.getAttribute('aria-label') } : null; }, a);
  const sp = await until('the tab speaker', speaker);
  check('the muted tab shows its speaker, crossed out, with a name', sp?.muted === true && /^Unmute tab/.test(sp?.label || ''), JSON.stringify(sp));
  await ui.evaluate((id) => document.querySelector(`#tabs .tab[data-id="${id}"] .tab-audio`)?.click(), a);
  check('a click on the tab\'s speaker unmutes it', await until('unmuted', async () => (await mutedTab()) === false), 'still muted');
  const rowMuted = await until('the list follows', async () => (await list()).find((x) => x.id === a)?.muted === false);
  check('...and the media list follows', rowMuted, JSON.stringify(await list()));

  step = 'go to tab';
  await ui.click('#media-btn');
  await until('open again', () => ui.evaluate(() => !document.getElementById('media-panel').hidden));
  await ui.evaluate((id) => document.querySelector(`#media-panel .media-row[data-id="${id}"] .media-go`)?.click(), b);
  check('a click on a row goes to that tab and closes the pop-up', await until('b active', () => ui.evaluate((id) => lastTabState.activeId === id && document.getElementById('media-panel').hidden, b)), await ui.evaluate(() => lastTabState.activeId));

  step = 'leaving and closing';
  await app.evaluate(({ webContents }, [id, u]) => webContents.getAllWebContents().find((w) => w.__lumenTabId === id)?.loadURL(u), [b, `${base}/plain`]);
  check('a tab that leaves the page drops out of the list', await until('b gone', async () => !(await list()).some((x) => x.id === b)), JSON.stringify(await list()));
  await inPage(a, 'window.__el.pause()');
  await app.evaluate(({ webContents }, id) => webContents.getAllWebContents().find((w) => w.__lumenTabId === id)?.close(), a);
  check('with every playing tab gone the list is empty', await until('empty', async () => (await list()).length === 0), JSON.stringify(await list()));
  check('...and the media button hides', await until('hidden', () => ui.evaluate(() => document.getElementById('media-btn').hidden)), 'shown');
  check('the media keys are never held in a test run', await app.evaluate(() => global.__mediaHub.keysHeld() === false), 'held');

  check('no page errors in the window', errors.length === 0, errors.join(' | '));
  try { await app.close(); } catch {}
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => giveUp(err.stack || err.message));
