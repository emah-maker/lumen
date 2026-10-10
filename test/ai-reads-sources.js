// Hidden-window proof that read_urls reads a PDF link and an HTML table page for the AI (the steam-table report, v0.5.22): the real Agent tool in a real
// Electron main process with real hidden reader views (a WebContentsView that is never attached to a window: nothing appears on screen), against a local
// http server. Run: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 CLAUDE_BROWSER_PROFILE=<temp dir> npx electron test/ai-reads-sources.js
// (an opt-in real fetch of a public PDF: LUMEN_TEST_NETWORK=1 LUMEN_TEST_PDF_URL=<address>). Not part of npm test.
const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

if (process.env.CLAUDE_BROWSER_PROFILE) app.setPath('userData', process.env.CLAUDE_BROWSER_PROFILE);
else app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reads-sources-')));
app.dock?.hide?.();

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };

app.whenReady().then(async () => {
  const { Agent } = require('../src/ai/agent');
  const { startServer } = require('./fixtures/steam-table');
  const { server, base } = await startServer();
  const wc = { id: 50, isDestroyed: () => false, getTitle: () => 't', getURL: () => 'about:blank' };
  const browser = {
    activeTab: () => ({ id: 5, webContents: wc }), tabById: () => ({ id: 5, webContents: wc }), listTabs: () => [], effectiveModel: (m) => m, aiOff: () => false,
    noTabReason: () => 'none', maxSteps: () => 0, autoApprove: () => true, bypassPermissions: () => true, handsOff: () => false, isAiTab: () => false, tabOff: () => false,
    typingText: () => '', deviceAccess: () => false, profileDir: () => '',
    showResearch: () => () => {},
  };
  const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5' }));
  agent.closeSignedInTabs = () => {};
  agent.taskTabInFront = () => true;
  agent.showResearch = () => () => {};
  const signal = new AbortController().signal;
  const asks = [];
  agent.askApproval = async (...a) => { asks.push(a); return true; };
  const read = async (urls) => {
    const out = await agent.inTask(5, signal, () => agent.execute('read_urls', { urls }), null, null, { chatId: 'a1b2c3d4e5f60718', hosts: new Set() });
    return Array.isArray(out) ? out.join('\n') : String(out);
  };
  try {
    const pdf = await read([`${base}/steam/Table_A_3.pdf`]);
    check('a PDF link: the table comes back with its 8 kPa row on one line', /8 41\.51 0\.001008 173\.85 2403\.0 2576\.8/.test(pdf) && /Page 1 of 1/.test(pdf), pdf);
    const odd = await read([`${base}/download`]);
    check('a PDF at an address that does not say .pdf (the page view cannot show it) is found and read', /173\.85/.test(odd), odd);
    const html = await read([`${base}/steam/table.html`]);
    check('an HTML page: the table keeps its rows and columns', /8 \| 41\.51 \| 173\.85 \| 2403\.0|\| 8 \| 41\.51 \| 173\.85 \| 2403\.0 \|/.test(html), html);
    const mixed = await read([`${base}/steam/missing.pdf`, `${base}/steam/Table_A_3.pdf?again=1`]);
    check('a first source that fails (404) does not stop the second one in the same call', /173\.85/.test(mixed) && /404|Could not|not found/i.test(mixed), mixed);
    check('no file prompt for a web PDF', asks.every((a) => a[2]?.action !== 'pdf'), JSON.stringify(asks));
    if (process.env.LUMEN_TEST_NETWORK === '1' && process.env.LUMEN_TEST_PDF_URL) {
      const real = await read([process.env.LUMEN_TEST_PDF_URL]);
      console.log(`--- real PDF (${process.env.LUMEN_TEST_PDF_URL}):\n${real.slice(0, 1500)}`);
    }
  } catch (err) {
    check('read_urls ran', false, err.stack || err.message);
  }
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  app.exit(failures ? 1 : 0);
});
setTimeout(() => { console.log('FAIL  timed out after 90 s'); app.exit(1); }, 90000).unref();
