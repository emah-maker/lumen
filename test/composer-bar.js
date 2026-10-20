// The composer's toolbar (renderer/composer-bar.js), in the sidebar and on lumen://chat: the text box on its own roomy row, then one
// toolbar row: a "+" menu (screenshot of this tab, attach files, plan first), the model picker with its whole short name, the mic, and
// Send with a chevron menu that holds "Run in the background". Above the box one quiet status line carries the usage meter and the
// compact Bypass badge, and takes no space when both are hidden. Hidden window, no network; a stand-in key keeps the picker on the API.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// Runs in the page: a long chat scrolled to the bottom, with the composer as is and with six lines typed. The last message must end above the
// composer's top edge (the list reserves the composer's live height), and the composer must be opaque (nothing shows through it).
const LONG_CHAT = `(async () => {
  const messages = document.getElementById('messages'); const prompt = document.getElementById('prompt'); const composer = document.getElementById('composer');
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // (the chat was drawn by the app itself: real messages sent through the composer, answered by a stand-in client)
  const lastMsg = () => [...messages.querySelectorAll(':scope > .msg')].pop();
  const out0 = { greeting: !document.getElementById('empty').hidden, count: messages.querySelectorAll(':scope > .msg').length };
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const alpha = (css) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = css; cv.fillRect(0, 0, 1, 1); return cv.getImageData(0, 0, 1, 1).data[3]; };
  const gap = async () => { messages.scrollTop = messages.scrollHeight; await frames(); await frames(); return !lastMsg() ? null : Math.round((composer.getBoundingClientRect().top - lastMsg().getBoundingClientRect().bottom) * 10) / 10; };
  const out = { ...out0, alpha: alpha(getComputedStyle(composer).backgroundColor), blur: getComputedStyle(composer).backdropFilter };
  out.gapIdle = await gap();
  prompt.value = 'a\\nb\\nc\\nd\\ne\\nf'; prompt.dispatchEvent(new Event('input', { bubbles: true })); await frames();
  out.gapTyped = await gap();
  prompt.value = ''; prompt.dispatchEvent(new Event('input', { bubbles: true })); await frames();
  return out;
})()`;

// Runs in the page: where everything sits.
const LAYOUT = `(() => {
  const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, hidden: el.hidden || r.width === 0 }; };
  const text = document.querySelector('#composer-bar .picker-text');
  const composer = box('#composer');
  const bar = box('#composer-bar');
  const prompt = box('#prompt');
  const items = ['#composer-plus', '#composer-bar .model-picker', '#mic-btn', '#send'].map(box).filter(Boolean);
  let overlap = false;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (items[i].l < items[j].r - 0.5 && items[j].l < items[i].r - 0.5) overlap = true;
  const status = box('#composer-status');
  return {
    composer, bar, prompt, status, overlap, text: text ? text.textContent : null, cut: text ? text.scrollWidth > text.clientWidth + 1 : null,
    inside: items.every((x) => x.l >= composer.l - 0.5 && x.r <= composer.r + 0.5), promptAboveBar: prompt.b <= bar.t + 0.5, promptFull: prompt.w >= composer.w - 40,
    headModel: Boolean(document.querySelector('.sidebar-head .model-picker')),
  };
})()`;

