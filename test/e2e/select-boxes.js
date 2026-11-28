// [select boxes] The AI chooses an option in every common kind of dropdown, by its visible text, in one call (src/ai/select-boxes.js):
//  1. fill_form with a field's label and the option: native <select>s (one in a scrolled box, one far down the page, one in an iframe),
//     a Headless UI listbox button, an MUI select (opens on mousedown, a portal, a virtualized list of 300 rows), React-Select (filters as
//     you type), Select2 (a hidden <select> behind it, its own search field), options that load after opening, options that load after
//     typing, a listbox in an iframe; each field then shows the option, and the page saw the choice;
//  2. a value that is not there fails with an error naming the options; a free-text field with suggestions keeps what was typed;
//  3. click: on a native <select> it is not opened (a system popup) and the options are named; click by an option's text sets a native
//     select, and picks an option further down an open custom list (scrolled to); scroll with a list open scrolls the list;
//  4. a run with a fake model (no network): its fill_form tool_use fills three custom boxes and the tool result says what was chosen;
//  5. the AI's cursor moves to the box it picks in (agent cursors).
// Local pages, no network. Temp profile, hidden window. Run alone: LUMEN_TEST_BACKGROUND=1 node test/e2e/select-boxes.js
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'select-boxes');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(path.join(FIXTURES, req.url.startsWith('/frame') ? 'frame.html' : 'index.html'))); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-select-boxes-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const load = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const ok = await app.evaluate(async (_e, u) => {
          global.__agent.browser.autoApprove = () => true;
          const wc = global.__agent.browser.activeTab().webContents;
          for (let i = 0; i < 100 && wc.isLoading(); i++) await new Promise((r) => setTimeout(r, 50));
          try { await wc.loadURL(u); return true; } catch { return false; }
        }, base);
        if (ok) break;
      }
      await waitFor(() => page('Boolean(document.getElementById("frame").contentDocument?.getElementById("meal"))'));
    };
    const page = (js) => app.evaluate(async (_e, code) => global.__agent.browser.activeTab().webContents.executeJavaScript(code), js);
    const frame = (js) => page(`document.getElementById('frame').contentWindow.eval(${JSON.stringify(js)})`);
    const tool = (name, input) => app.evaluate(async (_e, a) => {
      const agent = global.__agent;
      const signal = new AbortController().signal;
      const m = []; m.settings = { model: 'claude-opus-5' };
      const id = agent.browser.activeTab().id;
      try {
        const out = await agent.inTask(id, signal, () => agent.execute(a.name, a.input), m, null, { chatId: global.__chats.id(), hosts: new Set(['127.0.0.1']) });
        return { ok: true, out: typeof out === 'string' ? out : JSON.stringify(out) };
      } catch (e) { return { ok: false, error: e.message }; }
    }, { name, input });
    const shown = (sel) => page(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
    await load();

    // ---- 1. fill_form, one call, every kind
    const started = Date.now();
    let r = await tool('fill_form', { fields: [
      { label: 'Favorite color', value: 'Green' },
      { label: 'Shipping speed', value: 'Overnight' },
      { label: 'Year', value: '2026' },
      { label: 'Size', value: 'Large' },
      { label: 'Country', value: 'Uruguay' },
      { label: 'Fruit', value: 'Pear' },
      { label: 'City', value: 'San Francisco' },
      { label: 'Team', value: 'Cubs' },
      { label: 'Airport', value: 'Denver' },
      { label: 'Seat class', value: 'Business' },
      { label: 'Meal', value: 'Vegan' },
    ] });
    const took = Date.now() - started;
    check('(1) fill_form fills all eleven dropdowns in one call', r.ok && !/FAILED/.test(r.out), r.out || r.error);
    for (const [label, want] of [['Favorite color', 'Green'], ['Shipping speed', 'Overnight'], ['Year', '2026'], ['Size', 'Large'], ['Country', 'Uruguay'], ['Fruit', 'Pear'], ['City', 'San Francisco'], ['Team', 'Cubs'], ['Airport', 'Denver (DEN)'], ['Seat class', 'Business'], ['Meal', 'Vegan']]) {
      check(`(1) the result says ${label}: chose "${want}"`, String(r.out).includes(`${label}: chose "${want}"`), r.out || r.error);
    }
    const picked = await page('window.__picked.join(",")');
    check('(1) the page saw each choice (native change events, the widgets\' own clicks)', ['color=Green', 'speed=Overnight', 'year=2026', 'size=Large', 'country=Uruguay', 'fruit=Pear', 'city=San Francisco', 'team=Cubs', 'airport=Denver (DEN)'].every((p) => picked.split(',').includes(p)), picked);
    check('(1) the fields show the choices: the MUI box, React-Select\'s value, Select2\'s text and its hidden select', await shown('#country') === 'Uruguay' && await shown('#fruit-value') === 'Pear' && await shown('#city-rendered') === 'San Francisco' && await page('document.getElementById("city").value') === 'sf' && await shown('#team') === 'Cubs' && await page('document.getElementById("airport").value') === 'Denver (DEN)', JSON.stringify([await shown('#country'), await shown('#fruit-value'), await shown('#city-rendered')]));
    check('(1) the virtualized list: Uruguay, not "Uruguay River" (a closer match seen first)', !picked.includes('Uruguay River'), picked);
    check('(1) in the iframe: the native select and the listbox', await frame('window.__picked.join(",")') === 'seat=Business,meal=Vegan', await frame('window.__picked.join(",")'));
    check('(1) no list is left open', await page('document.querySelectorAll(".pop").length') === 0, await page('[...document.querySelectorAll(".pop")].map((p) => p.id).join(",")'));
    console.log(`      (eleven dropdowns took ${took} ms)`);

    // ---- 2. a value that is not there; a free-text field
    r = await tool('fill_form', { fields: [{ label: 'Fruit', value: 'Durian' }] });
    check('(2) a custom box without the value: an error that names the options', !r.ok && /no option matching "Durian"/.test(r.error) && /"Apple"/.test(r.error) && /"Strawberry"/.test(r.error), r.error || r.out);
    check('(2) …and the field still shows the earlier choice', await shown('#fruit-value') === 'Pear');
    r = await tool('fill_form', { fields: [{ label: 'Favorite color', value: 'Purple' }] });
    check('(2) a native select without the value: an error that names its options', !r.ok && /no option matching "Purple"\. Its options: "Choose…", "Red", "Green", "Blue"/.test(r.error), r.error || r.out);
    r = await tool('fill_form', { fields: [{ label: 'Country', value: 'Atlantis' }] });
    check('(2) the long list without the value: the error names its options, scrolled through (and how many more)', !r.ok && /no option matching "Atlantis"/.test(r.error) && /Place 001/.test(r.error) && /more/.test(r.error), r.error || r.out);
    check('(2) …and the list was closed', await page('document.querySelectorAll(".pop").length') === 0);
    r = await tool('fill_form', { fields: [{ label: 'Street address', value: '12 Main St' }] });
    check('(2) a free-text field with suggestions keeps what was typed (no error)', r.ok && /typed "12 Main St"/.test(r.out) && await page('document.getElementById("street").value') === '12 Main St', r.out || r.error);

    // ---- 3. click
    r = await tool('read_page', { mode: 'compact' });
    const idOf = (out, re) => { const m = new RegExp(`\\[(\\d+)\\][^\\n]*${re}`).exec(String(out)); return m ? Number(m[1]) : null; };
    const colorId = idOf(r.out, 'Favorite color');
    r = await tool('click', { element_id: colorId });
    check('(3) click on a native select: not opened, its options named', r.ok && /is a dropdown \(<select>\) showing "Green"/.test(r.out) && /"Red", "Green", "Blue"/.test(r.out), r.out || r.error);
    r = await tool('click', { text: 'Express' });
    check('(3) click by an option\'s text sets the native select it is in', r.ok && /Chose "Express"/.test(r.out) && await page('document.getElementById("speed").value') === 'Express', r.out || r.error);
    const countryId = idOf((await tool('read_page', { mode: 'compact' })).out, 'Country');
    r = await tool('click', { element_id: countryId });
    check('(3) click opens the MUI box', r.ok && await page('document.getElementById("country").getAttribute("aria-expanded")') === 'true', r.out || r.error);
    r = await tool('scroll', { direction: 'down' });
    check('(3) scroll with the list open scrolls the list, not the page', r.ok && /"scrolled":"list"/.test(r.out) && await page('document.getElementById("country-list").scrollTop') > 0, r.out || r.error);
    r = await tool('click', { text: 'Place 290' });
    check('(3) click by the text of an option further down the open list: scrolled to and clicked', r.ok && /Clicked the option "Place 290"/.test(r.out) && await shown('#country') === 'Place 290', r.out || r.error);

    // ---- 5. the AI's cursor went to the box it picked in
    await tool('fill_form', { fields: [{ label: 'Size', value: 'Small' }] });
    await sleep(300);
    const cursor = await page(`(() => { const h = document.getElementById('__lumen-agent-cursors'); const c = h && h.shadowRoot && h.shadowRoot.querySelector('.c'); return c ? { t: c.style.transform, label: c.querySelector('span').textContent } : null; })()`);
    check('(5) the AI\'s cursor is on the page while it picks', cursor && /Lumen/.test(cursor.label) && /translate/.test(cursor.t), JSON.stringify(cursor));

    // ---- 4. a fake model's fill_form
    await load();
    await app.evaluate(() => {
      const fake = global.__fake = { results: [] };
      const textOf = (c) => (Array.isArray(c) ? c.map((b) => b.text || '').join('\n') : String(c ?? ''));
      const reply = (content, stop) => {
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, usage: { input_tokens: 50, output_tokens: 10 } };
        return { async *[Symbol.asyncIterator]() { for (const [index, b] of content.entries()) if (b.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }; }, finalMessage: async () => message };
      };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const msgs = params.messages || [];
        const last = msgs[msgs.length - 1];
        const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
        if (results.length) { fake.results.push({ text: results.map((x) => textOf(x.content)).join('\n'), error: results.some((x) => x.is_error) }); return reply([{ type: 'text', text: 'Done.' }], 'end_turn'); }
        return reply([{ type: 'tool_use', id: `t-${Date.now()}`, name: 'fill_form', input: { fields: [{ label: 'Country', value: 'canada' }, { label: 'Fruit', value: 'banana' }, { label: 'City', value: 'Seattle' }] } }], 'tool_use');
      } } } });
    });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#prompt', { state: 'visible' });
    await ui.fill('#prompt', 'Pick Canada, banana and Seattle on this form');
    await ui.press('#prompt', 'Enter');
    const result = await waitFor(() => app.evaluate(() => global.__fake.results[0] || null), 45000);
    check('(4) the fake model\'s fill_form result says what was chosen in each box', result && !result.error && /Country: chose "Canada"/.test(result.text) && /Fruit: chose "Banana"/.test(result.text) && /City: chose "Seattle"/.test(result.text), JSON.stringify(result));
    check('(4) and the page shows them', await shown('#country') === 'Canada' && await shown('#fruit-value') === 'Banana' && await shown('#city-rendered') === 'Seattle', JSON.stringify([await shown('#country'), await shown('#fruit-value'), await shown('#city-rendered')]));
  } catch (e) {
    failures++;
    console.log(`FAIL  threw: ${e.stack || e}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
