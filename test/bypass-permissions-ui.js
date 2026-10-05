// The sidebar's permission menu (the bolt in the sidebar head: Ask / Auto-allow actions / Bypass permissions) and the badge above the
// message box, in a real window, and the same choice in Settings → AI. Turning a level up takes a second click, turning it down one;
// the saved settings and the agent's switches follow; Settings and the sidebar stay in step. Run with LUMEN_TEST_BACKGROUND=1.
// BYPASS_SHOTS=<dir> also saves screenshots of the menu, the armed line and the indicator there.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-bypass-ui-'));
  const shots = process.env.BYPASS_SHOTS || '';
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });
    await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-hidden')));
    await sleep(400);

    const saved = () => app.evaluate(() => { const p = global.__settings.backend.prefs(); return { ask: p.askBeforeActing, bypass: p.bypassPermissions }; });
    const agentSees = () => app.evaluate(() => ({ bypass: global.__agent.bypassOn(), auto: global.__agent.autoAllows({}) }));
    const view = () => ui.evaluate(() => {
      const b = document.getElementById('auto-allow');
      const menu = document.getElementById('perm-menu');
      const badge = document.getElementById('bypass-badge');
      const r = (el) => { const x = el.getBoundingClientRect(); return { w: Math.round(x.width), h: Math.round(x.height), right: Math.round(x.right), left: Math.round(x.left) }; };
      return {
        mode: b.dataset.mode, pressed: b.getAttribute('aria-pressed'), expanded: b.getAttribute('aria-expanded'), title: b.title,
        menuOpen: !menu.hidden, menuBox: menu.hidden ? null : r(menu), win: innerWidth,
        checked: [...menu.querySelectorAll('.perm-item')].filter((i) => i.getAttribute('aria-checked') === 'true').map((i) => i.dataset.mode),
        armed: [...menu.querySelectorAll('.perm-item.armed')].map((i) => i.dataset.mode),
        names: [...menu.querySelectorAll('.perm-name')].map((n) => n.textContent),
        descs: [...menu.querySelectorAll('.perm-desc')].map((n) => n.textContent),
        note: document.getElementById('perm-note')?.textContent || '',
        badgeShown: Boolean(badge) && !badge.hidden && badge.getBoundingClientRect().width > 0, badgeText: badge?.textContent || '',
        color: getComputedStyle(b).color, handsOffShown: !document.getElementById('hands-off').hidden,
      };
    });
    const clickBolt = () => ui.evaluate(() => document.getElementById('auto-allow').click());
    const clickItem = (mode) => ui.evaluate((m) => document.getElementById(`perm-${m}`).click(), mode);
    const shot = async (name, selector) => { if (shots) await ui.screenshot({ path: path.join(shots, name), clip: selector ? await ui.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 }; }, selector) : undefined }); };

    // the start: Ask
    let v = await view();
    check('starts on Ask: the bolt is plain, the menu is closed, no badge', v.mode === 'ask' && v.pressed === 'false' && !v.menuOpen && !v.badgeShown && v.expanded === 'false', JSON.stringify(v));
    let s = await saved();
    check('Ask is saved as ask-before-acting on, bypass off, and the agent is not bypassing', s.ask === true && s.bypass === false && (await agentSees()).bypass === false, JSON.stringify([s, await agentSees()]));

    // the menu
    await clickBolt();
    await sleep(700);
    v = await view();
    check('the bolt opens a menu with Ask, Auto-allow actions and Bypass permissions, Ask marked', v.menuOpen && v.expanded === 'true' && v.names.join('|') === 'Ask|Auto-allow actions|Bypass permissions' && v.checked.join() === 'ask', JSON.stringify(v));
    check('the Bypass line carries the one-line warning', /won’t ask before acting, reading PDFs, using your signed-in accounts, or sending what it read anywhere/.test(v.descs[2]), v.descs[2]);
    check('the menu says what still applies (AI-off sites, kept-off tabs, hands-off) and that choosing a file still needs the user', /Hands-off/.test(v.note) && /file for an upload still needs you/.test(v.note), v.note);
    check('the menu fits inside the window', v.menuBox && v.menuBox.right <= v.win && v.menuBox.left >= 0, JSON.stringify(v.menuBox));
    await shot('permission-menu.png', '#perm-menu');

    // Auto-allow: a second click confirms
    await clickItem('auto');
    v = await view();
    s = await saved();
    check('Auto-allow actions: the first click only arms it (the line asks to click again), nothing is saved yet', v.armed.join() === 'auto' && /Click again to confirm/.test(v.descs[1]) && v.mode === 'ask' && s.ask === true, JSON.stringify([v.armed, v.descs[1], s]));
    await clickItem('auto');
    await waitFor(async () => (await saved()).ask === false);
    v = await view();
    s = await saved();
    check('Auto-allow actions: the second click turns it on (saved as before: ask-before-acting off), the bolt is filled, the menu closes', s.ask === false && s.bypass === false && v.mode === 'auto' && v.pressed === 'true' && !v.menuOpen && !v.badgeShown, JSON.stringify([s, v]));
    check('Auto-allow actions: the agent skips the per-site cards but is not bypassing', JSON.stringify(await agentSees()) === JSON.stringify({ bypass: false, auto: true }), JSON.stringify(await agentSees()));

    // Bypass: armed first, a persistent indicator after
    await clickBolt();
    v = await view();
    check('reopened on Auto-allow: that line is the marked one', v.checked.join() === 'auto', JSON.stringify(v.checked));
    await clickItem('bypass');
    v = await view();
    s = await saved();
    check('Bypass permissions: the first click only arms it, the line says to click again', v.armed.join() === 'bypass' && /Click again to confirm/.test(v.descs[2]) && s.bypass === false && v.mode === 'auto', JSON.stringify([v.armed, s]));
    await shot('permission-menu-armed.png', '#perm-menu');
    await clickItem('bypass');
    await waitFor(async () => (await saved()).bypass === true);
    v = await view();
    s = await saved();
    check('Bypass permissions: the second click turns it on and the agent bypasses', s.bypass === true && (await agentSees()).bypass === true, JSON.stringify([s, await agentSees()]));
    check('Bypass permissions: the bolt turns red and filled, and the composer shows the "Bypass permissions on" badge', v.mode === 'bypass' && v.pressed === 'true' && v.badgeShown && /Bypass permissions on/.test(v.badgeText) && /bypass/i.test(v.title), JSON.stringify(v));
    await sleep(500);
    v = await view();
    const red = await ui.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--danger)'; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; });
    check('Bypass permissions: the bolt uses the danger colour', v.color === red, `${v.color} vs ${red}`);
    await shot('bypass-on-composer.png', '#composer');
    if (shots) await ui.screenshot({ path: path.join(shots, 'bypass-on-sidebar.png') });

    // Settings follows, and a change there reaches the sidebar
    const id = await app.evaluate((_e) => global.__settings.open('ask-before-acting'));
    const inSettings = (code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, [id, code]);
    await waitFor(() => inSettings('document.body?.dataset.ready === "1" && Boolean(document.getElementById("pref-aiPermissionMode"))'));
    check('Settings → AI shows the same choice, on Bypass, with the warning under it', (await inSettings('document.getElementById("pref-aiPermissionMode").value')) === 'bypass' && /won’t ask before acting/.test(await inSettings('document.getElementById("perm-warn").textContent')), await inSettings('document.getElementById("pref-aiPermissionMode").value'));
    check('Settings explains it at length (what is still in force, and the Choose file… card)', /Choose file/.test(await inSettings('document.getElementById("pref-aiPermissionMode").closest(".row").textContent')) && /Hands-off mode/.test(await inSettings('document.getElementById("pref-aiPermissionMode").closest(".row").textContent')), '');
    if (shots) {
      await app.evaluate(async (_e, i) => { const wc = global.__settings.contents(i); wc.executeJavaScript('document.getElementById("pref-aiPermissionMode").scrollIntoView({block:"center"})'); }, id);
      await sleep(300);
      const png = await app.evaluate(async (_e, i) => (await global.__settings.contents(i).capturePage()).toPNG().toString('base64'), id);
      fs.writeFileSync(path.join(shots, 'settings-permission-mode.png'), Buffer.from(png, 'base64'));
    }
    await inSettings('(() => { const s = document.getElementById("pref-aiPermissionMode"); s.value = "ask"; s.dispatchEvent(new Event("change")); })()');
    await waitFor(async () => (await saved()).bypass === false);
    await waitFor(async () => (await view()).mode === 'ask');
    v = await view();
    s = await saved();
    check('choosing Ask in Settings turns both off, and the sidebar follows at once (bolt plain, badge gone)', s.bypass === false && s.ask === true && v.mode === 'ask' && v.pressed === 'false' && !v.badgeShown, JSON.stringify([s, v.mode, v.badgeShown]));
    await app.evaluate(() => global.__settings.backend.set('aiPermissionMode', 'bypass'));
    await waitFor(async () => (await view()).mode === 'bypass');
    check('a change made in Settings reaches the sidebar without a reload (bolt red, badge shown)', (await view()).badgeShown === true && (await saved()).bypass === true);
    check('Settings rejects a value that is not a mode', await app.evaluate(async () => { try { await global.__settings.backend.set('aiPermissionMode', 'everything'); return false; } catch { return true; } }));

    // Down is one click
    await clickBolt();
    await clickItem('ask');
    await waitFor(async () => (await view()).mode === 'ask');
    v = await view();
    s = await saved();
    check('turning down to Ask takes one click and turns both off', v.mode === 'ask' && !v.menuOpen && !v.badgeShown && s.ask === true && s.bypass === false, JSON.stringify([v.mode, s]));

    // The menu closes with Escape and a click outside; an armed line expires
    await clickBolt();
    await clickItem('bypass');
    check('an armed line is armed', (await view()).armed.join() === 'bypass');
    await ui.keyboard.press('Escape');
    v = await view();
    check('Escape closes the menu and drops the armed line (nothing changed)', !v.menuOpen && (await saved()).bypass === false);
    await clickBolt();
    await ui.mouse.click(300, 400);
    check('a click outside closes the menu', !(await view()).menuOpen);
    await clickBolt();
    await clickItem('bypass');
    await sleep(4400);
    check('an armed line expires after a few seconds', (await view()).armed.length === 0 && (await saved()).bypass === false);
    await clickBolt();

    check('the menu is reachable by keyboard: items are real buttons in a menu with radio roles', await ui.evaluate(() => { const m = document.getElementById('perm-menu'); return m.getAttribute('role') === 'menu' && [...m.querySelectorAll('button')].every((b) => b.getAttribute('role') === 'menuitemradio') && document.getElementById('auto-allow').getAttribute('aria-haspopup') === 'menu'; }));
    check('the page has no script errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
