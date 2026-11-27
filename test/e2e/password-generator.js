// [passwords] "Use a strong password" end to end (features/password-page.js offer, features/password-generator.js) on local
// sign-up pages (http://127.0.0.1 counts as local). Checks: the offer shows on a new-password field and not on a sign-in;
// picking it (a trusted click, or ↓ and Enter) fills the password and confirm fields with one password that keeps the
// field's maxlength, minlength and pattern; nothing is submitted; the AI can't read it (read_page, run_script); sending the
// form saves it for the site without asking, and the bar says so; Settings → Generate a password (length, symbols, Copy).
// A throwaway profile; windows stay invisible (LUMEN_TEST_BACKGROUND); the clipboard is stubbed.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Sign-up with autocomplete="new-password", a confirm field, and constraints: 16 to 24 letters and digits.
const SIGNUP = `<!doctype html><html><head><meta charset="utf-8"><title>Create account</title></head><body>
<form id="f" method="post" action="/welcome">
  <label>Email <input id="user" type="email" name="email" autocomplete="username"></label>
  <label>Password <input id="pw" type="password" name="password" autocomplete="new-password" minlength="16" maxlength="24" pattern="[A-Za-z0-9]{16,24}"></label>
  <label>Confirm <input id="pw2" type="password" name="confirm"></label>
  <button id="go" type="submit">Create account</button>
</form></body></html>`;
// A sign-up form that marks nothing: password and confirm, maxlength 14.
const PLAIN = `<!doctype html><html><head><meta charset="utf-8"><title>Join</title></head><body>
<form id="f" method="post" action="/welcome">
  <input id="user" type="text" name="login">
  <input id="pw" type="password" name="pass" maxlength="14">
  <input id="pw2" type="password" name="pass2" maxlength="14">
  <button id="go" type="submit">Join</button>
</form></body></html>`;
const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<form id="f" method="post" action="/welcome">
  <input id="user" type="email" name="email" autocomplete="username">
  <input id="pw" type="password" name="password" autocomplete="current-password">
  <button id="go" type="submit">Sign in</button>
