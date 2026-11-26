// [ai preferences] ai/preferences.js: the safe keys only (security, privacy, permissions and accounts refused with where to go), each value
// checked, project keys only in a project's chat, standing notes kept apart in the instructions, every change logged with an Undo that puts
// the old value back only while the setting still has the AI's value, and the agent's gate (a card once the chat read outside content).
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const prefs = require('../../src/ai/preferences');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };

(async () => {
  // a fake browser and project
  const make = ({ inProject = true } = {}) => {
    const app = { theme: 'system', accentColor: 'blue', fontSize: 16, reduceMotion: false, compactTabs: false, tabLayout: 'top', aiPreferFractions: false, permissionMode: 'ask' };
    const project = { id: 'p1', name: 'Thesis', description: '', instructions: 'Write in my voice.', defaults: { model: '', plan: false } };
    const events = [];
    const log = prefs.createChangeLog({ newId: (() => { let n = 0; return () => `t${++n}`; })() });
    const read = (e) => (e.scope === 'app' ? app[e.key] : e.field === 'instructions' ? project.instructions : e.field === 'description' ? project.description : e.field === 'defaults.model' ? project.defaults.model : project.defaults.plan);
    const write = async (e, v) => {
      if (e.scope === 'app') app[e.key] = v;
      else if (e.field === 'instructions') project.instructions = v;
      else if (e.field === 'description') project.description = v;
      else if (e.field === 'defaults.model') project.defaults.model = v;
      else project.defaults.plan = v;
      return true;
    };
    const deps = { app: { read: (k) => app[k] }, project: inProject ? { get: () => project } : null, accents: ['blue', 'green', 'rose'], fontSizes: [12, 14, 16, 18, 20], models: ['claude-opus-5-5', 'claude-sonnet-5-5'], modelName: (id) => ({ 'claude-opus-5-5': 'Opus 5.5' })[id] || id, maxInstructions: 4000, log, write, changed: (ev) => events.push(ev) };
    return { app, project, events, log, read, write, deps };
  };

  // ---- the browser's own safe keys
  {
    const t = make();
    const out = await prefs.runTool({ action: 'set', key: 'theme', value: 'Dark' }, t.deps);
    check('set theme: saved, normalised to lower case', t.app.theme === 'dark', t.app.theme);
    check('...said back to the AI with the old and new value', /Theme: Match the system → Dark/.test(out), out);
    check('...and to the chat with an Undo token', t.events.length === 1 && t.events[0].token === 't1' && t.events[0].from === 'Match the system' && t.events[0].to === 'Dark', JSON.stringify(t.events));
    await prefs.runTool({ action: 'set', key: 'fontSize', value: '18' }, t.deps);
    check('set fontSize: a size the settings offer', t.app.fontSize === 18);
    let err = '';
    try { await prefs.runTool({ action: 'set', key: 'fontSize', value: 17 }, t.deps); } catch (e) { err = e.message; }
    check('...one they don’t is refused, nothing saved', /isn’t a value/.test(err) && t.app.fontSize === 18, err);
    err = '';
    try { await prefs.runTool({ action: 'set', key: 'accentColor', value: 'url(javascript:1)' }, t.deps); } catch (e) { err = e.message; }
    check('accentColor: a preset or #rrggbb only', /isn’t a value/.test(err) && t.app.accentColor === 'blue', err);
    await prefs.runTool({ action: 'set', key: 'accentColor', value: '#1A2b3c' }, t.deps);
    check('...#rrggbb accepted (lower case)', t.app.accentColor === '#1a2b3c');
    await prefs.runTool({ action: 'set', key: 'reduceMotion', value: 'on' }, t.deps);
    check('a switch takes on/off/true/false', t.app.reduceMotion === true);
    err = '';
    try { await prefs.runTool({ action: 'set', key: 'theme', value: 'dark' }, t.deps); } catch (e) { err = e.message; }
    check('the value it has already: said so, not logged again', /already/.test(err) && t.events.length === 4, `${err} ${t.events.length}`);
  }

  // ---- what stays the user's
  {
    const t = make();
    for (const key of ['permissionMode', 'bypassPermissions', 'allowedHosts', 'project.allowedHosts', 'project.permissionMode', 'httpsOnly', 'blockThirdPartyCookies', 'passkeys', 'aiMemory', 'downloadDir', 'safeBrowsing', 'fingerprintProtection', 'adblock', 'apiKey', 'proxy']) {
      let err = '';
      try { await prefs.runTool({ action: 'set', key, value: key === 'permissionMode' ? 'bypass' : true }, t.deps); } catch (e) { err = e.message; }
      check(`${key}: refused`, Boolean(err) && t.app.permissionMode === 'ask' && t.events.length === 0, err);
    }
    let err = '';
    try { await prefs.runTool({ action: 'set', key: 'bypassPermissions', value: true }, t.deps); } catch (e) { err = e.message; }
    check('...a security or permission key says it is the user’s and where (Settings)', /user’s to change/.test(err) && /Settings/.test(err), err);
    check('the safe lists hold no security, privacy or permission key', ![...Object.keys(prefs.APP), ...Object.keys(prefs.PROJECT)].some((k) => /permission|bypass|host|secur|privacy|cookie|pass|https|memory|download|key|token|proxy|block/i.test(k)), Object.keys(prefs.APP).join(','));
    const list = await prefs.runTool({ action: 'list' }, t.deps);
    check('list: every key with its value, and that the rest is the user’s', /theme: Match the system/.test(list) && /project\.model: My usual model/.test(list) && /permissions, sites, privacy, security/.test(list), list);
  }

  // ---- the project's keys
  {
    const t = make();
    await prefs.runTool({ action: 'set', key: 'project.model', value: 'claude-opus-5-5' }, t.deps);
    check('project.model: a model from the list, shown by its name', t.project.defaults.model === 'claude-opus-5-5' && t.events[0].to === 'Opus 5.5', JSON.stringify(t.events[0]));
    let err = '';
    try { await prefs.runTool({ action: 'set', key: 'project.model', value: 'gpt-made-up' }, t.deps); } catch (e) { err = e.message; }
    check('...not one the picker doesn’t have', /isn’t a value/.test(err) && t.project.defaults.model === 'claude-opus-5-5', err);
    await prefs.runTool({ action: 'set', key: 'planFirst', value: true }, t.deps);
    check('a project key works without the prefix too (planFirst)', t.project.defaults.plan === true);
    await prefs.runTool({ action: 'set', key: 'project.description', value: '  Finish the\u0007 thesis by May  ' }, t.deps);
    check('project.description: control characters out, trimmed', t.project.description === 'Finish the thesis by May', JSON.stringify(t.project.description));
    const n = make({ inProject: false });
    err = '';
    try { await prefs.runTool({ action: 'set', key: 'project.planFirst', value: true }, n.deps); } catch (e) { err = e.message; }
    check('outside a project: project keys refused', /not in a project/.test(err), err);
  }

  // ---- notes in the instructions
  {
    const t = make();
    await prefs.runTool({ action: 'set', key: 'project.note', value: 'Cite in APA 7.' }, t.deps);
    check('a note goes under its own heading after the user’s instructions', t.project.instructions === `Write in my voice.\n\n${prefs.NOTES_HEAD}\n- Cite in APA 7.`, JSON.stringify(t.project.instructions));
    await prefs.runTool({ action: 'set', key: 'project.note', value: 'I am a second-year ME student.' }, t.deps);
    check('...the next one under the same heading', prefs.notesOf(t.project.instructions).length === 2 && t.project.instructions.split(prefs.NOTES_HEAD).length === 2);
    let err = '';
    try { await prefs.runTool({ action: 'set', key: 'project.note', value: 'cite in apa 7.' }, t.deps); } catch (e) { err = e.message; }
    check('...the same note twice: said so', /there already/.test(err), err);
    // the user edits their own text since; Undo still takes just the note out
    t.project.instructions = t.project.instructions.replace('Write in my voice.', 'Write in my voice. Short answers.');
    const r = await prefs.undo(t.events[0].token, t);
    check('Undo of a note: just that line out, the user’s edit kept', r === 'undone' && !/APA/.test(t.project.instructions) && /Short answers/.test(t.project.instructions) && /second-year/.test(t.project.instructions), `${r} ${JSON.stringify(t.project.instructions)}`);
    check('...once only', (await prefs.undo(t.events[0].token, t)) === 'gone');
    await prefs.runTool({ action: 'set', key: 'project.note', value: 'I am a second-year ME student.', remove: true }, t.deps);
    check('remove: true takes a note out, and the heading once it is empty', t.project.instructions === 'Write in my voice. Short answers.', JSON.stringify(t.project.instructions));
    await prefs.undo(t.events[2].token, t);
    check('...and its Undo puts it back', /second-year/.test(t.project.instructions));
    const long = make();
    long.deps.maxInstructions = 30;
    err = '';
    try { await prefs.runTool({ action: 'set', key: 'project.note', value: 'A note that does not fit at all' }, long.deps); } catch (e) { err = e.message; }
    check('a note that would overfill the instructions: refused', /full/.test(err) && long.project.instructions === 'Write in my voice.', err);
  }

  // ---- Undo and the log
  {
    const t = make();
    await prefs.runTool({ action: 'set', key: 'theme', value: 'dark' }, t.deps);
    await prefs.runTool({ action: 'set', key: 'project.planFirst', value: true }, t.deps);
    check('the log lists a project’s changes, newest first; the browser’s only when asked', t.log.list({ projectId: 'p1' }).length === 1 && t.log.list({ projectId: 'p1', app: true }).map((e) => e.key).join() === 'planFirst,theme' && t.log.list({ projectId: 'other' }).length === 0);
    t.app.theme = 'light'; // the user changed it again since
    check('Undo after the user changed it since: left alone', (await prefs.undo(t.events[0].token, t)) === 'changed' && t.app.theme === 'light');
    check('Undo of the project change: the old value back, marked undone', (await prefs.undo(t.events[1].token, t)) === 'undone' && t.project.defaults.plan === false && t.log.list({ projectId: 'p1' })[0].undone === true);
    check('an unknown token: nothing', (await prefs.undo('nope', t)) === 'gone');
    const small = prefs.createChangeLog({ max: 2 });
    for (let i = 0; i < 4; i++) small.record({ scope: 'app', key: 'theme', label: 'Theme', from: 'a', to: 'b', fromText: 'a', toText: 'b' });
    check('the log keeps the newest few only', small.list({ app: true }).length === 2);
  }

  // ---- step labels
  check('step labels say what changes', prefs.stepLabel({ action: 'set', key: 'theme' }) === 'Changing theme' && /Noting for this project: Cite/.test(prefs.stepLabel({ action: 'set', key: 'project.note', value: 'Cite in APA' })));

  // ---- the agent's side: offered only in the sidebar's own chats, gated like a memory save, and the chat's Undo row
  {
    const agent = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ai', 'agent.js'), 'utf8');
    check('agent: the tool is defined in agent.js (ai/preferences.js stays out of startup)', /const PREFERENCES_TOOL = \{/.test(agent) && !/^const prefsLib = require\('\.\/preferences'\)/m.test(agent) && /require\('\.\/preferences'\)/.test(agent));
    check('agent: never offered to an outside agent, a temporary chat or a run with nobody to ask', /preferencesOffered\(messages\)/.test(agent) && /async allowPreferences\(/.test(agent) && /if \(external\) throw new Error\('Unknown tool: preferences'\)/.test(agent));
    check('agent: once the chat read outside content, a card shows the change first (no Always)', /allowPreferences[\s\S]{0,900}tainted[\s\S]{0,600}noAlways: true/.test(agent));
    const core = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'chat-core.js'), 'utf8');
    check('chat: a change is said in the chat with Undo', /case 'preference':/.test(core) && /preferences\.undo\(event\.token\)/.test(core));
  }

  console.log(failures ? `\n${failures} failed` : '\nAll AI preference checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
