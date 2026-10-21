// No console errors, warnings or uncaught exceptions anywhere in a realistic session, from the main process and from every
// renderer (the browser UI, sidebar, new tab and its widgets, Settings, History, Downloads, Bookmarks, the chat page and its
// canvas, the PDF and slide viewers, error pages, sleeping and woken tabs). A hook loaded before main.js listens on every
// web contents; the session below drives the app (hidden, throwaway profile, fake Claude client, local pages) and the suite fails
// on anything that is not in ALLOW. Every ALLOW entry needs a reason: add one only for a test-environment artefact, fix the rest.
//   node test/e2e/no-errors.js [--show-all]   (--show-all also prints the allowlisted lines)
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// Lines that are expected in this environment. `where`: 'main' (console.error/warn in the main process), 'renderer' (a web
// contents' console, matched on the text), 'stderr' (what the process itself prints, Chromium's native logging included).
const ALLOW = [
  { where: 'main', text: /Failed to load URL: http:\/\/127[.]0[.]0[.]1:\d+\/refused with error: ERR_CONNECTION_REFUSED/, reason: 'Electron itself warns about the refused address the session opens on purpose (Lumen catches the rejection and shows its error page)' },
  { where: 'renderer', text: /ERR_CONNECTION_REFUSED/, reason: 'the session deliberately loads a refused address to show the error page; Chromium logs the failed load' },
  { where: 'stderr', text: /ERR_CONNECTION_REFUSED|Autofill\.|DevTools listening|Electron Helper|trace-warnings|Waiting for the debugger to disconnect|^\s*$/, reason: 'the refused address above, the DevTools attach line Playwright prints, and Chromium/Windows noise outside Lumen' },
  { where: 'stderr', text: /\[\d+:\d+\/\d+\.\d+:(ERROR|WARNING):(?:gpu_channel_manager|viz_main_impl|network_service_instance_impl|chrome_browser_main_extra_parts|cert_verify_proc_builtin|dxva_video_decode_accelerator_win|command_buffer_proxy_impl|sandbox_win)/, reason: 'Chromium GPU/network-service lines of a headless, GPU-less test run; none comes from Lumen code' },
];

// ---- the hook: test/helpers/_no-errors-hook.js, loaded before main.js by a tiny generated entry point (NODE_OPTIONS=--require is off in Electron builds) ----

// ---- fixtures ----
function makePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8'); const comp = zlib.deflateRawSync(data); const nameBuf = Buffer.from(name, 'utf8'); const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp); centrals.push(central, nameBuf); offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (list) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const makeDeck = () => zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml']]),
  'ppt/theme/theme1.xml': `<a:theme ${NS} name="T"><a:themeElements><a:clrScheme name="C"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
  'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${NS}><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/></p:sldMaster>`,
  'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'theme', '../theme/theme1.xml']]),
  'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${NS}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`,
  'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  ...Object.fromEntries([1, 2].flatMap((n) => [
    [`ppt/slides/slide${n}.xml`, `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="6000000" cy="800000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"/><a:t>Slide ${n}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
    [`ppt/slides/_rels/slide${n}.xml.rels`, rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])],
  ])),
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 1500)}`}`); };
  const showAll = process.argv.includes('--show-all');
  const hardStop = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 420000);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-noerr-'));
  const profile = path.join(work, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(work, 'doc.pdf'), makePdf(['Page one', 'Page two']));
  fs.writeFileSync(path.join(work, 'deck.pptx'), makeDeck());
  fs.writeFileSync(path.join(work, 'local.html'), '<!doctype html><title>Local page</title><body><h1>Local</h1><p>a local file</p></body>');
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('.pdf')) { res.setHeader('Content-Type', 'application/pdf'); res.end(makePdf(['Served page'])); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Fixture ${req.url.slice(1)}</title><body><h1>Fixture ${req.url}</h1>${'<p>lorem ipsum dolor sit amet</p>'.repeat(40)}<a href="/next">next</a></body>`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const closedPort = await new Promise((r) => { const t = http.createServer().listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); }); // nothing listens: the error page

  // The entry point: the hook, then the real main.
  const entry = path.join(work, 'entry');
  fs.mkdirSync(entry);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'entry.js' }));
  fs.writeFileSync(path.join(entry, 'entry.js'), `require(${JSON.stringify(path.join(__dirname, '_no-errors-hook.js'))}); require('electron').app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, pkg.main))});`);

  // Never launch Electron on a file that doesn't parse (a broken main-process script pops a modal on the user's screen).
  for (const file of [path.join(entry, 'entry.js'), path.join(__dirname, '_no-errors-hook.js')]) {
    const r = require('child_process').spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) { console.error(`syntax error in ${file}
${r.stderr}`); process.exit(1); }
  }

  const stderrLines = []; const stdoutLines = [];
  const app = await electron.launch({
    args: [entry], timeout: 90000,
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1', TEMP: work, TMP: work, LUMEN_NOERR_LOG: path.join(work, 'events.jsonl') },
  });
  const proc = app.process();
  const lineSink = (list) => { let buf = ''; return (chunk) => { buf += chunk; const parts = buf.split(/\r?\n/); buf = parts.pop(); list.push(...parts); }; };
  proc.stderr.setEncoding('utf8'); proc.stdout.setEncoding('utf8');
  proc.stderr.on('data', lineSink(stderrLines)); proc.stdout.on('data', lineSink(stdoutLines));
  const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal })));

  const steps = [];
  const step = async (name, fn) => { try { await fn(); } catch (err) { steps.push(`${name}: ${err.message}`); } };
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab', { timeout: 60000 });
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    const state = await app.evaluate(() => { const t = global.__tabsArray(); return t.length; });
    check('Lumen started with a tab', state >= 1, state);
    // Fake Claude client: replies, and an HTML reply for the canvas.
    const html = '<!doctype html><html><body><p id="hello">hello canvas</p><script>document.title = "canvas";</script></body></html>';
    const reply = `Here you go.\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n\`\`\`html\n${html}\n\`\`\`\n\n$$x^2$$ and a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
    await app.evaluate((_e, text) => {
      global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 200 } };
        return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; }, finalMessage: async () => message };
      } } } });
    }, reply);

    // 1. Fifteen tabs: eleven local pages, a PDF, a deck, a local file, a refused address (the error page).
    await step('open tabs', async () => {
      for (let i = 0; i < 11; i++) await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 6000); }); }, `${base}/page${i}`);
      await app.evaluate(({ ipcMain }, files) => ipcMain.emit('files:open', {}, files), [path.join(work, 'doc.pdf'), path.join(work, 'deck.pptx'), path.join(work, 'local.html')]);
      await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 6000); }); }, `http://127.0.0.1:${closedPort}/refused`);
      await sleep(2500);
    });
    const tabCount = await waitFor(async () => { const n = await app.evaluate(() => global.__tabsArray().length); return n >= 15 && n; }, 10000);
    check('15 or more tabs are open', tabCount >= 15, tabCount);
    // Background tabs are placeholders until opened: visiting each makes its page (and the PDF and slide viewers) real.
    await step('switch tabs', async () => {
      const ids = await app.evaluate(() => global.__tabsArray().map((t) => t.id));
      for (const id of ids) { await app.evaluate((_e, i) => global.__aiTabs.switchTo(i), id); await sleep(250); }
    });
    const kindsNow = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => { try { return w.getURL().split(':')[0] + (/slides[.]html/.test(w.getURL()) ? ':slides' : ''); } catch { return ''; } }));
    const kinds = await waitFor(async () => { const k = await kindsNow(); return k.includes('lumen-pdf') && k.includes('file:slides') && k; }, 15000) || await kindsNow();
    check('a PDF viewer and a slide viewer are among the tabs', kinds.includes('lumen-pdf') && kinds.includes('file:slides'), JSON.stringify(kinds));

    // 2. Sidebar and chat.
    await step('sidebar and chat', async () => {
      await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
      await sleep(600);
      await ui.fill('#prompt', 'make a page');
      await ui.press('#prompt', 'Enter');
      await waitFor(async () => /Here you go/.test(await ui.evaluate(() => document.getElementById('messages').textContent)));
      await ui.fill('#prompt', 'and again');
      await ui.press('#prompt', 'Enter');
      await sleep(1200);
      await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
      await sleep(400);
      await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
      await sleep(400);
    });
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return 'NO CHAT TAB';
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await step('chat page and canvas', async () => {
      await ui.evaluate(() => document.getElementById('open-chat-page').click());
      await waitFor(async () => (await inPage("document.querySelectorAll('.code-block').length")) >= 2, 12000);
      await inPage("(() => { const b = document.querySelectorAll('.code-block')[1]?.querySelector('.code-canvas'); if (b) b.click(); })()");
      await sleep(1500);
      await inPage("(() => { const p = document.getElementById('prompt') || document.querySelector('textarea'); if (p) { p.focus(); } })()");
      await sleep(500);
      await app.evaluate(() => global.__chatPage.back());
      await sleep(800);
    });

    // 3. Organize the tabs.
    await step('organize', async () => { await app.evaluate(() => global.__organizeTabs()); await sleep(1000); });

    // 4. Lumen's own pages: History, Downloads, Bookmarks, Settings (every section).
    await step('history, bookmarks, downloads', async () => {
      await app.evaluate(() => global.__openHistoryPage());
      await sleep(1200);
      for (const page of ['bookmarks', 'downloads']) { await app.evaluate((_e, p) => global.__managers.managers.open(p), page); await sleep(1200); }
    });
    await step('settings', async () => {
      const sid = await app.evaluate(() => global.__settings.open(''));
      const inSettings = (code) => app.evaluate(async (_e, a) => { const wc = global.__settings.contents(a.sid); try { return await wc.executeJavaScript(a.code, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, { sid, code });
      await waitFor(async () => (await inSettings("document.querySelectorAll('#nav a').length")) > 3, 15000);
      const sections = await inSettings('[...document.querySelectorAll("#nav a")].map((a) => a.dataset.section)');
      check('Settings lists its sections', Array.isArray(sections) && sections.length > 5, JSON.stringify(sections));
      for (const s of sections) { await inSettings(`document.querySelector('#nav a[data-section="${s}"]').click()`); await sleep(350); }
      await inSettings("(() => { const s = document.querySelector('input[type=search]'); if (s) { s.value = 'theme'; s.dispatchEvent(new Event('input')); } })()");
      await sleep(400);
      // Dark mode, through the setting.
      await inSettings("(async () => { const el = document.getElementById('pref-theme'); el.value = 'dark'; el.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 600)); })()");
    });

    // 5. Resize, dark mode in the other pages, a tab through the settings once more.
    await step('resize', async () => {
      for (const [w, h] of [[900, 600], [480, 700], [1400, 900]]) { await app.evaluate(({ BrowserWindow }, s) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(s[0], s[1]); }, [w, h]); await sleep(500); }
    });
    await step('new tab page', async () => {
      await ui.evaluate(() => document.getElementById('new-tab').click());
      await sleep(2500);
    });

    // 6. Sleep and wake.
    await step('sleep and wake', async () => {
      const ids = await app.evaluate(() => global.__tabSleep.state().map((t) => t.id));
      const active = await app.evaluate(() => global.__chatPage.activeId());
      for (const id of ids.filter((i) => i !== active).slice(0, 8)) await app.evaluate((_e, i) => global.__tabSleep.sleep(i), id);
      await sleep(1000);
      for (const id of ids.slice(0, 8)) { await app.evaluate((_e, i) => global.__aiTabs.switchTo(i), id); await sleep(500); }
    });
    await sleep(1500);
    check('the session ran without a step failing', steps.length === 0, steps.join(' | '));

    if (process.argv.includes('--debug')) console.log(JSON.stringify(await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => `${w.getType()}#${w.id} ${w.getURL().slice(0, 90)}`)), null, 1));
    // Quit.
    await app.evaluate(({ app: a }) => a.quit()).catch(() => {});
  } catch (err) {
    check('the session ran', false, err.stack || err.message);
  }

  const exit = await Promise.race([exited, sleep(20000).then(() => null)]);
  if (!exit) { try { await app.close(); } catch { /* gone */ } }
  clearTimeout(hardStop);
  server.close();
  check('Lumen quit by itself and cleanly', exit && exit.code === 0, JSON.stringify(exit));

  let events = [];
  try { events = fs.readFileSync(path.join(work, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none written: no errors */ }
  events = events.filter((ev) => ev.where !== 'trace');
  for (const line of stderrLines) events.push({ where: 'stderr', level: 'stderr', text: line });
  const used = new Set();
  const allowed = (ev) => ALLOW.findIndex((a) => a.where === ev.where && a.text.test(ev.text));
  const bad = [];
  for (const ev of events) {
    const idx = allowed(ev);
    if (idx >= 0) { used.add(idx); if (showAll) console.log(`allowed (${ALLOW[idx].reason.slice(0, 40)}): [${ev.where}${ev.url ? ' ' + ev.url : ''}] ${ev.text.slice(0, 200)}`); } else bad.push(ev);
  }
  // Each distinct message once, with a count.
  const grouped = new Map();
  for (const ev of bad) { const key = `${ev.where}|${ev.level}|${ev.url || ''}|${ev.text.slice(0, 160)}`; const g = grouped.get(key) || { ev, n: 0 }; g.n++; grouped.set(key, g); }
  for (const { ev, n } of grouped.values()) console.log(`  [${ev.where} ${ev.level}${ev.kind ? " " + ev.kind : ""}${ev.url ? " " + ev.url : ""}${ev.source ? ' ' + ev.source + ':' + ev.line : ''}] x${n} ${ev.text.slice(0, 400)}`);
  check(`no console errors, warnings or exceptions in main or any renderer (${events.length - bad.length} allowlisted)`, bad.length === 0, `${grouped.size} distinct unexpected line(s), listed above`);
  try { fs.writeFileSync(path.join(work, 'stdout.txt'), stdoutLines.join('\n')); } catch { /* the folder is gone */ }
  // --keep <dir>: copy the raw event log and main's output there for a closer look.
  const keep = process.argv.indexOf('--keep');
  if (keep > 0) { const dir = path.resolve(process.argv[keep + 1]); fs.mkdirSync(dir, { recursive: true }); for (const n of ['events.jsonl', 'stdout.txt']) try { fs.copyFileSync(path.join(work, n), path.join(dir, n)); } catch { /* none */ } fs.writeFileSync(path.join(dir, 'stderr.txt'), stderrLines.join('\n')); }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
