// A click anywhere in the address field (not only on its text) focuses the address bar, and a click on one of its
// buttons does not.
'use strict';
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-omni-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(800);
    const focused = () => ui.evaluate(() => document.activeElement?.id === 'address');
    const blur = async () => { await ui.evaluate(() => document.activeElement?.blur()); await sleep(100); };
    const box = await ui.evaluate(() => { const r = document.getElementById('omnibox').getBoundingClientRect(); const a = document.getElementById('address').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, ax: a.x, aw: a.width }; });
    const y = box.y + box.h / 2;
    for (const [label, x] of [['the far left of the field', box.x + 6], ['left of the text', box.x + Math.max(8, (box.ax - box.x) / 2)], ['the far right of the field', box.x + box.w - 6], ['the middle of the text area', box.ax + box.aw / 2]]) {
      await blur();
      await ui.mouse.click(x, y);
      await sleep(150);
      check(`a click on ${label} focuses the address bar`, await focused(), `x=${Math.round(x)} box=${JSON.stringify(box)}`);
    }
    // The reload button inside the field still does its own job and does not turn into an address click.
    await blur();
    const reload = await ui.evaluate(() => { const r = document.getElementById('reload').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await ui.mouse.click(reload.x, reload.y);
    await sleep(150);
    check('a click on the reload button inside the field does not focus the address', !(await focused()), 'address took focus');
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
