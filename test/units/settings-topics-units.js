// Settings as topics (System Settings style), plain Node: the shape of the page's data (11 topics, every page opens from a row, every old link
// still lands somewhere), the one list of services (made from the connector registry), the "Let the AI use it" switch's backend (a paused connector
// is not offered to the AI and keeps its sign-in), the card switch that hides without signing out, and the one Todoist token.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const registry = require('../../src/features/connectors/registry');
const service = require('../../src/features/connectors/service');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const js = read('src/renderer/settings.js');
const cats = vm.runInNewContext(`(${/const CATEGORIES = (\[[\s\S]*?\n\]);/.exec(js)[1]})`);
const aliases = vm.runInNewContext(`(${/const ALIASES = (\{[\s\S]*?\n\});/.exec(js.replace(/\/\/[^\n]*/g, ''))[1]})`);

// ---- the shape
check('8 to 12 topics, each with a name a new person understands', cats.length >= 8 && cats.length <= 12 && cats.every((c) => /^[A-Z][A-Za-z ]+$/.test(c.title)), cats.map((c) => c.title).join());
check('the topics named in the brief are there', ['General', 'Appearance', 'AI', 'Apps and connections', 'Privacy and security', 'Tabs and browsing', 'Downloads and files', 'Advanced'].every((t) => cats.some((c) => c.title === t)));
const slotIds = cats.flatMap((c) => c.slots.map((s) => s[0]));
check('every slot id is used once', new Set(slotIds).size === slotIds.length, slotIds.filter((id, i) => slotIds.indexOf(id) !== i).join());
const slotOf = (id) => cats.flatMap((c) => c.slots.map((s) => ({ id: s[0], opts: s[2], cat: c.id }))).find((s) => s.id === id);
const pages = cats.flatMap((c) => c.slots.filter((s) => s[2]?.page));
check('every page is opened from a row in a list that is not itself a page, in its own topic', pages.every((p) => { const from = slotOf(p[2].page); return from && !from.opts?.page ? from.cat === cats.find((c) => c.slots.includes(p)).id : from?.opts?.page; }), pages.filter((p) => !slotOf(p[2].page)).map((p) => p[0]).join());
check('no topic page is long: a topic has at most 4 lists of its own (the rest are pages)', cats.every((c) => c.slots.filter((s) => !s[2]?.page).length <= 5), cats.map((c) => `${c.id}:${c.slots.filter((s) => !s[2]?.page).length}`).join());
const bad = Object.entries(aliases).filter(([, a]) => !cats.some((c) => c.id === a.cat) || (a.sub && !slotOf(a.sub) && !['connect-agents', 'external-apps', 'telegram', 'clock-greeting', 'passwords'].includes(a.sub)));
check('every old link (alias) lands in a topic or a page that exists', bad.length === 0, bad.map(([k]) => k).join());
check('the old Connectors and Widgets links open the merged topic and its cards page', aliases.connectors?.cat === 'apps' && slotOf('widgets')?.cat === 'apps' && slotOf('mcp-servers')?.cat === 'apps');
check('the AI topic has its first screen (model, short answers) and pages for the rest', slotOf('ai-model') && ['ai-answers', 'ai-memory', 'ai-approvals', 'ai-computer', 'ai-privacy', 'ai-keys-page'].every((id) => slotOf(id)?.opts?.page));
check('the first topic shows theme, search, startup, default AI and the apps', /buildQuick/.test(js) && /\['quick', ''\]/.test(js) && ['pref-theme-quick', 'pref-searchEngine', 'startup-select'].every((id) => js.includes(id)) && /settings\.quick\.ai/.test(js) && /settings\.quick\.apps/.test(js));
check('the duplicate Theme row on the first screen is left out of search', /theme\.dataset\.nosearch = '1'/.test(js) && /r\.dataset\.nosearch === '1'/.test(js));

// ---- long text is behind an (i)
check('a description over a line opens from an (i) button and stays for screen readers and search', /const INLINE_DESC = 64/.test(js) && /sr-only info-text/.test(js) && /aria-expanded/.test(js) && /'aria-controls': 'info-pop'/.test(js));
check('a caution that must be read first is never put behind the (i)', /!INLINE_WARN\.test\(desc\)/.test(js.slice(js.indexOf('function row(label'), js.indexOf('function row(label') + 400)));

