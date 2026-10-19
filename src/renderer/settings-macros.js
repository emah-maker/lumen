// Settings → Macros: the list (new, record, describe it, run, edit, duplicate, delete, import, export) and the editor
// (name, shortcut, site, steps you can add, change, reorder and delete, and a test run).
// Loaded before settings.js and called from its section table; it uses that file's h(), row() and flash().
// features/macros.js is the backend and decides what is valid; this page only edits plain data and shows its answers.
// Imported files are untrusted text: they are only ever shown in a review dialog first, in full.

const MACRO_STEP_TYPES = [
  ['open_url', 'Open a page'], ['click', 'Click'], ['type', 'Type text'], ['select', 'Choose an option'], ['key', 'Press a key'],
  ['wait', 'Wait'], ['scroll', 'Scroll'], ['tab', 'Switch or close a tab'], ['action', 'Lumen action'], ['ask_ai', 'Ask the AI'], ['pause', 'Pause for me'],
];
const MACRO_ACTIONS = [
  ['reader', 'Toggle reader mode'], ['mute', 'Mute or unmute the tab'], ['pin', 'Pin or unpin the tab'], ['group_tab', 'Put the tab in a group'],
  ['open_sidebar', 'Open the sidebar with a prompt'], ['new_chat', 'Start a new chat'], ['bookmark', 'Bookmark or unbookmark the page'],
  ['zoom_in', 'Zoom in'], ['zoom_out', 'Zoom out'], ['zoom_reset', 'Reset zoom'], ['reload', 'Reload'], ['back', 'Go back'], ['forward', 'Go forward'], ['new_tab', 'Open a new tab'],
];
const MACRO_VARIABLES = [['clipboard', 'the clipboard'], ['selection', 'the selected text'], ['url', 'the page address'], ['title', 'the page title'], ['date', 'today’s date'], ['time', 'the time']];
const MACRO_BUILTINS = MACRO_VARIABLES.map((v) => v[0]);

const macroNewStep = (type) => ({
  open_url: { type, url: 'https://', target: 'new' },
  click: { type, locator: { name: '' } },
  type: { type, locator: { name: '' }, text: '', enter: false },
  select: { type, locator: { name: '' }, option: '' },
  key: { type, key: 'Enter', modifiers: [] },
  wait: { type, mode: 'seconds', seconds: 2, timeout: 10, locator: { name: '' }, text: '' },
  scroll: { type, direction: 'down', screens: 1 },
  tab: { type, action: 'switch', which: 'next', match: '' },
  action: { type, action: 'reader', name: '', text: '' },
  ask_ai: { type, prompt: '', newChat: false },
  pause: { type, note: '' },
}[type]);

