// Settings wording and grouping (Area 5 of the settings audit), plain Node: the dead meetingHelper key is gone and dropped from old
// files, the AI page has one Approvals / Computer access / Let agents use Lumen group, the Advanced page one Graphics and effects
// group, "Side tabs: icons only" shows only for the Side layout, no description says "On/Off by default", and the inverted keys are documented.
const fs = require('fs');
const path = require('path');
const backend = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const settings = read('src/renderer/settings.js');
const en = JSON.parse(read('src/locales/en.json'));
const docs = read('docs/settings.md');

// #28 meetingHelper
check('meetingHelper is not a setting any more', !('meetingHelper' in backend.DEFAULTS));
check('docs/settings.md has no meetingHelper row', !docs.includes('`meetingHelper`'));
const old = { theme: 'dark', meetingHelper: true };
const dropped = backend.dropMeetingHelper(old);
check('an old settings file loses meetingHelper and keeps the rest', dropped && !('meetingHelper' in dropped) && dropped.theme === 'dark' && old.meetingHelper === true, JSON.stringify(dropped));
check('a file without it is left alone (nothing to write)', backend.dropMeetingHelper({ theme: 'dark' }) === null && backend.dropMeetingHelper(null) === null);

// groups: which rows are in which group
const groupBody = (key) => { const i = settings.indexOf(key); return settings.slice(i, i + 4000); };
const approvals = groupBody("tr('settings.ai.groupApprovals'");
check('Approvals holds the mode, the background option, hands-off and agents\' own-window approvals', ['permissionRow', 'bypassRow', "toggle('aiHandsOff'", "toggle('agentsNoAsk'"].every((k) => approvals.slice(0, approvals.indexOf("tr('settings.ai.groupBrowser'")).includes(k)));
check('the bypass-in-background row shows only while Bypass is the chosen mode', /bypassRow\.hidden = st\.prefs\.aiPermissionMode !== 'bypass'/.test(settings));
const computer = groupBody("tr('settings.ai.groupComputer'");
check('Computer access holds files, other apps, terminals, files in apps and Word, and points at the Privacy lists', ['aiDeviceAccess', 'aiDesktopControl', 'aiDesktopTerminals', 'aiFilesInApps', 'aiWordControl', 'ai-computer-lists'].every((k) => computer.includes(k)));
const agents = settings.slice(settings.indexOf("agents.group(tr('settings.ai.groupLetAgents'"));
const iLet = 0; const iCon = agents.indexOf("agents.group(tr('settings.ai.groupConnectors'");
check('Let agents use Lumen holds the connect switch, Connect an AI agent and Let other apps use Lumen; Connectors is its own group after it', iCon > 0 && ['mcpToggle', "subpage('connect-agents'", "subpage('external-apps'"].every((k) => { const at = agents.indexOf(k); return at > iLet && at < iCon; }) && agents.indexOf("subpage('connectors'") > iCon);
check('the automation tools (CDP) row sits in an Advanced "Let agents use Lumen" group and says how it differs', /groupAutomation', 'Let agents use Lumen \(advanced\)'/.test(settings) && /separate, lower-level way in/i.test(settings));
const system = settings.slice(settings.indexOf('function buildSystem'));
check('Advanced has one Graphics and effects group: acceleration, Performance mode, Visual effects and the music-reactive switch', (() => { const end = system.indexOf("buildUnloading"); const body = system.slice(0, end); return body.indexOf('groupGraphics') > 0 && ['hardwareAcceleration', 'performanceMode', 'graphicsMode', 'musicReactiveRow()'].every((k) => body.includes(k)); })());
check('Reduce motion stays in Appearance (Accessibility)', /function buildAccessibility[\s\S]*?toggle\('reduceMotion'/.test(settings));

// #33 rows with a description (and a control) or gone
check('Saved memory and Choose per program say what is inside before they open', /settings\.ai\.memoryEntriesSummary/.test(settings) && /settings\.ai\.perProgramDesc/.test(settings) && /function collapsible\(title, rows, desc\)/.test(settings));
check('Printing no longer claims there are no print settings, and still names Ctrl+P', !/no print settings/i.test(en['settings.print.desc']) && /Ctrl\+P/.test(en['settings.print.desc']));
check('Recent files says what it covers and its button says where it goes', /General > Files/.test(en['settings.files.privacyRefDesc']) && en['settings.files.privacyRefGo'] === 'Open Files settings');

// #35 side tabs
check('"Side tabs: icons only" is hidden unless the layout is Side', /collapsedRow\.hidden = st\.prefs\.tabLayout !== 'side'/.test(settings) && !/Only used when Tab layout is Side/.test(settings));

// #36 no "On/Off by default" sentences in anything a person reads
const shown = [...Object.values(en).filter((v) => typeof v === 'string'), ...(settings.match(/'[^'\n]*'/g) || [])];
const stale = shown.filter((v) => /\b(on|off) by default\b/i.test(v) && !/\/\//.test(v));
check('no setting description says "On by default" or "Off by default"', stale.length === 0, stale.slice(0, 3).join(' | '));

// #34 inverted keys
const be = read('src/settings/settings-backend.js');
check('the three inverted keys say so in the code', ['aiStayOnMyTab', 'aiHandsOff', 'agentsNoAsk'].every((k) => new RegExp(`${k}: [^\\n]*INVERTED in Settings`).test(be)));
check('the three inverted keys say so in docs/settings.md', ['aiStayOnMyTab', 'aiHandsOff', 'agentsNoAsk'].every((k) => docs.split('\n').some((l) => l.includes(`\`${k}\``) && /switch|inverted|other way/i.test(l))));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
