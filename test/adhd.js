// ADHD mode: the setting toggles the answer-style rules in the system prompt Claude receives.
const { _electron: electron } = require('playwright-core');
const path = require('path');

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

  // Fake Claude: records the system prompt, answers with plain text.
  await app.evaluate(() => {
    global.__systems = [];
    global.__agent.getClient = () => ({
      beta: { messages: { stream: (params) => {
        global.__systems.push(params.system);
        const message = { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' };
        return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
      } } },
    });
  });
  const ask = async () => {
    await app.evaluate(() => new Promise((resolve) => global.__agent.run('hi', (e) => { if (e.type === 'done') resolve(); })));
    return app.evaluate(() => global.__systems[global.__systems.length - 1]);
  };

  await ui.evaluate(() => { document.body.classList.remove('sidebar-hidden'); document.getElementById('open-settings').click(); });
  await ui.waitForTimeout(300);
  check('ADHD mode toggle is on by default', await ui.isChecked('#adhd-mode'), 'unchecked');
  check('ADHD rules sent when on', (await ask()).includes('the user has ADHD'), 'missing');
  await ui.click('#adhd-mode');
  await ui.waitForTimeout(300);
  await app.evaluate(() => global.__agent.reset()); // settings apply to new chats
  check('ADHD rules removed when turned off', !(await ask()).includes('the user has ADHD'), 'still present');
  await ui.click('#adhd-mode');
  await ui.waitForTimeout(300);
  await app.evaluate(() => global.__agent.reset()); // settings apply to new chats
  check('ADHD rules back when turned on again', (await ask()).includes('the user has ADHD'), 'missing');

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
