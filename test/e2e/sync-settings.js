// [sync] Settings → General → Sync in a real (hidden) app on a throwaway profile, with a temp folder as the cloud drive and a second
// "computer" played from this process: off by default and nothing loaded, the set-up form and its refusals (no folder, short or wrong
// passphrase), turning it on, the passphrase kept encrypted on this computer only, nothing readable in the folder, a bookmark arriving from
// the other computer on Sync now, the "what syncs" switches, the passwords switch (off, and blocked while Save passwords is off), Turn off
// (asks twice, forgets the passphrase) and that a relaunch picks sync up by itself without asking again.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../../src/features/sync-core');
const P = require('../../src/features/sync-providers');
const { openSettingsTab } = require('../helpers/settings-tab');

const root = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASS = 'a good sync passphrase';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sync-settings-'));
  const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sync-cloud-ui-'));
  const launch = () => electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_SYNC_TEST_MS: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const settingsJson = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')); } catch { return {}; } };
  const flush = (app) => app.evaluate(() => global.__settingsFlush?.());
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);

  const shot = async (app, id, name) => { if (!process.env.SYNC_SHOT) return; const png = await app.evaluate(async (_e, i) => (await global.__settings.contents(i).capturePage()).toPNG().toString('base64'), id); fs.writeFileSync(path.join(process.env.SYNC_SHOT, name + '.png'), Buffer.from(png, 'base64')); };
  let app = await launch();
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(1500);

    // ---- off by default: nothing loaded, nothing on disk
    const loaded = await app.evaluate(() => global.__perf.modules().filter((f) => /sync-(core|folder|providers)\.js$/.test(f)));
    check('off by default: the sync modules are not loaded at startup', loaded.length === 0, loaded.join());
    check('off by default: no sync files in the profile and no setting', !fs.readdirSync(profile).some((f) => /^sync-/.test(f)) && settingsJson().syncFolder === undefined);

    const inSettings = await openSettingsTab(app, 'general');
    await waitFor(async () => (await inSettings('Boolean(document.getElementById("sync-setup"))')) === true);
    check('Settings → General has a Sync row with a Set up button, off', (await inSettings('Boolean(document.getElementById("sync-setup")) && !document.getElementById("sync-now")')) === true);
    const desc = await inSettings('document.getElementById("sync-head").textContent');
    check('the row says what it does in plain words: your own cloud folder, no server, encrypted', /cloud drive/i.test(desc) && /no server/i.test(desc) && /encrypted/i.test(desc), desc);
    check('opening Settings did not load the sync modules', (await app.evaluate(() => global.__perf.modules().some((f) => /sync-(core|folder|providers)\.js$/.test(f)))) === false);
    check('the old "Lumen doesn\'t sync" text is gone', !/Lumen doesn.t sync/.test(await inSettings('document.body.textContent')));
    check('search finds it by "dropbox" and "sync"', (await inSettings('document.getElementById("sync-head").dataset.keywords')).includes('dropbox'));

    await shot(app, inSettings.id, 'off');
    // ---- the form and its refusals
    await inSettings('document.getElementById("sync-setup").click()');
    await waitFor(async () => (await inSettings('Boolean(document.getElementById("sync-form"))')) === true);
    const formText = await inSettings('document.getElementById("sync-form").textContent');
    check('the form has a folder chooser, a passphrase box and a switch for each kind of data', (await inSettings(`['sync-pick','sync-passphrase','sync-enable','sync-new-bookmarks','sync-new-history','sync-new-chats','sync-new-widgets','sync-new-settings','sync-new-passwords'].every((id) => document.getElementById(id))`)) === true);
    check('the passwords switch is off and unusable while Save passwords is off', (await inSettings('(() => { const i = document.getElementById("sync-new-passwords"); return i.checked === false && i.disabled === true; })()')) === true);
    check('the passphrase box is a password field that is not remembered', (await inSettings('(() => { const i = document.getElementById("sync-passphrase"); return i.type === "password" && i.autocomplete === "off"; })()')) === true);
    check('the form says the passphrase stays on this computer and cannot be recovered', /this computer only/.test(formText) && /can’t recover/.test(formText), formText);
    await inSettings('document.getElementById("sync-enable").click()');
    check('Turn on with no folder says so', Boolean(await waitFor(async () => /isn.t there|Choose/.test(await inSettings('document.getElementById("sync-form-status").textContent')), 4000)));
    await app.evaluate((_e, dir) => { global.__syncPick = dir; }, cloud);
    await inSettings('document.getElementById("sync-pick").click()');
    check('Choose folder fills in the folder', Boolean(await waitFor(async () => (await inSettings('document.getElementById("sync-folder-path").value')) === cloud, 4000)));
    await inSettings('(() => { const i = document.getElementById("sync-passphrase"); i.value = "short"; })()');
    await inSettings('document.getElementById("sync-enable").click()');
    check('a short passphrase for a new folder is refused with the reason', Boolean(await waitFor(async () => /at least 8/.test(await inSettings('document.getElementById("sync-form-status").textContent')), 8000)));
    check('after the refusals nothing was saved', settingsJson().syncFolder === undefined && !fs.existsSync(path.join(profile, 'sync-secret.bin')) && !fs.existsSync(path.join(cloud, core.DIR_NAME, 'sync.json')));
    const inside = await app.evaluate((_e, dir) => { global.__syncPick = dir; return true; }, path.join(profile, 'chats'));
    await inSettings('document.getElementById("sync-pick").click()');
    await sleep(300);
    await inSettings('(() => { document.getElementById("sync-passphrase").value = "a good sync passphrase"; document.getElementById("sync-enable").click(); })()');
    check('a folder inside Lumen\'s own data is refused', Boolean(inside) && Boolean(await waitFor(async () => /outside Lumen/.test(await inSettings('document.getElementById("sync-form-status").textContent')), 8000)));
    await app.evaluate((_e, dir) => { global.__syncPick = dir; }, cloud);
    await inSettings('document.getElementById("sync-pick").click()');
    await sleep(300);

    await shot(app, inSettings.id, 'form');
    // ---- turning it on (history off, to see a switch honoured)
    await inSettings('document.getElementById("sync-new-history").click()');
    await inSettings('(() => { document.getElementById("sync-passphrase").value = "a good sync passphrase"; document.getElementById("sync-enable").click(); })()');
    check('Turn on switches the page to "Sync is on" with the folder', Boolean(await waitFor(async () => /Sync is on/.test(await inSettings('document.getElementById("sync-head")?.textContent || ""')), 20000)));
    check('the sync service was created only now', (await app.evaluate(() => Boolean(global.__sync))) === true);
    check('the folder was set up and the passphrase is on this computer only, encrypted', fs.existsSync(path.join(cloud, core.DIR_NAME, 'sync.json')) && fs.existsSync(path.join(profile, 'sync-secret.bin')) && !fs.readFileSync(path.join(profile, 'sync-secret.bin')).toString('latin1').includes(PASS));
    await flush(app);
    const saved = settingsJson().syncFolder;
    check('settings.json keeps only on/off, the folder and the switches (no passphrase)', saved?.on === true && saved.path === cloud && saved.kinds.history === false && saved.kinds.bookmarks === true && saved.passwords === false && !JSON.stringify(settingsJson()).includes(PASS), JSON.stringify(saved));
    check('the page shows the folder, the status line and Sync now / Turn off', (await inSettings('(() => { const t = document.getElementById("sync-head").textContent; return t.includes(' + JSON.stringify(cloud) + ') && /Last synced/.test(t) && Boolean(document.getElementById("sync-now")) && Boolean(document.getElementById("sync-off")); })()')) === true);
    check('the five kinds and the passwords switch are listed, history off, passwords off', (await inSettings(`(() => { const on = (k) => document.getElementById('sync-kind-' + k)?.checked; return on('bookmarks') === true && on('history') === false && on('chats') === true && on('widgets') === true && on('settings') === true && document.getElementById('sync-passwords')?.checked === false; })()`)) === true);
    check('every data file in the folder is an encrypted Lumen sync file, and sync.json holds no passphrase', walk(cloud).filter((f) => f.endsWith('.lsync')).every((f) => fs.readFileSync(f).subarray(0, 4).toString() === 'LSY1') && !fs.readFileSync(path.join(cloud, core.DIR_NAME, 'sync.json'), 'utf8').includes(PASS));

    // ---- the other computer: it joins with the same passphrase and adds a bookmark
    const opened = await core.openFolder(cloud, PASS);
    let otherList = [{ url: 'https://from-the-other-computer.example/', title: 'Other computer' }];
    const otherState = {};
    const other = core.createEngine({ dirs: opened.dirs, key: opened.key, deviceId: 'abcabcabcabc', deviceName: 'The other PC', state: otherState, providers: [P.bookmarks({ read: () => otherList, write: (l) => { otherList = l; } })] });
    await other.sync();
    await inSettings('document.getElementById("sync-now").click()');
    check('Sync now brings the other computer\'s bookmark in', Boolean(await waitFor(async () => { await flush(app); return (settingsJson().bookmarks || []).some((b) => b.url === 'https://from-the-other-computer.example/'); }, 15000)), JSON.stringify(settingsJson().bookmarks));
    check('and the page lists the other computer by name', Boolean(await waitFor(async () => /The other PC/.test(await inSettings('document.getElementById("sync-devices")?.textContent || ""')), 15000)));

    await shot(app, inSettings.id, 'on');
    // ---- the switches
    await inSettings('document.getElementById("sync-kind-chats").click()');
    check('a "what syncs" switch changes the setting at once', Boolean(await waitFor(async () => { await flush(app); return settingsJson().syncFolder?.kinds?.chats === false; }, 10000)), JSON.stringify(settingsJson().syncFolder));
    check('the switch stays off after the page redraws', (await waitFor(async () => (await inSettings('document.getElementById("sync-kind-chats")?.checked')) === false, 6000)) === true);
    await inSettings('document.getElementById("sync-passwords").click()');
    check('the passwords switch cannot be turned on while Save passwords is off', (await inSettings('document.getElementById("sync-passwords").disabled')) === true && settingsJson().syncFolder?.passwords === false);

    // ---- turn off asks twice and forgets the passphrase
    await inSettings('document.querySelector("#sync-off").click()');
    check('Turn off asks first (still on after one click)', (await inSettings('/Click again/.test(document.querySelector("#sync-off").textContent)')) === true && settingsJson().syncFolder?.on === true);
    await inSettings('document.querySelector("#sync-off").click()');
    check('the second click turns sync off and the page goes back to Set up', Boolean(await waitFor(async () => (await inSettings('Boolean(document.getElementById("sync-setup")) && !document.getElementById("sync-now")')) === true, 10000)));
    await flush(app);
    check('the passphrase file, the local state and the setting are gone; the folder\'s files stay', !fs.existsSync(path.join(profile, 'sync-secret.bin')) && !fs.existsSync(path.join(profile, 'sync-state.json')) && settingsJson().syncFolder === undefined && fs.existsSync(path.join(cloud, core.DIR_NAME, 'sync.json')), JSON.stringify({ secret: fs.existsSync(path.join(profile, 'sync-secret.bin')), state: fs.existsSync(path.join(profile, 'sync-state.json')), setting: settingsJson().syncFolder }));
    check('bookmarks that came from the other computer are still here after turning off', (settingsJson().bookmarks || []).some((b) => b.url === 'https://from-the-other-computer.example/'));

    // ---- joining again: the wrong passphrase is refused with a plain sentence
    await inSettings('document.getElementById("sync-setup").click()');
    await waitFor(async () => (await inSettings('Boolean(document.getElementById("sync-form"))')) === true);
    await inSettings('document.getElementById("sync-pick").click()');
    await sleep(300);
    await inSettings('(() => { document.getElementById("sync-passphrase").value = "not the right passphrase"; document.getElementById("sync-enable").click(); })()');
    check('a wrong passphrase for an existing folder is refused: "not the passphrase this folder was set up with"', Boolean(await waitFor(async () => /isn.t the passphrase/.test(await inSettings('document.getElementById("sync-form-status").textContent')), 10000)));
    check('and nothing was saved', !fs.existsSync(path.join(profile, 'sync-secret.bin')) && (await app.evaluate(() => global.__sync.status().on)) === false);
    await inSettings('(() => { document.getElementById("sync-passphrase").value = "a good sync passphrase"; document.getElementById("sync-enable").click(); })()');
    check('the right one joins it again', Boolean(await waitFor(async () => /Sync is on/.test(await inSettings('document.getElementById("sync-head")?.textContent || ""')), 20000)));
    await flush(app);
  } finally {
    await app.close().catch(() => {});
  }

  // ---- a relaunch: sync starts by itself, from the saved passphrase, after the window is up
  app = await launch();
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const started = await waitFor(async () => app.evaluate(() => Boolean(global.__sync && global.__sync.isStarted())), 30000);
    check('a relaunch starts sync by itself (the setting is on)', Boolean(started), JSON.stringify({ setting: settingsJson().syncFolder, files: fs.readdirSync(profile).filter((f) => /sync|settings/.test(f)) }));
    const synced = await waitFor(async () => app.evaluate(() => global.__sync && global.__sync.status().lastSynced > 0 && !global.__sync.status().error), 30000);
    check('and it syncs with the saved passphrase, with no question asked', Boolean(synced), JSON.stringify(await app.evaluate(() => global.__sync.status().error)));
    // off again, then a relaunch with it off loads nothing
    await app.evaluate(() => global.__sync.disable());
  } finally {
    await app.close().catch(() => {});
  }
  app = await launch();
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(4000);
    check('a relaunch with sync off loads none of it', (await app.evaluate(() => global.__perf.modules().filter((f) => /sync-(core|folder|providers)\.js$/.test(f)).length)) === 0);
  } finally {
    await app.close().catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
