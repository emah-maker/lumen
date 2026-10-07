// Where a new-tab widget's edit / gear button goes (`node test/widget-edit-url-units.js`): Settings > Home > Widgets
// (lumen://settings/widgets), never a generic category; an open Settings tab is reused and told, not reloaded.
// Pure node: source checks plus the real widgets state machine. No Electron, no window.
const fs = require('fs');
const path = require('path');
const { createWidgets, CONNECTORS } = require('../src/features/widgets');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` -- ${detail}`}`);
}

(async () => {
  const settingsJs = read('src/renderer/settings.js');
  const mainJs = read('src/main.js');
  const backend = read('src/settings/settings-backend.js');
  const preload = read('src/preload/settings-preload.js');

  // The destination id exists on both sides.
  const links = /const SECTION_LINKS = \[([\s\S]*?)\];/.exec(backend)[1];
  check('settings backend: "widgets" is a deep-link id', /'widgets'/.test(links));
  check('settings backend: lumen://settings/widgets parses to widgets', /widgets/.test(JSON.stringify(parse('lumen://settings/widgets'))));
  function parse(t) { const m = /^(?:lumen|chrome):\/\/settings\/?([a-z-]*)\/?$/i.exec(t); return m ? { section: m[1] } : null; }
  check('settings.js: widgets is a sub-page slot under Home', /subpage\('widgets', 'Widgets'/.test(settingsJs) && /\['widgets', 'Widgets'\]/.test(settingsJs));
  check('settings.js: route() selects a sub-page id from the hash', /if \(sub\?\.isSub\) view = \{ cat: sub\.cat, sub: id \}/.test(settingsJs));
  check('settings.js: hashchange re-routes (an open tab follows a new hash)', /addEventListener\('hashchange', route\)/.test(settingsJs));

  // The gear's backend target.
  const cfg = /onConfigure: \(\) => \{([\s\S]*?)\n {2}\},/.exec(mainJs)[1];
  check('main.js: the gear opens the widgets section, not appearance', /openSettingsPage\('widgets'\)/.test(cfg) && !/'appearance'/.test(cfg));
  check('main.js: an open Settings tab is told (no reload), openSettingsPage reuses it', /send\('widgets:edit'\)/.test(cfg) && !/\.reload\(\)/.test(cfg) && /const existing = tabs\.find\(\(t\) => t\.settings && alive\(t\)\)/.test(mainJs));
  check('preload: exposes onEdit for widgets:edit', /onEdit: \(cb\) => ipcRenderer\.on\('widgets:edit'/.test(preload));
  check('settings.js: onEdit re-reads state, opens the editor, routes to #widgets and highlights it', /S\.widgets\.onEdit\?\.\(/.test(settingsJs) && /location\.hash = '#widgets'/.test(settingsJs) && /flash-target/.test(/S\.widgets\.onEdit[\s\S]*?\n {2}\}\);/.exec(settingsJs)[0]));
  check('settings.js: opening with a pending edit forces the widgets route', /forceRoute = 'widgets'/.test(settingsJs));

  // Every widget type: the gear / Add picker asks for it, and Settings' type list has it (so applyEdit opens its form).
  let settings = {};
  const w = createWidgets({ readSettings: () => settings, writeSettings: (s) => { settings = s; }, fetch: async () => { throw new Error('offline'); }, getSecret: () => null, setSecret: () => {}, endpoints: () => ({}), onConfigure: () => {} });
  const listed = new Set(w.state().types.map((t) => t.type));
  for (const type of Object.keys(CONNECTORS)) {
    check(`type ${type}: Settings lists it`, listed.has(type));
    const w2 = createWidgets({ readSettings: () => settings, writeSettings: (s) => { settings = s; }, fetch: async () => { throw new Error('offline'); }, getSecret: () => null, setSecret: () => {}, endpoints: () => ({}), onConfigure: () => {} });
    await w2.act({ do: 'create', type });
    const first = w2.state().create; const second = w2.state().create;
    check(`type ${type}: the create request reaches Settings once`, first === type && second === null, `${first}/${second}`);
  }
  // An existing widget id: edit is delivered once, then cleared.
  settings = { homeWidgets: [{ id: 'wtodo01', type: 'todoist', x: 0, y: 0, w: 4, h: 4 }] };
  const w3 = createWidgets({ readSettings: () => settings, writeSettings: (s) => { settings = s; }, fetch: async () => { throw new Error('offline'); }, getSecret: () => null, setSecret: () => {}, endpoints: () => ({}), onConfigure: () => {} });
  check('existing widget is in the list', w3.state().widgets.some((x) => x.id === 'wtodo01'));
  {
    await w3.act({ id: 'wtodo01', do: 'configure' });
    const a = w3.state().edit; const b = w3.state().edit;
    check('existing widget: edit id delivered once then cleared', a === 'wtodo01' && !b, `${a}/${b}`);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
