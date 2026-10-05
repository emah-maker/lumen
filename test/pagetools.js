// Page tools (features/page-tools.js): Save Page As, View Source, Reader mode and Picture in
// Picture, against local fixture pages. Also checks that the source and reader pages stay out of
// the AI's reach and that web pages can't open them.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PARAGRAPH = 'Lumen reader fixture paragraph. The quick brown fox jumps over the lazy dog, again and again, so that this block of text is long enough for Readability to treat it as the body of a real article rather than navigation or boilerplate. ';
const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test Article About Quick Foxes | Fixture Site</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article>
<h1>Test Article About Quick Foxes</h1>
<p class="byline">By Ada Fixture</p>
${[1, 2, 3, 4, 5, 6].map((n) => `<p>${n}. ${PARAGRAPH.repeat(3)}</p>`).join('\n')}
<p>Inline script below. <script>window.bad = 1;</script>
<img src="/pixel.png" onerror="window.bad = 2" alt="pixel"> <a href="javascript:window.bad=3">bad link</a> <a href="/next" id="good">good link</a></p>
<iframe src="/frame"></iframe>
</article>
<footer>Footer text</footer>
</body></html>`;
const SOURCE = '<!doctype html><html><head><title>Source Fixture</title></head><body>\n<!-- lumen-source-marker -->\n<p>Hello <b>source</b></p>\n<script>window.ranScript = 1; document.body.dataset.ran = "yes";</script>\n</body></html>';
const VIDEO = `<!doctype html><html><head><title>Video Fixture</title></head><body style="margin:0">
<video id="v" width="320" height="240" muted autoplay playsinline></video>
<canvas id="c" width="320" height="240" style="display:none"></canvas>
<script>
const c = document.getElementById('c'); const g = c.getContext('2d'); let n = 0;
setInterval(() => { g.fillStyle = n++ % 2 ? '#036' : '#063'; g.fillRect(0, 0, 320, 240); }, 100);
const v = document.getElementById('v'); v.srcObject = c.captureStream(10); v.play().catch(() => {});
</script></body></html>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await sleep(100); } return v; };

  const server = http.createServer((req, res) => {
    const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    if (req.url === '/article') return send('text/html; charset=utf-8', ARTICLE);
    if (req.url === '/source') return send('text/html; charset=utf-8', SOURCE);
    if (req.url === '/video') return send('text/html; charset=utf-8', VIDEO);
    if (req.url === '/pixel.png') return send('image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    send('text/html', '<!doctype html><title>Other</title><p>Other page</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pagetools-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pagetools-out-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // Opens `url` in a new foreground tab and waits for it to load; returns the tab id.
  const open = (url) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => t.webContents.once('did-finish-load', r));
    return t.id;
  }, url);
  const tabUrl = (id) => app.evaluate((_e, i) => global.__pageTools.tab(i)?.view.webContents.getURL() || '', id);
  const inTab = (id, js) => app.evaluate((_e, [i, code]) => global.__pageTools.tab(i).view.webContents.executeJavaScript(code), [id, js]);
  const shortcut = (input) => app.evaluate((_e, i) => global.__pageTools.handleShortcut(i), input);
  const ids = () => app.evaluate(() => global.__tabsArray().map((t) => t.id));
  const pages = { source: 'src/renderer/source.html', reader: 'src/renderer/reader.html' };

  // ---- Save Page As (Ctrl+S) ----
  const sourceTab = await open(`${base}/source`);
  await app.evaluate((_e, file) => { global.__pageToolsSaveDialog = (options) => { global.__lastSaveOptions = options; return { canceled: false, filePath: file }; }; }, path.join(out, 'saved.html'));
  await shortcut({ control: true, key: 's' });
  const saved = await waitFor(() => fs.existsSync(path.join(out, 'saved.html')) && fs.readFileSync(path.join(out, 'saved.html'), 'utf8'));
  check('Ctrl+S saves the page as complete HTML', typeof saved === 'string' && saved.includes('Hello'), saved);
  const options = await app.evaluate(() => global.__lastSaveOptions);
  check('the save dialog suggests the page title as the file name', /Source Fixture\.html$/.test(options?.defaultPath || ''), options?.defaultPath);
  await app.evaluate((_e, file) => { global.__pageToolsSaveDialog = () => ({ canceled: false, filePath: file }); }, path.join(out, 'saved.mhtml'));
  await shortcut({ control: true, key: 's' });
  const mhtml = await waitFor(() => fs.existsSync(path.join(out, 'saved.mhtml')) && fs.readFileSync(path.join(out, 'saved.mhtml'), 'utf8'));
  check('a .mhtml name saves a single-file MHTML archive', typeof mhtml === 'string' && /MIME-Version/i.test(mhtml), String(mhtml).slice(0, 120));
  await app.evaluate(() => { global.__pageToolsSaveDialog = () => ({ canceled: true }); });

  // ---- View Source (Ctrl+U) ----
  const before = await ids();
  await shortcut({ control: true, key: 'u' });
  const sourceView = await waitFor(async () => (await ids()).find((i) => !before.includes(i)));
  check('Ctrl+U opens the source in a new tab', Boolean(sourceView), await ids());
  const shown = await waitFor(() => inTab(sourceView, "document.body.dataset.ready === 'true' && document.getElementById('code').textContent"));
  check('the source tab shows the page\'s markup as text', typeof shown === 'string' && shown.includes('<!-- lumen-source-marker -->') && shown.includes('<b>source</b>'), shown);
  check('the source is not run as a page', (await inTab(sourceView, "typeof window.ranScript === 'undefined' && !document.body.dataset.ran && document.title.startsWith('Source of ')")) === true, await inTab(sourceView, 'document.title'));
  check('each source line is numbered on its own row', (await inTab(sourceView, "document.querySelectorAll('#code span').length")) === SOURCE.split('\n').length, await inTab(sourceView, "document.querySelectorAll('#code span').length"));
  check('the source tab is Lumen\'s own page', (await tabUrl(sourceView)).includes(pages.source), await tabUrl(sourceView));
  const address = await waitFor(async () => { const v = await ui.$eval('#address', (el) => el.value); return v.startsWith('view-source:') && v; });
  check('the address bar shows view-source:<url>', address === `view-source:${base}/source`, address);

  // Out of the AI's reach, and web pages can't open it.
  const listed = await app.evaluate(() => global.__agent.execute('list_tabs', {}));
  check('list_tabs leaves the source tab out', !String(listed).includes('source.html') && !String(listed).includes('view-source'), listed);
  const sourcePageUrl = await tabUrl(sourceView);
  const allUrls = async () => (await Promise.all((await ids()).map(tabUrl))).join('\n');
  const urlsBefore = await allUrls();
  const navigated = await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }).then(String, (e) => `threw: ${e.message}`), sourcePageUrl);
  check('the AI can\'t navigate to the source page', (await allUrls()) === urlsBefore, navigated);
  const viaScheme = await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: `view-source:${u}` }).then(String, (e) => `threw: ${e.message}`), `${base}/source`);
  check('the AI can\'t open view-source: either', (await allUrls()) === urlsBefore, viaScheme);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), sourceTab);
  await inTab(sourceTab, `location.href = ${JSON.stringify(sourcePageUrl)}; 1`).catch(() => {});
  await sleep(800); // must-not-happen: give a blocked navigation time to (not) land
  check('a web page can\'t navigate to the source page', (await tabUrl(sourceTab)) === `${base}/source`, await tabUrl(sourceTab));
  const countBefore = (await ids()).length;
  const opened = await inTab(sourceTab, `String(window.open(${JSON.stringify(`view-source:${base}/source`)}))`).catch((e) => e.message);
  await sleep(500); // must-not-happen: a new tab would appear within this time
  const urlsAfter = await Promise.all((await ids()).map(tabUrl));
  check('a web page can\'t open a view-source: window', urlsAfter.length === countBefore && !urlsAfter.some((u) => u.startsWith('view-source:')), `${opened} ${urlsAfter.join(' ')}`);

  // Typed view-source:<url> in the address bar shows the source in the current tab.
  await app.evaluate(({ ipcMain }, text) => ipcMain.emit('nav:go', {}, text), `view-source:${base}/source`);
  const typed = await waitFor(async () => (await tabUrl(sourceTab)).includes(pages.source));
  check('typing view-source:<url> shows the source in place', Boolean(typed), await tabUrl(sourceTab));

  // ---- Reader mode ----
  const articleTab = await open(`${base}/article`);
  const readerable = await waitFor(() => app.evaluate((_e, i) => global.__pageTools.tab(i).readerable, articleTab));
  check('an article page is detected as readerable', readerable === true, readerable);
  const button = await waitFor(() => ui.$eval('#reader', (el) => !el.hidden));
  check('the reader button shows in the address bar', button === true, button);
  await ui.$eval('#reader', (b) => b.click()); // a DOM click: the new tab left focus in the address bar, which hides the buttons
  const inReader = await waitFor(async () => (await tabUrl(articleTab)).includes(pages.reader) && inTab(articleTab, "document.body.dataset.ready === 'true'"));
  check('the reader button opens Reader mode in the same tab', inReader === true, await tabUrl(articleTab));
  const reader = await inTab(articleTab, `({
    title: document.getElementById('title').textContent,
    byline: document.getElementById('byline').textContent,
    text: document.getElementById('article').textContent,
    scripts: document.querySelectorAll('#article script, #article iframe').length,
    handlers: [...document.querySelectorAll('#article *')].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name) || a.name === 'style')).length,
    badLinks: [...document.querySelectorAll('#article a')].filter((a) => /^javascript:/i.test(a.getAttribute('href') || '')).length,
    goodLink: document.querySelector('#article a[href$="/next"]')?.href || '',
    nav: document.getElementById('article').textContent.includes('Footer text'),
    bad: typeof window.bad,
  })`);
  check('Reader mode shows the article title', reader.title === 'Test Article About Quick Foxes', reader.title);
  check('Reader mode keeps the article text', reader.text.includes('Lumen reader fixture paragraph') && reader.text.includes('6. '), reader.text.slice(0, 120));
  check('Reader mode drops scripts, frames, handlers and styles', reader.scripts === 0 && reader.handlers === 0 && reader.bad === 'undefined', JSON.stringify(reader));
  check('Reader mode drops javascript: links and keeps web links', reader.badLinks === 0 && reader.goodLink === `${base}/next`, JSON.stringify(reader));
  const pressed = await waitFor(() => ui.$eval('#reader', (el) => el.getAttribute('aria-pressed') === 'true'));
  check('the reader button shows as on', pressed === true, pressed);
  const readerAddress = await waitFor(async () => { const v = await ui.$eval('#address', (el) => el.value); return v.includes('/article') && v; });
  check('the address bar keeps the article\'s address', Boolean(readerAddress), await ui.$eval('#address', (el) => el.value));
  check('the lock and star are hidden on the reader page', await ui.$eval('#security', (el) => el.hidden) && await ui.$eval('#bookmark', (el) => el.hidden), 'shown');
  await ui.$eval('#reader', (b) => b.click()); // a DOM click: the new tab left focus in the address bar, which hides the buttons
  const back = await waitFor(async () => (await tabUrl(articleTab)) === `${base}/article`);
  check('the reader button again goes back to the page', back === true, await tabUrl(articleTab));
  await inTab(articleTab, "location.href = '/other'; 1").catch(() => {});
  await waitFor(async () => (await tabUrl(articleTab)).endsWith('/other'));
  const notReaderable = await waitFor(async () => (await app.evaluate((_e, i) => global.__pageTools.tab(i).readerable, articleTab)) === false && ui.$eval('#reader', (el) => el.hidden));
  check('a short page isn\'t readerable and hides the button', notReaderable === true, notReaderable);

  // ---- Picture in Picture ----
  const videoTab = await open(`${base}/video`);
  await waitFor(() => inTab(videoTab, "document.getElementById('v').readyState >= 1"));
  const items = await app.evaluate((_e, i) => {
    const wc = global.__pageTools.tab(i).view.webContents;
    return global.__pageTools.contextMenuItems(wc, { mediaType: 'video', mediaFlags: { canShowPictureInPicture: true }, x: 50, y: 50, srcURL: '', frame: wc.mainFrame }).map((m) => m.label || m.type);
  }, videoTab);
  check('the video context menu has Picture in Picture', items.includes('Picture in Picture'), items);
  const pip = await app.evaluate((_e, i) => { const wc = global.__pageTools.tab(i).view.webContents; return global.__pageTools.tools.togglePictureInPicture(wc.mainFrame, 50, 50).catch((e) => `error: ${e.message}`); }, videoTab);
  const inPip = await waitFor(() => inTab(videoTab, "document.pictureInPictureElement?.id === 'v'"));
  check('Picture in Picture opens for the video', pip === 'entered' && inPip === true, `${pip} / ${inPip}`);
  const left = await app.evaluate((_e, i) => { const wc = global.__pageTools.tab(i).view.webContents; return global.__pageTools.tools.togglePictureInPicture(wc.mainFrame, 50, 50).catch((e) => `error: ${e.message}`); }, videoTab);
  check('choosing it again closes Picture in Picture', left === 'exited' && (await inTab(videoTab, '!document.pictureInPictureElement')), left);
  const plainItems = await app.evaluate((_e, i) => global.__pageTools.contextMenuItems(global.__pageTools.tab(i).view.webContents, { mediaType: 'none', mediaFlags: {} }).length, videoTab);
  check('no video items for other content', plainItems === 0, plainItems);

  check('no errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  for (const dir of [profile, out]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
