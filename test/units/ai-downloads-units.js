// A file Lumen downloads is reported to the AI with its path (features/ai-downloads.js, agent.js executeGuarded / wait_for download /
// list_files), and click_at works without an earlier screenshot (agent.js shotScaleFor). Plain Node: no Electron.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dl = require('../../src/features/ai-downloads');
const { docxText } = require('../../src/features/docx-text');
const { makeDocx } = require('../fixtures/docx-fixture');
const { Agent } = require('../../src/ai/agent');
const scripts = require('../../src/ai/page-scripts');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidl-units-'));
  const docx = path.join(dir, 'Report.docx');
  fs.writeFileSync(docx, makeDocx(['Quarterly Report', 'Revenue grew & costs fell.', 'Second <paragraph>'], { table: [['Q1', '10'], ['Q2', '12']] }));
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, 'a'.repeat(30000));
  const pdf = path.join(dir, 'paper.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4');
  const now = Date.now();
  const entry = (over) => ({ id: 1, name: 'Report.docx', path: docx, state: 'completed', received: 1, total: 1, started: now - 2000, endedAt: now - 1000, ...over });

  // ---- the text of a Word file
  const text = await docxText(fs.readFileSync(docx));
  check('docx: the heading, paragraphs (entities decoded) and table rows come out', text.startsWith('# Quarterly Report\nRevenue grew & costs fell.\nSecond <paragraph>') && /Q1\t10\nQ2\t12$/.test(text), JSON.stringify(text));
  let err = null;
  try { await docxText(Buffer.from('not a zip at all, but long enough to be looked at')); } catch (e) { err = e; }
  check('docx: a file that is not a Word document says so', err && /not a Word document/.test(err.message), err && err.message);

  // ---- lines, sizes
  check('size text', dl.sizeText(500) === '500 B' && dl.sizeText(2048) === '2 KB' && dl.sizeText(5 * 1024 * 1024) === '5 MB');
  const line = dl.lineOf(entry());
  check('line: "Downloaded: name (size) at full path"', line === `Downloaded: Report.docx (${dl.sizeText(fs.statSync(docx).size)}) at ${docx}`, line);
  check('line: a failed, cancelled, running and held download each say so', /failed/.test(dl.lineOf(entry({ state: 'interrupted' }))) && /cancelled/.test(dl.lineOf(entry({ state: 'cancelled' }))) && /not finished/.test(dl.lineOf(entry({ state: 'progressing', received: 10, total: 100 }))) && /asking the user/.test(dl.lineOf(entry({ state: 'progressing', awaitingOk: true }))));

  // ---- what each chat is told: once, lately, the user's own included
  const chat = [];
  const list = [entry({ id: 3, endedAt: now - 500 }), entry({ id: 2, name: 'old.docx', endedAt: now - 10 * 60 * 1000 }), entry({ id: 1, state: 'progressing', endedAt: null })];
  const first = dl.news(list, chat, { now });
  check('news: a download that finished lately is reported; an old one and a running one are not', first.length === 1 && /Report\.docx/.test(first[0]), JSON.stringify(first));
  check('news: said once per chat, and another chat still hears it', dl.news(list, chat, { now }).length === 0 && dl.news(list, [], { now }).length === 1);

  // ---- an action that starts a download waits for it
  const running = entry({ id: 9, state: 'progressing', endedAt: null, started: Date.now() + 5 });
  const chat2 = [];
  setTimeout(() => { running.state = 'completed'; running.endedAt = Date.now(); }, 150);
  const t0 = Date.now();
  const lines = await dl.afterAction([running], chat2, t0, { timeoutMs: 3000 });
  check('afterAction: waits for the file and returns its path', lines.length === 1 && lines[0].startsWith('Downloaded: Report.docx') && Date.now() - t0 >= 120, JSON.stringify(lines));
  check('afterAction: the file is the chat\'s own, and not repeated as news', dl.isOwn(chat2, running) && dl.news([running], chat2).length === 0);
  check('afterAction: nothing started, nothing returned, no waiting', (await dl.afterAction([entry({ started: t0 - 60000 })], chat2, t0)).length === 0);
  const stuck = entry({ id: 10, state: 'progressing', endedAt: null, started: Date.now() + 5 });
  const slow = await dl.afterAction([stuck], [], Date.now(), { timeoutMs: 200 });
  check('afterAction: a download that does not finish in time is reported as still running', /not finished/.test(slow[0]), slow[0]);

  // ---- the list and reading
  check('listText: newest first with paths', /^Lumen's download list/.test(dl.listText([entry()])) && dl.listText([entry()]).includes(docx));
  check('find: by full path and by name', dl.find([entry()], docx).id === 1 && dl.find([entry()], 'report.DOCX').id === 1 && dl.find([entry()], 'nope.docx') === null);
  const read = await dl.readText(entry());
  check('readText: a .docx is read', read.text.startsWith('# Quarterly Report') && read.total === read.to, JSON.stringify(read).slice(0, 100));
  const part = await dl.readText(entry({ path: txt, name: 'notes.txt' }), { maxChars: 1000, offset: 10 });
  check('readText: a text file in chunks', part.text.length === 1000 && part.from === 10 && part.to === 1010 && part.total === 30000);
  let pdfErr = null;
  try { await dl.readText(entry({ path: pdf, name: 'paper.pdf' })); } catch (e) { pdfErr = e; }
  check('readText: a PDF points at open_tab + read_pdf', pdfErr && /read_pdf/.test(pdfErr.message), pdfErr && pdfErr.message);

  // ---- the agent: results carry the path, wait_for, list_files, reading and its card
  const makeAgent = (over = {}) => {
    const downloads = [];
    const agent = Object.assign(Object.create(Agent.prototype), {
      scopes: new Set(), messages: [],
      browser: { downloadList: () => downloads, aiOff: () => false, deviceAccess: () => false, ...over },
      signalAborted: () => false,
    });
    return { agent, downloads };
  };
  {
    const { agent, downloads } = makeAgent();
    agent.executeGuardedCore = async (name) => {
      if (name === 'click') { downloads.unshift({ id: 1, name: 'Report.docx', path: docx, state: 'progressing', received: 0, total: 100, started: Date.now(), endedAt: null }); setTimeout(() => Object.assign(downloads[0], { state: 'completed', endedAt: Date.now() }), 100); }
      return `${name} ok`;
    };
    const click = await agent.executeGuarded('click', { text: 'Download' });
    check('click that starts a download: the same result carries the path, name and size', /^click ok\nDownloaded: Report\.docx \(\d/.test(click) && click.includes(docx), click);
    check('the next result does not repeat it', (await agent.executeGuarded('find', { query: 'x' })) === 'find ok');
    downloads.unshift({ id: 2, name: 'user.pdf', path: pdf, state: 'completed', received: 8, total: 8, started: Date.now() - 500, endedAt: Date.now() - 100 });
    const next = await agent.executeGuarded('read_page', {});
    check('a download the user started that finished meanwhile is mentioned once in the next result', /^read_page ok\nDownloaded: user\.pdf/.test(next) && (await agent.executeGuarded('read_page', {})) === 'read_page ok', next);
    agent.executeGuardedCore = async () => [{ type: 'image' }];
    downloads.unshift({ id: 3, name: 'b.txt', path: txt, state: 'completed', received: 1, total: 1, started: Date.now() - 400, endedAt: Date.now() - 50 });
    const shot = await agent.executeGuarded('screenshot', {});
    check('an image result gets the note as one more text block', shot.length === 2 && /Downloaded: b\.txt/.test(shot[1].text), JSON.stringify(shot));
  }
  {
    const { agent, downloads } = makeAgent();
    agent.executeGuardedCore = async () => 'ok';
    const empty = await agent.waitForDownload({ seconds: 1 }).catch((e) => e);
    check('wait_for download: with none, it times out and says what to do', empty instanceof Error && /No download started/.test(empty.message), String(empty));
    setTimeout(() => downloads.unshift({ id: 5, name: 'Report.docx', path: docx, state: 'progressing', received: 0, total: 10, started: Date.now(), endedAt: null }), 100);
    setTimeout(() => Object.assign(downloads[0], { state: 'completed', endedAt: Date.now() }), 300);
    const got = await agent.waitForDownload({ seconds: 5 });
    check('wait_for download: waits for the next download and returns path and size', /^Downloaded: Report\.docx \(\d/.test(got) && got.includes(docx), got);
    check('wait_for download: asked again, it returns the same file at once', (await agent.waitForDownload({ seconds: 1 })) === got);
  }
  {
    const { agent, downloads } = makeAgent();
    downloads.push(entry());
    const listed = await agent.listFilesTool({ folder: 'downloads' });
    check('list_files downloads: Lumen\'s own list answers instantly, even with device access off', /Lumen's download list/.test(listed) && listed.includes(docx), listed);
    let off = null;
    try { await agent.listFilesTool({ folder: 'desktop' }); } catch (e) { off = e; }
    check('list_files elsewhere still needs the device-access setting', off && /Settings/.test(off.message), off && off.message);
    // reading: not the chat's own -> asks once
    let asked = 0;
    agent.askApproval = async (name, _emit, _signal, opts) => { asked++; check('the card names the file, not the folder', name === 'Report.docx' && !String(opts.title).includes(dir), opts.title); return true; };
    agent.markTainted = () => {};
    const readOut = await agent.readDownload({ read: 'Report.docx' }, downloads); // (no run scope here: nothing to ask, as a direct call)
    const chat3 = [];
    const gate = { emit() {}, signal: new AbortController().signal, who: 'Claude' };
    const inRun = (chat) => agent.inScope({ chat, gate }, () => agent.readDownload({ read: docx }, downloads));
    check('read: a file that is not this chat own asks once, then this chat has it', /Quarterly/.test(await inRun(chat3)) && asked === 1 && /Quarterly/.test(await inRun(chat3)) && asked === 1, String(asked));
    const own = [];
    dl.markOwn(own, downloads[0]);
    await inRun(own);
    check('read: a file this chat own action downloaded asks nothing', asked === 1, String(asked));
    agent.askApproval = async () => false;
    check('read: a "no" on the card refuses', await inRun([]).then(() => false, (e) => /did not allow/.test(e.message)));
    check('read: the text comes back marked as untrusted file content', /<untrusted_file_content name="Report.docx">\n# Quarterly Report/.test(readOut), readOut);
    check('read: an unknown name says where to look', await agent.readDownload({ read: 'zzz.docx' }, downloads).then(() => false, (e) => /download list/.test(e.message)));
    check('read: AI off for local files refuses', await makeAgent({ aiOff: () => true }).agent.readDownload({ read: 'Report.docx' }, [entry()]).then(() => false, (e) => /turned off AI/.test(e.message)));
  }

  // ---- click_at without an earlier screenshot
  {
    const calls = { capture: 0, script: 0 };
    let view = { innerWidth: 960, innerHeight: 600, scrollX: 0, scrollY: 0 };
    const png = { isEmpty: () => false, getSize: () => ({ width: 2400, height: 1500 }), resize({ width }) { return { isEmpty: () => false, getSize: () => ({ width, height: Math.round(width * 1500 / 2400) }) }; } };
    const wc = {
      getZoomFactor: () => 1.25,
      capturePage: async () => { calls.capture++; return png; },
      executeJavaScriptInIsolatedWorld: async () => { calls.script++; return view; },
    };
    const agent = Object.assign(Object.create(Agent.prototype), { screenshotScale: null });
    const a = await agent.shotScaleFor(wc);
    check('no screenshot yet: one is made inside, and nothing is thrown', calls.capture === 1 && a.ratio > 0 && a.wc === wc);
    check('the ratio is view pixels (CSS x zoom) over image pixels, so the display scale cancels', Math.abs(a.ratio - (960 * 1.25) / 1280) < 1e-9, a.ratio);
    const b = await agent.shotScaleFor(wc);
    check('a second click reuses it (no new capture)', b === a && calls.capture === 1);
    view = { ...view, innerWidth: 720 }; // the sidebar opened: the view is narrower
    const c = await agent.shotScaleFor(wc);
    check('a resized view makes a fresh one, so the coordinates stay right', c !== a && calls.capture === 2 && Math.abs(c.ratio - (720 * 1.25) / 1280) < 1e-9, c.ratio);
    const stub = Object.assign(Object.create(Agent.prototype), { screenshotScale: { wc, ratio: 1 } });
    check('a scale without a recorded width is trusted as it is', (await stub.shotScaleFor(wc)).ratio === 1);
    const glance = await agent.afterClick({ getURL: () => 'https://x.test/b', executeJavaScriptInIsolatedWorld: async () => ({ title: 'B', focus: 'text field "Search"' }) }, { title: 'A', focus: '' }, 'https://x.test/a');
    check('the click result says the new address, the title and the focus', / Page is now https:\/\/x\.test\/b\./.test(glance) && /Title: .B./.test(glance) && /Focus: text field "Search"/.test(glance), glance);
    check('a click that changed nothing adds nothing', (await agent.afterClick({ getURL: () => 'u', executeJavaScriptInIsolatedWorld: async () => ({ title: 'A', focus: '' }) }, { title: 'A', focus: '' }, 'u')) === '');
    check('the glance script is valid JavaScript', (() => { try { new Function(`return ${scripts.glance}`); return true; } catch { return false; } })());
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
