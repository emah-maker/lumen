// Settings > Advanced > "Restore settings to their original defaults": exactly the areas the row lists go back (src/settings/reset-scope.js),
// every other key stays, and a reset is refused while Focus mode is on. Plain Node.
const os = require('os');
const RS = require('../../src/settings/reset-scope');
const SB = require('../../src/settings/settings-backend');
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail ?? ''}`}`); if (!ok) failures++; };

const D = SB.DEFAULTS;
const inAreas = new Set(RS.AREAS.flatMap((a) => a.keys));
// Every setting a reset leaves alone, named here so a new setting has to be put in an area or on this list.
const KEPT = [
  'newTabHeader', 'newTabFavorites', 'newTabFrequent', 'newTabPrivacy', 'newTabHiddenTiles', 'newTabWidgetsPacked', 'homeWidgetSizes', 'weatherPlaces',
  'weatherHere', 'weatherLocation', 'homeWidgets', 'extensionPins', 'focusSites', 'focusSchedules', 'adblockAllow', 'projectsDir', 'tabSleepNever',
  'tabSleepSoon', 'maxSteps', 'aiSubagents', 'actingHelpers', 'aiSubagentModel', 'maxChatRuns', 'autoModel', 'autoCompact', 'autoExclude', 'imageGen',
  'usageBars', 'aiGapLog', 'autoFallback', 'aiSignedInSites', 'aiSharedFiles', 'connectorAlways', 'claudeCodeSidebar', 'grokSidebar', 'antigravitySidebar', 'aiEffort',
  'featureCardNever', 'featureOffersSeen', 'telegramChannel', 'telegramFiles', 'telegramSignedIn', 'bypassBackground',
  'aiDesktopControl', 'aiFilesInApps', 'aiWordControl', 'aiDesktopTerminals', 'aiDesktopApps', 'routineWebhooks', 'routineWebhookPort',
  'aiDeviceAccess', 'filesRemember', 'claudeCodeFullAccess', 'ccUserSettings', 'grokBuildFullAccess', 'codexSidebar', 'codexFullAccess',
  'antigravityFullAccess', 'grokTerminal', 'grokWarmup', 'grokKeepConnected', 'codexKeepConnected', 'grokKeepIdleMinutes', 'researchTabs',
  'groupAiTabs', 'hideAiTabs', 'agentsNoAsk', 'askBeforeActing', 'bypassPermissions', 'aiPreferFractions', 'aiInstructionsOn', 'aiInstructionsAbout',
  'aiInstructionsStyle', 'planModeDefault', 'skillsAutoUse', 'skillsFromClaudeCode', 'skillsSuggest', 'aiMemory', 'aiMemoryChatSearch', 'aiHandsOff',
  'sidebarNewChat', 'replySuggestions', 'chatAutocomplete', 'oneChatPerTab', 'aiStayOnMyTab', 'closeAiTabs', 'keepViewedAiTabs', 'dictationProvider', 'dictationAutoSend',
  'translateNever', 'translateConsent', 'lastSeenVersion',
];
const kept = new Set(KEPT);
check('scope: every setting is either reset or kept, so a new one has to be put somewhere', Object.keys(D).every((k) => inAreas.has(k) !== kept.has(k)), Object.keys(D).filter((k) => inAreas.has(k) === kept.has(k)).join());
check('scope: no key is listed that does not exist', [...inAreas, ...kept].every((k) => k in D), [...inAreas, ...kept].filter((k) => !(k in D)).join());
check('scope: no key is in two areas', RS.resetKeys().length === new Set(RS.resetKeys()).size);
check('scope: the row text names every area, in order', RS.areaList() === 'appearance, search engine, startup, privacy, site permissions, languages and system settings', RS.areaList());
check('scope: what the issue named stays (AI full-access flags, custom instructions, widgets, extension pins, allow-lists, Focus lists)',
  ['claudeCodeFullAccess', 'grokBuildFullAccess', 'codexFullAccess', 'antigravityFullAccess', 'aiInstructionsOn', 'aiInstructionsAbout', 'homeWidgets', 'extensionPins', 'adblockAllow', 'tabSleepNever', 'focusSites', 'focusSchedules'].every((k) => kept.has(k)));
