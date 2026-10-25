// The toolbar never crowds the address field. At every window width from Lumen's minimum up to a wide one, with any mix of the
// update pill and the "<AI> is using this tab" pill (none, either, both; short copy and the longest copy), every item of the toolbar
// sits whole inside it: nothing overlaps (the start buttons, the address field, each end item), nothing leaves the toolbar or the
// window, the end column contains its items, the address keeps a usable width, and every pill's buttons can still be reached
// (visible, in the window, on top, named). The pills go compact (a short label, then icons only) to make the room; the long words
// stay in the tooltip and the accessible name. The tab strip's pills are checked too.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/toolbar-layout.js   (TOOLBAR_SHOTS=<dir> saves a picture per width with every pill showing)
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

const COPY = {
  short: { update: 'Lumen 0.5.5 is ready: installs when you quit', action: 'Restart', agent: 'Lumen is using this tab' },
  long: { update: 'Couldn’t update to Lumen 0.5.5', action: 'Try again', agent: 'A Long Assistant Name is using this tab' },
};
const STATES = [{ id: 'none' }, ...['short', 'long'].flatMap((copy) => [{ id: `update ${copy}`, update: true, copy }, { id: `agent ${copy}`, agent: true, copy }, { id: `both ${copy}`, update: true, agent: true, copy }, { id: `every pill ${copy}`, update: true, agent: true, all: true, copy }])];

// In the page: put the pills in a state (with the strip's pills shown, and the pills' slide-in turned off so they are measured settled).
const SETUP = ({ s, copy }) => {
  if (!document.getElementById('toolbar-test-style')) document.head.append(Object.assign(document.createElement('style'), { id: 'toolbar-test-style', textContent: '*, *::before, *::after { animation: none !important; transition: none !important; }' }));
  document.body.classList.toggle('agent-active', Boolean(s.agent));
  const pill = document.getElementById('update-pill');
  if (pill) {
    pill.hidden = !s.update;
    pill.querySelector('.update-text').textContent = copy.update;
    pill.querySelector('#update-action .btn-label').textContent = copy.action;
    pill.title = copy.update;
  }
  document.getElementById('agent-pill-text').textContent = copy.agent;
  document.getElementById('agent-pill').title = copy.agent;
  for (const id of ['organize-tabs', 'hands-off-strip', 'hide-ai-tabs']) { const b = document.getElementById(id); if (b) b.hidden = false; }
  // "every pill": the rest of the end column's occupants too, built the way the renderer builds them (app.js): an outside agent's window
  // badge, the approvals count, a working app and an app asking, focus mode on with its time, a download, the zoom pill in the field.
  const mk = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', ...(text !== undefined ? { textContent: text } : {}) });
  const btn = (cls, text) => Object.assign(mk('button', cls, text), { type: 'button' });
  const on = Boolean(s.all);
  const show = (id, yes) => { const e = document.getElementById(id); if (e) e.hidden = !yes; };
  const chip = document.getElementById('agent-window-chip');
  chip.hidden = !on; chip.textContent = on ? 'Claude Code window' : ''; chip.title = chip.textContent;
  show('agents-pending', on);
  const pills = document.getElementById('external-pills');
  const ext = mk('div', 'external-pill');
  ext.title = 'Claude Desktop is using Lumen';
  ext.append(mk('span', 'agent-dot'), mk('span', 'external-pill-text', ext.title), btn('external-takeover', 'Take over'), btn('external-stop', 'Stop'));
  pills.replaceChildren(...(on ? [ext] : []));
  pills.hidden = !on;
  const bar = document.getElementById('external-bar');
  const words = mk('span', 'update-text external-ask-text');
  words.append(mk('span', 'ea-rest', 'wants to use Lumen: '), mk('span', 'ea-name', 'Claude Desktop'), mk('span', 'ea-rest', ''));
  bar.replaceChildren(...(on ? [mk('span', 'update-dot'), words, btn('primary external-ask-btn', 'Allow this time'), btn('external-ask-btn', 'Deny')] : []));
  bar.title = 'Claude Desktop wants to use Lumen';
  bar.hidden = !on;
  document.getElementById('focus-btn').classList.toggle('on', on);
  const ft = document.getElementById('focus-time');
  ft.hidden = !on; ft.textContent = on ? '1:29:59' : '';
  show('downloads', on);
  const zoom = document.getElementById('zoom');
  if (zoom) { zoom.hidden = !on; zoom.textContent = on ? '250%' : ''; }
  document.body.classList.toggle('zoomed', on);
};

