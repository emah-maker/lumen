// Automations end to end, on local fixture job pages (no real job site): a profile with a résumé file, an automation on a list of
// pages, its run (each page in its own background tab, in one group), the form filled from the profile (text, select, file,
// cover letter, a saved answer), Review before Submit with what was filled, a question with no answer (Needs you; filled in the
// tab, then Continue), a sign-in page (Needs you, never guessed), Skip, the tracker and its CSV, a search page's links (skipping
// what was done), recorded-style steps that reach the form, Submit without asking only in Bypass permissions, Pause and Stop,
// a schedule that comes due, a draft from a sentence (only the addresses the user wrote), and the store encrypted on disk.
// Hidden windows only (LUMEN_TEST_BACKGROUND), a throwaway profile, no dialogs. A screenshot of the run view goes to
// $AUTOMATIONS_SHOT (default: the temp folder).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(150); } return v; };

const FORM = ({ title, extra = '', company = 'Acme Robotics' }) => `<!doctype html><meta charset="utf-8"><title>${title} - ${company} | Careers</title>
<meta property="og:site_name" content="${company}"><h1>${title}</h1>
<form method="post" action="/thanks">
<label for="first">First name *</label><input id="first" name="first" required>
<label for="last">Last name *</label><input id="last" name="last" required>
<label>Email <input id="email" name="email" type="email" autocomplete="email" required></label>
<label for="cv">Resume/CV *</label><input id="cv" name="cv" type="file" required>
<label for="auth">Are you legally authorized to work in the United States? *</label>
<select id="auth" name="auth" required><option value="">Select...</option><option value="y">Yes</option><option value="n">No</option></select>
<label for="hear">How did you hear about this job?</label><input id="hear" name="hear">
<label for="cover">Cover letter</label><textarea id="cover" name="cover"></textarea>
${extra}
<button type="submit">Submit application</button></form>`;
const PAGES = {
  '/job/1': FORM({ title: 'Mechanical Engineering Co-op' }),
  '/job/2': FORM({ title: 'Thermal Co-op', company: 'Beta Labs', extra: '<label for="salary">Expected hourly pay *</label><input id="salary" name="salary" required>' }),
  '/job/3': '<!doctype html><title>Sign in</title><h1>Sign in to apply</h1><form><label>Email <input name="u"></label><label>Password <input type="password" name="p"></label><button>Sign in</button></form>',
  '/job/4': `<!doctype html><title>Design Co-op - Gamma | Careers</title><h1>Design Co-op</h1><p>About the role.</p><button type="button" id="apply" onclick="document.getElementById('f').hidden=false;this.hidden=true">Apply now</button>
<div id="f" hidden>${FORM({ title: 'Design Co-op', company: 'Gamma' }).split('<h1>Design Co-op</h1>')[1]}</div>`,
  '/job/5': FORM({ title: 'Robotics Co-op', company: 'Delta' }),
  '/job/6': FORM({ title: 'Controls Co-op', company: 'Epsilon' }),
  '/job/7': FORM({ title: 'Test Co-op', company: 'Zeta' }),
  '/search': '<!doctype html><title>Jobs</title><h1>Openings</h1><a href="/job/1?utm_source=x">Mechanical Engineering Co-op</a> <a href="/job/2">Thermal Co-op</a> <a href="/job/5">Robotics Co-op</a> <a href="/about">About us</a> <a href="https://example.org/job/9">Co-op elsewhere</a>',
};

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const posts = [];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { posts.push({ url: req.url, referer: req.headers.referer || '', body }); res.end('<!doctype html><title>Thanks</title><h1>Thank you for applying!</h1><p>Your application has been received.</p>'); });
      return;
    }
    res.end(PAGES[req.url.split('?')[0]] || '<title>Not found</title><p>Nothing here.</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-automations-'));
  const resume = path.join(profileDir, 'Sam Lee resume.pdf');
  fs.writeFileSync(resume, '%PDF-1.4 test résumé');
  const csvFile = path.join(profileDir, 'tracker.csv');
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profileDir, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
    colorScheme: null,
  });
  const watchdog = setTimeout(async () => { console.log('FAIL  watchdog: the test took longer than 5 minutes'); try { await app.close(); } catch { /* gone */ } process.exit(1); }, 300000);
  watchdog.unref();
  try {
    const ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    const rt = (code, arg) => app.evaluate((_e, [c, a]) => new Function('rt', 'arg', `return (${c})(rt, arg)`)(global.__automations.rt(), a), [code, arg]);
    const state = () => rt('(r) => r.state()');
    const runOf = async (id) => (await state()).runs.find((r) => r.id === id);
    const itemOf = async (runId, n) => (await runOf(runId))?.items.find((i) => i.url.includes(`/job/${n}`));
    const settled = (runId) => waitFor(async () => { const r = await runOf(runId); return r && !r.items.some((i) => i.status === 'running' || i.status === 'queued') ? r : null; }, 40000);
    const tabWc = (runId, n) => app.evaluate((_e, [id, num]) => {
      const ctx = global.__automations.rt().active().get(id);
      const item = ctx?.run.items.find((i) => i.url.includes(`/job/${num}`));
      return item && ctx.tabs.has(item.id) ? ctx.tabs.get(item.id) : null;
    }, [runId, n]);
    const inTab = (tabId, code) => app.evaluate((_e, [id, c]) => global.__agent.browser.tabById(id).webContents.executeJavaScript(c), [tabId, code]);

    // ---- the page
    await app.evaluate((_e, f) => { global.__automationsCsv = f; global.__automationsPick = async () => ''; }, csvFile);
    await app.evaluate(() => global.__automations.open());
    const pageTab = await waitFor(() => app.evaluate(() => global.__settings.tabs().find((x) => /automations\.html/.test(x.url))?.id || null));
    const inPage = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c, true), [pageTab, code]);
    check('lumen://automations opens with the describe box, Record and the list', await waitFor(() => inPage("Boolean(document.getElementById('describe') && document.getElementById('record') && document.getElementById('list-h'))")));

    // ---- a profile (from the page's own Save, so the page's call path is covered)
    await inPage("location.hash = 'profile'");
    await waitFor(() => inPage("Boolean(document.getElementById('p-save'))"));
    await inPage(`(() => { const set = (id, v) => { document.getElementById(id).value = v; }; set('p-name', 'Co-op'); set('p-firstName', 'Sam'); set('p-lastName', 'Lee'); set('p-email', 'sam@example.edu'); set('p-workAuth', 'Yes'); set('p-cover', 'Dear {{company}} team, I would love the {{role}} role. {{name}}'); document.getElementById('p-add').click(); })()`);
    await waitFor(() => inPage("document.querySelectorAll('.answer').length === 1"));
    await inPage("(() => { const row = document.querySelector('.answer'); row.querySelector('.q').value = 'How did you hear about us?'; row.querySelector('.a').value = 'Handshake'; document.getElementById('p-save').click(); })()");
    const profile = await waitFor(async () => (await state()).profiles[0]);
    check('the profile is saved from the page, with its answer', profile?.fields.firstName === 'Sam' && profile.answers[0]?.answer === 'Handshake', JSON.stringify(profile));
    await rt('(r, a) => r.saveProfile(a)', { ...profile, resumePath: resume });

    // ---- an automation on three pages
    const saved = await rt('(r, a) => r.saveAutomation(a)', { name: 'ME co-ops', inputs: { kind: 'urls', urls: [`${base}/job/1`, `${base}/job/2`, `${base}/job/3`] }, profileId: profile.id, projectId: 'proj-1' });
    check('the automation is saved with its pages, profile and project', saved.ok && saved.automation.inputs.urls.length === 3 && saved.automation.projectId === 'proj-1' && saved.automation.submitMode === 'review', JSON.stringify(saved));
    const A = saved.automation.id;
    const tabsBefore = await app.evaluate(() => global.__settings.tabs().length);
    const started = await rt('(r, id) => r.start(id)', A);
    check('Run now starts a run', started.ok && started.runId, JSON.stringify(started));
    const run1 = await settled(started.runId);
    const s1 = Object.fromEntries((run1?.items || []).map((i) => [i.url.split('/').pop(), i]));
    check('the filled form waits at Submit for review (nothing was posted)', s1['1']?.status === 'review' && posts.length === 0, JSON.stringify(s1['1']));
    check('a required question with no saved answer makes the item Needs you, with the question named', s1['2']?.status === 'needs-you' && s1['2'].need === 'questions' && s1['2'].questions.some((q) => /hourly pay/i.test(q)), JSON.stringify(s1['2']));
    check('a sign-in page is Needs you (login), never filled', s1['3']?.status === 'needs-you' && s1['3'].need === 'login', JSON.stringify(s1['3']));
    const filled = Object.fromEntries((s1['1']?.filled || []).map((f) => [f.label.replace(/\s*\*$/, ''), f.value]));
    check('the review lists what was filled: names, email, the résumé by name, Yes, the saved answer, the cover letter', filled['First name'] === 'Sam' && filled['Last name'] === 'Lee' && filled.Email === 'sam@example.edu' && filled['Resume/CV'] === 'Sam Lee resume.pdf' && /^Yes$/.test(filled['Are you legally authorized to work in the United States?']) && filled['How did you hear about this job?'] === 'Handshake' && /Dear Acme Robotics team, I would love the Mechanical Engineering Co-op role\. Sam Lee/.test(filled['Cover letter'] || ''), JSON.stringify(filled));
    check('the role and company come from the page', s1['1']?.role === 'Mechanical Engineering Co-op' && s1['1'].company === 'Acme Robotics', JSON.stringify(s1['1']));
    const t1 = await tabWc(started.runId, 1);
    const page1 = t1 ? await inTab(t1, "({ first: first.value, last: last.value, email: email.value, auth: auth.value, file: cv.files[0]?.name || '', cover: cover.value })") : null;
    check('the page itself holds the values, and the file field has the résumé', page1?.first === 'Sam' && page1.auth === 'y' && page1.file === 'Sam Lee resume.pdf' && /Acme Robotics/.test(page1.cover), JSON.stringify(page1));
    check('each page has its own tab', (await app.evaluate(() => global.__settings.tabs().length)) - tabsBefore >= 3);

    // The run view: Submit on the review card (the page's button).
    await inPage(`location.hash = 'run/${started.runId}'`);
    await waitFor(() => inPage("document.querySelectorAll('.card.item').length === 3"));
    check('the run view lists every item, the ones that need the user first', await inPage("[...document.querySelectorAll('.card.item')].map((c) => c.dataset.status).join(',') === 'review,needs-you,needs-you'"));
    await inPage("[...document.querySelector('.card.item[data-status=\"review\"]').querySelectorAll('button')].find((b) => b.textContent === 'Submit').click()");
    const done1 = await waitFor(async () => ((await itemOf(started.runId, 1))?.status === 'done' ? itemOf(started.runId, 1) : null), 20000);
    check('Submit sends the form and the item is done when the page thanks', done1?.status === 'done' && done1.submittedAt > 0 && posts.length === 1 && /first=Sam/.test(posts[0].body), JSON.stringify({ done1, posts }));
    check('a done item’s tab closes', !(await tabWc(started.runId, 1)));

    // Needs you → the user answers in the tab → Continue → Review → Submit.
    const t2 = await tabWc(started.runId, 2);
    await inTab(t2, "(() => { const s = document.getElementById('salary'); s.value = '25'; s.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await rt('(r, a) => r.itemAct(a)', { op: 'continue', runId: started.runId, itemId: s1['2'].id });
    const rev2 = await waitFor(async () => ((await itemOf(started.runId, 2))?.status === 'review' ? itemOf(started.runId, 2) : null));
    check('Continue looks again: the answered question is kept and the item is ready for review', rev2?.status === 'review' && rev2.filled.some((f) => f.label.startsWith('First name')), JSON.stringify(await itemOf(started.runId, 2)));
    await rt('(r, a) => r.itemAct(a)', { op: 'approve', runId: started.runId, itemId: s1['2'].id });
    check('…and its Submit sends what the user typed too', await waitFor(async () => (await itemOf(started.runId, 2))?.status === 'done' && posts.length === 2 && /salary=25/.test(posts[1].body)));
    await rt('(r, a) => r.itemAct(a)', { op: 'skip', runId: started.runId, itemId: s1['3'].id });
    const fin = await waitFor(async () => ((await runOf(started.runId))?.state === 'finished' ? runOf(started.runId) : null));
    check('Skip ends the last item and the run is finished', fin?.state === 'finished' && fin.counts.done === 2 && fin.counts.skipped === 1, JSON.stringify(fin?.counts));

    // ---- the tracker and its CSV
    const st = await state();
    check('the tracker has every item that ended, with what was filled', st.logCount === 3 && st.log.some((e) => e.status === 'done' && e.filled.length >= 6), JSON.stringify(st.log.map((e) => e.status)));
    const exported = await rt('(r) => r.exportCsv()');
    const csv = fs.existsSync(csvFile) ? fs.readFileSync(csvFile, 'utf8') : '';
    check('Export CSV writes one row per item, with company, role and status', exported.ok && csv.split('\r\n').filter(Boolean).length === 4 && /"Acme Robotics","Mechanical Engineering Co-op","done"/.test(csv), csv.slice(0, 400));

    // ---- a search page: its matching links, without the ones already submitted
    const S = (await rt('(r, a) => r.saveAutomation(a)', { name: 'Search co-ops', inputs: { kind: 'search', searchUrl: `${base}/search`, match: 'co-op', limit: 5 }, profileId: profile.id })).automation.id;
    const sr = await rt('(r, id) => r.start(id)', S);
    const srun = await settled(sr.runId);
    check('a search run opens the matching links on the same site, leaving out what was submitted already', srun?.items.length === 1 && srun.items[0].url.endsWith('/job/5'), JSON.stringify(srun?.items.map((i) => i.url)));
    await rt('(r, a) => r.runAct(a)', { op: 'stop', runId: sr.runId });
    check('Stop ends the run and stops its waiting item', (await runOf(sr.runId))?.state === 'stopped' && (await runOf(sr.runId)).items[0].status === 'stopped');

    // ---- steps that reach the form (as a recording makes them: a click on "Apply now")
    const B = (await rt('(r, a) => r.saveAutomation(a)', { name: 'Design', inputs: { kind: 'urls', urls: [`${base}/job/4`] }, profileId: profile.id, steps: [{ type: 'click', locator: { name: 'Apply now', text: 'Apply now', role: 'button' } }] })).automation.id;
    const br = await rt('(r, id) => r.start(id)', B);
    const brun = await settled(br.runId);
    check('the automation’s steps run first (Apply now), then the form behind it is filled and waits for review', brun?.items[0].status === 'review' && brun.items[0].filled.some((f) => f.value === 'Sam'), JSON.stringify(brun?.items[0]));
    await rt('(r, a) => r.runAct(a)', { op: 'stop', runId: br.runId });

    // ---- Submit without asking: only in Bypass permissions
    const C = (await rt('(r, a) => r.saveAutomation(a)', { name: 'Alone', inputs: { kind: 'urls', urls: [`${base}/job/6`] }, profileId: profile.id, submitMode: 'auto' })).automation.id;
    const cr = await rt('(r, id) => r.start(id)', C);
    const crun = await settled(cr.runId);
    check('set to submit without asking, it still stops for review while Lumen asks before acting', crun?.items[0].status === 'review' && posts.length === 2, JSON.stringify(crun?.items[0]?.status));
    await rt('(r, a) => r.runAct(a)', { op: 'stop', runId: cr.runId });
    await app.evaluate(() => { global.__settings.backend.set('askBeforeActing', false); global.__settings.backend.set('bypassPermissions', true); });
    const cr2 = await rt('(r, id) => r.start(id)', C);
    const c2 = await waitFor(async () => { const r = await runOf(cr2.runId); return r?.state === 'finished' ? r : null; }, 30000);
    check('in Bypass permissions it submits alone and the run finishes', c2?.items[0].status === 'done' && posts.length === 3, JSON.stringify(c2?.items[0]));
    await app.evaluate(() => { global.__settings.backend.set('bypassPermissions', false); global.__settings.backend.set('askBeforeActing', true); });

    // ---- Pause holds the queue
    const P = (await rt('(r, a) => r.saveAutomation(a)', { name: 'Pause test', inputs: { kind: 'urls', urls: [`${base}/job/7`, `${base}/job/5`] }, profileId: profile.id })).automation.id;
    const pr = await rt('(r, id) => r.start(id)', P);
    await rt('(r, a) => r.runAct(a)', { op: 'pause', runId: pr.runId });
    await sleep(4000);
    const paused = await runOf(pr.runId);
    check('Pause: the run is paused and the next item does not start', paused?.state === 'paused' && paused.items.filter((i) => i.status === 'queued').length >= 1, JSON.stringify(paused?.items.map((i) => i.status)));
    await rt('(r, a) => r.runAct(a)', { op: 'resume', runId: pr.runId });
    check('Resume goes on with the queue', await waitFor(async () => (await runOf(pr.runId))?.items.every((i) => i.status !== 'queued' && i.status !== 'running'), 30000));
    await rt('(r, a) => r.runAct(a)', { op: 'stop', runId: pr.runId });

    // ---- a schedule that came due runs once
    const D = (await rt('(r, a) => r.saveAutomation(a)', { name: 'Daily', inputs: { kind: 'urls', urls: [`${base}/job/7`] }, profileId: profile.id, schedule: { repeat: 'daily', time: '08:00' }, scheduleOn: true })).automation;
    check('a scheduled automation has its next run', (await state()).automations.find((a) => a.id === D.id)?.nextRun > Date.now(), JSON.stringify(D.schedule));
    await rt('(r, id) => { const a = r.store.automation(id); a.lastDue = Date.now() - 3 * 86400000; a.updatedAt = a.lastDue; r.runDue(); }', D.id);
    const sched = await waitFor(async () => (await state()).runs.find((r) => r.automationId === D.id));
    check('a missed scheduled time starts one run, marked as scheduled', sched?.trigger === 'schedule' && (await state()).runs.filter((r) => r.automationId === D.id).length === 1, JSON.stringify(sched));
    await settled(sched.id);
    await sleep(500);
    const shot = process.env.AUTOMATIONS_SHOT || path.join(os.tmpdir(), 'lumen-automations-run.png');
    await inPage(`location.hash = 'run/${started.runId}'`);
    await sleep(600);
    fs.writeFileSync(shot, Buffer.from(await app.evaluate(async (_e, id) => (await global.__settings.contents(id).capturePage()).toPNG().toString('base64'), pageTab), 'base64'));
    console.log(`screenshot: ${shot}`);
    await rt('(r, a) => r.runAct(a)', { op: 'stop', runId: sched.id });

    // ---- a draft from a sentence: the model's draft, with only the addresses the user wrote
    await app.evaluate((_e, b) => { global.__automationsComplete = async () => ({ name: 'Co-op hunt', kind: 'urls', urls: [`${b}/job/1`, 'https://made-up.example/job'], search_url: '', match: '', limit: 0, schedule: 'every weekday at 9am', steps: [{ type: 'click', element_text: 'Apply now', seconds: 0, key: '', direction: 'down' }] }); }, base);
    const dr = await rt('(r, t) => r.describe(t)', `Apply to ${base}/job/1 every weekday at 9am`);
    check('Describe: the model’s draft keeps only the user’s addresses, with its schedule and steps', dr.ok && dr.draft.name === 'Co-op hunt' && dr.draft.inputs.urls.length === 1 && dr.draft.schedule?.repeat === 'weekdays' && dr.draft.steps[0]?.type === 'click', JSON.stringify(dr));

    // ---- on disk: encrypted (the profile holds personal details)
    await rt('(r) => r.store.write()');
    const raw = fs.readFileSync(await app.evaluate(() => global.__automations.file), 'utf8');
    const enc = (await state()).keychain;
    // (the file is only an envelope: format, version and the encrypted body; the names are looked for in the decoded bytes, not in the base64 text, where "Sam" turns up by chance in a long body)
    const encOk = (text) => { let j; try { j = JSON.parse(text); } catch { return false; } const bytes = Buffer.from(String(j.enc || ''), 'base64').toString('latin1'); return JSON.stringify(Object.keys(j).sort()) === '["enc","format","version"]' && j.enc.length > 0 && !/sam@example\.edu/.test(bytes) && !/Sam/.test(bytes) && !/sam@example\.edu/.test(text.replace(j.enc, '')) && !/Sam/.test(text.replace(j.enc, '')); };
    check('the automations file is encrypted with the keychain (no name or email in it)', !enc || (encOk(raw)), raw.slice(0, 200));
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  ${err?.stack || err}`);
  } finally {
    clearTimeout(watchdog);
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
