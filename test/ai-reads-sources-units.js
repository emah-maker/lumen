// The AI finds and reads a source itself (a steam table behind a PDF link, an HTML table): plain Node, a local http server, no window, no network.
// Covers: read_urls on a web PDF (ai/remote-pdf.js + Agent.execute) with the table's rows kept, a failing first source then a working second one,
// HTML tables kept as rows and columns (ai/page-reading.js), the Claude Code / CLI engine args and prompts that steer to Lumen's tools instead of
// WebFetch / Bash, and Auto routing of "double check" asks. The real psu.edu PDF is read only with LUMEN_TEST_NETWORK=1.
require('./_tmp-cleanup');

// Agent.execute reads web PDFs through the reader session: here that is Node's fetch.
const electronPath = require.resolve('electron');
const real = require('electron');
require.cache[electronPath].exports = Object.assign(Object.create(null), typeof real === 'object' ? real : {}, { session: { fromPartition: () => ({ fetch: (u, o) => fetch(u, o) }) } });

const { Agent, cliSystemPrompt } = require('../src/ai/agent');
const remotePdf = require('../src/ai/remote-pdf');
const pdfText = require('../src/features/pdf-text');
const reading = require('../src/ai/page-reading');
const cc = require('../src/ai/claude-code');
const route = require('../src/features/model-route');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };

const { PDF, HTML_TABLE, startServer } = require('./fixtures/steam-table');


