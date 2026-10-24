// The sidebar's Helpers row (More menu): Off / Auto / On, in a real window. A new profile starts on Auto; a click cycles Auto -> On -> Off -> Auto,
// the saved setting and the agent follow, and a change made in Settings reaches the row. A profile that saved true / false before Auto existed
// keeps meaning On / Off. Run with LUMEN_TEST_BACKGROUND=1 (hidden), through scripts/test/e2e-lock.js.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

async function session(profile, fn) {
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await fn(app, ui);
  } finally { await app.close().catch(() => {}); }
}

(async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-helpers-auto-'));
  await session(fresh, async (app, ui) => {
    const row = () => ui.evaluate(() => { const b = document.getElementById('helpers-btn'); return { state: document.getElementById('helpers-state')?.textContent, checked: b?.getAttribute('aria-checked'), title: b?.title || '' }; });
    const saved = () => app.evaluate(() => global.__settings.backend.prefs().aiSubagents);
    const agentMode = () => app.evaluate(() => global.__agent.subagentsMode());
    const click = () => ui.evaluate(() => document.getElementById('helpers-btn').click());

    await waitFor(async () => (await row()).state === 'Auto');
    let r = await row();
    check('a new profile starts on Auto: the row says Auto, is "mixed", and the title explains it', r.state === 'Auto' && r.checked === 'mixed' && /auto/i.test(r.title), JSON.stringify(r));
    check('...the saved setting and the agent are Auto', (await saved()) === 'auto' && (await agentMode()) === 'auto', JSON.stringify([await saved(), await agentMode()]));

    await click();
    await waitFor(async () => (await row()).state === 'On');
    r = await row();
    check('a click: On (checked), saved, and the agent follows', r.state === 'On' && r.checked === 'true' && (await saved()) === 'on' && (await agentMode()) === 'on', JSON.stringify([r, await saved(), await agentMode()]));

    await click();
    await waitFor(async () => (await row()).state === 'Off');
    r = await row();
    check('another click: Off (unchecked), saved, and the agent follows', r.state === 'Off' && r.checked === 'false' && (await saved()) === 'off' && (await agentMode()) === 'off', JSON.stringify([r, await saved(), await agentMode()]));

    await click();
    await waitFor(async () => (await row()).state === 'Auto');
    r = await row();
    check('one more click: back to Auto', r.state === 'Auto' && (await saved()) === 'auto' && (await agentMode()) === 'auto', JSON.stringify([r, await saved()]));

    await app.evaluate(() => global.__settings.backend.set('aiSubagents', 'off'));
    await waitFor(async () => (await row()).state === 'Off');
    check('a change made in Settings reaches the row', (await row()).state === 'Off', JSON.stringify(await row()));
    const refused = await app.evaluate(async () => { try { await global.__settings.backend.set('aiSubagents', 'sometimes'); return false; } catch { return true; } });
    check('a value that is not off / auto / on is refused', refused === true && (await saved()) === 'off');
  });

  // a profile from before Auto: true / false were saved by hand in settings.json
  for (const [old, label, want] of [[true, 'On', 'on'], [false, 'Off', 'off']]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-helpers-old-'));
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ aiSubagents: old }));
    await session(profile, async (app, ui) => {
      await waitFor(async () => (await ui.evaluate(() => document.getElementById('helpers-state')?.textContent)) === label);
      const state = await ui.evaluate(() => document.getElementById('helpers-state')?.textContent);
      check(`an older profile with ${old} keeps it: the row says ${label} and the agent is ${want}`, state === label && (await app.evaluate(() => global.__agent.subagentsMode())) === want, state);
    });
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
