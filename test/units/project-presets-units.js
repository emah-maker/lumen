// [project presets] [job page chat] [job page controls] renderer/chat-project-page.js and .css: every template's project looks its own (its mark,
// badge and three first questions, in the theme's accent: no palette of its own), a Job applications project's Applications view starts with
// the same box and latest chats as every project's Overview, every project page has the chat header's Show chat list and Full screen, and
// Settings lists what the AI changed with Undo. Plain Node: source and stylesheet checks, and the templates' data.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const T = require('../../src/features/project-templates');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
const js = src('src/renderer/chat-project-page.js');
const css = src('src/renderer/chat-project-page.css');
const en = JSON.parse(src('src/locales/en.json'));
const rule = (selector) => { const at = css.indexOf(`${selector} {`); if (at < 0) return null; return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)); };

// ---- every template looks its own
{
  const tpl = js.match(/const TPL = \{([^\n]+)\};/);
  check('the page knows every template’s mark and name', Boolean(tpl) && T.list().every((t) => tpl[1].includes(`${t.id === 'job-applications' ? '[JOB]' : t.id}: ['${t.icon}', '${t.name}']`)), tpl?.[1]);
  check('...and draws each mark it names', T.list().every((t) => new RegExp(`\\n    ${t.icon}: '<`).test(js)));
  check('a template’s project gets the badge and the pjp-tpl look, not only Job applications', /const badge = tpl \? el\('span', \{ className: 'pjp-type-badge'/.test(js) && /root\.classList\.toggle\('pjp-tpl', Boolean\(tpl\)\)/.test(js));
  check('its first questions, translated, put in the box without sending', /projecttpl\.starter\.\$\{id\}\.\$\{i\}/.test(js) && /box\.value = b\.textContent/.test(js) && !/startersRow[\s\S]{0,1400}requestSubmit/.test(js));
  for (const t of T.list()) check(`en.json has ${t.name}’s three first questions as the template says them`, t.starters.every((q, i) => en[`projecttpl.starter.${t.id}.${i}`] === q));
  const look = ['.pjp-tpl:not(.pjp-job) .pjp-head-row', '.pjp-tpl:not(.pjp-job) .pjp-mark', '.pjp-tpl:not(.pjp-job) .pjp-type-badge', '.pjp-starter'].map((s) => [s, rule(s)]);
  check('the preset look is the theme’s tokens and accent only (no colour of its own)', look.every(([, r]) => r && !/#[0-9a-f]{3,8}\b(?!\))/i.test(r.replace(/var\([^)]*\)/g, '')) && /var\(--/.test(r)), JSON.stringify(look));
  check('no custom palette: no --job-like colour variables for the presets', !/--(?:course|code|research)[\w-]*:/.test(css));
}

// ---- the Applications view has the same chat box and latest chats
{
  check('Applications: the same box (page.start) and latest chats (page.recent) over the dashboard', /const dock = el\('div', \{ className: 'pjp-job-chat' \}, page\.start, page\.recent\);\s*\n\s*viewBox\.replaceChildren\(dock, holder\);/.test(js));
  check('...moved back to Overview when another view opens (one box, not two)', /if \(page\.start && page\.start\.parentNode !== cols\) cols\.prepend\(page\.start, page\.recent\);/.test(js) && (js.match(/(?<!function )composer\(data\)/g) || []).length === 1);
  check('...compact: a short box, one row of at most three cards, and All chats to the whole list', /min-height: 24px/.test(rule('.pjp-job-chat .pjp-compose-text') || '') && /display: none/.test(rule('.pjp-job-chat .pjp-chat-card:nth-child(n+4)') || '') && /display: inline/.test(rule('.pjp-job-chat .pjp-all-chats') || '') && /display: none/.test(rule('.pjp-all-chats') || ''));
}

// ---- the chat header's controls on every project page
{
  check('Show chat list and Full screen press the chat header’s own buttons', /ctl\('rail', [^\n]+'cp-rail-open', 'pjp-rail-open'\)/.test(js) && /ctl\('expand', [^\n]+'cp-fullscreen', 'cp-full-btn pjp-full'\)/.test(js) && /document\.getElementById\(target\)\?\.click\(\)/.test(js));
  check('...in the page’s top bar, for every project (not only a job one)', /const topbar = el\('div', \{ className: 'pjp-topbar' \}, railBtn, back, el\('span', \{ className: 'pjp-grow' \}\), fullBtn\);/.test(js) && /el\('header', \{ className: 'pjp-head' \}, topbar,/.test(js));
  check('...Full screen is a .cp-full-btn, so chat-page.js keeps its pressed state and label', /'cp-full-btn pjp-full'/.test(js) && /cp-full-in/.test(js) && /cp-full-out/.test(js));
  check('...Show chat list only while the list is folded', /display: none/.test(rule('.pjp .pjp-ctl.pjp-rail-open') || '') && /display: inline-grid/.test(rule('body.cp-rail-hidden .pjp .pjp-ctl.pjp-rail-open') || ''));
  const page = src('src/renderer/chat-page.js');
  check('chat-page.js updates every .cp-full-btn on a change (the project page’s included)', /for \(const b of document\.querySelectorAll\('\.cp-full-btn'\)\)/.test(page));
}

// ---- Settings: what the AI changed
{
  check('Settings lists the AI’s changes with Undo', /folderCard\(page\.data\), aiChangesCard\(\)\]/.test(js) && /prefs\.undo\(e\.token\)/.test(js) && /prefs\.list\(me\.id\)/.test(js));
  for (const k of ['prefs.card', 'prefs.card.tip', 'prefs.none', 'prefs.changed', 'prefs.undone', 'prefs.changedSince', 'prefs.gone', 'prefs.scope.app', 'prefs.scope.project', 'projectws.allChats', 'projectws.starters']) check(`en.json has ${k}`, typeof en[k] === 'string' && en[k].length > 0);
  check('the card says the AI never changes permissions, privacy or security', /never changes permissions, privacy or security/.test(en['prefs.card.tip']));
}

console.log(failures ? `\n${failures} failed` : '\nAll project preset checks passed.');
process.exit(failures ? 1 : 0);
