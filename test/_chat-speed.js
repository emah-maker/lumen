// Shared by test/chat-tab-speed.js and scripts/measure/measure-chat-tabs.js: times how long a chat tab takes to become usable, in the real app
// (hidden: LUMEN_TEST_BACKGROUND=1) on a throwaway profile holding a realistic chat history (test/_chat-seed.js).
// "Usable" means the page is out of its boot state, the chat list has rendered, the open chat's messages are on screen
// (when it has any) and the composer takes focus. Every number is milliseconds from the keypress or click (or, for a
// restore, from starting the app) to that point; -1 means it never got there.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const copyProfile = (src) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-chatspeed-')); fs.cpSync(src, dir, { recursive: true }); return dir; };
const launch = (profile) => electron.launch({
  args: [root],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' },
});
const removeProfile = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* left in the temp folder */ } };

// Polls (in the main process, every few ms) until the chat page of a tab that is not in `exclude` (or tab `id`) is usable.
// `messages`: at least this many message bubbles must be on screen (0: don't care).
function whenReady(app, { t0, exclude = [], id = null, messages = 0, timeout = 20000 }) {
  return app.evaluate(async (_e, a) => {
    const expr = `(() => {
      const p = document.getElementById('prompt'); const b = document.body;
      if (!p || !b || b.classList.contains('cp-booting') || p.disabled) return false;
      if (!document.getElementById('cp-items').children.length) return false;
      if (${a.messages} && document.querySelectorAll('#messages .msg').length < ${a.messages}) return false;
      p.focus(); return document.activeElement === p;
    })()`;
    const end = Date.now() + a.timeout;
    while (Date.now() < end) {
      const tab = global.__chatPage.tabs().find((t) => t.chat && (a.id != null ? t.id === a.id : !a.exclude.includes(t.id)));
      const wc = tab && global.__chatPage.contents(tab.id);
      if (wc && !wc.isDestroyed()) {
        let ok = false;
        try { ok = await wc.executeJavaScript(expr); } catch { /* still loading */ }
        if (ok) return { ms: Date.now() - a.t0, id: tab.id };
      }
      await new Promise((r) => setTimeout(r, 4));
    }
    return { ms: -1, id: null };
  }, { t0, exclude, id, messages, timeout });
}

const chatTabIds = (app) => app.evaluate(() => global.__chatPage.tabs().filter((t) => t.chat).map((t) => t.id));
// Ctrl+Shift+L, through the same handler the keyboard reaches (as test/chatpage.js does)
const shortcut = (app) => app.evaluate(() => global.__pageTools.handleShortcut({ key: 'L', control: true, shift: true }));

// `spare`: a spare chat page is ready before each measured open (what a person who has used the chat page this session has).
const spareReady = async (app) => { for (let i = 0; i < 80; i++) { if (await app.evaluate(() => global.__spareChat.ready())) { await sleep(300); return true; } await sleep(100); } return false; };
async function boot(profileSrc, { spare = false } = {}) {
  const profile = copyProfile(profileSrc);
  const app = await launch(profile);
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await sleep(2500); // startup work settles, as it has by the time a person reaches for a shortcut
  if (spare) { await app.evaluate(() => global.__spareChat.enable()); await spareReady(app); }
  return { app, ui, profile, spare, ready: () => (spare ? spareReady(app) : null), done: async () => { await app.close().catch(() => {}); removeProfile(profile); } };
}

// (a) a new chat tab: the shortcut from an ordinary tab, the new-tab page's Chat button (this tab turns into the chat), and Ctrl+click on it (a new tab).
async function newChatTab(profileSrc, opts) {
  const out = {};
  const s = await boot(profileSrc, opts);
  try {
    const before = await chatTabIds(s.app);
    await s.ready();
    const t0 = Date.now();
    await shortcut(s.app);
    out.shortcut = (await whenReady(s.app, { t0, exclude: before, messages: 1 })).ms;
    // back to a new-tab page; its Ask AI button
    await s.app.evaluate(() => global.__chatPage.back());
    await sleep(1500);
    const clickChat = async (ctrl) => {
      const before = await chatTabIds(s.app);
      const home = await s.app.evaluate(async () => {
        const t = global.__agent.browser.openTab();
        await new Promise((r) => { t.webContents.once('did-finish-load', r); setTimeout(r, 6000); });
        global.__chatPage.switchTab(t.id);
        return t.id;
      });
      await sleep(1200);
      await s.ready();
      const t0b = Date.now();
      await s.app.evaluate((_e, [id, c]) => global.__chatPage.contents(id).executeJavaScript(`(() => { const b = document.getElementById('mode-ask'); const click = () => b.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${c} })); click(); if (!${c}) click(); })()`), [home, ctrl]);
      return (await whenReady(s.app, { t0: t0b, exclude: before, messages: 0 })).ms; // (the Chat button opens a new, empty chat: no messages to wait for)
    };
    out.button = await clickChat(false);
    out.buttonNewTab = await clickChat(true);
  } finally { await s.done(); }
  return out;
}

