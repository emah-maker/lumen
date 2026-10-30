// Plain Node: Settings → AI → "Start a new chat for a new topic" (autoNewChat). On by default, so a typed message with
// nothing in common with the open chat still moves to a new chat (renderer/chat-topic.js, chat-core.js askOnNewTopic);
// off, every message stays in the open chat. test/e2e/auto-new-chat.js sends the messages for real.
const fs = require('fs');
const path = require('path');
const { DEFAULTS, validate } = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');
const backend = read('src/settings/settings-backend.js');
const settings = read('src/renderer/settings.js');
const core = read('src/renderer/chat-core.js');
const en = JSON.parse(read('src/locales/en.json'));

// the setting
check('setting: on by default, so nothing changes for existing users', DEFAULTS.autoNewChat === true, DEFAULTS.autoNewChat);
check('setting: only a real on/off value is kept', validate('autoNewChat', false) === false && validate('autoNewChat', true) === true && validate('autoNewChat', 'no') === null && validate('autoNewChat', 0) === null, JSON.stringify([validate('autoNewChat', false), validate('autoNewChat', 'no'), validate('autoNewChat', 0)]));

// plumbing: settings file -> prefs:ui -> ui-prefs.js -> chat-core.js
check('plumbing: carried to the UI with the other preferences (missing counts as on)', /autoNewChat: p\.autoNewChat !== false/.test(backend));
check('plumbing: a change is pushed to the UI at once', /key === 'autoNewChat'( \|\| key === '\w+')*\) \(deps\.broadcastUi/.test(backend));
check('plumbing: ui-prefs.js keeps it where chat-core.js reads it', /window\.lumenAutoNewChat = p\.autoNewChat !== false/.test(read('src/renderer/ui-prefs.js')));
const body = core.slice(core.indexOf('async function askOnNewTopic('), core.indexOf('\n}\n', core.indexOf('async function askOnNewTopic(')));
check('plumbing: off, askOnNewTopic stops before it judges the message or opens a chat', body.indexOf('window.lumenAutoNewChat === false) return false') > 0 && body.indexOf('window.lumenAutoNewChat === false') < body.indexOf('isNewTopic(') && body.indexOf('window.lumenAutoNewChat === false') < body.indexOf("$('new-chat').click()"));
check('plumbing: the bundle carries the check', /window\.lumenAutoNewChat === false/.test(read('src/renderer/ui.bundle.js')));

// Settings → AI
const at = settings.indexOf("toggle('autoNewChat'");
check('Settings → AI: a "Start a new chat for a new topic" switch in the Chat box group, after "Sidebar button starts a new chat"', at > settings.indexOf("toggle('sidebarNewChat'") && at < settings.indexOf("toggle('replySuggestions'") && en['settings.ai.autoNewChat'] === 'Start a new chat for a new topic', at);
check('Settings → AI: the description says what off does, briefly', /Off: every message stays in the open chat/.test(en['settings.ai.autoNewChatDesc']) && en['settings.ai.autoNewChatDesc'].length < 160, en['settings.ai.autoNewChatDesc']);
check('Settings → AI: a missing value shows the switch on (fallback)', /toggle\('autoNewChat',[^\n]*\{ fallback: true \}\)/.test(settings));

// docs
check('docs: a settings row and a changelog entry', /`autoNewChat` \| on \|/.test(read('docs/settings.md')) && /autoNewChat/.test(read('CHANGELOG.md'))); // (anywhere: a release cut moves the entry out of Unreleased)

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
