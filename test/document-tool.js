// The `document` tool in the real app (ai/document-tool.js), hidden windows (LUMEN_TEST_BACKGROUND=1), temp profile, no network.
// Against test/fixtures/docs-like.js, a page that mimics Google Docs' keyboard (Find, Find and replace, styles, paragraph selection) and
// serves its export a moment after each edit. Checks the things the real failure got wrong: moving a section keeps every picture, table and
// equation; styles and replace work; formatted text pastes as real formatting; verify catches a loss and never says "unchanged" without
// checking; undo puts the document back; and selecting everything then typing, or deleting a selection with pictures, asks first.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const fx = require('./fixtures/docs-like');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The export lags an edit by 300 ms, like a saved copy.
  let saved = { txt: '', html: fx.DOC_HTML };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (type, body, status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    if (u.pathname === '/document/d/FIXDOC1/edit') return send('text/html; charset=utf-8', fx.PAGE(fx.DOC_HTML));
    if (u.pathname === '/document/d/FIXDOC1/export') {
      return u.searchParams.get('format') === 'html' ? send('text/html; charset=utf-8', `<html><body>${saved.html}</body></html>`) : send('text/plain; charset=utf-8', saved.txt.replace(/\n/g, '\r\n'));
    }
    if (u.pathname === '/sync' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { const v = JSON.parse(body); setTimeout(() => { saved = v; }, 300); res.writeHead(204); res.end(); });
      return;
    }
    send('text/html', '<title>Other</title>', 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-doctool-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: path.join(dir, 'profile'), TEMP: dir, TMP: dir, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const tabId = await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-stop-loading', r)); return t.id; }, `${base}/document/d/FIXDOC1/edit`);
  await sleep(800);

  // One long-lived sidebar-like run (so the snapshot and the undo count live as they do in a chat): steps are queued into it. Each goes
  // through ensureAllowed (the site approval answered by noAsk) and execute. A card is answered with the current `answer` and recorded.
  const start = () => app.evaluate((_e, id) => {
    const agent = global.__agent;
    const R = (global.__run = { jobs: [], results: {}, cards: [], answer: true, stop: false, n: 0 });
    const signal = new AbortController().signal;
    const m = []; m.settings = { model: 'claude-opus-5' };
    const emit = (ev) => { if (ev.type === 'approval') { R.cards.push(ev.title || ev.host); setTimeout(() => agent.pendingApprovals.get(ev.approvalId)?.(R.answer), 5); } };
    const hosts = new Set();
    R.done = agent.inTask(id, signal, async () => {
      while (!R.stop) {
        const j = R.jobs.shift();
        if (!j) { await new Promise((r) => setTimeout(r, 20)); continue; }
        try {
          await agent.ensureAllowed(j.name, emit, signal, { hosts, who: 'Claude', noAsk: true, input: j.input });
          const r = await agent.execute(j.name, j.input);
          R.results[j.id] = typeof r === 'string' ? r : JSON.stringify(r);
        } catch (e) { R.results[j.id] = `ERROR: ${e.message}`; }
      }
    }, m);
  }, tabId);
  const step = async (name, input, answer = true) => {
    const id = await app.evaluate((_e, a) => { const R = global.__run; R.answer = a.answer; R.cards = []; const id = ++R.n; R.jobs.push({ id, name: a.name, input: a.input }); return id; }, { name, input, answer });
    for (let i = 0; i < 600; i++) {
      const got = await app.evaluate((_e, k) => ({ r: global.__run.results[k], cards: global.__run.cards }), id);
      if (got.r !== undefined) return { out: got.r, cards: got.cards };
      await sleep(100);
    }
    throw new Error(`step ${name} timed out`);
  };
  const finish = () => app.evaluate(async () => { global.__run.stop = true; await global.__run.done; });
  const doc = (code) => app.evaluate((_e, [id, c]) => global.__agent.browser.tabById(id).webContents.executeJavaScript(c), [tabId, code]);
  const heads = () => doc("[...document.querySelectorAll('#doc h1,#doc h2,#doc h3')].map(h => h.tagName + ':' + h.textContent)");
  const counts = () => doc("({ img: document.querySelectorAll('#doc img:not([data-math])').length, eq: document.querySelectorAll('#doc img[data-math]').length, tbl: document.querySelectorAll('#doc table').length, words: (document.getElementById('doc').innerText.match(/[A-Za-z0-9]+/g) || []).length })");
  const html0 = await doc("document.getElementById('doc').innerHTML");
  const c0 = await counts();
  const reset = async () => { await doc(`(() => { document.getElementById('doc').innerHTML = ${JSON.stringify(html0)}; document.getElementById('doc').focus(); })()`); await sleep(900); };
  check('fixture: 3 pictures, 1 equation, 1 table', c0.img === 3 && c0.eq === 1 && c0.tbl === 1, JSON.stringify(c0));
  const ORIGINAL = 'H1:Abstract|H1:Methods|H2:Setup|H1:Results|H1:Discussion';

  // ---- one run: outline, two moves, a style, a replace, an insert, verify, then undo everything
  await start();
  let r = await step('document', { action: 'outline' });
  check('outline: headings with levels and the whole-document counts', /H1 Abstract/.test(r.out) && /H2 Setup/.test(r.out) && /3 images, 1 tables, 1 equations/.test(r.out), r.out);

  r = await step('document', { action: 'move_section', heading: 'Results', where: 'before', to: 'Methods' });
  let h = await heads();
  let c = await counts();
  check('move_section: the headings are in the new order', h.join('|') === 'H1:Abstract|H1:Results|H1:Methods|H2:Setup|H1:Discussion', `${h.join('|')} / ${r.out}`);
  check('move_section: every picture, equation and table came with it, and no words were lost (cut and paste, no retyping)', c.img === 3 && c.eq === 1 && c.tbl === 1 && c.words === c0.words, JSON.stringify(c));
  check('move_section: the result says it was checked against the version before the edits', /same words, same pictures, tables and equations/.test(r.out), r.out);

  r = await step('document', { action: 'move_section', heading: 'Abstract', where: 'after', to: 'Discussion' });
  h = await heads();
  c = await counts();
  check('move_section after the last section: it ends the document, the counts are the same', h[h.length - 1] === 'H1:Abstract' && h[0] === 'H1:Results' && c.img === 3 && c.eq === 1 && c.tbl === 1, `${h.join('|')} ${JSON.stringify(c)} / ${r.out}`);

  r = await step('document', { action: 'style', heading: 'Setup', style: 'Heading 3' });
  h = await heads();
  check('style: Setup becomes a Heading 3 (Ctrl+Alt+3)', h.includes('H3:Setup') && !h.includes('H2:Setup'), `${h.join('|')} / ${r.out}`);

  r = await step('document', { action: 'replace', find: 'constant', replace: 'stiffness', all: true });
  const text = await doc("document.getElementById('doc').textContent");
  check('replace all: the editor\'s Find and replace changed every match, the pictures and table are untouched', !/constant/i.test(text) && /spring stiffness/.test(text) && /Replaced all/.test(r.out) && (await counts()).img === 3 && (await counts()).tbl === 1, r.out);

  r = await step('document', { action: 'insert_markdown', text: '## Appendix\n\nExtra **notes** here.', where: 'end' });
  h = await heads();
  check('insert_markdown: a real heading and bold, not literal # or **', h.includes('H2:Appendix') && (await doc("document.querySelectorAll('#doc b,#doc strong').length")) >= 1 && !/##|\*\*/.test(await doc("document.getElementById('doc').textContent")), `${h.join('|')} / ${r.out}`);

  r = await step('document', { action: 'verify' });
  check('verify: after the edits it checks out against the snapshot from before the first one', /same words/.test(r.out) && /my edits so far/.test(r.out), r.out);

  r = await step('document', { action: 'undo' });
  h = await heads();
  c = await counts();
  check('undo: all my edits are taken back, to the order and styles at the start', h.join('|') === ORIGINAL, `${h.join('|')} / ${r.out}`);
  check('undo: the pictures, table and words match the start, and the answer says so', c.img === 3 && c.eq === 1 && c.tbl === 1 && c.words === c0.words && /matches the version from before/.test(r.out), `${JSON.stringify(c)} / ${r.out}`);

  // ---- a drop in the middle of the same run is caught by verify (an edit made outside the tool, as the real failure was)
  await doc("(() => { document.querySelector('#doc img').closest('p').remove(); })()");
  await sleep(900);
  r = await step('document', { action: 'verify' });
  check('verify: a dropped picture is named, not reported as unchanged, and restoring is offered', /images: 3 before, 2 now/.test(r.out) && !/same words/.test(r.out) && /restore|undo/.test(r.out), r.out);
  await finish();

  // ---- select-all then a key is the whole-document retype: it asks, and when the user says no nothing changes
  await reset();
  await start();
  await step('press_key', { key: 'a', modifiers: ['control'] });
  r = await step('press_key', { key: 'x' }, false);
  let cR = await counts();
  check('select-all then a key asks first (the card says it removes the whole document)', r.cards.length === 1 && /whole document|100% of the document/i.test(r.cards[0]), JSON.stringify(r));
  check('and when the user says no, the document is untouched', /did not allow replacing the whole document/.test(r.out) && cR.img === 3 && cR.tbl === 1 && cR.words === c0.words, `${r.out} ${JSON.stringify(cR)}`);
  await finish();

  // ---- a Delete over a selection that holds a picture asks, and says what would be lost
  await reset();
  await start();
  await doc("(() => { const p = document.querySelector('#doc img').closest('p'); const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNode(p); s.addRange(r); })()");
  r = await step('press_key', { key: 'Delete' }, false);
  check('Delete over a picture asks first (1 image)', r.cards.length === 1 && /1 image/.test(r.cards[0]), JSON.stringify(r));
  check('and the picture is still there when the user says no', (await counts()).img === 3, JSON.stringify(await counts()));
  await finish();

  // ---- insert_markdown with everything selected is refused (it would replace the whole text)
  await reset();
  await start();
  await step('press_key', { key: 'a', modifiers: ['control'] });
  r = await step('document', { action: 'insert_markdown', text: '# Replacement' });
  cR = await counts();
  check('insert_markdown over a select-all is refused, nothing changed', /Replacing the whole document/.test(r.out) && cR.img === 3 && cR.words === c0.words, `${r.out} ${JSON.stringify(cR)}`);
  await finish();

  await Promise.race([app.close().catch(() => {}), sleep(6000)]);
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
