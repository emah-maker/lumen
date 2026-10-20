// read_page extract:"tables" (src/ai/snapshot.js extractTables / formatTables): the AI can always get a whole table. The user report: "I couldn't
// read the zyBooks table for problem 2. The reader cuts long tables off, and I can't scroll or page through them."
// Plain Node: the paging, the cut messages, picking a table by number or caption, the tool wiring and the notes on a clipped full read.
// The page script itself runs in a real page in test/read-tables.js (Electron).
require('./_tmp-cleanup');
const snap = require('../src/ai/snapshot');
const scripts = require('../src/ai/page-scripts');
const reading = require('../src/ai/page-reading');
const { validateInput, EXTERNAL_TOOLS } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };

const rows = (n, w = 4) => Array.from({ length: n }, (_, i) => Array.from({ length: w }, (__, c) => (c === 0 ? `r${i + 1}c1` : `r${i + 1}c${c + 1}${'.'.repeat(25)}`)));
const table = (n, extra = {}) => ({ caption: '', heading: '', near: '', hidden: false, scrolled: false, header: ['A', 'B', 'C', 'D'], rows: rows(n), ...extra });
const result = (tables, cut = {}) => ({ url: 'https://x.test/', tables, cut: { cells: 0, rows: false, tables: false, ...cut } });
const bodyRows = (text) => text.split('\n').filter((l) => /^\| r\d+c1 \|/.test(l));