// A stand-in Claude client (no network): every reply is a long paragraph, so a few exchanges fill more than a screen.
const fakeClient = (app) => app.evaluate(() => {
  const fake = global.__fakeLong = { n: 0 };
  global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
    const text = 'Reply ' + (++fake.n) + '. ' + 'This is a long answer that keeps going so the chat is taller than the window. '.repeat(8);
    const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 200 } };
    return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; }, finalMessage: async () => message };
  } } } });
});
const SEND_LONG = `(async () => {
  const messages = document.getElementById('messages'); const prompt = document.getElementById('prompt'); const send = document.getElementById('send');
  for (let i = 0; i < 5; i++) {
    const before = messages.querySelectorAll(':scope > .msg.assistant').length;
    prompt.value = 'Question ' + i; prompt.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer').requestSubmit();
    for (let t = 0; t < 100 && (messages.querySelectorAll(':scope > .msg.assistant').length <= before || send.classList.contains('stop')); t++) await new Promise((r) => setTimeout(r, 100));
  }
  return messages.querySelectorAll(':scope > .msg').length;
})()`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-composer-bar-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });
    await ui.waitForSelector('#prompt', { state: 'visible' });
    await sleep(600);

    // ---- layout at the default and the minimum sidebar width
    for (const [name, width] of [['default', 360], ['minimum', 300]]) {
      await ui.evaluate((w) => document.documentElement.style.setProperty('--sidebar-width', `${w}px`), width);
      await sleep(300);
      const l = await ui.evaluate(LAYOUT);
      check(`${name} width: the text box has its own full-width row above the toolbar`, l.promptAboveBar && l.promptFull, JSON.stringify(l));
      check(`${name} width: the box is roomy when empty (about 2-3 lines)`, l.prompt.h >= 56 && l.prompt.h <= 72, l.prompt.h);
      check(`${name} width: the toolbar's controls sit inside the composer and do not overlap`, l.inside && !l.overlap, JSON.stringify(l));
      check(`${name} width: the model name is shown whole, never cut`, Boolean(l.text) && l.text.trim().length > 2 && l.cut === false, JSON.stringify([l.text, l.cut]));
      check(`${name} width: the model picker left the header`, l.headModel === false, '');
      check(`${name} width: with Bypass and usage hidden the status line takes no space`, l.status.hidden && l.status.h === 0, JSON.stringify(l.status));
    }

    // ---- the status line: usage on the left, the compact Bypass badge on the right
    await ui.evaluate(() => {
      document.getElementById('bypass-badge').hidden = false;
      const m = document.getElementById('usage-meter');
      m.hidden = false; document.getElementById('meter-strip').hidden = false;
      m.innerHTML = '<span class="um-text">Plan 5% · resets Oct 19, 1:50pm</span><span class="um-bar"><i style="width:5%"></i></span>';
    });
    for (const [name, width] of [['default', 360], ['minimum', 300]]) {
      await ui.evaluate((w) => document.documentElement.style.setProperty('--sidebar-width', `${w}px`), width);
      await sleep(300);
      const s = await ui.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const status = r('#composer-status'); const meter = r('#usage-meter'); const badge = r('#bypass-badge'); const prompt = r('#prompt');
        const b = document.getElementById('bypass-badge');
        return { oneLine: status.height < 30, badgeRight: badge.left >= meter.left, within: badge.right <= status.right + 0.5, above: status.bottom <= prompt.top + 0.5, text: b.querySelector('.bb-text').textContent, full: b.textContent, title: b.title };
      });
      check(`${name} width: usage and the Bypass badge share one status line above the box`, s.oneLine && s.badgeRight && s.within && s.above, JSON.stringify(s));
      check(`${name} width: the badge reads "Bypass", says the whole thing to a screen reader, and keeps its tooltip`, s.text === 'Bypass' && /Bypass permissions on/.test(s.full) && s.title.length > 20, JSON.stringify(s)); // (the tooltip's words are checked on the real mode change in test/working-on-chip.js)
    }

    // ---- a long chat: the last answer is never under the box, and the box is opaque
    await fakeClient(app);
    const sent = await ui.evaluate(SEND_LONG);
    const lc = await ui.evaluate(LONG_CHAT);
    check('long chat (sidebar): the composer is opaque, with no blur behind it', lc.alpha === 255 && (lc.blur === 'none' || lc.blur === '') && lc.greeting === false && lc.count >= 10 && sent >= 10, JSON.stringify(lc));
    check('long chat (sidebar): scrolled to the bottom, the last message ends above the composer, also while six lines are typed', lc.gapIdle !== null && lc.gapIdle >= 0 && lc.gapTyped >= 0, JSON.stringify(lc));

    // ---- alignment: one centre line for + / picker / mic / send / chevron, the chevron's icon centred, the picker's caret right after its name
    for (const [name, width] of [['default', 360], ['minimum', 300]]) {
      await ui.evaluate((w) => document.documentElement.style.setProperty('--sidebar-width', `${w}px`), width);
      await sleep(250);
      const a = await ui.evaluate(() => {
        const c = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, r: r.right }; };
        const more = document.getElementById('send-more');
        const mic = document.getElementById('mic-btn');
        const text = document.querySelector('#composer-bar .picker-text'); const caret = document.querySelector('#composer-bar .model-picker svg');
        const ys = ['composer-plus', 'send', 'send-more'].map((id) => c(document.getElementById(id)).y).concat(mic ? [c(mic).y] : [], [c(document.querySelector('#composer-bar .picker-button')).y]);
        return { spread: Math.max(...ys) - Math.min(...ys), dx: Math.abs(c(more.querySelector('svg')).x - c(more).x), dy: Math.abs(c(more.querySelector('svg')).y - c(more).y), caretGap: c(caret).l - c(text).r };
      });
      check(`${name} width: +, model, mic, send and the chevron share one centre line; the chevron's icon is centred; the caret follows the name`, a.spread <= 1 && a.dx <= 0.5 && a.dy <= 0.5 && a.caretGap >= 0 && a.caretGap <= 10, JSON.stringify(a));
    }

    // ---- the + menu: opens, arrow keys, Escape, and the rows keep working
    await ui.click('#composer-plus');
    let m = await ui.evaluate(() => ({ open: !document.getElementById('composer-menu').hidden, expanded: document.getElementById('composer-plus').getAttribute('aria-expanded'), rows: [...document.querySelectorAll('#composer-menu [role^="menuitem"]')].filter((e) => !e.hidden).map((e) => e.id) }));
    check('+ opens a menu with Screenshot, Attach files and Plan', m.open && m.expanded === 'true' && m.rows.join() === 'screen-btn,attach,plan-chip', JSON.stringify(m));
    await ui.keyboard.press('Escape');
    m = await ui.evaluate(() => ({ open: !document.getElementById('composer-menu').hidden, focus: document.activeElement.id }));
    check('Escape closes it and returns focus to +', !m.open && m.focus === 'composer-plus', JSON.stringify(m));
    await ui.keyboard.press('ArrowDown');
    m = await ui.evaluate(() => ({ open: !document.getElementById('composer-menu').hidden, focus: document.activeElement.id }));
    check('ArrowDown on + opens it on the first row', m.open && m.focus === 'screen-btn', JSON.stringify(m));
    await ui.keyboard.press('ArrowDown');
    await ui.keyboard.press('ArrowDown');
    m = await ui.evaluate(() => document.activeElement.id);
    check('arrow keys move through the rows', m === 'plan-chip', m);
    await ui.keyboard.press('ArrowDown');
    m = await ui.evaluate(() => document.activeElement.id);
    check('and wrap around', m === 'screen-btn', m);

    // Screenshot row: state on the + button
    await ui.keyboard.press('Enter');
    m = await ui.evaluate(() => ({ state: document.getElementById('screen-btn').dataset.state, dot: !document.getElementById('plus-dot').hidden, checked: document.getElementById('screen-btn').getAttribute('aria-checked'), open: !document.getElementById('composer-menu').hidden }));
    check('choosing Screenshot turns it on: a dot shows on +, and the menu closes', m.state === 'on' && m.dot && m.checked === 'true' && !m.open, JSON.stringify(m));
    await ui.click('#composer-plus');
    await ui.click('#screen-btn');
    m = await ui.evaluate(() => ({ state: document.getElementById('screen-btn').dataset.state, dot: !document.getElementById('plus-dot').hidden }));
    check('choosing it again turns it off and the dot goes', m.state === 'off' && !m.dot, JSON.stringify(m));

    // Plan row: a Plan tag beside +
    await ui.click('#composer-plus');
    await ui.click('#plan-chip');
    m = await ui.evaluate(() => ({ pressed: document.getElementById('plan-chip').getAttribute('aria-pressed'), tag: !document.getElementById('plan-tag').hidden, text: document.getElementById('plan-tag').textContent.trim(), right: document.getElementById('plan-tag').getBoundingClientRect().left >= document.getElementById('composer-plus').getBoundingClientRect().right }));
    check('turning Plan on shows a "Plan" tag next to +', m.pressed === 'true' && m.tag && m.text === 'Plan' && m.right, JSON.stringify(m));
    await ui.evaluate(() => { document.documentElement.style.setProperty('--sidebar-width', '300px'); });
    await sleep(200);
    const narrow = await ui.evaluate(LAYOUT);
    check('with the Plan tag on at the minimum width the model name is still whole', narrow.cut === false && !narrow.overlap && narrow.inside, JSON.stringify(narrow));
    await ui.click('#plan-tag');
    m = await ui.evaluate(() => ({ pressed: document.getElementById('plan-chip').getAttribute('aria-pressed'), tag: !document.getElementById('plan-tag').hidden }));
    check('clicking the tag turns Plan off', m.pressed === 'false' && !m.tag, JSON.stringify(m));

    // Attach row: the file input is reached
    await ui.click('#composer-plus');
    const chooser = ui.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
    await ui.click('#attach');
    check('Attach files opens the file picker', Boolean(await chooser), 'no chooser');

    // ---- the model menu opens from the toolbar, inside the window and right above the button (not offset by the composer's glass)
    await ui.click('#composer-bar .picker-button');
    await sleep(400);
    const pm = await ui.evaluate(() => {
      const menu = document.querySelector('#composer-bar .picker-menu'); const btn = document.querySelector('#composer-bar .picker-button');
      const r = menu.getBoundingClientRect(); const b = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 30));
      return { open: !menu.hidden, inside: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5, nearButton: r.bottom <= b.top + 1 && b.top - r.bottom < 24, onTop: Boolean(hit && menu.contains(hit)), r: [r.left, r.top, r.right, r.bottom], b: [b.left, b.top] };
    });
    check('the model menu opens above the toolbar button, inside the window, and on top', pm.open && pm.inside && pm.nearButton && pm.onTop, JSON.stringify(pm));
    await ui.keyboard.press('Escape');
    await sleep(200);

    // ---- Send's chevron: keyboard reachable, Run in the background
    await ui.fill('#prompt', 'a background job');
    await ui.focus('#send-more');
    await ui.keyboard.press('Enter');
    m = await ui.evaluate(() => ({ open: !document.getElementById('send-menu').hidden, focus: document.activeElement.id, disabled: document.getElementById('send-bg').disabled }));
    check('Enter on the chevron opens the menu on "Run in the background"', m.open && m.focus === 'send-bg' && !m.disabled, JSON.stringify(m));
    await ui.keyboard.press('Escape');
    m = await ui.evaluate(() => ({ open: !document.getElementById('send-menu').hidden, focus: document.activeElement.id }));
    check('Escape closes it and returns focus to the chevron', !m.open && m.focus === 'send-more', JSON.stringify(m));
    await ui.evaluate(() => document.getElementById('send').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    check('right-clicking Send opens the same menu', await ui.evaluate(() => !document.getElementById('send-menu').hidden), '');
    await ui.keyboard.press('Escape');
    await ui.fill('#prompt', '');

    // ---- mic and send on the right, the roomy box shrinks back
    const order = await ui.evaluate(() => { const mic = document.getElementById('mic-btn'); const send = document.getElementById('send'); return mic && mic.getBoundingClientRect().right <= send.getBoundingClientRect().left + 0.5 && Boolean(mic.closest('.cb-end')); });
    check('the mic sits right before Send on the right of the toolbar', order === true, order);
    await ui.fill('#prompt', 'one\ntwo\nthree\nfour\nfive\nsix');
    await sleep(200);
    const tall = await ui.evaluate(() => document.getElementById('prompt').getBoundingClientRect().height);
    await ui.fill('#prompt', '');
    await sleep(200);
    const back = await ui.evaluate(() => document.getElementById('prompt').getBoundingClientRect().height);
    check('six lines make the box taller, and it shrinks back after sending/clearing', tall > 100 && back >= 56 && back <= 72, JSON.stringify([tall, back]));

    // ---- the full-page chat
    await app.evaluate(() => global.__chatPage.open());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete');
    await sleep(800);
    const page = await inPage(LAYOUT);
    check('chat page: the box has its own roomy row, the toolbar sits under it and nothing overlaps or is cut', Boolean(page) && page.promptAboveBar && page.promptFull && page.prompt.h >= 56 && page.inside && !page.overlap && page.cut === false, JSON.stringify(page));
    const sentPage = await inPage(SEND_LONG);
    const lcPage = await inPage(LONG_CHAT);
    check('long chat (chat page): opaque composer, and the last message ends above it (idle and with six lines typed)', Boolean(lcPage) && lcPage.alpha === 255 && lcPage.greeting === false && lcPage.count >= 10 && sentPage >= 10 && lcPage.gapIdle >= 0 && lcPage.gapTyped >= 0, JSON.stringify(lcPage));
    const rows = await inPage(`[...document.querySelectorAll('#composer-menu [role^="menuitem"]')].map((e) => e.id).join() + '|' + Boolean(document.getElementById('send-more'))`);
    check('chat page: the + menu has Attach files and Plan (no screenshot row there), and no background chevron ("Add this tab to the project" is there too, but only shown inside a project)', rows === 'attach,plan-chip|false', rows);
    await inPage(`document.getElementById('composer-plus').click()`);
    const open = await inPage(`!document.getElementById('composer-menu').hidden`);
    check('chat page: + opens its menu', open === true, open);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall composer-bar checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
