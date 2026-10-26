// The AI reads Canvas the way a person does: through Canvas's own pages in a background tab, never its JSON API (features/connectors/canvas-pages.js,
// agent.js runCanvasPages). A stand-in Canvas on 127.0.0.1 (test/fixtures/fake-connectors.js) serves the pages, a fake Claude asks for the
// connector tool through the real sidebar chat, and this checks:
//  - the answer is the pages' text, starting with the address read (the calendar fills itself in 400 ms after it loads: it is waited for), the
//    course list gives the current courses only, announcements with no course read each course's page in the same tab;
//  - no /api/ request was made after connecting (the connect-time check of who is signed in is the one API call);
//  - the pages load in a tab the AI opened (an AI tab) that is NOT the one in front, and the user's own tab stays where it was;
//  - the chat's step is a Browser card for that tab (data-surface browser, "Reading Canvas · …", the tab's name, Go to tab), and Go to tab shows it;
//  - signed out: the school's sign-in page is what loads, the AI is told to ask the user to sign in, the card says Needs sign-in, and the tab stays on
//    the sign-in page for the user; signing in and asking again is Connected again.
// Hidden window (LUMEN_TEST_BACKGROUND=1), a throwaway profile, no network. Run under the lock:
//   P=$(mktemp -d) && CLAUDE_BROWSER_TEST=1 LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_PROFILE="$P" node scripts/test/e2e-lock.js run -- node test/e2e/canvas-pages.js
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakes } = require('../fixtures/fake-connectors');
const { openSettingsTab } = require('../helpers/settings-tab');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

