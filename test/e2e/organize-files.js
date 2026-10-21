// Organize and tabs that show files, in the real app (hidden: LUMEN_TEST_BACKGROUND=1): local PDFs open in Lumen's viewer, the viewer reads the first page's
// text for Organize, the strip draws a file icon, Organize groups the PDFs by what they are about (not by the viewer's address), and "Turn off AI here"
// for local files stops a file's text from being described to a model. Offline: a temp folder with hand-made PDFs.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// A valid one-page PDF, built by hand so the test needs no fixture file.
function makePdf(text) {
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 800)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-organize-files-'));
  const folders = {
    'Thermo Notes': [['Lecture A.pdf', 'Entropy and the second law of thermodynamics. Heat engines and the Carnot cycle.'], ['Lecture B.pdf', 'Thermodynamics: entropy, heat engines, reversible processes.'], ['Problem set.pdf', 'Thermodynamics problem set: entropy change of an ideal gas.']],
    'Sourdough': [['Starter feeding.pdf', 'Sourdough starter feeding schedule, flour and water ratios.'], ['Bread recipe.pdf', 'Sourdough bread recipe: levain, autolyse, bulk fermentation.'], ['Baking tips.pdf', 'Sourdough baking tips: scoring, steam, oven spring.']],
  };
  const files = [];
  for (const [folder, list] of Object.entries(folders)) {
    fs.mkdirSync(path.join(dir, folder));
    for (const [name, text] of list) { fs.writeFileSync(path.join(dir, folder, name), makePdf(text)); files.push(path.join(dir, folder, name)); }
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-organize-files-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ tabGrouping: 'topic' }));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const entries = () => app.evaluate(() => global.__tabGroups.candidates());
  const openFile = (file) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-stop-loading', r)); return t.id; }, pathToFileURL(file).href);

  for (const file of files) await openFile(file);
  const viewer = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  check('the PDFs opened in Lumen\'s viewer', viewer.startsWith('lumen-pdf://'), viewer);

  // 1. What Organize sees of a PDF tab: the file, not the viewer, with the first page's text once the viewer has read it.
  const sawText = await waitFor(async () => { const e = await entries(); return e.filter((x) => x.file && /thermodynamics|sourdough/i.test(x.text)).length === files.length; });
  const seen = await entries();
  check('every PDF tab is described as a file, with its folder and first-page text', sawText && seen.every((e) => e.file && e.file.kind === 'pdf' && !/lumen-pdf/.test(e.url)), JSON.stringify(seen.slice(0, 2)));
  check('a PDF with no title of its own is shown by its tidied file name and folder', seen.some((e) => e.title === 'Lecture A - Thermo Notes'), JSON.stringify(seen.map((e) => e.title)));

  // 2. The strip draws a file icon for them (no favicon, no globe).
  const icons = await ui.evaluate(() => [...document.querySelectorAll('.tab')].filter((el) => /[.]pdf/i.test(el.textContent)).map((el) => el.querySelector('.tab-favicon')?.getAttribute('class') + '|' + (el.querySelector('.tab-favicon')?.innerHTML || '').length));
  check('file tabs in the strip have a file icon', icons.length >= 4 && icons.every((i) => /page-icon/.test(i)), JSON.stringify(icons));

  // 3. Organize groups them by subject (they used to be skipped).
  const count = await app.evaluate(() => global.__tabGroups.organizableCount());
  check('Organize counts the PDF tabs', count >= files.length, String(count));
  const made = await app.evaluate(() => global.__organizeTabs());
  const groups = await app.evaluate(() => global.__tabGroups.state().map((g) => ({ ...g, tabs: global.__tabGroups.groupEntries(g.id).map((e) => e.title) })));
  check('Organize made two groups', groups.length === 2, JSON.stringify({ made, groups }));
  const thermo = groups.find((g) => g.tabs.some((t) => /Lecture A/.test(t)));
  const bread = groups.find((g) => g.tabs.some((t) => /Bread recipe/.test(t)));
  check('the thermodynamics PDFs are one group, the sourdough PDFs another', thermo && bread && thermo.id !== bread.id && thermo.tabs.length === 3 && bread.tabs.length === 3, JSON.stringify(groups));
  check('no group is named for the viewer', groups.every((g) => !/app|viewer|lumen/i.test(g.name)), JSON.stringify(groups.map((g) => g.name)));

  // 4. AI off for local files: the text of a file is not sent (the entry keeps it for the local grouping).
  const before = (await entries()).filter((e) => e.aiText).length;
  await app.evaluate(() => global.__aiSites.set('local files', true));
  const after = await entries();
  check('with AI on, a PDF\'s snippet may be described; with AI off for local files it is not', before === files.length && after.every((e) => !e.aiText) && after.every((e) => /thermodynamics|sourdough/i.test(e.text)), JSON.stringify({ before, after: after.map((e) => e.aiText) }));
  await app.evaluate(() => global.__aiSites.set('local files', false));

  await app.close();
  // (Windows: the app's helper processes can hold the folders for a moment after close. A leftover is not a failure: _tmp-cleanup removes both at exit.)
  for (const folder of [dir, profile]) { try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* removed at exit */ } }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