async function buildMacros(card) {
  const K = window.lumenSettings.macros;
  const say = (key, english, vars) => tr(`macros.settings.${key}`, english, vars);
  let macros = await K.list();
  let editing = null; // the editor's working copy
  let activeRun = null;

  const list = h('div', { class: 'macros-list', id: 'macros-list' });
  const note = h('span', { class: 'note', id: 'macros-status', role: 'status' });
  const editor = h('div', { class: 'macros-editor', id: 'macros-editor', hidden: true });
  const errText = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const chordText = (chord) => String(chord || '').split('+').map((p) => ({ mod: /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl', ctrl: 'Ctrl', alt: /Mac/i.test(navigator.platform) ? '⌥' : 'Alt', shift: /Mac/i.test(navigator.platform) ? '⇧' : 'Shift' }[p] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))).join(/Mac/i.test(navigator.platform) ? '' : '+');

  // Which {{names}} a draft asks the user for at run time (the built-in ones are filled in by Lumen).
  const variablesOf = (m) => {
    const seen = [];
    for (const s of m.steps) for (const f of [s.url, s.text, s.option, s.prompt, s.match, s.name]) for (const x of String(f || '').matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g)) if (!MACRO_BUILTINS.includes(x[1]) && !seen.includes(x[1])) seen.push(x[1]);
    return seen;
  };
  const describe = (s) => {
    const loc = (l) => (l?.name ? `“${l.name}”` : l?.text ? `“${l.text}”` : l?.css || l?.testid || '…');
    switch (s.type) {
      case 'open_url': return say('d.open_url', 'Open {url}', { url: s.url });
      case 'click': return say('d.click', 'Click {el}', { el: loc(s.locator) });
      case 'type': return say('d.type', 'Type into {el}', { el: loc(s.locator) });
      case 'select': return say('d.select', 'Choose “{o}” in {el}', { o: s.option, el: loc(s.locator) });
      case 'key': return say('d.key', 'Press {k}', { k: [...(s.modifiers || []), s.key].join('+') });
      case 'wait': return s.mode === 'seconds' ? say('d.wait', 'Wait {n} s', { n: s.seconds }) : say(`d.wait.${s.mode}`, s.mode === 'load' ? 'Wait for the page to load' : 'Wait for something', {});
      case 'scroll': return say('d.scroll', 'Scroll {d}', { d: s.direction });
      case 'tab': return say('d.tab', '{a} a tab', { a: s.action === 'close' ? 'Close' : 'Switch to' });
      case 'action': return MACRO_ACTIONS.find((a) => a[0] === s.action)?.[1] || s.action;
      case 'ask_ai': return say('d.ask_ai', 'Ask the AI');
      case 'pause': return say('d.pause', 'Pause: {n}', { n: s.note || '' });
      default: return s.type;
    }
  };

  // ---------- the list ----------
  function render() {
    list.replaceChildren(...macros.map((m) => {
      const run = h('button', { text: say('run', 'Run'), 'aria-label': say('runNamed', 'Run {name}', { name: m.name }), onclick: () => testRun(m, {}, null) });
      const edit = h('button', { text: say('edit', 'Edit'), 'aria-label': say('editNamed', 'Edit {name}', { name: m.name }), onclick: () => openEditor(m) });
      const dup = h('button', { text: say('duplicate', 'Duplicate'), onclick: () => openEditor({ ...m, id: undefined, name: `${m.name} copy`.slice(0, 60), shortcut: '' }) });
      const del = h('button', { class: 'danger', text: say('delete', 'Delete'), 'aria-label': say('deleteNamed', 'Delete {name}', { name: m.name }) });
      del.onclick = async () => {
        if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = say('deleteSure', 'Really delete?'); setTimeout(() => { del.dataset.sure = ''; del.textContent = say('delete', 'Delete'); }, 4000); return; }
        macros = (await K.remove(m.id)).macros;
        render();
      };
      const vars = variablesOf(m);
      return h('div', { class: 'macro-row', 'data-macro': m.name },
        h('div', { class: 'macro-text' },
          h('span', { class: 'macro-title' }, m.name,
            m.shortcut ? h('span', { class: 'macro-chip', text: chordText(m.shortcut) }) : null,
            m.site ? h('span', { class: 'macro-chip', text: say('onlyOn', 'only on {site}', { site: m.site }) }) : null,
            vars.length ? h('span', { class: 'macro-chip', text: say('asks', 'asks: {v}', { v: vars.join(', ') }) }) : null),
          h('span', { class: 'note', text: m.description || (m.steps.length === 1 ? say('step1', '1 step') : say('steps', '{n} steps', { n: m.steps.length })) })),
        h('div', { class: 'macro-actions' }, run, edit, dup, del));
    }));
    if (!macros.length) list.append(h('p', { class: 'note macros-empty', text: say('empty', 'No macros yet. Record one, describe one, or add steps by hand.') }));
  }

  // ---------- running (a test run, from the list or the editor) ----------
  async function testRun(macro, values, out) {
    const say2 = (text, cls = 'ok') => flash(out || note, text, cls);
    say2(say('running', 'Running…'), 'ok');
    const request = macro.id && !editing ? { id: macro.id, values, source: 'settings' } : { macro, values, source: 'settings' };
    const r = await K.run(request).catch((err) => ({ ok: false, message: errText(err) }));
    if (r.asking) { say2(say('askingSidebar', 'The sidebar is asking for the values.'), 'ok'); return; }
    if (r.ok) say2(say('ranOk', 'Done.'), 'ok'); else say2(r.message || say('ranFailed', 'It did not finish.'), 'err');
  }
  K.onProgress((e) => {
    if (!activeRun || !e) return;
    if (e.phase === 'step') flash(activeRun, say('stepOf', 'Step {n} of {total}: {label}', { n: e.index, total: e.total, label: e.label }), 'ok');
  });

  // ---------- the editor ----------
  function openEditor(m) {
    const draft = JSON.parse(JSON.stringify({ id: m?.id, name: m?.name || '', description: m?.description || '', shortcut: m?.shortcut || '', site: m?.site || '', steps: m?.steps?.length ? m.steps : [macroNewStep('open_url')] }));
    editing = draft;
    const field = (id, label, control, hint) => h('label', { class: 'macros-field', for: id }, h('span', { class: 'macros-label', text: label }), control, hint ? h('span', { class: 'note', text: hint }) : null);
    const name = h('input', { type: 'text', id: 'macro-name', value: draft.name, maxlength: 60, autocomplete: 'off', placeholder: say('namePlaceholder', 'Search my order') });
    const description = h('input', { type: 'text', id: 'macro-description', value: draft.description, maxlength: 200, placeholder: say('descriptionHint', 'What it does, in a line (optional)') });
    const site = h('input', { type: 'text', id: 'macro-site', value: draft.site, maxlength: 80, autocomplete: 'off', spellcheck: 'false', placeholder: 'example.com' });
    const shortcut = h('input', { type: 'text', id: 'macro-shortcut', value: draft.shortcut ? chordText(draft.shortcut) : '', readonly: true, placeholder: say('shortcutPlaceholder', 'Click, then press the keys'), autocomplete: 'off' });
    const shortcutNote = h('span', { class: 'note', id: 'macro-shortcut-note', role: 'status' });
    const clearShortcut = h('button', { type: 'button', text: say('clear', 'Clear'), onclick: () => { draft.shortcut = ''; shortcut.value = ''; shortcutNote.textContent = ''; } });
    shortcut.addEventListener('keydown', async (e) => {
      if (e.key === 'Tab') return;
      e.preventDefault();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      if (e.key === 'Escape' || e.key === 'Backspace') { clearShortcut.click(); return; }
      const mac = /Mac/i.test(navigator.platform);
      const code = /^Key([A-Z])$/.exec(e.code) || /^Digit(\d)$/.exec(e.code);
      const key = (code ? code[1] : e.key).toLowerCase();
      const named = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', ' ': 'space' }[key] || key;
      const mods = [];
      if (mac ? e.metaKey : e.ctrlKey) mods.push('mod');
      if (mac && e.ctrlKey) mods.push('ctrl');
      if (e.altKey) mods.push('alt');
      if (e.shiftKey) mods.push('shift');
      const chord = [...mods, named].join('+');
      const r = await K.checkShortcut(chord, draft.id || null).catch((err) => ({ ok: false, error: errText(err) }));
      if (r.ok) { draft.shortcut = r.chord; shortcut.value = chordText(r.chord); flash(shortcutNote, say('shortcutOk', 'Free to use.'), 'ok'); } else { shortcut.value = chordText(chord); flash(shortcutNote, r.error, 'err'); }
    });

    const stepsBox = h('div', { class: 'macro-steps', id: 'macro-steps' });
    const varsLine = h('p', { class: 'note', id: 'macro-vars' });
    const testOut = h('span', { class: 'note', id: 'macro-test-status', role: 'status' });
    const testValues = h('div', { class: 'macro-test-values' });
    const formNote = h('span', { class: 'note', id: 'macro-error', role: 'alert' });

    const refreshVars = () => {
      const v = variablesOf(draft);
      varsLine.textContent = v.length ? say('varsAsked', 'Asked each time it runs: {v}. Also filled in for you: {{clipboard}}, {{selection}}, {{url}}, {{title}}, {{date}}, {{time}}.', { v: v.map((x) => `{{${x}}}`).join(', ') }) : say('varsNone', 'Use {{name}} in a step to ask for a value each time it runs. Also filled in for you: {{clipboard}}, {{selection}}, {{url}}, {{title}}, {{date}}, {{time}}.');
      testValues.replaceChildren(...v.map((x) => h('label', { class: 'macros-field' }, h('span', { class: 'macros-label', text: x }), h('input', { type: 'text', 'data-var': x, placeholder: x, autocomplete: 'off' }))));
    };

    // One input bound to draft data; `set` writes the value back.
    const input = (value, set, props = {}) => {
      const el = h('input', { type: 'text', value: value ?? '', autocomplete: 'off', spellcheck: 'false', ...props });
      el.addEventListener('input', () => { set(el.value); refreshVars(); });
      return el;
    };
    const area = (value, set, props = {}) => {
      const el = h('textarea', { rows: 2, spellcheck: 'true', ...props });
      el.value = value ?? '';
      el.addEventListener('input', () => { set(el.value); refreshVars(); });
      return el;
    };
    const select = (value, options, set) => {
      const el = h('select', {}, options.map(([v, label]) => h('option', { value: v, text: label })));
      el.value = value;
      el.addEventListener('change', () => { set(el.value); renderSteps(); });
      return el;
    };
    const check = (value, label, set) => {
      const box = h('input', { type: 'checkbox', checked: Boolean(value) });
      box.addEventListener('change', () => set(box.checked));
      return h('label', { class: 'macros-check' }, box, label);
    };
    const labelled = (text, control) => h('label', { class: 'macro-field-inline' }, h('span', { text }), control);
    const locatorFields = (s) => {
      s.locator ||= {};
      const l = s.locator;
      return h('div', { class: 'macro-locator' },
        labelled(say('loc.name', 'Name'), input(l.name, (v) => { l.name = v; })),
        labelled(say('loc.text', 'Visible text'), input(l.text, (v) => { l.text = v; })),
        labelled(say('loc.testid', 'Test id'), input(l.testid, (v) => { l.testid = v; })),
        labelled(say('loc.css', 'CSS selector'), input(l.css, (v) => { l.css = v; })),
        h('span', { class: 'note macro-locator-note', text: say('loc.note', 'Lumen tries the test id, then the role and name, then the text, then the CSS selector, so a page that changes a little still works.') }));
    };
    const stepBody = (s) => {
      switch (s.type) {
        case 'open_url': return [labelled(say('f.url', 'Address'), input(s.url, (v) => { s.url = v; }, { placeholder: 'https://example.com/search?q={{query}}' })), labelled(say('f.target', 'Where'), select(s.target, [['new', say('target.new', 'In a new tab')], ['current', say('target.current', 'In this tab')]], (v) => { s.target = v; }))];
        case 'click': return [locatorFields(s)];
        case 'type': return [locatorFields(s), labelled(say('f.text', 'Text'), area(s.text, (v) => { s.text = v; }, { placeholder: say('f.textHint', 'What to type. {{query}} asks each time; {{clipboard}} pastes.') })), check(s.enter, say('f.enter', 'Press Enter after'), (v) => { s.enter = v; })];
        case 'select': return [locatorFields(s), labelled(say('f.option', 'Option'), input(s.option, (v) => { s.option = v; }))];
        case 'key': return [labelled(say('f.key', 'Key'), input(s.key, (v) => { s.key = v; }, { placeholder: 'Enter' })), h('div', { class: 'macros-checks' }, ['control', 'shift', 'alt', 'meta'].map((m) => check((s.modifiers || []).includes(m), m, (on) => { s.modifiers = [...new Set([...(s.modifiers || []).filter((x) => x !== m), ...(on ? [m] : [])])]; })))];
        case 'wait': return [
          labelled(say('f.waitFor', 'Wait for'), select(s.mode, [['seconds', say('wait.seconds', 'A number of seconds')], ['element', say('wait.element', 'An element to appear')], ['load', say('wait.load', 'The page to finish loading')], ['text', say('wait.text', 'Some text to appear')]], (v) => { s.mode = v; })),
          ...(s.mode === 'seconds' ? [labelled(say('f.seconds', 'Seconds'), input(s.seconds, (v) => { s.seconds = Number(v); }, { type: 'number', min: 0.1, max: 60, step: 0.5 }))] : []),
          ...(s.mode === 'element' ? [locatorFields(s)] : []),
          ...(s.mode === 'text' ? [labelled(say('f.text', 'Text'), input(s.text, (v) => { s.text = v; }))] : []),
          ...(s.mode !== 'seconds' ? [labelled(say('f.timeout', 'Give up after (seconds)'), input(s.timeout, (v) => { s.timeout = Number(v); }, { type: 'number', min: 1, max: 60 }))] : []),
        ];
        case 'scroll': return [labelled(say('f.direction', 'Direction'), select(s.direction, [['down', say('dir.down', 'Down')], ['up', say('dir.up', 'Up')]], (v) => { s.direction = v; })), labelled(say('f.screens', 'Screens'), input(s.screens, (v) => { s.screens = Number(v); }, { type: 'number', min: 0.25, max: 10, step: 0.25 }))];
        case 'tab': return [labelled(say('f.tabAction', 'Do'), select(s.action, [['switch', say('tab.switch', 'Switch to')], ['close', say('tab.close', 'Close')]], (v) => { s.action = v; })), labelled(say('f.which', 'Which tab'), select(s.which, [['next', say('tab.next', 'The next tab')], ['previous', say('tab.previous', 'The previous tab')], ['first', say('tab.first', 'The first tab')], ['last', say('tab.last', 'The last tab')], ['match', say('tab.match', 'One matching…')]], (v) => { s.which = v; })), ...(s.which === 'match' ? [labelled(say('f.match', 'Part of its title or address'), input(s.match, (v) => { s.match = v; }))] : [])];
        case 'action': return [labelled(say('f.action', 'Do'), select(s.action, MACRO_ACTIONS.map(([v, label]) => [v, say(`action.${v}`, label)]), (v) => { s.action = v; })), ...(s.action === 'group_tab' ? [labelled(say('f.group', 'Group name'), input(s.name, (v) => { s.name = v; }))] : []), ...(s.action === 'open_sidebar' ? [labelled(say('f.sidebarText', 'Prompt to put in the box'), area(s.text, (v) => { s.text = v; }))] : [])];
        case 'ask_ai': return [labelled(say('f.prompt', 'Prompt'), area(s.prompt, (v) => { s.prompt = v; }, { rows: 3, placeholder: say('f.promptHint', 'Sent to the sidebar AI. {{selection}} and {{url}} put the page in.') })), check(s.newChat, say('f.newChat', 'In a new chat'), (v) => { s.newChat = v; })];
        case 'pause': return [labelled(say('f.note', 'What you need to do'), input(s.note, (v) => { s.note = v; }, { placeholder: say('f.noteHint', 'Sign in, then press Continue') }))];
        default: return [];
      }
    };
    function renderSteps() {
      stepsBox.replaceChildren(...draft.steps.map((s, i) => {
        const move = (by) => { const j = i + by; if (j < 0 || j >= draft.steps.length) return; [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]]; renderSteps(); };
        const typeSel = h('select', { 'aria-label': say('stepType', 'Step {n} type', { n: i + 1 }), class: 'macro-step-type' }, MACRO_STEP_TYPES.map(([v, label]) => h('option', { value: v, text: say(`type.${v}`, label) })));
        typeSel.value = s.type;
        typeSel.addEventListener('change', () => { draft.steps[i] = macroNewStep(typeSel.value); renderSteps(); });
        const masked = s.type === 'pause' && s.masked;
        return h('div', { class: `macro-step${masked ? ' masked' : ''}`, 'data-step': i + 1, 'data-type': s.type },
          h('div', { class: 'macro-step-head' },
            h('span', { class: 'macro-step-n', text: String(i + 1) }), typeSel,
            h('span', { class: 'macro-step-sum note', text: describe(s) }),
            h('span', { class: 'macro-step-btns' },
              h('button', { type: 'button', text: '↑', title: say('moveUp', 'Move up'), 'aria-label': say('moveUpN', 'Move step {n} up', { n: i + 1 }), disabled: i === 0, onclick: () => move(-1) }),
              h('button', { type: 'button', text: '↓', title: say('moveDown', 'Move down'), 'aria-label': say('moveDownN', 'Move step {n} down', { n: i + 1 }), disabled: i === draft.steps.length - 1, onclick: () => move(1) }),
              h('button', { type: 'button', class: 'danger', text: '×', title: say('removeStep', 'Remove this step'), 'aria-label': say('removeStepN', 'Remove step {n}', { n: i + 1 }), onclick: () => { draft.steps.splice(i, 1); renderSteps(); } }))),
          masked ? h('p', { class: 'note', text: say('maskedNote', 'You typed into a password or payment field while recording. Lumen did not keep what you typed; it will wait here for you.') }) : null,
          h('div', { class: 'macro-step-body' }, stepBody(s)));
      }));
      refreshVars();
    }
    const addType = h('select', { id: 'macro-add-type', 'aria-label': say('addStepType', 'Type of step to add') }, MACRO_STEP_TYPES.map(([v, label]) => h('option', { value: v, text: say(`type.${v}`, label) })));
    const addBtn = h('button', { type: 'button', id: 'macro-add-step', text: say('addStep', 'Add step'), onclick: () => { draft.steps.push(macroNewStep(addType.value)); renderSteps(); stepsBox.lastElementChild?.querySelector('input, textarea')?.focus(); } });

    const read = () => ({ ...draft, name: name.value, description: description.value, site: site.value });
    const close = () => { editing = null; activeRun = null; editor.hidden = true; editor.replaceChildren(); toolbar.hidden = false; list.hidden = false; };
    const saveBtn = h('button', {
      class: 'primary', id: 'macro-save', text: say('save', 'Save'),
      onclick: async () => {
        const r = await K.save(read()).catch((err) => ({ ok: false, error: errText(err) }));
        if (!r.ok) {
          flash(formNote, r.error, 'err');
          const at = /^Step (\d+):/.exec(r.error || '');
          for (const el of stepsBox.children) el.classList.toggle('bad', Boolean(at) && el.dataset.step === at[1]);
          if (at) stepsBox.children[Number(at[1]) - 1]?.scrollIntoView({ block: 'nearest' });
          return;
        }
        macros = r.macros;
        close();
        render();
        flash(note, say('saved', 'Saved. Run it from the ⋯ menu, with /macro {name} in the sidebar{shortcut}.', { name: r.macro.name, shortcut: r.macro.shortcut ? say('savedShortcut', ' or with {chord}', { chord: chordText(r.macro.shortcut) }) : '' }), 'ok');
      },
    });
    const testBtn = h('button', {
      type: 'button', id: 'macro-test', text: say('test', 'Test run'), title: say('testTitle', 'Runs these steps now on the web page you were last on, without saving'),
      onclick: async () => {
        activeRun = testOut;
        const values = Object.fromEntries([...testValues.querySelectorAll('input[data-var]')].map((i) => [i.dataset.var, i.value]));
        await testRun(read(), values, testOut);
        activeRun = null;
      },
    });
    editor.replaceChildren(...[
      h('h3', { class: 'macros-heading', text: m?.id ? say('editing', 'Edit macro') : say('new', 'New macro') }),
      m?.masked ? h('p', { class: 'note macros-recorded', text: say('recorded', 'Recorded {n} steps. {masked} Check them, give the macro a name, and save.', { n: draft.steps.length, masked: m.masked ? say('recordedMasked', 'Password and payment fields were not recorded: a Pause step stands in for each one.') : '' }) }) : null,
      field('macro-name', say('name', 'Name'), name),
      field('macro-description', say('description', 'Description'), description),
      h('div', { class: 'macros-two' },
        field('macro-shortcut', say('shortcut', 'Keyboard shortcut'), h('span', { class: 'macros-shortcut-field' }, shortcut, clearShortcut), null),
        field('macro-site', say('site', 'Only on this site (optional)'), site, say('siteHint', 'The macro only runs on this site and its subdomains.'))),
      shortcutNote,
      h('div', { class: 'macros-field' }, h('span', { class: 'macros-label', text: say('stepsLabel', 'Steps') }), stepsBox),
      h('div', { class: 'item macros-add' }, addType, addBtn),
      varsLine,
      h('div', { class: 'macros-field' }, h('span', { class: 'macros-label', text: say('testLabel', 'Try it') }), testValues, h('div', { class: 'item' }, testBtn, testOut)),
      h('div', { class: 'item' }, saveBtn, h('button', { text: say('cancel', 'Cancel'), onclick: close }), formNote)].filter(Boolean));
    toolbar.hidden = true;
    list.hidden = true;
    editor.hidden = false;
    renderSteps();
    name.focus();
    editor.scrollIntoView({ block: 'nearest' });
  }

  // ---------- describe it: the AI drafts, you review ----------
  const describeBox = h('div', { class: 'macros-describe', id: 'macros-describe', hidden: true });
  function openDescribe() {
    const text = h('textarea', { id: 'macros-describe-text', rows: 3, placeholder: say('describePlaceholder', 'Search Amazon for {{item}} and sort by price, low to high') });
    const out = h('span', { class: 'note', role: 'status', id: 'macros-describe-status' });
    const go = h('button', { class: 'primary', id: 'macros-describe-go', text: say('describeGo', 'Draft the steps') });
    go.onclick = async () => {
      go.disabled = true;
      flash(out, say('describeWorking', 'Asking the AI for a draft…'), 'ok');
      const r = await K.describe(text.value).catch((err) => ({ ok: false, error: errText(err) }));
      go.disabled = false;
      if (!r.ok) { flash(out, r.error, 'err'); return; }
      describeBox.hidden = true;
      describeBox.replaceChildren();
      openEditor({ ...r.draft, id: undefined, masked: 0 });
      flash(note, say('describeDone', 'Draft ready. Read every step before you save: the AI only guesses at the page.'), 'ok');
    };
    describeBox.replaceChildren(h('label', { class: 'macros-field', for: 'macros-describe-text' }, h('span', { class: 'macros-label', text: say('describeLabel', 'Describe what the macro should do') }), text), h('div', { class: 'item' }, go, h('button', { text: say('cancel', 'Cancel'), onclick: () => { describeBox.hidden = true; describeBox.replaceChildren(); } }), out));
    describeBox.hidden = false;
    text.focus();
  }

  // ---------- import: a review dialog first, always ----------
  function review(result) {
    if (!result?.ok) { flash(note, result?.error || say('importFailed', 'That file could not be imported.'), 'err'); return; }
    const dlg = h('dialog', { class: 'skills-review macros-review', id: 'macros-review', 'aria-labelledby': 'macros-review-title' });
    const boxes = result.candidates.map((c, i) => {
      const box = h('input', { type: 'checkbox', checked: true, 'data-index': i, 'aria-label': say('importThis', 'Import {name}', { name: c.macro.name }) });
      return h('div', { class: 'skills-review-item' },
        h('label', { class: 'skills-check' }, box, h('strong', { text: c.macro.name }), c.renamedFrom ? h('span', { class: 'note', text: ` ${say('renamed', '(renamed: “{name}” is taken)', { name: c.renamedFrom })}` }) : null),
        c.macro.description ? h('p', { class: 'note', text: c.macro.description }) : null,
        c.shortcutCleared ? h('p', { class: 'note', text: say('shortcutCleared', 'Its keyboard shortcut was dropped: {why}', { why: c.shortcutCleared }) }) : null,
        h('pre', { class: 'code skills-review-prompt', tabindex: 0, text: c.macro.steps.map((s, n) => `${n + 1}. ${describe(s)}`).join('\n') }));
    });
    const rejects = result.rejected.map((r) => h('p', { class: 'err skills-rejected', text: say('rejected', 'Not imported: {name} {reason}', { name: r.name ? `“${r.name}”:` : `#${r.index + 1}:`, reason: r.reason }) }));
    const importBtn = h('button', {
      class: 'primary', id: 'macros-review-import', text: say('importSelected', 'Import selected'), disabled: boxes.length === 0,
      onclick: async () => {
        const picked = boxes.map((_, i) => i).filter((i) => dlg.querySelector(`input[data-index="${i}"]`).checked);
        const r = await K.importCommit(result.token, picked).catch((err) => ({ ok: false, error: errText(err) }));
        dlg.close();
        if (r.ok) { macros = r.macros; render(); flash(note, say('imported', 'Imported {n}.', { n: r.added }), 'ok'); } else flash(note, r.error, 'err');
      },
    });
    dlg.append(
      h('h3', { id: 'macros-review-title', text: say('reviewTitle', 'Review before importing') }),
      h('p', { class: 'note', text: say('reviewNote', 'These macros come from a file. They click and type on pages when you run them, so read each list of steps. Nothing runs until you run it yourself.') }),
      ...boxes, ...rejects,
      h('div', { class: 'item' }, importBtn, h('button', { text: say('cancel', 'Cancel'), onclick: () => dlg.close() })));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // ---------- the toolbar ----------
  const toolbar = h('div', { class: 'item macros-toolbar' },
    h('button', { class: 'primary', id: 'macro-new', text: say('newMacro', 'New macro'), onclick: () => openEditor(null) }),
    h('button', { id: 'macro-record', text: say('record', 'Record…'), title: say('recordTitle', 'Do the steps once on a web page; Lumen turns them into a macro. Passwords and card fields are never recorded.'), onclick: async () => { const r = await K.recordStart().catch((err) => ({ ok: false, error: errText(err) })); flash(note, r.ok ? say('recording', 'Recording the page you were on. Do the steps, then press “Stop and review” at the top of the window.') : r.error, r.ok ? 'ok' : 'err'); } }),
    h('button', { id: 'macro-describe-open', text: say('describe', 'Describe it…'), title: say('describeTitle', 'Say what you want in a sentence; the AI drafts the steps for you to review.'), onclick: openDescribe }),
    h('button', { id: 'macros-import', text: say('import', 'Import…'), onclick: async () => { const r = await K.importPick().catch((err) => ({ ok: false, error: errText(err) })); if (!r.canceled) review(r); } }),
    h('button', { id: 'macros-export', text: say('export', 'Export all…'), onclick: async () => { const r = await K.exportAll().catch((err) => ({ ok: false, error: errText(err) })); if (r.ok) flash(note, say('exported', 'Exported {n} macros.', { n: r.count }), 'ok'); else if (!r.canceled) flash(note, r.error, 'err'); } }),
    note);

  const intro = row(say('introTitle', 'Macros'), say('intro', 'A macro is a saved list of steps: open pages, click, type, press keys, wait, scroll, run Lumen commands, ask the AI. Run one from the ⋯ menu, with its keyboard shortcut, by typing /macro in the sidebar, or let the AI run it. Passwords and card numbers are never stored. A step that submits or buys works only because you wrote it; when the AI runs a macro it asks first.'));
  intro.dataset.search += ' macros automation record replay steps shortcut script';
  card.append(intro, h('div', { class: 'skills-section macros-section' }, toolbar, describeBox, list, editor));
  render();

  K.onChanged((next) => { if (Array.isArray(next) && !editing) { macros = next; render(); } });
  // A recording, or a "Describe it" draft, opens the editor prefilled; nothing is saved until you press Save.
  const takeDraft = (draft) => { if (draft && typeof draft === 'object') openEditor({ ...draft, id: undefined }); };
  K.onDraft((draft) => { takeDraft(draft); K.takeDraft().catch(() => {}); }); // (taken: a page opened later does not get it again)
  K.takeDraft().then(takeDraft).catch(() => {});
  // "Edit macro" in the progress toast after a step failed.
  K.onEdit(async (id) => { let m = macros.find((x) => x.id === id); if (!m) { macros = await K.list(); render(); m = macros.find((x) => x.id === id); } if (m) openEditor(m); });
}
