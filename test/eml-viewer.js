// The email viewer (hidden Electron run: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1, a fresh profile and TEMP of its own, no real network).
// Every way of opening an .eml shows the viewer in an ordinary tab of the window (never a download, a program, a window or a dialog):
//   a click in the downloads panel, a download from a web page (web mail), File > Open (Ctrl+O, dialog stubbed), a file: address
//   (typed, dropped on the page, a link), the command line (Open with). The tab's title is the subject, its address the file's,
//   Back/Forward/Reload work, two files make two tabs, and a restart brings them back.
// Then per fixture (test/fixtures/eml): headers and body render, nothing in the email runs (canary + a local server counting hits),
// remote pictures wait for "Load remote images", cid: pictures show, attachments list with sizes and Save works (dialog stubbed),
// links open in a new tab and never in the viewer.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const FIX = path.join(__dirname, 'fixtures', 'eml');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await Promise.resolve().then(fn).catch(() => null);
      if (v || Date.now() > end) return v;
      await sleep(120);
    }
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eml-viewer-'));
  const work = path.join(root, 'tmp'); const docs = path.join(root, 'docs'); const dl = path.join(root, 'downloads'); const profile = path.join(root, 'profile');
  for (const d of [work, docs, dl, profile]) fs.mkdirSync(d);

  // The local server: counts every request a hostile email might provoke, serves the .eml files like web mail does, and a page to leave to.
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const m = /^\/mail\/([\w.-]+\.eml)/.exec(req.url);
    if (m && fs.existsSync(path.join(docs, m[1]))) {
      res.writeHead(200, { 'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="${m[1]}"` });
      return res.end(fs.readFileSync(path.join(docs, m[1])));
    }
    res.setHeader('Content-Type', req.url.endsWith('.gif') ? 'image/gif' : 'text/html');
    res.end(req.url.endsWith('.gif') ? Buffer.from('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64') : '<!doctype html><title>Elsewhere</title><p>elsewhere</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const hitsOf = (part) => hits.filter((u) => u.includes(part)).length;

  // Working copies of the fixtures, pointing at the local server instead of the web.
  const files = {};
  for (const f of fs.readdirSync(FIX)) {
    if (!f.endsWith('.eml')) continue;
    fs.writeFileSync(path.join(docs, f), fs.readFileSync(path.join(FIX, f), 'utf8').split('__TRACKER__').join(base).split('https://example.com').join(base));
    files[f.replace(/\.eml$/, '')] = path.join(docs, f);
  }
  const url = (p) => pathToFileURL(p).href;

  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work };
  const launch = async () => {
    for (let attempt = 1; ; attempt++) {
      let app = null;
      try {
        app = await electron.launch({ args: [path.join(__dirname, '..')], env, timeout: 60000 });
        const ui = await app.firstWindow({ timeout: 60000 });
        await ui.waitForSelector('.tab');
        await sleep(2000);
        await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), dl);
        return { app, ui };
      } catch (e) {
        try { await app?.close(); } catch {}
        if (attempt >= 3) throw e;
        await sleep(3000);
      }
    }
  };
  const exited = (p) => new Promise((r) => { if (p.exitCode !== null) r(); else { p.once('exit', r); setTimeout(r, 15000); } });

  const windows = (app) => app.evaluate(() => global.__windows.list());
  const tabsOf = async (app) => ((await windows(app))[0]?.tabs || []);
  const isViewer = (u) => /\/renderer\/eml\.html/.test(u || '');
  const viewerFile = (u) => { try { return new URL(u).searchParams.get('u'); } catch { return null; } };
  const viewerTabs = async (app) => (await tabsOf(app)).filter((t) => isViewer(t.url));
  const tabFor = async (app, p) => (await viewerTabs(app)).find((t) => viewerFile(t.url) === url(p));
  // Runs code in the viewer page of one tab (by the tab's contents id).
  const inTab = (app, contentsId, code) => app.evaluate(({ webContents }, [id, c]) => { const wc = webContents.fromId(id); return wc ? wc.executeJavaScript(c).catch((e) => `ERR ${e.message}`) : null; }, [contentsId, code]);
  const state = (app, id) => inTab(app, id, `(() => ({
    title: document.title, subject: document.getElementById('subject').textContent, fields: document.getElementById('fields').innerText,
    attachments: Array.from(document.querySelectorAll('#att-list li')).map((li) => ({ name: li.querySelector('.att-name').textContent, size: li.querySelector('.att-size').textContent, openDisabled: li.querySelector('[data-action=open]').disabled })),
    srcdoc: document.getElementById('frame').srcdoc, remoteBar: !document.getElementById('remote').hidden, href: location.href, canary: typeof window.__canary,
    hasWebview: Boolean(document.querySelector('script:not([src])')), message: document.getElementById('message').hidden ? '' : document.getElementById('message').innerText,
  }))()`);
  const waitState = (app, id, ok) => waitFor(async () => { const s = await state(app, id); return s && s.subject && (!ok || ok(s)) ? s : null; }, 15000);
  const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
  const tabTitles = (ui) => ui.$$eval('.tab .tab-title', (els) => els.map((e) => e.textContent));
  const openFileTab = async (app, p) => { await app.evaluate((_e, f) => global.__windows.open(global.__windows.list()[0].windowId, f), url(p)); return waitFor(() => tabFor(app, p), 15000); };

  let started = null;
  try {
    started = await launch();
    let { app, ui } = started;
    const wins0 = await windowCount(app);

    // ---------- 1. every way in ----------
    console.log('--- entry points');
    // (a) File > Open (Ctrl+O) with the native dialog stubbed
    await app.evaluate(({ dialog }, p) => { global.__dialogCalls = 0; dialog.showOpenDialog = async () => { global.__dialogCalls++; return { canceled: false, filePaths: [p] }; }; }, files.plain);
    await ui.bringToFront().catch(() => {});
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html')); for (const t of ['keyDown', 'keyUp']) w.webContents.sendInputEvent({ type: t, keyCode: 'O', modifiers: ['control'] }); });
    const viaDialog = await waitFor(() => tabFor(app, files.plain), 10000);
    check('Ctrl+O on an .eml shows the viewer in a tab', Boolean(viaDialog));
    // (b) the command line / "Open with"
    await app.evaluate(({}, p) => global.__taskbar.secondInstance(['Lumen.exe', p]), files['html-cid']);
    const viaArgs = await waitFor(() => tabFor(app, files['html-cid']), 10000);
    check('the command line (Open with) shows the viewer in a tab', Boolean(viaArgs));
    // (c) a file: address (typed, dropped on the page, a link): the tab loads it
    await app.evaluate((_e, u) => global.__windows.open(global.__windows.list()[0].windowId, u), `${base}/web`);
    const web = await waitFor(async () => (await tabsOf(app)).find((x) => x.url === `${base}/web`), 10000);
    await sleep(500);
    await app.evaluate(({ webContents }, [id, f]) => webContents.fromId(id).loadURL(f).catch(() => {}), [web.contentsId, url(files.alternative)]);
    const viaNav = await waitFor(() => tabFor(app, files.alternative), 10000);
    check('navigating a tab to file:///...eml shows the viewer in that tab', Boolean(viaNav), viaNav || JSON.stringify((await tabsOf(app)).map((x) => x.url.slice(-50))));
    // (d) a download from a web page (an attachment in web mail): saved, then shown in a new tab
    await app.evaluate((_e, u) => global.__windows.open(global.__windows.list()[0].windowId, u), `${base}/mail`);
    const web3 = await waitFor(async () => (await tabsOf(app)).find((x) => x.url === `${base}/mail`), 10000);
    await app.evaluate(({ webContents }, [id, u]) => webContents.fromId(id).downloadURL(u), [web3.contentsId, `${base}/mail/nested.eml`]);
    const savedNested = path.join(dl, 'nested.eml');
    const viaWeb = await waitFor(() => tabFor(app, savedNested), 10000);
    check('an .eml downloaded from a web page opens in a tab', Boolean(viaWeb));
    check('...and was saved to the downloads folder', await waitFor(() => fs.existsSync(path.join(dl, 'nested.eml')), 5000));
    // (e) a click on a finished download in the downloads panel
    const entry = await waitFor(() => app.evaluate(() => global.__downloads.list().find((d) => d.name === 'nested.eml' && d.state === 'completed')?.id));
    const before = (await viewerTabs(app)).length;
    await app.evaluate(({}, id) => global.__managers.downloads.act(id, 'open'), entry);
    const viaPanel = await waitFor(async () => (await viewerTabs(app)).length > before && (await viewerTabs(app)), 10000);
    check('clicking the finished .eml in the downloads panel opens a viewer tab (not another program)', Boolean(viaPanel), before);
    check('no entry point left a window, a dialog or an extra download behind', (await windowCount(app)) === wins0 && fs.readdirSync(dl).filter((f) => f.endsWith('.eml')).length === 1);
    check('the Open dialog was the stub, not a real one', (await app.evaluate(() => global.__dialogCalls)) === 1);

    // ---------- 2. the tab ----------
    console.log('--- the tab');
    const t = await tabFor(app, files.plain);
    const s = await waitState(app, t.contentsId);
    check('the tab title is the email subject', s.title === 'Lunch on Friday', s.title);
    check('the viewer is a tab in the window strip (the window count did not change)', (await windowCount(app)) === wins0, await windowCount(app));
    const titles = await waitFor(async () => { const x = await tabTitles(ui); return x.includes('Lunch on Friday') && x; });
    check('the strip shows the subject', Boolean(titles), (await tabTitles(ui)).join('|'));
    const icon = await ui.evaluate(() => { const tabs = Array.from(document.querySelectorAll('.tab')); const el = tabs.find((x) => x.querySelector('.tab-title')?.textContent === 'Lunch on Friday'); return el ? el.querySelector('svg')?.innerHTML || '' : null; });
    check('the strip shows the envelope icon', typeof icon === 'string' && /m2\.75 4\.75 5\.25 4/.test(icon), icon);
    await app.evaluate(({}, id) => global.__aiTabs.switchTo(id), t.id);
    const address = await waitFor(async () => { const v = await ui.inputValue('#address'); return v.startsWith('file:') && v.endsWith('plain.eml') && v; }, 8000);
    check("the address bar shows the file's address", address === url(files.plain) || decodeURI(address) === decodeURI(url(files.plain)), address);
    // Back / forward / reload
    const wc = t.contentsId;
    await app.evaluate(({ webContents }, [id, u]) => webContents.fromId(id).loadURL(u).catch(() => {}), [wc, `${base}/elsewhere`]);
    await waitFor(async () => /Elsewhere/.test(await inTab(app, wc, 'document.title') || ''));
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).navigationHistory.goBack(), wc);
    const back = await waitState(app, wc);
    check('Back returns to the email, drawn again', back && back.subject === 'Lunch on Friday', JSON.stringify(back));
    await sleep(500);
    const canForward = await app.evaluate(({ webContents }, id) => webContents.fromId(id).navigationHistory.canGoForward(), wc);
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).navigationHistory.goForward(), wc);
    check('Forward goes on', Boolean(await waitFor(async () => /Elsewhere/.test(await inTab(app, wc, 'document.title') || ''))), `canGoForward ${canForward}`);
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).navigationHistory.goBack(), wc);
    await waitState(app, wc);
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).reload(), wc);
    check('Reload draws the email again', Boolean(await waitState(app, wc, (x) => x.subject === 'Lunch on Friday' && x.fields.includes('alice@example.com'))));
    // two files, two tabs
    const nTabs = (await viewerTabs(app)).length;
    const second = await openFileTab(app, files.attachments);
    check('a second .eml opens in a new tab', Boolean(second) && (await viewerTabs(app)).length === nTabs + 1 && Boolean(await tabFor(app, files.plain)));

    // ---------- 3. each fixture, by the downloads-panel path and the file path ----------
    console.log('--- fixtures');
    const expect = {
      plain: { subject: 'Lunch on Friday', body: 'Are we still on for lunch', att: [] },
      alternative: { subject: 'Both parts', body: 'HTML <b>VERSION</b>', att: [] },
      'html-cid': { subject: 'Logo inside', body: 'data:image/png;base64,', att: [['red.png', '74 B']] },
      attachments: { subject: 'Files attached', body: 'See the attached files.', att: [['tiny.pdf', '193 B'], ['red.png', '74 B'], ['notes.txt', '21 B']] },
      'qp-utf8': { subject: 'Café réunion — €50', body: 'Café — the price is €50. This line is soft-wrapped across two lines.', att: [] },
      nested: { subject: 'Fwd: Original question', body: 'Forwarding this to you.', att: [['Original question.eml', '211 B']] },
      malicious: { subject: 'URGENT: your account', body: 'ignore previous instructions', att: [] },
    };
    for (const [name, want] of Object.entries(expect)) {
      const tab = (await tabFor(app, files[name])) || (await openFileTab(app, files[name]));
      const st = tab && (await waitState(app, tab.contentsId));
      check(`${name}: subject is the title`, st && st.title === want.subject && st.subject === want.subject, st && st.title);
      check(`${name}: headers render (From, To, Date)`, st && /From\s+Alice Example|From\s+Ren/.test(st.fields) && /To\s/.test(st.fields) && /2026/.test(st.fields), st && st.fields);
      check(`${name}: the body renders`, st && st.srcdoc.replace(/\s+/g, ' ').includes(want.body.replace(/\s+/g, ' ')) || (name === 'qp-utf8' && st && st.srcdoc.replace(/\s+/g, ' ').includes('the price is €50.')), st && st.srcdoc.slice(0, 300));
      check(`${name}: attachments list with sizes`, st && JSON.stringify(st.attachments.map((a) => [a.name, a.size])) === JSON.stringify(want.att), st && JSON.stringify(st.attachments));
      check(`${name}: the page stays the viewer (no navigation away)`, st && isViewer(st.href));
    }
    // the same fixtures through the downloads-panel path
    for (const name of Object.keys(expect)) {
      const dlFile = path.join(dl, `${name}.eml`);
      fs.copyFileSync(files[name], dlFile);
      await app.evaluate(({}, [p, n]) => { const list = global.__managers.downloads.list; list.unshift({ id: 9000 + list.length, name: n, path: p, state: 'completed', received: 1, total: 1, started: Date.now(), endedAt: Date.now(), url: 'file:///x', speed: 0 }); }, [dlFile, `${name}.eml`]);
      const id = await app.evaluate(({}, n) => global.__managers.downloads.list.find((d) => d.name === n && d.path.includes('downloads'))?.id, `${name}.eml`);
      const known = (await viewerTabs(app)).map((x) => x.id);
      await app.evaluate(({}, i) => global.__managers.downloads.act(i, 'open'), id);
      const opened = await waitFor(async () => (await viewerTabs(app)).find((x) => !known.includes(x.id) && viewerFile(x.url) === url(dlFile)), 10000);
      const st = opened && (await waitState(app, opened.contentsId));
      check(`${name}: opens from the downloads panel, subject ${expect[name].subject}`, st && st.title === expect[name].subject, st && st.title);
    }

    // ---------- 4. security ----------
    console.log('--- security');
    const mal = await tabFor(app, files.malicious);
    const ms = await state(app, mal.contentsId);
    check('no script ran in the viewer (canary)', ms.canary === 'undefined' && !ms.hasWebview, ms.canary);
    check('the sanitized body has no script, handler, form, frame, object, meta refresh, base or javascript: link', !/<script|onerror|onload|<form|<iframe|<object|<meta|<base|javascript:|<svg|<input/i.test(ms.srcdoc.replace(/<meta (charset|http-equiv="Content-Security-Policy"|name="referrer")[^>]*>/g, '')), ms.srcdoc);
    check('the body carries its own strict CSP and the iframe is sandboxed without allow-scripts', /Content-Security-Policy/.test(ms.srcdoc) && /img-src data:;/.test(ms.srcdoc) && !/script-src/.test(ms.srcdoc) && /default-src 'none'/.test(ms.srcdoc), ms.srcdoc.slice(0, 400));
    const sandbox = await inTab(app, mal.contentsId, "document.getElementById('frame').getAttribute('sandbox')");
    check('sandbox attribute has no allow-scripts and no allow-same-origin', /allow-popups/.test(sandbox) && !/allow-scripts|allow-same-origin|allow-forms|allow-top-navigation/.test(sandbox), sandbox);
    await sleep(1200);
    check('no remote request fired while remote images are blocked', hitsOf('/pixel.gif') === 0 && hitsOf('/css-bg.gif') === 0 && hitsOf('/script-ran') === 0, JSON.stringify(hits));
    check('the viewer offers "Load remote images"', ms.remoteBar === true);
    check('the remote pixel address is not in the body while blocked', !ms.srcdoc.includes('pixel.gif'));
    await inTab(app, mal.contentsId, "document.getElementById('load-remote').click()");
    const loaded = await waitFor(() => hitsOf('/pixel.gif') >= 1, 10000);
    check('after "Load remote images" the picture is requested', Boolean(loaded), JSON.stringify(hits));
    check('...and still no script ran', hitsOf('/script-ran') === 0 && (await inTab(app, mal.contentsId, 'typeof window.__canary')) === 'undefined');
    check('the button goes away once pressed', (await state(app, mal.contentsId)).remoteBar === false);

    // links: open in a new tab, never in the viewer
    const html = await tabFor(app, files['html-cid']);
    await app.evaluate(({}, id) => global.__aiTabs.switchTo(id), html.id);
    await sleep(800);
    // Where the link is: the first pixels of the link colour (#0062cc) inside the body frame (the page itself can't be asked, the frame has no scripts).
    const point = await app.evaluate(async ({ webContents }, id) => {
      const wc = webContents.fromId(id);
      const view = await wc.executeJavaScript("(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth }; })()");
      const img = await wc.capturePage();
      const { width } = img.getSize();
      const k = width / view.vw;
      const bmp = img.toBitmap();
      const hits = [];
      for (let y = Math.floor(view.y * k); y < Math.floor((view.y + view.h) * k); y++) {
        for (let x = Math.floor(view.x * k); x < Math.floor((view.x + view.w) * k); x++) {
          const o = (y * width + x) * 4;
          if (Math.abs(bmp[o + 2] - 0) < 12 && Math.abs(bmp[o + 1] - 98) < 12 && Math.abs(bmp[o] - 204) < 12) hits.push([x, y]);
        }
      }
      if (!hits.length) return { error: 'no link pixels', k };
      const [x, y] = hits[Math.floor(hits.length / 2)];
      return { x: x / k, y: y / k, n: hits.length };
    }, html.contentsId).catch((e) => ({ error: e.message }));
    const tabsBefore = (await tabsOf(app)).length;
    if (point && !point.error) {
      // (a real mouse click, through the debugger: sendInputEvent does not reach a frame in another process while the window is hidden)
      await app.evaluate(async ({ webContents }, [id, p]) => {
        const wc = webContents.fromId(id);
        const mine = !wc.debugger.isAttached();
        if (mine) wc.debugger.attach('1.3');
        try { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra }); } finally { if (mine) { try { wc.debugger.detach(); } catch {} } }
      }, [html.contentsId, point]);
    }
    const linkTab = await waitFor(async () => (await tabsOf(app)).find((x) => x.url.startsWith(`${base}/page`)), 10000);
    check('clicking a link in the body opens it in a new tab', Boolean(linkTab) && (await tabsOf(app)).length === tabsBefore + 1, JSON.stringify(point));
    check('...and the viewer stays on the email', (await tabFor(app, files['html-cid'])) !== undefined && isViewer((await tabsOf(app)).find((x) => x.id === html.id)?.url));

    // cid pictures
    const hs = await state(app, html.contentsId);
    check('the cid: picture is embedded from the message itself', /<img[^>]*src="data:image\/png;base64,/.test(hs.srcdoc) && !/cid:/.test(hs.srcdoc), hs.srcdoc.slice(0, 300));

    // attachments: Save through the normal download path (no dialog), Open in a tab, unsafe types never open
    const att = await tabFor(app, files.attachments);
    await app.evaluate(({ dialog }) => { global.__saveDialogs = 0; dialog.showSaveDialog = async () => { global.__saveDialogs++; return { canceled: true }; }; });
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelectorAll('#att-list li')[0].querySelector('[data-action=save]').click()"), att.contentsId);
    const saved = await waitFor(() => fs.existsSync(path.join(dl, 'tiny.pdf')) && fs.statSync(path.join(dl, 'tiny.pdf')).size === 193, 10000);
    check('Save writes the attachment through the normal download path, byte for byte, with no save dialog', Boolean(saved) && fs.readFileSync(path.join(dl, 'tiny.pdf')).equals(fs.readFileSync(path.join(FIX, 'tiny.pdf'))) && (await app.evaluate(() => global.__saveDialogs)) === 0);
    const before2 = (await tabsOf(app)).length;
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelectorAll('#att-list li')[1].querySelector('[data-action=open]').click()"), att.contentsId);
    const pic = await waitFor(async () => (await tabsOf(app)).length > before2 && (await tabsOf(app)).find((x) => /lumen-eml-/.test(decodeURIComponent(x.url))), 10000);
    check('Open on a picture attachment opens it in a new tab from a private temp copy', Boolean(pic), JSON.stringify((await tabsOf(app)).map((x) => x.url)));
    const nested = await tabFor(app, files.nested);
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelectorAll('#att-list li')[0].querySelector('[data-action=open]').click()"), nested.contentsId);
    const inner = await waitFor(async () => { for (const x of await viewerTabs(app)) if (/lumen-eml-/.test(decodeURIComponent(x.url))) { const st = await state(app, x.contentsId); if (st && st.title === 'Original question') return st; } return null; }, 10000);
    check('a nested message/rfc822 attachment opens in the viewer as its own email', Boolean(inner) && /forwarded original message/.test(inner.srcdoc), inner && inner.srcdoc);

    // ---------- 5. restart ----------
    console.log('--- restart');
    const wanted = [files.plain, files.attachments, files.nested].map(url);
    const proc = app.process();
    await app.close().catch(() => {});
    await exited(proc);
    started = await launch();
    ({ app, ui } = started);
    const norm = (u) => decodeURIComponent(String(u || '')).toLowerCase();
    const shown = (x) => norm(isViewer(x.url) ? viewerFile(x.url) : x.url); // (a tab still asleep keeps the file's own address)
    const restored = await waitFor(async () => { const v = await tabsOf(app); return wanted.every((w) => v.some((x) => shown(x) === norm(w))) && v; }, 25000);
    check('after a restart the email tabs are back (two files stay two tabs)', Boolean(restored), (await tabsOf(app)).map((x) => path.basename(decodeURIComponent(x.url))).join(' | '));
    const again = (await tabsOf(app)).find((x) => shown(x) === norm(url(files.attachments)));
    if (again) {
      await app.evaluate(({}, id) => global.__aiTabs.switchTo(id), again.id);
      const rs = await waitState(app, (await tabsOf(app)).find((x) => x.id === again.id).contentsId);
      check('a restored tab draws the email and keeps its title', rs && rs.title === 'Files attached' && rs.attachments.length === 3, rs && rs.title);
    } else check('a restored tab draws the email and keeps its title', false, 'no tab');
  } catch (e) {
    check('the run finished without an error', false, e && e.stack);
  } finally {
    try { await started?.app.close(); } catch {}
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll eml-viewer checks passed');
  process.exit(failures ? 1 : 0);
})();