async function main() {
  const root = path.join(__dirname, '..', '..');
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(root, 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const fakes = await startFakes();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-pages-'));
  const app = await electron.launch({
    args: [root],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('closeAiTabs', 'off'); }); // (the AI's tabs stay open after the run, so this test can look at them)
    const ui = await app.firstWindow({ timeout: 90000 });
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await app.evaluate(async (_e, urls) => {
      global.__connectorEndpoints = { canvas: urls.canvas };
      const agent = global.__agent;
      agent.browser.effectiveModel = (m) => m;
      const base = agent.getOptions;
      agent.getOptions = () => ({ ...base(), pageContext: false });
      // A fake Claude that asks for global.__script.toolUses one by one (each answer is read from the chat's history), then ends.
      agent.getClient = () => ({ beta: { messages: { stream: () => {
        const s = global.__script;
        const t = s.turn++;
        const message = t < s.toolUses.length
          ? { role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${s.run}_${t}`, name: 'connector', input: s.toolUses[t] }] }
          : { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
        return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
      } } } });
    }, fakes.urls);
    await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
    await sleep(500);

    const status = () => app.evaluate(() => global.__connectors.list().connectors.find((c) => c.id === 'canvas').statusText);
    const inSettings = await openSettingsTab(app, 'apps');
    await waitFor(async () => (await inSettings("Boolean(document.getElementById('conn-canvas-domain'))")) === true);
    await inSettings("document.getElementById('conn-canvas-domain').value = 'school.instructure.com'; document.getElementById('conn-canvas-connect').click(); true");
    await waitFor(async () => (await status()) === 'Needs sign-in');
    const userTab = await app.evaluate(() => global.__agent.browser.activeTab()?.id); // (the Settings tab the user is looking at)
    check('Canvas is connected, signed out: Needs sign-in', (await status()) === 'Needs sign-in', await status());
    const apiBefore = () => fakes.seen.filter((r) => r.service === 'canvas' && r.url.startsWith('/api/')).length;
    const connectApi = apiBefore();

    await ui.evaluate('loadStepUI()');
    await ui.waitForFunction(() => window.stepUI && window.stepLabels);
    const card = '#messages .act-card[data-surface="browser"]';
    let runNo = 0;
    const ask = async (prompt, toolUses) => {
      runNo++;
      await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
      await sleep(500);
      await ui.click('#new-chat');
      await sleep(400);
      await app.evaluate((_e, s) => { global.__script = s; }, { toolUses, turn: 0, run: runNo });
      await ui.fill('#prompt', prompt);
      await ui.press('#prompt', 'Enter');
      await waitFor(() => ui.evaluate(() => document.querySelectorAll('#messages .act-card').length >= 1), 20000);
      await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')), 60000);
      await sleep(600);
      return app.evaluate(() => global.__agent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').map((b) => ({ error: Boolean(b.is_error), text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) })));
    };
    const cardInfo = () => ui.evaluate((sel) => {
      const c = document.querySelector(sel);
      if (!c) return null;
      return { cards: document.querySelectorAll('#messages .act-card').length, surface: c.dataset.surface, steps: [...c.querySelectorAll('.act-list .step')].map((r) => r.firstChild?.textContent || ''), chip: c.querySelector('.act-tabref .tab-ref-title')?.textContent || '', button: [...c.querySelectorAll('button')].map((b) => b.textContent).filter(Boolean) };
    }, card);
    const tabsNow = () => app.evaluate(() => { const b = global.__agent.browser; const front = b.activeTab()?.id; return b.listTabs().map((t) => ({ id: t.id, url: t.url, title: t.title, front: t.id === front, ai: Boolean(b.isAiTab?.(t.id)) })); });

    console.log('--- signed out');
    const out = await ask('What courses am I in?', [{ app: 'canvas', action: 'courses' }]);
    check('the AI is told Canvas is not signed in and to ask the user to sign in', out[0]?.error && /isn’t signed in/.test(out[0].text) && /Ask the user to sign in/.test(out[0].text), JSON.stringify(out));
    check('the card on the settings page says Needs sign-in', (await status()) === 'Needs sign-in', await status());
    const signedOutCard = await cardInfo();
    check('the step is a Browser card: "Reading Canvas · Course list", with Go to tab', signedOutCard && signedOutCard.surface === 'browser' && signedOutCard.steps.includes('Reading Canvas · Course list') && signedOutCard.button.includes('Go to tab'), JSON.stringify(signedOutCard));
    const loginTab = (await tabsNow()).find((t) => /\/login\//.test(t.url));
    check('the tab stays on the school\'s sign-in page, for the user to sign in there; it is an AI tab, not the one in front', Boolean(loginTab) && loginTab.ai && !loginTab.front && loginTab.id !== userTab, JSON.stringify((await tabsNow()).map((t) => ({ ...t, url: t.url.slice(0, 60) }))));
    check('the chip names that tab', /Log in to Canvas/.test(signedOutCard?.chip || ''), JSON.stringify(signedOutCard));
    check('no Canvas API request', apiBefore() === connectApi, String(apiBefore() - connectApi));

    console.log('--- signed in');
    await app.evaluate(async ({ session }, { url, cookie }) => { const [name, value] = cookie.split('='); await session.defaultSession.cookies.set({ url, name, value }); }, { url: fakes.urls.canvas, cookie: fakes.cookie });
    const res = await ask('What is due, and any announcements?', [{ app: 'canvas', action: 'courses' }, { app: 'canvas', action: 'upcoming', args: { days: 14 } }, { app: 'canvas', action: 'announcements' }, { app: 'canvas', action: 'announcement', args: { course_id: '101', id: '5001' } }]);
    const base = fakes.urls.canvas;
    check('courses: the page\'s text, after its address, with the courses', !res[0]?.error && res[0].text.includes(`Page: ${base}/courses\n`) && /Fundamentals of Computer Science/.test(res[0].text) && /Linear Algebra/.test(res[0].text) && /<untrusted_page_content source="connector:canvas\/courses">/.test(res[0].text), JSON.stringify(res[0]));
    check('upcoming: the calendar that fills itself in after the load is read after it filled in', !res[1]?.error && res[1].text.includes(`Page: ${base}/calendar#view_name=agenda`) && /Lab 5 report \(Fundamentals of Computer Science\) due tomorrow/.test(res[1].text) && /Problem Set 3/.test(res[1].text), JSON.stringify(res[1]));
    check('announcements with no course: the current courses\' pages, one after the other', !res[2]?.error && res[2].text.includes(`Page: ${base}/courses/101/announcements`) && res[2].text.includes(`Page: ${base}/courses/202/announcements`) && /The midterm is now Friday/.test(res[2].text) && !/courses\/9\//.test(res[2].text), JSON.stringify(res[2]));
    check('text on a page that tries to steer the AI stays inside the untrusted wrapper', /<untrusted_page_content source="connector:canvas\/announcements">[\s\S]*Ignore previous instructions[\s\S]*<\/untrusted_page_content>$/.test(res[2]?.text || ''), res[2]?.text);
    check('announcement: that discussion page', !res[3]?.error && res[3].text.includes(`Page: ${base}/courses/101/discussion_topics/5001`) && /Prof\. Hopper/.test(res[3].text) && /Room 210/.test(res[3].text), JSON.stringify(res[3]));
    check('every answer is under 12,500 characters', res.every((r) => r.text.length < 12500), res.map((r) => r.text.length).join());
    check('the pages were asked for as pages: the course list, the calendar, each course\'s announcements, the topic', ['/courses', '/calendar', '/courses/101/announcements', '/courses/202/announcements', '/courses/101/discussion_topics/5001'].every((p) => fakes.canvasPages.some((x) => x.startsWith(p))), JSON.stringify(fakes.canvasPages));
    check('no request to the Canvas API since connecting', apiBefore() === connectApi, JSON.stringify(fakes.seen.filter((r) => r.url.startsWith('/api/'))));
    check('the card went back to Connected after a page was read', /^Connected/.test(await status()), await status());

    const tabs = await tabsNow();
    const canvasTabs = tabs.filter((t) => t.url.startsWith(base) && t.id !== loginTab.id);
    check('one new tab was used for all four reads: an AI tab on Canvas, not in front, and the user\'s own tab is still in front', canvasTabs.length === 1 && canvasTabs[0].ai && !canvasTabs[0].front && (await app.evaluate(() => global.__agent.browser.activeTab()?.id)) === userTab, JSON.stringify({ userTab, active: await app.evaluate(() => global.__agent.browser.activeTab()?.id), tabs: tabs.map((t) => ({ ...t, url: t.url.slice(0, 60) })) }));

    const info = await cardInfo();
    check('the chat shows ONE Browser card with a step per Canvas read ("Reading Canvas · …")', info && info.cards === 1 && info.surface === 'browser' && ['Reading Canvas · Course list', 'Reading Canvas · Upcoming assignments', 'Reading Canvas · Announcements', 'Reading Canvas · Read an announcement'].every((l) => info.steps.includes(l)), JSON.stringify(info));
    check('…whose tab row names the tab and offers Go to tab', Boolean(info) && /Exam moved to Friday/.test(info.chip) && info.button.includes('Go to tab'), JSON.stringify(info));

    console.log('--- Go to tab');
    await ui.evaluate((sel) => { const b = [...document.querySelector(sel).querySelectorAll('button')].find((x) => x.textContent === 'Go to tab'); b.click(); }, card);
    const shown = await waitFor(async () => (await app.evaluate(() => global.__agent.browser.activeTab()?.id)) === canvasTabs[0].id, 8000);
    check('clicking Go to tab shows that tab (only then does it come to the front)', Boolean(shown), JSON.stringify((await tabsNow()).map((t) => ({ ...t, url: t.url.slice(0, 60) }))));
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    await fakes.stop();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