(async () => {
  const { server, base } = await startServer();

  // ---- the PDF text keeps the table's rows (cells in separate text objects, rows at their own height)
  const pages = pdfText.extractPages(PDF);
  const lines = pages[0].split('\n');
  check('pdf text: a table written cell by cell comes back one row per line', lines.length === 4 && /^8 41\.51 0\.001008 173\.85 2403\.0 2576\.8$/.test(lines[2]) && /^P \(kPa\) Tsat \(C\)/.test(lines[0]), JSON.stringify(pages[0]));

  // ---- remote-pdf: fetch, redirects, not-a-PDF
  const fetchOpts = { fetch: (u, o) => fetch(u, o) };
  const direct = await remotePdf.readRemotePdf(`${base}/steam/Table_A_3.pdf`, fetchOpts);
  check('read_urls on a PDF link: the table text comes back, page-numbered, with the 8 kPa row', direct && /--- Page 1 of 1 ---/.test(direct.text) && /8 41\.51 0\.001008 173\.85 2403\.0 2576\.8/.test(direct.text) && direct.title === 'Table_A_3.pdf', JSON.stringify(direct));
  const hops = [];
  const moved = await remotePdf.readRemotePdf(`${base}/steam/old-name.pdf`, { ...fetchOpts, onHop: (n) => hops.push(n) });
  check('a redirect is followed (same host: no extra question)', moved && /173\.85/.test(moved.text) && hops.length === 0, JSON.stringify(moved));
  const other = await remotePdf.readRemotePdf(`${base}/x.pdf`, { fetch: async () => new Response(null, { status: 302, headers: { location: 'http://other.test/a.pdf' } }), onHop: (n) => { throw new Error(`blocked ${new URL(n).host}`); } });
  check('a redirect to another host goes through the site check first (here: refused, said plainly)', other && /blocked other\.test/.test(other.text) && /Could not read this PDF/.test(other.text), JSON.stringify(other));
  check('a 404 or an HTML page at a .pdf address is not a PDF (null: read it as a page)', (await remotePdf.readRemotePdf(`${base}/steam/missing.pdf`, fetchOpts)) === null && (await remotePdf.readRemotePdf(`${base}/steam/soft404.pdf`, fetchOpts)) === null, '');
  check('a PDF served at an address without .pdf is found by its content type', /173\.85/.test((await remotePdf.readRemotePdf(`${base}/download`, fetchOpts))?.text || ''), '');
  check('an ordinary web page is not touched', (await remotePdf.readRemotePdf(`${base}/steam/table.html`, fetchOpts)) === null, '');
  const paged = await remotePdf.readRemotePdf(`${base}/steam/Table_A_3.pdf`, { ...fetchOpts, maxChars: 1000, offset: 0 });
  check('read_urls max_chars / offset paging works on a PDF', paged && !/offset: \d+/.test(paged.text), paged?.text);

  // ---- the whole tool: Agent.execute('read_urls'), a failing first source, then the next one
  {
    const wc = { id: 50, isDestroyed: () => false, getTitle: () => 't', getURL: () => 'about:blank' };
    const browser = {
      activeTab: () => ({ id: 5, webContents: wc }), tabById: () => ({ id: 5, webContents: wc }), listTabs: () => [], effectiveModel: (m) => m, aiOff: () => false,
      noTabReason: () => 'none', maxSteps: () => 0, autoApprove: () => true, bypassPermissions: () => true, handsOff: () => false, isAiTab: () => false, tabOff: () => false,
      typingText: () => '', deviceAccess: () => false, profileDir: () => '',
    };
    const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5' }));
    agent.closeSignedInTabs = () => {};
    agent.taskTabInFront = () => true;
    const signal = new AbortController().signal;
    const asks = [];
    agent.askApproval = async (...a) => { asks.push(a); return true; };
    const run = (name, input) => agent.inTask(5, signal, () => agent.execute(name, input), null, null, { chatId: 'a1b2c3d4e5f60718', hosts: new Set() });
    const out = await run('read_urls', { urls: [`${base}/steam/Table_A_3.pdf`] });
    const text = Array.isArray(out) ? out.join('\n') : String(out);
    check('Agent read_urls on a remote PDF returns its text inside the untrusted-content wrapper, with no local-file prompt', /173\.85/.test(text) && /untrusted_page_content/.test(text) && asks.every((a) => a[2]?.action !== 'pdf'), text);
    const second = await run('read_urls', { urls: [`${base}/steam/broken.pdf`, `${base}/steam/Table_A_3.pdf?other=1`] });
    const t2 = Array.isArray(second) ? second.join('\n') : String(second);
    check('one source failing does not fail the call: the other source in the same read_urls still comes back', /173\.85/.test(t2), t2);
  }

  // ---- HTML tables come back as rows and columns
  {
    const raw = { url: 'https://x.test/steam', title: 'Steam', text: 'Saturated water: pressure table\nProperties of saturated water by pressure (kPa).\nP (kPa)\tTsat (C)\thf\thfg\n7.5\t40.29\t168.75\t2406.0\n8\t41.51\t173.85\t2403.0', textLen: 160, article: null, probe: {} };
    const plain = reading.finishRead(raw, {});
    check('a table on a page that is not an article: each row keeps its columns ("8 | 41.51 | ...")', /8 \| 41\.51 \| 173\.85 \| 2403\.0/.test(plain.text) && !/\t/.test(plain.text), plain.text);
    const prose = '<p>' + 'Saturated water properties are listed by pressure and by temperature in the tables of every thermodynamics text. '.repeat(6) + '</p>';
    const art = reading.finishRead({ ...raw, article: { title: 'Steam', byline: '', content: prose }, tablesHtml: HTML_TABLE.match(/<table>[\s\S]*<\/table>/)[0] }, {});
    check('an article that lost its table gets it back as a markdown table', art.article && /\| 8 \| 41\.51 \| 173\.85 \| 2403\.0 \|/.test(art.text) && /\| --- \|/.test(art.text), art.text);
  }

  // ---- the engines are steered to Lumen's tools
  {
    const args = (o) => cc.buildArgs({ mcpConfig: 'm', sessionId: 's', resume: false, systemPrompt: 'p', ...o });
    const full = args({ fullAccess: true });
    check('Claude Code full access: WebFetch and WebSearch are disallowed (Lumen reads pages and PDFs), Bash and files stay', full[full.indexOf('--disallowedTools') + 1] === 'WebFetch,WebSearch' && !full.includes('--tools'), JSON.stringify(full));
    const lock = args({});
    check('Claude Code default: no built-in tools at all (--tools "") and only mcp__lumen allowed', lock[lock.indexOf('--tools') + 1] === '' && lock[lock.indexOf('--allowedTools') + 1] === 'mcp__lumen', JSON.stringify(lock));
    const note = (engine) => cliSystemPrompt({ model: `${engine}:default`, adhdMode: false }, engine, {});
    for (const engine of ['claudecode', 'grokbuild', 'codex', 'antigravity']) {
      const p = note(engine);
      check(`${engine}: the prompt says to go find a source, read PDFs with read_urls / read_pdf, and not to answer from memory`, /read_urls/.test(p) && /read_pdf/.test(p) && /never download and run local programs/i.test(p) && /from memory/.test(p) && /ask the user only after several real attempts/.test(p), p.length);
    }
    const agentSrc = require('fs').readFileSync(require.resolve('../src/ai/agent'), 'utf8');
    check('every full-access note tells the CLI to read pages and PDFs with Lumen\'s tools, not WebFetch / a downloaded file', (agentSrc.match(/not (?:WebFetch, WebSearch or )?a downloaded file run through (?:Bash|the shell)/g) || []).length >= 4, '');
  }

  // ---- Auto
  for (const p of ['can you double check the tables', 'verify the 0.08 bar values', 'is this right?', 'look it up', 'confirm the values', 'find the source', 'check the tables']) {
    const r = route.tierFor(p, {});
    check(`Auto: "${p}" is research on at least a mid-size model`, r.kind === 'research' && r.tier !== 'light', JSON.stringify(r));
  }
  check('Auto: "look up the weather" and "open youtube" are not research', route.tierFor('look up the weather', {}).kind !== 'research' && route.tierFor('open youtube', {}).kind !== 'research', '');

  // ---- opt-in: the real file from the report (the address is truncated in the report, so only a reachable one is read)
  if (process.env.LUMEN_TEST_NETWORK === '1') {
    const real2 = await remotePdf.readRemotePdf(process.env.LUMEN_TEST_PDF_URL || 'https://www.me.psu.edu/cimbala/me405/Links/Table_A_3_CC_Saturated_Water_Pressure_Table.pdf', fetchOpts);
    console.log(real2 ? real2.text.slice(0, 1500) : '(not a PDF or not reachable)');
  }

  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
