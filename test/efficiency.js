// Token-efficient tools: compact read_page with refs, since_last diffs, find, batch, cheaper
// screenshots, and token budgets on real pages (needs internet for the last part).
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');

const FIXTURE = `<!doctype html><title>Shop</title>
<nav aria-label="Main"><a href="/a">Home</a> <a href="/b">Deals</a></nav>
<main><h1>Checkout</h1><p>Items ship in <b>2 days</b>. Questions? <a href="/help">Contact us</a>.</p>
<table><tr><th>Born</th><td>23 June 1912</td></tr></table>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'ordered:' + document.getElementById('cust').value + ':' + document.getElementById('size').value + ':' + document.getElementById('gift').checked">
<label>Name <input id="cust"></label>
<label>Size <select id="size"><option>Small</option><option>Large</option></select></label>
<label><input type="checkbox" id="gift"> Gift wrap</label>
<button>Place order</button></form><p id="out"></p>
<button onclick="this.insertAdjacentHTML('afterend', '<p>Coupon SAVE10 applied</p>')">Apply coupon</button>
</main>`;

(async () => {
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(FIXTURE); }).listen(0);
  const site = `http://127.0.0.1:${server.address().port}/`;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
    try {
      const r = await global.__agent.execute(n, i);
      return typeof r === 'string' ? r : JSON.stringify(r.map((b) => (b.type === 'image' ? { image: b.source.data.length } : b)));
    } catch (err) { return `ERROR: ${err.message}`; }
  }, [name, input]);
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const ref = (text, re) => Number((re.exec(text) || [])[1]);

  // Tool lists: the new tools reach every provider and MCP.
  const names = await app.evaluate(() => process.mainModule.require('./ai/agent').EXTERNAL_TOOLS.map((t) => t.name));
  check('find and batch are exposed to MCP / other providers', names.includes('find') && names.includes('batch'), names.join(','));

  await run('navigate', { url: site });
  const compact = await run('read_page', { mode: 'compact' });
  check('compact: headings, landmarks, inline links', compact.includes('# Checkout') && compact.includes('[nav: Main]') && /\[\d+\]Contact us/.test(compact), compact);
  check('compact: controls with refs', /\[\d+\] textbox "Name"/.test(compact) && /\[\d+\] select "Size" = "Small"/.test(compact) && /\[\d+\] checkbox "Gift wrap"/.test(compact), compact);
  const full = await run('read_page', {});
  check('full mode unchanged (JSON + PAGE TEXT)', JSON.parse(full.split('\n')[1]).elements.length > 5 && full.includes('PAGE TEXT:'), full.slice(0, 200));
  check('compact is much smaller than full', compact.length * 2 < full.length, `${compact.length} vs ${full.length}`);

  // batch: fill and submit with refs from the compact outline, one call, diff included.
  const out = await run('batch', { steps: [
    { do: 'type', ref: ref(compact, /\[(\d+)\] textbox "Name"/), text: 'Ada' },
    { do: 'select', ref: ref(compact, /\[(\d+)\] select "Size"/), text: 'Large' },
    { do: 'click', ref: ref(compact, /\[(\d+)\] checkbox "Gift wrap"/) },
    { do: 'click', text: 'Place order' },
  ] });
  check('batch runs every step and returns the diff', out.includes('ordered:Ada:Large:true') && out.includes('4.') && out.includes('Changes since your last read'), out);
  const failed = await run('batch', { steps: [{ do: 'click', ref: 9999 }, { do: 'click', text: 'Apply coupon' }] });
  check('batch stops at the first failure', failed.includes('FAILED') && failed.includes('Stopped at step 1') && !failed.includes('SAVE10'), failed);

  // since_last: only the change.
  await run('read_page', { mode: 'compact' });
  await run('click', { text: 'Apply coupon' });
  const diff = await run('read_page', { mode: 'compact', since_last: true });
  check('since_last returns just the new line', diff.includes('Coupon SAVE10 applied') && !diff.includes('# Checkout'), diff);
  const same = await run('read_page', { mode: 'compact', since_last: true });
  check('since_last with no change', same.includes('No changes since your last read.'), same);

  // find: text snippets with values, word-start matching, controls by label.
  let found = await run('find', { query: 'born' });
  check('find widens a table header to its row', found.includes('Born 23 June 1912'), found);
  found = await run('find', { query: 'gift' });
  check('find returns controls as refs', /\[\d+\] input:checkbox "Gift wrap"/.test(found), found);
  found = await run('find', { query: 'nothing-like-this' });
  check('find with no match', found.startsWith('No matches'), found);

  // Screenshots: smaller by default, region crop.
  const shot = JSON.parse(await run('screenshot', {}));
  check('screenshot defaults to 1024 px', shot[1].text.includes('1024x'), shot[1].text);
  const crop = JSON.parse(await run('screenshot', { region: { x: 0, y: 0, width: 200, height: 100 } }));
  check('screenshot region crop is small', crop[0].image < shot[0].image / 2 && crop[1].text.includes('Region'), `${crop[0].image} vs ${shot[0].image}`);
  const bad = await run('screenshot', { region: { x: 0 } });
  check('invalid region is rejected by validation', await app.evaluate((_e, input) => process.mainModule.require('./ai/agent').validateInput('screenshot', input), { region: { x: 0 } }) !== null, bad);

  // Token budgets on real pages.
  const BUDGET = 6500; // chars (~1.6k tokens) for the whole Alan Turing outline, vs ~50k for full
  await run('navigate', { url: 'https://en.wikipedia.org/wiki/Alan_Turing' });
  const turing = await run('read_page', { mode: 'compact' });
  check(`Wikipedia Alan Turing compact outline < ${BUDGET} chars`, turing.length < BUDGET && turing.includes('Alan Turing'), turing.length);
  const born = await run('find', { query: 'Born', max: 3 });
  check('Wikipedia: find gets the birth date in < 1000 chars', born.includes('23 June 1912') && born.length < 1000, born);
  await run('navigate', { url: 'https://httpbin.org/forms/post' });
  const form = await run('read_page', { mode: 'compact' });
  const r = (label) => ref(form, new RegExp(`\\[(\\d+)\\] [a-z]+ "${label}`, 'i'));
  const posted = await run('batch', { steps: [
    { do: 'type', ref: r('Customer name'), text: 'Ada' }, { do: 'type', ref: r('Telephone'), text: '555' },
    { do: 'type', ref: r('E-mail'), text: 'a@b.co' }, { do: 'click', ref: r('Large') }, { do: 'click', ref: r('Onion') },
    { do: 'click', ref: r('Submit order') },
  ] });
  check('httpbin form completed from compact refs via one batch', posted.includes('"custname": "Ada"') && posted.includes('"size": "large"') && posted.includes('"topping": "onion"'), posted);
  check('httpbin compact outline < 1500 chars', form.length < 1500, form.length);

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
