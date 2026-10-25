// The Browser card says each step once (renderer/step-ui.js): the step being done is in the status bar only (the summary line is just the step
// count, the tab row names the tab), and consecutive identical steps (a page read three times in a row) are ONE row with a count, not N rows.
// Feeds the card a realistic turn (open_tab, read_page, click, read_page, then read_page x3) and counts where the text appears.
// Hidden window (LUMEN_TEST_BACKGROUND=1), throwaway profile, no network. Run under the lock:
//   node scripts/test/e2e-lock.js run -- node test/e2e/browser-card-dedupe.js
// PNGs go to $CARD_DEDUPE_SHOTS when set.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const shots = process.env.CARD_DEDUPE_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-card-dedupe-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow({ timeout: 90000 });
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(500);
  await ui.evaluate('loadStepUI()');
  await ui.waitForFunction(() => window.stepUI && window.stepLabels);

  const step = (name, input, id) => ui.evaluate(({ name, input, id }) => {
    const messages = document.getElementById('messages');
    const turn = (window.__turn ||= {});
    const opts = { messages, append: (n) => messages.append(n), task: 'Find the cheatsheet', runId: 1 };
    const row = window.stepUI.add(turn, { name, input, id, label: window.t(`tool.${name}`, input) }, opts);
    window.stepUI.thumb(turn, { kind: 'frame', tabId: 3, url: 'https://example.com/notes', title: 'Course notes', data: '' });
    if (id) { row.classList.remove('running'); row.classList.add('done'); window.stepUI.done(turn, row, { ok: true, tabId: 3 }); }
    return row.firstChild.textContent;
  }, { name, input, id });
  // What the user can see of the card: every piece of text it shows, in the card's own words.
  const view = () => ui.evaluate(() => {
    const card = document.querySelector('#messages .act-card');
    const vis = (n) => { for (let e = n; e && e !== card; e = e.parentElement) if (e.hidden || getComputedStyle(e).display === 'none') return false; return true; };
    const rows = [...card.querySelectorAll('.act-list > .step, .act-list > details > summary')].filter((r) => !r.classList.contains('step-note')).map((r) => r.firstChild.textContent);
    return { status: card.querySelector('.act-status-text').textContent, summary: card.querySelector('.act-steps > summary').textContent, site: vis(card.querySelector('.act-site-name')) ? card.querySelector('.act-site-name').textContent : '', rows, state: card.dataset.state };
  });

  await step('open_tab', { url: 'https://example.com/notes' }, 'a1');
  await step('read_page', {}, 'a2');
  await step('click', { selector: '#next' }, 'a3');
  await step('read_page', {}, 'a4');
  const v1 = await view();
  console.log(JSON.stringify(v1));
  const latest = v1.rows[v1.rows.length - 1];
  const sayings = [v1.status, v1.summary, v1.site].filter((s) => s.toLowerCase().includes(latest.toLowerCase().replace(/[.\u2026]+$/, '')));
  check('the current step is said once above the list (status bar), not also in the summary or the tab row', sayings.length <= 1, JSON.stringify({ latest, status: v1.status, summary: v1.summary, site: v1.site }));
  check('the summary line is just the step count while working', /^\d+ steps?$/.test(v1.summary), v1.summary);
  check('four steps are four rows', v1.rows.length === 4, JSON.stringify(v1.rows));
  if (shots) await ui.screenshot({ path: path.join(shots, 'card-sequence.png') });

  for (let i = 0; i < 3; i++) await step('read_page', {}, `b${i}`);
  const v2 = await view();
  console.log(JSON.stringify(v2));
  check('the last page read and the three after it are ONE row (4 rows, not 6)', v2.rows.length === 4, JSON.stringify(v2.rows));
  check('the collapsed row shows the count (x4)', /×4$/.test(v2.rows[v2.rows.length - 1]), v2.rows[v2.rows.length - 1]);
  check('the summary still counts every step', v2.summary === '7 steps', v2.summary);
  if (shots) await ui.screenshot({ path: path.join(shots, 'card-repeat.png') });

  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