// (b) an existing chat from the chat library (the page's list): the long chat, and a short one.
async function openFromLibrary(profileSrc, { bigId, shortId, spare }) {
  const out = {};
  const s = await boot(profileSrc, { spare });
  try {
    const before = await chatTabIds(s.app);
    await shortcut(s.app);
    const first = await whenReady(s.app, { t0: Date.now(), exclude: before, messages: 1 });
    const id = first.id;
    const click = async (chatId, want) => {
      await sleep(600);
      const t0 = Date.now();
      await s.app.evaluate((_e, [tab, cid]) => global.__chatPage.contents(tab).executeJavaScript(`document.querySelector('.chat-item[data-id="${cid}"] .chat-open').click()`), [id, chatId]);
      // wait for the messages of the chat that was opened: the page shows its title and bubbles
      return (await whenReady(s.app, { t0, id, messages: want })).ms;
    };
    out.openShort = await click(shortId, 2);
    out.openBig = await click(bigId, 2);
  } finally { await s.done(); }
  return out;
}

// (c) restore: the previous session had chat tabs (the active one a chat); time from launching the app to that chat being usable.
// First run: open `tabs` chat tabs on the long chat's profile and quit (the session is saved). Second: launch and time it.
async function restoreChatTabs(profileSrc, { tabs = 3, bigId, spare = false } = {}) {
  const profile = copyProfile(profileSrc);
  try {
    const first = await launch(profile);
    const ui = await first.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(1500);
    for (let i = 0; i < tabs; i++) {
      const before = await chatTabIds(first);
      await first.evaluate(() => global.__chatPage.fromHome(null, { inNewTab: true }));
      await whenReady(first, { t0: Date.now(), exclude: before, messages: 0 }); // (a new, empty chat)
      await sleep(400);
    }
    if (bigId) {
      const id = (await chatTabIds(first)).slice(-1)[0];
      await first.evaluate((_e, [tab, cid]) => global.__chatPage.contents(tab).executeJavaScript(`document.querySelector('.chat-item[data-id="${cid}"] .chat-open')?.click()`), [id, bigId]);
      await sleep(1500);
    }
    await first.close();
    const t0 = Date.now();
    const app = await launch(profile);
    try {
      const ui2 = await app.firstWindow();
      const shown = await whenReady(app, { t0, messages: 1 });
      await ui2.waitForSelector('.tab');
      const marks = await app.evaluate(() => global.__perf.marks()).catch(() => ({}));
      // then each of the other restored chat tabs, switched to (they load when first opened)
      const ids = await app.evaluate(() => global.__tabSleep.state().map((t) => t.id));
      const switches = [];
      if (spare) await app.evaluate(() => global.__spareChat.enable());
      for (const id of ids) {
        const active = await app.evaluate(() => global.__chatPage.activeId());
        if (id === active) continue;
        if (spare) await spareReady(app);
        const t1 = Date.now();
        await app.evaluate((_e, tid) => global.__chatPage.switchTab(tid), id);
        switches.push((await whenReady(app, { t0: t1, id, messages: 1 })).ms);
      }
      return { restore: shown.ms, tabs: ids.length, uiReady: marks?.uiReady ?? null, switches };
    } finally { await app.close().catch(() => {}); }
  } finally { removeProfile(profile); }
}

// (d) opening several chat tabs in a row (Ctrl+click on the new-tab page's Chat button, five times): each one's time.
async function openSeveral(profileSrc, { n = 5, spare = false, wait = 0 } = {}) {
  const s = await boot(profileSrc, { spare });
  const times = [];
  try {
    for (let i = 0; i < n; i++) {
      const before = await chatTabIds(s.app);
      await s.ready();
      const t0 = Date.now();
      await s.app.evaluate(() => global.__chatPage.fromHome(null, { inNewTab: true }));
      times.push((await whenReady(s.app, { t0, exclude: before, messages: 0 })).ms); // (a new, empty chat)
      await sleep(wait);
    }
  } finally { await s.done(); }
  return times;
}

module.exports = { newChatTab, openFromLibrary, restoreChatTabs, openSeveral, copyProfile, removeProfile, sleep };
