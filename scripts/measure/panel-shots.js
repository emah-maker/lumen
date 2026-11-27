// Pictures of the sidebar's Tasks, Research, Notes and Meeting panels with sample content, for before/after comparisons of a design
// change. Hidden windows only (LUMEN_TEST_BACKGROUND), a temp profile, a stubbed model and stubbed panel data (no key, no network).
//   node scripts/measure/panel-shots.js <out folder> [light|dark]
// Saves: tasks-list, tasks-detail, research-list, research-open, notes-list, notes-edit, meeting-ask, meeting-transcript, meeting-context.
/* global document, window */ // (code run inside the app's pages)
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };

const SOURCES = [
  { n: 1, title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'], year: 2017, venue: 'NeurIPS', starred: true, by: 'ai', url: 'https://example.org/a', doi: '10.48550/arXiv.1706.03762',
    chips: [{ id: 'peer', tone: 'good', text: 'Peer-reviewed' }, { id: 'cited', tone: 'good', text: 'Cited 100k+' }, { id: 'oa', tone: 'info', text: 'Open access' }],
    abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.',
    reference: 'Vaswani, A., Shazeer, N., & Parmar, N. (2017). Attention is all you need. NeurIPS.', note: '', quotes: [{ q: 'based solely on attention mechanisms', text: 'based solely on attention mechanisms, dispensing with recurrence and convolutions entirely', page: 2, verified: true }], pdfUrl: 'https://example.org/a.pdf' },
  { n: 2, title: 'A Survey of Large Language Models', authors: ['Wayne Xin Zhao'], year: 2023, venue: 'arXiv', starred: false, by: 'user', url: 'https://example.org/b', chips: [{ id: 'preprint', tone: 'warn', text: 'Preprint' }], abstract: '', reference: 'Zhao, W. X. (2023). A survey of large language models. arXiv.', note: '', quotes: [] },
  { n: 3, title: 'Retracted: Deep features for everything', authors: ['J. Doe'], year: 2019, venue: 'J. Imaginary Res.', retracted: true, by: 'ai', url: 'https://example.org/c', chips: [{ id: 'retracted', tone: 'bad', text: 'Retracted' }], abstract: '', reference: 'Doe, J. (2019).', note: '', quotes: [] },
];

