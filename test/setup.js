// "Set up an AI": nothing connected hides the picker and shows three equal ways in; connecting any
// one provider (API key, or the user's own Claude Code) shows only its models and hides the card.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findClaude } = require('../claude-code');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A base env with every provider's key scrubbed and no signed-in `ant` (Anthropic CLI) profile.
  // Each scenario below (LUMEN_CLAUDE_BIN, CLAUDE_BROWSER_TEST's own fresh userData) also keeps the
  // Claude Code CLI and any stored key out of the picture unless the scenario means to add one.
  const cleanEnv = () => {
    const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', ANTHROPIC_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-setup-ant-')) };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete env[k];
    return env;
  };

  // ---------- scenario 1: nothing connected ----------
  {
    // A bogus path forces findClaude() to report "not installed" regardless of this machine's
    // real setup, so the "nothing connected" case is deterministic everywhere.
    const env = { ...cleanEnv(), LUMEN_CLAUDE_BIN: path.join(os.tmpdir(), 'lumen-setup-no-such-claude-binary') };
    const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
    const ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await sleep(1500); // past the 800ms Claude Code detection

    const s = await ui.evaluate(() => window.assistant.getSettings());
    check('nothing connected: no models, no model, not ready', s.models.length === 0 && s.model === null && s.ready === false, JSON.stringify(s));

    const dom = await ui.evaluate(() => ({
      pickerHidden: document.querySelector('.model-picker')?.hidden,
      setupHidden: document.getElementById('setup').hidden,
      options: [...document.querySelectorAll('.setup-option .setup-name')].map((e) => e.textContent),
      ccDisabled: document.getElementById('setup-claude-code').disabled,
    }));
    check('picker is hidden, not just empty', dom.pickerHidden === true, JSON.stringify(dom));
    check('setup card is visible', dom.setupHidden === false, JSON.stringify(dom));
    check('three equal options: API key, OpenRouter, Claude Code', JSON.stringify(dom.options) === JSON.stringify(['Add an API key', 'Sign in with OpenRouter', 'Use your own Claude Code']), JSON.stringify(dom.options));
    check('Claude Code option is disabled (not installed here)', dom.ccDisabled === true, dom.ccDisabled);

    check('no UI errors (nothing connected)', errors.length === 0, errors.join('; '));
    await app.close();
  }

  // ---------- scenario 2: one provider connected via env (OpenAI) ----------
  {
    // A key that isn't real: main's startup refreshModels() tries it, fails, and falls back to
    // OpenAI's default model list — connected, just without a fetched list.
    const env = { ...cleanEnv(), OPENAI_API_KEY: 'sk-test-not-real', LUMEN_CLAUDE_BIN: path.join(os.tmpdir(), 'lumen-setup-no-such-claude-binary') };
    const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
    const ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());

    let s = await ui.evaluate(() => window.assistant.getSettings());
    for (let i = 0; i < 30 && s.models.length === 0; i++) { await sleep(300); s = await ui.evaluate(() => window.assistant.getSettings()); }
    check('only the connected provider\'s models are listed', s.models.length > 0 && s.models.every((m) => m.id.startsWith('openai:')), JSON.stringify(s.models));
    check('OpenAI defaults used (the fake key fails, falls back)', s.models.map((m) => m.id).sort().join() === ['openai:gpt-5.6', 'openai:gpt-5.6-mini'].sort().join(), JSON.stringify(s.models));
    check('a connected model is selected and ready', s.model?.startsWith('openai:') && s.ready === true, JSON.stringify(s));

    const dom = await ui.evaluate(() => ({
      pickerHidden: document.querySelector('.model-picker')?.hidden,
      setupHidden: document.getElementById('setup').hidden,
    }));
    check('picker is visible', dom.pickerHidden === false, JSON.stringify(dom));
    check('setup card is hidden', dom.setupHidden === true, JSON.stringify(dom));

    check('no UI errors (OpenAI connected)', errors.length === 0, errors.join('; '));
    await app.close();
  }

  // ---------- scenario 3: Claude Code, real detection ----------
  {
    const bin = await findClaude();
    if (!bin) {
      console.log('SKIP  Claude Code connect flow: the claude CLI is not installed on this machine');
    } else {
      const app = await electron.launch({ args: [path.join(__dirname, '..')], env: cleanEnv() });
      const ui = await app.firstWindow();
      const errors = [];
      ui.on('pageerror', (e) => errors.push(e.message));
      await ui.waitForSelector('.tab');
      await ui.evaluate(() => document.getElementById('toggle-sidebar').click());

      let disabled = true;
      for (let i = 0; i < 30 && disabled; i++) { await sleep(300); disabled = await ui.evaluate(() => document.getElementById('setup-claude-code').disabled); }
      check('Claude Code option becomes enabled once detected', disabled === false, 'still disabled after 9s');
      // With Claude Code the only thing connected in this env, main already made it the fallback
      // model the moment it was detected (same as OpenAI alone in scenario 2) — so the setup card
      // may already be hidden here. The click still has to work regardless (a real click, if the
      // card is still up; the same handler otherwise), and land on the right model either way.
      const box = await ui.locator('#setup-claude-code').boundingBox();
      if (box) await ui.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      else await ui.evaluate(() => document.getElementById('setup-claude-code').click());
      await sleep(400);

      const s = await ui.evaluate(() => window.assistant.getSettings());
      const setupHidden = await ui.evaluate(() => document.getElementById('setup').hidden);
      check('selecting it sets the model to claudecode:default', s.model === 'claudecode:default', s.model);
      check('the setup card is hidden once connected', setupHidden === true, setupHidden);

      check('no UI errors (Claude Code connected)', errors.length === 0, errors.join('; '));
      await app.close();
    }
  }

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
