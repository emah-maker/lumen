// lumen://settings/<id>: every id the Settings page itself understands (a category, an old name or natural alias, a sub-page) must be a link
// the backend accepts, and the command bar must list every current category and sub-page. Reads renderer/settings.js, so a page added
// there without its link (or a stale command-bar entry) fails here. Pure node.
const fs = require('fs');
const path = require('path');
const SB = require('../../src/settings/settings-backend');
const CB = require('../../src/features/command-bar');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const settings = read('src', 'renderer', 'settings.js');
const bar = read('src', 'renderer', 'command-bar.js');
const en = JSON.parse(read('src', 'locales', 'en.json'));

const cats = [...(/const CATEGORIES = \[([\s\S]*?)\n\];/.exec(settings)[1]).matchAll(/\{ id: '([a-z-]+)', title/g)].map((m) => m[1]);
const aliasBlock = /const ALIASES = \{([\s\S]*?)\n\};/.exec(settings)[1];
const aliases = [...aliasBlock.replace(/\/\/[^\n]*/g, '').matchAll(/(?:^|[{,])\s*(?:'([a-z-]+)'|([a-z]+)):\s*\{/g)].map((m) => m[1] || m[2]);
// (a page is a slot of CATEGORIES with { page }, or a subpage() made by a builder; a service's own page, app-<id>, is made from the connector registry)
const subs = [...new Set([...settings.matchAll(/\.subpage\('([a-z-]+)'/g), ...(/const CATEGORIES = \[([\s\S]*?)\n\];/.exec(settings)[1]).matchAll(/\['([a-z-]+)', '[^']+', \{ page:/g)].map((m) => m[1]))];

check('parsed the page: 11 topics, 30+ aliases, 40+ pages', cats.length === 11 && aliases.length > 30 && subs.length > 40, `${cats.length} ${aliases.length} ${subs.length}`);
const links = (ids) => ids.filter((id) => SB.urlFor(id) !== `${SB.SETTINGS_URL}#${id}`);
check('every category opens through lumen://settings/<id>', links(cats).length === 0, links(cats).join());
check('every alias opens through lumen://settings/<id>', links(aliases).length === 0, links(aliases).join());
check('every sub-page opens through lumen://settings/<id>', links(subs).length === 0, links(subs).join());
check('the backend lists nothing the page does not know', SB.SECTION_LINKS.every((id) => [...cats, ...aliases, ...subs, ...SB.SECTIONS].includes(id)), SB.SECTION_LINKS.filter((id) => ![...cats, ...aliases, ...subs, ...SB.SECTIONS].includes(id)).join());
check('an unknown id opens the plain page', SB.urlFor('no-such-page') === SB.SETTINGS_URL && SB.urlFor('') === SB.SETTINGS_URL, '');
check('lumen://settings/connectors and /focus parse to those ids', SB.parseSettingsInput('lumen://settings/connectors').section === 'connectors' && SB.parseSettingsInput('lumen://settings/ai-keys-page').section === 'ai-keys-page', '');

// The command bar.
const ids = CB.SECTION_IDS;
check('command bar: every category is listed', cats.every((id) => ids.includes(id)), cats.filter((id) => !ids.includes(id)).join());
check('command bar: every page is listed', subs.every((id) => ids.includes(id)), subs.filter((id) => !ids.includes(id)).join());
check('a service page (app-<id>) is a link the backend accepts, an unknown one is not a page', SB.urlFor('app-gmail') === `${SB.SETTINGS_URL}#app-gmail` && SB.urlFor('app-') === SB.SETTINGS_URL && SB.parseSettingsInput('lumen://settings/app-gmail').section === 'app-gmail', '');
check('command bar: nothing it lists is a retired name', !['about', 'you-and-ai'].some((id) => ids.includes(id)), '');
check('command bar: every entry opens a page the backend accepts', ids.every((id) => SB.SECTION_LINKS.includes(id)), ids.filter((id) => !SB.SECTION_LINKS.includes(id)).join());
check('command bar: no duplicate entries', new Set(ids).size === ids.length, '');
const titles = Object.fromEntries([...bar.matchAll(/\['([a-z-]+)', '([^']+)', '[^']*'\],/g)].map((m) => [m[1], m[2]]));
check('command bar: the renderer and main side list the same pages', Object.keys(titles).join() === ids.join(), Object.keys(titles).join());
check('command bar: titles match Settings (en.json) and the page headings', ids.every((id) => en[`settings.section.${id}`] === titles[id]), ids.filter((id) => en[`settings.section.${id}`] !== titles[id]).join());
const catTitles = [...(/const CATEGORIES = \[([\s\S]*?)\n\];/.exec(settings)[1]).matchAll(/\{ id: '([a-z-]+)', title: '([^']+)'/g)];
check('command bar: category titles are the sidebar titles', catTitles.every((m) => titles[m[1]] === m[2]), catTitles.filter((m) => titles[m[1]] !== m[2]).map((m) => m[1]).join());

process.exit(failures ? 1 : 0);
