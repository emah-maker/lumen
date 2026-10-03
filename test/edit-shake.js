// New-tab "Edit layout": no card may wiggle, tilt or change shape in edit mode; each shows a dashed outline
// instead, and none moves. Checks the computed style of EVERY visible card (animation name, outline) and that
// it does not move (the computed rotate/transform stays the same over ~300 ms), in several situations:
// a fresh page, after adding / moving / resizing a card, with a stack, over repeated enter/leave
// cycles, after a drag-drop, and under the OS "reduce motion" preference (which deliberately swaps
// the shake for a dashed outline: checked to be consistent for every card, and to resume afterwards).
// Offline; a throwaway profile; LUMEN_TEST_BACKGROUND keeps the window off-screen.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-shake-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);
  const note = (text) => ({ type: 'notes', note: { text } });
  const a = await W('save', note('one'));
  const b = await W('save', note('two'));
  const c = await W('save', { type: 'countdown', cd: { label: 'Soon', at: Date.now() + 864e5 * 9 } }).catch(() => null);
  await W('layout', [{ id: a.widget.id, x: 0, y: 0, w: 3, h: 3 }, { id: b.widget.id, x: 9, y: 0, w: 3, h: 3 }, ...(c?.widget ? [{ id: c.widget.id, x: 0, y: 4, w: 3, h: 3 }] : [])]);
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__stab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, code2) => global.__stab.webContents.executeJavaScript(code2), code);
  await page(`window.__s = {
    frame() { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); },
    fire(target, type, x, y) { return target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse', clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, button: 0 })); },
    visible() { return [...document.querySelectorAll('.w-card')].filter((c) => c.getClientRects().length > 0); },
    // what every visible card is doing right now, sampled four times over ~300 ms
    async probe() {
      const cards = this.visible();
      const snap = () => cards.map((c) => getComputedStyle(c).rotate + '|' + getComputedStyle(c).transform);
      const s0 = snap(); await new Promise((r) => setTimeout(r, 90)); const s1 = snap(); await new Promise((r) => setTimeout(r, 90)); const s2 = snap(); await new Promise((r) => setTimeout(r, 120)); const s3 = snap();
      return { editing: document.body.classList.contains('w-editing'), calm: document.body.classList.contains('calm'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        cards: cards.map((c, i) => { const s = getComputedStyle(c); return { id: c.dataset.id, name: s.animationName, play: s.animationPlayState, dur: parseFloat(s.animationDuration) || 0, iter: s.animationIterationCount, outline: s.outlineStyle, moves: new Set([s0[i], s1[i], s2[i], s3[i]]).size > 1, cls: c.className }; }) };
    },
  }; 1`);
  const wait = async (code, tries = 60) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(100); } return false; };
  await wait('document.querySelectorAll(".w-card").length >= 2');
  const edit = (on) => page(`window.widgetGrid.setEditing(${on}), window.__s.frame().then(() => document.body.classList.contains('w-editing'))`);

  // Debugger-driven media emulation: the OS "reduce motion" preference.
  await app.evaluate(() => { try { global.__stab.webContents.debugger.attach('1.3'); } catch { /* Lumen's own automation already holds it */ } });
  const emulate = (reduce) => app.evaluate((_e, r) => global.__stab.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: r ? 'reduce' : 'no-preference' }] }), reduce);

  const shaking = async (label, { reduced = false } = {}) => {
    const p = await page('window.__s.probe()');
    const bad = p.cards.filter((k) => !(k.name === 'none' && k.outline === 'dashed' && !k.moves));
    check(`${label}: ${p.cards.length} card(s) show the dashed outline, no motion`, p.editing && p.cards.length > 0 && bad.length === 0, JSON.stringify({ calm: p.calm, reduced: p.reduced, bad }));
  };
  const still = async (label) => {
    const p = await page('window.__s.probe()');
    check(`${label}: no card has an outline or motion once edit mode is off`, !p.editing && p.cards.every((k) => k.name === 'none' && !k.moves), JSON.stringify(p.cards.filter((k) => k.name !== 'none' || k.moves)));
  };

  // 1. a fresh page
  check('edit mode is entered on a fresh page', await edit(true), '');
  await shaking('fresh page');
  await edit(false); await still('fresh page');

  // 2. after adding a widget (edit mode off, then on), and while edit mode is already on
  const d = await W('save', note('three'));
  await W('layout', [{ id: d.widget.id, x: 9, y: 4, w: 3, h: 3 }]);
  await wait(`Boolean(document.querySelector('.w-card[data-id="${d.widget.id}"]'))`);
  await edit(true); await shaking('after adding a widget');
  const e = await W('save', note('four'));
  await W('layout', [{ id: e.widget.id, x: 4, y: 8, w: 3, h: 3 }]);
  await wait(`Boolean(document.querySelector('.w-card[data-id="${e.widget.id}"]'))`);
  await sleep(500);
  await shaking('a widget added while edit mode is on');
  await W('save', note('five'));
  await sleep(700);
  await shaking('after the cards were re-rendered during edit mode');

  // 3. after a move and a resize through the layout, and a real pointer drag/drop in edit mode
  await W('layout', [{ id: a.widget.id, x: 0, y: 12, w: 4, h: 3 }]);
  await sleep(700); await shaking('after moving a widget (layout)');
  await W('layout', [{ id: b.widget.id, x: 8, y: 0, w: 4, h: 5 }]);
  await sleep(700); await shaking('after resizing a widget (layout)');
  const drag = await page(`(async () => {
    const card = document.querySelector('.w-card[data-id="${a.widget.id}"]'); const r = card.getBoundingClientRect();
    const s = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    window.__s.fire(card, 'pointerdown', s.x, s.y);
    for (let k = 1; k <= 8; k++) { window.__s.fire(document, 'pointermove', s.x + 40 * k / 8, s.y - 120 * k / 8); await window.__s.frame(); }
    const lifted = card.classList.contains('lifted') && getComputedStyle(card).animationName;
    window.__s.fire(document, 'pointerup', s.x + 40, s.y - 120); await window.__s.frame();
    return { lifted, after: getComputedStyle(card).animationName, cls: card.className };
  })()`);
  check('a card held up and dropped never wiggles (lifted, then dropped)', drag.lifted === 'none' && drag.after === 'none' && !/lifted|resizing/.test(drag.cls), JSON.stringify(drag));
  await sleep(600); await shaking('after a drag and drop');

  // 4. with a stack
  const list = await W('list');
  const x = list.find((i) => i.id === d.widget.id); const y = list.find((i) => i.id === e.widget.id);
  await edit(false);
  await W('layout', [{ id: y.id, x: x.x, y: x.y, w: x.w, h: x.h }]);
  await W('act', { do: 'stack', id: y.id, onto: x.id, anchor: x.id });
  await sleep(900);
  const stacked = await page('document.querySelectorAll(".w-stack, .w-stack-dots").length');
  await edit(true); await shaking(`with a stack (${stacked} stack element(s))`);
  await W('act', { do: 'cycle', id: y.id });
  await sleep(700); await shaking('after switching the stack to its other member');
  await edit(false); await still('with a stack');

  // 5. entering and leaving several times, quickly and slowly
  for (let i = 0; i < 6; i++) { await edit(true); if (i % 2) await sleep(250); await edit(false); }
  await edit(true); await shaking('after leaving and re-entering six times');
  await edit(false); await still('after repeated toggling');
  await page('window.widgetGrid.setEditing(true); window.widgetGrid.setEditing(false); window.widgetGrid.setEditing(true); 1');
  await sleep(300); await shaking('after enter / leave / enter in one task');
  await edit(false);
  await page("(() => { const b = document.querySelector('.w-edit-btn'); b.click(); b.click(); b.click(); return 1; })()");
  await sleep(300); await shaking('after three quick presses of the Edit layout button');
  await edit(false);

  // 6. the reduce-motion preference: a dashed outline instead, the same for every card, and back
  await emulate(true);
  await edit(true); await shaking('OS reduce motion on', { reduced: true });
  await emulate(false);
  await sleep(200); await shaking('OS reduce motion switched off while editing');
  await emulate(true); await sleep(200); await shaking('OS reduce motion switched back on while editing', { reduced: true });
  await emulate(false); await edit(false); await still('reduce motion cycle');
  await edit(true); await shaking('re-entered after the reduce-motion cycle');
  await edit(false);

  // 7. Lumen's own settings: Performance mode (on / off, as Auto flips it by itself) keeps the shake;
  // Reduce motion swaps it for the dashed outline on every card, and clears again.
  const setPref = (k, v) => app.evaluate((_e, [key, val]) => global.__settings.backend.set(key, val).then(() => 'ok', (err) => 'ERROR ' + err.message), [k, v]);
  const calmIs = (on) => wait(`document.body.classList.contains('calm') === ${on}`, 80);
  await edit(true);
  for (const mode of ['on', 'off', 'on', 'off']) {
    await setPref('performanceMode', mode);
    check(`Performance mode ${mode}: the page follows (calm ${mode === 'on'})`, await calmIs(mode === 'on'), await page('document.body.className'));
    await shaking(`Performance mode ${mode}, while editing`);
  }
  await setPref('performanceMode', 'on'); await calmIs(true);
  await edit(false); await edit(true); await shaking('Performance mode on, re-entered');
  await setPref('reduceMotion', true);
  check('Reduce motion: the page follows (still)', await wait("document.body.classList.contains('still')", 80), await page('document.body.className'));
  await sleep(300);
  const calm = await page('window.__s.probe()');
  check('Lumen Reduce motion: a dashed outline on every card, none shakes', calm.cards.length > 0 && calm.cards.every((k) => k.name === 'none' && k.outline === 'dashed' && !k.moves), JSON.stringify(calm.cards));
  await setPref('reduceMotion', false); await setPref('performanceMode', 'off');
  check('Reduce motion off: the page follows', await wait("!document.body.classList.contains('still')", 80), await page('document.body.className'));
  await sleep(300);
  await shaking('after Reduce motion is switched off while editing');
  await edit(false);

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
