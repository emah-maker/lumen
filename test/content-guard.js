// Content guard, in a hidden Lumen with local fixtures (src/ai/content-guard.js): the AI's typing, scripts and Delete clicks on a
// big editor are measured; what they take out is asked about before (type over a field, a script that assigns innerHTML) or put
// back and asked about after; text the AI typed itself never asks; Bypass logs a step and asks nothing; "Undo the AI's edits"
// puts a field or editor back; verify_changes reports the real numbers.
// Run: LUMEN_TEST_BACKGROUND=1 node test/content-guard.js
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };

  const words = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} of the user's own long document.`).join(' ');
  const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const page = `<title>Editor</title>
<div id="doc" contenteditable="true" aria-label="Document"><h1>Title</h1><p>${words}</p><p><img id="i1" src="${gif}" width="20" height="20"><img id="i2" src="${gif}" width="20" height="20"></p><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table></div>
<button id="delimg" onclick="document.getElementById('i1').remove()">Delete image</button>
<label>Notes <textarea id="notes">original text</textarea></label>`;
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(page); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = (n) => `http://127.0.0.1:${server.address().port}/?${n}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-content-guard-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(() => {
    const agent = global.__agent;
    agent.browser.effectiveModel = (m) => m;
    const base = agent.getOptions;
    agent.getOptions = () => ({ ...base(), pageContext: true });
  });

  // One sidebar run with a fake Claude asking for `toolUses` in order. `answers`: what the content cards get (true = go ahead / keep).
  const run = (opts) => app.evaluate(async (_e, { toolUses, startUrl, answers = [], bypass = false, prepare = '' }) => {
    const agent = global.__agent;
    agent.reset();
    const tab = agent.browser.activeTab();
    await tab.webContents.loadURL(startUrl).catch(() => {});
    for (let i = 0; i < 100 && tab.webContents.getURL() !== startUrl; i++) await new Promise((r) => setTimeout(r, 50));
    if (prepare) await tab.webContents.executeJavaScript(prepare);
    agent.browser.bypassPermissions = () => bypass;
    agent.messages.settings = { model: 'claude-opus-5', adhdMode: true };
    let turn = 0;
    agent.getClient = () => ({ beta: { messages: { stream: () => {
      const t = turn++;
      const message = t < toolUses.length
        ? { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${t}`, name: toolUses[t].name, input: toolUses[t].input }] }
        : { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
      return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
    } } } });
    const events = [];
    const queue = [...answers];
    await agent.run('edit the page', (e) => {
      events.push(e);
      if (e.type === 'approval') setTimeout(() => agent.resolveApproval(e.approvalId, e.action === 'content-loss' ? (queue.length ? queue.shift() : true) : true), 0);
    });
    const results = agent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ error: Boolean(b.is_error), text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content).slice(0, 1500) }));
    agent.browser.bypassPermissions = () => false;
    return { results, events, done: events.find((e) => e.type === 'done') };
  }, opts);
  const state = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript(`({
    chars: document.getElementById('doc').innerText.length, images: document.querySelectorAll('#doc img').length, tables: document.querySelectorAll('#doc table').length,
    notes: document.getElementById('notes').value })`));
  const cards = (r) => r.events.filter((e) => e.type === 'approval' && e.action === 'content-loss');
  const field = (label, value) => ({ name: 'fill_form', input: { fields: [{ label, value }] } });

  const start = await (async () => { await run({ toolUses: [], startUrl: url('base') }); return state(); })();
  check('fixture: the editor has text, images and a table', start.chars > 2500 && start.images === 2 && start.tables === 1, JSON.stringify(start));

  // 1. Typing over the big editor asks BEFORE acting
  let r = await run({ startUrl: url('a'), answers: [false], toolUses: [field('Document', 'Short replacement')] });
  let s = await state();
  check('type over a big editor: a card comes first (before the change)', cards(r).length === 1 && cards(r)[0].phase === 'before' && /image/.test(cards(r)[0].title), JSON.stringify(cards(r)));
  check('type over a big editor: refused, nothing changed', s.chars === start.chars && s.images === 2 && s.tables === 1, JSON.stringify(s));
  check('type over a big editor: the model is told not to work around it', r.results.some((x) => /did not allow/.test(x.text)), JSON.stringify(r.results));

  // 2. A script that assigns innerHTML: carded before
  r = await run({ startUrl: url('b'), answers: [false], toolUses: [{ name: 'run_script', input: { code: "document.getElementById('doc').innerHTML = ''" } }] });
  s = await state();
  check('script innerHTML wipe: carded before it runs', cards(r).length === 1 && cards(r)[0].phase === 'before' && s.images === 2, JSON.stringify({ c: cards(r), s }));

  // 3. A wipe the pre-check can't read: caught after, undone, carded
  const sneaky = "const d = document.getElementById('doc'); d['inner' + 'HTML'] = '';";
  r = await run({ startUrl: url('c'), answers: [false], toolUses: [{ name: 'run_script', input: { code: sneaky } }] });
  s = await state();
  check('script wipe: caught after, put back and carded', cards(r).length === 1 && cards(r)[0].phase === 'after' && cards(r)[0].undone === true, JSON.stringify(cards(r)));
  check('script wipe: "Undo it" leaves the editor as it was (text, images, table)', s.chars === start.chars && s.images === 2 && s.tables === 1, JSON.stringify(s));
  r = await run({ startUrl: url('c2'), answers: [true], toolUses: [{ name: 'run_script', input: { code: sneaky } }] });
  s = await state();
  check('script wipe: "Keep the change" keeps it', cards(r).length === 1 && s.chars === 0 && s.images === 0, JSON.stringify(s));

  // 4. An image removed by a Delete click
  r = await run({ startUrl: url('d'), answers: [false], toolUses: [{ name: 'click', input: { text: 'Delete image' } }] });
  s = await state();
  check('removing an image is caught, and put back', cards(r).length === 1 && /1 image/.test(cards(r)[0].title) && s.images === 2, JSON.stringify({ c: cards(r), s }));

  // 5. Text the AI typed itself never cards
  const a = 'alpha '.repeat(100), b = 'beta '.repeat(100);
  r = await run({ startUrl: url('e'), toolUses: [field('Notes', a), field('Notes', b), { name: 'run_script', input: { code: "document.getElementById('notes').value = ''" } }] });
  check('its own typed text: editing or removing it never cards', cards(r).length === 0 && !r.results.some((x) => x.error), JSON.stringify({ c: cards(r), r: r.results }));

  // 6. Bypass: no card, a step, nothing undone, and Undo still works
  r = await run({ startUrl: url('f'), bypass: true, toolUses: [{ name: 'run_script', input: { code: sneaky } }] });
  s = await state();
  check('bypass: no card, but a step says what was allowed', cards(r).length === 0 && r.events.some((e) => e.type === 'tool' && e.name === 'auto_allowed' && /removed/i.test(e.label)), JSON.stringify(r.events.filter((e) => e.type === 'tool').map((e) => e.label)));
  check('bypass: the change stands and the reply offers undo', s.chars === 0 && r.done?.undo?.edits >= 1, JSON.stringify({ s, undo: r.done?.undo }));
  const undone = await app.evaluate((_e, id) => global.__agent.undoEdits(id), r.done?.undo?.id);
  s = await state();
  check('undo the AI\'s edits: the editor is back, images and table too', undone.ok && s.chars === start.chars && s.images === 2 && s.tables === 1, JSON.stringify({ undone, s }));

  // 7. Undo restores a textarea, and verify_changes reports real numbers
  r = await run({ startUrl: url('g'), toolUses: [field('Notes', 'rewritten by the AI'), { name: 'verify_changes', input: {} }] });
  const report = r.results[r.results.length - 1]?.text || '';
  check('verify_changes: reports the field before and after', /text field\): text 13 → 19 characters/.test(report) && /added/.test(report), report);
  s = await state();
  check('the edit happened', s.notes === 'rewritten by the AI', s.notes);
  const back = await app.evaluate((_e, id) => global.__agent.undoEdits(id), r.done?.undo?.id);
  s = await state();
  check('undo the AI\'s edits: a text field goes back', back.ok && s.notes === 'original text', JSON.stringify({ back, s }));
  const twice = await app.evaluate((_e, id) => global.__agent.undoEdits(id), r.done?.undo?.id);
  check('undo the AI\'s edits: only once', twice.ok === false);

  // 8. verify_changes when nothing was edited
  r = await run({ startUrl: url('h'), toolUses: [{ name: 'verify_changes', input: {} }] });
  check('verify_changes: nothing edited says so', /nothing to compare/.test(r.results[0]?.text || ''), JSON.stringify(r.results));

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