</form></body></html>`;
const WELCOME = '<!doctype html><html><head><title>Welcome</title></head><body><p>Welcome.</p></body></html>';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const skip = (label, why) => console.log(`SKIP  ${label}  (${why})`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await sleep(100); } return v; };

  const posted = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { posted.push({ url: req.url, body }); res.writeHead(200, { 'content-type': 'text/html' }); res.end(WELCOME); }); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/plain') ? PLAIN : req.url.startsWith('/login') ? LOGIN : SIGNUP);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const site = `127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-password-generator-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: '' }, colorScheme: null });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  const open = (url) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u, {});
    await new Promise((r) => t.webContents.once('did-finish-load', r));
    return t.id;
  }, url);
  const inTab = (id, js) => app.evaluate((_e, [i, code]) => global.__translate.tab(i).view.webContents.executeJavaScript(code), [id, js]);
  const pwWorld = (id, js) => app.evaluate((_e, [i, code]) => global.__translate.tab(i).view.webContents.executeJavaScriptInIsolatedWorld(1077, [{ code }]), [id, js]);
  const stateOf = (id) => app.evaluate((_e, i) => global.__passwords.stateOf(global.__translate.tab(i)), id);
  const offerShown = (id) => inTab(id, 'Boolean(document.querySelector("lumen-password-offer"))');
  // Real input events (trusted, as the user's own), sent to the page itself.
  const keys = (id, ...codes) => app.evaluate(async (_e, [i, list]) => {
    const wc = global.__translate.tab(i).view.webContents;
    for (const keyCode of list) { wc.sendInputEvent({ type: 'keyDown', keyCode }); if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode }); await new Promise((r) => setTimeout(r, 60)); }
  }, [id, codes]);
  const clickAt = (id, x, y) => app.evaluate(async (_e, [i, px, py]) => {
    const wc = global.__translate.tab(i).view.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
  }, [id, Math.round(x), Math.round(y)]);
  const typeUser = (id, text) => app.evaluate(async (_e, [i, u]) => {
    const wc = global.__translate.tab(i).view.webContents;
    await wc.executeJavaScript('document.getElementById("user").focus()');
    await wc.insertText(u);
  }, [id, text]);
  const submit = (id) => app.evaluate(async (_e, i) => {
    const wc = global.__translate.tab(i).view.webContents;
    const done = new Promise((r) => wc.once('did-finish-load', r));
    await wc.executeJavaScript('document.getElementById("f").requestSubmit(document.getElementById("go"))');
    await done;
  }, id);
  const readPage = () => app.evaluate(async () => { try { return String(await global.__agent.execute('read_page', { mode: 'full' })); } catch (err) { return `ERROR ${err.message}`; } });
  const runScript = (code) => app.evaluate(async (_e, c) => { try { return String(await global.__agent.execute('run_script', { code: c })); } catch (err) { return `ERROR ${err.message}`; } }, code);

  const available = await app.evaluate(() => global.__secretBox.available());
  if (!available) {
    skip('the strong password checks', 'safeStorage is unavailable here');
    await app.close();
    server.close();
    process.exit(0);
  }

  // ---- off: no offer ----
  const t0 = await open(`${base}/signup`);
  await inTab(t0, 'document.getElementById("pw").focus()');
  await sleep(400);
  check('Save passwords off: no offer on a sign-up form', !(await offerShown(t0)), '');

  const on = await app.evaluate(() => global.__passwords.setEnabled(true));
  check('Save passwords turns on', on.enabled, JSON.stringify(on));

  // ---- a sign-in form: never offered ----
  const tl = await open(`${base}/login`);
  await waitFor(async () => (await pwWorld(tl, 'typeof window.__lumenPasswords?.offering')) === 'object');
  await inTab(tl, 'document.getElementById("pw").focus()');
  await sleep(400);
  check('a sign-in (current-password) field gets no offer', !(await offerShown(tl)), '');

  // ---- sign-up with autocomplete="new-password": offered, picked with a click ----
  const t1 = await open(`${base}/signup`);
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), t1);
  await waitFor(async () => (await pwWorld(t1, 'typeof window.__lumenPasswords?.offering')) === 'object');
  await typeUser(t1, 'new.user@example.com');
  await sleep(200);
  check('the email field gets no offer', !(await offerShown(t1)), '');
  await inTab(t1, 'document.getElementById("pw").focus()');
  check('the new-password field gets "Use a strong password"', await waitFor(() => offerShown(t1)), '');
  const pageBefore = await readPage();
  check('the box is closed to the page (no shadow root it can open)', (await inTab(t1, 'document.querySelector("lumen-password-offer").shadowRoot')) === null, '');
  const box = await inTab(t1, '(() => { const r = document.querySelector("lumen-password-offer").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()');
  check('the box sits under the field with a size', box.w > 100 && box.h > 20, JSON.stringify(box));
  const untrusted = await inTab(t1, '(() => { document.querySelector("lumen-password-offer").click(); return document.getElementById("pw").value; })()');
  check('a page script clicking the box fills nothing', untrusted === '', untrusted);
  await clickAt(t1, box.x, box.y);
  const filled = await waitFor(async () => { const v = await inTab(t1, 'document.getElementById("pw").value'); return v ? v : ''; });
  const confirm = await inTab(t1, 'document.getElementById("pw2").value');
  check('a click fills the password', typeof filled === 'string' && filled.length > 0, filled ? `${filled.length} chars` : 'empty');
  check('...and the confirm field with the same one', confirm === filled, `${confirm.length} vs ${filled.length}`);
  check('...keeping maxlength 24, minlength 16 and the pattern (letters and digits)', filled.length >= 16 && filled.length <= 24 && /^[A-Za-z0-9]{16,24}$/.test(filled), filled.length);
  check('...with capitals, lowercase and digits, no look-alikes', /[a-z]/.test(filled) && /[A-Z]/.test(filled) && /[2-9]/.test(filled) && !/[0Oo1lI]/.test(filled), '');
  check('...that the page itself sees as valid', (await inTab(t1, 'document.getElementById("pw").checkValidity()')) === true, '');
  check('the box goes after the pick', !(await offerShown(t1)), '');
  check('nothing was submitted', posted.length === 0, posted.length);
  check('the AI saw no password before the pick', !pageBefore.startsWith('ERROR') && !pageBefore.includes(filled), pageBefore.slice(0, 200));
  const pageAfter = await readPage();
  check('read_page shows no password after the pick', !pageAfter.includes(filled), pageAfter.slice(0, 200));
  const script = await runScript('return document.getElementById("pw").value');
  check('run_script is refused on the page with the strong password', /^ERROR run_script is not available on this page/.test(script) && !script.includes(filled), script);
  check('the browser UI never gets the password', !(await ui.evaluate(() => document.body.innerHTML)).includes(filled), '');

  // ---- sending the form saves it, without asking ----
  await submit(t1);
  const saved = await waitFor(() => app.evaluate((_e, s) => global.__passwords.vault.find(s, 'new.user@example.com')?.password || '', site));
  check('the form sends the strong password', posted.length === 1 && posted[0].body.includes(`password=${encodeURIComponent(filled)}`), posted[0]?.body?.slice(0, 80));
  check('sending the form saves it for the site and username', saved === filled, saved ? 'other password' : 'not saved');
  const st = await stateOf(t1);
  check('the bar says it was saved (no password in the state)', st?.offer?.generated === true && st.offer.site === site && !JSON.stringify(st).includes(filled), JSON.stringify(st));
  const barText = await waitFor(() => ui.$eval('#password-bar', (el) => (el.hidden ? '' : el.textContent)));
  check('...as "Lumen saved the strong password for <site>"', barText.includes(`Lumen saved the strong password for ${site}`) && !barText.includes('Never for this site') && !barText.includes(filled), barText);
  await ui.evaluate(() => [...document.querySelectorAll('#password-bar button')].find((b) => b.textContent === 'OK').click());
  check('OK closes the bar', await waitFor(() => ui.$eval('#password-bar', (el) => el.hidden)), '');
  check('one login saved', (await app.evaluate(() => global.__passwords.vault.count())) === 1, '');

  // ---- a form that marks nothing (password + confirm), picked with the keyboard ----
  const t2 = await open(`${base}/plain`);
  await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), t2);
  await waitFor(async () => (await pwWorld(t2, 'typeof window.__lumenPasswords?.offering')) === 'object');
  await typeUser(t2, 'joiner');
  await inTab(t2, 'document.getElementById("pw2").focus()');
  check('a sign-up with password and confirm (no autocomplete) is offered, from the confirm field too', await waitFor(() => offerShown(t2)), '');
  await keys(t2, 'Down', 'Return');
  const plain = await waitFor(async () => (await inTab(t2, 'document.getElementById("pw").value')) || '');
  check('↓ then Enter fills both fields', plain && plain === (await inTab(t2, 'document.getElementById("pw2").value')), `${plain.length}`);
  check('...14 characters at most (maxlength), with symbols and all four kinds', plain.length === 14 && /[a-z]/.test(plain) && /[A-Z]/.test(plain) && /[2-9]/.test(plain) && /[^A-Za-z0-9]/.test(plain), plain.length);
  check('Enter picked it rather than sending the form', posted.length === 1, posted.length);
  const t2b = await open(`${base}/plain`);
  await waitFor(async () => (await pwWorld(t2b, 'typeof window.__lumenPasswords?.offering')) === 'object');
  await inTab(t2b, 'document.getElementById("pw").focus()');
  await waitFor(() => offerShown(t2b));
  await keys(t2b, 'Escape');
  await sleep(200);
  check('Escape closes the box and fills nothing', !(await offerShown(t2b)) && (await inTab(t2b, 'document.getElementById("pw").value')) === '', '');

  // ---- Settings → Generate a password ----
  await app.evaluate(({ clipboard }) => {
    global.__genClip = { text: '', writes: 0, real: { writeText: clipboard.writeText, readText: clipboard.readText, clear: clipboard.clear } };
    clipboard.writeText = (t) => { global.__genClip.text = t; global.__genClip.writes++; };
    clipboard.readText = () => global.__genClip.text;
    clipboard.clear = () => { global.__genClip.text = ''; };
  });
  const sid = await app.evaluate(() => global.__settings.open('passwords'));
  const sWc = (code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err.message}`; } }, [sid, code]);
  const shown = await waitFor(async () => { const v = await sWc('document.getElementById("passwords-generated")?.value || ""'); return v.length ? v : ''; });
  check('Settings shows a generated password, 20 characters with symbols', shown.length === 20 && /[^A-Za-z0-9]/.test(shown) && /[a-z]/.test(shown) && /[A-Z]/.test(shown) && /[2-9]/.test(shown), shown.length);
  await sWc('(() => { const r = document.getElementById("passwords-gen-length"); r.value = "40"; r.dispatchEvent(new Event("input")); })()');
  const longer = await waitFor(async () => { const v = await sWc('document.getElementById("passwords-generated").value'); return v.length === 40 ? v : ''; });
  check('the length slider makes a 40-character one', longer.length === 40 && (await sWc('document.getElementById("passwords-gen-length-text").textContent')) === '40 characters', longer.length);
  await sWc('document.getElementById("passwords-gen-symbols").click()');
  const noSym = await waitFor(async () => { const v = await sWc('document.getElementById("passwords-generated").value'); return v !== longer && /^[A-Za-z0-9]{40}$/.test(v) ? v : ''; });
  check('symbols off: letters and digits only', /^[A-Za-z0-9]{40}$/.test(noSym || ''), noSym);
  await sWc('document.getElementById("passwords-gen-new").click()');
  const fresh = await waitFor(async () => { const v = await sWc('document.getElementById("passwords-generated").value'); return v && v !== noSym ? v : ''; });
  check('New password makes another one', fresh && fresh !== noSym && fresh.length === 40, '');
  await sWc('document.getElementById("passwords-gen-copy").click()');
  const clip = await waitFor(() => app.evaluate(() => global.__genClip.text));
  check('Copy puts it on the clipboard', clip === fresh, clip ? 'other text' : 'nothing');
  check('...and says it is cleared in 30 seconds', /cleared in 30 seconds/.test(await waitFor(() => sWc('document.getElementById("passwords-gen-status").textContent'))), '');
  check('generating saves nothing', (await app.evaluate(() => global.__passwords.vault.count())) === 1, '');
  const bad = await app.evaluate(async ({ clipboard }) => { const before = global.__genClip.writes; const r = global.__passwords.invoke('settings:passwords-copy-generated', { __synthetic: true }, 'x\nmultiline'); return { r, wrote: global.__genClip.writes !== before }; }).catch((err) => ({ err: err.message }));
  check('Copy refuses text that is not a generated password (a line break here)', bad.r === false && !bad.wrote, JSON.stringify(bad));
  const fromPage = await app.evaluate(async (_e, i) => { try { await global.__passwords.invoke('settings:passwords-generate', { sender: global.__translate.tab(i).view.webContents }, {}); return 'answered'; } catch (err) { return err.message; } }, t1);
  check('a web page cannot ask for a generated password', fromPage === 'Not allowed', fromPage);
  await app.evaluate(({ clipboard }) => Object.assign(clipboard, global.__genClip.real));

  check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
