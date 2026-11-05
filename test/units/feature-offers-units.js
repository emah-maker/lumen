// "New in Lumen" (features/feature-offers.js), plain Node: every settings key has a line on the card or a reason not to;
// who is shown what (a fresh install nothing, an update every line not seen yet whose setting still has its default,
// newest release first, nothing twice, nothing already changed by hand); that a batch counts as shown once it has been on
// screen; that a switch or a choice goes through the settings setter at once and stays on the card, while a line that
// needs setting up (Telegram, voice input) only points at its Settings section; that a long batch is capped with "More in
// Settings"; and that "Not now" / "Don't show again" stick.
const FO = require('../../src/features/feature-offers');
const { DEFAULTS } = require('../../src/settings/settings-backend');
const en = require('../../src/locales/en.json');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const toggles = [{ id: 'a', key: 'a', since: '0.5.1', value: true, kind: 'toggle' }, { id: 'b', key: 'b', since: '0.5.1', value: true, kind: 'toggle' }];
const SIX = ['aiMemory', 'planModeDefault', 'skillsFromClaudeCode', 'telegramChannel', 'dictation', 'actingHelpers']; // the first batch (0.5.55-0.5.60)
const ALL_SEEN = FO.OFFERS.map(FO.seenKey);
const idOf = (key) => FO.OFFERS.find((o) => FO.seenKey(o) === key).id;

// The settings keys that were already in DEFAULTS when the card learned to list settings (0.5.65). Frozen: never add to
// it. A key added since then needs a line in FO.OFFERS (with the release that brings it) or a reason in FO.QUIET.
const BEFORE_0_5_65 = new Set([
  'theme', 'accentColor', 'newTabBackground', 'newTabShuffle', 'newTabWidgetGlass', 'newTabEffect', 'newTabEffectColor', 'newTabEffectAmount',
  'newTabEffectSpeed', 'newTabEffectSize', 'newTabEffectInteract', 'newTabImage', 'newTabClock', 'newTabClockSize', 'newTabClockStyle',
  'newTabClockHours', 'newTabClockSeconds', 'newTabClockDate', 'newTabClockCard', 'newTabClockShadow', 'newTabGreetingFont', 'newTabSearchWidth',
  'newTabName', 'newTabHeader', 'newTabFavorites', 'newTabFrequent', 'newTabPrivacy', 'newTabWidgetsPacked', 'homeWidgetSizes', 'weatherPlaces',
  'weatherHere', 'weatherLocation', 'homeWidgets', 'forceDarkWebsites', 'defaultZoom', 'fontSize', 'showBookmarkButton', 'showAiOffButton',
  'compactTabs', 'tabLayout', 'sideTabsWidth', 'sideTabsCollapsed', 'startup', 'startupPages', 'blockThirdPartyCookies', 'sendDoNotTrack', 'sendGpc',
  'hideTabActivity', 'hideWindowSize', 'stripTrackingParams', 'fingerprintProtection', 'webrtcIpProtection', 'blockTrackingPings', 'httpsOnly',
  'passkeys', 'safeBrowsing', 'focusSites', 'focusSchedules', 'adblock', 'adblockAllow', 'permissionDefaults', 'downloadDir', 'projectsDir',
  'askWhereToSave', 'pdfViewer', 'spellcheck', 'spellcheckLanguages', 'languages', 'reduceMotion', 'minimumFontSize', 'focusRings',
  'screenReaderSupport', 'hardwareAcceleration', 'tabSleep', 'tabSleepMode', 'tabSleepMinutes', 'tabSleepHow', 'tabSleepFreePercent',
  'tabSleepLumenGb', 'tabSleepMaxAwake', 'tabSleepKeepPinned', 'tabSleepKeepRecent', 'tabSleepNever', 'tabSleepFreezeFirstMinutes', 'tabSleepPressure',
  'tabSleepKeepAudio', 'tabSleepKeepForms', 'tabSleepKeepTransfers', 'tabSleepKeepGroups', 'tabSleepSoon', 'tabSleepSoonMinutes', 'tabSleepDim',
  'tabSleepShowFreed', 'tabSleepOnReturn', 'tabReadyRecent', 'tabPreload', 'performanceMode', 'graphicsMode', 'proxy', 'keepRunningInBackground',
  'organizeOnlyMixed', 'organizeDelaySeconds', 'maxSteps', 'aiSubagents', 'aiSubagentModel', 'maxChatRuns', 'autoModel', 'autoCompact', 'autoExclude',
  'imageGen', 'usageBars', 'recordSwitchTimings', 'aiGapLog', 'autoFallback', 'aiSignedInSites', 'aiSharedFiles', 'claudeCodeSidebar', 'grokSidebar',
  'antigravitySidebar', 'aiEffort', 'pinchZoom', 'telegramSignedIn', 'bypassBackground', 'aiDesktopControl', 'aiDesktopTerminals', 'aiDesktopApps',
  'routineWebhooks', 'routineWebhookPort', 'aiDeviceAccess', 'filesRemember', 'claudeCodeFullAccess', 'ccUserSettings', 'grokBuildFullAccess',
  'codexSidebar', 'codexFullAccess', 'antigravityFullAccess', 'grokTerminal', 'grokWarmup', 'grokKeepConnected', 'codexKeepConnected',
  'grokKeepIdleMinutes', 'researchTabs', 'hideAiTabs', 'agentsNoAsk', 'askBeforeActing', 'bypassPermissions', 'aiInstructionsOn',
  'aiInstructionsAbout', 'aiInstructionsStyle', 'skillsAutoUse', 'skillsSuggest', 'aiMemoryChatSearch', 'aiHandsOff', 'sidebarNewChat',
  'oneChatPerTab', 'aiStayOnMyTab', 'closeAiTabs', 'dictationProvider', 'dictationAutoSend', 'translateOffer', 'translateTarget', 'translateNever',
  'translateConsent', 'translateEngine', 'translateLocalAuto', 'autoDownloadUpdates', 'showWhatsNew', 'lastSeenVersion'
]);

