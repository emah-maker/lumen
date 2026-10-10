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
