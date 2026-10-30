// What "Restore settings to their original defaults" resets, in one place: the row's text, the confirmation and the backend all read this.
// Each area lists the settings.json keys it puts back to their defaults (`stored`: keys that are not in DEFAULTS).
// Everything else is left alone: the AI page, widgets, Focus lists, allow-lists, extension pins, bookmarks, history, API keys and sign-ins.
// test/units/settings-reset-units.js fails when a DEFAULTS key is in neither an area nor its list of kept settings, so a new setting has to be put somewhere.
const AREAS = [
  { id: 'appearance', label: 'appearance', keys: [
    'theme', 'accentColor', 'newTabBackground', 'newTabShuffle', 'newTabWidgetGlass', 'newTabEffect', 'newTabEffectColor', 'newTabEffectAmount',
    'newTabEffectSpeed', 'newTabEffectSize', 'newTabEffectInteract', 'newTabImage', 'newTabClock', 'newTabClockSize', 'newTabClockStyle',
    'newTabClockHours', 'newTabClockSeconds', 'newTabClockDate', 'newTabClockCard', 'newTabClockShadow', 'newTabGreetingFont', 'newTabSearchWidth',
    'newTabName', 'forceDarkWebsites', 'defaultZoom', 'fontSize', 'showBookmarkButton', 'showAiOffButton', 'extensionsToolbar',
    'compactTabs', 'tabLayout', 'sideTabsWidth', 'sideTabsCollapsed', 'reduceMotion', 'minimumFontSize', 'focusRings', 'screenReaderSupport',
    'graphicsMode', 'pinchZoom',
  ], stored: ['siteZoom'] },
  { id: 'search', label: 'search engine', keys: [], stored: ['searchEngine'] },
  { id: 'startup', label: 'startup', keys: [
    'startup', 'startupPages',
  ] },
  { id: 'privacy', label: 'privacy', keys: [
    'blockThirdPartyCookies', 'sendDoNotTrack', 'sendGpc', 'hideTabActivity', 'hideWindowSize', 'stripTrackingParams', 'fingerprintProtection',
    'webrtcIpProtection', 'blockTrackingPings', 'httpsOnly', 'passkeys', 'safeBrowsing', 'adblock',
  ] },
  { id: 'permissions', label: 'site permissions', keys: [
    'permissionDefaults',
  ], stored: ['sitePermissions', 'deviceGrants'] },
  { id: 'languages', label: 'languages', keys: [
    'languages', 'spellcheck', 'spellcheckLanguages', 'translateOffer', 'translateTarget', 'translateEngine', 'translateLocalAuto',
  ] },
  { id: 'system', label: 'system settings', keys: [
    'hardwareAcceleration', 'tabSleep', 'tabSleepMode', 'tabSleepMinutes', 'tabSleepHow', 'tabSleepFreePercent', 'tabSleepLumenGb', 'tabSleepMaxAwake',
    'tabSleepKeepPinned', 'tabSleepKeepRecent', 'tabSleepFreezeFirstMinutes', 'tabSleepPressure', 'tabSleepKeepAudio', 'tabSleepKeepForms',
    'tabSleepKeepTransfers', 'tabSleepKeepGroups', 'tabSleepSoonMinutes', 'tabSleepDim', 'tabSleepShowFreed', 'tabSleepOnReturn', 'tabReadyRecent',
    'tabPreload', 'performanceMode', 'proxy', 'keepRunningInBackground', 'downloadDir', 'askWhereToSave', 'pdfViewer', 'autoDownloadUpdates',
    'showWhatsNew', 'organizeOnlyMixed', 'organizeDelaySeconds', 'recordSwitchTimings',
  ] },
];
const keysOf = (area) => [...area.keys, ...(area.stored || [])];
const resetKeys = () => AREAS.flatMap(keysOf);
// "appearance, search engine, startup, privacy, site permissions, languages and system settings"
const areaList = (areas = AREAS) => { const names = areas.map((a) => a.label); return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || ''; };
const FOCUS_MESSAGE = 'Focus mode is on: settings can be reset when it ends.';

module.exports = { AREAS, keysOf, resetKeys, areaList, FOCUS_MESSAGE };
