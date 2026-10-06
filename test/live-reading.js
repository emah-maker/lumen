// Opt-in live check of the reading, page-debug and video tools against the real web (not in npm test: needs the
// network and real sites that change). Run: LUMEN_LIVE=1 node test/live-reading.js [outDir]
// One app session in a throwaway profile; local fixtures for console/network/dialogs/video. Prints PASS/FAIL with
// timings, and writes every tool result (trimmed) and the video contact sheet to outDir (default: the OS temp folder).
if (!process.env.LUMEN_LIVE) { console.log('SKIP  live-reading needs LUMEN_LIVE=1 (it reads real sites)'); process.exit(0); }
const { _electron: electron } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-live-'));
fs.mkdirSync(OUT, { recursive: true });
let app = null;
const VIDEO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

(async () => {
  let video = null;
  try { video = Buffer.from(await (await fetch(VIDEO_URL)).arrayBuffer()); } catch (err) { console.log('note: could not fetch the test video:', err.message); }
  const pages = {
    '/debug': '<title>Debug</title><p>debug page</p><img src="/missing.png"><script>console.error("live-check boom");console.warn("live-check warn");fetch("/api/data?x=1").catch(()=>{})</script>',
    '/later': '<title>Later</title><p id=bye>going away</p><script>setTimeout(()=>{document.getElementById("bye").remove();location.hash="done"},800);setTimeout(()=>fetch("/slow"),100)</script>',
    '/alert': '<title>Alert</title><button onclick="alert(\'hi there\');document.title=\'after-alert\'">Alert me</button>',
    '/confirm': '<title>Confirm</title><button onclick="document.title=\'confirmed:\'+confirm(\'Really?\')">Confirm me</button>',
    '/video': '<title>Video</title><video id=v src="/flower.mp4" muted width=640 playsinline></video>',
  };
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/flower.mp4' && video) { res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Accept-Ranges', 'bytes'); return res.end(video); }
    if (p === '/slow') return setTimeout(() => res.end('ok'), 1200);
    if (p === '/api/data') { res.setHeader('Content-Type', 'application/json'); return res.end('{"ok":true}'); }
    if (pages[p]) { res.setHeader('Content-Type', 'text/html'); return res.end(pages[p]); }
    res.statusCode = 404; res.end('nope');
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-live-profile-'));
  app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  const bail = setTimeout(() => { console.error('live-reading: 13 min cap, closing'); app.close().finally(() => process.exit(1)); }, 13 * 60000);
  await ui.waitForSelector('.tab');

  // Runs a tool through the agent (or, mcp: true, as an outside MCP agent would, in the user's window); returns
  // { ms, text, images: [base64...] }.
  const run = (name, input, { mcp = false, timeout = 90000 } = {}) => app.evaluate(async (_e, [n, i, viaMcp, t]) => {
    const started = Date.now();
    const flat = (r) => {
      if (typeof r === 'string') return { text: r, images: [] };
      const blocks = Array.isArray(r) ? r : r?.content || [r];
      return { text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n'), images: blocks.filter((b) => b?.type === 'image').map((b) => b.source?.data || b.data) };
    };
    try {
      global.__mcpSharedWindow = true;
      global.__liveSession ||= { approvedHosts: new Set(), clientName: 'LiveCheck', controller: new AbortController() };
      const work = viaMcp ? global.__mcpCallTool(n, i, global.__liveSession) : global.__agent.execute(n, i);
      const r = await Promise.race([work, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${t} ms`)), t))]);
      return { ms: Date.now() - started, ...flat(r), isError: Boolean(r?.isError) };
    } catch (err) { return { ms: Date.now() - started, text: 'ERROR: ' + err.message, images: [] }; }
  }, [name, input, mcp, timeout]);
  const js = (code) => app.evaluate((_e, c) => Promise.race([global.__agent.browser.activeTab().webContents.executeJavaScript(c), new Promise((r) => setTimeout(r, 10000, 'ERROR: page did not answer in 10 s'))]), code);
  const log = [];
  const rows = [];
  const save = () => fs.writeFileSync(path.join(OUT, 'live-results.json'), JSON.stringify({ rows, log }, null, 1));
  const keep = (label, r) => { log.push({ label, ms: r.ms, text: String(r.text).slice(0, 4000), images: r.images?.length || 0 }); save(); return r; };
  const check = (label, ok, ms, evidence) => { rows.push({ label, ok: Boolean(ok), ms, evidence: String(evidence).replace(/\s+/g, ' ').slice(0, 220) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ms != null ? ` (${ms} ms)` : ''}  -- ${String(evidence).replace(/\s+/g, ' ').slice(0, 220)}`); };
  const head = (r, n = 160) => String(r.text).slice(0, n);
  const line = (r, re) => (String(r.text).match(re) || [''])[0];

  // ---- 1. read_urls speed, completeness, paging, cache
  const WIKI = 'https://en.wikipedia.org/wiki/Electron_(software_framework)';
  // (first: a fresh MCP session has read nothing, so read_urls needs no approval card; after a read it asks, by design)
  const mcpRead = keep('mcp read_urls', await run('read_urls', { urls: ['https://en.wikipedia.org/wiki/Chromium_(web_browser)'], max_chars: 2000 }, { mcp: true }));
  check('1 MCP read_urls via the MCP path', !mcpRead.isError && mcpRead.text.length > 1000, mcpRead.ms, head(mcpRead, 120));
  const VERGE = 'https://www.theverge.com';
  for (const [u, label] of [[VERGE, 'verge'], [WIKI, 'wiki']]) {
    const d = keep(`${label} default`, await run('read_urls', { urls: [u] }));
    const l = keep(`${label} load`, await run('read_urls', { urls: [u + (u.includes('?') ? '&' : '?') + 'lc=load'], wait: 'load' }));
    check(`1 read_urls ${label}: default vs wait:load`, !d.text.startsWith('ERROR') && !l.text.startsWith('ERROR') && d.text.length > 2000, d.ms, `default ${d.ms} ms / ${d.text.length} chars; load ${l.ms} ms / ${l.text.length} chars`);
    if (label === 'wiki') {
      const heads = (d.text.match(/^#{1,3} .+$/gm) || []).slice(0, 6);
      check('1 wikipedia: markdown headings', heads.length >= 1, null, heads.join(' | '));
      const c1 = keep('wiki page1', await run('read_urls', { urls: [WIKI], max_chars: 3000 }));
      const c2 = keep('wiki page2', await run('read_urls', { urls: [WIKI], max_chars: 3000, offset: 3000 }));
      const body = (r) => r.text.replace(/[\s\S]*?<untrusted_page_content[^>]*>/, '').slice(0, 300);
      check('1 wikipedia: max_chars/offset gives the next chunk', c2.text.length > 500 && body(c1) !== body(c2) && !c2.text.startsWith('ERROR'), c2.ms, `p1 ${c1.text.length}ch; p2 ${c2.text.length}ch; hints: ${line(c1, /.{0,40}offset.{0,60}/i)}`);
      const again = keep('wiki repeat', await run('read_urls', { urls: [WIKI] }));
      check('1 wikipedia: repeat read is a cache hit (fast)', again.ms < Math.max(400, d.ms / 4), again.ms, `first ${d.ms} ms, repeat ${again.ms} ms; ${line(again, /.{0,30}cache.{0,40}/i)}`);
    }
  }

  // ---- 2. page health
  for (const u of ['https://www.linkedin.com/feed/', 'https://x.com/home']) {
    const r = keep(`wall ${u}`, await run('read_urls', { urls: [u] }));
    check(`2 health: login wall ${u}`, /Page: wall/.test(r.text), r.ms, line(r, /Page: [^\n]+/) || head(r));
  }
  for (const u of ['https://www.bbc.co.uk/news/this-page-does-not-exist-12345', 'https://medium.com/@lumen-nonexistent-user-zz9/x', 'https://www.npmjs.com/package/lumen-surely-not-a-package-zz9']) {
    const r = keep(`404 ${u}`, await run('read_urls', { urls: [u] }));
    check(`2 health: not-found ${u}`, /soft_404|404|not found/i.test(r.text), r.ms, line(r, /Page: [^\n]+/) || line(r, /.{0,40}(404|not found).{0,40}/i) || head(r));
  }
  for (const u of ['https://app.slack.com/client', 'https://open.spotify.com/']) {
    const r = keep(`shell ${u}`, await run('read_urls', { urls: [u] }));
    check(`2 health: JS shell ${u}`, /Page: (js_shell|data_shell|wall)/.test(r.text), r.ms, line(r, /Page: [^\n]+/) || head(r));
  }

  // ---- 3. outline
  for (const u of ['https://news.ycombinator.com/', 'https://www.theverge.com/tech']) {
    await run('navigate', { url: u });
    const r = keep(`outline ${u}`, await run('read_page', { mode: 'outline' }));
    check(`3 outline ${u}`, /#|heading/i.test(r.text) && /link/i.test(r.text), r.ms, `${r.text.length}ch; next: ${line(r, /.{0,20}next.{0,60}/i)}; repeat: ${line(r, /.{0,20}(repeat|×|x\d+).{0,50}/i)}`);
  }

  // ---- 4. site readers
  let hnItem = null;
  try {
    const top = await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')).json();
    for (const id of top.slice(0, 15)) {
      const it = await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).json();
      if (it?.descendants > 20) { hnItem = `https://news.ycombinator.com/item?id=${id}`; break; }
    }
  } catch (err) { console.log('note: HN API', err.message); }
  const sub = keep('reddit sub', await run('read_urls', { urls: ['https://www.reddit.com/r/programming/'] }));
  const thread = (sub.text.match(/https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/programming\/comments\/[a-z0-9]+\/[^\s)\]"]*/i) || [])[0]
    || ((sub.text.match(/\/r\/programming\/comments\/[a-z0-9]+\/[^\s)\]"]*/i) || [])[0] ? 'https://www.reddit.com' + sub.text.match(/\/r\/programming\/comments\/[a-z0-9]+\/[^\s)\]"]*/i)[0] : null);
  check('4 reddit subreddit', /^Source: reddit|Source: reddit/m.test(sub.text), sub.ms, line(sub, /Source: [^\n]+/) || head(sub));
  const sites = [
    ['hn item', hnItem], ['youtube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'], ['x status', 'https://x.com/jack/status/20'],
    ['tiktok', 'https://www.tiktok.com/@scout2015/video/6718335390845095173'], ['github repo', 'https://github.com/electron/electron'],
    ['github issue', 'https://github.com/electron/electron/issues/24000'], ['reddit thread', thread],
  ];
  for (const [label, u] of sites) {
    if (label === 'reddit thread') await new Promise((r) => setTimeout(r, 6000)); // (Reddit rate-limits signed-out feed reads hard)
    if (!u) { check(`4 site ${label}`, false, null, 'no URL found'); continue; }
    const r = keep(`site ${label}`, await run('read_urls', { urls: [u] }));
    const src = line(r, /Source: [^\n]+/);
    const extra = label === 'youtube' ? ` transcript:${/\d+:\d\d/.test(r.text)}` : label.includes('hn') || label.includes('reddit thread') ? ` comment-lines:${(r.text.match(/\n\s*[-*]|\n\s+\S+ ·|points|score/gi) || []).length}` : '';
    check(`4 site ${label}`, Boolean(src), r.ms, `${src || 'FALLBACK: ' + head(r, 120)} ${r.text.length}ch${extra} ${u}`);
  }

  // ---- 5. read_page site view in a tab
  if (hnItem) {
    await run('navigate', { url: hnItem });
    const plain = keep('hn read_page', await run('read_page', {}));
    check('5 read_page on HN item -> site view', /Source: /.test(plain.text), plain.ms, line(plain, /Source: [^\n]+/) || head(plain));
    const compact = keep('hn compact', await run('read_page', { mode: 'compact' }));
    check('5 read_page mode:compact still gives element ids', /\[\d+\]/.test(compact.text), compact.ms, line(compact, /.{0,30}\[\d+\].{0,40}/));
    const viaMcp = keep('hn mcp read_page', await run('read_page', {}, { mcp: true }));
    check('5 MCP read_page (no mode) on HN item', /\[\d+\]|Source: /.test(viaMcp.text) && !viaMcp.isError, viaMcp.ms, line(viaMcp, /Source: [^\n]+/) || head(viaMcp, 120));
  }

  // ---- 6. debug tools
  await run('navigate', { url: `${base}/debug` });
  await new Promise((r) => setTimeout(r, 800));
  const cons = keep('console', await run('get_console', {}));
  check('6 get_console shows the error', /live-check boom/.test(cons.text), cons.ms, head(cons, 200));
  const net = keep('network', await run('get_network', { failed: true }));
  const netAll = keep('network all', await run('get_network', {}));
  check('6 get_network shows the 404 (no query by default)', /404/.test(net.text) && /missing\.png/.test(net.text) && !/x=1/.test(netAll.text), net.ms, head(net, 200));
  const netQ = keep('network query', await run('get_network', { include_query: true, url_contains: 'api' }));
  check('6 get_network include_query', /x=1/.test(netQ.text), netQ.ms, head(netQ, 160));
  await run('navigate', { url: `${base}/later` });
  const wUrl = keep('wait url', await run('wait_for', { url: '*#done', seconds: 5 }));
  check('6 wait_for url', !/ERROR|timed out|Timed out/i.test(wUrl.text), wUrl.ms, head(wUrl));
  await run('navigate', { url: `${base}/later?2` });
  const wGone = keep('wait gone', await run('wait_for', { gone: 'going away', seconds: 5 }));
  check('6 wait_for gone', !/ERROR|timed out|Timed out/i.test(wGone.text) && wGone.ms >= 300, wGone.ms, head(wGone));
  await run('navigate', { url: `${base}/later?3` });
  const wIdle = keep('wait idle', await run('wait_for', { network_idle: true, seconds: 8 }));
  check('6 wait_for network_idle (waits for the 1.2 s /slow)', !/ERROR|timed out|Timed out/i.test(wIdle.text) && wIdle.ms >= 600, wIdle.ms, head(wIdle));
  const wTo = keep('wait timeout', await run('wait_for', { text: 'never appears zz', seconds: 1 }));
  check('6 wait_for timeout says what is pending', /time|still|not/i.test(wTo.text), wTo.ms, head(wTo, 200));
  await run('navigate', { url: `${base}/alert` });
  const a = keep('alert click', await run('click', { text: 'Alert me' }));
  const aTitle = await js('document.title');
  check('6 alert auto-closed and mentioned', aTitle === 'after-alert' && /alert/i.test(a.text), a.ms, `title=${aTitle}; ${head(a, 160)}`);
  await run('navigate', { url: `${base}/confirm` });
  const c = keep('confirm click', await run('click', { text: 'Confirm me' }));
  const next = keep('after confirm', await run('get_console', { level: 'all' }));
  check('6 confirm held: header shows Dialog open', /Dialog open/.test(c.text + next.text), c.ms, line({ text: c.text + '\n' + next.text }, /Dialog open[^\n]*/));
  const hd = keep('handle_dialog', await run('handle_dialog', { accept: true }));
  await new Promise((r) => setTimeout(r, 300));
  const cTitle = await js('document.title');
  check('6 handle_dialog accept', cTitle === 'confirmed:true', hd.ms, `title=${cTitle}; ${head(hd, 120)}`);

  // ---- 7. video
  if (video) {
    await run('navigate', { url: `${base}/video` });
    await js('new Promise((r)=>{const v=document.getElementById("v");if(v.readyState>=2)r();else v.addEventListener("loadeddata",()=>r(),{once:true});setTimeout(r,5000)})');
    await js('(async()=>{const v=document.getElementById("v");v.currentTime=2.5;await new Promise(r=>v.addEventListener("seeked",r,{once:true}));})()');
    const before = await js('({t:document.getElementById("v").currentTime,paused:document.getElementById("v").paused})');
    const ov = keep('video_overview', await run('video_overview', { frames: 9 }));
    const after = await js('({t:document.getElementById("v").currentTime,paused:document.getElementById("v").paused})');
    if (ov.images[0]) fs.writeFileSync(path.join(OUT, 'contact-sheet-local.jpg'), Buffer.from(ov.images[0], 'base64'));
    check('7 video_overview returns a contact sheet', ov.images.length === 1 && ov.images[0].length > 5000, ov.ms, `${ov.images.length} image(s); ${head(ov, 160)}`);
    check('7 paused state restored', Math.abs(before.t - after.t) < 0.05 && after.paused === before.paused, null, `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    await js('document.getElementById("v").play()');
    await new Promise((r) => setTimeout(r, 300));
    const ov2 = keep('video_overview playing', await run('video_overview', { frames: 4 }));
    const after2 = await js('({t:document.getElementById("v").currentTime,paused:document.getElementById("v").paused})');
    check('7 playing state restored (still playing)', after2.paused === false && ov2.images.length === 1, ov2.ms, JSON.stringify(after2));
    await js('document.getElementById("v").pause()');
    const fr = keep('video_frames', await run('video_frames', { at: ['1', '0:03'] }));
    fr.images.forEach((img, i) => fs.writeFileSync(path.join(OUT, `frame-${i}.jpg`), Buffer.from(img, 'base64')));
    check('7 video_frames at 2 timestamps', fr.images.length === 2, fr.ms, `${fr.images.length} image(s); ${head(fr, 160)}`);
  } else check('7 video (local)', false, null, 'test video could not be fetched');
  await run('navigate', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  await new Promise((r) => setTimeout(r, 3000));
  const yt = keep('yt overview', await run('video_overview', { frames: 6 }, { timeout: 120000 }));
  if (yt.images[0]) fs.writeFileSync(path.join(OUT, 'contact-sheet-youtube.jpg'), Buffer.from(yt.images[0], 'base64'));
  check('7 YouTube video_overview', yt.images.length === 1, yt.ms, `${yt.images.length} image(s); ${head(yt, 200)}`);

  // ---- 8. Grok terminal switch renders in Settings > AI
  const { openSettingsTab } = require('./settings-tab');
  const inSettings = await openSettingsTab(app, 'you-and-ai');
  const sw = await inSettings('(() => { const i = document.getElementById("pref-grokTerminal"); if (!i) return null; const row = i.closest(".row") || i.parentElement; return { checked: i.checked, text: (row?.textContent || "").slice(0, 120), visible: Boolean(i.offsetParent || row?.offsetParent) }; })()');
  check('8 Settings > AI shows "Let Grok Build ask to run terminal commands" (on by default)', sw && sw.checked === true && /Grok Build/.test(sw.text), null, JSON.stringify(sw));

  save();
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed; results in ${OUT}`);
  clearTimeout(bail);
  await app.close();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* a locked file in the throwaway profile */ }
  process.exit(failed ? 1 : 0);
})().catch(async (err) => { console.error(err); try { await app?.close(); } catch { /* already gone */ } process.exit(1); });

