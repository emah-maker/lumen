// New-tab cards that can't show anything yet, in a real window (off-screen, throwaway profile): a card with no key or token
// says it needs setup and offers Open Settings (not a Try again that can't help), a failed card keeps Try again and shows
// that it was pressed, a sign-in prompt carries no "Updated ..." line, and the edit tip is short and leaves the picker alone.
'use strict';
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-states-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [
    { id: 'wtodo0001', type: 'todoist', x: 0, y: 0, w: 4, h: 4 },
    { id: 'wgit00001', type: 'github', x: 4, y: 0, w: 4, h: 4 },
    { id: 'wgmail001', type: 'gmail', x: 8, y: 0, w: 4, h: 4 },
  ] }));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__homeTab = t; });
    const inTab = (js) => app.evaluate((_e, code) => global.__homeTab.webContents.executeJavaScript(code), js);
    const waitFor = async (code, tries = 120) => { for (let i = 0; i < tries; i++) { if (await inTab(code).catch(() => false)) return true; await sleep(150); } return false; };
    const card = (id) => `document.querySelector('.w-card[data-id="${id}"]')`;

    check('a card with no token says it needs setup', await waitFor(`("" + ${card('wtodo0001')}?.querySelector('.w-note strong')?.textContent).indexOf('Needs setup') >= 0`), '');
    const todo = await inTab(`(() => { const c = ${card('wtodo0001')}; return { buttons: [...c.querySelectorAll('.w-body button')].map((b) => b.textContent.trim() + (b.classList.contains('primary') ? '*' : '')), foot: c.querySelector('.w-foot')?.textContent || '' }; })()`);
    check('...with Open Settings as its one button (no Try again)', JSON.stringify(todo.buttons) === JSON.stringify(['Open Settings*']), JSON.stringify(todo));
    check('same for GitHub', await waitFor(`("" + ${card('wgit00001')}?.querySelector('.w-note strong')?.textContent).indexOf('Needs setup') >= 0`) && JSON.stringify(await inTab(`[...${card('wgit00001')}.querySelectorAll('.w-body button')].map((b) => b.textContent.trim())`)) === '["Open Settings"]', '');

    // A sign-in prompt has no "Updated ..." under it.
    check('Gmail signed out shows its sign-in button', await waitFor(`Boolean(${card('wgmail001')}?.querySelector('.w-btn.primary'))`), '');
    await sleep(300);
    check('...and no “Updated” line under it', !/Updated/.test(await inTab(`${card('wgmail001')}.querySelector('.w-foot')?.textContent || ''`)), '');

    // Try again shows that it was pressed, then comes back.
    const shown = await inTab(`(() => { const w = { id: 'wxxxx0001', type: 'feed', title: 'Test', error: 'Couldn’t connect. Check your internet connection.', data: null }; const el = buildCard(w); document.body.append(el); const b = [...el.querySelectorAll('button')].find((x) => x.textContent === 'Try again'); if (!b) return 'no button'; b.click(); const out = [b.disabled, b.textContent]; el.remove(); return out; })()`).catch((e) => String(e));
    check('Try again goes to “Trying…” and disabled while it waits', Array.isArray(shown) && shown[0] === true && shown[1] === 'Trying…', JSON.stringify(shown));

    // Gmail's button is named once ("Sign in to Gmail"), not "... for Gmail".
    const gmailLabel = await inTab(`${card('wgmail001')}.querySelector('.w-btn.primary')?.getAttribute('aria-label')`);
    check('Gmail sign-in button is labelled "Sign in to Gmail" (no "for Gmail")', gmailLabel === 'Sign in to Gmail', gmailLabel);

    // A message that starts "Couldn't ..." is its own heading; other errors keep "Couldn't update" above them.
    const heads = await inTab(`(() => { const out = []; for (const error of ['Couldn’t connect. Check your internet connection.', 'The feed answered 500.']) { const el = buildCard({ id: 'wxxxx0002', type: 'feed', title: 'Test', error, data: null }); out.push(el.querySelector('.w-note').textContent); } return out; })()`);
    check('"Couldn’t connect" is not preceded by "Couldn’t update"', heads[0] === 'Couldn’t connect. Check your internet connection.', JSON.stringify(heads));
    check('...but another failure still says "Couldn’t update"', heads[1] === 'Couldn’t updateThe feed answered 500.', JSON.stringify(heads));

    // The greeting: night until 5 am.
    const greets = await inTab(`[0, 4, 5, 11, 12, 17, 18, 23].map((h) => greeting(new Date(2026, 0, 5, h, 30)))`);
    check('greeting: Good night until 5 am, then morning, afternoon, evening', greets.join() === 'Good night,Good night,Good morning,Good morning,Good afternoon,Good afternoon,Good evening,Good evening', greets.join());

    // Favorites: the page says where they come from.
    const fav = await inTab(`(() => { const s = document.querySelector('section[aria-label="Favorites"]'); const one = [{ url: 'https://example.com/', title: 'Example' }]; return { title: s ? s.querySelector('h2').title : '', empty: favorites([]).textContent, short: favorites(one).textContent, full: favorites(Array.from({ length: 6 }, (_, i) => ({ url: 'https://example.com/' + i, title: 'E' + i }))).textContent }; })()`);
    check('Favorites says where it comes from: the heading tooltip, and a line on an empty or short list (not a full one)', /bookmarks/i.test(fav.title) && /Favorites are your bookmarks.*D on any page/.test(fav.empty) && /Favorites are your bookmarks/.test(fav.short) && !/bookmarks/.test(fav.full), JSON.stringify(fav));

    // Ask AI: with nothing connected it is a setup prompt, otherwise it names the connected assistant.
    await inTab(`document.getElementById('mode-ask').click(); 1`);
    const ask = await inTab(`(() => { let a = null; try { a = JSON.parse(decodeURIComponent(location.hash.slice(1))).assistant; } catch {} return { a, ph: document.getElementById('q').placeholder, connect: !document.getElementById('mode-connect').hidden }; })()`);
    check('Ask AI: a setup prompt when no AI is connected, else the assistant\'s own name', ask.a && ask.a.agentUsable === false ? ask.ph === 'Connect an AI to ask questions' && ask.connect : ask.ph === `Ask ${ask.a?.name || 'AI'}…` && !ask.connect, JSON.stringify(ask));
    await inTab(`document.getElementById('mode-search').click(); 1`);

    // Add widget outside Edit layout: visible, grouped, a filter, and a visible note before Settings opens.
    const outside = await inTab(`(() => { const b = document.querySelector('.w-tb-add'); return { shown: !b.hidden && getComputedStyle(b).display !== 'none', editing: document.body.classList.contains('w-editing') }; })()`);
    check('Add widget is there without Edit layout', outside.shown && !outside.editing, JSON.stringify(outside));
    await inTab(`document.querySelector('.w-tb-add').click(); 1`);
    await sleep(250);
    const pick = await inTab(`(() => { const p = document.querySelector('.w-picker'); return { heads: [...p.querySelectorAll('h3')].map((h) => h.textContent), filter: Boolean(p.querySelector('input[type=search]')), focus: document.activeElement === p.querySelector('input'), rows: p.querySelectorAll('.w-pick').length }; })()`);
    check('Add list is grouped, has a filter and starts in it', pick.heads.includes('Time and weather') && pick.heads.includes('Work and mail') && pick.heads.includes('Music') && pick.filter && pick.focus, JSON.stringify(pick));
    await inTab(`(() => { const i = document.querySelector('.w-picker input'); i.value = 'todo'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    const filtered = await inTab(`(() => { const p = document.querySelector('.w-picker'); return { rows: [...p.querySelectorAll('.w-pick:not([hidden])')].map((b) => b.querySelector('b').textContent), heads: [...p.querySelectorAll('h3:not([hidden])')].map((h) => h.textContent) }; })()`);
    check('typing narrows the list to Todoist and its heading only', filtered.rows.join() === 'Todoist' && filtered.heads.join() === 'Work and mail', JSON.stringify(filtered));
    await inTab(`[...document.querySelectorAll('.w-picker .w-pick')].find((b) => /Todoist/.test(b.textContent)).click(); 1`);
    await sleep(250);
    const note = await inTab(`document.querySelector('.w-toast')?.textContent || ''`);
    check('choosing Todoist says on the page that Settings opens, and what to paste and where from', /Todoist/.test(note) && /Settings/.test(note) && /API token/.test(note) && /Developer/.test(note), note);

    // Targets: icon buttons and handles are at least 24 px.
    const sizes = await inTab(`['.w-icon-btn', '.w-grip', '.w-resize', '.w-gear', '.w-remove'].map((sel) => { const b = document.querySelector(sel); if (!b) return [sel, 'none']; const c = getComputedStyle(b); return [sel, parseFloat(c.width), parseFloat(c.height)]; })`);
    check('card icon buttons and resize handles are at least 24 px', sizes.filter((s) => s[1] !== 'none').every((s) => s[1] >= 24 && s[2] >= 24) && sizes.some((s) => s[0] === '.w-resize' && s[1] !== 'none'), JSON.stringify(sizes));

    // The edit tip: short, and gone while the picker is open.
    await inTab(`document.querySelector('.w-edit-btn').click(); 1`);
    await sleep(300);
    const tip = await inTab(`(() => { const h = document.querySelector('.w-dock-hint'); return { text: h.textContent, shown: getComputedStyle(h).display !== 'none' }; })()`);
    check('the edit tip is one short line', tip.shown && tip.text.length < 110, JSON.stringify(tip));
    await inTab(`document.querySelector('.w-tb-add').click(); 1`);
    await sleep(300);
    check('the tip steps aside while the picker is open', await inTab(`getComputedStyle(document.querySelector('.w-dock-hint')).display === 'none'`), '');
    await inTab(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.w-picker')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
    await sleep(300);
    check('...and comes back when it closes', await inTab(`!document.querySelector('.w-picker') && getComputedStyle(document.querySelector('.w-dock-hint')).display !== 'none'`), '');
    const x = await inTab(`(() => { const b = document.createElement('button'); b.className = 'w-x'; document.body.append(b); const r = b.getBoundingClientRect(); b.remove(); return [r.width, r.height]; })()`);
    check('the tip’s dismiss × is at least 24px', x[0] >= 24 && x[1] >= 24, JSON.stringify(x));
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
