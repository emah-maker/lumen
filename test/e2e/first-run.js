// First run, as a brand-new user with nothing connected: no key, and no Claude Code, Codex, Grok Build or Antigravity on this
// computer (each one's LUMEN_*_BIN points at a file that isn't there, so this machine's own installs can't sneak in).
//   - the toolbar button reads "Set up AI" (not just a sparkle), and stops saying it once something is connected, Auto included;
//   - the sidebar's setup card leads with the ways in that need no install (OpenRouter, an API key), then Claude Code, and a note
//     says how to bring Codex, Grok Build or Antigravity (no row for an engine that isn't there);
//   - Settings > AI says "No AI connected yet." with a Connect an AI button, and no empty model picker.
// Windows are off-screen (LUMEN_TEST_BACKGROUND) and the profile a throwaway.
'use strict';
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

const launchEnv = (extra = {}) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-first-run-'));
  const dir = (n) => { const d = path.join(base, n); fs.mkdirSync(d); return d; };
  const env = {
    ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: dir('profile'), ANTHROPIC_CONFIG_DIR: dir('ant'), CODEX_HOME: dir('codex'),
    LUMEN_CLAUDE_BIN: path.join(base, 'no-claude'), LUMEN_CODEX_BIN: path.join(base, 'no-codex'), LUMEN_GROK_BIN: path.join(base, 'no-grok'), LUMEN_AGY_BIN: path.join(base, 'no-agy'), ...extra,
  };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) if (!(k in extra)) delete env[k];
  return env;
};

(async () => {
  // ---------- nothing connected ----------
  {
    const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: launchEnv() });
    try {
      const ui = await app.firstWindow();
      const errors = [];
      ui.on('pageerror', (e) => errors.push(e.message));
      await ui.waitForSelector('.tab');
      await sleep(1500);

      const btn = await ui.evaluate(() => { const b = document.getElementById('toggle-sidebar'); return { setup: b.classList.contains('needs-setup'), label: b.getAttribute('aria-label'), shown: getComputedStyle(b, '::after').content }; });
      check('the toolbar AI button says "Set up AI" in words, not only a sparkle', btn.setup && btn.label === 'Set up AI' && btn.shown === '"Set up AI"', JSON.stringify(btn));

      await ui.click('#toggle-sidebar');
      await sleep(1200);
      const card = await ui.evaluate(() => {
        const shown = (id) => { const e = document.getElementById(id); return Boolean(e) && !e.hidden && e.getClientRects().length > 0; };
        const ids = ['setup-openrouter', 'setup-keys', 'setup-claude-code', 'setup-grok', 'setup-antigravity', 'setup-codex'];
        return {
          cold: document.getElementById('setup').classList.contains('cold'),
          order: ids.filter(shown).sort((a, b) => document.getElementById(a).getBoundingClientRect().top - document.getElementById(b).getBoundingClientRect().top),
          more: shown('setup-more'),
        };
      });
      check('the setup card leads with OpenRouter and an API key, then Claude Code (nothing to install first)', JSON.stringify(card.order) === JSON.stringify(['setup-openrouter', 'setup-keys', 'setup-claude-code']), JSON.stringify(card));
      check('an engine that is not on this computer gets no row (Grok Build, Antigravity, Codex), only a note saying how', card.cold && card.more && !card.order.some((id) => /grok|antigravity|codex/.test(id)), JSON.stringify(card));

      // Settings > AI and agents
      await ui.evaluate(() => window.lumenPrefs.openSettingsPage('ai'));
      let st = null;
      for (let i = 0; i < 40 && !st; i++) {
        await sleep(250);
        st = await app.evaluate(({ webContents }) => {
          const w = webContents.getAllWebContents().find((x) => /settings\.html/.test(x.getURL()));
          return w ? w.executeJavaScript(`(() => {
            const note = document.getElementById('ai-model-empty'); const connect = document.getElementById('ai-model-connect');
            if (!note || !connect) return null;
            const pb = document.querySelector('.picker-host .picker-button');
            return { noteShown: note.getClientRects().length > 0, connectShown: connect.getClientRects().length > 0, text: note.textContent, pickerShown: Boolean(pb) && pb.getClientRects().length > 0 };
          })()`) : null;
        }).catch(() => null);
      }
      check('Settings > AI says no AI is connected and offers Connect an AI', Boolean(st) && st.noteShown && st.connectShown && /No AI connected yet/.test(st.text), JSON.stringify(st));
      check('Settings > AI shows no empty model picker beside it', Boolean(st) && st.pickerShown === false, JSON.stringify(st));
      await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((x) => /settings\.html/.test(x.getURL())).executeJavaScript("document.getElementById('ai-model-connect').click()"));
      await sleep(500);
      const hash = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((x) => /settings\.html/.test(x.getURL())).executeJavaScript('location.hash'));
      check('Connect an AI opens the API keys and sign-ins page', hash === '#ai-keys-page', hash);
      check('no UI errors (nothing connected)', errors.length === 0, errors.join('; '));
    } finally { await app.close().catch(() => {}); }
  }

  // ---------- something connected (a key): the button stops asking for setup, Auto included ----------
  {
    const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: launchEnv({ OPENAI_API_KEY: 'sk-test-not-real' }) });
    try {
      const ui = await app.firstWindow();
      await ui.waitForSelector('.tab');
      await ui.click('#toggle-sidebar');
      let s = await ui.evaluate(() => window.assistant.getSettings());
      for (let i = 0; i < 30 && !s.models.length; i++) { await sleep(300); s = await ui.evaluate(() => window.assistant.getSettings()); }
      await ui.evaluate(() => window.assistant.setModel('auto'));
      await ui.evaluate(() => window.loadModels());
      await sleep(800);
      const btn = await ui.evaluate(() => { const b = document.getElementById('toggle-sidebar'); return { setup: b.classList.contains('needs-setup'), label: b.getAttribute('aria-label'), who: b.dataset.assistant, shown: getComputedStyle(b, '::after').content }; });
      check('with Auto picked and a key connected, the toolbar button no longer says "Set up AI"', !btn.setup && btn.label !== 'Set up AI' && btn.who === 'Lumen' && btn.shown !== '"Set up AI"', JSON.stringify(btn));
    } finally { await app.close().catch(() => {}); }
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