(async () => {
  // ---- a 400-row table, paged until the end: every row comes back exactly once, in order, and no cut is silent
  const long = result([table(400, { caption: 'Problem 2 results' })]);
  let offset = 0;
  let seen = [];
  let pages = 0;
  let silent = false;
  for (; pages < 50; pages++) {
    const text = snap.formatTables(long, { offset });
    const got = bodyRows(text);
    seen = seen.concat(got.map((l) => l.split(' | ')[0].slice(2)));
    const next = /text_offset:(\d+) for the rest/.exec(text);
    if (!text.includes('| A | B | C | D |')) silent = true; // the header is repeated on each page
    if (!next) { if (!/\[end of table 1: rows \d+-400 of 400\]/.test(text)) silent = true; break; }
    if (Number(next[1]) !== offset + got.length) silent = true; // the message says exactly where the next page starts
    offset = Number(next[1]);
  }
  check('400 rows: paging with the offset the cut message gives returns every row once, in order', seen.length === 400 && seen.every((r, i) => r === `r${i + 1}c1`), `${seen.length} rows in ${pages + 1} pages`);
  check('400 rows: it takes more than one page (the budget is real) and fewer than 20', pages >= 1 && pages < 20, pages);
  check('400 rows: every page repeats the header and ends with a message (more, or the end)', !silent);
  const first = snap.formatTables(long, {});
  check('a cut table names the call for the rest', /\[table 1: rows 1-\d+ of 400; call read_page extract:"tables" table:1 text_offset:\d+ for the rest\]/.test(first), first.slice(-300));
  check('a page is within the budget (about 20k characters)', first.length < 21000, first.length);
  check('text_offset past the end shows an end line, no rows', /\[end of table 1: rows 401-400 of 400\]/.test(snap.formatTables(long, { offset: 5000 })) || /end of table 1/.test(snap.formatTables(long, { offset: 5000 })));

  // ---- several tables: a list, the ones that fit whole, a cut one named, the rest listed by number
  const many = result([table(5, { caption: 'Small' }), table(300, { heading: 'Big one' }), table(3, { near: 'Problem 2 Fill in the table' }), table(4, { caption: 'Last' })]);
  const all = snap.formatTables(many, {});
  check('several tables: a numbered list first', /^Tables on the page:\n\[1\] Small: 5 rows x 4 columns\n\[2\] Big one: 300 rows x 4 columns\n\[3\] …Problem 2 Fill in the table: 3 rows/.test(all), all.slice(0, 300));
  check('several tables: the small one comes whole, the big one is cut with its exact call, the later ones are listed as not shown', /Table \[1\] Small:/.test(all) && /\[table 2: rows 1-\d+ of 300; call read_page extract:"tables" table:2 text_offset:\d+ for the rest\]/.test(all) && /Not shown, no room: \[3\] \[4\]; call read_page extract:"tables" table:N/.test(all), all.slice(-500));
  const byNumber = snap.formatTables(many, { table: 3 });
  check('table:3 (a number) is that table, whole, with the others listed', /Table \[3\] …Problem 2 Fill in the table \(3 rows\)/.test(byNumber) && bodyRows(byNumber).length === 3 && /Other tables:\n\[1\]/.test(byNumber), byNumber);
  const byWords = snap.formatTables(many, { table: 'problem 2' });
  check('table:"problem 2" matches the text above the table, case-insensitively', /Table \[3\]/.test(byWords) && bodyRows(byWords).length === 3, byWords);
  check('table:"big" matches a heading and pages with text_offset', /Table \[2\] Big one/.test(snap.formatTables(many, { table: 'big', offset: 100 })) && bodyRows(snap.formatTables(many, { table: 'big', offset: 100 }))[0].startsWith('| r101c1 |'));
  const none = snap.formatTables(many, { table: 'nothing here' });
  check('a table that matches nothing says so and lists the tables', /No table matches "nothing here"\. Tables on the page:\n\[1\]/.test(none), none);
  check('table:9 (no such number) says so and lists the tables', /No table matches "9"/.test(snap.formatTables(many, { table: '9' })));
  check('two tables match one word: the first is shown and the other named', /Also matching: \[2\]/.test(snap.formatTables(result([table(2, { caption: 'Prices A' }), table(2, { caption: 'Prices B' })]), { table: 'prices' })));
  check('a lone table is shown whole with no list', !/Tables on the page/.test(snap.formatTables(result([table(3)]), {})) && bodyRows(snap.formatTables(result([table(3)]), {})).length === 3);

  // ---- flags and notes
  const flagged = snap.formatTables(result([table(3, { hidden: true, scrolled: true, caption: 'Grid' })], { cells: 2, rows: true, tables: true }), {});
  check('collapsed / scrolled tables are labelled; cut cells, rows and tables are all said', /\(collapsed or hidden on the page\)/.test(flagged) && /rows loaded by scrolling it/.test(flagged) && /2 cells held more than 300 characters/.test(flagged) && /up to 5000 rows each/.test(flagged) && /first 40 tables/.test(flagged), flagged);
  check('a pipe inside a cell does not break the row', /\| a¦b \|/.test(snap.formatTables(result([table(1, { rows: [['a|b']], header: null })]), {})));
  check('no tables: says where it looked and what to try', /No tables found on this page.*shadow roots.*read_page mode:"full"/.test(snap.formatTables(result([]), {})));
  check('an error from the page is passed on', snap.formatTables({ error: 'No element matches selector.' }, {}) === 'No element matches selector.');

  // ---- the tool: extract:"tables" runs the page script, hands `table` and `text_offset` to the formatter, in untrusted markers
  const calls = [];
  const wc = { id: 9, isDestroyed: () => false, getURL: () => 'https://x.test/' };
  const agent = { requireTab: () => wc };
  const h = { scripts: {}, runScript: async (w, code, ms) => { calls.push({ code, ms }); return long; } };
  const out = await snap.execute(agent, 'read_page', { extract: 'tables', text_offset: 200 }, h);
  check('read_page extract:"tables" runs extractTables and pages from text_offset, wrapped as page data', /^<untrusted_page_content>\n/.test(out) && /<\/untrusted_page_content>$/.test(out) && bodyRows(out)[0].startsWith('| r201c1 |') && calls.length === 1 && /extractTables/.test(calls[0].code) && calls[0].ms >= 20000, out.slice(0, 200));
  await snap.execute(agent, 'read_page', { extract: 'tables', selector: '#grid' }, h);
  check('selector reaches the page script', /"selector":"#grid"/.test(calls[1].code));
  const links = await snap.execute(agent, 'read_page', { extract: 'links' }, { ...h, runScript: async () => ({ url: 'u', kind: 'links', data: [] }) });
  check('extract links / lists still answer as JSON', /"kind":"links"/.test(links));

  // ---- the schema: `table` is a real argument (a call is validated) but costs nothing in the listing other agents see
  const listed = EXTERNAL_TOOLS.find((t) => t.name === 'read_page');
  check('the listing shown to Grok / Claude Code / outside agents has no `table` property (the description names it)', !('table' in listed.input_schema.properties) && /table:n\|caption, text_offset:row/.test(listed.description), JSON.stringify(listed));
  check('the call is validated against the full schema: table is accepted', (() => { try { validateInput('read_page', { extract: 'tables', table: '2', text_offset: 10 }); return true; } catch { return false; } })());

  // ---- a full read cut by its chunk says how to get the rest
  const cutPage = { url: 'u', title: 't', text: 'hello', textRange: [0, 12000], totalTextChars: 90000, moreTextAvailable: true };
  const cutText = scripts.formatFull(cutPage);
  check('full read: a clipped chunk says text_offset for the next part and extract:"tables" for whole tables', /\[characters 0-12000 of 90000; read_page mode:"full" text_offset:12000 for the next part, or extract:"tables" for whole tables\]\n<\/untrusted_page_content>$/.test(cutText), cutText);
  check('full read: the last chunk has no such line', !/for the next part/.test(scripts.formatFull({ ...cutPage, moreTextAvailable: false })));

  // ---- read_urls: tables put back after an article are kept whole (paged by offset), and a limit hit is said
  const html = (n) => `<table><thead><tr><th>T</th><th>P</th></tr></thead><tbody>${Array.from({ length: n }, (_, i) => `<tr><td>${i + 1}</td><td>${(i * 1.5).toFixed(2)}</td></tr>`).join('')}</tbody></table>`;
  const article = `<p>${'Steam tables list properties of water. '.repeat(40)}</p>`;
  const done = reading.finishRead({ url: 'https://x.test/a', title: 'Steam', text: 'x '.repeat(900), textLen: 1800, article: { content: article, byline: '' }, tablesHtml: html(900), tablesCut: false, probe: {} }, { maxChars: 400000 });
  check('read_urls: a 900-row table put back after an article comes back whole (no 20k cut)', /\| 900 \| 1348\.50 \|/.test(done.text) && /\| 1 \| 0\.00 \|/.test(done.text) && !/left out/.test(done.text), done.text.slice(-200));
  const limited = reading.finishRead({ url: 'https://x.test/a', title: 'Steam', text: 'x '.repeat(900), textLen: 1800, article: { content: article, byline: '' }, tablesHtml: html(5), tablesCut: true, probe: {} }, { maxChars: 400000 });
  check('read_urls: when the page script had to leave tables out, the result says so and names read_page extract:"tables"', /Some tables were left out.*read_page extract:"tables" table:N/.test(limited.text), limited.text.slice(-300));

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
