// Page translation (features/translate.js) end to end against a local Spanish page. A FAKE
// translator stands in for the AI (a test hook: no provider, no tokens): it answers the real prompt
// with "[EN] <text>" so the prompt building, reply validation and in-place text replacement all run.
// Checks: the offer, the one-time consent card gating the first send, applying to text nodes only
// (code, translate="no", notranslate and form fields untouched), text added later, Show original,
// Never for this site, the Google fallback URL, and refusals (private session, non-web pages).
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SPANISH = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Página de prueba</title></head><body>
<h1 id="h">Hola mundo</h1>
<p id="p">Esta es una página de ejemplo escrita en español para probar la traducción.</p>
<p>Visita <a id="link" href="/otra">nuestra tienda en línea</a> hoy mismo.</p>
<pre id="pre">const saludo = "hola";</pre>
<p id="code">Usa <code id="c">función()</code> con cuidado.</p>
<p id="no" translate="no">Marca Registrada</p>
<div id="nt" class="notranslate">No traducir esto</div>
<div id="ed" contenteditable="true">Texto editable del usuario</div>
<textarea id="ta">Borrador de mensaje</textarea>
<button id="add" onclick="const p = document.createElement('p'); p.id = 'late'; p.textContent = 'Texto nuevo añadido después'; document.body.append(p)">Añadir</button>
</body></html>`;
const ENGLISH = '<!doctype html><html lang="en"><head><title>English page</title></head><body><p>This page is already in English, so nothing is offered.</p></body></html>';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await sleep(100); } return v; };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/en') ? ENGLISH : SPANISH);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-translate-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: '' }, colorScheme: null });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // The fake translator: records every request, answers with "[EN] text" (the real prompt is used).
  await app.evaluate(() => {
    global.__trCalls = [];
    global.__translate.api.setTestEngine({
      id: 'test:fake',
      label: 'FakeAI',
      run: async (system, user) => {
        global.__trCalls.push({ system, user });
        const { items } = JSON.parse(user);
        return { items: items.map((i) => ({ id: i.id, text: i.text === 'Hola mundo' ? 'Hello world' : `[EN] ${i.text}` })) };
      },
    });
  });
  const calls = () => app.evaluate(() => global.__trCalls.length);
  const open = (url) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => t.webContents.once('did-finish-load', r));
    return t.id;
  }, url);
  const stateOf = (id) => app.evaluate((_e, i) => global.__translate.api.stateOf(global.__translate.tab(i)), id);
  const inTab = (id, js) => app.evaluate((_e, [i, code]) => global.__translate.tab(i).view.webContents.executeJavaScript(code), [id, js]);
  const text = (id, sel) => inTab(id, `document.querySelector(${JSON.stringify(sel)}).textContent`);
  const barClick = (label) => ui.evaluate((l) => { const b = [...document.querySelectorAll('#translate-bar button')].find((x) => x.textContent === l); if (b) b.click(); return Boolean(b); }, label);
  const barText = () => ui.$eval('#translate-bar', (el) => (el.hidden ? '' : el.textContent));
  const settingsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')); } catch { return {}; } };

  // ---- the offer: local detection only, nothing sent ----
  const en = await open(`${base}/en`);
  await sleep(700);
  check('an English page gets no translate button or bar', (await stateOf(en))?.phase !== 'offer' && (await ui.$eval('#translate-btn', (b) => b.hidden)) === true, JSON.stringify(await stateOf(en)));

  const es = await open(`${base}/es`);
  const offered = await waitFor(async () => (await stateOf(es))?.phase === 'offer' && (await stateOf(es))?.lang === 'es');
  check('a Spanish page is detected and offered', Boolean(offered), JSON.stringify(await stateOf(es)));
  const btnShown = await waitFor(() => ui.$eval('#translate-btn', (b) => !b.hidden));
  check('the translate button shows in the address bar', btnShown === true, btnShown);
  const offerText = await waitFor(async () => (await barText()).includes('Spanish') && (await barText()));
  check('the infobar names the page language and offers Translate, Not now, Never for this site', /Spanish.*Translate to English/.test(offerText) && /Translate.*Not now.*Never for this site/.test(offerText), offerText);
  check('offering sent nothing to any AI', (await calls()) === 0, await calls());
  const labels = await app.evaluate((_e, i) => global.__translate.api.menuItems(global.__translate.tab(i)).map((m) => m.label).filter(Boolean), es);
  check('the page menu offers Translate to English and Translate to…', labels.includes('Translate to English') && labels.includes('Translate to…'), labels.join(' | '));
  const pageItem = await app.evaluate((_e, i) => global.__translate.api.pageMenuItem(global.__translate.tab(i)).map((m) => m.label), es);
  check('the page menu item is "Translate Page…"', pageItem.join() === 'Translate Page…', pageItem.join());

  // ---- the consent card gates the first send ----
  await barClick('Translate');
  const consent = await waitFor(async () => (await stateOf(es))?.phase === 'consent');
  check('the first click asks for consent instead of sending', Boolean(consent), JSON.stringify(await stateOf(es)));
  const consentText = await waitFor(async () => (await barText()).includes('FakeAI') && (await barText()));
  check('the consent card names the provider', /Sends this page.s text to FakeAI/.test(consentText) && /Allow and translate/.test(consentText), consentText);
  await sleep(400);
  check('nothing was sent while the consent card is up', (await calls()) === 0 && (await text(es, '#h')) === 'Hola mundo', `${await calls()} ${await text(es, '#h')}`);
  await barClick('Cancel');
  await sleep(300);
  check('Cancel sends nothing and remembers no consent', (await calls()) === 0 && !(settingsFile().translateConsent || []).length, JSON.stringify(settingsFile().translateConsent));

  await app.evaluate((_e, i) => global.__translate.api.act(global.__translate.tab(i), 'translate'), es);
  await waitFor(async () => (await barText()).includes('Allow and translate'));
  await barClick('Allow and translate');
  const done = await waitFor(async () => (await stateOf(es))?.phase === 'done');
  check('after consent the page is translated', Boolean(done), JSON.stringify(await stateOf(es)));
  check('the consent is remembered in settings', (settingsFile().translateConsent || []).includes('test:fake'), JSON.stringify(settingsFile().translateConsent));

  // ---- what got translated ----
  check('a text node is replaced in place', (await text(es, '#h')) === 'Hello world' && (await text(es, '#p')).startsWith('[EN] Esta es una página'), `${await text(es, '#h')} / ${await text(es, '#p')}`);
  check('the link keeps its element and href while its text is translated', (await inTab(es, "document.querySelector('#link').getAttribute('href')")) === '/otra' && (await text(es, '#link')).startsWith('[EN] nuestra tienda'), await text(es, '#link'));
  check('the document title is translated', (await inTab(es, 'document.title')).startsWith('[EN] Página'), await inTab(es, 'document.title'));
  check('code, pre, translate="no", notranslate, editable and textarea text are untouched',
    (await text(es, '#pre')) === 'const saludo = "hola";' && (await text(es, '#c')) === 'función()' && (await text(es, '#no')) === 'Marca Registrada' && (await text(es, '#nt')) === 'No traducir esto'
    && (await text(es, '#ed')) === 'Texto editable del usuario' && (await inTab(es, "document.querySelector('#ta').value")) === 'Borrador de mensaje', await inTab(es, 'document.body.innerText'));
  const sentText = await app.evaluate(() => global.__trCalls.map((c) => c.user).join(' '));
  check('untouched text never left the page', !/saludo|función|Marca Registrada|No traducir|editable|Borrador/.test(sentText), sentText);
  const sys = await app.evaluate(() => global.__trCalls[0].system);
  check('the prompt treats the page as untrusted data', /untrusted DATA/.test(sys) && /never instructions/.test(sys), sys);
  check('the infobar shows the result with Show original', /Translated to English/.test(await barText()) && /Show original/.test(await barText()), await barText());

  // ---- content added later ----
  const before = await calls();
  await inTab(es, "document.querySelector('#add').click()");
  const late = await waitFor(async () => (await text(es, '#late')).startsWith('[EN] Texto nuevo'));
  check('text added to the page later is translated', Boolean(late), await text(es, '#late'));
  const afterLate = await calls();
  check('only the new text was sent for it', afterLate === before + 1 && !(await app.evaluate(() => global.__trCalls[global.__trCalls.length - 1].user)).includes('Hola'), `${before} -> ${afterLate}`);

  // ---- Show original ----
  await barClick('Show original');
  const restored = await waitFor(async () => (await text(es, '#h')) === 'Hola mundo' && (await text(es, '#late')) === 'Texto nuevo añadido después');
  check('Show original restores every text node', Boolean(restored), `${await text(es, '#h')} / ${await text(es, '#late')}`);
  check('Show original restores the title', (await inTab(es, 'document.title')) === 'Página de prueba', await inTab(es, 'document.title'));
  await inTab(es, "document.querySelector('#add').click()");
  await sleep(2200);
  check('after Show original, new text is left alone', (await inTab(es, "document.querySelectorAll('#late').length")) === 2 && (await inTab(es, "[...document.querySelectorAll('#late')].every((n) => n.textContent === 'Texto nuevo añadido después')")) === true, await inTab(es, 'document.body.innerText'));

  // ---- Translate again: consent already given, cache used ----
  const callsBefore = await calls();
  await app.evaluate((_e, i) => global.__translate.api.act(global.__translate.tab(i), 'translate'), es);
  const again = await waitFor(async () => (await stateOf(es))?.phase === 'done' && (await text(es, '#h')) === 'Hello world');
  check('translating again goes straight through (consent remembered)', Boolean(again), JSON.stringify(await stateOf(es)));
  const newCalls = await app.evaluate((_e, n) => global.__trCalls.slice(n).map((c) => c.user).join(' '), callsBefore);
  check('the second pass is served from the cache (only the title is asked again)', !newCalls.includes('Esta es una') && !newCalls.includes('nuestra tienda'), newCalls);
  await app.evaluate((_e, i) => global.__translate.api.act(global.__translate.tab(i), 'original'), es);
  await waitFor(async () => (await text(es, '#h')) === 'Hola mundo');

  // ---- Never for this site ----
  const es2 = await open(`${base}/es2`);
  await waitFor(async () => (await stateOf(es2))?.phase === 'offer');
  await barClick('Never for this site');
  const never = await waitFor(() => (settingsFile().translateNever || []).includes('127.0.0.1'));
  check('"Never for this site" remembers the host in settings', Boolean(never), JSON.stringify(settingsFile().translateNever));
  await app.evaluate((_e, i) => global.__translate.tab(i).view.webContents.reload(), es2);
  await sleep(1500);
  check('the site is not offered again', (await stateOf(es2))?.phase !== 'offer', JSON.stringify(await stateOf(es2)));

  // ---- refusals ----
  const callsRefuse = await calls();
  const firstTab = await app.evaluate(() => global.__tabsArray()[0].id);
  const newtab = await app.evaluate((_e, i) => ({ items: global.__translate.api.menuItems(global.__translate.tab(i)).length, start: global.__translate.api.start(global.__translate.tab(i)) }), firstTab);
  check('a lumen page (the new tab page) has no translate menu and refuses to start', newtab.items === 0 && newtab.start.ok === false && newtab.start.reason === 'unsupported', JSON.stringify(newtab));
  const priv = await app.evaluate(async ({ BrowserWindow, session }, url) => {
    const w = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition('translate-private-test'), sandbox: true } });
    await w.loadURL(url);
    const tab = { view: { webContents: w.webContents } };
    const api = global.__translate.api;
    const menu = api.menuItems(tab).length;
    const plain = api.start(tab, { explicit: false });
    const clicked = api.start(tab); // an explicit click: asks again, never remembered
    const state = api.stateOf(tab);
    api.act(tab, 'allow'); // even "allowing" must not have stored anything
    w.destroy();
    return { menu, plain, clicked, phase: state?.phase };
  }, `${base}/es`);
  check('a private (in-memory) session has no translate menu and refuses an unclicked start', priv.menu === 0 && priv.plain.ok === false && priv.plain.reason === 'private', JSON.stringify(priv));
  check('a click in a private session asks for consent every time', priv.clicked.ok === true && priv.clicked.pending === 'consent' && priv.phase === 'consent', JSON.stringify(priv));
  check('nothing was sent for the refused pages or private window', (await calls()) === callsRefuse, `${callsRefuse} -> ${await calls()}`);
  check('private consent is not stored', !(settingsFile().translateConsent || []).some((p) => p !== 'test:fake'), JSON.stringify(settingsFile().translateConsent));

  // ---- fallback: no AI connected ----
  await app.evaluate(() => global.__translate.api.setTestEngine(false));
  const noAi = await app.evaluate((_e, i) => ({ items: global.__translate.api.menuItems(global.__translate.tab(i)), google: global.__translate.api.google(global.__translate.tab(i)) }), es);
  check('with no AI and a local page, the item explains instead of offering', noAi.items.length === 1 && noAi.items[0].enabled === false && /connect an AI/i.test(noAi.items[0].label) && noAi.google === false, JSON.stringify(noAi));
  const started = await app.evaluate((_e, i) => global.__translate.api.start(global.__translate.tab(i)), es);
  check('starting with no AI reports it and sends nothing', started.ok === false && started.reason === 'no-engine' && (await calls()) === callsRefuse, JSON.stringify(started));
  const gurl = await app.evaluate(() => global.__translate.api.googleUrl('https://ejemplo.es/a?x=1&y=2', 'en'));
  check('the Google Translate address carries the page and target', gurl === 'https://translate.google.com/translate?sl=auto&tl=en&u=https%3A%2F%2Fejemplo.es%2Fa%3Fx%3D1%26y%3D2', gurl);

  check('no errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