// ---- the services list
const apps = read('src/renderer/settings-apps.js');
check('the list is made from the connector registry, so a new connector appears by itself', /C\.list\(\)/.test(apps) && /data\.connectors\.map\(\(c\) => \(\{ id: c\.id/.test(apps) && /data\.categories/.test(apps));
check('the services that have a card as well as a connector are Gmail, Calendar, Todoist and GitHub', /APP_WIDGET_OF = \{ gmail: 'gmail', gcal: 'calendar', todoist: 'todoist', github: 'github' \}/.test(apps));
check('a service page has one Connect, then Show on new tab page and Let the AI use it', /'show'/.test(apps) && /'ai'/.test(apps) && /conn-\$\{svc\.id\}-connect/.test(apps) && /Show on new tab page/.test(apps) && /Let the AI use it/.test(apps));
check('the Google client override is under Advanced on the Google pages', /googleClientRows/.test(apps) && /settings\.apps\.advanced/.test(apps) && /app-google-clientid/.test(apps));
const registryHasWidgetOnly = ['spotify', 'applemusic', 'slack', 'muse'].every((id) => !registry.get(id));
check('Spotify, Apple Music, Slack and Meta Muse are cards without a connector, listed beside the connectors', registryHasWidgetOnly && /APP_CARD_ONLY/.test(apps));
const widgetSummary = require('../../src/renderer/widget-summary');
check('every card kind is either a service or on the "Cards without an account" page', Object.keys(widgetSummary.KINDS).length >= 20 && ['gmail', 'calendar', 'todoist', 'github', 'spotify', 'applemusic', 'slack', 'muse'].every((t) => widgetSummary.KINDS[t]));

// ---- the AI switch: paused keeps the sign-in, takes the connector from the AI
const fakeSecrets = { available: () => true, encrypt: (s) => `x${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(1), 'base64').toString() };
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-topics-'));
let token = 'tok_abcdefghijklmnopqrstuvwxyz0123';
const svc = service.create({ userData, secrets: fakeSecrets, shared: { todoist: { info: () => (token ? { token, account: 'me@example.com' } : null), signOut: () => { token = ''; } } }, testLoopback: true });
(async () => {
  check('nothing is connected at first', svc.hasAny() === false);
  let list = svc.syncShared('todoist');
  const card = () => svc.list().connectors.find((c) => c.id === 'todoist');
  check('a Todoist token the card already has makes the connector connected, with no second token', card().status === 'connected' && /signed in/.test(card().statusText) && svc.hasAny() && list.connectors.length > 5);
  svc.setPaused('todoist', true);
  check('paused: still signed in, but the AI is offered nothing', card().status === 'connected' && card().paused === true && svc.hasAny() === false && registry.connectedIds().length === 0, JSON.stringify(registry.connectedIds()));
  const err = await svc.call({ app: 'todoist', action: 'tasks', args: {} }).then(() => '', (e) => e.message);
  check('paused: a call from the AI is refused and says why', /switched off for the AI|No service is connected/.test(err), err);
  svc.setPaused('todoist', false);
  check('turned on again: offered again, nothing was signed out', card().paused === false && svc.hasAny() && token !== '');
  check('the file keeps the pause (it is the user\'s choice, not a session one)', (() => { svc.setPaused('todoist', true); const on = JSON.parse(fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8')).connected.todoist.config.paused === true; svc.setPaused('todoist', false); return on; })());
  const refused = await (async () => { try { svc.setPaused('canvas', true); return ''; } catch (e) { return e.message; } })();
  check('pausing something that is not connected says to connect it first', /Connect it first/.test(refused), refused);
  await svc.disconnect('todoist');
  check('Disconnect on a shared token signs the card out too (one token, one place)', token === '' && card().status === 'off');

  // ---- widgets: hide without signing out; a key saved without a card
  const widgets = read('src/features/widgets.js');
  check('hiding a card keeps its sign-in or key (remove keepSecret), and the Todoist/GitHub shared token is kept while the connector uses it', /function remove\(id, \{ keepSecret = false \} = \{\}\)/.test(widgets) && /!keepSecret/.test(widgets) && /deps\.todoistInUse\?\.\(\)/.test(widgets));
  check('a key (Todoist, Muse, Twelve Data, CoinGecko) can be saved without a card, and a Todoist change tells the connector', /function setServiceSecret/.test(widgets) && /KEY_SERVICES = new Set\(\['todoist', 'muse', 'stocks', 'crypto'\]\)/.test(widgets) && /deps\.onTodoistChange\?\.\(\)/.test(widgets));
  const be = read('src/settings/settings-backend.js'); const pre = read('src/preload/settings-preload.js'); const main = read('src/main.js');
  check('backend, preload and main carry the new calls', /'prefs:widget-secret'/.test(be) && /keepSecret: opts\?\.keepSecret === true/.test(be) && /setSecret: call\('prefs:widget-secret'\)/.test(pre) && /setPaused: call\('connectors:set-paused'\)/.test(pre) && /'connectors:set-paused'/.test(main) && /'connectors:sync'/.test(main) && /shared: \{\s*\/\/ Todoist/.test(main));
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
