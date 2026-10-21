// The rows of a card's step list (renderer/step-ui.js, step-ui.css): the small icon that says where a step was done (globe, monitor, page) has its own
// fixed slot between the status dot and the text, so it never lies on the text; the text starts at the same place on every row (rows with no icon keep
// the slot); long text is cut with an ellipsis; the time is at the right; nothing is rotated or stacked. Checked at the sidebar's default and minimum
// width, light and dark. Also: a tool with no line of its own is named in plain words, never "Using a tool". Hidden window (LUMEN_TEST_BACKGROUND=1),
// a throwaway profile, no network. Run under the lock:
//   node scripts/test/e2e-lock.js run --owner steps-badges -- timeout 400 node test/e2e/step-rows.js
// Screenshots go to $STEP_ROWS_SHOTS when it is set.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const shots = process.env.STEP_ROWS_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(__dirname, '..', '..', 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-step-rows-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(500);

  await ui.evaluate('loadStepUI()'); // (the step cards' code loads on first use)
  await ui.waitForFunction(() => window.stepUI && window.stepLabels);

  // The steps of the screenshot that asked for this: a mix of surfaces and tools with no line of their own, short and very long.
  await ui.evaluate(() => {
    const messages = document.getElementById('messages');
    const turn = {};
    const opts = { messages, append: (n) => messages.append(n), task: 'Find the original cheatsheet', runId: 1 };
    const steps = [
      ['Bash', { command: 'pdftoppm -png "C:/Users/me/Midterm_1_Review_Sheet_DiffEq (10).pdf" out', description: 'Render the review sheet pages to pictures for reading later' }],
      ['Read', { file_path: 'C:\\Users\\me\\Midterm_1_Review_Sheet_DiffEq (10).pdf' }],
      ['mcp__lumen__list_files', { folder: 'downloads' }],
      ['navigate', { url: 'https://example.com/a/very/long/address/that/goes/on/and/on/and/on/forever.html' }],
      ['ToolSearch', { query: 'select:SomeTool' }],
      ['SomethingElse', {}],
      ['Write', { file_path: 'C:\\Users\\me\\notes\\a-quite-long-file-name-for-the-notes-about-the-cheatsheet-source.md' }],
    ];
    for (const [name, input] of steps) window.stepUI.add(turn, { name, input, label: window.stepLabels.defaults.label(name, input) || window.stepLabels.defaults.generic(name, input) }, opts);
    const card = messages.querySelector('.act-card');
    card.querySelector('.act-steps').open = true;
    for (const t of messages.querySelectorAll('.step')) t.classList.add('done');
  });
  await sleep(300);

  const measure = () => ui.evaluate(() => {
    const rows = [...document.querySelectorAll('#messages .act-list .step')].filter((r) => r.tagName !== 'SUMMARY' && r.querySelector(':scope > .step-detail'));
    return rows.map((r) => {
      const rr = r.getBoundingClientRect();
      const d = r.querySelector(':scope > .step-detail');
      const dr = d.getBoundingClientRect();
      const after = getComputedStyle(r, '::after');
      const before = getComputedStyle(r, '::before');
      const time = r.querySelector(':scope > .step-time');
      return { text: d.textContent, surf: r.dataset.surf || '', title: r.title, rowLeft: rr.left, rowRight: rr.right, left: Math.round(dr.left * 10) / 10, right: dr.right, h: dr.height, rowH: rr.height, cut: d.scrollWidth > d.clientWidth + 1, iconW: parseFloat(after.width), iconH: parseFloat(after.height), iconVis: after.visibility, iconMask: after.webkitMaskImage || after.maskImage, dotW: parseFloat(before.width), order: after.order, wm: after.writingMode, tr: after.transform, trD: getComputedStyle(d).transform, timeLeft: time && time.offsetParent ? time.getBoundingClientRect().left : null };
    });
  });
  const verify = async (tag) => {
    const rows = await measure();
    check(`${tag}: all the rows are there`, rows.length === 7, rows.length);
    const lefts = new Set(rows.map((r) => r.left));
    check(`${tag}: the text starts at the same place on every row (with or without an icon)`, lefts.size === 1, [...lefts].join(','));
    check(`${tag}: every row is one line high (nothing stacked or wrapped)`, rows.every((r) => r.rowH < 26 && r.h < 22), JSON.stringify(rows.map((r) => [r.rowH, r.h])));
    check(`${tag}: nothing is rotated`, rows.every((r) => r.tr === 'none' && r.trD === 'none' && r.wm === 'horizontal-tb'), JSON.stringify(rows.map((r) => [r.tr, r.wm])));
    check(`${tag}: the icon's box (13px) lies before the text and inside the row, never on the text`, rows.every((r) => r.iconW === 13 && r.iconH === 13 && r.left >= r.rowLeft + r.dotW + 8 + 13 + 8 - 1), JSON.stringify(rows.map((r) => [r.left - r.rowLeft, r.iconW])));
    check(`${tag}: rows done on a surface show the icon, the others keep an empty slot`, rows.filter((r) => r.surf).every((r) => r.iconVis === 'visible' && /svg/.test(r.iconMask)) && rows.filter((r) => !r.surf).every((r) => r.iconVis === 'hidden'), JSON.stringify(rows.map((r) => [r.surf, r.iconVis])));
    check(`${tag}: the word is the row's tooltip`, rows.filter((r) => r.surf).every((r) => /\((Browser|Computer|Files)\)$/.test(r.title)), JSON.stringify(rows.map((r) => r.title)));
    check(`${tag}: a long step is cut with an ellipsis, inside the row`, rows.some((r) => r.cut) && rows.every((r) => r.right <= r.rowRight + 0.5), JSON.stringify(rows.map((r) => [r.cut, r.right, r.rowRight])));
    check(`${tag}: no step is the bare "Using a tool"`, rows.every((r) => r.text !== 'Using a tool'), JSON.stringify(rows.map((r) => r.text)));
    return rows;
  };
  const resizeSidebar = (w) => ui.evaluate((width) => { document.documentElement.style.setProperty('--sidebar-width', `${width}px`); }, w);
  const shot = async (name) => { if (shots) await ui.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const theme = (t) => ui.evaluate((v) => { document.documentElement.dataset.theme = v; }, t);

  for (const [wName, w] of [['default', 360], ['min', 300]]) {
    await resizeSidebar(w);
    for (const t of ['light', 'dark']) {
      await theme(t);
      await sleep(250);
      await verify(`${wName} width, ${t}`);
      await shot(`rows-${wName}-${t}`);
    }
  }
  const texts = (await measure()).map((r) => r.text);
  check('the tools with no line of their own are named in words with their main argument', texts.includes('Looking at files: downloads') && texts.includes('Looking up a tool: select:SomeTool') && texts.includes('Using something else'), JSON.stringify(texts));

  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
