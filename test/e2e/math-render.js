// Display math in a real chat window: the Fe–Fe3C lever-rule reply (formulas with "\text{ wt% C}" inside numbered list
// items, 3- and 4-space indents, and one in a block quote) is typeset as MathML once Temml loads, never left as source.
// Run hidden: LUMEN_TEST_BACKGROUND=1 node test/e2e/math-render.js
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-math-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  try {
    const ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');

    const L1 = String.raw`W_{Fe_3C'} = \frac{C_0 - 0.76}{6.70 - 0.76} = 0.049 \Rightarrow C_0 = 0.76 + 0.049(5.94) = 1.05 \text{ wt% C}`;
    const L2 = String.raw`W_\alpha = \frac{6.70 - C_0}{6.70 - 0.022} = 0.846 \Rightarrow C_0 = 6.70 - 0.846(6.678) = 1.05 \text{ wt% C}`;
    const reply = `**Yes, it's possible.**\n\n1. Solve for $C_0$ from the primary cementite fraction using the lever rule:\n\n   $$\n   ${L1}\n   $$\n\n2. Solve for $C_0$ again from the total ferrite fraction:\n\n    $$${L2}$$\n\n3. Both give $C_0 \\approx 1.05$ wt% C.\n\n> $$\n> ${L1}\n> $$`;
    // Rendered into an assistant message the way the chat does, then Temml (loaded on first math) typesets it in place.
    await ui.evaluate((md) => {
      const msg = document.createElement('div');
      msg.className = 'msg assistant';
      msg.id = 'math-e2e';
      msg.innerHTML = window.renderMarkdown(md);
      (document.querySelector('#messages, .messages') || document.body).append(msg);
    }, reply);
    await ui.waitForFunction(() => document.querySelectorAll('#math-e2e .math-block math').length >= 3 || !!window.temml, null, { timeout: 15000 }).catch(() => {});
    // After Temml is here, render again (a finished reply is redrawn) and read the result.
    const got = await ui.evaluate(async (md) => {
      for (let i = 0; i < 100 && !window.temml; i++) await new Promise((r) => setTimeout(r, 100));
      const msg = document.getElementById('math-e2e');
      for (let i = 0; i < 50 && msg.querySelector('.math-src[data-tex]'); i++) await new Promise((r) => setTimeout(r, 100));
      const upgraded = { blocks: msg.querySelectorAll('.math-block math[display="block"]').length, src: msg.querySelectorAll('.math-src').length };
      msg.innerHTML = window.renderMarkdown(md);
      return {
        temml: !!window.temml,
        upgraded,
        blocks: msg.querySelectorAll('.math-block math[display="block"]').length,
        inList: msg.querySelectorAll('ol > li .math-block math').length,
        inQuote: msg.querySelectorAll('blockquote .math-block math').length,
        src: msg.querySelectorAll('.math-src, pre').length,
        // (the LaTeX kept in each <annotation> for copying is not shown text)
        raw: ((c) => { c.querySelectorAll('annotation').forEach((a) => a.remove()); return c.textContent.includes('$$') || c.textContent.includes('\\frac'); })(msg.cloneNode(true)),
        html: msg.innerHTML.replace(/<math[^]*?<\/math>/g, '<math/>').slice(0, 800),
      };
    }, reply);
    check('Temml loaded on the first formula', got.temml, JSON.stringify(got));
    check('formulas drawn before Temml arrived were typeset in place', got.upgraded.blocks === 3 && got.upgraded.src === 0, JSON.stringify(got.upgraded));
    check('both lever-rule formulas in the numbered list render as display MathML', got.inList === 2, got.html);
    check('the formula in a block quote renders', got.inQuote === 1, got.html);
    check('no formula is left as source or a code block', got.src === 0 && !got.raw, got.html);
    check('no UI errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
