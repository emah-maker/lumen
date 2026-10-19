// Times how long chat tabs take to open, hidden, on a seeded throwaway profile (50 chats, long messages, Markdown, code, mermaid):
//   node scripts/measure-chat-tabs.js [runs=3]
// (a) a new chat tab (shortcut, the new-tab page's Chat button, Ctrl+click on it), (b) an existing chat from the chat library,
// (c) restoring chat tabs at startup, (d) opening several chat tabs. The shared code is test/_chat-speed.js; test/chat-tab-speed.js asserts ceilings.
require('../test/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seed } = require('../test/_chat-seed');
const speed = require('../test/_chat-speed');

const median = (xs) => { const s = xs.filter((x) => x >= 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : -1; };

(async () => {
  const runs = Number(process.argv[2]) || 3;
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-chatseed-'));
  const { ids } = await seed(src, { chats: 50, big: 60 });
  const bigId = ids[0];
  const shortId = ids[3];
  const all = { shortcut: [], button: [], buttonNewTab: [], openShort: [], openBig: [], restore: [], switches: [], several: [], spareShortcut: [], spareButton: [], spareSeveral: [], spareSwitches: [] };
  for (let i = 0; i < runs; i++) {
    const a = await speed.newChatTab(src);
    for (const k of ['shortcut', 'button', 'buttonNewTab']) all[k].push(a[k]);
    const b = await speed.openFromLibrary(src, { bigId, shortId });
    all.openShort.push(b.openShort); all.openBig.push(b.openBig);
    const c = await speed.restoreChatTabs(src, { tabs: 3, bigId });
    all.restore.push(c.restore); all.switches.push(...c.switches);
    all.several.push(...await speed.openSeveral(src, { n: 5 }));
    const w = await speed.newChatTab(src, { spare: true });
    all.spareShortcut.push(w.shortcut); all.spareButton.push(w.button);
    all.spareSeveral.push(...await speed.openSeveral(src, { n: 5, spare: true }));
    all.spareSwitches.push(...(await speed.restoreChatTabs(src, { tabs: 3, bigId, spare: true })).switches);
    console.log(`run ${i + 1}:`, JSON.stringify({ a, b, c }));
  }
  console.log('\nmedians (ms), runs =', runs);
  for (const [k, v] of Object.entries(all)) console.log(`${k.padEnd(14)} ${median(v)}   all: ${v.join(', ')}`);
  speed.removeProfile(src);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
