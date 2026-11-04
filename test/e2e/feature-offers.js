// "New in Lumen" (features/feature-offers.js, renderer/offer-card.js), in a real sidebar with invisible windows: an update
// shows the settings it brought on the empty chat, grouped by release, newest first, capped with "More in Settings"; they
// are recorded as shown once on screen; a switch and a choice change the setting right on the card, through the settings
// backend (no restart), and the line stays; uBlock Origin Lite asks on the card first; "Set up…" opens the feature's
// Settings section and switches nothing on (Telegram and voice input send data, so they keep their own setup); it never
// shows over a conversation; "Not now" and "Don't show again" stick across launches; a fresh profile is never asked.
// The rules are test/units/feature-offers-units.js.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const FO = require('../../src/features/feature-offers');
const ALL = FO.OFFERS.map(FO.seenKey); // a fresh install records every line as seen
const SIX = ['aiMemory', 'planModeDefault', 'skillsFromClaudeCode', 'telegramChannel', 'dictation', 'actingHelpers']; // the first batch
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sorted = (a) => JSON.stringify([...(a || [])].sort());

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
  const makeProfile = (settings) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-offers-'));
    if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    return dir;
  };
  const settingsOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return {}; } };

  async function launch(profile) {
    const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_FEATURE_OFFERS_TEST: '1', ANTHROPIC_API_KEY: 'sk-ant-test' };
    const app = await electron.launch({ args: [root], env });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const open = async () => { // the sidebar, on its empty chat
      if (await ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true')) await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
      await waitFor(() => ui.evaluate(() => !document.body.classList.contains('sidebar-moving') && document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true'));
    };
    const card = () => ui.evaluate(() => {
      const el = document.querySelector('.offer-card');
      if (!el || el.offsetParent === null) return null;
      const control = (r) => {
        const sw = r.querySelector('input[role=switch]'); if (sw) return { type: 'switch', on: sw.checked };
        const sel = r.querySelector('select'); if (sel) return { type: 'choice', value: sel.value, options: [...sel.options].map((o) => o.textContent) };
        const b = r.querySelector(':scope > .offer-go'); if (b) return { type: 'button', text: b.textContent };
        return { type: 'none' };
      };
      return {
        title: el.querySelector('.offer-title').textContent,
        releases: [...el.querySelectorAll('.offer-release')].map((h) => h.textContent),
        rows: [...el.querySelectorAll('.offer-row')].map((r) => ({ id: r.dataset.offer, name: r.querySelector('.offer-name').textContent, desc: r.querySelector('.offer-desc').textContent, control: control(r) })),
        foot: [...el.querySelectorAll('.offer-foot button')].map((b) => b.textContent),
        lazy: Boolean(document.querySelector('script[data-later][src="offer-card.js"]')),
      };
    });
    const present = () => ui.evaluate(() => Boolean(document.querySelector('.offer-card'))); // (in the DOM, even when a Settings tab has the view)
    const press = (sel) => ui.evaluate((q) => document.querySelector(q).click(), sel);
    const choose = (id, value) => ui.evaluate(([i, v]) => { const s = document.querySelector(`.offer-row[data-offer="${i}"] select`); s.value = v; s.dispatchEvent(new Event('change')); }, [id, value]);
    const urls = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));
    return { app, ui, open, card, urls, present, press, choose };
  }

  // A profile that saw the first batch (0.5.55-0.5.60) and nothing since, updated to this version.
  const updated = makeProfile({ lastSeenVersion: '0.5.87', featureOffersSeen: SIX });
  let firstIds = [];
  {
    const { app, ui, open, card, urls, present, press, choose } = await launch(updated);
    try {
      await open();
      const c = await waitFor(card);
      firstIds = c?.rows.map((r) => r.id) || [];
      check('update: the card shows the new settings on the empty chat', c?.title === 'New in Lumen' && c.rows.length === FO.CARD_MAX, JSON.stringify(c));
      // (the newest release in OFFERS heads the card, with its offers in OFFERS order; every heading after it is older)
      const vnum = (v) => v.split('.').map(Number).reduce((n, x) => n * 1000 + x, 0);
      const newest = FO.OFFERS.map((o) => o.since).sort((x, y) => vnum(y) - vnum(x))[0];
      const newestIds = FO.OFFERS.filter((o) => o.since === newest && !SIX.includes(o.id)).map((o) => o.id).slice(0, FO.CARD_MAX);
      const heads = (c?.releases || []).map((r) => r.replace(/^In /, ''));
      check('grouped by release, newest first', c?.releases[0] === `In ${newest}` && newestIds.length > 0 && firstIds.slice(0, newestIds.length).join() === newestIds.join() && heads.length >= 2 && heads.every((v, i) => i === 0 || vnum(v) < vnum(heads[i - 1])), JSON.stringify({ releases: c?.releases, firstIds, newestIds }));
      check('a long batch is capped with "More in Settings"', c?.foot.join() === `${FO.OFFERS.length - SIX.length - FO.CARD_MAX} more in Settings,Not now,Don’t show again`, JSON.stringify(c?.foot));
      check('the card was loaded after start, not with the window', c?.lazy === true, JSON.stringify(c));
      const row = (id) => c?.rows.find((r) => r.id === id);
      check('the ad blocker is a choice: Lumen’s built-in (in use) or uBlock Origin Lite', JSON.stringify(row('adBlocker')?.control) === JSON.stringify({ type: 'choice', value: 'lumen', options: ['Lumen’s built-in', 'uBlock Origin Lite'] }), JSON.stringify(row('adBlocker')));
      check('a setting that ships on is a switch that shows on', JSON.stringify(row('autoNewChat')?.control) === '{"type":"switch","on":true}', JSON.stringify(row('autoNewChat')));
      check('a setting that needs more has Set up…, a new thing to know has just its line', row('extensionSites')?.control.text === 'Set up…' && row('accountTabs')?.control.type === 'none', JSON.stringify(c?.rows));
      check('each line is plain', c?.rows.every((r) => r.name && r.desc && r.desc.length < 200), JSON.stringify(c?.rows));
      const want = [...SIX, ...firstIds.map((id) => FO.seenKey(FO.OFFERS.find((o) => o.id === id)))];
      await waitFor(() => sorted(settingsOf(updated).featureOffersSeen) === sorted(want), 4000);
      check('once it has been on screen, those lines are recorded as shown (and only those)', sorted(settingsOf(updated).featureOffersSeen) === sorted(want), JSON.stringify(settingsOf(updated).featureOffersSeen));

      await ui.click('.offer-row[data-offer="autoNewChat"] input[role=switch]');
      await waitFor(() => settingsOf(updated).autoNewChat === false, 4000);
      check('the switch changes the setting at once', settingsOf(updated).autoNewChat === false, JSON.stringify(settingsOf(updated)));
      check('and the line stays, showing off', JSON.stringify((await card())?.rows.find((r) => r.id === 'autoNewChat')?.control) === '{"type":"switch","on":false}', JSON.stringify(await card()));
      check('the chat follows it without a restart', await waitFor(() => ui.evaluate(() => window.lumenAutoNewChat === false), 4000), await ui.evaluate(() => window.lumenAutoNewChat));
      // (Secure DNS is the newest choice on the card; it goes back to Automatic at once, so the rest of the run keeps the system's DNS)
      await choose('secureDns', 'cloudflare');
      await waitFor(() => settingsOf(updated).secureDns === 'cloudflare', 4000);
      check('a choice changes its setting too', settingsOf(updated).secureDns === 'cloudflare', JSON.stringify(settingsOf(updated)));
      await choose('secureDns', 'auto');
      await waitFor(() => settingsOf(updated).secureDns === 'auto', 4000);
      await choose('adBlocker', 'ublock');
      const ask = await waitFor(() => ui.evaluate(() => document.querySelector('.offer-row[data-offer="adBlocker"] .offer-confirm')?.textContent));
      check('uBlock Origin Lite asks on the card first (it is installed from the Chrome Web Store)', /Chrome Web Store/.test(ask || ''), ask);
      check('and nothing is changed while it asks', settingsOf(updated).adBlocker === undefined, JSON.stringify(settingsOf(updated).adBlocker));
      await press('.offer-row[data-offer="adBlocker"] .offer-confirm .link-btn');
      check('Cancel puts the choice back and keeps Lumen’s blocker', (await card())?.rows.find((r) => r.id === 'adBlocker')?.control.value === 'lumen' && settingsOf(updated).adBlocker === undefined && !(await ui.evaluate(() => document.querySelector('.offer-confirm'))), JSON.stringify(settingsOf(updated).adBlocker));

      await press('.offer-row[data-offer="extensionSites"] .offer-go');
      const opened = await waitFor(async () => (await urls()).some((u) => /settings\.html#extensions-page$/.test(u)));
      check('Set up… opens the Extensions section of Settings', Boolean(opened), JSON.stringify(await urls()));
      check('and that line leaves the card', !(await card())?.rows.some((r) => r.id === 'extensionSites'), 'still there');

      await press('.offer-foot .offer-later');
      check('Not now takes the card away', !(await present()), 'still there');
      check('and changes nothing else', settingsOf(updated).replySuggestions === undefined && settingsOf(updated).featureCardNever !== true, JSON.stringify(settingsOf(updated)));
    } finally { await app.close().catch(() => {}); }
  }
  {
    const { app, open, card } = await launch(updated);
    try {
      await open();
      const c = await waitFor(card);
      check('the next launch shows the rest, none of what was on screen', c && c.rows.length > 0 && !c.rows.some((r) => firstIds.includes(r.id)), JSON.stringify(c));
    } finally { await app.close().catch(() => {}); }
  }

  // The first batch, for a profile that had seen everything newer: Telegram and voice input are set up in Settings.
  const firstBatch = makeProfile({ lastSeenVersion: '0.5.19', featureOffersSeen: ALL.filter((k) => !SIX.includes(k)) });
  {
    const { app, ui, open, card, urls, press } = await launch(firstBatch);
    try {
      await open();
      const c = await waitFor(card);
      check('a feature that ships off is a switch that shows off', ['memory', 'plan', 'skills', 'helpers'].every((id) => JSON.stringify(c?.rows.find((r) => r.id === id)?.control) === '{"type":"switch","on":false}'), JSON.stringify(c));
      await ui.click('.offer-row[data-offer="memory"] input[role=switch]');
      await waitFor(() => settingsOf(firstBatch).aiMemory === true, 4000);
      check('switching it on saves the setting', settingsOf(firstBatch).aiMemory === true, JSON.stringify(settingsOf(firstBatch)));
      await press('.offer-row[data-offer="telegram"] .offer-go');
      const opened = await waitFor(async () => (await urls()).some((u) => /settings\.html#telegram$/.test(u)));
      check('Set up… opens the Telegram section of Settings', Boolean(opened), JSON.stringify(await urls()));
      check('and turns nothing on by itself', settingsOf(firstBatch).telegramChannel !== true, JSON.stringify(settingsOf(firstBatch)));
      await press('.offer-row[data-offer="voice"] .offer-go');
      check('voice input is set up in Settings too', Boolean(await waitFor(async () => (await urls()).some((u) => /settings\.html#voice-input$/.test(u)))), JSON.stringify(await urls()));
    } finally { await app.close().catch(() => {}); }
  }

  const never = makeProfile({ lastSeenVersion: '0.5.87', featureOffersSeen: SIX });
  {
    const { app, ui, open, card } = await launch(never);
    try {
      await open();
      await waitFor(card);
      await ui.click('.offer-foot .offer-never');
      await waitFor(() => settingsOf(never).featureCardNever === true, 4000);
      check('Don\'t show again is saved and the card goes', settingsOf(never).featureCardNever === true && (await card()) === null, JSON.stringify(settingsOf(never)));
    } finally { await app.close().catch(() => {}); }
  }
  {
    const { app, open, card } = await launch(never);
    try {
      await open();
      await sleep(2500);
      check('and the next launch shows nothing, though lines are left', (await card()) === null, JSON.stringify(await card()));
    } finally { await app.close().catch(() => {}); }
  }

  const busy = makeProfile({ lastSeenVersion: '0.5.87', featureOffersSeen: SIX });
  {
    const { app, ui, open, card } = await launch(busy);
    try {
      await app.evaluate(() => { global.__agent.getClient = () => ({ beta: { messages: { stream: () => ({
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } }; await new Promise((r) => { global.__gate = r; }); },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Working' }], usage: { input_tokens: 1, output_tokens: 1 } }),
      }) } } }); });
      await open();
      await waitFor(card);
      await ui.fill('#prompt', 'do a long task');
      await ui.press('#prompt', 'Enter');
      await waitFor(() => ui.evaluate(() => document.body.classList.contains('running')));
      check('a running task is never covered by the card', (await card()) === null, JSON.stringify(await card()));
      await app.evaluate(() => global.__gate?.());
    } finally { await app.close().catch(() => {}); }
  }

  const fresh = makeProfile(null);
  {
    const { app, ui, open, card } = await launch(fresh);
    try {
      await open();
      await sleep(3000);
      check('a fresh profile is never asked, and records every line as seen', (await card()) === null && sorted(settingsOf(fresh).featureOffersSeen) === sorted(ALL), `${JSON.stringify(await card())} ${JSON.stringify(settingsOf(fresh))}`);
      check('and never loads the card', !(await ui.evaluate(() => Boolean(document.querySelector('script[src="offer-card.js"]')))), 'loaded');
    } finally { await app.close().catch(() => {}); }
  }
  for (const dir of [updated, firstBatch, never, busy, fresh]) fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