(async () => {
  const out = path.resolve(process.argv[2] || 'panel-shots');
  const theme = process.argv[3] || 'light';
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-panelshots-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_CLAUDE_BIN: 'C:/none/claude.exe', LUMEN_CODEX_BIN: 'C:/none/codex.exe', LUMEN_GROK_BIN: 'C:/none/grok.exe', LUMEN_AGY_BIN: 'C:/none/agy.exe' } });
  const win = async (fn, arg) => app.evaluate(fn, arg);
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await win(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    await win(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('replySuggestions', false); });
    // The model: a task's prompt names its script (TASK-DONE finishes with a short result, TASK-HOLD keeps running).
    await win(() => {
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts) => {
        const first = JSON.stringify(params.messages[0].content);
        const hold = /TASK-HOLD/.test(first);
        const text = hold ? 'Checking the prices on each site.' : 'Found 3 flights under $300. The cheapest is Tuesday morning, $214 on JetBlue.';
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
            if (hold) await new Promise((r, j) => { opts?.signal?.addEventListener?.('abort', () => j(Object.assign(new Error('aborted'), { name: 'AbortError' }))); setTimeout(r, 120000); });
          },
          finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } }),
        };
      } } } });
    });
    // Panel data that would otherwise need the network or a microphone.
    await win(({ ipcMain }, SOURCES) => {
      const base = { styles: [{ id: 'apa', name: 'APA' }, { id: 'mla', name: 'MLA' }, { id: 'bibtex', name: 'BibTeX' }] };
      ipcMain.removeHandler('research:get'); ipcMain.handle('research:get', () => ({ chat: 'x', count: SOURCES.length, sources: SOURCES, ...base }));
      ipcMain.removeHandler('meeting:prompt'); ipcMain.handle('meeting:prompt', () => ({ ok: true, answer: 'Lead with the Q3 numbers: revenue is up 12% and churn is down to 2.1%. Then ask about the hiring plan.', talkingPoints: ['Revenue +12%', 'Churn 2.1%', 'Hiring plan'] }));
    }, SOURCES);

    const shot = async (name) => {
      await sleep(250);
      const png = await win(async ({ BrowserWindow }, t) => {
        const c = BrowserWindow.getAllWindows()[0].webContents;
        if (t === 'dark') { try { if (!c.debugger.isAttached()) c.debugger.attach('1.3'); await c.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await new Promise((r) => setTimeout(r, 300)); } catch { /* attached elsewhere */ } }
        const [cw, ch] = BrowserWindow.getAllWindows()[0].getContentSize();
        return (await c.capturePage({ x: cw - 440, y: 0, width: 440, height: ch })).toPNG().toString('base64');
      }, theme);
      fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(png, 'base64'));
      console.log('saved', name);
    };
    const click = (sel) => ui.evaluate((s) => document.querySelector(s)?.click(), sel);
    await click('#toggle-sidebar');
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    await sleep(1000);

    // ---- Tasks
    await ui.evaluate(() => window.assistant.tasks.create({ confirmed: true, prompt: 'TASK-DONE Find flights from Boston to Chicago under $300 next week' }));
    await ui.evaluate(() => window.assistant.tasks.create({ confirmed: true, prompt: 'TASK-HOLD Compare prices for a 27-inch 4K monitor on three sites' }));
    await waitFor(() => win(() => global.__bg.tasks().some((t) => t.status === 'done')), 20000);
    await sleep(500);
    await click('#tasks-btn');
    await waitFor(() => ui.evaluate(() => document.querySelectorAll('.task-row').length >= 2));
    await sleep(600);
    await shot('tasks-list');
    await ui.evaluate(() => [...document.querySelectorAll('.task-row')].find((r) => /flights/i.test(r.textContent))?.click());
    await sleep(700);
    await shot('tasks-detail');
    await click('#tasks-btn');
    await sleep(300);

    // ---- Research
    await click('#research-btn');
    await waitFor(() => ui.evaluate(() => document.querySelectorAll('.rs-card').length === 3));
    await sleep(500);
    await shot('research-list');
    await click('#rs-1 .rs-toggle');
    await sleep(500);
    await shot('research-open');
    await click('#research-btn');
    await sleep(300);

    // ---- Notes
    for (const text of ['# Biology midterm\nCell respiration, photosynthesis, the Krebs cycle.', '# Trip packing list\n- passport\n- charger', '# Reading list\nThinking, Fast and Slow']) await ui.evaluate((t) => window.assistant.notes.act('new', { text: t }), text);
    await click('#notes-btn');
    await waitFor(() => ui.evaluate(() => document.querySelectorAll('.nt-row').length >= 3));
    await sleep(500);
    await shot('notes-list');
    await click('.nt-row .nt-open');
    await sleep(800);
    await shot('notes-edit');
    await click('#notes-btn');
    await sleep(300);

    // ---- Meeting
    await click('#meeting-btn');
    await waitFor(() => ui.evaluate(() => window.meetingUi && !document.getElementById('meeting-panel').hidden));
    await sleep(500);
    await ui.evaluate(() => { const p = document.querySelector('.mt-prompt-input'); p.value = 'What should I lead with?'; });
    await click('.mt-prompt-box .btn, .mt-prompt-input-row button');
    await sleep(800);
    await shot('meeting-ask');
    for (const [t, s] of [['Thanks everyone for joining. Let us start with the quarterly numbers.', 'Host'], ['Revenue is up twelve percent and churn is down.', 'Participant'], ['Great. What does the hiring plan look like?', 'Host']]) await ui.evaluate(([a, b]) => window.assistant.meeting.sendTranscript(a, b), [t, s]);
    await ui.evaluate(() => [...document.querySelectorAll('.mt-tab')].find((b) => /transcript/i.test(b.textContent))?.click());
    await sleep(600);
    await shot('meeting-transcript');
    await ui.evaluate(() => [...document.querySelectorAll('.mt-tab')].find((b) => /context/i.test(b.textContent))?.click());
    await sleep(400);
    await shot('meeting-context');
  } catch (e) {
    console.error('FAILED', e);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})();
