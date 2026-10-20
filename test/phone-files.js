// [phone files] Files and links from the phone in a real Lumen window (main.js notePhoneFile / openFromPhone; the Telegram side
// is test/telegram-units.js): a saved file shows the strip's toast, its Attach to chat button puts the file in the composer
// and the caption in the empty prompt (not sent), a program only gets Show in Finder, several files in a row share one toast,
// a link opens a tab behind the current one, and Send to phone stays hidden while no chat is paired. Throwaway profile.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-phone-files-'));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-phone-dl-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };
    await app.evaluate((_e, dir) => { global.__phoneInboxDir = dir; global.__filesShell = (name, p) => { (global.__shellCalls ||= []).push([name, p]); }; }, downloads);

    // ---- a photo with a caption
    const saved = await app.evaluate(() => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const f = global.__phone.inbox().save({ name: 'Photo 2026-10-20 12.00.00.png', mime: 'image/png', data: png });
      global.__phone.note(f, 'what plant is this?');
      return f;
    });
    check('the file is saved in Downloads/From phone', saved.path === path.join(downloads, 'From phone', saved.name) && fs.existsSync(saved.path), saved.path);
    const toast = await waitFor(() => ui.evaluate(() => { const n = document.querySelector('.organize-note'); return n && { text: n.querySelector('.organize-note-text')?.textContent, button: n.querySelector('button')?.textContent }; }));
    check('the strip shows a toast with Attach to chat', toast && /came from your phone/.test(toast.text) && toast.button === 'Attach to chat', JSON.stringify(toast));
    await ui.click('.organize-note button');
    const composer = await waitFor(() => ui.evaluate(() => { const chips = document.querySelectorAll('#attachments .attachment').length; return chips ? { chips, prompt: document.getElementById('prompt').value } : null; }));
    check('Attach to chat puts the file in the composer', composer?.chips === 1, JSON.stringify(composer));
    check('…and the caption in the empty prompt, not sent', composer?.prompt === 'what plant is this?', JSON.stringify(composer));

    // ---- an album: one toast for several files
    const count = await app.evaluate(() => {
      for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) global.__phone.note(global.__phone.inbox().save({ name: n, mime: 'application/pdf', data: Buffer.from('%PDF-1.4') }), '');
      return global.__phoneNotes.slice(-3).map((x) => x.token);
    });
    check('files arriving together share one toast', new Set(count).size === 1, JSON.stringify(count));
    const many = await waitFor(() => ui.evaluate(() => document.querySelector('.organize-note-text')?.textContent));
    check('…which counts them', /3 files came from your phone/.test(many || ''), many);

    // ---- a program: Show in Finder only
    await sleep(8100); // (past the album window: a new toast)
    const risky = await app.evaluate(async () => {
      const f = global.__phone.inbox().save({ name: 'installer.pkg', data: Buffer.from('xar!') });
      global.__phone.note(f, '');
      const last = global.__phoneNotes.at(-1);
      await global.__phone.action(last.token);
      return { showOnly: last.showOnly, shell: global.__shellCalls?.at(-1) };
    });
    check('a program is only shown in Finder, never attached', risky.showOnly && risky.shell?.[0] === 'show' && /installer\.pkg$/.test(risky.shell?.[1] || ''), JSON.stringify(risky));

    // ---- a link opens a tab behind the current one
    const before = await app.evaluate(() => global.__notifyClick.activeId());
    const tabsBefore = await ui.evaluate(() => document.querySelectorAll('.tab').length);
    await app.evaluate(() => global.__phone.open('about:blank#from-phone'));
    const tabsAfter = await waitFor(async () => { const n = await ui.evaluate(() => document.querySelectorAll('.tab').length); return n > tabsBefore ? n : 0; });
    check('a link from the phone opens a new tab', tabsAfter === tabsBefore + 1, `${tabsBefore} -> ${tabsAfter}`);
    check('…behind the one in front', (await app.evaluate(() => global.__notifyClick.activeId())) === before);

    // ---- Send to phone
    check('Send to phone is hidden while no chat is paired', (await app.evaluate(() => global.__phone.ready())) === false);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(downloads, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
