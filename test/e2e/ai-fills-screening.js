// [about you] The AI finishes a job application from the project's profile, in a real (invisible) window with a fake model and a local
// fake application form (nothing real is read or visited):
//  - a Job applications project with work authorization and sponsorship saved and "Decline to self-identify" for demographic questions;
//  - a chat in it sends the model the profile and the rules (fill without asking, one question for the rest, never submit); the fake model
//    fills what the system prompt it got holds: the work questions from the saved boxes, gender with the form's decline option;
//  - the one thing missing (start date) is asked once; the user's answer is saved with applications remember and filled;
//  - a demographic answer the user never gave is refused; the form is never submitted.
// Run: LUMEN_TEST_BACKGROUND=1 node test/e2e/ai-fills-screening.js
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

const FORM = `<!doctype html><title>Career Opportunities: Apply for Mechanical Co-op</title>
<form id="app" method="post" action="/submit" onsubmit="window.__submitted = true">
  <h1>Application questions</h1>
  <label for="auth">Are you legally authorized to work in the United States?</label>
  <select id="auth" name="auth"><option value="">Select One</option><option value="y">Yes</option><option value="n">No</option></select>
  <label for="spon">Will you now or in the future require sponsorship for employment visa status?</label>
  <select id="spon" name="spon"><option value="">Select One</option><option value="y">Yes</option><option value="n">No</option></select>
  <label for="gender">Gender</label>
  <select id="gender" name="gender"><option value="">Select One</option><option value="m">Male</option><option value="f">Female</option><option value="d">I don't wish to answer</option></select>
  <label for="start">Earliest start date</label>
  <input id="start" name="start" type="text">
  <button id="submit" type="submit">Submit application</button>
</form>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
  let posted = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') posted++;
    res.setHeader('Content-Type', 'text/html');
    res.end(req.method === 'POST' ? '<title>Submitted</title><p>Thanks</p>' : FORM);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const formUrl = `http://127.0.0.1:${server.address().port}/apply`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fills-screening-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); });
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false, 20000);
    const api = (call, ...args) => inPage(`window.assistant.chats.${call}(...${JSON.stringify(args)})`);

    // ---- the project and its profile, as the user fills it on About you
    const job = await api('saveProject', { name: 'Co-op hunt', template: 'job-applications', folderMode: 'none' });
    check('a Job applications project with a profile', Boolean(job?.profileId), JSON.stringify(job).slice(0, 200));
    await api('projectAbout', job.id, { fields: { fullName: 'Sam Lee', workAuth: 'Yes', sponsorship: 'No' } });
    const chose = await api('projectAbout', job.id, { demographics: 'decline' });
    check('About you: the demographics choice is saved', chose?.about?.demographics === 'decline', JSON.stringify(chose?.about).slice(0, 300));
    await inPage(`(async () => { document.querySelector('.cp-pj-item[data-project="${job.id}"] .cp-pj-new').click(); await new Promise((r) => setTimeout(r, 900)); })()`);

    // ---- the form in a tab, and a fake model that fills only from what its system prompt holds
    const formTab = await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); return t.id; }, formUrl);
    const run = (text) => app.evaluate(async (_e, { typed, tabId }) => {
      const agent = global.__agent;
      try { agent.browser.switchTab(tabId); } catch { /* already in front */ }
      const cid = global.__chats.id();
      agent.messages.settings = { ...(agent.messages.settings || {}), adhdMode: true, model: 'claude-opus-5', ...global.__projectWorkspace.settingsFor(cid) };
      const fake = global.__fake ||= { requests: [], asked: 0 };
      agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const system = (params.system || []).map((s) => s.text).join('\n');
        const last = params.messages[params.messages.length - 1];
        const results = (Array.isArray(last?.content) ? last.content : []).filter((b) => b.type === 'tool_result');
        const said = JSON.stringify(last?.content || '');
        fake.requests.push({ system, tools: (params.tools || []).map((t) => t.name) });
        const pick = (re) => (re.exec(system) || [])[1] || '';
        let content;
        if (results.length) {
          fake.results = [...(fake.results || []), ...results.map((r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)))];
          if (/Saved to the user's profile: Available from/.test(fake.results.join('\n')) && !fake.filledStart) {
            fake.filledStart = true;
            content = [{ type: 'tool_use', id: 'toolu_f2', name: 'fill_form', input: { fields: [{ label: 'Earliest start date', value: 'January 2027' }] } }];
          } else if (/Saved to the user's profile: Available from/.test(fake.results.join('\n')) && !fake.triedGuess) {
            fake.triedGuess = true; // (a demographic answer the user never gave: the tool must refuse it)
            content = [{ type: 'tool_use', id: 'toolu_g1', name: 'applications', input: { action: 'remember', note: 'What is your race or ethnicity? Asian' } }];
          } else content = [{ type: 'text', text: 'Everything is filled. Review it and tell me when to submit.' }];
        } else if (/January 2027/.test(said)) {
          content = [{ type: 'tool_use', id: 'toolu_r1', name: 'applications', input: { action: 'remember', note: 'startDate: January 2027' } }];
        } else if (!fake.filled) {
          fake.filled = true;
          const fields = [];
          const auth = pick(/Authorized to work here\?: (\w+)/);
          const spon = pick(/Need visa sponsorship\?: (\w+)/);
          if (auth) fields.push({ label: 'Are you legally authorized to work in the United States?', value: auth });
          if (spon) fields.push({ label: 'Will you now or in the future require sponsorship for employment visa status?', value: spon });
          if (/the user chose to decline them/.test(system)) fields.push({ label: 'Gender', value: "I don't wish to answer" });
          content = [{ type: 'tool_use', id: 'toolu_f1', name: 'fill_form', input: { fields } }];
        } else {
          fake.asked++;
          content = [{ type: 'text', text: /ONE short question/.test(system) && /Not saved yet[^\n]*Available from/.test(system) ? 'One thing is missing: your earliest start date?' : 'Please fill in the rest yourself.' }];
        }
        const stop = content[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, usage: { input_tokens: 10, output_tokens: 5 } };
        return { async *[Symbol.asyncIterator]() { if (stop === 'end_turn') yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content[0].text } }; }, finalMessage: async () => message };
      } } } });
      const events = [];
      await agent.run(typed, (e) => { events.push(e); if (e.type === 'approval') setTimeout(() => agent.resolveApproval(e.approvalId, true), 0); });
      const replies = agent.messages.filter((m) => m.role === 'assistant').flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'text').map((b) => b.text);
      return { replies, events: events.map((e) => ({ type: e.type, action: e.action, text: String(e.text || e.title || '').slice(0, 200) })), fake: { ...fake, requests: fake.requests.map((r) => ({ tools: r.tools, about: (/<about_user>[\s\S]*?<\/about_user>/.exec(r.system) || [''])[0] })) } };
    }, { typed: text, tabId: formTab });
    const formState = () => app.evaluate(async (_e, id) => {
      const wc = global.__agent.browser.tabById(id)?.webContents;
      return wc.executeJavaScript("({ url: location.href, auth: document.getElementById('auth')?.value, spon: document.getElementById('spon')?.value, gender: document.getElementById('gender')?.value, start: document.getElementById('start')?.value, submitted: Boolean(window.__submitted) })");
    }, formTab);

    // ---- turn 1: fill from the profile, then one question
    const r1 = await run('Fill out this application for me.');
    const about = r1.fake.requests[0]?.about || '';
    check('the model gets the profile and the rules: fill without asking, one question, never submit', /Authorized to work here\?: Yes/.test(about) && /without asking/.test(about) && /ONE short question/.test(about) && /Never submit/.test(about), about.slice(0, 900));
    check('…the demographics choice ("decline")', /the user chose to decline them/.test(about), about);
    check('…and the applications tool (remember)', r1.fake.requests[0]?.tools.includes('applications'), JSON.stringify(r1.fake.requests[0]?.tools));
    const s1 = await formState();
    check('work authorization and sponsorship filled from the profile, without asking', s1.auth === 'y' && s1.spon === 'n', JSON.stringify(s1));
    check('gender: the form\'s "I don\'t wish to answer", never a pick of its own', s1.gender === 'd', JSON.stringify(s1));
    check('one question for what is missing', r1.fake.asked === 1 && /earliest start date\?/.test(r1.replies.join('\n')), JSON.stringify(r1.replies));

    // ---- turn 2: the user answers; saved to the profile and filled; a guessed demographic answer refused; nothing submitted
    const r2 = await run('January 2027');
    const s2 = await formState();
    check('the answer is filled in', s2.start === 'January 2027', JSON.stringify(s2));
    const after = await api('projectAbout', job.id);
    check('…and saved to the profile (About you), so the next application does not ask', after?.about?.groups?.find((g) => g.id === 'work')?.fields.find((f) => f.key === 'startDate')?.value === 'January 2027', JSON.stringify(after?.about?.groups?.find((g) => g.id === 'work')));
    check('a demographic answer the user never gave is refused, not saved', /saved only as the user’s own words/.test((r2.fake.results || []).join('\n')) && !(after?.about?.answers || []).some((a) => /race/i.test(a.question)), JSON.stringify(r2.fake.results));
    check('the next chat\'s profile has the start date (not asked again)', !/Not saved yet/.test((await app.evaluate(() => global.__projectWorkspace.blockFor(global.__chats.id()))) || ''), '');
    check('never submitted', s2.submitted === false && posted === 0 && !/submit/i.test(JSON.stringify(r2.events.filter((e) => e.type === 'approval'))), JSON.stringify([s2, posted]));
  } catch (err) {
    failures++;
    console.log(`FAIL  the suite threw  -> ${err?.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll ai-fills-screening checks passed.');
  process.exit(failures ? 1 : 0);
})();
