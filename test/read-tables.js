// read_page extract:"tables" in real pages (src/ai/snapshot.js extractTables / formatTables; user report: "I couldn't read the zyBooks table for
// problem 2. The reader cuts long tables off, and I can't scroll or page through them"). Real app, hidden (LUMEN_TEST_BACKGROUND=1), temp profile,
// 127.0.0.1 only, local test pages only: a 400-row table, a div role="table", a table in a scroll container, a virtualized grid that draws a dozen
// rows at a time, a table in an open shadow root, a table in a same-origin frame, collapsed (<details>, display:none) tables. The page script runs in
// a hidden window's page; the tool path (snapshot.execute) runs with that page as its tab.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const snap = require('../src/ai/snapshot');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };

const row = (i) => `<tr><td>${i}</td><td>Item ${i}</td><td>${(i * 1.25).toFixed(2)}</td><td>${'note '.repeat(8)}${i}</td></tr>`;
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const PAGES = {
  '/long': `<h2>Problem 2</h2><p>Fill in the table.</p><table><caption>Problem 2 results</caption><thead><tr><th>N</th><th>Name</th><th>Value</th><th>Note</th></tr></thead><tbody>${range(400).map(row).join('')}</tbody></table>
    <h2>Problem 3</h2><table><tr><th>X</th><th>Y</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>`,
  '/div': `<h3>Scores</h3><div role="table" aria-label="Scores"><div role="rowgroup"><div role="row"><span role="columnheader">Player</span><span role="columnheader">Score</span></div></div>
    <div role="rowgroup">${range(60).map((i) => `<div role="row"><span role="cell">P${i}</span><span role="cell">${i * 10}</span></div>`).join('')}</div></div>`,
  '/scroll': `<div id="box" style="height:200px;overflow:auto;border:1px solid #000"><table><caption>Scrolling table</caption>${range(150).map(row).join('')}</table></div>`,
  // a virtualized grid: 300 rows declared, about 12 drawn at the scroll position (a spacer holds the height); scroll drives it
  '/virtual': `<div id="vp" style="height:240px;overflow:auto;position:relative"><div id="spacer" style="height:${300 * 30}px;position:relative"><div role="grid" aria-label="Virtual grid" aria-rowcount="301" id="g" style="position:absolute;left:0;right:0"></div></div></div>
    <script>
      const vp = document.getElementById('vp'), g = document.getElementById('g');
      const draw = () => { const first = Math.floor(vp.scrollTop / 30); g.style.top = first * 30 + 'px';
        let h = '<div role="row" aria-rowindex="1"><span role="columnheader">Id</span><span role="columnheader">Label</span></div>';
        for (let i = first; i < Math.min(300, first + 12); i++) h += '<div role="row" aria-rowindex="' + (i + 2) + '" style="height:30px"><span role="gridcell">' + (i + 1) + '</span><span role="gridcell">Label ' + (i + 1) + '</span></div>';
        g.innerHTML = h; };
      draw(); vp.addEventListener('scroll', draw); setInterval(draw, 30);
    </script>`,
  '/shadow': `<div id="host"></div><script>const r = document.getElementById('host').attachShadow({ mode: 'open' });
    r.innerHTML = '<h3>Shadow</h3><table><caption>In a shadow root</caption><tr><th>K</th><th>V</th></tr>' + Array.from({ length: 30 }, (_, i) => '<tr><td>k' + (i + 1) + '</td><td>v' + (i + 1) + '</td></tr>').join('') + '</table>';</script>`,
  '/frame': '<h3>Outer</h3><iframe src="/framed" style="width:400px;height:200px"></iframe>',
  '/framed': `<table><caption>In a frame</caption><tr><th>A</th><th>B</th></tr>${range(25).map((i) => `<tr><td>a${i}</td><td>b${i}</td></tr>`).join('')}</table>`,
  '/collapsed': `<details><summary>Show the answer table</summary><table><caption>Hidden answers</caption>${range(10).map((i) => `<tr><td>q${i}</td><td>a${i}</td></tr>`).join('')}</table></details>
    <div style="display:none"><table><caption>Display none</caption>${range(6).map((i) => `<tr><td>h${i}</td><td>x${i}</td></tr>`).join('')}</table></div>`,
  '/one': '<table><tr><td>layout only</td></tr></table><p>no data tables here</p>',
};

