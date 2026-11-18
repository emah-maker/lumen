// [stable ids] [agent cursors] Several agents on one page: a read of the same page keeps the ids it gave before (one agent's read never
// renumbers what another is about to click), and a helper's or sub-agent's click shows its own colored cursor with its name. Also:
// acting helpers ship on (0.5.103). Local page, no network. Temp profile, hidden window.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const PAGE = `<!doctype html><title>shared</title><body>
<button id="a" onclick="log('a')">Alpha</button> <button id="b" onclick="log('b')">Bravo</button> <button id="c" onclick="log('c')">Charlie</button>
<input id="f" aria-label="Notes"><pre id="log"></pre>
<script>function log(x){document.getElementById('log').textContent+=x;}</script></body>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cursors-profile-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    for (let attempt = 0; attempt < 4; attempt++) {
      const ok = await app.evaluate(async (_e, u) => {
        global.__agent.browser.autoApprove = () => true;
        const wc = global.__agent.browser.activeTab().webContents;
        for (let i = 0; i < 100 && wc.isLoading(); i++) await new Promise((r) => setTimeout(r, 50));
        try { await wc.loadURL(u); return true; } catch { return false; }
      }, base);
      if (ok) break;
    }
    const page = (js) => app.evaluate(async (_e, code) => global.__agent.browser.activeTab().webContents.executeJavaScript(code), js);
    const tool = (name, input, tag = null) => app.evaluate(async (_e, a) => {
      const agent = global.__agent;
      const tags = process.mainModule.require('./src/features/agent-tags');
      const signal = new AbortController().signal;
      const m = []; m.settings = { model: 'claude-opus-5' };
      const id = agent.browser.activeTab().id;
      try {
        const out = await agent.inTask(id, signal, () => tags.run(a.tag, () => agent.execute(a.name, a.input)), m, null, { chatId: global.__chats.id(), hosts: new Set(['127.0.0.1']) });
        return { ok: true, out: typeof out === 'string' ? out : JSON.stringify(out) };
      } catch (e) { return { ok: false, error: e.message }; }
    }, { name, input, tag });

    check('acting helpers are on by default', await app.evaluate(() => global.__agent.actingHelpersOn()) === true);

    // ---- stable ids
    let r = await tool('read_page', { mode: 'compact' });
    const idOf = (out, label) => { const m = String(out).match(new RegExp('\\[(\\d+)\\][^\\[\\n]*"' + label + '"')); return m ? Number(m[1]) : null; };
    const a1 = idOf(r.out, 'Alpha'); const b1 = idOf(r.out, 'Bravo'); const c1 = idOf(r.out, 'Charlie');
    check('first read lists the buttons', r.ok && a1 && b1 && c1, r.out || r.error);
    await page(`(() => { const n = document.createElement('button'); n.textContent = 'Zulu'; n.onclick = () => log('z'); document.body.prepend(n); document.getElementById('b').remove(); })()`);
    r = await tool('read_page', { mode: 'compact' });
    const a2 = idOf(r.out, 'Alpha'); const c2 = idOf(r.out, 'Charlie'); const z2 = idOf(r.out, 'Zulu');
    check('a second read keeps Alpha and Charlie at their ids, though a button was added above them and one removed', a1 && a2 === a1 && c2 === c1, JSON.stringify({ a1, c1, a2, c2 }));
    check('the new button gets a new id after the old ones', z2 && z2 > Math.max(a1, b1, c1), JSON.stringify({ z2 }));
    check('the removed button is not listed', !/Bravo/.test(r.out));
    r = await tool('click', { element_id: c1 });
    check('an id from before the other read still clicks the same button', r.ok && (await page('document.getElementById("log").textContent')) === 'c', JSON.stringify(r));
    r = await tool('click', { element_id: b1 });
    check('the removed button\'s id fails, never clicks another element', !r.ok && (await page('document.getElementById("log").textContent')) === 'c', JSON.stringify(r));

    // ---- agent cursors
    const tagA = { key: 'cc:toolu_A', n: 1, label: 'Helper 1', color: '#ff375f' };
    const tagB = { key: 'cx:thread_B', n: 2, label: 'Helper 2', color: '#30d158' };
    r = await tool('click', { element_id: a1 }, tagA);
    await new Promise((res) => setTimeout(res, 300));
    const cursors = () => page(`(() => { const h = document.getElementById('__lumen-agent-cursors'); if (!h || !h.shadowRoot) return []; return [...h.shadowRoot.querySelectorAll('.c')].map((c) => ({ key: c.dataset.key, label: c.querySelector('span').textContent, color: c.querySelector('path').getAttribute('fill'), t: c.style.transform, pe: getComputedStyle(h).pointerEvents })); })()`);
    let cs = await cursors();
    check('a helper\'s click shows its cursor with its name and color', r.ok && cs.length === 1 && cs[0].label === 'Helper 1' && cs[0].color === '#ff375f', JSON.stringify(cs));
    check('the cursor never takes the page\'s clicks', cs[0]?.pe === 'none');
    r = await tool('type_text', { element_id: idOf((await tool('read_page', { mode: 'compact' })).out, 'Notes'), text: 'hi' }, tagB);
    await new Promise((res) => setTimeout(res, 300));
    cs = await cursors();
    check('a second agent gets a second cursor in its own color', r.ok && cs.length === 2 && cs.some((c) => c.label === 'Helper 2' && c.color === '#30d158'), JSON.stringify(cs));
    const before = cs.find((c) => c.key === tagA.key).t;
    await tool('click', { element_id: c1 }, tagA);
    await new Promise((res) => setTimeout(res, 300));
    cs = await cursors();
    check('the same agent\'s next click moves its one cursor', cs.length === 2 && cs.find((c) => c.key === tagA.key).t !== before, JSON.stringify(cs));
    await tool('click', { element_id: a1 });
    cs = await cursors();
    check('the lead agent\'s own click adds no cursor', cs.length === 2, JSON.stringify(cs));
  } catch (e) {
    failures++;
    console.log(`FAIL  threw: ${e.stack || e}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
