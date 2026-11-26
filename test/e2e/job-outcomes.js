// [outcomes] A Job applications project's dashboard with a linked tracker sheet, in a real (invisible) window: the sheet is the truth.
// The way the user saw it go wrong (2026-11-26): Outcomes said 1 rejection and "0 d" to an answer. The sheet has no Date Applied column;
// its days are in Status ("Applied Nov 6", "Rejected Nov 4") and Notes ("Submitted Nov 5"), and a sync stamped every answer with its own
// time, so every wait was 0 days. And the sheet's Dashboard tab (listings by odds, region, posting status) was nowhere on the dashboard.
//  - the sheet (a fake Google Sheets answering as the API does; laid out like the user's: a Dashboard tab first, then the tracker) is
//    linked, and its rows are the tracker's: Outcomes counts the sheet's rejection and interview, those waiting and those closed;
//  - the average days to an answer is the sheet's own days (3 and 15: 9 d), not 0, and says how many dated answers it is from;
//  - "From your sheet" shows the Dashboard tab's blocks as the sheet has them: a card per block, a line and a bar per count, the text answer;
//  - a sync again changes nothing (the same numbers), and no page errors.
// Hidden: LUMEN_TEST_BACKGROUND=1, a temp profile; nothing is sent anywhere.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

const TRACKER = [
  ['Company', 'Area', 'Role', 'Deadline', 'Gates', 'Status', 'Apply URL', 'Notes', 'Referral', 'Odds', 'Link'],
  ['Acme Motors', 'Detroit, MI', 'ME Intern', 'Rolling', 'None listed', 'Rejected Nov 4', 'https://acme.example/jobs/1', 'Recheck Oct 26: verified open. Applied Nov 1 via portal', '', 'Med', 'Apply'],
  ['Beta Robotics', 'Boston, MA', 'ME Intern', 'Nov 30', 'None listed', 'Applied Nov 6', 'https://beta.example/jobs/2', 'SUBMITTED Nov 6 via iCIMS', '', 'High', 'Apply'],
  ['Gamma Air', 'Boston, MA', 'ME Intern', 'Rolling', 'None listed', 'Applied (user-reported)', 'https://gamma.example/jobs/3', 'Confirm in portal', '', 'Applied', 'Apply'],
  ['Delta Labs', 'San Jose, CA', 'ME Intern', 'Rolling', 'Unknown', 'Closed — posting removed (checked Oct 23, 2026)', 'https://delta.example/jobs/4', '', '', 'Low', 'Apply'],
  ['Eps Power', 'San Francisco, CA', 'ME Intern', 'Dec 1', 'Unknown', 'Found Oct 26, verified open', 'https://eps.example/jobs/5', 'Confirm gates', '', 'Med', 'Apply'],
  ['Zeta Space', 'Los Angeles, CA', 'ME Intern', 'Rolling', 'U.S. Person', 'Interview Nov 20', 'https://zeta.example/jobs/6', 'Submitted Nov 5, 2026 via Workday', '', 'High', 'Apply'],
];
const DASH = [
  ['Odds', 'Listings by odds'], ['High', '23'], ['Med', '51'], ['Low', '37'], ['Verify', '0'], ['Applied', '37'],
  [], ['Region', 'Listings by region'], ['Boston area', '65'], ['California', '57'], ['Other', '57'],
  [], ['Posting status', 'Listings by posting status'], ['Verified open', '46'], ['Unverified', '56'], ['Applied / backup / skip', '77'],
  [], ['Missing apply link'], ['none'],
];

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const root = path.join(__dirname, '..', '..');
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(root, 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-job-outcomes-'));
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    // A fake Google Sheets: the spreadsheet's tabs, one tab's values, and several tabs' values at once (as the API answers each).
    await app.evaluate((_e, [tracker, dash]) => {
      const tabs = { Dashboard: dash, 'internship-tracker': tracker };
      const tabOf = (range) => { const m = /^'?(.*?)'?!/.exec(decodeURIComponent(range)); return m ? m[1].replace(/''/g, "'") : 'Dashboard'; };
      const answer = (json) => ({ ok: true, status: 200, text: JSON.stringify(json) });
      global.__sheetCalls = [];
      global.__sheetsFake = async (target, opts = {}) => {
        global.__sheetCalls.push(target);
        if (/values:batchGet$/.test(target)) {
          const ranges = [].concat(opts.query?.ranges || []);
          return answer({ valueRanges: ranges.map((r) => ({ range: r, values: tabs[tabOf(r)] || [] })) });
        }
        const one = /\/values\/([^:]+)$/.exec(target);
        if (one && (!opts.method || opts.method === 'GET')) return answer({ values: tabs[tabOf(one[1])] || [] });
        if (/values:batchUpdate$|:append$/.test(target)) return answer({});
        return answer({ properties: { title: 'Summer 2027 ME Internship Tracker' }, sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) });
      };
    }, [TRACKER, DASH]);

    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false, 20000);
    const errors = [];
    await app.evaluate(() => { const t = global.__chatPage.tabs().find((x) => x.chat); global.__jobErrors = []; global.__chatPage.contents(t.id).on('console-message', (e) => { if (e.level === 'error' || e.level === 3) global.__jobErrors.push(String(e.message).slice(0, 200)); }); });
    const api = (call, ...args) => inPage(`window.assistant.chats.${call}(...${JSON.stringify(args)})`);

    const job = await api('saveProject', { name: 'Summer 2027', template: 'job-applications', folderMode: 'none' });
    check('a Job applications project', Boolean(job?.id) && job.template === 'job-applications', JSON.stringify(job).slice(0, 200));
    const linked = await api('projectApplications', job.id, 'link-sheet', { url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit', write: true });
    check('the sheet links and syncs: its rows are in the tracker (the Dashboard tab it opens on is skipped for the one with the columns)', linked?.ok && linked.added === 6, JSON.stringify(linked));
    const data = await api('projectApplications', job.id);
    const st = data?.stats || {};
    check('the numbers are the sheet\'s: 1 rejection, 1 interview, 2 waiting, 1 closed, 4 applied', st.rejections === 1 && st.interviews === 1 && st.waiting === 2 && st.closed === 1 && st.total === 4, JSON.stringify(st));
    check('the average wait is the sheet\'s days (Nov 1 to Nov 4, Nov 5 to Nov 20: 9), not 0', st.avgDays === 9 && st.answered === 2, JSON.stringify(st));
    const src = await api('projectApplications', job.id, 'sources');
    check('the Dashboard tab\'s numbers are kept with the link', src?.sheet?.metrics?.[0]?.tab === 'Dashboard' && src.sheet.metrics[0].blocks.length === 4, JSON.stringify(src?.sheet?.metrics).slice(0, 400));

    // the page: open the project (its dashboard is the first view of a job project)
    const row = `.cp-pj-item[data-project="${job.id}"]`;
    await waitFor(() => inPage(`Boolean(document.querySelector('${row}'))`));
    await inPage(`document.querySelector('${row} .cp-pj-name').click()`);
    const drawn = await waitFor(() => inPage("document.querySelectorAll('.jb-sec-outcomes .jb-tile').length >= 6 && Boolean(document.querySelector('.jb-sec-sheet'))"), 20000);
    check('the dashboard draws Outcomes and From your sheet', drawn === true, await inPage("document.querySelector('.jb')?.innerText?.slice(0, 600)"));
    const tiles = await inPage("Object.fromEntries([...document.querySelectorAll('.jb-sec-outcomes .jb-tile')].map((t) => [t.querySelector('.jb-tile-l').textContent, t.querySelector('.jb-tile-n').textContent]))");
    check('Outcomes: Interviews 1, Offers 0, Rejections 1, Waiting 2, Closed 1, 9 d to an answer', tiles?.Interviews === '1' && tiles.Offers === '0' && tiles.Rejections === '1' && tiles['Waiting to hear back'] === '2' && tiles['Closed or skipped'] === '1' && tiles['Avg. days to an answer'] === '9 d', JSON.stringify(tiles));
    check('…and says what the average is of', /2 dated answers/.test(await inPage("document.querySelector('.jb-sec-outcomes .jb-caption')?.textContent || ''")), await inPage("document.querySelector('.jb-sec-outcomes .jb-sec-head')?.textContent"));
    check('no "+N in email" when no email check found anything', (await inPage("document.querySelectorAll('.jb-tile-more').length")) === 0);
    const sheet = await inPage(`(() => {
      const cards = [...document.querySelectorAll('.jb-sec-sheet .jb-sheet-card')];
      return { caption: document.querySelector('.jb-sec-sheet .jb-caption')?.textContent, cards: cards.map((c) => ({ title: c.querySelector('.jb-sub').textContent, text: c.querySelector('.jb-sheet-text')?.textContent || '', rows: [...c.querySelectorAll('.jb-sheet-row')].map((r) => [r.querySelector('.jb-sheet-label').textContent, r.querySelector('.jb-sheet-n').textContent, Math.round(r.querySelector('.jb-sheet-bar i').getBoundingClientRect().width)]) })) };
    })()`);
    const odds = sheet?.cards?.find((c) => c.title === 'Listings by odds');
    check('From your sheet: a card per block of the Dashboard tab, titled as the sheet has them', JSON.stringify(sheet?.cards?.map((c) => c.title)) === JSON.stringify(['Listings by odds', 'Listings by region', 'Listings by posting status', 'Missing apply link']) && sheet.caption === 'Dashboard', JSON.stringify(sheet));
    check('…each line with its count and a bar as long as its share (Med the longest, Verify none)', odds && odds.rows.length === 5 && odds.rows[1][0] === 'Med' && odds.rows[1][1] === '51' && odds.rows[1][2] > odds.rows[0][2] && odds.rows[3][2] === 0, JSON.stringify(odds));
    check('…and a text answer as the sheet says it', sheet?.cards?.[3]?.text === 'none', JSON.stringify(sheet?.cards?.[3]));
    if (process.env.JOB_OUTCOMES_SHOT) { // (a picture of Outcomes and From your sheet: webContents.capturePage of the hidden page)
      await inPage("document.querySelector('.jb-sec-outcomes').scrollIntoView({ block: 'start' })");
      await sleep(400);
      const png = await app.evaluate(async () => { const t = global.__chatPage.tabs().find((x) => x.chat); return (await global.__chatPage.contents(t.id).capturePage()).toPNG().toString('base64'); });
      fs.writeFileSync(process.env.JOB_OUTCOMES_SHOT, Buffer.from(png, 'base64'));
    }
    const again = await api('projectApplications', job.id, 'sync');
    const st2 = (await api('projectApplications', job.id))?.stats || {};
    check('a second sync adds, moves and writes nothing; the numbers stay', again?.ok && again.added === 0 && again.moved === 0 && again.written === 0 && again.appended === 0 && st2.rejections === 1 && st2.avgDays === 9, JSON.stringify({ again, st2 }));
    errors.push(...(await app.evaluate(() => global.__jobErrors || [])));
    check('no errors on the page', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* in use */ }
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
