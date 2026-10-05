// "What's new" after an update (features/whats-new.js) in a real Lumen: a profile that last ran an
// older version gets the release notes once over the window (the dialogs overlay), with Got it and the
// "Show what's new after updates" switch; closing records the version and saves the switch; the next
// launch shows nothing; a first run records the version silently; test mode shows nothing unless the
// test opts in (LUMEN_WHATS_NEW_TEST); Settings → Updates has the switch and a button that reopens
// the notes; and the card is drawn over the normal window, never in a private one.
// Run with LUMEN_TEST_BACKGROUND=1 to keep the windows invisible.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../src/features/whats-new');

const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
    return fn();
  };
  const profiles = [];
  const makeProfile = (settings) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-whats-new-'));
    profiles.push(dir);
    if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    return dir;
  };
  const settingsOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return {}; } };

  async function launch(profile, { optIn = true } = {}) {
    const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
    if (optIn) env.LUMEN_WHATS_NEW_TEST = '1'; else delete env.LUMEN_WHATS_NEW_TEST;
    const app = await electron.launch({ args: [root], env });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    // The overlay's document, once a card is on screen (null if none comes up in `ms`).
    const overlay = async (script, ms = 8000) => waitFor(() => app.evaluate(async ({ webContents }, script) => {
      const view = webContents.getAllWebContents().find((w) => w.getURL().endsWith('dialog.html'));
      if (!view || !(await view.executeJavaScript("document.getElementById('backdrop').classList.contains('shown')"))) return null;
      return { value: await view.executeJavaScript(script) };
    }, script), ms).then((r) => (r ? r.value : null));
    const kind = () => app.evaluate(() => global.__dialogs.currentKind());
    const card = () => overlay(`({
      message: document.getElementById('message').textContent,
      title: document.getElementById('title').textContent,
      versions: [...document.querySelectorAll('#notes .release h3')].map((h) => h.firstChild.textContent),
      items: document.querySelectorAll('#notes li').length,
      wide: document.getElementById('card').classList.contains('wide'),
      buttons: [...document.querySelectorAll('#buttons button')].map((b) => b.textContent),
      toggle: document.getElementById('checkbox-row').hidden ? null : document.getElementById('checkbox-label').textContent,
      checked: document.getElementById('checkbox').checked,
      link: document.getElementById('notes-link').hidden ? null : document.getElementById('notes-link').href,
      toggleVisible: document.getElementById('checkbox-row').parentElement.id === 'card',
    })`);
    const gotIt = async (checked) => {
      await overlay(`(() => { const c = document.getElementById('checkbox'); ${checked === undefined ? '' : `c.checked = ${checked};`} [...document.querySelectorAll('#buttons button')].find((b) => b.textContent === 'Got it').click(); return true; })()`);
      await waitFor(async () => (await kind()) === null);
    };
    return { app, ui, overlay, kind, card, gotIt };
  }

  const expected = W.releasesBetween(W.parseChangelog(fs.readFileSync(W.CHANGELOG, 'utf8')), '0.3.0', version).map((r) => r.version).slice(0, W.MAX_RELEASES); // the card lists at most MAX_RELEASES, newest first

  // ---- 1. an update from 0.3.0: the card comes up once
  const updated = makeProfile({ lastSeenVersion: '0.3.0' });
  {
    const { app, card, gotIt, kind, overlay } = await launch(updated);
    try {
      const c = await card();
      check('update: the release notes come up after the window is ready', c && (await kind()) === 'notes', JSON.stringify(c));
      check(`update: the card is headed "What’s new in Lumen ${version}" and says where it updated from`, c?.message === `What’s new in Lumen ${version}` && c?.title === `Lumen was updated from 0.3.0 to ${version}`, `${c?.message} | ${c?.title}`);
      check(`update: it lists the releases since 0.3.0 (${expected.join(', ')}), newest first`, JSON.stringify(c?.versions) === JSON.stringify(expected) && c?.items > 0, JSON.stringify(c?.versions));
      check('update: a wide card with Got it, the switch (on) under the list, and a link to all notes', c?.wide && JSON.stringify(c?.buttons) === '["Got it"]' && c?.toggle === 'Show what’s new after updates' && c?.checked === true && c?.toggleVisible && /^https:\/\/github\.com\/emah-maker\/lumen\//.test(c?.link || ''), JSON.stringify(c));
      check('update: the new version is recorded as soon as the card shows', settingsOf(updated).lastSeenVersion === version, JSON.stringify(settingsOf(updated)));
      const hosted = await app.evaluate(({ BrowserWindow, webContents }) => {
        const view = webContents.getAllWebContents().find((w) => w.getURL().endsWith('dialog.html'));
        return BrowserWindow.getAllWindows().filter((w) => w.contentView.children.some((v) => v.webContents === view)).map((w) => w.webContents.getURL().split('/').pop());
      });
      check('update: the card is drawn in the browser window', hosted.length === 1 && !/private/.test(hosted[0]), JSON.stringify(hosted));
      await gotIt(false);
      check('update: Got it closes the card', (await kind()) === null, await kind());
      await waitFor(() => settingsOf(updated).showWhatsNew === false, 4000); // (saved once the card's promise settles, a moment after it closes)
      check('update: switching it off on the card saves showWhatsNew: false', settingsOf(updated).showWhatsNew === false && settingsOf(updated).lastSeenVersion === version, JSON.stringify(settingsOf(updated)));

      // ---- Settings → Updates: the switch (now off) and the button that reopens the notes
      const id = await app.evaluate(() => global.__settings.open('updates'));
      const inTab = (code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, [id, code]);
      await waitFor(() => inTab("document.body?.dataset.ready === '1' && Boolean(document.getElementById('whats-new-open'))"));
      const row = await inTab("(() => { const s = document.getElementById('pref-showWhatsNew'); return s ? { checked: s.checked, label: s.closest('.row').querySelector('.label').textContent, button: document.getElementById('whats-new-open')?.textContent } : null; })()");
      check('settings: Updates has the "Show what’s new after updates" switch, off as saved, and a Show what’s new button', row && row.checked === false && row.label === 'Show what’s new after updates' && row.button === 'Show what’s new', JSON.stringify(row));
      await inTab("document.getElementById('pref-showWhatsNew').click()");
      await waitFor(() => settingsOf(updated).showWhatsNew === true, 4000);
      check('settings: the switch saves showWhatsNew', settingsOf(updated).showWhatsNew === true, JSON.stringify(settingsOf(updated)));
      await inTab("document.getElementById('whats-new-open').click()");
      const again = await card();
      check('settings: Show what’s new opens the notes, the running version first, with no "updated from" line', again?.versions?.[0] === version && again.versions.length <= 3 && again.title === '' && again.checked === true, JSON.stringify(again));
      await gotIt();
      check('settings: closing it again changes nothing', settingsOf(updated).showWhatsNew === true && settingsOf(updated).lastSeenVersion === version, JSON.stringify(settingsOf(updated)));
      const setBlocked = await inTab("window.lumenSettings.set('lastSeenVersion', '0.0.1').then(() => 'set', (err) => 'refused')");
      check('settings: the page cannot rewrite lastSeenVersion', setBlocked === 'refused' && settingsOf(updated).lastSeenVersion === version, setBlocked);

      // ---- a private window: the card never goes in it
      await app.evaluate(() => global.__private.open());
      await waitFor(() => app.evaluate(() => global.__private.count() === 1));
      await app.evaluate(() => { global.__whatsNew.open(); }); // resolves only once the card closes: don't wait for it
      await overlay('true');
      const where = await app.evaluate(({ BrowserWindow, webContents }) => {
        const view = webContents.getAllWebContents().find((w) => w.getURL().endsWith('dialog.html'));
        const privateIds = global.__private.list().map((p) => p.windowId);
        const hosts = BrowserWindow.getAllWindows().filter((w) => w.contentView.children.some((v) => v.webContents === view));
        return { hosts: hosts.length, inPrivate: hosts.some((w) => privateIds.includes(w.id)) };
      });
      check('private window: What’s New opens over the browser window, not the private one', where.hosts === 1 && where.inPrivate === false, JSON.stringify(where));
      await gotIt();
    } catch (err) {
      check('update run', false, err.stack);
    } finally {
      await app.close().catch(() => {});
    }
  }

  // ---- 2. the next launch on the same version: nothing
  {
    const before = settingsOf(updated);
    const { app, kind, overlay } = await launch(updated);
    try {
      const shown = await overlay('true', 3500);
      check('relaunch: the same version shows nothing', shown === null && (await kind()) === null, JSON.stringify(shown));
      check('relaunch: settings are untouched', JSON.stringify(settingsOf(updated)) === JSON.stringify(before), JSON.stringify(settingsOf(updated)));
    } finally {
      await app.close().catch(() => {});
    }
  }

  // ---- 3. a first run ever: nothing shown, the version recorded
  {
    const fresh = makeProfile(null);
    const { app, kind, overlay } = await launch(fresh);
    try {
      const shown = await overlay('true', 3500);
      check('first run: no card', shown === null && (await kind()) === null, JSON.stringify(shown));
      check('first run: the version is recorded', settingsOf(fresh).lastSeenVersion === version, JSON.stringify(settingsOf(fresh)));
    } finally {
      await app.close().catch(() => {});
    }
  }

  // ---- 4. test mode without the opt-in: nothing shown, nothing written
  {
    const quiet = makeProfile({ lastSeenVersion: '0.3.0' });
    const { app, kind, overlay } = await launch(quiet, { optIn: false });
    try {
      const shown = await overlay('true', 3500);
      check('test mode: an update shows nothing unless the test asks', shown === null && (await kind()) === null, JSON.stringify(shown));
      check('test mode: the stored version is left alone', settingsOf(quiet).lastSeenVersion === '0.3.0', JSON.stringify(settingsOf(quiet)));
    } finally {
      await app.close().catch(() => {});
    }
  }

  for (const dir of profiles) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
