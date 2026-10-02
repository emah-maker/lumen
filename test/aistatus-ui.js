// The AI status card on the new-tab page, in a real window: it renders from the facts Lumen holds (the test stands in the facts), follows
// them live without a reload, adapts to the card's size (summary and dots, then rows, then detail and the live strip) and never
// overflows or clips at any size. The window is off-screen (LUMEN_TEST_BACKGROUND) and the profile a throwaway.
'use strict';
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-aistatus-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [{ id: 'waistat01', type: 'aistatus', x: 0, y: 0, w: 3, h: 3 }] }));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aistatus-cli-')), LUMEN_CLAUDE_BIN: path.join(os.tmpdir(), 'lumen-aistatus-no-such-claude') };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const inTab = (js) => app.evaluate((_e, code) => global.__homeTab.webContents.executeJavaScript(code), js);
    const waitFor = async (code, tries = 40) => { for (let i = 0; i < tries; i++) { if (await inTab(code).catch(() => false)) return true; await sleep(150); } return false; };
    const setFacts = (facts) => app.evaluate((_e, f) => { global.__aiStatusFacts = f ? () => f : null; }, facts);
    const NOW = Date.now();
    const MANY = {
      apis: ['anthropic', 'openai', 'xai', 'gemini', 'openrouter'],
      engines: { claudecode: { installed: true, signedIn: true }, grokbuild: { installed: true, signedIn: false, enabled: true }, antigravity: { installed: false } },
      current: { provider: 'claudecode', label: 'Sonnet' },
      cooling: { claudecode: { until: NOW + 3 * 3600e3, kind: 'limit', exact: true, scope: 'provider' }, openai: { until: NOW + 3600e3, kind: 'limit', exact: false, scope: 'model', model: 'GPT-5.6' } },
      meter: null, grokLimit: null, today: { claudecode: { turns: 3, costUSD: 0.42 } },
      fullAccess: { claudecode: true }, runs: { working: 1, waiting: 2, max: 3 }, aiTabs: 4, handsOff: true,
    };

    // The real facts (nothing stood in) shape up without error: on a fresh profile no provider, and the three CLIs.
    await setFacts(null);
    await sleep(400);
    const real = await app.evaluate(() => { const c = global.__widgets.forPage().find((x) => x.id === 'waistat01'); return c ? { type: c.type, ais: (c.data?.ais || []).length, summary: c.data?.summary || null, kinds: (c.data?.ais || []).map((a) => `${a.id}:${a.state}`) } : null; });
    check('real facts: the card is built from this browser’s own state (three CLI rows, no providers on a fresh profile)', real && real.type === 'aistatus' && real.ais >= 3 && /ready|No AI set up/.test(real.summary || ''), JSON.stringify(real));
    await setFacts(MANY);

    // A new-tab page.
    await app.evaluate(async () => {
      const t = global.__agent.browser.openTab();
      await new Promise((r) => t.webContents.once('did-finish-load', r));
      global.__homeTab = t;
    });
    check('the card is on the page', await waitFor("Boolean(document.querySelector('.w-card.aistatus .ai-sum'))"), '');

    // Sizes: set the card's cells (the real layout path), then measure what the page drew.
    const setCells = async (w, h) => {
      await app.evaluate((_e, [cw, ch]) => global.__widgets.layout([{ id: 'waistat01', x: 0, y: 0, w: cw, h: ch }]), [w, h]);
      await sleep(250);
      await waitFor("Boolean(document.querySelector('.w-card.aistatus .ai-sum'))");
      await sleep(300);
    };
    const measure = () => inTab(`(() => {
      const card = document.querySelector('.w-card.aistatus');
      const body = card.querySelector('.w-body');
      const cr = card.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      const shown = (n) => n.getClientRects().length > 0;
      const out = { w: Math.round(cr.width), h: Math.round(cr.height), cardX: card.scrollWidth - card.clientWidth, cardY: card.scrollHeight - card.clientHeight, bodyX: body.scrollWidth - body.clientWidth, bodyY: body.scrollHeight - body.clientHeight, outside: [], clipped: [] };
      for (const n of body.querySelectorAll('*')) {
        if (!shown(n) || n.classList.contains('ai-sr')) continue;
        const r = n.getBoundingClientRect();
        if (r.width && (r.right > br.right + 1 || r.bottom > br.bottom + 1 || r.left < br.left - 1 || r.top < br.top - 1)) out.outside.push(n.className + ':' + (n.textContent || '').slice(0, 24));
        if (n.children.length === 0 && n.textContent.trim() && n.scrollWidth > n.clientWidth + 1) out.clipped.push(n.className + ':' + n.textContent.slice(0, 24));
      }
      const vis = (sel) => [...body.querySelectorAll(sel)].filter(shown).length;
      out.sum = vis('.ai-sum'); out.dots = vis('.ai-dot'); out.rows = vis('.ai-row'); out.details = vis('.ai-detail'); out.live = vis('.ai-live'); out.sub = vis('.ai-sub'); out.more = vis('.ai-more');
      const hOf = (sel) => { const n = body.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().height) + (shown(n) ? '' : 'x') : 0; };
      out.bodyH = body.clientHeight; out.bodyW = body.clientWidth; out.sumH = hOf('.ai-sum'); out.dotsH = hOf('.ai-dots'); out.compactH = hOf('.ai-compact');
      out.sumText = (body.querySelector('.ai-sum') || {}).textContent || '';
      out.headTitle = (card.querySelector('.w-head h2') || {}).textContent || '';
      return out;
    })()`);
    // LUMEN_AISTATUS_SHOTS=<folder>: also save a picture of the card at each size (for looking at, not checked).
    const shot = async (name) => {
      if (!process.env.LUMEN_AISTATUS_SHOTS) return;
      const r = await inTab("(() => { const b = document.querySelector('.w-card.aistatus').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })()");
      const png = await app.evaluate(async (_e, [x, y, w, h]) => (await global.__homeTab.webContents.capturePage({ x: Math.floor(x), y: Math.floor(y), width: Math.ceil(w), height: Math.ceil(h) })).toPNG().toString('base64'), r);
      fs.mkdirSync(process.env.LUMEN_AISTATUS_SHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.LUMEN_AISTATUS_SHOTS, `${name}.png`), Buffer.from(png, 'base64'));
    };
    const sizes = [[2, 2], [3, 2], [2, 3], [3, 3], [4, 3], [4, 4], [6, 4], [6, 6], [12, 8]];
    const seen = {};
    for (const [w, h] of sizes) {
      await setCells(w, h);
      const m = await measure();
      seen[`${w}x${h}`] = m;
      await shot(`${w}x${h}-light`);
      const label = `${w}x${h} cells (${m.w}x${m.h}px)`;
      check(`${label}: nothing overflows the card or its body`, m.cardX <= 1 && m.cardY <= 1 && m.bodyX <= 1 && m.bodyY <= 2, JSON.stringify(m));
      check(`${label}: nothing is drawn outside the body or cut off`, m.outside.length === 0 && m.clipped.length === 0, JSON.stringify([m.outside, m.clipped]));
      check(`${label}: it says something useful`, m.headTitle === 'AI status' && (m.sum === 1 || m.rows >= 1), JSON.stringify(m));
    }
    console.log('sizes seen:', JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, m]) => [k, `${m.w}x${m.h} sum${m.sum} dots${m.dots} rows${m.rows} det${m.details} live${m.live} sub${m.sub} more${m.more}`]))));
    const m22 = seen['2x2'];
    check('2x2: the compact summary line, "N ready · M working", and a dot per AI', m22.sum === 1 && /^\d+ ready · \d+ working/.test(m22.sumText) && m22.rows === 0 && m22.live === 0 && m22.dots === 8, JSON.stringify(m22));
    check('3x3 and up: a row per AI, as many as fit', seen['3x3'].rows >= 3 && seen['3x3'].sum === 0, JSON.stringify(seen['3x3']));
    check('6x4: every AI has a row, or the rest are counted as "+N more"', seen['6x4'].rows >= 7 || (seen['6x4'].rows >= 3 && seen['6x4'].more === 1), JSON.stringify(seen['6x4']));
    check('6x6: the second lines (model, limit, usage) and the live strip show', seen['6x6'].details >= 3 && seen['6x6'].live === 1, JSON.stringify(seen['6x6']));
    check('12x8: everything is there', seen['12x8'].rows === 8 && seen['12x8'].live === 1 && seen['12x8'].details >= 4 && seen['12x8'].more === 0, JSON.stringify(seen['12x8']));

    // Odd sizes in between and below the 2x2 cell (a narrow window or a custom width): the card is forced to a pixel size, as a resize would.
    for (const [w, h] of [[100, 94], [130, 120], [150, 112], [160, 150], [150, 200], [200, 140], [215, 170], [260, 160], [300, 100], [90, 300]]) {
      await inTab(`(() => { const c = document.querySelector('.w-card.aistatus'); c.style.width = '${w}px'; c.style.height = '${h}px'; })()`);
      await sleep(350);
      const m = await measure();
      await shot(`px-${w}x${h}`);
      check(`${w}x${h}px: nothing overflows, is outside the body or is cut off`, m.cardX <= 1 && m.cardY <= 1 && m.bodyX <= 1 && m.bodyY <= 2 && m.outside.length === 0 && m.clipped.length === 0 && (m.sum === 1 || m.rows >= 1), JSON.stringify(m));
      console.log(`  ${w}x${h}px: body ${m.bodyW}x${m.bodyH} sumH ${m.sumH} dotsH ${m.dotsH} compactH ${m.compactH} sum${m.sum} dots${m.dots} rows${m.rows} det${m.details} live${m.live} sub${m.sub} more${m.more}`);
    }

    // Text content at a large size: states in words, the model, the limit with its reset time, the live strip.
    await setCells(3, 3);
    await setCells(12, 8);
    const text = await inTab("document.querySelector('.w-card.aistatus .w-body').innerText");
    check('large: each AI’s state is written out (not only a colour)', /Claude Code[\s\S]*Limit reached/.test(text) && /Signed out/.test(text) && /Not installed/.test(text) && /Connected/.test(text), text);
    check('large: the model in use, the full-access state and a limit’s reset time', /Using Sonnet/.test(text) && /Full access on/.test(text) && /Resets \d{1,2}:\d{2}/.test(text), text);
    check('large: the live strip says chats working, waiting, the AI tabs and Hands-off', /1 of 3 chats working/.test(text) && /2 waiting/.test(text) && /4 AI tabs/.test(text) && /Hands-off on/.test(text), text);
    // Roles and names.
    const aria = await inTab(`(() => { const card = document.querySelector('.w-card.aistatus'); return { role: card.getAttribute('role'), label: card.getAttribute('aria-label'), lists: card.querySelectorAll('ul').length, mark: [...card.querySelectorAll('.ai-mark')].every((m) => m.getAttribute('aria-hidden') === 'true') }; })()`);
    check('accessible: the card is a named group, lists are lists, the shapes are hidden from a screen reader', aria.role === 'group' && /^AI status: \d+ ready/.test(aria.label) && aria.lists >= 2 && aria.mark, JSON.stringify(aria));
    // Compact: the dots are named in text.
    await setCells(2, 2);
    const dotsText = await inTab("[...document.querySelectorAll('.w-card.aistatus .ai-dot')].map((d) => d.textContent + '|' + d.title).join('; ')");
    check('compact: every dot has its AI and state as text (and a tooltip)', /Claude Code: Limit reached\|Claude Code: Limit reached/.test(dotsText) && /Antigravity: Not installed/.test(dotsText), dotsText);

    // Live: the facts change, one nudge from main, and the open page redraws by itself (no reload, nothing called on the page).
    await setFacts({ ...MANY, cooling: {}, runs: { working: 3, waiting: 0, max: 3 }, aiTabs: 0, handsOff: false });
    await app.evaluate(() => global.__widgets.aiStatusSoon());
    check('live: a chat starting (facts changed, main nudged) updates the open page by itself: the summary says 3 working', await waitFor("/3 working/.test(document.querySelector('.w-card.aistatus .ai-sum')?.textContent || '')", 40), await inTab("document.querySelector('.w-card.aistatus').innerText"));
    await setFacts({ ...MANY, cooling: {}, runs: { working: 0, waiting: 0, max: 3 } });
    await app.evaluate(() => global.__widgets.aiStatusChanged());
    check('live: back to idle', await waitFor("/idle/.test(document.querySelector('.w-card.aistatus .ai-sum')?.textContent || '')"), await inTab("document.querySelector('.w-card.aistatus').innerText"));

    // Nothing set up.
    await setFacts({ apis: [], engines: { claudecode: { installed: false }, grokbuild: { installed: false }, antigravity: { installed: false } }, runs: { working: 0, waiting: 0, max: 3 } });
    await app.evaluate(() => global.__widgets.aiStatusChanged());
    check('empty: "No AI set up"', await waitFor("/No AI set up/.test(document.querySelector('.w-card.aistatus .ai-sum')?.textContent || '')"), '');
    const empty = await measure();
    check('empty: nothing overflows at the smallest size', empty.cardY <= 1 && empty.bodyY <= 2 && empty.outside.length === 0 && empty.clipped.length === 0, JSON.stringify(empty));

    // Light, dark and glass ("on-media" is the photo look): the card is readable and contained under each.
    await setFacts(MANY);
    await app.evaluate(() => global.__widgets.aiStatusChanged());
    const emulate = (scheme) => app.evaluate(async ({ webContents }, s) => { const wc = global.__homeTab.webContents; if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s }] }); return true; }, scheme).catch(() => false);
    for (const [scheme, media] of [['light', false], ['dark', false], ['dark', true]]) {
      const emulated = await emulate(scheme);
      for (const [w, h] of [[2, 2], [3, 3], [6, 6]]) {
        await setCells(w, h);
        await inTab(`document.body.classList.toggle('on-media', ${media})`);
        await sleep(150);
        const colors = await inTab(`(() => { const c = document.querySelector('.w-card.aistatus'); const m = c.querySelector('.ai-mark'); const t = c.querySelector('.ai-sum, .ai-name'); return { mark: getComputedStyle(m).backgroundColor, text: getComputedStyle(t).color, bg: getComputedStyle(c).backgroundColor, dark: matchMedia('(prefers-color-scheme: dark)').matches }; })()`);
        const m = await measure();
        await shot(`${scheme}${media ? '-glass' : ''}-${w}x${h}`);
        check(`${scheme}${media ? ' + glass' : ''} ${w}x${h}: readable and contained${emulated ? '' : ' (scheme not emulated)'}`, m.bodyY <= 2 && m.outside.length === 0 && m.clipped.length === 0 && Boolean(colors.text) && colors.text !== colors.bg && (!emulated || colors.dark === (scheme === 'dark')), JSON.stringify([colors, m]));
      }
    }
    await inTab("document.body.classList.remove('on-media')");
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the temp profile may linger */ }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
