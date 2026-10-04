// Exercises every agent tool against a local fixture page served over HTTP (no API calls).
const { _electron: electron } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/static') return res.end('<title>Static</title><p>Nothing moves here.</p>');
    // A page that never goes quiet (a ticker): the wait after loading must stop at its cap.
    if (req.url === '/busy') return res.end('<title>Busy</title><p id=t>0</p><script>let n=0;setInterval(()=>{document.getElementById("t").textContent=++n},20)</script>');
    res.end(fs.readFileSync(path.join(__dirname, 'fixture.html')));
  }).listen(0);
  const fixture = `http://127.0.0.1:${server.address().port}/`;

  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
    try { const r = await global.__agent.execute(n, i); return typeof r === 'string' ? r : JSON.stringify(r).slice(0, 200); }
    catch (err) { return 'ERROR: ' + err.message; }
  }, [name, input]);
  const title = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getTitle());
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  let r = await run('navigate', { url: fixture });
  check('navigate over http', r.includes('Fixture'), r);
  const page = await run('read_page', { elements: true });
  const elements = JSON.parse(page.split('\n')[1]).elements;
  const id = (label) => elements.find((e) => e.label === label)?.id;
  check('<label for> names input', id('Full name'), JSON.stringify(elements));
  check('wrapping <label> names select', elements.some((e) => e.tag === 'select' && e.label.startsWith('Color')), JSON.stringify(elements));
  check('finds iframe button', id('Frame button'), JSON.stringify(elements));
  check('finds shadow DOM button', id('Shadow button'), JSON.stringify(elements));

  await run('type_text', { element_id: id('Full name'), text: 'Ada' });
  r = await run('type_text', { element_id: elements.find((e) => e.tag === 'select').id, text: 'blue' });
  check('select option', r.includes('Blue'), r);
  r = await run('type_text', { element_id: elements.find((e) => e.kind === 'date').id, text: '2026-03-14' });
  check('date input value set', r.includes('2026-03-14'), r);
  await run('click', { element_id: id('Submit') });
  await run('click', { element_id: id('Shadow button') });
  const after = await run('read_page', {});
  check('click submits typed values', after.includes('clicked:Ada:Blue:2026-03-14'), after.slice(-400));
  check('shadow DOM click', after.includes('shadow-clicked'), after.slice(-400));
  await run('click', { element_id: id('Frame button') });
  check('iframe click', (await title()) === 'iframe-clicked', await title());

  r = await run('scroll', { direction: 'down', screens: 2 });
  check('scroll', r.includes('window'), r);
  r = await run('type_text', { element_id: id('search box'), text: 'hello', press_enter: true });
  check('type + Enter submits', (await title()) === 'submitted', await title());
  r = await run('navigate', { url: 'file:///C:/Windows/win.ini' });
  check('blocks file:// for Claude', r.startsWith('ERROR'), r);
  r = await run('open_tab', { url: 'example.com' });
  check('open_tab', r.includes('example.com'), r);
  r = await run('switch_tab', { tab_id: 1 });
  check('switch_tab', r.includes('tab 1'), r);
  r = await run('click', { element_id: 9999 });
  check('bad id error', r.includes('No element with id 9999'), r);

  // New control tools.
  await run('navigate', { url: fixture });
  let els = JSON.parse((await run('read_page', { elements: true })).split(String.fromCharCode(10))[1]).elements;
  await run('hover', { element_id: els.find((e) => e.label === 'Hover me').id });
  check('hover', (await title()) === 'hovered', await title());
  await run('type_text', { element_id: els.find((e) => e.label === 'Full name').id, text: 'Grace' });
  await run('press_key', { key: 'a', modifiers: ['control'] });
  await run('press_key', { key: 'Delete' });
  await run('press_key', { key: 'Z', modifiers: ['shift'] });
  const nameValue = await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.getElementById('name').value"));
  check('press_key combos (Ctrl+A, Delete, Shift+Z)', nameValue === 'Z', JSON.stringify(nameValue));
  await run('screenshot', {});
  const pt = await app.evaluate(async () => {
    const wc = global.__agent.browser.activeTab().webContents;
    const r = await wc.executeJavaScript("(() => { const c = document.getElementById('cv'); c.scrollIntoView({block:'center'}); const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()");
    await global.__agent.execute('screenshot', {});
    const ratio = global.__agent.screenshotScale.ratio;
    return { x: r.x * wc.getZoomFactor() / ratio, y: r.y * wc.getZoomFactor() / ratio };
  });
  await run('click_at', pt);
  const canvasOut = await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.getElementById('out').textContent"));
  check('click_at on canvas via screenshot coords', canvasOut.includes('canvas-clicked'), canvasOut);
  await run('navigate', { url: 'https://example.com' });
  await run('go_back', {});
  r = await run('go_forward', {});
  check('go_forward', r.includes('example.com'), r);
  r = await run('reload', {});
  check('reload', r.includes('example.com'), r);
  await run('open_tab', { url: 'example.com' });
  const newest = JSON.parse(await run('list_tabs', {})).pop().id;
  r = await run('close_tab', { tab_id: newest });
  check('close_tab', !JSON.parse(await run('list_tabs', {})).some((x) => x.id === newest), r);

  // High-level tools.
  await run('navigate', { url: fixture });
  r = await run('fill_form', { fields: [
    { label: 'Full name', value: 'Ada Lovelace' }, { label: 'Color', value: 'Green' }, { label: 'Date', value: '2026-05-01' },
    { label: 'Newsletter', value: 'true' }, { label: 'Size', value: 'Large' },
  ] });
  check('fill_form reports every field', !r.includes('FAILED') && r.split(String.fromCharCode(10)).length === 5, r);
  r = await run('run_script', { code: "return { name: document.getElementById('name').value, color: document.getElementById('color').value, when: document.getElementById('when').value, news: document.getElementById('news').checked, size: document.querySelector('input[name=size]:checked')?.value }" });
  check('fill_form set all values (run_script readback)', r.includes('"name":"Ada Lovelace"') && r.includes('"color":"Green"') && r.includes('"when":"2026-05-01"') && r.includes('"news":true') && r.includes('"size":"l"'), r);
  r = await run('click', { text: 'Submit' });
  r = await run('wait_for', { text: 'clicked:Ada Lovelace', seconds: 5 });
  check('click by text + wait_for', r.startsWith('Found'), r);
  r = await run('run_script', { code: 'throw new Error("boom")' });
  check('run_script surfaces errors', r.includes('boom'), r);
  r = await run('wait_for', { text: 'never-appears-xyz', seconds: 1 });
  check('wait_for times out', r.startsWith('ERROR'), r);
  const setPref = (k, v) => app.evaluate((_e, [key, value]) => global.__settings.backend.set(key, value).then(() => 'ok', (err) => `ERROR ${err.message}`), [k, v]);
  const listTabs = async () => JSON.parse(await run('list_tabs', {}));
  const activeBefore = (await listTabs()).find((t) => t.active)?.id;
  await setPref('researchTabs', false);
  const tabsBefore = (await listTabs()).length;
  r = await app.evaluate(async (_e, url) => global.__agent.execute('read_urls', { urls: [url, 'https://example.com'] }), fixture);
  const tabsAfter = (await listTabs()).length;
  check('read_urls reads pages in parallel; with research tabs off, no new tabs', r.includes('Test form') && r.includes('Example Domain') && tabsBefore === tabsAfter, r.slice(0, 300));
  await setPref('researchTabs', true);
  r = await app.evaluate(async (_e, url) => global.__agent.execute('read_urls', { urls: [url] }), fixture);
  const withResearch = await listTabs();
  check('read_urls with research tabs on: the page opens in a background tab, the tab in front stays active', r.includes('Test form') && withResearch.length === tabsAfter + 1 && withResearch.find((t) => t.active)?.id === activeBefore, JSON.stringify(withResearch.map((t) => [t.id, t.active, t.url])));
  for (const t of withResearch.slice(tabsAfter)) await run('close_tab', { tab_id: t.id }).catch(() => {});
  const { validateInput } = require('../src/ai/agent.js');
  check('validator accepts modifiers array', validateInput('press_key', { key: 'a', modifiers: ['control'] }) === null, validateInput('press_key', { key: 'a', modifiers: ['control'] }));
  check('validator rejects bad modifier', validateInput('press_key', { key: 'a', modifiers: ['hyper'] }) !== null, 'accepted');
  check('validator requires element_id or text', validateInput('click', {}) !== null && validateInput('click', { text: 'Go' }) === null, validateInput('click', {}));
  check('validator checks fill_form items', validateInput('fill_form', { fields: [{ label: 'x' }] }) !== null, 'accepted');

  // Back must not get stuck on an error page.
  await run('navigate', { url: 'https://example.com' });
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.loadURL('http://no-such-host.invalid/').catch(() => {}));
  await new Promise((res) => setTimeout(res, 2500));
  r = await run('go_back', {});
  check('Back from error page reaches previous site', r.includes('example.com'), r);

  // Zoomed page: clicks must still land.
  await run('navigate', { url: fixture });
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.setZoomLevel(2));
  const zp = JSON.parse((await run('read_page', { elements: true })).split('\n')[1]).elements;
  await run('click', { element_id: zp.find((e) => e.label === 'Submit').id });
  const zafter = await run('read_page', {});
  check('click lands on zoomed page', zafter.includes('clicked:'), zafter.slice(-300));

  // Navigate returns promptly on a static page, and still waits (up to its cap) on one that keeps mutating.
  await run('navigate', { url: fixture }); // (warm)
  const timed = async (url) => { const t = Date.now(); const out = await run('navigate', { url }); return { ms: Date.now() - t, out }; };
  const quick = Math.min(...[await timed(`${fixture}static`), await timed(`${fixture}static`), await timed(`${fixture}static`)].map((x) => x.ms));
  check('navigate on a static page returns promptly (no fixed sleeps)', quick < 350, `${quick} ms`);
  const busy = await timed(`${fixture}busy`);
  check('navigate on a page that keeps mutating waits for it, up to the cap', busy.ms > 250 && busy.ms < 2500 && busy.out.includes('Busy'), `${busy.ms} ms ${String(busy.out).slice(0, 100)}`);

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