(async () => {
  // ---- the catalog
  {
    const listed = new Set(FO.OFFERS.map((o) => o.key).filter(Boolean));
    const missing = Object.keys(DEFAULTS).filter((k) => !listed.has(k) && !(k in FO.QUIET) && !BEFORE_0_5_65.has(k));
    check('every settings key added since 0.5.65 has a line on the card or a reason not to', missing.length === 0, `no line and no reason: ${missing.join(', ')} (add it to OFFERS in features/feature-offers.js with its release, or to QUIET with why)`);
    check('every reason to leave a key out is written down', Object.values(FO.QUIET).every((r) => typeof r === 'string' && r.length > 10), J(FO.QUIET));
    check('a key is listed or left out, never both', ![...listed].some((k) => k in FO.QUIET));
    check('the frozen list only names keys that still exist and gains nothing', [...BEFORE_0_5_65].every((k) => k in DEFAULTS) && BEFORE_0_5_65.size <= 168, [...BEFORE_0_5_65].filter((k) => !(k in DEFAULTS)).join());
    check('every line has a release, a known kind and a unique id', FO.OFFERS.every((o) => /^\d+\.\d+\.\d+$/.test(o.since) && ['toggle', 'choice', 'setup', 'tip'].includes(o.kind)) && new Set(FO.OFFERS.map((o) => o.id)).size === FO.OFFERS.length);
    check('every line names a setting that exists (or none: a tip, a setup, voice input)', FO.OFFERS.every((o) => !o.key || o.key in DEFAULTS || o.ready));
    check('a switch is a boolean setting', FO.OFFERS.filter((o) => o.kind === 'toggle').every((o) => typeof DEFAULTS[o.key] === 'boolean'));
    check('a setting that ships off and is offered to be turned on defaults to false', FO.OFFERS.filter((o) => 'value' in o && o.kind === 'toggle').every((o) => DEFAULTS[o.key] === false));
    check('a choice includes its default and only values the setting takes', FO.OFFERS.filter((o) => o.kind === 'choice').every((o) => o.choices.includes(DEFAULTS[o.key]) && (o.confirm === undefined || o.choices.includes(o.confirm))));
    const backend = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'settings', 'settings-backend.js'), 'utf8');
    const noSection = FO.OFFERS.filter((o) => o.section && !new RegExp(`'${o.section}'`).test(backend));
    check('every Settings section a line opens exists', noSection.length === 0, noSection.map((o) => o.section).join());
    check('every setup line opens a section', FO.OFFERS.filter((o) => o.kind === 'setup').every((o) => o.section));
    check('Telegram and voice input are setup lines, never turned on by the card', ['telegram', 'voice'].every((id) => FO.OFFERS.find((o) => o.id === id).kind === 'setup'));
    check('the ad blocker is a choice of Lumen\'s own or uBlock Origin Lite, which asks first (it installs an extension)', J(FO.OFFERS.find((o) => o.key === 'adBlocker')) === J({ id: 'adBlocker', key: 'adBlocker', since: '0.5.88', kind: 'choice', choices: ['lumen', 'ublock'], confirm: 'ublock', section: 'privacy-adblock' }));
    check('0.5.88 brings the ad blocker, extension site access and account tabs', J(FO.OFFERS.filter((o) => o.since === '0.5.88').map((o) => o.id)) === '["adBlocker","extensionSites","accountTabs"]');
    const strings = (o) => [`offers.${o.id}`, `offers.${o.id}.desc`, ...(o.choices || []).map((v) => `offers.${o.id}.${v}`), ...(o.confirm !== undefined ? [`offers.${o.id}.${o.confirm}.confirm`] : [])];
    const noString = FO.OFFERS.flatMap(strings).concat(['offers.title', 'offers.setUp', 'offers.notNow', 'offers.never', 'offers.release', 'offers.more', 'offers.useIt', 'offers.cancel']).filter((k) => !en[k]);
    check('every line, choice and the card have their strings', noString.length === 0, noString.join());
    check('every line is short', FO.OFFERS.every((o) => en[`offers.${o.id}.desc`].length < 200), FO.OFFERS.filter((o) => en[`offers.${o.id}.desc`]?.length >= 200).map((o) => o.id).join());
  }

  // ---- plan
  {
    let p = FO.plan({ settings: {}, offers: toggles });
    check('a fresh install is offered nothing and records every line as seen', p.show.length === 0 && J(p.seen) === '["a","b"]', J(p));
    p = FO.plan({ settings: {} });
    check('(the real list too, a line with no setting by its id)', p.show.length === 0 && J([...p.seen].sort()) === J([...ALL_SEEN].sort()) && p.seen.includes('offer:accountTabs'), J(p.seen));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19' }, offers: toggles });
    check('an update is offered every line still off, and records nothing yet', J(p.show.map((o) => o.key)) === '["a","b"]' && p.seen.length === 0, J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19', featureOffersSeen: ['a'] }, offers: toggles });
    check('a line already shown is not shown again', J(p.show.map((o) => o.key)) === '["b"]' && J(p.seen) === '["a"]', J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19', b: true }, offers: toggles });
    check('a setting the user already turned on is not offered (but recorded)', J(p.show.map((o) => o.key)) === '["a"]' && p.seen.includes('b'), J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19', featureOffersSeen: 'junk' }, offers: toggles });
    check('a broken seen list is treated as empty', p.show.length === 2, J(p));

    const user = { lastSeenVersion: '0.5.87', featureOffersSeen: SIX }; // a profile that saw the first batch and nothing since
    p = FO.plan({ settings: user, defaults: DEFAULTS });
    check('an update shows only the lines not seen yet', p.show.length === FO.OFFERS.length - SIX.length && !p.show.some((o) => SIX.includes(FO.seenKey(o))) && J(p.seen) === J(SIX), J(p.show.map((o) => o.id)));
    const rel = (v) => v.split('.').map(Number).reduce((n, x) => n * 1000 + x, 0);
    check('newest release first', p.show[0].since === '0.5.96' && p.show[0].id === 'automationsKeepTabs' && p.show.every((o, i) => i === 0 || rel(p.show[i - 1].since) >= rel(o.since)), J(p.show.map((o) => o.since)));
    p = FO.plan({ settings: { ...user, autoNewChat: false, chatAutoDeleteDays: 30, adBlocker: 'lumen' }, defaults: DEFAULTS });
    check('a key changed by hand counts as seen (and one saved at its default does not)', !p.show.some((o) => ['autoNewChat', 'chatAutoDelete'].includes(o.id)) && p.seen.includes('autoNewChat') && p.seen.includes('chatAutoDeleteDays') && p.show.some((o) => o.id === 'adBlocker'), J({ show: p.show.map((o) => o.id), seen: p.seen }));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.88', featureOffersSeen: ALL_SEEN }, defaults: DEFAULTS });
    check('once everything is seen, nothing is shown', p.show.length === 0, J(p.show));
  }

  // ---- the card
  {
    const make = (settings = { lastSeenVersion: '0.5.19' }, { voiceReady = false } = {}) => {
      let file = { ...settings };
      const writes = []; const sets = [];
      const fo = FO.createFeatureOffers({
        readSettings: () => ({ ...file }), writeSettings: (s) => { writes.push(s); file = { ...s }; },
        setSetting: async (k, v) => { sets.push([k, v]); file = { ...file, [k]: v }; },
        defaults: DEFAULTS, ready: () => ({ dictation: voiceReady }), test: false,
      });
      return { fo, writes, sets, file: () => file };
    };
    const ids = (g) => (g ? g.items.map((i) => i.id) : null);
    // A profile that saw the first batch and the newest line (Keep automation tabs open, off by default), so the card's first six
    // still hold a switch that ships on (autoNewChat) for the checks below.
    const upd = { lastSeenVersion: '0.5.87', featureOffersSeen: [...SIX, 'automationsKeepTabs'] };
    const waiting = FO.OFFERS.length - upd.featureOffersSeen.length;

    let c = make(upd);
    const early = c.fo.get(); // asked before startup has decided: it waits, it doesn't guess
    check('before startup prepares it, the card waits (the version is not recorded yet)', await Promise.race([early.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 50))]) === 'waiting' && c.fo.list() === null);
    c.fo.prepare();
    const first = await early;
    check('and answers as soon as it has: the same call, no retry', first?.items?.length > 0);
    check(`a long batch shows the first ${FO.CARD_MAX}, newest first, and counts the rest for "More in Settings"`, first.items.length === FO.CARD_MAX && first.items[0].id === 'secureDns' && first.more === waiting - FO.CARD_MAX && Boolean(first.moreSection), J(first));
    const ad = first.items.find((i) => i.id === 'adBlocker');
    check('a choice comes with its values, the one in use and the one that asks first', J(ad) === J({ id: 'adBlocker', kind: 'choice', since: '0.5.88', value: 'lumen', choices: ['lumen', 'ublock'], confirm: 'ublock', section: 'privacy-adblock' }), J(ad));
    const sw = first.items.find((i) => i.id === 'autoNewChat');
    check('a switch comes with its state (a setting that ships on shows on)', sw?.kind === 'toggle' && sw.value === true, J(sw));
    check('a setup line and a tip come with no value', first.items.find((i) => i.id === 'extensionSites').kind === 'setup' && first.items.find((i) => i.id === 'accountTabs').kind === 'tip' && !('value' in first.items.find((i) => i.id === 'accountTabs')));
    check('listing it records nothing: it counts as shown only once on screen', c.writes.length === 0, J(c.writes));
    c.fo.onShown(ids(first));
    check('once shown, the lines on screen are recorded as seen (and only those)', J(c.file().featureOffersSeen) === J([...upd.featureOffersSeen, ...first.items.map((i) => FO.seenKey(FO.OFFERS.find((o) => o.id === i.id)))]), J(c.file().featureOffersSeen));
    check('and stay on the card for the rest of this session (the other surface shows them too)', J(ids(c.fo.list())) === J(ids(first)), J(c.fo.list()));
    c.fo.onShown(['adBlocker']);
    check('showing it twice does not write twice', c.writes.length === 1, J(c.writes));

    let r = await c.fo.set('autoNewChat', false);
    check('a switch changed on the card is saved through the settings setter at once', r.ok && J(c.sets) === '[["autoNewChat",false]]' && c.file().autoNewChat === false, J(c.sets));
    check('and the line stays, showing its new state', c.fo.list().items.find((i) => i.id === 'autoNewChat')?.value === false, J(c.fo.list()));
    r = await c.fo.set('secureDns', 'cloudflare');
    check('a choice is saved too', r.ok && c.file().secureDns === 'cloudflare' && c.fo.list().items.find((i) => i.id === 'secureDns')?.value === 'cloudflare', J(c.sets));
    r = await c.fo.set('secureDns', 'google'); // (a value Settings has, but not one of the card's choices)
    check('a value that is not one of its choices is refused', r.ok === false && c.sets.length === 2);
    r = await c.fo.set('adBlocker', 'ublock');
    check('the ad blocker goes through the setter (which installs uBlock Origin Lite)', r.ok && J(c.sets[2]) === '["adBlocker","ublock"]', J(c.sets));
    r = await c.fo.set('autoNewChat', 'yes');
    check('a switch takes only true or false', r.ok === false);
    r = await c.fo.set('extensionSites', true);
    check('a setup line or a tip has nothing to set', r.ok === false && (await c.fo.set('accountTabs', true)).ok === false);
    r = await c.fo.act('extensionSites');
    check('"Set up…" names its Settings section, changes nothing and leaves the card', r.ok && r.section === 'extensions-page' && c.sets.length === 3 && !ids(c.fo.list()).includes('extensionSites'), J({ r, list: c.fo.list() }));

    let next = make(c.file()); next.fo.prepare();
    const second = next.fo.list();
    check('the next launch shows only what was not on screen', second && !ids(second).some((id) => ids(first).includes(id)) && second.items.length === Math.min(FO.CARD_MAX, first.more), J(second));
    next.fo.onShown(ids(second));
    const third = make(next.file()); third.fo.prepare();
    const left = first.more - Math.min(FO.CARD_MAX, first.more);
    check('and a later one the rest, until nothing is left', left > 0 ? third.fo.list()?.items.length === Math.min(FO.CARD_MAX, left) : third.fo.list() === null, J(third.fo.list()));

    // the first batch, as an old profile that has seen everything newer sees it
    c = make({ lastSeenVersion: '0.5.19', featureOffersSeen: ALL_SEEN.filter((k) => !SIX.includes(k)) }); c.fo.prepare();
    check('the first batch keeps its lines: acting helpers, memory, plan mode, skills, Telegram, voice input', J(ids(c.fo.list())) === J(['actingHelpers', ...SIX.slice(0, 5)].map(idOf)), J(c.fo.list()));
    check('a feature that ships off is a switch that shows off', c.fo.list().items.find((i) => i.id === 'memory').value === false);
    c.fo.onShown(ids(c.fo.list()));
    r = await c.fo.set('memory', true);
    check('switching it on sets it through the settings setter', r.ok && J(c.sets) === '[["aiMemory",true]]' && c.file().aiMemory === true, J(c.sets));
    r = await c.fo.set('memory', false);
    check('and off again', r.ok && c.file().aiMemory === false);
    r = await c.fo.act('helpers');
    check('"act" on a switch still turns it on', r.ok && c.file().actingHelpers === true);
    r = await c.fo.act('telegram');
    check('"Set up…" on Telegram only names its Settings section: nothing is switched on', r.ok && r.section === 'telegram' && !c.file().telegramChannel, J({ r, sets: c.sets }));
    r = await c.fo.act('voice');
    check('"Set up…" on voice input opens its section and sets nothing', r.section === 'voice-input' && c.sets.length === 3, J({ r, sets: c.sets }));
    r = await c.fo.act('nope');
    check('an unknown id does nothing', r.ok === false && (await c.fo.set('nope', true)).ok === false && c.sets.length === 3);

    c = make(upd); c.fo.prepare(); const shownIds = ids(c.fo.list()); c.fo.onShown(shownIds);
    c.fo.dismiss();
    check('"Not now" puts the card away for this run without changing anything or stopping later batches', c.fo.list() === null && c.sets.length === 0 && c.file().featureCardNever !== true, J(c.file()));
    next = make(c.file()); next.fo.prepare();
    check('and the next launch shows none of what was on screen, only the rest', next.fo.list() && !ids(next.fo.list()).some((id) => shownIds.includes(id)), J(next.fo.list()));
    c = make(upd); c.fo.prepare(); const noIo = ids(c.fo.list());
    c.fo.dismiss();
    check('"Not now" counts what was on the card as seen even if it was never reported on screen', noIo.every((id) => c.file().featureOffersSeen.includes(FO.seenKey(FO.OFFERS.find((o) => o.id === id)))), J(c.file().featureOffersSeen));

    c = make(upd); c.fo.prepare();
    c.fo.dismiss({ never: true });
    check('"Don\'t show again" is remembered', c.file().featureCardNever === true && c.fo.list() === null, J(c.file()));
    next = make({ ...c.file(), featureOffersSeen: [] }); next.fo.prepare();
    check('and stops later batches too, even for lines never shown before', next.fo.list() === null);

    c = make({ lastSeenVersion: '0.5.19', featureOffersSeen: ALL_SEEN.filter((k) => !SIX.includes(k)), aiMemory: true, planModeDefault: true }); c.fo.prepare();
    check('a feature already on by hand is not listed (and is recorded)', J(ids(c.fo.list())) === '["helpers","skills","telegram","voice"]' && c.file().featureOffersSeen.includes('aiMemory'), J(c.fo.list()));
    c = make({ lastSeenVersion: '0.5.19', featureOffersSeen: ALL_SEEN.filter((k) => k !== 'dictation') }, { voiceReady: true }); c.fo.prepare();
    check('voice input is not offered when it already works (a key is set)', c.fo.list() === null, J(c.fo.list()));
    {
      const fo = FO.createFeatureOffers({ readSettings: () => ({ lastSeenVersion: '0.5.19', featureOffersSeen: ['automationsKeepTabs'] }), writeSettings: () => {}, setSetting: async () => { throw new Error('nope'); }, defaults: DEFAULTS, test: false });
      fo.prepare();
      const log = console.error; console.error = () => {};
      const res = await fo.set('autoNewChat', false);
      console.error = log;
      check('a change that fails is reported (the card puts the control back)', res.ok === false && ids(fo.list()).includes('autoNewChat'), J(res));
    }
    c = make({}); c.fo.prepare();
    check('a fresh install shows no card and records every line as seen', c.fo.list() === null && J([...c.file().featureOffersSeen].sort()) === J([...ALL_SEEN].sort()), J(c.file()));

    const quietFo = FO.createFeatureOffers({ readSettings: () => ({ lastSeenVersion: '0.5.19' }), writeSettings: () => { throw new Error('wrote'); }, setSetting: async () => {}, test: true });
    let quiet = true;
    try { quietFo.prepare(); quietFo.list(); } catch { quiet = false; }
    check('test mode never lists or writes on its own', process.env.LUMEN_FEATURE_OFFERS_TEST ? true : quiet && quietFo.list() === null);
  }

  // ---- the renderer file and the plumbing
  {
    const fs = require('fs'); const path = require('path');
    const rd = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
    check('the sidebar loads the card after start, only when there is something to show (not part of the startup bundle)', !/offer-card\.js/.test(rd('src/renderer/index.src.html')) && /loadLater\('offer-card\.css', 'offer-card\.js'\)/.test(rd('src/renderer/app.js')) && !/offerCard = \{ show \}/.test(rd('src/renderer/ui.bundle.js')) && !/\.offer-card/.test(rd('src/renderer/ui.bundle.css')));
    check('the chat page loads it with its stylesheet', /offer-card\.js/.test(rd('src/renderer/chat-page.html')) && /offer-card\.css/.test(rd('src/renderer/chat-page.html')));
    check('the chat page and the sidebar may both ask for it', /'offers:get', 'offers:act'/.test(rd('src/features/chat-page.js')) && /'offers:get', 'offers:act'/.test(rd('src/main.js')));
    check('main passes the defaults and takes a change', /defaults: settingsPage\.DEFAULTS/.test(rd('src/main.js')) && /action === 'set'.*offers\.set\(arg\.id, arg\.value\)/.test(rd('src/main.js')));
    check('the settings setter refuses the card\'s own records', /featureCardNever'\) throw/.test(rd('src/settings/settings-backend.js')) && /featureOffersSeen'\) throw/.test(rd('src/settings/settings-backend.js')));
    const card = rd('src/renderer/offer-card.js');
    check('the card sits inside the empty chat (never over a conversation) and saves nothing itself', /empty\.querySelector\('\.chips'\)/.test(card) && !/setSetting|settings:set|prefs\.set/.test(card));
    check('it draws switches, choices, Set up…, release headings and More in Settings', /'role', 'switch'/.test(card) && /'select'/.test(card) && /offers\.setUp/.test(card) && /offers\.more/.test(card) && /offers\.release/.test(card));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
