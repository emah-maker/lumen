// How fast a chat tab opens (the full-page chat, lumen://chat), in the real app, hidden (LUMEN_TEST_BACKGROUND=1), on a throwaway
// profile with a realistic history: 50 saved chats, the newest of 60 exchanges with long replies, Markdown, code blocks, tables, math and a
// mermaid diagram in every fifth reply (test/_chat-seed.js). Every number runs from the keypress or click (or from starting the app) to
// a usable page: out of its boot state, the chat list drawn, the open chat's messages on screen and the composer focused
// (test/_chat-speed.js). scripts/measure-chat-tabs.js prints the same numbers.
//
// The ceilings sit about two and a half times above what a developer machine measures, so noise does not fail a run, and below what the
// page cost before this work (about 1.4 s for a new chat tab, 1.9 s to restore one, 0.5 s to open the long chat from the library):
// a chat that renders every message with a layout each, or draws every diagram when it opens, trips them.
//   what it was -> measured now -> ceiling:
//   new chat tab, cold      1400 ->  380 -> 1000    (shortcut, the new-tab page's Chat button, Ctrl+click on it)
//   new chat tab, spare      n/a ->  150 ->  600    (a chat page was loaded in the background first)
//   existing chat, library   517 ->   80 ->  400    (the 60-exchange chat)
//   restore at start-up     1857 ->  800 -> 1500    (chat tabs kept from the last session)
//   woken restored tab      1407 ->  440 -> 1000
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seed } = require('./_chat-seed');
const speed = require('./_chat-speed');
const { _electron: electron } = require('playwright-core');

