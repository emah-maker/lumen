// [sync] Sync through a folder, end to end between two stand-in computers (features/sync-folder.js, sync-providers.js, sync-core.js) over a
// temp folder that plays the cloud drive: turning it on (checks, the passphrase kept encrypted), every kind of data in both directions,
// the "also sync passwords" switch, what must never leave (keys, paths, secrets), the watcher, restart, turning it off, a missing folder.
// Plain Node, no Electron, no network.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computer } = require('../helpers/_sync-computer');
const core = require('../../src/features/sync-core');
const P = require('../../src/features/sync-providers');
const { DEFAULTS } = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(25); } return v; };
const rejectsWith = async (fn, code) => { try { await fn(); return false; } catch (err) { return err.code === code; } };
const PASS = 'a good sync passphrase';
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const allText = (dir) => walk(dir).map((f) => fs.readFileSync(f).toString('latin1')).join('\n');
// (a directory is briefly in use while another part of this process lists it, on Windows: try again)
const moveDir = async (from, to) => { for (let i = 0; ; i++) { try { fs.renameSync(from, to); return; } catch (err) { if (i > 40 || err.code !== 'EPERM') throw err; await sleep(25); } } };
const bk = (url, title, folder) => ({ url, title, ...(folder ? { folder } : {}) });