(async () => {
  const server = http.createServer((req, res) => {
    const page = PAGES[req.url.split('?')[0]];
    res.statusCode = page ? 200 : 404;
    res.setHeader('Content-Type', 'text/html');
    res.end(page ? `<!doctype html><meta charset="utf-8"><title>t</title><body>${page}</body>` : 'no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-read-tables-'));
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    await (await app.firstWindow()).waitForSelector('.tab');
    // a hidden window the pages load in, and a runner for page code in it (the page's own world, as the agent's isolated world sees the same DOM)
    await app.evaluate(async ({ BrowserWindow }) => {
      global.__rt = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { backgroundThrottling: false } });
    });
    const load = (p) => app.evaluate(async (_e, url) => { await global.__rt.loadURL(url); await new Promise((r) => setTimeout(r, 400)); }, base + p);
    const run = (code) => app.evaluate((_e, c) => global.__rt.webContents.executeJavaScript(c), code);
    const tool = async (page, input) => {
      await load(page);
      const wc = { id: 1, isDestroyed: () => false, getURL: () => base + page };
      return snap.execute({ requireTab: () => wc }, 'read_page', input, { scripts: {}, runScript: (w, code) => run(code) });
    };
    const rowsIn = (text) => text.split('\n').filter((l) => /^\| /.test(l) && !/^\| (---|N|X|Player|Id|K|A) /.test(l));

    // ---- the 400-row table (zyBooks-style): paged to the end through the tool, every row once
    let text = await tool('/long', { extract: 'tables' });
    check('a page of tables: the list names both, with the heading and caption', /\[1\] Problem 2 results: 400 rows x 4 columns/.test(text) && /\[2\] Problem 3: 2 rows x 2 columns/.test(text), text.slice(0, 400));
    let offset = 0; let got = []; let pages = 0;
    for (; pages < 30; pages++) {
      text = await tool('/long', { extract: 'tables', table: 'problem 2', text_offset: offset });
      got = got.concat(rowsIn(text).map((l) => l.split(' | ')[0].slice(2)));
      const next = /text_offset:(\d+) for the rest/.exec(text);
      if (!next) break;
      offset = Number(next[1]);
    }
    check('400 rows: paged by the message\'s offset, all 400 come back once, in order', got.length === 400 && got.every((v, i) => v === String(i + 1)) && pages >= 1, `${got.length} rows, ${pages + 1} pages`);
    check('400 rows: the last page says it is the end', /\[end of table 1: rows \d+-400 of 400\]/.test(text), text.slice(-200));
    text = await tool('/long', { extract: 'tables', table: '2' });
    check('table:2 is the small table, whole, by number', /Table \[2\] Problem 3 \(2 rows\)/.test(text) && rowsIn(text).length === 2, text);
    text = await tool('/long', { extract: 'tables', table: 'results' });
    check('table:"results" finds the table by its caption', /Table \[1\] Problem 2 results/.test(text));

    // ---- div role="table"
    text = await tool('/div', { extract: 'tables' });
    check('div role="table": 60 rows with the header row, labelled by aria-label', /Table \[1\] Scores \(60 rows\)/.test(text) && /\| Player \| Score \|/.test(text) && /\| P60 \| 600 \|/.test(text) && /\| P1 \| 10 \|/.test(text), text.slice(0, 500));

    // ---- a table in a scroll container: all rows (they are all in the DOM), the container's scroll put back
    text = await tool('/scroll', { extract: 'tables' });
    check('table in a scroll container: all 150 rows (a 200 px box shows a few)', /150 rows/.test(text) && /\| 150 \| Item 150 \|/.test(text), text.slice(0, 300));
    const top = await run("document.getElementById('box').scrollTop");
    check('...and the box is left where it was', top === 0, top);

    // ---- a virtualized grid: 12 rows drawn at a time, all 300 read by scrolling it; the scroll position is restored
    await load('/virtual');
    await run("document.getElementById('vp').scrollTop = 600; true");
    await new Promise((r) => setTimeout(r, 200));
    text = await tool('/virtual', { extract: 'tables' });
    check('virtualized grid: 300 rows from a grid that draws about 12 (found by stepping through its scroll container)', /Table \[1\] Virtual grid \(300 rows\) \(rows loaded by scrolling it\)/.test(text), text.slice(0, 400));
    const ids = rowsIn(text).map((l) => Number(l.split(' | ')[0].slice(2)));
    check('virtualized grid: rows 1..300 in order, each once', ids.length === 300 && ids.every((v, i) => v === i + 1), `${ids.length} rows: ${ids.slice(0, 5)}...${ids.slice(-3)}`);
    // (a fresh load resets the scroll; check that a read with the grid scrolled leaves it where it was)
    await run("document.getElementById('vp').scrollTop = 900; true");
    await new Promise((r) => setTimeout(r, 150));
    const rd = await run(`(${snap.extractTables.toString()})(${JSON.stringify({ selector: '' })}).then((r) => r.tables[0].rows.length)`);
    const after = await run("document.getElementById('vp').scrollTop");
    check('virtualized grid: read again from a scrolled position it still finds 300 rows and puts the scroll back', rd === 300 && after === 900, JSON.stringify({ rd, after }));

    // ---- shadow root and same-origin frame
    text = await tool('/shadow', { extract: 'tables' });
    check('table in an open shadow root: found, 30 rows, its caption', /Table \[1\] In a shadow root \(30 rows\)/.test(text) && /\| k30 \| v30 \|/.test(text), text.slice(0, 300));
    text = await tool('/frame', { extract: 'tables' });
    check('table in a same-origin frame: found, 25 rows', /Table \[1\] In a frame \(25 rows\)/.test(text) && /\| a25 \| b25 \|/.test(text), text.slice(0, 300));

    // ---- collapsed
    text = await tool('/collapsed', { extract: 'tables' });
    check('a closed <details> table and a display:none table are read, labelled collapsed or hidden', /\[1\] Hidden answers: 10 rows x 2 columns \(collapsed or hidden on the page\)/.test(text) && /\[2\] Display none: 6 rows x 2 columns \(collapsed or hidden/.test(text) && /\| q10 \| a10 \|/.test(text), text.slice(0, 500));

    // ---- selector, nothing found, bad selector
    text = await tool('/long', { extract: 'tables', selector: 'h2' });
    check('selector scopes the search (a heading holds no table)', /^<untrusted_page_content>\nNo tables found/.test(text), text.slice(0, 200));
    text = await tool('/long', { extract: 'tables', selector: '#nope' });
    check('a selector that matches nothing says so', /No element matches selector/.test(text), text);
    text = await tool('/one', { extract: 'tables' });
    check('a one-row layout table is not a data table: "No tables found" with where it looked', /No tables found on this page/.test(text), text);
  } catch (err) {
    check('suite ran', false, err.stack || err.message);
  } finally {
    await app.close().catch(() => {});
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
