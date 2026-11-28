// [humanize] Humanize in the app, hidden (LUMEN_TEST_BACKGROUND=1), with a mocked Anthropic client (no network):
//   - a text box: right-click "Humanize" shows the before and after, Replace puts the rewrite in place of the selection (the page hears
//     it as typing), and Undo on the toast puts the original back
//   - read-only text: the card has Copy (no Replace) and Copy puts the rewrite on the clipboard
//   - a reply's "Humanize" action shows the rewrite in its place with "Show original"; the chat's history keeps the original
//   - /humanize <text> and "humanize this:" with text show a card with the rewrite, and send nothing to the chat
//   - without a humanizer skill the card says Humanize needs it, with Open Settings → Skills
//   - every rewrite goes to the chat's own provider, on its cheaper model, with the humanizer skill's own instructions as the system prompt
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(60); } return v; };

const BOX_TEXT = 'Hi Sam, this is not just a fix, but a pivotal moment for the team — truly. I hope this helps!';
const BOX_REWRITE = 'Hi Sam, the fix is in.';
const PAGE_TEXT = 'Nestled in the heart of the valley, the town boasts breathtaking views.';
const PAGE_REWRITE = 'The town is in the valley and has good views.';
const REPLY = "It's not just fast, it's a game-changer. Additionally, it is crucial. I hope this helps!";
const REPLY_REWRITE = 'It is fast, and it matters.';
const PASTE = 'Let us delve into the tapestry of this pivotal and crucial launch, which stands as a testament to our team.';
const PASTE_REWRITE = 'The launch went well, thanks to the team.';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Compose</title><body><textarea id="box" rows="4" cols="80">${BOX_TEXT} Thanks, Ana</textarea><p id="para">${PAGE_TEXT}</p>
      <script>window.inputs = 0; document.getElementById('box').addEventListener('input', () => { window.inputs++; });</script></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-humanize-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.waitForSelector('#prompt');
    await app.evaluate(() => global.__patchSettings({ replySuggestions: false }));
    // The mock: a rewrite request (the editor's system prompt) answers by its text; the chat's own reply streams REPLY.
    await app.evaluate((_e, t) => {
      global.__hz = [];
      global.__main = 0;
      const rewrite = (user) => (user.includes('pivotal moment for the team') ? t.BOX_REWRITE : user.includes('Nestled') ? t.PAGE_REWRITE : user.includes('game-changer') ? t.REPLY_REWRITE : user.includes('tapestry') ? t.PASTE_REWRITE : 'unknown');
      const create = async (params) => {
        const user = String(params.messages?.[0]?.content || '');
        global.__hz.push({ model: params.model, system: String(params.system || ''), user, tools: params.tools ? params.tools.length : 0 });
        if (!/<skill name="humanizer"/.test(String(params.system || ''))) return { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
        return { role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: `<rewrite>${rewrite(user)}</rewrite>` }], usage: { input_tokens: 30, output_tokens: 8 } };
      };
      const stream = (params) => {
        global.__main++;
        const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: t.REPLY }], usage: { input_tokens: 20, output_tokens: 5 } };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t.REPLY } };
          },
          finalMessage: async () => message,
        };
      };
      global.__agent.getClient = () => ({ messages: { create }, beta: { messages: { stream } } });
    }, { BOX_REWRITE, PAGE_REWRITE, REPLY, REPLY_REWRITE, PASTE_REWRITE });

    // ======== a text box: Humanize, Replace, Undo
    const tab = await app.evaluate(async (_e, u) => {
      const t = global.__agent.browser.openTab(u);
      await new Promise((r) => { if (!t.webContents.isLoading()) r(); else t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
      return t.id;
    }, `${base}/compose`);
    await app.evaluate(() => { global.__menu = null; global.__captureContextMenu = (items) => { global.__menu = items; }; });
    const page = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c), [tab, code]);
    const overlay = (code) => app.evaluate((_e, [id, c]) => {
      const wc = global.__settings.contents(id);
      const view = global.__screenshot.overlay.viewFor(global.__screenshot.ctx(wc).win);
      return view ? view.webContents.executeJavaScript(c) : null;
    }, [tab, code]);
    const mode = () => app.evaluate((_e, id) => { const wc = global.__settings.contents(id); return global.__screenshot.overlay.currentFor(global.__screenshot.ctx(wc).win)?.mode || null; }, tab);
    const menuFor = (params) => app.evaluate((_e, [id, p]) => {
      const wc = global.__settings.contents(id);
      global.__menu = null;
      wc.emit('context-menu', { preventDefault() {} }, { x: 20, y: 20, selectionText: '', isEditable: false, mediaType: 'none', srcURL: '', linkURL: '', mediaFlags: {}, editFlags: {}, dictionarySuggestions: [], misspelledWord: '', frame: null, ...p });
      return (global.__menu || []).map((i) => i.label || i.role || i.type);
    }, [tab, params]);
    const clickItem = (label) => app.evaluate((_e, l) => { global.__menu.find((i) => i.label === l).click(); }, label);

    // ======== no humanizer skill yet: the card says so (this machine's ~/.claude/skills may hold one with the switch off: then it says to turn it on)
    await app.evaluate(() => { for (const s of global.__skills.store.list()) if (s.name === 'humanizer' || s.name === 'humanize') global.__skills.store.remove(s.id); });
    await page("(() => { const p = document.getElementById('para'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 1; })()");
    await menuFor({ isEditable: false, selectionText: PAGE_TEXT });
    await clickItem('Humanize');
    const needs = await waitFor(async () => (await mode()) === 'humanize' && /Humanize needs the humanizer skill/.test(await overlay("document.getElementById('m-sub').textContent")), 6000);
    const needButtons = await overlay("[...document.querySelectorAll('#m-buttons button')].map((b) => b.textContent).join('|')");
    check('no skill: the card says Humanize needs the humanizer skill, with Open Settings → Skills', needs && needButtons === 'Open Settings → Skills|Close', `${await overlay("document.getElementById('m-sub').textContent")} / ${needButtons}`);
    check('no skill: nothing was sent to a model', (await app.evaluate(() => global.__hz.length)) === 0, await app.evaluate(() => global.__hz.length));
    await overlay("document.querySelector('#m-buttons [data-id=close]').click()");
    await waitFor(async () => (await mode()) === null, 3000);
    // The user's skill, as Settings → Skills holds it: Humanize runs it as written.
    await app.evaluate(() => global.__skills.store.save({ name: 'humanizer', title: 'Humanizer', description: 'Rewrite AI-sounding text.', prompt: 'E2E-SKILL-MARKER: rewrite the text so it reads like the writer; keep every fact.', inputs: [] }));

    await page(`(() => { const b = document.getElementById('box'); b.focus(); b.setSelectionRange(0, ${BOX_TEXT.length}); return b.selectionEnd; })()`);
    const boxMenu = await menuFor({ isEditable: true, selectionText: BOX_TEXT });
    check('box: the menu has Humanize, with the editing items', boxMenu.includes('Humanize') && boxMenu.includes('paste'), boxMenu.join(' | '));
    await clickItem('Humanize');
    const shown = await waitFor(async () => (await mode()) === 'humanize' && (await overlay("document.getElementById('hz-after').textContent")) === BOX_REWRITE, 8000);
    check('box: a card shows the text before and after', shown && (await overlay("document.getElementById('hz-before').textContent")) === BOX_TEXT, await overlay("document.getElementById('hz').innerText"));
    const boxButtons = await overlay("[...document.querySelectorAll('#m-buttons button')].map((b) => b.textContent).join('|')");
    check('box: Replace (first), Copy and Cancel', boxButtons === 'Replace|Copy|Cancel', boxButtons);
    const sub = await overlay("document.getElementById('m-sub').textContent");
    check('box: the card says it ran your humanizer skill, and which model', /Your humanizer skill/.test(sub) && /By Claude Haiku/i.test(sub), sub);
    const req = (await app.evaluate(() => global.__hz)).filter((r) => /<skill name="humanizer"/.test(r.system));
    check('model: the rewrite went to the chat\'s provider on its cheaper model, no tools, the skill\'s own instructions as the system prompt', req.length === 1 && req[0].model === 'claude-haiku-5-5' && req[0].tools === 0 && /E2E-SKILL-MARKER: rewrite the text/.test(req[0].system) && req[0].user.includes(BOX_TEXT), JSON.stringify(req.map((r) => ({ model: r.model, tools: r.tools }))));
    await overlay("document.querySelector('#m-buttons [data-id=replace]').click()");
    const replaced = await waitFor(async () => (await page("document.getElementById('box').value")) === `${BOX_REWRITE} Thanks, Ana`, 5000);
    check('box: Replace puts the rewrite in place of the selection only', replaced, await page("document.getElementById('box').value"));
    check('box: the page heard it as typing (an input event)', (await page('window.inputs')) >= 1, await page('window.inputs'));
    const toast = await waitFor(async () => (await mode()) === 'toast' && /Replaced/.test(await overlay("document.getElementById('t-title').textContent")), 4000);
    check('box: a toast says so and offers Undo', toast && (await overlay("document.querySelector('#t-buttons button')?.textContent")) === 'Undo', await overlay("document.getElementById('toast').innerText"));
    await overlay("document.querySelector('#t-buttons button').click()");
    const undone = await waitFor(async () => (await page("document.getElementById('box').value")) === `${BOX_TEXT} Thanks, Ana`, 5000);
    check('box: Undo puts the original back', undone, await page("document.getElementById('box').value"));

    // ======== read-only text: Copy
    await page("(() => { const p = document.getElementById('para'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()");
    const paraMenu = await menuFor({ isEditable: false, selectionText: PAGE_TEXT });
    check('page text: the menu has Humanize next to Ask AI', paraMenu.includes('Humanize') && paraMenu.indexOf('Humanize') === paraMenu.indexOf('Ask AI about selection') + 1, paraMenu.join(' | '));
    await clickItem('Humanize');
    const paraShown = await waitFor(async () => (await mode()) === 'humanize' && (await overlay("document.getElementById('hz-after').textContent")) === PAGE_REWRITE, 8000);
    const paraButtons = await overlay("[...document.querySelectorAll('#m-buttons button')].map((b) => b.textContent).join('|')");
    check('page text: the card has Copy and Close, no Replace', paraShown && paraButtons === 'Copy|Close', paraButtons);
    await overlay("document.querySelector('#m-buttons [data-id=copy]').click()");
    const copied = await waitFor(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === PAGE_REWRITE, 3000);
    check('page text: Copy puts the rewrite on the clipboard', copied, await app.evaluate(({ clipboard }) => clipboard.readText()));
    await overlay("document.querySelector('#m-buttons [data-id=close]').click()");
    check('page text: Close closes the card', await waitFor(async () => (await mode()) === null, 3000));
    check('page text: the page itself is untouched', (await page("document.getElementById('para').textContent")) === PAGE_TEXT);
    await app.evaluate(() => { global.__captureContextMenu = null; });

    // ======== a reply's Humanize action
    await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });
    await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden')));
    await ui.fill('#prompt', 'is it fast?');
    await ui.press('#prompt', 'Enter');
    const hasButton = await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('#messages .msg.assistant .reply-meta .reply-humanize')) && !document.body.classList.contains('agent-active')), 10000);
    check('reply: a finished reply has a Humanize action in its strip', hasButton, await ui.evaluate(() => document.getElementById('messages').innerHTML.slice(-600)));
    await ui.click('#messages .msg.assistant .reply-humanize');
    const swapped = await waitFor(() => ui.evaluate((want) => { const b = [...document.querySelectorAll('#messages .msg.assistant')].pop(); const fresh = b?.querySelector('.hz-text'); return fresh && !fresh.hidden && fresh.textContent.trim() === want && b.querySelector('.hz-original')?.hidden === true; }, REPLY_REWRITE), 8000);
    check('reply: the rewrite shows in place of the reply, the original hidden', swapped, await ui.evaluate(() => [...document.querySelectorAll('#messages .msg.assistant')].pop()?.innerText));
    const note = await ui.evaluate(() => [...document.querySelectorAll('#messages .msg.assistant')].pop()?.querySelector('.hz-note')?.textContent || '');
    check('reply: a line says it was humanized, by which model, with Show original', /Humanized by Claude Haiku/i.test(note) && /Show original/.test(note), note);
    await ui.click('#messages .msg.assistant .hz-swap');
    const back = await ui.evaluate((want) => { const b = [...document.querySelectorAll('#messages .msg.assistant')].pop(); return b.querySelector('.hz-original').hidden === false && b.querySelector('.hz-text').hidden === true && b.querySelector('.hz-original').textContent.includes(want); }, "It's not just fast");
    check('reply: Show original switches back', back);
    const history = await app.evaluate(() => JSON.stringify(global.__agent.messages));
    check('reply: the chat\'s history keeps the reply as written', history.includes('game-changer') && !history.includes(REPLY_REWRITE), history.slice(0, 300));

    // ======== /humanize <text>
    const mainBefore = await app.evaluate(() => global.__main);
    await ui.fill('#prompt', `/humanize ${PASTE}`);
    await ui.press('#prompt', 'Enter');
    const card = await waitFor(() => ui.evaluate((want) => [...document.querySelectorAll('#messages .hz-card')].some((c) => c.querySelector('.hz-card-body')?.textContent.trim() === want), PASTE_REWRITE), 8000);
    check('/humanize: a card with the rewrite and Copy', card && await ui.evaluate(() => Boolean(document.querySelector('#messages .hz-card .hz-copy'))), await ui.evaluate(() => document.querySelector('#messages .hz-card')?.innerText));
    const pasteReq = (await app.evaluate(() => global.__hz)).filter((r) => /<skill name="humanizer"/.test(r.system)).pop();
    check('/humanize: the pasted text was sent as pasted text', pasteReq && pasteReq.user.includes(PASTE) && /pasted by the user/.test(pasteReq.system));

    // ======== "humanize this:" with the text on the next line
    await ui.evaluate(() => { for (const c of document.querySelectorAll('#messages .hz-card')) c.remove(); });
    await ui.fill('#prompt', `humanize this:\n${PASTE}`);
    await ui.press('#prompt', 'Enter');
    const card2 = await waitFor(() => ui.evaluate((want) => [...document.querySelectorAll('#messages .hz-card')].some((c) => c.querySelector('.hz-card-body')?.textContent.trim() === want), PASTE_REWRITE), 8000);
    check('"humanize this": the same card', card2);
    check('neither command sent a message to the chat', (await app.evaluate(() => global.__main)) === mainBefore && !(await app.evaluate(() => JSON.stringify(global.__agent.messages))).includes('tapestry'), await app.evaluate(() => global.__main));
    check('the prompt box is empty again', (await ui.evaluate(() => document.getElementById('prompt').value)) === '');
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
