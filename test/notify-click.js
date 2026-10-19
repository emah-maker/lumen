// Clicking a site's notification brings its tab to the front (preload/page-dialogs-preload.js -> main.js
// 'page-notification:click'), like Chrome; a click the page fakes (dispatchEvent) does not, and the page's Notification API
// is unchanged. A chat's own notification (main.js showNotification) goes to the tab the AI worked in (its own tab when it navigated),
// an approval's to the tab it is about, a closed tab falls back to the chat's start; the notification stays referenced until clicked, and
// an activation with no click (a toast from the Action Center) opens the newest. Real Lumen, throwaway profile, a local page.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>notify</title><body>notify</body>'); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-notify-click-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: ['--js-flags=--expose-gc', path.join(__dirname, '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

    const site = await app.evaluate((_e, u) => global.__notifyClick.open(u), url);
    const other = await app.evaluate(() => global.__notifyClick.open('about:blank'));
    const inSite = (code) => app.evaluate(({ webContents }, [id, c]) => webContents.fromId(global.__notifyClick.contentsOf(id)).executeJavaScript(c, true), [site, code]);
    await waitFor(() => inSite('document.readyState === "complete" && document.title === "notify"').catch(() => false));
    check('the other tab is in front', (await app.evaluate(() => global.__notifyClick.activeId())) === other, '');

    const api = await inSite(`(() => {
      const n = new Notification('hi', { body: 'x' });
      class Sub extends Notification {}
      const s = new Sub('sub');
      let own = 0; n.onclick = () => { own++; };
      n.dispatchEvent(new Event('click'));
      return { instance: n instanceof Notification, sub: s instanceof Notification && s instanceof Sub, statics: typeof Notification.requestPermission === 'function' && typeof Notification.permission === 'string', own, name: Notification.name };
    })()`);
    check("the page's Notification API is unchanged (instanceof, subclass, statics, its own onclick)", api.instance && api.sub && api.statics && api.own === 1 && api.name === 'Notification', JSON.stringify(api));
    await sleep(600);
    check('a click the page fakes does not pull its tab forward', (await app.evaluate(() => global.__notifyClick.activeId())) === other, '');

    await app.evaluate(({ ipcMain, webContents }, id) => ipcMain.emit('page-notification:click', { sender: webContents.fromId(global.__notifyClick.contentsOf(id)) }), site);
    const front = await waitFor(async () => (await app.evaluate(() => global.__notifyClick.activeId())) === site);
    check("a real click on the site's notification brings its tab to the front", front, await app.evaluate(() => global.__notifyClick.activeId()));

    // ---- a chat's notification (main.js tellUser -> showNotification): where the click goes, and the notification staying alive
    const N = (fn, arg) => app.evaluate(fn, arg);
    const active = () => N(() => global.__notifyClick.activeId());
    const tell = (spec, kind) => N((_e, [s, k]) => global.__notifyClick.tell(s, k), [spec, kind]);
    const click = (i) => N((_e, n) => global.__notifyClick.click(n), i);
    await ui.evaluate(() => { window.__openChat = []; window.assistant.onOpenChat(({ id }) => window.__openChat.push(id)); });
    const aiTab = await N((_e, u) => global.__notifyClick.openAi(u), url); // a tab the AI opened, behind the user's
    await N((_e, id) => global.__notifyClick.switchTab(id), other); // the user is on their own tab
    check('the AI\'s own tab is not in front', (await active()) === other, await active());

    const done = await tell({ chatId: 'chat-a', homeTab: other, aiNavTabId: aiTab, bind: other }, 'done');
    check('a finished chat\'s notification is kept (a collected one would lose its click)', await N((_e, n) => global.__notifyClick.isKept(n), done), '');
    if (await N(() => global.__notifyClick.collect())) {
      await sleep(200); await N(() => global.__notifyClick.collect());
      check('the notification survives a garbage collection (the keeper holds it)', await N((_e, n) => global.__notifyClick.isKept(n), done), 'collected');
    } else console.log('SKIP  garbage collection (this Electron did not expose gc)');
    await click(done);
    check('clicking a chat notification for a run that navigated in its own tab goes to the AI\'s tab, not the user\'s', (await active()) === aiTab, await active());
    check('the sidebar is asked to open that chat', await waitFor(async () => (await ui.evaluate(() => window.__openChat)).includes('chat-a')), '');
    check('the AI\'s tab shows the chat (sidebar on that chat)', (await N((_e, id) => global.__notifyClick.chatOf(id), aiTab)) === 'chat-a', await N((_e, id) => global.__notifyClick.chatOf(id), aiTab));
    check('a clicked notification is let go', !(await N((_e, n) => global.__notifyClick.isKept(n), done)), '');

    // an approval opens the tab it is about, even when the AI has an own tab
    await N((_e, id) => global.__notifyClick.switchTab(id), other);
    const ask = await tell({ chatId: 'chat-b', tabId: site, homeTab: other, aiNavTabId: aiTab }, 'approval');
    await click(ask);
    check("an approval notification opens the approval's tab", (await active()) === site, await active());

    // a tab that is gone: the click falls back to where the chat started
    await N((_e, id) => global.__notifyClick.switchTab(id), other);
    const gone = await N((_e, u) => global.__notifyClick.openAi(u), 'about:blank');
    await N((_e, id) => global.__notifyClick.closeTab(id), gone);
    await waitFor(async () => (await N((_e, id) => global.__notifyClick.contentsOf(id), gone)) === null);
    const lost = await tell({ chatId: 'chat-c', tabId: gone, homeTab: site, aiNavTabId: gone }, 'done');
    await click(lost);
    check('a notification for a closed AI tab falls back to the tab the chat started on', (await active()) === site, await active());
    await N((_e, id) => global.__notifyClick.switchTab(id), other);
    const nowhere = await tell({ chatId: 'chat-d', tabId: gone, homeTab: gone, aiNavTabId: gone }, 'done');
    await click(nowhere);
    // (the sidebar hears of the chat a moment after the window comes forward, as in the checks above: wait for it)
    check('with no tab left the window still comes forward and the chat opens', (await active()) === other && await waitFor(async () => (await ui.evaluate(() => window.__openChat)).includes('chat-d')), await active());

    // a toast clicked from the Action Center (an activation with no click of its own) goes where the click would have
    await N((_e, id) => global.__notifyClick.switchTab(id), other);
    await tell({ chatId: 'chat-e', homeTab: other, aiNavTabId: aiTab }, 'done');
    check('an activation without a click opens the newest notification', await N(() => global.__notifyClick.activate()) === true && (await active()) === aiTab, await active());
    check('and only once (a later plain relaunch just focuses)', (await N(() => global.__notifyClick.activate())) === false, '');
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall notify-click checks passed');
  process.exit(failures ? 1 : 0);
})();