const CEILING = { cold: 1000, spare: 600, library: 400, restore: 1500, wake: 1000 };
const median = (xs) => { const s = xs.filter((x) => x >= 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : -1; };
const best = (xs) => { const s = xs.filter((x) => x >= 0); return s.length ? Math.min(...s) : -1; }; // (the fastest of a few runs: one slow run on a busy machine is not the page)

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const within = (label, ms, ceiling) => check(`${label} <= ${ceiling} ms (${ms} ms)`, ms >= 0 && ms <= ceiling, `${ms} ms`);

  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-chatspeed-seed-'));
  const { ids } = await seed(src, { chats: 50, big: 60 });
  const bigId = ids[0];
  const shortId = ids[3];
  check('the profile holds 50 chats', ids.length === 50, ids.length);

  // ---- (a) a new chat tab
  const cold = [];
  const a = { shortcut: [], button: [], buttonNewTab: [] };
  for (let i = 0; i < 2; i++) { const r = await speed.newChatTab(src); for (const k of Object.keys(a)) a[k].push(r[k]); }
  within('(a) a new chat tab from the shortcut', best(a.shortcut), CEILING.cold);
  within("(a) the new-tab page's Chat button turns the tab into the chat", best(a.button), CEILING.cold);
  within('(a) Ctrl+click on the Chat button opens a chat tab', best(a.buttonNewTab), CEILING.cold);
  cold.push(...a.shortcut, ...a.button, ...a.buttonNewTab);

  // with a spare chat page loaded in the background first
  const w = { shortcut: [], button: [], buttonNewTab: [] };
  for (let i = 0; i < 2; i++) { const r = await speed.newChatTab(src, { spare: true }); for (const k of Object.keys(w)) w[k].push(r[k]); }
  within('(a) the shortcut, with a spare chat page ready', best(w.shortcut), CEILING.spare);
  within("(a) the Chat button, with a spare chat page ready", best(w.button), CEILING.spare);
  within('(a) Ctrl+click on the Chat button, with a spare chat page ready', best(w.buttonNewTab), CEILING.spare);
  check('a spare chat page is clearly sooner than a cold one', median([...w.shortcut, ...w.button, ...w.buttonNewTab]) < median(cold), `${median([...w.shortcut, ...w.button, ...w.buttonNewTab])} vs ${median(cold)} ms`);

  // ---- (b) an existing chat from the chat library
  const b = { openShort: [], openBig: [] };
  for (let i = 0; i < 2; i++) { const r = await speed.openFromLibrary(src, { bigId, shortId }); b.openShort.push(r.openShort); b.openBig.push(r.openBig); }
  within('(b) a short chat opens from the library', best(b.openShort), CEILING.library);
  within('(b) the 60-exchange chat opens from the library', best(b.openBig), CEILING.library);

  // ---- (c) chat tabs kept from the last session, with "continue where you left off"
  const c = { restore: [], switches: [] };
  for (let i = 0; i < 2; i++) { const r = await speed.restoreChatTabs(src, { tabs: 3, bigId }); c.restore.push(r.restore); c.switches.push(...r.switches.filter((x) => x > 50)); check('three chat tabs came back', r.tabs === 3, r.tabs); }
  within('(c) the chat tab in front at start-up is usable', best(c.restore), CEILING.restore);
  within('(c) a restored chat tab is usable when first opened', best(c.switches), CEILING.wake);

  // ---- (d) several chat tabs in a row
  const d = await speed.openSeveral(src, { n: 5 });
  check('(d) five chat tabs in a row all opened', d.length === 5 && d.every((x) => x >= 0), JSON.stringify(d));
  within('(d) the slowest of five chat tabs in a row', Math.max(...d), CEILING.cold);
  const dSpare = await speed.openSeveral(src, { n: 5, spare: true });
  within('(d) the slowest of five chat tabs, each with a spare ready', Math.max(...dSpare), CEILING.spare);

  // ---- the spare chat page and the long chat, in detail
  const profile = speed.copyProfile(src);
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await speed.sleep(1500);
    const inPage = (id, code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__chatPage.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, [id, code]);
    check('no spare chat page is made unless someone uses the chat page (and tests ask for one)', await app.evaluate(() => !global.__spareChat.has()), '');

    await app.evaluate(() => global.__spareChat.enable());
    await speed.sleep(200);
    for (let i = 0; i < 60 && !(await app.evaluate(() => global.__spareChat.ready())); i++) await speed.sleep(100);
    check('a spare chat page loads in the background', await app.evaluate(() => global.__spareChat.ready()), '');
    await speed.sleep(400);
    const held = await app.evaluate(async () => {
      const wc = global.__spareChat.contents();
      return wc.executeJavaScript("Promise.race([window.assistant.state().then(() => 'answered', () => 'refused'), new Promise((r) => setTimeout(() => r('held'), 400))])");
    });
    check('its calls wait until a tab takes it (they would be refused, and nothing may reach the chats)', held === 'held', held);
    const noChats = await app.evaluate(() => global.__spareChat.contents().executeJavaScript("document.querySelectorAll('#cp-items .chat-item').length === 0 && document.querySelectorAll('#messages .msg').length === 0"));
    check('and it shows no chat yet', noChats === true, noChats);

    const spareId = await app.evaluate(() => global.__spareChat.contents().id);
    const opened = await app.evaluate(() => global.__chatPage.open()); // (the shortcut's path: a chat tab on the last chat; the Chat button opens a new, empty chat)
    const taken = await app.evaluate((_e, id) => global.__chatPage.contents(id).id, opened);
    check('a chat tab takes the spare page', taken === spareId, `${taken} vs ${spareId}`);
    const ready = await app.evaluate(async (_e, id) => {
      const end = Date.now() + 8000;
      while (Date.now() < end) {
        const ok = await global.__chatPage.contents(id).executeJavaScript("!document.body.classList.contains('cp-booting') && document.querySelectorAll('#messages .msg').length > 0 && document.getElementById('cp-items').children.length > 0").catch(() => false);
        if (ok) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    }, opened);
    check('the page starts once it is a tab: its chat list and the open chat show', ready === true, ready);
    const url = await app.evaluate((_e, id) => global.__chatPage.contents(id).getURL(), opened);
    check('its address is the chat page, with nothing added to it', /renderer\/chat-page\.html$/.test(url), url);

    // ---- the long chat
    // (a long chat is drawn newest first, the older messages filling in above while the window is idle: the first screenful is there at once, the whole chat a moment later)
    for (let i = 0; i < 100 && !(Number(await inPage(opened, "document.querySelectorAll('#messages .msg').length")) >= 120); i++) await speed.sleep(100);
    const state = await inPage(opened, `(() => {
      const m = document.getElementById('messages');
      return JSON.stringify({ msgs: m.querySelectorAll('.msg').length, atBottom: m.scrollHeight - m.scrollTop - m.clientHeight < 150, mermaid: typeof window.mermaid, boxes: document.querySelectorAll('.code-block[data-diagram]').length, drawn: document.querySelectorAll('.code-block.mermaid-ok').length });
    })()`);
    const st = JSON.parse(state);
    check('the long chat is on screen, scrolled to its newest message', st.msgs >= 120 && st.atBottom, state);
    check('Mermaid (3.5 MB) is not loaded when the chat opens: diagrams far up the chat wait', st.mermaid === 'undefined', state);
    await inPage(opened, "document.getElementById('messages').scrollTop = 0");
    let drawn = 0;
    for (let i = 0; i < 80 && !drawn; i++) { await speed.sleep(100); drawn = Number(await inPage(opened, "document.querySelectorAll('.code-block.mermaid-ok').length")) || 0; }
    check('a diagram is drawn when it comes near the view', drawn > 0, drawn);
    await inPage(opened, "document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight");

  } finally {
    await app.close().catch(() => {});
    speed.removeProfile(profile);
  }

  speed.removeProfile(src);
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
