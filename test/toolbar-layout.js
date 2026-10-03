// Toolbar pills (update, "Lumen is using this tab", zoom) are never clipped or overlapped at ordinary window
// widths: every pill sits whole inside the toolbar's end column, clear of the address field and its star.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

// In the page: show the pills with their longest copy, then report each one's rect against its ancestors' clip boxes.
const MEASURE = `(() => {
  document.body.classList.add('agent-active');
  document.head.append(Object.assign(document.createElement('style'), { textContent: '*, *::before, *::after { animation: none !important; transition: none !important; }' })); // (the pills slide in: measure them settled)
  const pill = document.getElementById('update-pill');
  if (pill) {
    pill.hidden = false;
    pill.querySelector('.update-text').textContent = 'Couldn\u2019t update to Lumen 0.5.5';
    document.getElementById('update-action').textContent = 'Try again';
  }
  for (const id of ['organize-tabs', 'hands-off-strip', 'hide-ai-tabs']) { const b = document.getElementById(id); if (b) b.hidden = false; }
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width }; };
  const out = [];
  for (const sel of ['#agent-pill', '#update-pill']) {
    const el = document.querySelector(sel);
    if (!el || !el.getClientRects().length) { out.push({ sel, missing: true }); continue; }
    const r = rect(el);
    // Whole means visible: no clipping ancestor cuts into it, and its own buttons are inside it.
    let clipped = 0;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a);
      if (o.overflowX === 'visible') continue;
      const c = a.getBoundingClientRect();
      clipped = Math.max(clipped, c.left - r.l, r.r - c.right);
    }
    const inner = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect()).filter((b) => b.width);
    const innerOut = Math.max(0, ...inner.map((b) => Math.max(r.l - b.left, b.right - r.r)));
    out.push({ sel, left: r.l, right: r.r, clipped: Math.round(clipped * 10) / 10, innerOut: Math.round(innerOut * 10) / 10 });
  }
  const box = document.getElementById('omnibox')?.getBoundingClientRect() || document.querySelector('.omnibox').getBoundingClientRect();
  const star = document.querySelector('.omnibox .star')?.getBoundingClientRect();
  const end = document.querySelector('.toolbar-end').getBoundingClientRect();
  const kids = [...document.querySelector('.toolbar-end').children].filter((c) => c.getClientRects().length).map((c) => ({ id: c.id || c.tagName, l: c.getBoundingClientRect().left, r: c.getBoundingClientRect().right }));
  // The tab strip's pills sit whole in the strip and clear of the tabs (which scroll, so they give way).
  const strip = document.querySelector('.tabstrip').getBoundingClientRect();
  const tabs = document.querySelector('.tabs').getBoundingClientRect();
  const stripPills = ['organize-tabs', 'hands-off-strip', 'hide-ai-tabs', 'new-tab'].map((id) => document.getElementById(id)).filter((b) => b && b.getClientRects().length).map((b) => {
    const r = b.getBoundingClientRect();
    return { id: b.id, inside: r.left >= strip.left - 0.5 && r.right <= strip.right + 0.5, overlap: r.left < tabs.right - 0.5 && r.right > tabs.left + 0.5 };
  });
  return { stripPills, out, omniRight: box.right, starRight: star ? star.right : 0, endLeft: end.left, endRight: end.right, kids, vw: innerWidth, sw: document.documentElement.scrollWidth };
})()`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-toolbar-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  try {
    const page = (await Promise.all([app.firstWindow()]))[0];
    await page.waitForSelector('.toolbar-end');
    for (const w of [800, 1000, 1400]) {
      await app.evaluate(({ BrowserWindow }, width) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].setContentSize(width, 760), w);
      await page.waitForTimeout(400);
      const m = await page.evaluate(MEASURE);
      if (process.env.TOOLBAR_DEBUG) console.log(JSON.stringify(m));
      for (const p of m.out) {
        if (p.missing) { check(`${w}px: ${p.sel} is shown`, false, 'not rendered'); continue; }
        check(`${w}px: ${p.sel} is not clipped by an ancestor`, p.clipped <= 0.5, p.clipped);
        check(`${w}px: ${p.sel} keeps its buttons inside it`, p.innerOut <= 0.5, p.innerOut);
        check(`${w}px: ${p.sel} clears the address field`, p.left >= m.omniRight - 0.5, `${p.left} < ${m.omniRight}`);
      }
      for (const p of m.stripPills) {
        check(`${w}px: tab strip #${p.id} is inside the strip`, p.inside, JSON.stringify(p));
        check(`${w}px: tab strip #${p.id} does not overlap the tabs`, !p.overlap, JSON.stringify(p));
      }
      check(`${w}px: the page does not scroll sideways`, m.sw <= m.vw, `${m.sw} > ${m.vw}`);
    }
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} // (Electron may still hold the folder briefly)
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
