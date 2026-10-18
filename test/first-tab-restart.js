// The front tab after Lumen was closed and opened again, and a page that was still loading when Lumen was closed (hidden Electron run: LUMEN_TEST_BACKGROUND=1, a fresh profile of its own).
// A user reported that the first page never loads in after a restart. For each variant: open pages (one in front), quit, start again
// on the same profile, and the tab that was in front must, within 3 s of the window being there, have loaded (not loading, its own address),
// be shown at the page area's size (not 0x0, not hidden), and have painted (capturePage's centre pixel is the page's colour).
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLORS = { a: [220, 30, 30], b: [30, 160, 60], c: [40, 60, 220], slow: [230, 140, 20] };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`); };
  const server = http.createServer((req, res) => {
    const name = req.url.split('/')[1].split('?')[0];
    const c = COLORS[name] || COLORS.a;
    const send = () => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Page ${name}</title><body style="margin:0;background:rgb(${c.join(',')})"><p style="color:#fff">${name}</p></body>`); };
    if (name === 'slow') setTimeout(send, 1500); else send();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-tab-'));
  const work = path.join(root, 'tmp');
  fs.mkdirSync(work);

  const makeEnv = (profile) => ({ ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work });
  const exited = (app) => new Promise((r) => { const p = app.process(); if (p.exitCode !== null) r(); else { p.once('exit', r); setTimeout(r, 15000); } });
  const launch = async (env) => {
    for (let attempt = 1; ; attempt++) {
      let app = null;
      try {
        app = await electron.launch({ args: [path.join(__dirname, '..')], env, timeout: 60000 });
        const ui = await app.firstWindow({ timeout: 60000 });
        await ui.waitForSelector('.tab');
        return app;
      } catch (e) {
        try { await app?.close(); } catch {}
        if (attempt >= 3) throw e;
        await sleep(3000);
      }
    }
  };
  const windows = (app) => app.evaluate(() => global.__windows.list());
  // What the front tab looks like right now.
  const probe = (app, want) => app.evaluate(async ({ BrowserWindow }, w) => {
    const rec = global.__windows.list()[w.window || 0];
    const win = BrowserWindow.fromId(rec.windowId);
    const tab = rec.tabs.find((t) => t.id === rec.activeId);
    const out = { tabs: rec.tabs.length, active: rec.activeId, url: tab?.url || null, contentsId: tab?.contentsId ?? null };
    out.content = win.getContentSize();
    if (!tab || tab.contentsId == null) { out.asleep = true; return out; }
    const view = win.contentView.children.find((c) => c.webContents && c.webContents.id === tab.contentsId);
    const wc = view?.webContents;
    out.hasView = Boolean(view);
    if (!view) return out;
    out.visible = view.getVisible();
    out.bounds = view.getBounds();
    out.loading = wc.isLoading();
    out.ready = !wc.isLoading() && wc.getURL() === w.url;
    if (out.visible && out.bounds.width > 0) {
      try {
        const img = await Promise.race([wc.capturePage(), new Promise((r) => setTimeout(() => r(null), 1500))]);
        if (img && !img.isEmpty()) {
          const { width, height } = img.getSize();
          const bmp = img.toBitmap(); const o = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
          out.pixel = [bmp[o + 2], bmp[o + 1], bmp[o]]; // (BGRA)
        } else out.pixel = null;
      } catch (e) { out.pixel = null; out.err = String(e.message); }
    }
    return out;
  }, want);
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(100); } };
  const near = (p, c) => Boolean(p) && p.every((v, i) => Math.abs(v - c[i]) < 40);
  const summ = (p) => ({ u: p.url && p.url.slice(-8), v: p.visible, b: p.bounds && [p.bounds.x, p.bounds.y, p.bounds.width, p.bounds.height], l: p.loading, r: p.ready, px: p.pixel, asleep: p.asleep, hasView: p.hasView });

  // An unpacked extension in the profile's Extensions folder (id folder / version folder), with a content script on the test pages and
  //  blocking rules in a declarativeNetRequest ruleset: a big one takes the extension seconds to load (it finishes after the first tabs).
  function makeExtension(profile, rules) {
    const dir = path.join(profile, 'Extensions', 'abcdefghijklmnopabcdefghijklmnop', '1.0.0');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      manifest_version: 3, key: require('crypto').generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), name: 'Late test extension', version: '1.0.0', permissions: ['declarativeNetRequest'], host_permissions: ['<all_urls>'],
      content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_start' }],
      background: { service_worker: 'background.js' },
      declarative_net_request: { rule_resources: [{ id: 'r', enabled: true, path: 'rules.json' }] },
    }));
    fs.writeFileSync(path.join(dir, 'content.js'), 'window.__lateExt = 1;');
    fs.writeFileSync(path.join(dir, 'background.js'), '');
    fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(Array.from({ length: rules }, (_, i) => ({ id: i + 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: `||ads${i}.example.invalid^`, resourceTypes: ['script', 'image'] } }))));
  }

  // One scenario: open `pages` in a window (`front`: the index of the one in front, or 'newtab'), quit, start again, probe.
  async function scenario(label, { pages, front, maximize = false, limit = 3000, settle = 1500, closeWindow = false, extension = false, rounds = 1, sidebar = false, second = null, before: prep }) {
    if (process.env.ONLY && !label.includes(process.env.ONLY)) return;
    const profile = path.join(root, `profile-${label.replace(/\W+/g, '-')}`);
    fs.mkdirSync(profile);
    const env = makeEnv(profile);
    if (extension) makeExtension(profile, extension);
    let app = await launch(env);
    try {
      const w = (await windows(app))[0];
      const opened = [];
      for (const name of pages) opened.push(await app.evaluate((_, [id, u]) => global.__windows.open(id, u), [w.windowId, `${base}/${name}`]));
      if (maximize) await app.evaluate(({ BrowserWindow }) => { for (const x of BrowserWindow.getAllWindows()) if (x.webContents.getURL().includes('index.html')) x.maximize(); });
      if (prep) await prep(app, w, opened);
      let targetId = null;
      if (front === 'newtab') targetId = (await windows(app))[0].tabs.find((t) => /newtab\.html/.test(t.url))?.id ?? null;
      else if (front === 'chat') targetId = (await windows(app))[0].tabs.find((t) => /chat/i.test(t.url))?.id ?? null;
      else targetId = opened[front].id;
      if (targetId != null) await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:switch', {}, id), targetId);
      if (second) { // a second window with its own pages, one in front
        await app.evaluate(() => global.__basics.openNewWindow());
        await waitFor(async () => (await windows(app)).length === 2, 10000);
        const w2 = (await windows(app)).find((x) => x.windowId !== w.windowId);
        const o2 = [];
        for (const name of second.pages) o2.push(await app.evaluate((_, [id, u]) => global.__windows.open(id, u), [w2.windowId, `${base}/${name}`]));
        await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:switch', {}, id), o2[second.front].id);
      }
      await sleep(settle); // (the pages load, and the session is saved)
      for (let round = 1; round <= rounds; round++) {
        const was = (await windows(app))[0];
        const frontUrl = front === 'newtab' || front === 'chat' ? null : `${base}/${pages[front]}`;
        const quit = exited(app);
        if (closeWindow) await app.evaluate(({ BrowserWindow }) => { for (const x of BrowserWindow.getAllWindows()) if (x.webContents.getURL().includes('index.html')) x.close(); }); else await app.close().catch(() => {});
        await quit;
        // ---- start again
        const t0 = Date.now();
        app = await launch(env);
        const color = frontUrl ? COLORS[pages[front]] : null;
        let last = null; let tOk = null; const log = [];
        while (Date.now() - t0 < limit + 4000) {
          last = await probe(app, { url: frontUrl, noShot: false }).catch((e) => ({ err: String(e.message) }));
          const s = JSON.stringify(summ(last));
          if (!log.length || log[log.length - 1].s !== s) log.push({ t: Date.now() - t0, s });
          const sized = Boolean(last.bounds) && last.bounds.width > 0 && last.bounds.height > 0 && last.bounds.y + last.bounds.height === last.content[1] && (last.bounds.width === last.content[0] || (sidebar && last.bounds.x + last.bounds.width === last.content[0] - 360));
          if (frontUrl ? last.ready && last.visible && sized && near(last.pixel, color) : last.visible && sized && last.pixel) { tOk = Date.now() - t0; break; }
          await sleep(100);
        }
        const tag = rounds > 1 ? `${label} (start ${round})` : label;
        check(`${tag}: the front tab is loaded, shown at the page area's size and painted`, tOk !== null, JSON.stringify({ was: was.tabs.map((t) => t.url.slice(-40)), active: was.activeId, content: last && last.content, log }));
        if (tOk !== null) {
          console.log(`      (${tOk} ms after the start)`);
          if (frontUrl) {
            // the window's own UI agrees: the front tab is the highlighted one and the address bar shows its address
            const uiPage = await app.firstWindow();
            const shown = await waitFor(async () => { const v = await uiPage.evaluate(() => ({ tabs: document.querySelectorAll('#tabs .tab').length, active: document.querySelector('#tabs .tab.active')?.textContent || '', address: document.getElementById('address').value })); return v.tabs >= pages.length && v.address.includes(`/${pages[front]}`) && v.active.includes(`Page ${pages[front]}`) ? v : null; }, 3000);
            check(`${tag}: the tab strip and address bar show it too`, Boolean(shown), JSON.stringify(await uiPage.evaluate(() => ({ tabs: [...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim().slice(0, 20) + (t.classList.contains('active') ? '*' : '')), address: document.getElementById('address').value }))));
          }
          check(`${tag}: within ${limit} ms`, tOk <= limit, `${tOk} ms`);
        } else break;
        if (second) {
          const want2 = `${base}/${second.pages[second.front]}`;
          let l2 = null; let t2 = null;
          const t1 = Date.now();
          while (Date.now() - t1 < limit + 2000) {
            l2 = await probe(app, { url: want2, window: 1 }).catch((e) => ({ err: String(e.message) }));
            const sized2 = Boolean(l2.bounds) && l2.bounds.width > 0 && l2.bounds.height > 0 && l2.bounds.width === l2.content[0] && l2.bounds.y + l2.bounds.height === l2.content[1];
            if (l2.ready && l2.visible && sized2 && near(l2.pixel, COLORS[second.pages[second.front]])) { t2 = Date.now() - t1; break; }
            await sleep(100);
          }
          check(`${tag}: the second window's front tab is loaded, shown and painted too`, t2 !== null, JSON.stringify({ l2: summ(l2 || {}), content: l2 && l2.content, windows: (await windows(app)).map((x) => [x.windowId, x.activeId, x.tabs.length]) }));
        }
        if (round < rounds) { // the next tab along (a restored one that was asleep wakes) comes to the front before the next quit
          front = (front + 1) % pages.length;
          const cur = (await windows(app))[0].tabs.find((t) => t.url.endsWith(`/${pages[front]}`));
          if (cur) await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:switch', {}, id), cur.id);
          await sleep(settle);
        }
      }
    } finally { try { await app?.close(); } catch {} }
  }

  // Lumen is closed again while the front page is still loading (a slow site, the first seconds after a start): the next start must still
  // bring that page back in front.
  async function closedWhileLoading() {
    if (process.env.ONLY && !'closed while the front page is loading'.includes(process.env.ONLY)) return;
    const label = 'closed while the front page is loading';
    const profile = path.join(root, 'profile-loading');
    fs.mkdirSync(profile);
    const env = makeEnv(profile);
    let app = await launch(env);
    try {
      const w = (await windows(app))[0];
      const opened = [];
      for (const name of ['a', 'slow']) opened.push(await app.evaluate((_, [id, u]) => global.__windows.open(id, u), [w.windowId, `${base}/${name}`]));
      await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:switch', {}, id), opened[1].id);
      await sleep(3500);
      for (let start = 2; start <= 3; start++) {
        await app.close().catch(() => {}); // (quit)
        app = await launch(env);
        await sleep(300); // (the front page, 1.5 s away from answering, is still loading)
        const now = (await windows(app))[0];
        const quit = exited(app);
        await app.close().catch(() => {});
        await quit;
        app = await launch(env);
        const back = await waitFor(async () => { const l = (await windows(app))[0]; const t = l.tabs.find((x) => x.id === l.activeId); return t && t.url.endsWith('/slow') ? l : null; }, 6000);
        const l = (await windows(app))[0];
        check(`${label}: start ${start}: the page that was loading is still the front tab`, Boolean(back), JSON.stringify({ during: now.tabs.map((t) => t.url.slice(-12)), after: l.tabs.map((t) => t.url.slice(-12)), active: l.tabs.findIndex((t) => t.id === l.activeId) }));
        if (!back) break;
      }
    } finally { try { await app?.close(); } catch {} }
  }

  try {
    await closedWhileLoading();
    await scenario('middle tab in front', { pages: ['a', 'b', 'c'], front: 1 });
    await scenario('last tab in front', { pages: ['a', 'b', 'c'], front: 2 });
    await scenario('first page in front', { pages: ['a', 'b'], front: 0 });
    await scenario('slow page in front', { pages: ['a', 'slow'], front: 1, limit: 5000, settle: 3500 });
    await scenario('new-tab page in front', { pages: ['a', 'b'], front: 'newtab' });
    await scenario('sidebar open on the front tab', { pages: ['a', 'b', 'c'], front: 1, sidebar: true, before: async (app, w, opened) => { await app.evaluate((_, id) => global.__tabChats.setSidebar(id, true), opened[1].id); } });
    await scenario('an AI chat tab exists', { pages: ['a', 'b'], front: 1, before: async (app) => { await app.evaluate(() => global.__chatPage.open()); await sleep(800); } });
    await scenario('the AI chat tab in front', { pages: ['a', 'b'], front: 'chat', before: async (app) => { await app.evaluate(() => global.__chatPage.open()); await sleep(1500); } });
    await scenario('window closed, not quit', { pages: ['a', 'b', 'c'], front: 1, closeWindow: true });
    await scenario('an extension that loads late', { pages: ['a', 'b', 'c'], front: 1, extension: 30000 });
    await scenario('three starts in a row, a different tab each time', { pages: ['a', 'b', 'c'], front: 1, rounds: 3 });
    await scenario('the front tab is pinned', { pages: ['a', 'b', 'c'], front: 1, before: async (app, w, opened) => { await app.evaluate((_, [id, tab]) => global.__windows.pin(id, tab, true), [w.windowId, opened[1].id]); } });
    await scenario('the front tab is in a group', { pages: ['a', 'b', 'c'], front: 1, before: async (app, w, opened) => { await app.evaluate((_, [id, tabs]) => global.__windows.group(id, tabs, 'Work'), [w.windowId, [opened[0].id, opened[1].id]]); } });
    await scenario('many tabs, the last in front', { pages: ['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a'], front: 24 });
    await scenario('two windows', { pages: ['a', 'b'], front: 1, second: { pages: ['b', 'c'], front: 0 } });
    await scenario('window maximized', { pages: ['a', 'b', 'c'], front: 1, maximize: true });
  } catch (e) {
    failures++;
    console.log(`FAIL  test crashed -> ${e.stack || e}`);
  } finally {
    server.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* the temp sweep gets it */ }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
