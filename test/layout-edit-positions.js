// New-tab "Edit layout": every card must sit exactly where it does with edit mode off (same cell, same pixels),
// at several window widths; chrome may overlay but never moves a card. Moving a card in edit mode and leaving
// keeps exactly the edited cell. Offline; a throwaway profile; LUMEN_TEST_BACKGROUND keeps the window off-screen.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-layoutpos-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ newTabPrivacy: false, newTabWidgetsPacked: process.env.LAYOUT_PACKED === '1' }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);
  const note = (text) => ({ type: 'notes', note: { text } });
  const ids = [];
  for (const t of ['one', 'two', 'three', 'four', 'five']) ids.push((await W('save', note(t))).widget.id);
  await W('layout', [
    { id: ids[0], x: 0, y: 0, w: 3, h: 3 },
    { id: ids[1], x: 9, y: 0, w: 3, h: 4 },
    { id: ids[2], x: 0, y: 5, w: 4, h: 3 },
    { id: ids[3], x: 8, y: 6, w: 4, h: 5 },
    { id: ids[4], x: 4, y: 9, w: 3, h: 2 },
  ]);
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__stab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, code2) => global.__stab.webContents.executeJavaScript(code2), code);
  const frame = () => page('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const wait = async (code, tries = 60) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(100); } return false; };
  await wait('document.querySelectorAll(".w-card").length >= 5');
  const setWidth = async (w) => {
    await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.fromId(global.__windows.list()[0].windowId); win.setSize(width, 800); }, w);
    // settled once two reads 250 ms apart agree (the resize and the re-layout it triggers take a few frames)
    let last = '';
    for (let i = 0; i < 30; i++) { await sleep(250); const now = JSON.stringify(await rects()) + await page('document.documentElement.clientWidth'); if (now === last) break; last = now; }
    await frame();
  };
  // Widget cards by id; the page's own sections as "sys0", "sys1"...: a docked section in the centre column with edit mode
  // off, the card it becomes (same order) with it on.
  const rects = () => page(`(() => { const o = {}; const rect = (n, cell) => { const r = n.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round((r.top + scrollY) * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10, cell]; };
    for (const c of document.querySelectorAll('.w-card')) { if (!c.getClientRects().length || /^wsys(head|search)$/.test(c.dataset.id)) continue; if (c.dataset.id.startsWith('wsys')) continue; o[c.dataset.id] = rect(c, c.dataset.cell || ''); }
    const sys = document.body.classList.contains('w-editing') ? [...document.querySelectorAll('.w-card[data-id^="wsys"]')].filter((c) => !/^wsys(head|search)$/.test(c.dataset.id)) : [...document.querySelectorAll('#sections > *')];
    sys.forEach((n, i) => { o['sys' + i] = rect(n, ''); });
    return o; })()`);
  const edit = async (on) => { await page(`window.widgetGrid.setEditing(${on})`); await sleep(500); await frame(); };
  const diff = (a, b, tol = 1) => {
    const bad = [];
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = a[id], q = b[id];
      if (!p || !q) { bad.push(`${id}: ${p ? 'gone in edit' : 'new in edit'}`); continue; }
      // A section's card is whole grid cells, so its top and height may differ from the section's natural box by under a row.
      const t = (i) => (id.startsWith('sys') && i > 0 && i !== 2 ? 72 : tol);
      if (p.slice(0, 4).some((v, i) => Math.abs(v - q[i]) > t(i)) || (!id.startsWith('sys') && p[4] !== q[4])) bad.push(`${id}: ${p.join(' ')} -> ${q.join(' ')}`);
    }
    return bad;
  };

  for (const width of [1000, 1280, 1700, 2200]) {
    await setWidth(width);
    const cols = await page('window.widgetGrid.geometry().m.cols');
    if (cols === 1) continue;
    const normal = await rects();
    await edit(true);
    const inEdit = await rects();
    check(`${width}px: every card is where it was (${Object.keys(normal).length} cards, ${cols} columns)`, diff(normal, inEdit).length === 0, diff(normal, inEdit).join('; '));
    await edit(false);
    const after = await rects();
    check(`${width}px: leaving edit mode puts every card back`, diff(normal, after).length === 0, diff(normal, after).join('; '));
  }

  // Move one card in edit mode: leaving keeps the edited cell, and it matches the edit-mode pixels.
  await setWidth(1280);
  await edit(true);
  const before = await rects();
  const target = ids[4];
  const res = await page(`(async () => { const g = window.widgetGrid; const card = document.querySelector('.w-card[data-id="${target}"]'); const r = card.getBoundingClientRect(); const pitch = g.metrics().pitchX; const fire = (t, type, x, y) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse', clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, button: 0 })); const x0 = r.left + r.width / 2, y0 = r.top + 20; fire(card, 'pointerdown', x0, y0); for (let i = 1; i <= 8; i++) { fire(document, 'pointermove', x0 + pitch * 3 * i / 8, y0 + 4 * i); await new Promise((r2) => setTimeout(r2, 16)); } fire(document, 'pointerup', x0 + pitch * 3, y0 + 32); return true; })()`);
  await sleep(900); await frame();
  const movedEdit = await rects();
  check('a card dragged in edit mode moved', movedEdit[target] && movedEdit[target][4] !== before[target][4], JSON.stringify([before[target], movedEdit[target], res]));
  await edit(false);
  const movedNormal = await rects();
  check('after leaving, every card sits exactly as it did in edit mode', diff(movedEdit, movedNormal).length === 0, diff(movedEdit, movedNormal).join('; '));

  await app.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
