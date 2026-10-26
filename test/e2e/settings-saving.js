// [settings saving] Settings > failed saves, Reset, empty Add buttons, Proxy and Restart, in a hidden app on a throwaway profile:
//   - a save that fails (the backend is told to throw for one key through global.__failPrefsSet, honoured only under CLAUDE_BROWSER_TEST)
//     puts the switch back and says why in the row (role=alert), and the next good save clears it
//   - Reset settings opens a real dialog that lists the areas; Cancel and Escape change nothing; Reset puts only those back; while Focus mode
//     is on the button is disabled and the backend refuses
//   - an Add button pressed with nothing typed says what to type
//   - Proxy says "Not applied yet" and Apply is live only while something changed
//   - every restart-needed row has the one "Restart" button, and no "Relaunch" is left on the page
// SAVING_SHOTS=<dir> also writes PNGs of the failed save and the dialog (webContents.capturePage).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { tmpProfile, env, root, sleep } = require('../helpers/_settings-open-rig');
const { openSettingsTab } = require('../helpers/settings-tab');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const app = await electron.launch({ args: [process.env.SAVING_ROOT || root], env: env(tmpProfile()) });
  const shotDir = process.env.SAVING_SHOTS;
  const shot = async (id, name) => {
    if (!shotDir) return;
    fs.mkdirSync(shotDir, { recursive: true });
    const b64 = await app.evaluate(async (_e, i) => (await global.__settings.contents(i).capturePage()).toPNG().toString('base64'), id);
    fs.writeFileSync(path.join(shotDir, name), Buffer.from(b64, 'base64'));
  };
  const swallow = (p) => p.on('dialog', (d) => { d.dismiss().catch(() => {}); });
  app.on('window', swallow);
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(1500);
    const pref = (k) => app.evaluate((_e, key) => global.__settings.backend.prefs()[key], k);
    const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(60); } return false; };

    // ---- a failed save
    let run = await openSettingsTab(app, 'accessibility');
    await run('document.getElementById("pref-reduceMotion").scrollIntoView()');
    await app.evaluate(() => { globalThis.__failPrefsSet = 'reduceMotion'; });
    await run('document.getElementById("pref-reduceMotion").click()');
    const alerted = await until(async () => (await run('!!document.querySelector("#pref-reduceMotion").closest(".row").querySelector("[role=alert]")')) === true);
    check('failed save: the row says so with an alert', alerted);
    check('failed save: the message carries the reason', /Couldn’t save: .*the save failed/.test(await run('document.querySelector("#pref-reduceMotion").closest(".row").querySelector("[role=alert]")?.textContent || ""')));
    check('failed save: the switch went back', (await run('document.getElementById("pref-reduceMotion").checked')) === false);
    check('failed save: nothing was stored', (await pref('reduceMotion')) === false);
    await shot(run.id, 'saving-failed-save.png');
    await app.evaluate(() => { globalThis.__failPrefsSet = null; });
    await run('document.getElementById("pref-reduceMotion").click()');
    check('good save after it: stored, switch on, message gone', await until(async () => (await pref('reduceMotion')) === true && (await run('!document.querySelector("#pref-reduceMotion").closest(".row").querySelector("[role=alert]") && document.getElementById("pref-reduceMotion").checked')) === true));
    await run('document.getElementById("pref-reduceMotion").click()'); // (back off)

    // a select reverts too, and a failed save does not run its follow-up
    await app.evaluate(() => { globalThis.__failPrefsSet = 'theme'; });
    const before = await run('document.getElementById("pref-theme").value');
    await run('(() => { const s = document.getElementById("pref-theme"); s.value = s.value === "dark" ? "light" : "dark"; s.dispatchEvent(new Event("change")); })()');
    check('failed save: a select goes back to the stored choice', await until(async () => (await run('document.getElementById("pref-theme").value')) === before));
    await app.evaluate(() => { globalThis.__failPrefsSet = null; });

    // ---- Restart: one word, one button
    await run('document.getElementById("pref-hardwareAcceleration")?.scrollIntoView()');
    await run('document.getElementById("pref-hardwareAcceleration").click()');
    check('restart: the row shows a Restart button once the setting differs', await until(async () => (await run('(() => { const b = document.getElementById("relaunch"); return !!b && !b.hidden && b.textContent === "Restart"; })()')) === true));
    check('restart: no "Relaunch" anywhere on the page', (await run('/relaunch/i.test(document.body.innerText) || [...document.querySelectorAll("button")].some((b) => /relaunch/i.test(b.textContent))')) === false);
    await run('document.getElementById("pref-hardwareAcceleration").click()'); // (back)
    await until(async () => (await pref('hardwareAcceleration')) === true);

    // ---- an Add button with nothing typed
    run = await openSettingsTab(app, 'privacy-adblock');
    const clickAdd = (inputId) => run(`(() => { const i = document.getElementById("${inputId}"); i.value = ""; i.closest(".controls").querySelector("button").click(); return i.closest(".controls").querySelector(".note")?.textContent || ""; })()`);
    check('empty Add (ads allow-list) says what to type', /Type a site first/.test(await clickAdd('adblock-add')));
    check('empty Add: the box has the cursor', (await run('document.activeElement?.id')) === 'adblock-add');
    run = await openSettingsTab(app, 'ai-privacy');
    check('empty "Turn off AI" says what to type', /Type a site first/.test(await clickAdd('ai-off-add')));
    run = await openSettingsTab(app, 'tabs-sleep');
    const unloadAdd = await run('(() => { const b = document.getElementById("unload-never-add-add"); if (!b) return "no button"; b.click(); return b.closest(".row").querySelector(".note[role=status]")?.textContent || ""; })()');
    check('empty "Add site" in Tabs says what to type', /Type a site first/.test(unloadAdd), unloadAdd);

    // ---- Proxy
    run = await openSettingsTab(app, 'proxy');
    await run('document.getElementById("proxy-apply").scrollIntoView()');
    check('proxy: Apply starts disabled, with nothing pending', (await run('document.getElementById("proxy-apply").disabled && document.getElementById("proxy-status").textContent === ""')) === true);
    await shot(run.id, 'saving-proxy-clean.png');
    await run('(() => { const m = document.getElementById("proxy-mode"); m.value = "direct"; m.dispatchEvent(new Event("change")); })()');
    check('proxy: a change says "Not applied yet" and enables Apply', (await run('!document.getElementById("proxy-apply").disabled && document.getElementById("proxy-status").textContent === "Not applied yet"')) === true);
    await shot(run.id, 'saving-proxy-pending.png');
    await run('document.getElementById("proxy-apply").click()');
    check('proxy: Apply saves, says Applied and disables itself', await until(async () => (await run('document.getElementById("proxy-apply").disabled && document.getElementById("proxy-status").textContent === "Applied."')) === true && (await pref('proxy')).mode === 'direct'));
    await run('(() => { const m = document.getElementById("proxy-mode"); m.value = "system"; m.dispatchEvent(new Event("change")); })()');
    check('proxy: a different mode is pending again', (await run('!document.getElementById("proxy-apply").disabled')) === true);
    await run('(() => { const m = document.getElementById("proxy-mode"); m.value = "direct"; m.dispatchEvent(new Event("change")); })()');
    check('proxy: back to what is applied clears the hint and disables Apply', (await run('document.getElementById("proxy-apply").disabled && document.getElementById("proxy-status").textContent === ""')) === true);

    // ---- Reset settings
    await app.evaluate(async () => { await global.__settings.backend.set('theme', 'dark'); await global.__settings.backend.set('aiInstructionsAbout', 'I like cats'); await global.__settings.backend.set('adblockAllow', ['keep.example']); });
    run = await openSettingsTab(app, 'reset');
    await run('document.getElementById("reset").scrollIntoView()');
    const rowText = await run('document.getElementById("reset").closest(".row").querySelector(".desc").textContent');
    const areas = await app.evaluate(() => global.__settings.backend.state().resetAreas.map((a) => a.label));
    check('reset: the row text lists exactly the backend\'s areas', areas.every((a) => rowText.includes(a)) && /Resets appearance, search engine, startup, privacy, site permissions, languages and system settings\./.test(rowText), rowText);
    await shot(run.id, 'saving-reset-row.png');
    await run('document.getElementById("reset").click()');
    check('reset: one click opens a dialog (it does not reset)', await until(async () => (await run('!!document.querySelector("dialog#reset-confirm[open]")')) === true) && (await pref('theme')) === 'dark');
    const listed = await run('[...document.querySelectorAll("#reset-confirm-list li")].map((l) => l.textContent)');
    check('reset: the dialog lists what goes back, the same areas', JSON.stringify(listed) === JSON.stringify(areas), JSON.stringify(listed));
    await shot(run.id, 'saving-reset-dialog.png');
    await run('document.getElementById("reset-confirm-cancel").click()');
    await sleep(300);
    check('reset: Cancel closes it and changes nothing', (await run('!document.querySelector("#reset-confirm")')) === true && (await pref('theme')) === 'dark');
    await run('document.getElementById("reset").click()');
    await until(async () => (await run('!!document.querySelector("dialog#reset-confirm[open]")')) === true);
    await app.evaluate((_e, i) => { global.__settings.contents(i).sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); global.__settings.contents(i).sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); }, run.id);
    await sleep(400);
    check('reset: Escape closes it and changes nothing', (await run('!document.querySelector("#reset-confirm")')) === true && (await pref('theme')) === 'dark');
    await run('document.getElementById("reset").click()');
    await until(async () => (await run('!!document.querySelector("dialog#reset-confirm[open]")')) === true);
    await run('document.getElementById("reset-confirm-go").click()');
    check('reset: confirming puts the listed areas back', await until(async () => (await pref('theme')) === 'system'));
    check('reset: …and leaves the rest (custom instructions, ads allow-list)', (await pref('aiInstructionsAbout')) === 'I like cats' && (await pref('adblockAllow')).join() === 'keep.example');

    // ---- Reset while Focus is on
    run = await openSettingsTab(app, 'focus');
    await until(async () => (await run('typeof window.lumenSettings?.focus?.start')) === 'object' || (await run('typeof window.lumenSettings?.focus?.start')) === 'function');
    await run('window.lumenSettings.focus.start(25).then(() => true)');
    await app.evaluate(async () => { await global.__settings.backend.set('theme', 'dark').catch(() => {}); });
    // a Settings tab opened before Focus began still offers Reset: confirming says why it is refused
    run = await openSettingsTab(app, 'reset');
    await run('document.getElementById("reset").click()');
    await until(async () => (await run('!!document.querySelector("dialog#reset-confirm[open]")')) === true);
    await run('document.getElementById("reset-confirm-go").click()');
    check('focus: a stale page says Focus mode is on instead of resetting', await until(async () => (await run('/Focus mode is on/.test(document.getElementById("reset-status").textContent)')) === true));
    // a fresh page opens with the button disabled and the reason
    await app.evaluate(async (_e, i) => { await global.__closeTabInteractive(i); }, run.id);
    await until(async () => (await app.evaluate(() => global.__settings.tabs().filter((t) => t.settings).length)) === 0);
    run = await openSettingsTab(app, 'reset');
    check('focus: Reset is disabled with the reason while Focus mode is on', await until(async () => (await run('document.getElementById("reset").disabled && /Focus mode is on/.test(document.getElementById("reset-status").textContent)')) === true));
    const refused = await app.evaluate(async () => { try { await global.__settings.backend.reset(); return 'reset'; } catch (e) { return e.message; } });
    check('focus: the backend refuses too', /Focus mode is on/.test(refused), refused);
    check('focus: nothing was reset', (await pref('theme')) === 'dark');
    await shot(run.id, 'saving-reset-focus.png');
  } catch (err) {
    failures++;
    console.log(`FAIL  ${err.stack}`);
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
