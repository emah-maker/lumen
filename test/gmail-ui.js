// The Gmail widget in the real app (Electron, a throwaway profile, a background window): the card signed out
// (this really asks mail.google.com's feed with no Google cookies, which answers 401: nothing is sent but a GET),
// then signed in against a stand-in feed (main.js's TEST hook global.__googleMailFake), what Settings shows for
// each mode, the account picker and the client-JSON box of the Advanced setup. Never signs in to anything.
// SHOTS=<dir> saves screenshots of the card and Settings there.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const entry = (title, summary, name, email, hex) => `<entry><title>${title}</title><summary>${summary}</summary><link rel="alternate" href="https://mail.google.com/mail?account_id=me%40example.com&amp;message_id=${hex}&amp;view=conv&amp;extsrc=atom" type="text/html"/><modified>2026-10-05T08:00:00Z</modified><id>tag:gmail.google.com,2004:1</id><author><name>${name}</name><email>${email}</email></author></entry>`;
const FEED = (who) => `<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for ${who}</title><fullcount>12</fullcount>${[
  entry('Your Friday itinerary', 'Boarding passes are attached &amp; ready', 'Ada Lovelace', 'ada@example.com', '18c3a1b2c3d4e5f6'),
  entry('&lt;img src=x onerror=alert(1)&gt; Invoice', '&lt;script&gt;alert(2)&lt;/script&gt; due Monday', 'Billing &lt;b&gt;Bot&lt;/b&gt;', 'bill@example.com', '28c3a1b2c3d4e5f6'),
  entry('Lunch?', 'Are you free at noon on Thursday to try the new place', 'Grace Hopper', 'grace@example.com', '38c3a1b2c3d4e5f6'),
].join('')}</feed>`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-gmail-ui-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [{ id: 'wgmail001', type: 'gmail', title: '', span: 3, x: 0, y: 0, w: 5, h: 9, mode: 'google', count: 4 }], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ...(process.env.SHOW_WINDOW ? {} : { LUMEN_TEST_BACKGROUND: '1' }) } });
  const shots = process.env.SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const shot = async (name, evalIn) => { if (!shots) return; const b64 = await app.evaluate(async (_e, c) => { const wc = eval(c); global.__agent.browser.switchToContents?.(wc); wc.invalidate?.(); await new Promise((r) => setTimeout(r, 600)); return (await wc.capturePage()).toPNG().toString('base64'); }, evalIn); fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(b64, 'base64')); };
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(() => { global.__googleMailCalls = []; });
    const W = (method, ...args) => app.evaluate((_e, [m, a]) => global.__widgets[m](...a), [method, args]);
    await app.evaluate(() => { global.__widgetRateMax = 5000; });
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
    const cardText = () => page(`(document.querySelector('.w-card[data-id="wgmail001"]') || {}).textContent || ''`);
    const waitCard = async (re, ms = 20000) => { const end = Date.now() + ms; let t = ''; while (Date.now() < end) { t = await cardText(); if (re.test(t)) return t; await sleep(250); } return t; };

    // ---- signed out: the real feed answers 401 to a request with no Google cookies ----
    let t = await waitCard(/Sign in to Gmail/);
    check('card signed out (live): the feed answered 401 and the card offers "Sign in to Gmail"', /Sign in to Gmail/.test(t) && !/\d+\s*unread/i.test(t), t);
    const btn = await page(`(() => { const b = [...document.querySelectorAll('.w-card[data-id="wgmail001"] button')].find((x) => /Sign in to Gmail/.test(x.textContent)); return b ? b.getAttribute('aria-label') : null; })()`);
    check('card signed out: the button is labelled for assistive tech', /Sign in to Gmail for/.test(btn || ''), btn);
    await shot('card-signed-out', 'global.__wtab.webContents');
    const before = await app.evaluate(() => global.__settings.tabs().length);
    await page(`[...document.querySelectorAll('.w-card[data-id="wgmail001"] button')].find((x) => /Sign in to Gmail/.test(x.textContent)).click()`);
    await sleep(1500);
    const tabs = await app.evaluate(() => global.__settings.tabs());
    check('card signed out: its button opens Google\'s sign-in in a normal tab', tabs.length === before + 1 && tabs.some((x) => /^https:\/\/accounts\.google\.com\//.test(x.url)), JSON.stringify(tabs.map((x) => x.url)));
    t = await cardText();
    check('card signed out: it then says to finish signing in in that tab', /Finish signing in/.test(t), t);

    // ---- signed in (a stand-in feed) ----
    // (functions do not cross evaluate; the stand-in is installed from the feed text)
    await app.evaluate((_e, src) => { global.__googleMailCalls = []; global.__googleMailFake = async (url) => { global.__googleMailCalls.push(url); const n = Number(new URL(url).pathname.split('/')[3]); return n < 2 ? { status: 200, body: src.replace('Inbox for X', `Inbox for ${n === 0 ? 'me@example.com' : 'work@example.com'}`) } : { status: 401, body: '' }; }; },
      FEED('X'));
    await W('googleSessionChanged');
    t = await waitCard(/12/, 15000);
    check('card signed in: the unread count, the account and the newest subjects show', /12\s*\n?\s*unread/i.test(t) && /me@example\.com/.test(t) && /Your Friday itinerary/.test(t) && /Lunch\?/.test(t) && /Ada Lovelace/.test(t), t);
    check('card signed in: it says plainly that only unread mail is listed', /unread messages only/i.test(t), t);
    const dom = await page(`(() => { const c = document.querySelector('.w-card[data-id="wgmail001"]'); return { imgs: c.querySelectorAll('img, script, svg[onload]').length, links: [...c.querySelectorAll('a')].map((a) => a.href), html: c.innerHTML.includes('onerror=') && c.querySelectorAll('[onerror]').length }; })()`);
    check('card signed in: markup in a message stays text (no element made, no handler attribute)', dom.imgs === 0 && dom.html === 0 && /<img src=x onerror=alert\(1\)> Invoice/.test(await cardText()), JSON.stringify(dom));
    check('card signed in: each subject links to its message in the chosen account', dom.links.filter((l) => l.includes('#inbox/')).length === 3 && dom.links.every((l) => l === 'https://mail.google.com/mail/u/0/' || /^https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox\/[0-9a-f]+$/.test(l)), JSON.stringify(dom.links));
    await shot('card-signed-in', 'global.__wtab.webContents');
    check('no console errors on the page', (await app.evaluate(() => global.__errs)).length === 0, JSON.stringify(await app.evaluate(() => global.__errs)));

    // ---- Settings: the default mode, the account picker, and the Advanced setup ----
    const settingsId = await app.evaluate(() => global.__settings.open('appearance'));
    const sp = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c), [settingsId, code]);
    await sleep(1500);
    await sp(`document.querySelector('.widget-item[data-id="wgmail001"]').click()`);
    await sleep(1500);
    const google = await sp(`(() => ({ g: !document.getElementById('widget-gmail-google').hidden, o: !document.getElementById('widget-gmail-oauth').hidden, opts: [...document.querySelectorAll('#widget-gmail-account option')].map((o) => o.textContent), limits: document.getElementById('widget-gmail-limits').textContent, status: document.getElementById('widget-gmail-gstatus').textContent }))()`);
    check('settings: the Google sign-in way shows first, the own-client way is hidden', google.g === true && google.o === false, JSON.stringify(google));
    check('settings: the account picker lists the signed-in accounts by address', JSON.stringify(google.opts) === JSON.stringify(['me@example.com', 'work@example.com']) && /Signed in to Google in Lumen: 2 accounts/.test(google.status), JSON.stringify(google));
    check('settings: it says what the feed cannot do', /unread messages only/i.test(google.limits), google.limits);
    await sp("location.hash = '#widgets'");
    await sleep(500);
    await sp("document.getElementById('widget-gmail-mode').scrollIntoView({ block: 'start' })");
    await sleep(300);
    await shot('settings-google', 'global.__settings.contents(' + settingsId + ')');
    await sp(`document.querySelector('#widget-gmail-mode [data-value="oauth"]').click()`);
    await sleep(300);
    const adv = await sp(`(() => ({ g: !document.getElementById('widget-gmail-google').hidden, o: !document.getElementById('widget-gmail-oauth').hidden, helps: [...document.querySelectorAll('[data-help]')].map((b) => b.dataset.help), connect: document.getElementById('widget-gmail-connect').textContent }))()`);
    check('settings: Advanced shows the four guided steps and the Connect button', adv.o === true && adv.g === false && JSON.stringify(adv.helps) === JSON.stringify(['gmailProject', 'gmailApi', 'gmailConsent', 'gmailClient']) && /Connect Gmail/.test(adv.connect), JSON.stringify(adv));
    const json = JSON.stringify({ installed: { client_id: '123456789012-abcdefghijklmnop.apps.googleusercontent.com', client_secret: 'GOCSPX-abcdefgh_ij-12', redirect_uris: ['http://localhost'] } });
    await sp(`(() => { const t = document.getElementById('widget-gmail-json'); t.value = ${JSON.stringify(json)}; t.dispatchEvent(new Event('change')); })()`);
    await sleep(600);
    const filled = await sp(`({ id: document.getElementById('widget-clientid').value, secretLen: document.getElementById('widget-clientsecret').value.length, found: document.getElementById('widget-gmail-found').textContent, box: document.getElementById('widget-gmail-json').value })`);
    check('settings: dropping or pasting the downloaded client JSON fills in the Client ID and secret', filled.id === '123456789012-abcdefghijklmnop.apps.googleusercontent.com' && filled.secretLen === 21 && /Got the client/.test(filled.found) && filled.box === '', JSON.stringify({ ...filled, secretLen: filled.secretLen }));
    await sp(`(() => { const t = document.getElementById('widget-gmail-json'); t.value = '{"web":{"client_id":"x"}}'; t.dispatchEvent(new Event('change')); })()`);
    await sleep(400);
    check('settings: a Web application client file is refused with the reason', /Desktop app/.test(await sp(`document.getElementById('widget-gmail-found').textContent`)), '');
    await sp("location.hash = '#widgets'");
    await sleep(500);
    await sp("document.getElementById('widget-gmail-mode').scrollIntoView({ block: 'start' })");
    await sleep(300);
    await shot('settings-advanced', 'global.__settings.contents(' + settingsId + ')');
    check('the stand-in feed was only ever asked for mail.google.com feed addresses', (await app.evaluate(() => global.__googleMailCalls)).every((u) => /^https:\/\/mail\.google\.com\/mail\/u\/[0-9]\/feed\/atom$/.test(u)), JSON.stringify(await app.evaluate(() => global.__googleMailCalls)));
    check('no secret reached settings.json', !/GOCSPX/.test(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')), '');
  } catch (err) {
    check('the Gmail UI run finished', false, err.stack);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the OS cleans temp */ }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
