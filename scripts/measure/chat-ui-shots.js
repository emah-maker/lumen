// Pictures of the chat UI in every mode, for before/after comparisons of a design change. Hidden windows only
// (LUMEN_TEST_BACKGROUND), a temp profile, a stubbed model (no key, no network).
//   node scripts/measure/chat-ui-shots.js <out folder> [light|dark]
// Saves: sidebar-empty, sidebar-reply, sidebar-working, sidebar-done, sidebar-menu, page-reply, page-working, page-empty.
/* global document, window */ // (code run inside the app's pages)
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const REPLY = [
  '## Gaussian elimination, step by step',
  '',
  'Row-reduce the augmented matrix until it is in **row echelon form**, then solve from the bottom up. Partial pivoting picks the largest entry in each column, which keeps rounding errors small.',
  '',
  '1. Pick the pivot column and swap the largest row up.',
  '2. Subtract multiples of the pivot row from the rows below it.',
  '3. Repeat on the smaller matrix, then back-substitute.',
  '',
  '```python',
  'def solve(A, b):',
  '    n = len(A)',
  '    for k in range(n):',
  '        p = max(range(k, n), key=lambda i: abs(A[i][k]))',
  '        A[k], A[p] = A[p], A[k]; b[k], b[p] = b[p], b[k]',
  '    return back_substitute(A, b)',
  '```',
  '',
  '| Method | Cost | Stable |',
  '|---|---|---|',
  '| No pivoting | n³/3 | No |',
  '| Partial pivoting | n³/3 | Usually |',
  '',
  'Want me to work through a 3×3 example with numbers?',
].join('\n');

(async () => {
  const out = path.resolve(process.argv[2] || 'chat-shots');
  const theme = process.argv[3] || 'light';
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chatshots-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_CLAUDE_BIN: 'C:/none/claude.exe', LUMEN_CODEX_BIN: 'C:/none/codex.exe', LUMEN_GROK_BIN: 'C:/none/grok.exe', LUMEN_AGY_BIN: 'C:/none/agy.exe' } });
  const win = async (fn, arg) => app.evaluate(fn, arg);
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await win(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    await win(({ nativeTheme }, t) => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('replySuggestions', false); global.__patchSettings({ theme: t }); nativeTheme.themeSource = t; }, theme);
    await win((_e, REPLY) => {
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params, opts) => {
        const last = JSON.stringify(params.messages.at(-1));
        const hold = /HOLD/.test(last);
        const text = hold ? 'On it. Reading the notes first.' : REPLY;
        return {
          async *[Symbol.asyncIterator]() {
            for (const bit of text.match(/[\s\S]{1,40}/g)) { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: bit } }; await new Promise((r) => setTimeout(r, 5)); }
            if (hold) await new Promise((r, j) => { global.__release = r; opts?.signal?.addEventListener?.('abort', () => j(Object.assign(new Error('aborted'), { name: 'AbortError' }))); setTimeout(r, 120000); });
          },
          finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } }),
        };
      } } } });
    }, REPLY);
    const shot = async (name, wc = 'ui') => {
      await win(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme); await sleep(150);
      const png = await win(async ({ BrowserWindow }, [w, t]) => {
        const c = w === 'ui' ? BrowserWindow.getAllWindows()[0].webContents : global.__chatPage.contents(global.__chatPage.tabs().find((x) => x.chat).id);
        if (t === 'dark') { try { if (!c.debugger.isAttached()) c.debugger.attach('1.3'); await c.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await new Promise((r) => setTimeout(r, 300)); } catch { /* attached elsewhere */ } }
        return (await c.capturePage()).toPNG().toString('base64');
      }, [wc, theme]);
      fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(png, 'base64'));
      console.log('saved', name);
    };
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#sidebar', { state: 'visible' });
    await sleep(1200);
    await shot('sidebar-empty');
    const send = (text) => ui.evaluate((t) => { const p = document.getElementById('prompt'); p.value = t; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); }, text);
    const idle = () => waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop') && !document.querySelector('.msg.assistant.streaming')), 20000);
    await send('How does Gaussian elimination with partial pivoting work? Keep it short.');
    await sleep(800); await idle(); await sleep(900);
    await shot('sidebar-reply');

    await send('HOLD and build the 4.x decks from my notes');
    const run = await waitFor(() => ui.evaluate(() => (typeof turn !== 'undefined' && turn && runId ? runId : 0)), 20000); // eslint-disable-line no-undef
    const ev = (...events) => win(({ BrowserWindow }, [evs, id]) => { const wc = BrowserWindow.getAllWindows()[0].webContents; for (const e of evs) wc.send('agent:event', { runId: id, ...e }); }, [events, run]);
    await ui.evaluate(() => loadStepUI()); // eslint-disable-line no-undef
    await waitFor(() => ui.evaluate(() => Boolean(window.stepUI)));
    await ev({ type: 'tool', id: 's1', name: 'Read', label: 'Reading notes/chapter-4.md', input: { file_path: 'notes/chapter-4.md' } });
    await sleep(300);
    await ev({ type: 'tool_done', id: 's1', ok: true }, { type: 'tool', id: 's2', name: 'Write', label: 'Writing slides/4.1.pptx', input: { file_path: 'slides/4.1.pptx' } });
    await sleep(1500);
    await shot('sidebar-working');
    await ev({ type: 'tool_done', id: 's2', ok: true });
    await win(() => global.__release && global.__release());
    await idle(); await sleep(1200);
    await shot('sidebar-done');
    await ui.evaluate(() => document.getElementById('composer-plus').click());
    await sleep(500);
    await shot('sidebar-menu');
    await ui.evaluate(() => document.body.click());
    await ui.keyboard.press('Escape');

    await win(() => global.__chatPage.open());
    await waitFor(() => win(() => global.__chatPage.tabs().find((x) => x.chat)?.id));
    const inPage = (code) => win(async (_e, c) => global.__chatPage.contents(global.__chatPage.tabs().find((x) => x.chat).id).executeJavaScript(c, true), code);
    await waitFor(() => inPage(`Boolean(document.getElementById('prompt')) && document.readyState === 'complete'`));
    await sleep(1500);
    await shot('page-empty', 'page');
    await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'How does Gaussian elimination with partial pivoting work?'; p.dispatchEvent(new Event('input')); document.getElementById('send').click(); })()`);
    await sleep(800);
    await waitFor(() => inPage(`!document.getElementById('send').classList.contains('stop') && !document.querySelector('.msg.assistant.streaming')`), 20000);
    await sleep(1000);
    await shot('page-reply', 'page');
    await inPage(`(() => { const p = document.getElementById('prompt'); p.value = 'Tell me more about pivot choice'; p.dispatchEvent(new Event('input')); })()`);
    await inPage(`document.getElementById('composer-plus').click()`);
    await sleep(500);
    await shot('page-menu', 'page');
  } catch (e) {
    console.error('FAILED', e);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})();
