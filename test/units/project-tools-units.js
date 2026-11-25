// [project tools] features/project-tools.js: which connected apps, MCP servers and skills a project's chats get. The allow rules (unset is
// every one, [] none, the older connectors/mcp switches still win), the page's catalog and switches, template presets and the New project
// dialog's picks; the chat store and project.json keeping the lists; the connector tool listing only a project's apps; the skills listing
// cut to a project's; and the templates' presets. Plain Node; every folder is a temp folder.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../../src/features/project-tools');
const T = require('../../src/features/project-templates');
const registry = require('../../src/features/connectors/registry');
const portable = require('../../src/features/project-portable');
const skillMd = require('../../src/features/skill-md');
const { createChatStore } = require('../../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;

// ---- the allow rules
{
  check('no defaults: every tool', P.allows(undefined, 'app:gmail') && P.allows({}, 'server:files') && P.allows({}, 'skill:review') && P.allows({}, 'connectors') && P.allows({}, 'mcp'));
  const d = { apps: ['gmail', 'sheets'], servers: ['files'], skills: ['job-search'] };
  check('a list: only what it names', P.allows(d, 'app:gmail') && !P.allows(d, 'app:github') && P.allows(d, 'server:files') && !P.allows(d, 'server:other') && P.allows(d, 'skill:job-search') && !P.allows(d, 'skill:review'));
  check('a connector card\'s MCP server follows its app', P.allows({ apps: ['linear'] }, 'preset:linear') && !P.allows({ apps: ['gmail'] }, 'preset:linear') && P.allows({}, 'preset:linear'));
  check('an empty app list: no connector tool at all', !P.allows({ apps: [] }, 'connectors') && P.allows({ apps: ['gmail'] }, 'connectors'));
  check('the older switches still win over a list', !P.allows({ connectors: false, apps: ['gmail'] }, 'app:gmail') && !P.allows({ mcp: false, servers: ['files'] }, 'server:files') && !P.allows({ mcp: false }, 'preset:linear') && !P.allows({ mcp: false }, 'mcp'));
  check('onlyApps: null for every one, the list, [] when switched off', P.onlyApps({}) === null && J(P.onlyApps({ apps: ['gmail'] })) === J(['gmail']) && J(P.onlyApps({ connectors: false, apps: ['gmail'] })) === '[]');
  check('anything else asked about is allowed (not a tool this decides)', P.allows({ apps: [] }, 'something'));
}

// ---- cleaning
{
  check('lists: known shapes only, no repeats', J(P.cleanList(['gmail', 'gmail', 'Bad Id', '../x', 'sheets'], 'apps')) === J(['gmail', 'sheets']) && P.cleanList('gmail', 'apps') === undefined);
  check('lists: at most 60', P.cleanList(Array.from({ length: 80 }, (_, i) => `s${i}`), 'servers').length === P.MAX);
  check('cleanTools keeps only set lists', J(P.cleanTools({ apps: ['gmail'], skills: 'x', model: 'm' })) === J({ apps: ['gmail'] }));
}

// ---- the page's catalog and its switches
const connectors = [
  { id: 'gmail', name: 'Gmail', kind: 'oauth', status: 'connected', icon: { text: 'M', color: '#d93025' } },
  { id: 'sheets', name: 'Google Sheets', kind: 'google', status: 'off' },
  { id: 'github', name: 'GitHub', kind: 'token', status: 'connected' },
  { id: 'linear', name: 'Linear', kind: 'mcp', status: 'off' },
];
const servers = [{ name: 'files', enabled: true, state: 'ready', tools: [{}, {}] }, { name: 'linear', preset: 'linear', enabled: true }, { name: 'old', enabled: false }];
const skills = [{ name: 'job-search', title: 'Job search', description: 'Find jobs' }, { name: 'review', title: 'Review' }];
{
  const all = P.catalog({ connectors, servers, skills }, {});
  check('every one: the connected apps on, the rest off, and it says "all"', all.all.apps && J(all.apps.filter((a) => a.on).map((a) => a.id)) === J(['gmail', 'github']), J(all.apps));
  check('a connector card\'s server is listed as an app, not as a server', !all.servers.some((s) => s.id === 'linear') && all.apps.some((a) => a.id === 'linear'));
  check('servers: every enabled one on; tools counted', J(all.servers.map((s) => [s.id, s.on, s.tools])) === J([['files', true, 2], ['old', false, 0]]));
  check('how each connects: one click for a sign-in, Settings for a token', all.apps.find((a) => a.id === 'sheets').connect === 'click' && all.apps.find((a) => a.id === 'github').connect === 'settings' && all.apps.find((a) => a.id === 'linear').connect === 'click' && P.connectMode({ id: 'canvas', kind: 'session' }) === 'click');
  const picked = P.catalog({ connectors, servers, skills }, { apps: ['gmail', 'sheets'] });
  check('a list: what it names is on, connected or not yet', !picked.all.apps && J(picked.apps.filter((a) => a.on).map((a) => a.id)) === J(['gmail', 'sheets']));
  check('missing: the apps on that still need connecting', J(P.missing(picked).map((a) => a.id)) === J(['sheets']) && P.missing(all).length === 0);

  // switches
  const off = P.toggle({ model: 'm' }, 'apps', 'github', false, ['gmail', 'github']);
  check('switching one off on "every one" keeps the others on, as a list', J(off) === J({ model: 'm', apps: ['gmail'] }), J(off));
  const on = P.toggle(off, 'apps', 'sheets', true);
  check('switching one on adds it', J(on.apps) === J(['gmail', 'sheets']));
  check('"all" goes back to every one (the older switch too)', !('apps' in P.toggle({ apps: ['gmail'], connectors: false }, 'apps', 'all', true)) && !('connectors' in P.toggle({ connectors: false }, 'apps', 'all', true)));
  check('"none" empties the list', J(P.toggle({}, 'skills', 'none', false).skills) === '[]');
  check('from the older "off" switch, switching one on starts from none', J(P.toggle({ connectors: false }, 'apps', 'gmail', true)) === J({ apps: ['gmail'] }));
  check('servers and skills switch the same way', J(P.toggle({}, 'servers', 'files', false, ['files', 'old'])) === J({ servers: ['old'] }) && J(P.toggle({ skills: ['review'] }, 'skills', 'job-search', true).skills) === J(['review', 'job-search']));
  check('an unknown kind changes nothing', J(P.toggle({ apps: ['gmail'] }, 'nope', 'x', true)) === J({ apps: ['gmail'] }));
}

// ---- templates and the New project dialog
{
  const job = T.byId('job-applications');
  check('Job applications comes with Gmail, Sheets, Drive, Docs and Calendar', J(P.templateDefaults(job)) === J({ apps: ['gmail', 'sheets', 'drive', 'docs', 'calendar'] }));
  check('Code project comes with GitHub and plan first', J(P.templateDefaults(T.byId('coding'))) === J({ apps: ['github'], plan: true }));
  check('every template\'s apps are real connectors', T.TEMPLATES.every((t) => (t.tools?.apps || []).every((id) => registry.get(id))), J(T.TEMPLATES.map((t) => t.tools?.apps)));
  check('every template\'s instructions fit a project', T.TEMPLATES.every((t) => t.instructions.length > 50 && t.instructions.length <= 4000));
  check('no template: nothing preset', J(P.templateDefaults(null)) === '{}');
  check('the dialog\'s ticks replace the template\'s apps; untouched kinds keep it', J(P.mergeChosen(P.templateDefaults(job), { apps: ['gmail'] })) === J({ apps: ['gmail'] }) && J(P.mergeChosen({ apps: ['gmail'], plan: true }, {})) === J({ apps: ['gmail'], plan: true }));
  check('the dialog\'s null: every one', !('apps' in P.mergeChosen({ apps: ['gmail'] }, { apps: null })));
}

// ---- the connector tool lists only a project's apps
{
  registry.setConnected(['gmail', 'github', 'canvas']);
  const every = registry.toolDef();
  const some = registry.toolDef({ only: ['gmail', 'sheets'] });
  check('the connector tool: every connected app without a list', J([...every.input_schema.properties.app.enum].sort()) === J(['canvas', 'github', 'gmail']), J(every.input_schema.properties.app.enum));
  check('the connector tool: a project\'s connected apps only', J(some.input_schema.properties.app.enum) === J(['gmail']) && !/github/.test(some.description), some.description);
  check('the connector tool: none at all when none of its apps is connected', registry.toolDef({ only: ['sheets'] }) === null && registry.toolDef({ only: [] }) === null);
  registry.setConnected([]);
}

// ---- the skills listing cut to a project's
{
  const list = [{ name: 'job-search', description: 'Find jobs' }, { name: 'review', description: 'Review a draft' }];
  const only = skillMd.promptListing(list.filter((s) => ['job-search'].includes(s.name)));
  check('a project\'s skills: only those listed to the AI', /job-search/.test(only) && !/review/.test(only));
}

// ---- kept by the chat store and in project.json
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-tools-'));
  const enc = (s) => Buffer.from(s).toString('base64');
  const dec = (s) => Buffer.from(s, 'base64').toString();
  const store = createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => 1_800_000_000_000 });
  const p = store.saveProject({ name: 'Co-op', defaults: { model: 'm', apps: ['gmail', 'gmail', 'Bad!'], servers: ['files'], skills: [] } });
  check('the store keeps the lists, cleaned; an empty one stays empty', J(p.defaults) === J({ model: 'm', apps: ['gmail'], servers: ['files'], skills: [] }), J(p.defaults));
  const again = createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => 1_800_000_000_001 }).projects().find((x) => x.id === p.id);
  check('…and they are there after a restart', J(again.defaults) === J(p.defaults));
  const cleared = store.saveProject({ id: p.id, name: p.name, defaults: { model: 'm' } });
  check('a list left out is every one again', J(cleared.defaults) === J({ model: 'm' }));
  const text = portable.settingsText({ description: 'x', defaults: p.defaults });
  const back = portable.parseSettings(text);
  check('project.json keeps the lists both ways', J(back.defaults) === J(p.defaults), text);
  check('project.json without lists: none made up', !('apps' in portable.parseSettings('{"format":1,"defaults":{"plan":true}}').defaults));
  check('project.json: a bad entry is dropped', J(portable.parseSettings('{"defaults":{"apps":["gmail","../x",3]}}').defaults.apps) === J(['gmail']));
}

if (failures) { console.log(`\n${failures} project tools check(s) failed.`); process.exit(1); }
console.log('\nAll project tools checks passed.');
