// The search on the engine cards (Apple Music and Spotify) in a real window, offline: a stand-in engine (the main process hands the widgets a
// fake for the engine's calls, in test mode only) so that what is tested is the card: the magnifier in the header (also while playing), the
// field and the panel laid over the card without moving it, typing with a short pause before the search is sent, results grouped
// Songs, Albums, Artists, Playlists with a picture, title, artist and length, arrow keys, Enter and Escape, Play next and Add to queue
// where the service has them, the last five searches when the field is empty, songs only in a small card, and the typing surviving the
// card being drawn again. Set LUMEN_APPLEMUSIC_SHOTS=<dir> to keep screenshots.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.LUMEN_APPLEMUSIC_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const ART = (() => {
  const zlib = require('zlib');
  const W = 48;
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = 250 - x * 3; raw[o + 1] = 35 + y * 3; raw[o + 2] = 59 + ((x ^ y) & 63); }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
})();

const SERVICES = [
  { type: 'applemusic', fake: '__appleMusicFake', name: 'Apple Music', queue: true, note: /short previews/, slug: 'apple' },
  { type: 'spotify', fake: '__spotifyEngineFake', name: 'Spotify', queue: false, note: /Sign in to Spotify to play/, slug: 'spotify' },
];

(async () => {
  for (const svc of SERVICES) await run(svc);
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function run(svc) {
  const label = svc.name.toLowerCase();
  const W = [
    { id: 'wsmall001', type: svc.type, mode: 'status', x: 0, y: 0, w: 2, h: 2 },
    { id: 'wdefault1', type: svc.type, mode: 'status', x: 2, y: 0, w: 4, h: 4 },
  ];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-musicsearch-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: W, newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, { g, art, queue }) => {
    const result = (id, kind, title, sub, ms) => ({ id, kind, title, sub, ms, thumb: kind === 'artist' || kind === 'playlist' ? '' : art });
    global.__fx = {
      calls: { search: [], searchAt: [], play: [], next: [], later: [], control: [] },
      card: { mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 30000, durationMs: 200000, at: Date.now(), source: 'engine', kind: 'track', reason: '', art, signedIn: true, preview: false, can: { search: true, lists: queue, seek: true, queue }, recent: [], playlists: [], results: [], query: '', searching: false, searchOk: true, error: '' },
      results: (term) => [result('s1', 'song', `${term} (Song one)`, 'Taylor Swift', 219000), result('s2', 'song', `${term} (Song two)`, 'Ann', 187000), result('s3', 'song', `${term} (Song three)`, 'Bo', 65000), result('a1', 'album', '1989', 'Taylor Swift', 0), result('r1', 'artist', 'Taylor Swift', '', 0), result('p1', 'playlist', 'Hits', 'Curator', 0)],
    };
    global[g] = {
      read: async () => ({ ...global.__fx.card, at: Date.now() }),
      control: async (n) => { global.__fx.calls.control.push(n); return true; },
      seek: () => true,
      playItem: (kind, id) => { global.__fx.calls.play.push(`${kind}:${id}`); return true; },
      playNext: (kind, id) => { global.__fx.calls.next.push(`${kind}:${id}`); return queue; },
      playLater: (kind, id) => { global.__fx.calls.later.push(`${kind}:${id}`); return queue; },
      search: (term) => {
        global.__fx.calls.search.push(term);
        global.__fx.calls.searchAt.push(Date.now());
        const t = String(term || '').trim();
        global.__fx.card = { ...global.__fx.card, query: t, searching: Boolean(t), results: [] };
        setTimeout(() => { global.__fx.card = { ...global.__fx.card, searching: false, results: t ? global.__fx.results(t) : [] }; global.__widgets.engineChanged(); }, 60);
        global.__widgets.engineChanged();
        return true;
      },
      signIn: () => true, refreshLists: () => {}, reload: () => {},
    };
  }, { g: svc.fake, art: ART, queue: svc.queue });
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
  const waitFor = async (code, tries = 60) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(100); } return false; };
  const shot = async (name) => { if (shots) fs.writeFileSync(path.join(shots, name), Buffer.from(await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64')), 'base64')); };
  const calls = () => app.evaluate(() => global.__fx.calls);
  const card = (id) => `(document.querySelector('.w-card[data-id="${id}"]') || document.createElement('i'))`;
  const D = 'wdefault1';
  const S = 'wsmall001';
  const typeInto = (id, value) => page(`(() => { const i = ${card(id)}.querySelector('.am-searchfield input'); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const key = (id, k) => page(`${card(id)}.querySelector('.am-searchfield input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
  const popOpen = (id) => page(`(() => { const p = ${card(id)}.querySelector('.am-pop'); return Boolean(p) && !p.hidden; })()`);
  await page(`localStorage.clear()`);
  await app.evaluate(async () => { for (const e of global.__widgets.cache.values()) if (e.pending) await e.pending; for (const e of global.__widgets.cache.values()) { e.at = 0; e.retryAt = 0; } return global.__widgets.refreshAll({ force: true }); });

  check(`${label}: the magnifier is in the header while a song is playing (not only when idle)`, await waitFor(`${card(D)}.querySelector('.sp-title')?.textContent === 'Night Shift' && Boolean(${card(D)}.querySelector('.w-head .am-searchbtn'))`), '');
  check(`${label}: the panel is closed until the search is opened`, !(await popOpen(D)), '');
  const rectBefore = await page(`(() => { const r = ${card(D)}.getBoundingClientRect(); const w = ${card(D)}.querySelector('.sp-wrap').getBoundingClientRect(); const c = ${card(D)}.querySelector('.sp-controls').getBoundingClientRect(); return [Math.round(r.height), Math.round(w.top), Math.round(c.top)]; })()`);
  await page(`${card(D)}.querySelector('.am-searchbtn').click()`);
  check(`${label}: the magnifier opens the field and focuses it; the combobox says it is expanded`, await page(`(() => { const i = ${card(D)}.querySelector('.am-searchfield input'); return document.activeElement === i && i.getAttribute('aria-expanded') === 'true' && getComputedStyle(i).display !== 'none' && ${card(D)}.querySelector('.am-searchbtn').getAttribute('aria-expanded') === 'true'; })()`), '');
  check(`${label}: empty and focused with no history it says to type`, await page(`/Type to search ${svc.name}/.test(${card(D)}.querySelector('.am-pop').textContent)`), '');

  // typing: one search for a burst of keys, after a short pause
  const lastKey = await page(`(async () => { const i = ${card(D)}.querySelector('.am-searchfield input'); i.focus(); for (const v of ['s', 'sh', 'sha', 'shak', 'shake']) { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 40)); } return Date.now(); })()`); // (a burst of keys, typed inside the page so the gaps are real)
  await sleep(500);
  check(`${label}: a burst of keys is one search with the whole text, sent after a pause of about a quarter of a second (not per key)`, JSON.stringify((await calls()).search) === '["shake"]' && (await calls()).searchAt[0] - lastKey >= 200 && (await calls()).searchAt[0] - lastKey < 600, JSON.stringify([(await calls()).search, (await calls()).searchAt[0] - lastKey]));
  check(`${label}: while it waits the panel says searching, then the results show`, await waitFor(`${card(D)}.querySelectorAll('.am-opt:not(.am-opt-recent)').length === 6`), await page(`${card(D)}.querySelector('.am-pop')?.textContent || ''`));
  const headings = await page(`[...${card(D)}.querySelectorAll('.am-pop .am-heading')].map((h) => h.textContent)`);
  check(`${label}: grouped Songs, Albums, Artists, Playlists, in that order`, JSON.stringify(headings) === '["Songs","Albums","Artists","Playlists"]', JSON.stringify(headings));
  const first = await page(`(() => { const o = ${card(D)}.querySelector('.am-songs .am-opt'); return { title: o.querySelector('.am-title').textContent, sub: o.querySelector('.am-sub').textContent, dur: o.querySelector('.am-dur').textContent, thumb: Boolean(o.querySelector('img.am-thumb')), role: o.getAttribute('role') }; })()`);
  check(`${label}: a song row has its picture, title, artist and length`, first.title === 'shake (Song one)' && first.sub === 'Taylor Swift' && first.dur === '3:39' && first.thumb && first.role === 'option', JSON.stringify(first));
  check(`${label}: the typing survived the card being drawn again (the field has its text and the focus)`, await page(`(() => { const i = ${card(D)}.querySelector('.am-searchfield input'); return document.activeElement === i && i.value === 'shake'; })()`), '');
  const rectAfter = await page(`(() => { const r = ${card(D)}.getBoundingClientRect(); const w = ${card(D)}.querySelector('.sp-wrap').getBoundingClientRect(); const c = ${card(D)}.querySelector('.sp-controls').getBoundingClientRect(); return [Math.round(r.height), Math.round(w.top), Math.round(c.top)]; })()`);
  check(`${label}: the panel is laid over the card: the layout under it did not move`, JSON.stringify(rectBefore) === JSON.stringify(rectAfter) && await page(`getComputedStyle(${card(D)}.querySelector('.am-pop')).position === 'absolute' && ${card(D)}.contains(${card(D)}.querySelector('.am-pop'))`), JSON.stringify([rectBefore, rectAfter]));
  const queueButtons = await page(`${card(D)}.querySelectorAll('.am-songs .am-optrow')[0].querySelectorAll('.am-act').length`);
  check(`${label}: ${svc.queue ? 'songs have Play next and Add to queue' : 'there is no Play next or Add to queue (this service has none)'}`, svc.queue ? queueButtons === 2 : queueButtons === 0, String(queueButtons));
  await shot(`search-${svc.slug}-results.png`);

  // keyboard
  await key(D, 'ArrowDown');
  const act1 = await page(`(() => { const list = [...${card(D)}.querySelectorAll('.am-opt')]; const i = ${card(D)}.querySelector('.am-searchfield input'); return { idx: list.findIndex((b) => b.classList.contains('active')), sel: list[0].getAttribute('aria-selected'), ad: i.getAttribute('aria-activedescendant') === list[0].id }; })()`);
  check(`${label}: ArrowDown highlights the first result (aria-selected and aria-activedescendant follow)`, act1.idx === 0 && act1.sel === 'true' && act1.ad, JSON.stringify(act1));
  await key(D, 'ArrowDown'); await key(D, 'ArrowDown'); await key(D, 'ArrowUp');
  check(`${label}: the arrows move one at a time`, await page(`[...${card(D)}.querySelectorAll('.am-opt')].findIndex((b) => b.classList.contains('active'))`) === 1, '');
  await key(D, 'ArrowUp'); await key(D, 'ArrowUp');
  check(`${label}: ArrowUp from the first wraps to the last`, await page(`[...${card(D)}.querySelectorAll('.am-opt')].findIndex((b) => b.classList.contains('active'))`) === 5, '');
  await shot(`search-${svc.slug}-keyboard.png`);
  await key(D, 'Enter');
  await sleep(300);
  check(`${label}: Enter plays the highlighted result (kind and id), and the panel closes`, (await calls()).play.join() === 'playlist:p1' && !(await popOpen(D)), JSON.stringify((await calls()).play));

  // Enter with nothing highlighted: the first song
  await page(`${card(D)}.querySelector('.am-searchbtn').click()`);
  await typeInto(D, 'again');
  await waitFor(`${card(D)}.querySelectorAll('.am-opt:not(.am-opt-recent)').length === 6`);
  await key(D, 'Enter');
  await sleep(300);
  check(`${label}: Enter with nothing highlighted plays the first song`, (await calls()).play.at(-1) === 'song:s1', JSON.stringify((await calls()).play));

  // play next / queue
  await page(`${card(D)}.querySelector('.am-searchbtn').click()`);
  await typeInto(D, 'queue');
  await waitFor(`${card(D)}.querySelectorAll('.am-opt:not(.am-opt-recent)').length === 6`);
  if (svc.queue) {
    await page(`${card(D)}.querySelectorAll('.am-songs .am-optrow')[1].querySelectorAll('.am-act')[0].click()`);
    await page(`${card(D)}.querySelectorAll('.am-songs .am-optrow')[2].querySelectorAll('.am-act')[1].click()`);
    await sleep(300);
    const c = await calls();
    check(`${label}: Next and Queue send that song to the engine, and the panel stays for more`, c.next.join() === 'song:s2' && c.later.join() === 'song:s3' && await popOpen(D), JSON.stringify([c.next, c.later]));
  }

  // escape and clicking outside
  await key(D, 'Escape');
  check(`${label}: Escape closes the panel and gives the focus back to the magnifier`, !(await popOpen(D)) && await page(`document.activeElement === ${card(D)}.querySelector('.am-searchbtn')`), '');
  await page(`${card(D)}.querySelector('.am-searchbtn').click()`);
  await page(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  check(`${label}: a click outside the card closes it`, !(await popOpen(D)), '');

  // recent searches
  const termsList = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
  for (const t of termsList) {
    await page(`${card(D)}.querySelector('.am-searchbtn').click()`);
    await typeInto(D, t);
    await waitFor(`${card(D)}.querySelectorAll('.am-opt:not(.am-opt-recent)').length === 6`);
    await key(D, 'Enter');
    await sleep(150);
  }
  await page(`${card(D)}.querySelector('.am-searchbtn').click()`);
  await page(`(() => { const i = ${card(D)}.querySelector('.am-searchfield input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(450);
  const recent = await page(`[...${card(D)}.querySelectorAll('.am-opt-recent')].map((b) => b.textContent)`);
  check(`${label}: the field, empty, shows the last five searches, newest first (remembered on this card only)`, JSON.stringify(recent) === '["eta","zeta","epsilon","delta","gamma"]' && /Recent searches/.test(await page(`${card(D)}.querySelector('.am-pop').textContent`)) && await page(`localStorage.getItem('lumen-music-recent:${D}') !== null && localStorage.getItem('lumen-music-recent:${S}') === null`), JSON.stringify(recent));
  await shot(`search-${svc.slug}-recent.png`);
  const before = (await calls()).search.length;
  await page(`${card(D)}.querySelectorAll('.am-opt-recent')[1].click()`);
  await sleep(400);
  check(`${label}: choosing a recent search searches it at once`, (await calls()).search.at(-1) === 'zeta' && (await calls()).search.length > before, JSON.stringify((await calls()).search.slice(-2)));
  await key(D, 'Escape');

  // signed out, no results, a search that failed
  await app.evaluate(() => { global.__fx.card = { ...global.__fx.card, signedIn: false }; global.__widgets.engineChanged(); });
  await page(`${card(D)}.querySelector('.am-searchbtn').click()`);
  await typeInto(D, 'nothing');
  await waitFor(`${card(D)}.querySelectorAll('.am-opt:not(.am-opt-recent)').length === 6`);
  check(`${label}: signed out, the panel says so (${svc.queue ? 'previews' : 'sign in to play'})`, await page(`${svc.note}.test(${card(D)}.querySelector('.am-pop').textContent)`), await page(`${card(D)}.querySelector('.am-pop').textContent`));
  await app.evaluate(() => { global.__fx.results = () => []; });
  await typeInto(D, 'zzzz');
  check(`${label}: no results says so`, await waitFor(`/No results/.test(${card(D)}.querySelector('.am-pop')?.textContent || '')`), await page(`${card(D)}.querySelector('.am-pop').textContent`));
  await app.evaluate(() => { global.__fx.card = { ...global.__fx.card, searchOk: false, query: 'zzzz', results: [] }; global.__widgets.engineChanged(); });
  check(`${label}: a search the service could not answer says it may have changed its page`, await waitFor(`/may have changed its page/.test(${card(D)}.querySelector('.am-pop')?.textContent || '')`), await page(`${card(D)}.querySelector('.am-pop').textContent`));
  await key(D, 'Escape');

  // a small card: songs only
  await app.evaluate(() => { global.__fx.results = (term) => [{ id: 's1', kind: 'song', title: `${term} one`, sub: 'A', ms: 100000, thumb: '' }, { id: 'a1', kind: 'album', title: 'Album', sub: 'A', ms: 0, thumb: '' }, { id: 'r1', kind: 'artist', title: 'Artist', sub: '', ms: 0, thumb: '' }]; global.__fx.card = { ...global.__fx.card, searchOk: true, signedIn: true }; global.__widgets.engineChanged(); });
  await page(`${card(S)}.querySelector('.am-searchbtn').click()`);
  await typeInto(S, 'tiny');
  await waitFor(`${card(S)}.querySelectorAll('.am-opt:not(.am-opt-recent)').length === 3`);
  const small = await page(`(() => ({ w: Math.round(${card(S)}.getBoundingClientRect().width), groups: [...${card(S)}.querySelectorAll('.am-group')].filter((g) => getComputedStyle(g).display !== 'none').map((g) => g.querySelector('.am-heading').textContent), inside: ${card(S)}.querySelector('.am-pop').getBoundingClientRect().right <= ${card(S)}.getBoundingClientRect().right + 1 }))()`);
  check(`${label}: in a small card (${small.w} px) only the songs are listed, and the panel stays inside the card`, small.w < 300 && JSON.stringify(small.groups) === '["Songs"]' && small.inside, JSON.stringify(small));
  await shot(`search-${svc.slug}-small.png`);
  await key(S, 'Escape');

  check(`${label}: no console errors on the new-tab page`, (await app.evaluate(() => global.__errs)).length === 0, JSON.stringify(await app.evaluate(() => global.__errs)));
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}