// In the page: report the geometry of the settled toolbar.
const MEASURE = () => {
  const vis = (el) => el && el.getClientRects().length > 0;
  const R = (el) => { const r = el.getBoundingClientRect(); return { el, id: el.id || el.className || el.tagName, l: r.left, r: r.right, t: r.top, b: r.bottom }; };
  const tb = document.querySelector('.toolbar').getBoundingClientRect();
  const start = document.querySelector('.toolbar-start');
  const end = document.querySelector('.toolbar-end');
  const omni = document.querySelector('.omnibox');
  const endBox = end.getBoundingClientRect();
  const rects = [...start.children, omni, ...end.children].filter(vis).map(R);
  // (the pills' own parts too: a pill whose words outgrow it runs its buttons into each other)
  for (const g of [...end.children].filter(vis)) if (/pill|chip|external/.test(g.className + g.id) && g.children.length > 1) rects.push(...[...g.children].filter((c) => vis(c) && c.getBoundingClientRect().width > 2).map((c) => ({ ...R(c), id: `${g.id || g.className} > ${c.id || c.className}` })));
  const overlaps = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) overlaps.push(`${a.id} x ${b.id} (${Math.round(a.l)}-${Math.round(a.r)} / ${Math.round(b.l)}-${Math.round(b.r)})`);
    }
  }
  // Nothing outside the toolbar's box or the window.
  const outside = rects.filter((r) => r.l < tb.left - 0.5 || r.r > tb.right + 0.5 || r.l < -0.5 || r.r > innerWidth + 0.5).map((r) => `${r.id} ${Math.round(r.l)}-${Math.round(r.r)}`);
  const endOut = [...end.children].filter(vis).map(R).filter((r) => r.l < endBox.left - 0.5 || r.r > endBox.right + 0.5).map((r) => `${r.id} ${Math.round(r.l)}-${Math.round(r.r)} vs column ${Math.round(endBox.left)}-${Math.round(endBox.right)}`);
  const pills = ['#update-pill', '#agent-pill'].map((sel) => document.querySelector(sel)).filter(vis).map((p) => {
    const bad = [];
    for (const b of [...p.querySelectorAll('button')].filter((x) => !x.hidden)) {
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) { bad.push(`${b.id} has no size`); continue; }
      if (r.left < 0 || r.right > innerWidth) bad.push(`${b.id} outside the window`);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || (hit !== b && !b.contains(hit))) bad.push(`${b.id} covered by ${hit && (hit.id || hit.className || hit.tagName)}`);
      if (!(b.getAttribute('aria-label') || b.textContent || '').trim()) bad.push(`${b.id} has no name`);
      if (r.width < 24 - 0.5 && b.id === 'agent-stop') bad.push(`${b.id} is under 24px wide`);
    }
    const words = p.id === 'agent-pill' ? document.getElementById('agent-pill-text').textContent : p.querySelector('.update-text').textContent;
    return { id: p.id, bad, words, name: p.textContent, title: p.title, w: Math.round(p.getBoundingClientRect().width) };
  });
  const strip = document.querySelector('.tabstrip').getBoundingClientRect();
  const tabs = document.querySelector('.tabs').getBoundingClientRect();
  const stripPills = ['organize-tabs', 'hands-off-strip', 'hide-ai-tabs', 'new-tab'].map((id) => document.getElementById(id)).filter(vis).map((b) => {
    const r = b.getBoundingClientRect();
    return { id: b.id, inside: r.left >= strip.left - 0.5 && r.right <= strip.right + 0.5, overlap: r.left < tabs.right - 0.5 && r.right > tabs.left + 0.5 };
  });
  return { kids: [...end.children].filter(vis).map((c) => (c.id || c.className) + ':' + Math.round(c.getBoundingClientRect().width)).join(' '), overlaps, outside, endOut, pills, stripPills, omniW: omni.getBoundingClientRect().width, compact: end.dataset.compact, vw: innerWidth, sw: document.documentElement.scrollWidth };
};

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-toolbar-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const win = ({ BrowserWindow }, width) => {
    const w = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0];
    if (width === 'min') w.setSize(100, 760); else w.setContentSize(width, 760); // (100 is clamped up to the window's minimum)
  };
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.toolbar-end');
    await page.waitForSelector('#update-pill', { state: 'attached' });
    const min = await app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].getMinimumSize()[0]);
    check('Lumen has a minimum window width of 800 px or less', min > 0 && min <= 800, min);
    for (const w of [1920, 1400, 1280, 1200, 1000, 900, 800, 'min']) {
      await app.evaluate(win, w);
      await page.waitForTimeout(400);
      const vw = await page.evaluate(() => innerWidth);
      const label = w === 'min' ? `minimum (${vw}px)` : `${w}px`;
      // (The page is a few pixels wider than the content size asked for: the window's frame.)
      if (w === 'min') check('the minimum width is the smallest the window can be made', vw <= 830 && vw >= 700, vw);
      else check(`${label}: window was resized`, Math.abs(vw - w) <= 20, `inner width ${vw}`);
      for (const s of STATES) {
        await page.evaluate(SETUP, { s, copy: COPY[s.copy || 'short'] });
        await page.waitForTimeout(120);
        const m = await page.evaluate(MEASURE);
        const tag = `${label}, ${s.id}`;
        if (process.env.TOOLBAR_DEBUG) console.log(tag, JSON.stringify({ compact: m.compact, omniW: m.omniW, pills: m.pills.map((p) => [p.id, p.w]), kids: m.kids }));
        check(`${tag}: nothing overlaps and nothing leaves the toolbar`, m.overlaps.length === 0 && m.outside.length === 0, JSON.stringify({ overlaps: m.overlaps, outside: m.outside, compact: m.compact }));
        check(`${tag}: the end column contains its items and the address keeps room`, m.endOut.length === 0 && m.omniW >= (m.compact === '4' ? 160 : 240) - 0.5, JSON.stringify({ endOut: m.endOut, omniW: m.omniW }));
        const pillsOk = m.pills.length === (s.update ? 1 : 0) + (s.agent ? 1 : 0) && m.pills.every((p) => p.bad.length === 0 && p.name.includes(p.words) && p.title.includes(p.words));
        check(`${tag}: every pill is shown, reachable, named, with its full words in the tooltip`, pillsOk, JSON.stringify(m.pills));
        check(`${tag}: the page does not scroll sideways`, m.sw <= m.vw, `${m.sw} > ${m.vw}`);
        if (s.id === 'both long') {
          for (const p of m.stripPills) check(`${tag}: tab strip #${p.id} is inside the strip and clear of the tabs`, p.inside && !p.overlap, JSON.stringify(p));
        }
        if (s.id === 'every pill long' && process.env.TOOLBAR_SHOTS) {
          fs.mkdirSync(process.env.TOOLBAR_SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.TOOLBAR_SHOTS, `toolbar-all-pills-${vw}.png`), clip: { x: 0, y: 0, width: vw, height: 92 } }).catch((e) => console.log('screenshot failed:', e.message));
        }
      }
    }
    // Compaction comes in steps: a wide window keeps the full words, the narrowest is icons only.
    await app.evaluate(win, 1400);
    await page.waitForTimeout(300);
    await page.evaluate(SETUP, { s: STATES.find((x) => x.id === 'both long'), copy: COPY.long });
    await page.waitForTimeout(150);
    check('at 1400 px both pills keep their full words', (await page.evaluate(() => document.querySelector('.toolbar-end').dataset.compact)) === '0', 'compact');
    await app.evaluate(win, 'min');
    await page.waitForTimeout(300);
    check('at the minimum width both long pills are compact', (await page.evaluate(() => document.querySelector('.toolbar-end').dataset.compact)) !== '0', 'compact');
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch {} // (Electron may still hold the folder briefly)
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
