// A chat reopened from history (or after a restart) shows the files the AI wrote as the same links as live: the saved reply keeps the paths
// (meta.written), main turns them into rows of the file registry when the chat is opened, and the safety rules are checked again at click time
// (a missing file says so; a script or program is only shown in its folder). Temp files only; hidden window; no network.
//   node <scratchpad>\e2e-slots.js run --owner reopened-chat-files --wait-min 90 -- node test/reopened-chat-files.js
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const root = process.env.REOPENED_ROOT || path.join(__dirname, '..');
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(root, 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-reopened-files-'));
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-reopened-work-')));
  const page = path.join(work, 'report.html');
  const script = path.join(work, 'run.ps1');
  const gone = path.join(work, 'deleted.md');
  const notes = path.join(work, 'notes.txt');
  fs.writeFileSync(page, '<!doctype html><title>reopened report</title><p>hello</p>');
  fs.writeFileSync(script, 'Write-Host hi');
  fs.writeFileSync(notes, 'notes');
  const app = await electron.launch({
    args: [root],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await sleep(400);
    await ui.evaluate('loadStepUI()');
    await ui.waitForFunction(() => window.stepUI && window.stepLabels);

    // A saved chat: one exchange whose reply wrote four files (as a run stamps it, meta.written holds the paths).
    const reopen = async (written) => {
      await app.evaluate(({ BrowserWindow }, args) => {
        global.__shellCalls = [];
        global.__aiFileShell = (how, p) => { global.__shellCalls.push([how, p]); return { ok: true }; };
        const agent = global.__agent;
        agent.messages.length = 0;
        const step = (p, name) => ({ label: `Writing ${name}`, name: 'Write', input: { file_path: p }, ok: true });
        agent.messages.push({ role: 'user', content: 'write the files' });
        agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Done: wrote report.html.' }], meta: { id: 'abc123', at: Date.now(), cards: true, tools: [step(args.page, 'report.html'), step(args.script, 'run.ps1'), step(args.gone, 'deleted.md'), step(args.notes, 'notes.txt')], ...(args.written ? { written: [args.page, args.script, args.gone, args.notes] } : {}) } });
        const w = BrowserWindow.getAllWindows().find((x) => /index\.html/.test(x.webContents.getURL())) || BrowserWindow.getAllWindows()[0];
        w.webContents.send('agent:history', { items: agent.transcript() });
      }, { page, script, gone, notes, written });
    };
    const links = () => ui.evaluate(() => [...document.querySelectorAll('#messages .act-card .act-files .act-filelink')].map((b) => b.textContent));

    await reopen(true);
    const shown = await waitFor(async () => (await links()).length >= 4, 8000);
    check('a reopened chat shows its written files as links in the Files card', Boolean(shown) && JSON.stringify(await links()) === JSON.stringify(['report.html', 'run.ps1', 'deleted.md', 'notes.txt']), JSON.stringify(await links()));
    check('each row also has Show in folder', (await ui.evaluate(() => document.querySelectorAll('#messages .act-card .act-files .act-fileshow').length)) === 4);
    const cardCount = await ui.evaluate(() => document.querySelectorAll('#messages .act-card').length);
    check('one card for the reply', cardCount === 1, cardCount);

    // click: a page opens in a tab, a script is only shown in its folder, a deleted file says so, Show in folder reveals
    const tabsBefore = await app.evaluate(() => global.__agent.browser.listTabs().length);
    await ui.evaluate(() => document.querySelectorAll('#messages .act-card .act-files .act-filelink')[0].click());
    const opened = await waitFor(() => app.evaluate(() => global.__agent.browser.listTabs().some((t) => /report\.html/i.test(t.url))), 8000);
    check('clicking the page opens it in a tab', Boolean(opened) && (await app.evaluate(() => global.__agent.browser.listTabs().length)) > tabsBefore, JSON.stringify(await app.evaluate(() => global.__agent.browser.listTabs().map((t) => t.url.slice(0, 80)))));
    await ui.evaluate(() => document.querySelectorAll('#messages .act-card .act-files .act-filelink')[1].click());
    await sleep(300);
    let calls = await app.evaluate(() => global.__shellCalls);
    check('a script is only shown in its folder, never opened', calls.length === 1 && calls[0][0] === 'reveal' && calls[0][1].toLowerCase() === script.toLowerCase(), JSON.stringify(calls));
    await ui.evaluate(() => document.querySelectorAll('#messages .act-card .act-files .act-filelink')[2].click());
    const note = await waitFor(() => ui.evaluate(() => document.querySelector('#messages .act-card .act-filenote')?.textContent || ''), 4000);
    check('a file deleted since says it is no longer there', /no longer there/.test(note || ''), note);
    await ui.evaluate(() => document.querySelectorAll('#messages .act-card .act-files .act-fileshow')[3].click());
    await sleep(300);
    calls = await app.evaluate(() => global.__shellCalls);
    check('Show in folder reveals the file', calls.length === 2 && calls[1][0] === 'reveal' && calls[1][1].toLowerCase() === notes.toLowerCase(), JSON.stringify(calls));

    // only paths recorded as written for this chat: a reply with no record has no links, and an id the page makes up opens nothing
    await ui.evaluate(() => { for (const n of [...document.getElementById('messages').children]) if (n.id !== 'empty') n.remove(); });
    await reopen(false);
    await waitFor(() => ui.evaluate(() => document.querySelectorAll('#messages .act-card').length === 1), 6000);
    await sleep(300);
    check('the reply is drawn again as one card', (await ui.evaluate(() => document.querySelectorAll('#messages .act-card').length)) === 1);
    check('a reply with no recorded files has no file links', (await links()).length === 0, JSON.stringify(await links()));
    const forged = await ui.evaluate(() => window.assistant.files.open('0123456789abcdef', 'system'));
    check('an id main never made opens nothing', forged && forged.ok === false, JSON.stringify(forged));
  } finally {
    await app.close().catch(() => {});
    for (const d of [profile, work]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ } }
  }
  console.log(failures ? `\n${failures} failed` : '\nAll reopened-chat-files checks passed');
  process.exit(failures ? 1 : 0);
})();
