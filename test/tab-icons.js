// A tab's indicators never overlap (renderer/styles.css, tab-search.js): the AI marks (sparkle, chat spinner) and the speaker, at every tab
// width and layout (top strip normal / squeezed / pinned, side tabs normal / icons only, split pair). On a narrow tab the speaker is a small
// badge on the icon's lower-left corner (a click still mutes), the chat mark is the lower-right one and the sparkle the upper right.
// The tab states are faked in the renderer (the quiet test runs never report sound), the windows are hidden, the profile is a temp folder.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/tab-icons.js
/* global renderTabsNow:writable, lastTabState */
require('./_tmp-cleanup');
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
  // Nothing here may wait forever: every renderer / main-process call and the whole run are bounded and fail with a message that names the step.
  let step = 'starting'; let app = null; let ui = null;
  const bound = (p, what, ms = 20000) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s: ${what} (step: ${step})`)), ms); })]).finally(() => clearTimeout(t)); };
  giveUp = async (why) => {
    console.log(`FAIL  ${why}`);
    const probe = async (n, f) => { try { await bound(f(), n, 3000); console.log(`  ${n}: responds`); } catch (e) { console.log(`  ${n}: ${e.message}`); } };
    if (app) { await probe('main process', () => app.evaluate(() => 1)); await probe('window renderer', () => ui.evaluate(() => 1)); try { app.process().kill(); } catch {} }
    process.exit(1);
  };
  const watchdog = setTimeout(() => giveUp(`the whole suite took longer than 240s (step: ${step})`), 240000); watchdog.unref();
  const server = http.createServer((q, r) => { r.setHeader('Content-Type', 'text/html'); r.end(`<title>Page ${q.url.slice(1)}</title><p>x</p>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tab-icons-'));
  app = await bound(electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile } }), 'launching the app', 60000);
  ui = await bound(app.firstWindow(), 'the first window', 30000);
  await ui.waitForSelector('.tab', { timeout: 30000 });
  for (const target of [app, ui]) { const ev = target.evaluate.bind(target); target.evaluate = (f, a) => bound(ev(f, a), `${target === app ? 'main' : 'renderer'} call`); }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
  await ui.evaluate(() => window.assistant.setAutoGroup(false));
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  const open = (u) => { step = `opening ${u}`; return app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u, { background: true }); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 4000); }); return t.id; }, u); };
  const setting = (k, v) => { step = `setting ${k}`; return app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v), [k, v]); };

  // Every tab shows sound (the second one muted), the AI sparkle and the chat spinner; `o` says which are pinned / split / active.
  const fake = async (o) => {
    step = `faking tab states ${JSON.stringify(o)}`;
    await ui.evaluate((o) => {
      window.__fo = o;
      if (!window.__origRTN) {
        window.__origRTN = renderTabsNow;
        renderTabsNow = (st) => {
          const s = JSON.parse(JSON.stringify(st)); const f = window.__fo;
          s.tabs.forEach((t, i) => { t.audible = i !== 1; t.muted = i === 1; t.aiOpened = true; t.chat = 'running'; t.aiReading = f.reading === i; t.pinned = f.pinned.includes(i); t.split = f.split[i] || undefined; });
          if (f.group) { s.groups = [{ id: 99, name: 'Lab', color: 'orange', collapsed: false }]; s.tabs.forEach((t, i) => { if (i < 3) t.groupId = 99; }); } else { s.groups = []; s.tabs.forEach((t) => { delete t.groupId; }); }
        if (f.active != null) s.activeId = s.tabs[f.active].id;
          return window.__origRTN(s);
        };
      }
      renderTabsNow(lastTabState);
    }, o);
    await sleep(700);
  };
  const measure = () => ui.evaluate(() => [...document.querySelectorAll('#tabs .tab:not(.tab-ghost)')].filter((t) => t.querySelector('.tab-audio')).map((tab) => {
    const R = (el) => { if (!el) return null; const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null; const r = el.getBoundingClientRect(); return r.width || r.height ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; };
    const hit = (x, y) => x.l < y.r - 0.5 && y.l < x.r - 0.5 && x.t < y.b - 0.5 && y.t < x.b - 0.5;
    const a = R(tab.querySelector('.tab-audio'));
    const tr = tab.getBoundingClientRect(); const T = { l: tr.left, t: tr.top, r: tr.right, b: tr.bottom };
    const others = { sparkle: R(tab.querySelector('.tab-ai-mark svg')), chat: R(tab.querySelector('.tab-chat-mark svg')), close: R(tab.querySelector('.tab-close')) };
    const bad = Object.entries(others).filter(([, v]) => v && a && hit(a, v)).map(([k]) => k);
    const sp = others.sparkle, ch = others.chat;
    const inside = (v) => !v || (v.l >= T.l - 0.5 && v.r <= T.r + 0.5 && v.t >= T.t - 0.5 && v.b <= T.b + 0.5);
    const el = tab.querySelector('.tab-audio'); const x = a ? (a.l + a.r) / 2 : 0, y = a ? (a.t + a.b) / 2 : 0;
    const top = document.elementFromPoint(x, y);
    const sr = (document.querySelector('#tabs.side') || document.getElementById('tabs')).getBoundingClientRect(); const shown = tr.left >= sr.left + 28 && tr.right <= sr.right - 28 && tr.top >= sr.top - 1 && tr.bottom <= sr.bottom + 1; // (a tab scrolled away behind the strip's fade can't be clicked)
    return { id: tab.dataset.id, w: Math.round(tr.width), bad, sparkleVsChat: Boolean(sp && ch && hit(sp, ch)), inside: inside(a) && inside(sp) && inside(ch), clickable: !shown || Boolean(top && (top === el || el.contains(top))), title: el.title || '', label: el.getAttribute('aria-label') || '' };
  }));

  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await open(`${base}/${i}`));
  const verify = async (name) => {
    step = `checking ${name}`;
    const rows = await measure();
    check(`${name}: tabs with a speaker were measured`, rows.length >= 2, rows.length);
    for (const r of rows) {
      const where = `${name}, tab ${r.id}, ${r.w}px`;
      check(`${where}: the speaker overlaps no AI mark and no ✕`, r.bad.length === 0, r.bad.join());
      check(`${where}: the sparkle and the chat mark do not overlap`, !r.sparkleVsChat, 'overlap');
      check(`${where}: the indicators sit inside the tab`, r.inside, 'outside');
      check(`${where}: a click on the speaker lands on it`, r.clickable, 'covered');
      check(`${where}: its tooltip names the state`, /^(Mute|Unmute) tab/.test(r.title) && r.label.includes(r.title), `${r.title} | ${r.label}`);
    }
    const muted = rows.find((r, i) => i === 1);
    if (muted) check(`${name}: the muted one says unmute`, /^Unmute tab/.test(muted.title), muted.title);
  };

  const plain = { pinned: [], split: {}, active: 0 };
  await setting('tabLayout', 'top'); await sleep(900);
  await fake(plain); await verify('top, normal');
  await fake({ ...plain, active: null }); await verify('top, normal, none active');
  await fake({ ...plain, reading: 2 }); await verify('top, normal, AI reading a tab');
  await fake({ pinned: [0, 1], split: {}, active: 3 }); await verify('top, pinned');
  await fake({ pinned: [], split: { 2: 'left', 3: 'right' }, active: 0 }); await verify('top, split pair');
  await setting('tabLayout', 'side'); await setting('sideTabsCollapsed', false); await sleep(1200);
  await fake(plain); await verify('side, normal');
  await fake({ pinned: [0, 1], split: {}, active: 3 }); await verify('side, pinned');
  await setting('sideTabsCollapsed', true); await sleep(1200);
  await fake(plain); await verify('side, icons only');
  await setting('tabLayout', 'top'); await sleep(900);
  for (let i = 0; i < 22; i++) await open(`${base}/s${i}`);
  await sleep(500);
  await fake({ ...plain, reading: 2 }); await verify('top, squeezed (26 tabs)');
  await fake({ ...plain, active: 5 }); await verify('top, squeezed, another tab active');
  // A group chip beside tabs whose chat is working: the chip and the first tab keep apart, a title is shown whole enough to read or not at all,
  // and the working ring is the accent colour (never an error red).
  const groupCase = async (name, o) => {
    step = `group case ${name}`;
    await fake({ ...o, group: true });
    const g = await ui.evaluate(() => {
      const chip = document.querySelector('#tabs .group-label'); const tabs = [...document.querySelectorAll('#tabs .tab.grouped')];
      const root = document.createElement('i'); root.style.color = 'var(--accent)'; document.body.append(root); const accent = getComputedStyle(root).color; root.remove();
      const first = tabs[0]; const cr = chip.getBoundingClientRect(); const fr = first.getBoundingClientRect();
      return {
        gap: Math.max(fr.left - cr.right, fr.top - cr.bottom), chipInside: cr.height > 0 && cr.top >= first.parentElement.getBoundingClientRect().top - 1,
        titles: tabs.map((t) => { const el = t.querySelector('.tab-title'); const cs = getComputedStyle(el); return { hidden: cs.display === 'none', w: el.clientWidth, w0: Math.round(t.getBoundingClientRect().width) }; }),
        ringColors: tabs.map((t) => getComputedStyle(t.querySelector('.tab-chat-mark')).color), accent,
        spinner: [...document.querySelectorAll('#tabs .tab-favicon.spinner')].map((s) => getComputedStyle(s).borderTopColor),
      };
    });
    check(`${name}: the group chip and its first tab do not touch`, g.gap >= 0, g.gap);
    check(`${name}: a grouped tab's title is readable or away, never a letter`, g.titles.every((t) => t.hidden || t.w >= 40), JSON.stringify(g.titles));
    check(`${name}: the working ring is the accent colour`, g.ringColors.every((c) => c === g.accent) && g.spinner.every((c) => c === g.accent), JSON.stringify([g.ringColors, g.spinner, g.accent]));
  };
  await groupCase('group, squeezed', { pinned: [], split: {}, active: 0, reading: 1 });
  for (const [mode, layout] of [['group, side', 'side']]) { await setting('tabLayout', layout); await sleep(1000); await groupCase(mode, { pinned: [], split: {}, active: 0, reading: 1 }); }
  check('no page errors', errors.length === 0, errors.join(' | '));
  step = 'closing the app'; await bound(app.close(), 'closing the app', 20000).catch(() => { try { app.process().kill(); } catch {} });
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log(`FAIL  ${e.message}`); return giveUp('the suite stopped on an error'); });
