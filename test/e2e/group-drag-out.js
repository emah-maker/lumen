// Dragging a tab out of its group along the strip (renderer/app.js): pulled left past the group's label, or right past
// its last tab, the tab lands outside the group; dropped between two of the group's tabs it stays in. Real mouse
// input in a hidden window (LUMEN_TEST_BACKGROUND), in the top strip (app.js) and in Tab layout: Side (side-tabs.js), up and down.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>P${req.url.slice(1)}</title>`); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-group-drag-out-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900));
  await ui.evaluate(() => window.assistant.setAutoGroup(false));

  const open = (url) => app.evaluate(async (_e, url) => {
    const t = global.__agent.browser.openTab(url, { background: true });
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, url);
  const list = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => ({ id: t.id, group: t.group })));
  const show = async () => (await list()).map((t) => `${t.id}${t.group ? `[${t.group}]` : ''}`).join(' ');
  const groupOf = async (id) => (await list()).find((t) => t.id === id)?.group || null;
  const rect = (sel) => ui.evaluate((sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && { left: r.left, right: r.right, width: r.width, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
  const tabRect = (id) => rect(`#tabs .tab[data-id="${id}"]`);

  // A drag along the strip: press at the tab's middle, move in steps to x, release.
  const drag = async (id, toX) => {
    const r = await tabRect(id);
    await ui.mouse.move(r.x, r.y);
    await ui.mouse.down();
    const steps = 16;
    for (let i = 1; i <= steps; i++) { await ui.mouse.move(r.x + ((toX - r.x) * i) / steps, r.y); await sleep(16); }
    await sleep(150);
    await ui.mouse.up();
    await sleep(800);
  };

  const start = (await list()).map((t) => t.id);
  const pages = [];
  for (let i = 0; i < 6; i++) pages.push(await open(`${base}/${i}`));
  for (const id of start) await app.evaluate((_e, id) => global.__agent.browser.closeTab(id), id).catch(() => {});
  await sleep(400);
  const [, g1, g2, g3] = pages;
  const regroup = async (ids) => {
    await app.evaluate((_e, ids) => { for (const g of [...global.__tabGroups.groups.keys()]) global.__tabGroups.ungroup?.(g); }, null).catch(() => {});
    await app.evaluate((_e, ids) => global.__agent.execute('ungroup_tabs', { tab_ids: ids }), pages).catch(() => {});
    await app.evaluate((_e, ids) => global.__agent.execute('group_tabs', { name: 'Grp', tab_ids: ids }), ids);
    await sleep(600);
  };
  await regroup([g1, g2, g3]);
  console.log('start  ', await show());

  // 1. the middle tab pulled left past the group's label
  let label = await rect('#tabs .group-label');
  await drag(g2, label.left - 8);
  console.log('after 1', await show());
  check('a group tab dragged left past the label leaves the group', (await groupOf(g2)) === null, await show());

  // 2. the last tab pulled right past the group's end, onto the next loose tab's left half
  await regroup([g1, g2, g3]);
  console.log('start 2', await show());
  const now = await list();
  const lastIn = now.map((t) => t.group).lastIndexOf('Grp');
  const lastTab = now[lastIn].id;
  const next = now[lastIn + 1].id; // the loose tab after the group
  const rn = await tabRect(next);
  await drag(lastTab, rn.left + rn.width * 0.6);
  console.log('after 2', await show());
  check('a group\'s last tab dragged right onto the next tab leaves the group', (await groupOf(lastTab)) === null, await show());
  // the same, released just past the group's end (over the gap before the next tab)
  await regroup([g1, g2, g3]);
  const now2 = await list();
  const lastIn2 = now2.map((t) => t.group).lastIndexOf('Grp');
  const lastTab2 = now2[lastIn2].id;
  const rl = await tabRect(lastTab2);
  await drag(lastTab2, rl.right + rl.width * 0.55);
  console.log('after 2b', await show());
  check('a group\'s last tab pulled clearly past the group\'s end leaves the group', (await groupOf(lastTab2)) === null, await show());

  // 3. a group at the very end of the strip: its last tab pulled right off the end
  await regroup([pages[3], pages[4], pages[5]]);
  console.log('start 3', await show());
  const strip = await rect('#tabs');
  await drag(pages[5], strip.right - 2);
  console.log('after 3', await show());
  check('the last tab of a group at the strip\'s end, dragged off the end, leaves the group', (await groupOf(pages[5])) === null, await show());

  // 4. a group at the very start: its first tab pulled left past the label
  await regroup([pages[0], pages[1], pages[2]]);
  console.log('start 4', await show());
  label = await rect('#tabs .group-label');
  await drag(pages[1], Math.max(2, label.left - 8));
  console.log('after 4', await show());
  check('a tab of a group at the strip\'s start, dragged before the label, leaves the group', (await groupOf(pages[1])) === null, await show());

  // 5. dropped between two of its own group's tabs: it stays in
  await regroup([pages[0], pages[1], pages[2]]);
  const r2 = await tabRect(pages[2]);
  await drag(pages[0], r2.left + r2.width * 0.3);
  console.log('after 5', await show());
  check('a group tab moved within its group stays in it', (await groupOf(pages[0])) === 'Grp', await show());

  // ---- Tab layout: Side (side-tabs.js): the same, up and down
  await app.evaluate((_e) => global.__settings.backend.set('tabLayout', 'side'));
  await ui.waitForFunction(() => document.body.classList.contains('side-layout'));
  await sleep(500);
  const dragY = async (id, toY) => {
    const r = await ui.evaluate((id) => { const b = document.querySelector(`#tabs .tab[data-id="${id}"]`).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, id);
    await ui.mouse.move(r.x, r.y);
    await ui.mouse.down();
    for (let i = 1; i <= 12; i++) { await ui.mouse.move(r.x, r.y + ((toY - r.y) * i) / 12); await sleep(16); }
    await sleep(150);
    await ui.mouse.up();
    await sleep(800);
  };
  const rowOf = (id) => ui.evaluate((id) => { const b = document.querySelector(`#tabs .tab[data-id="${id}"]`).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height }; }, id);
  const members = async () => (await list()).filter((t) => t.group === 'Grp').map((t) => t.id);

  // 6. the first tab of a group dragged above its label
  await regroup([g1, g2, g3]);
  console.log('side 6 ', await show());
  let first = (await members())[0];
  const lb = await ui.evaluate(() => document.querySelector('#tabs .group-label').getBoundingClientRect().top);
  await dragY(first, lb + 3);
  console.log('after 6', await show());
  check('Side: a group\'s first tab dragged above its label leaves the group', (await groupOf(first)) === null, await show());

  // 7. the last tab of a group in the middle pulled just below its own row
  await regroup([g1, g2, g3]);
  let last = (await members()).pop();
  let row = await rowOf(last);
  await dragY(last, row.bottom + row.h * 0.4);
  console.log('after 7', await show());
  check('Side: a group\'s last tab pulled below its row leaves the group', (await groupOf(last)) === null, await show());

  // 8. ... but nudged a little and let go on its own row, it stays in
  await regroup([g1, g2, g3]);
  last = (await members()).pop();
  row = await rowOf(last);
  await dragY(last, row.top + row.h * 0.8);
  check('Side: a group\'s last tab nudged within its own row stays in the group', (await groupOf(last)) === 'Grp', await show());

  // 9. a group at the end of the list: its last tab pulled below it
  const order9 = (await list()).map((t) => t.id);
  await regroup(order9.slice(-3));
  last = (await members()).pop();
  console.log('side 9 ', await show());
  row = await rowOf(last);
  await dragY(last, row.bottom + row.h * 0.6);
  console.log('after 9', await show());
  check('Side: the last tab of a group at the end of the list, pulled below it, leaves the group', (await groupOf(last)) === null, await show());

  check('no page errors', !errors.length, errors.join(' | '));
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