check('scope: search engine, site permissions and per-site zoom are in the reset', ['searchEngine', 'sitePermissions', 'deviceGrants', 'siteZoom'].every((k) => RS.resetKeys().includes(k)));

let settings = {};
let focus = false;
let cleared = 0;
const backend = SB.create({
  app: { getPath: () => os.tmpdir(), disableHardwareAcceleration() {}, commandLine: { appendSwitch() {} }, getLocale: () => 'en' },
  session: { defaultSession: { availableSpellCheckerLanguages: [], getSpellCheckerLanguages: () => [], setSpellCheckerLanguages() {}, setSpellCheckerEnabled() {}, setProxy: async () => {}, setUserAgent() {}, webRequest: {}, clearHostResolverCache: async () => {} } },
  nativeTheme: {}, dialog: {}, shell: {},
  readSettings: () => settings,
  writeSettings: (s) => { settings = s; },
  permissionDecisions: { clear: () => { cleared++; } },
  focusLocked: () => focus,
  ui: () => ({ send() {} }), broadcastUi() {}, refreshAccent() {}, refreshNewTabs() {},
  tabContents: () => [],
  onSearchEngineReset: () => {},
});

(async () => {
  const messy = () => ({
    theme: 'dark', accentColor: 'red', startup: 'pages', languages: ['fr'], blockThirdPartyCookies: false, hardwareAcceleration: false, tabSleepMinutes: 5,
    searchEngine: 'bing', sitePermissions: { 'a.com': 1 }, deviceGrants: { x: 1 }, siteZoom: { 'a.com': 1.5 },
    claudeCodeFullAccess: true, aiInstructionsOn: true, aiInstructionsAbout: 'I like cats', adblockAllow: ['a.com'], tabSleepNever: ['b.com'],
    focusSites: ['example.com'], focusSchedules: [], extensionPins: { order: ['x'], seen: ['x'] }, someUnknownKey: 'stay',
  });
  settings = messy();
  focus = true;
  let refused = '';
  try { await backend.reset(); } catch (err) { refused = err.message; }
  check('focus: a reset is refused while Focus mode is on, with the reason', /Focus mode is on/.test(refused), refused);
  check('focus: …and nothing changed', JSON.stringify(settings) === JSON.stringify(messy()) && cleared === 0);
  check('focus: the state says so (the Reset button is disabled)', backend.state().resetLocked === true);

  focus = false;
  check('state: the areas the page lists are the scope', JSON.stringify(backend.state().resetAreas.map((a) => a.label)) === JSON.stringify(RS.AREAS.map((a) => a.label)) && backend.state().resetLocked === false);
  await backend.reset();
  const gone = ['theme', 'accentColor', 'startup', 'languages', 'blockThirdPartyCookies', 'hardwareAcceleration', 'tabSleepMinutes', 'searchEngine', 'sitePermissions', 'deviceGrants', 'siteZoom'];
  check('reset: every listed area is back to its default', gone.every((k) => !(k in settings)), gone.filter((k) => k in settings).join());
  const stayed = messy();
  for (const k of gone) delete stayed[k];
  check('reset: nothing else changed (AI flags, instructions, allow-lists, Focus lists, extension pins, unknown keys)', JSON.stringify(settings) === JSON.stringify(stayed), JSON.stringify(settings));
  check('reset: the site-permission answers remembered this session are cleared too', cleared === 1);
  check('reset: the resulting state shows the defaults', backend.state().prefs.theme === D.theme && backend.state().prefs.claudeCodeFullAccess === true);

  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log(`FAIL  ${e.stack}`); process.exit(1); });