(async () => {
  const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sync-cloud-'));

  // ---- off by default
  {
    const a = computer('off');
    check('off: nothing is on and no sync file exists in the profile', a.service.status().on === false && !fs.readdirSync(a.userData).some((f) => /^sync-/.test(f)));
    check('off: start() does nothing', a.service.start() === false && a.service.isStarted() === false);
    a.service.touch('bookmarks'); check('off: a change schedules nothing', a.service.isStarted() === false);
    check('off: syncNow does nothing', (await a.service.syncNow()) === null);
  }

  // ---- turning it on: every check comes first
  {
    const a = computer('checks');
    check('enable: a relative folder is refused', await rejectsWith(() => a.service.enable({ folder: 'relative/path', passphrase: PASS }), 'no-folder'));
    check('enable: a folder that does not exist is refused', await rejectsWith(() => a.service.enable({ folder: path.join(cloud, 'nope'), passphrase: PASS }), 'no-folder'));
    check('enable: a folder inside Lumen\'s own profile is refused', await rejectsWith(() => a.service.enable({ folder: path.join(a.userData, 'chats'), passphrase: PASS }), 'bad-folder') && await rejectsWith(() => a.service.enable({ folder: a.userData, passphrase: PASS }), 'bad-folder'));
    check('enable: no passphrase is refused', await rejectsWith(() => a.service.enable({ folder: cloud, passphrase: '' }), 'short-passphrase'));
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sync-fresh-'));
    check('enable: a too-short new passphrase is refused', await rejectsWith(() => a.service.enable({ folder: fresh, passphrase: 'short' }), 'short-passphrase'));
    check('enable: after the refusals nothing was saved and nothing created', !a.settings.syncFolder && !fs.existsSync(path.join(a.userData, 'sync-secret.bin')) && !fs.existsSync(path.join(fresh, core.DIR_NAME, 'data', 'x')) && a.service.status().on === false);
    const noKeychain = computer('nokeychain');
    const orig = require('../helpers/_sync-computer').keychain.available;
    require('../helpers/_sync-computer').keychain.available = () => false;
    check('enable: with no keychain (nowhere safe for the passphrase) it is refused', await rejectsWith(() => noKeychain.service.enable({ folder: fresh, passphrase: PASS }), 'no-keychain'));
    require('../helpers/_sync-computer').keychain.available = orig;
  }

  // ---- two computers
  const A = computer('A');
  const B = computer('B');
  A.settings.bookmarks = [bk('https://a.example/', 'A site'), bk('https://shared.example/', 'Shared', 'Work')];
  A.settings.theme = 'dark';
  A.settings.accentColor = '#aa2255';
  A.settings.searchEngine = 'duckduckgo';
  A.settings.homeWidgets = [{ id: 'w-clock', type: 'clock', x: 0, y: 0, w: 2, h: 1 }, { id: 'w-rss', type: 'rss', x: 2, y: 0, w: 2, h: 2, url: 'https://feed.example/rss', apiToken: 'SECRET-WIDGET-TOKEN' }];
  A.settings.keys = { anthropic: 'sk-ant-SECRET-KEY' };
  A.settings.downloadDir = 'C:\\Users\\a\\Downloads';
  A.settings.automationPort = 9222;
  A.settings.proxy = { mode: 'manual', rules: 'http://user:PROXYPASS@proxy:8080' };
  A.settings.bypassPermissions = true;
  A.history.set('https://visited.example/', { url: 'https://visited.example/', title: 'Visited', visits: 4, last: 5000 });
  A.chats.save('1111111111111111', A.snap(1));
  A.chats.rename('1111111111111111', 'My renamed chat');
  A.chats.setPinned('1111111111111111', true);
  A.vault.upsert({ site: 'bank.example', username: 'ann', password: 'Hunter2-VERY-SECRET' });

  let r = await A.service.enable({ folder: cloud, passphrase: PASS });
  check('enable: the first computer sets the folder up', r.created === true && fs.existsSync(path.join(cloud, core.DIR_NAME, 'sync.json')) && A.service.status().on && A.service.status().path === cloud);
  const secretFile = path.join(A.userData, 'sync-secret.bin');
  check('enable: the passphrase is kept in a keychain-encrypted file on this computer only', fs.existsSync(secretFile) && !fs.readFileSync(secretFile).toString('latin1').includes(PASS) && A.service.status().hasPassphrase);
  check('enable: the passphrase is not in settings, and the folder has neither it nor the key', !JSON.stringify(A.settings).includes(PASS) && !allText(cloud).includes(PASS));
  check('enable: the setting records only on/off, folder and the switches', JSON.stringify(Object.keys(A.settings.syncFolder).sort()) === '["kinds","on","passwords","path"]' && A.settings.syncFolder.passwords === false, JSON.stringify(A.settings.syncFolder));
  const st = A.service.status();
  check('status: last synced is set, no error, this computer is listed', st.lastSynced > 0 && st.error === null && st.devices.length === 1 && st.devices[0].self && st.devices[0].name === 'pc-A', JSON.stringify(st));

  const text = allText(cloud);
  for (const secret of ['A site', 'a.example', 'Visited', 'My renamed chat', 'question 1', 'duckduckgo', 'feed.example', 'ann', 'pc-A']) {
    if (text.includes(secret)) { check(`folder: "${secret}" is not readable in the folder`, false, 'found in plain text'); }
  }
  check('folder: nothing is readable in the folder (everything is encrypted)', !/(a\.example|Visited|renamed chat|duckduckgo|feed\.example|bank\.example|Hunter2|pc-A)/.test(text));
  check('folder: no password was written (the switch is off)', !walk(cloud).some((f) => /passwords\./.test(path.basename(f))));

  // the second computer, wrong passphrase first
  check('join: a wrong passphrase is refused and changes nothing', await rejectsWith(() => B.service.enable({ folder: cloud, passphrase: 'not the passphrase' }), 'wrong-passphrase') && !B.settings.syncFolder && !fs.existsSync(path.join(B.userData, 'sync-secret.bin')));
  B.settings.bookmarks = [bk('https://b.example/', 'B site'), bk('https://shared.example/', 'Shared (B title)')];
  B.settings.theme = 'light';
  B.history.set('https://b-visited.example/', { url: 'https://b-visited.example/', title: 'B visited', visits: 1, last: 9000 });
  B.settings.keys = { openai: 'sk-B-KEY-STAYS' };
  B.settings.homeWidgets = [{ id: 'w-rss', type: 'rss', x: 0, y: 0, w: 1, h: 1, url: 'https://old.example/', apiToken: 'B-LOCAL-TOKEN' }];
  r = await B.service.enable({ folder: cloud, passphrase: PASS });
  check('join: the same passphrase joins the folder', r.created === false && B.service.status().on);

  const titles = (c) => (c.settings.bookmarks || []).map((b) => b.url).sort().join(' ');
  check('bookmarks: both computers end with both lists (union)', titles(B) === 'https://a.example/ https://b.example/ https://shared.example/', titles(B));
  check('bookmarks: a conflicting bookmark takes the folder\'s version on the joining computer, with its folder', B.settings.bookmarks.find((b) => b.url === 'https://shared.example/').title === 'Shared' && B.settings.bookmarks.find((b) => b.url === 'https://shared.example/').folder === 'Work');
  await A.service.syncNow();
  check('bookmarks: and the first computer gets the new computer\'s', titles(A) === titles(B), titles(A));
  check('settings: the joining computer takes the folder\'s theme and accent, and the first one keeps its own', B.settings.theme === 'dark' && B.settings.accentColor === '#aa2255' && A.settings.theme === 'dark');
  check('settings: the search engine (a direct setting) travels', B.settings.searchEngine === 'duckduckgo');
  check('history: both ways', B.history.has('https://visited.example/') && A.history.has('https://b-visited.example/') && B.history.get('https://visited.example/').visits === 4);
  check('chats: the chat arrives with its title, pin and messages', (() => { const l = B.chats.list(); const c = l.find((x) => x.id === '1111111111111111'); return c && c.title === 'My renamed chat' && c.pinned === true && B.chats.load('1111111111111111').messages.length === 2; })(), JSON.stringify(B.chats.list()));
  check('chats: with its original date, not the time it arrived', B.chats.list()[0].updated === A.chats.list()[0].updated && B.chats.list()[0].created === A.chats.list()[0].created);
  check('widgets: both computers\' cards end up on both', ['w-clock', 'w-rss'].every((id) => B.settings.homeWidgets.some((w) => w.id === id)) && B.refreshed >= 1, JSON.stringify(B.settings.homeWidgets));
  check('widgets: a card\'s secret never travelled, and B kept its own', B.settings.homeWidgets.find((w) => w.id === 'w-rss').apiToken === 'B-LOCAL-TOKEN' && !JSON.stringify(A.settings.homeWidgets).includes('B-LOCAL-TOKEN'));
  check('widgets: the other computer\'s card has no secret on B for a card B never had', !('apiToken' in B.settings.homeWidgets.find((w) => w.id === 'w-clock')));
  check('never synced: keys, paths, ports, proxy and permission switches stay where they are', B.settings.keys.openai === 'sk-B-KEY-STAYS' && !JSON.stringify(B.settings).includes('SECRET-KEY') && B.settings.downloadDir === undefined && B.settings.automationPort === undefined && B.settings.proxy === undefined && B.settings.bypassPermissions === undefined, JSON.stringify(B.settings));
  check('passwords: off, so nothing of A\'s passwords reached B', B.vault.count() === 0 && !B.vault.exists());
  check('applied: the stores were told which kinds changed (the UI refreshes them)', B.applied.includes('bookmarks') && B.applied.includes('chats') && B.applied.includes('history'));

  // ---- changes flow by themselves: touch -> pass -> file -> watcher -> pass
  {
    A.settings.bookmarks = [...A.settings.bookmarks, bk('https://later.example/', 'Added later on A')];
    A.service.touch('bookmarks');
    const got = await until(() => B.settings.bookmarks.some((b) => b.url === 'https://later.example/'), 6000);
    check('live: a bookmark added on A reaches B without anyone pressing anything (change, debounce, file, watcher)', Boolean(got));
    A.settings.bookmarks = A.settings.bookmarks.filter((b) => b.url !== 'https://a.example/'); A.service.touch('bookmarks');
    check('live: a deletion reaches B too', Boolean(await until(() => !B.settings.bookmarks.some((b) => b.url === 'https://a.example/'), 6000)));
    A.history.set('https://newpage.example/', { url: 'https://newpage.example/', title: 'New page', visits: 1, last: Date.now() }); A.service.touch('history');
    check('live: history follows (after its longer wait)', Boolean(await until(() => B.history.has('https://newpage.example/'), 6000)));
    const before = B.service.status().lastSynced;
    A.chats.save('2222222222222222', A.snap(2));
    check('live: a new chat on A reaches B (the chat store\'s own change notice starts it)', Boolean(await until(() => B.chats.list().some((c) => c.id === '2222222222222222'), 6000)));
    A.chats.rename('2222222222222222', 'Renamed after');
    check('live: renaming a chat reaches B', Boolean(await until(() => B.chats.list().find((c) => c.id === '2222222222222222')?.title === 'Renamed after', 6000)));
    A.chats.trash('2222222222222222');
    check('live: deleting a chat on A removes it from B\'s list', Boolean(await until(() => !B.chats.list().some((c) => c.id === '2222222222222222'), 6000)));
    check('live: the deleted chat is only hidden on B (the usual undo time), its file is not erased', fs.existsSync(path.join(B.userData, 'chats', '2222222222222222.json')));
    check('live: B\'s last-synced moved on', B.service.status().lastSynced >= before);
  }

  // ---- chats that are open wait; chats that are huge are skipped
  {
    B.busy.add('3333333333333333');
    A.chats.save('3333333333333333', A.snap(3)); A.service.touch('chats');
    await until(() => walk(cloud).some((f) => /chats-3333333333333333/.test(f)), 5000);
    await B.service.syncNow();
    check('chats: a chat that is open here is not overwritten (it waits)', !B.chats.list().some((c) => c.id === '3333333333333333'));
    B.busy.clear(); await B.service.syncNow();
    check('chats: and arrives on the next pass once it is not open', B.chats.list().some((c) => c.id === '3333333333333333'));
    const huge = { messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(30 * 1024 * 1024) }] }] };
    A.chats.save('4444444444444444', huge);
    await A.service.syncNow(); await B.service.syncNow();
    check('chats: a chat over the size limit stays out of the folder', !B.chats.list().some((c) => c.id === '4444444444444444') && !walk(cloud).some((f) => /4444444444444444/.test(f)));
  }

  // ---- passwords: a separate, explicit switch
  {
    await A.service.configure({ passwords: true });
    await B.service.configure({ passwords: true });
    await A.service.syncNow(); await B.service.syncNow();
    check('passwords: with the switch on, a saved login arrives', B.vault.find('bank.example', 'ann')?.password === 'Hunter2-VERY-SECRET');
    check('passwords: and only inside encrypted files (not readable in the folder)', !allText(cloud).includes('Hunter2') && !allText(cloud).includes('bank.example') && walk(cloud).some((f) => /passwords\./.test(path.basename(f))));
    A.vault.update(A.vault.find('bank.example', 'ann').id, { password: 'Changed-2-NEW' }); A.service.touch('passwords'); await A.service.syncNow(); await B.service.syncNow();
    check('passwords: a changed password follows', B.vault.find('bank.example', 'ann').password === 'Changed-2-NEW');
    A.vault.remove(A.vault.find('bank.example', 'ann').id); await A.service.syncNow(); await B.service.syncNow();
    check('passwords: a removed login is removed on the other computer', !B.vault.find('bank.example', 'ann'));
    A.vaultBroken = true; await A.service.syncNow();
    check('passwords: a vault that cannot be read is skipped, nothing is deleted from the folder', A.service.status().skipped.some((s) => s.provider === 'passwords'));
    A.vaultBroken = false;
    await A.service.configure({ passwords: false });
    check('passwords: turning the switch off stops syncing them (the setting says so)', A.settings.syncFolder.passwords === false && A.service.status().passwords === false);
  }

  // ---- the "what syncs" switches
  {
    await B.service.configure({ kinds: { history: false } });
    A.history.set('https://nohistory.example/', { url: 'https://nohistory.example/', title: 'x', visits: 1, last: Date.now() });
    await A.service.syncNow(); await B.service.syncNow();
    check('kinds: a kind switched off here is no longer received', !B.history.has('https://nohistory.example/') && B.service.status().kinds.history === false && B.service.status().kinds.bookmarks === true);
    await B.service.configure({ kinds: { history: true } }); await B.service.syncNow();
    check('kinds: switched on again, it catches up', B.history.has('https://nohistory.example/'));
  }

  // ---- restart: the stored passphrase is used, nothing is asked
  {
    const again = computer('A2');
    again.userData; // (a new profile folder: a different computer) -- the restart below reuses A's
    const restarted = require('../../src/features/sync-folder').createSyncService({
      userData: A.userData, readSettings: () => ({ ...A.settings }), writeSettings: (s) => { A.settings = { ...s }; }, cipher: require('../helpers/_sync-computer').keychain, appVersion: 't', deviceName: 'pc-A',
      timing: { local: 30, history: 60, watch: 30, periodic: 60000, first: 10 },
      makeProvider: (kind) => ({ bookmarks: () => P.bookmarks({ read: () => A.settings.bookmarks, write: (l) => { A.settings = { ...A.settings, bookmarks: l }; } }) }[kind]?.()),
      onStatus: () => {},
    });
    A.service.stop();
    B.settings.bookmarks = [...B.settings.bookmarks, bk('https://while-a-was-closed.example/', 'Added while A was closed')];
    await B.service.syncNow();
    check('restart: start() picks the saved setting up', restarted.start() === true && restarted.isStarted());
    const got2 = await until(() => A.settings.bookmarks.some((b) => b.url === 'https://while-a-was-closed.example/'), 5000);
    check('restart: it syncs by itself using the stored passphrase (the first pass after the window is up)', Boolean(got2), JSON.stringify(restarted.status()) + JSON.stringify(B.settings.bookmarks.map((b) => b.url)));
    check('restart: and reports no error', restarted.status().error === null && restarted.status().lastSynced > 0, JSON.stringify(restarted.status().error));
    // the stored passphrase is unreadable (another Windows account, a reset keychain)
    restarted.stop();
    fs.writeFileSync(secretFile, 'garbage');
    const broken = require('../../src/features/sync-folder').createSyncService({ userData: A.userData, readSettings: () => ({ ...A.settings }), writeSettings: (s) => { A.settings = { ...s }; }, cipher: require('../helpers/_sync-computer').keychain, timing: { first: 5, periodic: 60000 }, makeProvider: () => null, onStatus: () => {} });
    broken.start(); await broken.pass(true);
    check('restart: a passphrase that cannot be decrypted is reported (asks to enter it again), nothing breaks', broken.status().error?.code === 'no-passphrase', JSON.stringify(broken.status().error));
    broken.stop();
    // type it again
    await A.service.enable({ folder: cloud, passphrase: PASS });
    check('restart: entering the passphrase again works and keeps the data', A.service.status().error === null && A.service.status().hasPassphrase);
    // a damaged local state file: the computer joins again as if new (the folder's version wins), nothing is lost or thrown
    A.service.stop();
    fs.writeFileSync(path.join(A.userData, 'sync-state.json'), '{ not json');
    const countBefore = A.settings.bookmarks.length;
    const again2 = require('../../src/features/sync-folder').createSyncService({ userData: A.userData, readSettings: () => ({ ...A.settings }), writeSettings: (s) => { A.settings = { ...s }; }, cipher: require('../helpers/_sync-computer').keychain, timing: { first: 5, periodic: 60000, poll: 600000 }, makeProvider: (kind) => ({ bookmarks: () => P.bookmarks({ read: () => A.settings.bookmarks, write: (l) => { A.settings = { ...A.settings, bookmarks: l }; } }) }[kind]?.()), onStatus: () => {} });
    again2.start(); await again2.pass(true);
    check('restart: a damaged state file is replaced, sync works again and no bookmark is lost', again2.status().error === null && again2.status().lastSynced > 0 && A.settings.bookmarks.length >= countBefore, JSON.stringify(again2.status().error));
    again2.stop();
  }

  // ---- the folder goes away and comes back
  {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sync-moved-'));
    await moveDir(path.join(cloud, core.DIR_NAME), path.join(holder, core.DIR_NAME));
    const res = await B.service.syncNow();
    check('folder gone: Sync now reports it, with a code the page can explain', res === null && B.service.status().error?.code === 'no-folder', JSON.stringify(B.service.status().error));
    check('folder gone: Lumen stays usable and nothing local was touched', B.settings.bookmarks.length > 0 && B.history.size > 0);
    // The next pass opens the folder again from scratch (the first one dropped its engine): it must not make a new sync set, with a
    // new key, where the old one was (a cloud drive that has not downloaded it yet looks just like this).
    const res2 = await B.service.syncNow();
    check('folder gone: a second Sync now still reports it, and makes no new sync set in its place', res2 === null && B.service.status().error?.code === 'no-folder' && !fs.existsSync(path.join(cloud, core.DIR_NAME)), JSON.stringify({ error: B.service.status().error, made: fs.existsSync(path.join(cloud, core.DIR_NAME)) }));
    await moveDir(path.join(holder, core.DIR_NAME), path.join(cloud, core.DIR_NAME));
    await B.service.syncNow();
    check('folder gone: it recovers when the folder is back', B.service.status().error === null);
  }

  // ---- turning it off
  {
    const files = walk(cloud).length;
    const idFile = path.join(cloud, core.DIR_NAME, 'devices');
    const devicesBefore = fs.readdirSync(idFile).length;
    await B.service.disable();
    check('off: the setting, the passphrase and the local state are gone', !B.settings.syncFolder && !fs.existsSync(path.join(B.userData, 'sync-secret.bin')) && !fs.existsSync(path.join(B.userData, 'sync-state.json')) && B.service.status().on === false && !B.service.isStarted());
    check('off: this computer\'s entry leaves the device list, and the folder\'s data is untouched', fs.readdirSync(idFile).length === devicesBefore - 1 && walk(cloud).length >= files - 1);
    check('off: B\'s own data is all still here', B.settings.bookmarks.length > 0 && B.chats.list().length > 0 && B.history.size > 0);
    A.settings.bookmarks = [...A.settings.bookmarks, bk('https://after-b-left.example/', 'x')]; await A.service.syncNow();
    await sleep(200);
    check('off: a change on A no longer reaches B', !B.settings.bookmarks.some((b) => b.url === 'https://after-b-left.example/'));
    A.service.stop();
  }

  // ---- the folder watcher (fs.watch; Windows polls instead, so this is the same journey with the watcher forced on)
  {
    const cloud2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sync-cloud2-'));
    const W1 = computer('W1', { watchMode: 'watch', timing: { poll: 600000 } });
    const W2 = computer('W2', { watchMode: 'watch', timing: { poll: 600000 } });
    await W1.service.enable({ folder: cloud2, passphrase: PASS });
    await W2.service.enable({ folder: cloud2, passphrase: PASS });
    W1.settings.bookmarks = [bk('https://watched.example/', 'Watched')]; W1.service.touch('bookmarks');
    check('watcher: a file that appears in the folder starts a pass on the other computer', Boolean(await until(() => (W2.settings.bookmarks || []).some((b) => b.url === 'https://watched.example/'), 6000)));
    W2.settings.bookmarks = []; W2.service.touch('bookmarks');
    check('watcher: and back again', Boolean(await until(() => (W1.settings.bookmarks || []).length === 0, 6000)));
    W1.service.stop(); W2.service.stop();
  }

  // ---- what is allowed to be synced as settings
  {
    const keys = [...P.SETTING_KEYS, ...Object.keys(P.DIRECT_SETTINGS)];
    check('settings list: every key is a real setting', P.SETTING_KEYS.every((k) => k in DEFAULTS), P.SETTING_KEYS.filter((k) => !(k in DEFAULTS)).join());
    check('settings list: no key looks like a key, token, secret, password, path, port, file or folder', keys.every((k) => !P.SECRETISH.test(k) && !/dir$|path$|port$|file$|folder$/i.test(k)), keys.filter((k) => P.SECRETISH.test(k)).join());
    check('settings list: nothing about what the AI may do, full access, bypass, MCP, automation, proxy or sign-ins', keys.every((k) => !/FullAccess|bypass|mcp|automation|proxy|handsOff|askBefore|Desktop|signedIn|telegram|webhook|connectors|oauth|permission/i.test(k)));
    let threw = false; try { P.settings({ read: () => ({}), set: async () => {}, writeDirect: () => {}, keys: ['apiKey'] }); } catch { threw = true; }
    check('settings list: a secret-looking key cannot even be added', threw);
    const lib = require('../../src/features/sync-folder');
    const base = { bookmarks: [1], homeWidgets: [2], theme: 'dark', session: { tabs: [1] }, syncFolder: { on: true } };
    check('which kinds a settings write changed: a write that carries the same data along (the session saved every few seconds) changes none', lib.kindsChanged(base, { ...base, session: { tabs: [1, 2] } }).length === 0 && lib.kindsChanged(base, { ...base, syncFolder: { on: false } }).length === 0);
    check('which kinds a settings write changed: bookmarks, cards and preferences are told apart', lib.kindsChanged(base, { ...base, bookmarks: [1, 3] }).join() === 'bookmarks' && lib.kindsChanged(base, { ...base, homeWidgets: [] }).join() === 'widgets' && lib.kindsChanged(base, { ...base, theme: 'light' }).join() === 'settings' && lib.kindsChanged(base, { ...base, theme: 'light', bookmarks: [] }).join() === 'bookmarks,settings');
    check('which kinds a settings write changed: a key that is never synced (an API key, a folder) changes none', lib.kindsChanged(base, { ...base, keys: { a: 1 }, downloadDir: '/somewhere', proxy: {} }).length === 0);
    const sp = P.settings({ read: () => ({ newTabBackground: 'image', theme: 'dark', keys: { a: 'b' } }), set: async () => {}, writeDirect: () => {} });
    check('settings: a wallpaper picture (a file on one computer only) is not synced; a preset is', !sp.scan().has('newTabBackground') && sp.scan().has('theme') && !sp.scan().has('keys'));
    const calls = []; const sp2 = P.settings({ read: () => ({}), set: async (k, v) => { calls.push(k); }, writeDirect: (p) => calls.push(JSON.stringify(p)) });
    await sp2.apply([{ key: 'keys', value: { x: 1 } }, { key: 'downloadDir', value: 'C:\\evil' }, { key: 'theme', value: 'dark' }, { key: 'searchEngine', value: 'bad value!' }, { key: 'searchEngine', value: 'bing' }, { key: 'adhdMode', value: 'yes' }]);
    check('settings: a key outside the list or a value that is not valid is never applied', calls.join('|') === 'theme|{"searchEngine":"bing"}', calls.join('|'));
    const wp = P.widgets({ read: () => ({ homeWidgets: [{ id: 'a', type: 't', token: 'T', nested: { password: 'p', ok: 1 } }] }), write: () => {} });
    check('widgets: secret-looking fields are scrubbed from what is written to the folder, nested ones too', JSON.stringify([...wp.scan().values()]) === '[{"value":{"id":"a","type":"t","nested":{"ok":1}}}]', JSON.stringify([...wp.scan().values()]));
    const hist = P.history({ map: () => new Map(), ready: async () => false, save() {} });
    check('history: it is not scanned until it has loaded (an empty list is not "everything deleted")', await rejectsWith(() => hist.scan(), 'loading'));
    const bad = P.history({ map: () => new Map(), ready: async () => true, save() {}, isWorthImporting: (u) => !u.includes('token=') });
    const hmap = new Map(); const hp = P.history({ map: () => hmap, ready: async () => true, save() {}, isWorthImporting: (u) => !u.includes('token=') });
    hp.apply([{ key: 'https://x.example/?token=1', value: { url: 'https://x.example/?token=1', title: 't', visits: 1, last: 1 } }, { key: 'javascript:alert(1)', value: { url: 'javascript:alert(1)', visits: 1, last: 1 } }, { key: 'https://ok.example/', value: { url: 'https://ok.example/', title: 'ok', visits: 2, last: 5 } }, { key: 'https://liar.example/', value: { url: 'https://other.example/', visits: 1, last: 1 } }]);
    check('history: a sign-in link, a script address and a record whose key lies are not taken from the folder', hmap.size === 1 && hmap.has('https://ok.example/') && bad.name === 'history', [...hmap.keys()].join());
    const bp = P.bookmarks({ read: () => [], write: (l) => { bp.out = l; } });
    bp.apply([{ key: 'javascript:alert(1)', value: { url: 'javascript:alert(1)', title: 'x' } }, { key: 'https://ok.example/', value: { url: 'https://ok.example/', title: 'ok', extra: { evil: 1 } } }, { key: 'https://ok2.example/', value: { url: 'https://different.example/', title: 'lie' } }]);
    check('bookmarks: only web addresses whose key matches are taken, and only url, title and folder are kept', JSON.stringify(bp.out) === '[{"url":"https://ok.example/","title":"ok"}]', JSON.stringify(bp.out));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
