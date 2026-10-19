// Settings → Skills: the list (search, new, edit, duplicate, delete, reset built-ins, export, import)
// and the editor with a variable cheat-sheet and a live preview (features/skills.js is the backend).
// Loaded before settings.js and called from its section table; it uses that file's h(), row() and flash().
// Imported files are untrusted text: they are only ever shown in a review dialog first, in full.
// SKILL.md (features/skill-md.js): Import SKILL.md… and Export SKILL.md, the read-only list of Claude Code skills,
// the three switches (the AI using skills on its own, Claude Code skills, offers to save and improve skills) and
// the diff dialog for "Update the skill with what changed?" (nothing changes until Accept).

const SKILL_VARIABLES = [
  ['content', 'the selected text, else the page'],
  ['page', 'the page: title, address and text'],
  ['selection', 'the text selected on the page'],
  ['clipboard', 'the clipboard'],
  ['tabs', 'tabs picked with @'],
  ['input', 'what you type after the command'],
  ['date', 'today’s date'],
  ['language', 'your language'],
];
const SKILL_MODES = [
  ['no-tools', 'Answer only: no browser actions'],
  ['chat', 'Normal chat'],
  ['agent', 'May use the browser and search (still asks first)'],
];

async function buildSkills(card) {
  const K = window.lumenSettings.skills;
  const say = (key, english, vars) => tr(`skills.settings.${key}`, english, vars);
  let skills = await K.list();
  let filter = '';

  const list = h('div', { class: 'skills-list', id: 'skills-list' });
  const note = h('span', { class: 'note', id: 'skills-status', role: 'status' });
  const search = h('input', { type: 'search', id: 'skills-search', placeholder: say('search', 'Search skills'), 'aria-label': say('search', 'Search skills'), autocomplete: 'off', oninput: (e) => { filter = e.target.value.trim().toLowerCase(); render(); } });
  const editor = h('div', { class: 'skills-editor', id: 'skills-editor', hidden: true });

  const modeText = (m) => say(`mode.${m}`, SKILL_MODES.find((x) => x[0] === m)?.[1] || m);
  const errText = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const matches = (s) => !filter || filter.split(/\s+/).every((w) => `${s.title} ${s.name} ${s.description} ${s.prompt}`.toLowerCase().includes(w));

  function render() {
    const shown = skills.filter(matches);
    list.replaceChildren(...shown.map((s) => {
      const edit = h('button', { text: say('edit', 'Edit'), 'aria-label': say('editNamed', 'Edit {title}', { title: s.title }), onclick: () => openEditor(s) });
      const dup = h('button', { text: say('duplicate', 'Duplicate'), 'aria-label': say('duplicateNamed', 'Duplicate {title}', { title: s.title }), onclick: () => openEditor({ ...s, id: undefined, name: `${s.name}-copy`.slice(0, 32), title: `${s.title} copy`.slice(0, 60), source: 'user' }) });
      const exportMd = h('button', { text: say('exportMd', 'Export SKILL.md…'), title: say('exportMdTitle', 'Save this skill as a SKILL.md folder for Claude Code and other agents'), 'aria-label': say('exportMdNamed', 'Export {title} as SKILL.md', { title: s.title }), onclick: async () => { const r = await K.exportMd(s.id).catch((err) => ({ ok: false, error: errText(err) })); if (r.ok) flash(note, say('exportedMd', 'Saved {path}', { path: r.filePath }), 'ok'); else if (!r.canceled) flash(note, r.error, 'err'); } });
      const reset = s.source === 'builtin' ? h('button', { text: say('reset', 'Reset'), title: say('resetOne', 'Put this built-in skill back to its original text'), onclick: async () => { const r = await K.reset(s.id); skills = r.skills; render(); flash(note, say('resetDone', 'Reset.'), 'ok'); } }) : null;
      const del = h('button', { class: 'danger', text: say('delete', 'Delete'), 'aria-label': say('deleteNamed', 'Delete {title}', { title: s.title }), onclick: async () => { if (!confirm(say('confirmDelete', 'Delete the skill “{title}”?', { title: s.title }))) return; skills = (await K.remove(s.id)).skills; render(); } });
      const line = h('div', { class: 'skill-row', 'data-skill': s.name },
        h('div', { class: 'skill-text' },
          h('span', { class: 'skill-title' }, s.icon ? `${s.icon} ` : '', s.title, h('span', { class: 'skill-slash', text: ` /${s.name}` }), s.source !== 'user' ? h('span', { class: 'skill-source', text: s.source === 'builtin' ? say('builtin', 'built-in') : say('imported', 'imported') }) : null, s.autoUse ? h('span', { class: 'skill-source', text: say('autoUseBadge', 'AI can use') }) : null),
          s.description ? h('span', { class: 'note', text: s.description }) : null),
        h('div', { class: 'skill-actions' }, edit, dup, exportMd, reset, del));
      return line;
    }));
    if (!shown.length) list.append(h('p', { class: 'note skills-empty', text: skills.length ? say('none', 'No skill matches.') : say('empty', 'No skills yet.') }));
  }

  // ---------- the editor ----------
  function openEditor(s) {
    const draft = { id: s?.id, name: s?.name || '', title: s?.title || '', description: s?.description || '', prompt: s?.prompt || '', inputs: s?.inputs || [], inputRequired: Boolean(s?.inputRequired), mode: s?.mode || 'no-tools', model: s?.model || '', icon: s?.icon || '', autoUse: Boolean(s?.autoUse) };
    const field = (id, label, control) => h('label', { class: 'skills-field', for: id }, h('span', { class: 'skills-label', text: label }), control);
    const name = h('input', { type: 'text', id: 'skill-name', value: draft.name, maxlength: 32, spellcheck: 'false', autocomplete: 'off', placeholder: 'summarize' });
    const title = h('input', { type: 'text', id: 'skill-title', value: draft.title, maxlength: 60, placeholder: 'Summarize' });
    const description = h('input', { type: 'text', id: 'skill-description', value: draft.description, maxlength: 200, placeholder: say('descriptionHint', 'What it does, in a line') });
    const prompt = h('textarea', { id: 'skill-prompt', rows: 9, maxlength: 8000, spellcheck: 'true', 'aria-describedby': 'skill-vars' });
    prompt.value = draft.prompt;
    const previewBox = h('pre', { class: 'code skill-preview', id: 'skill-preview', 'aria-live': 'polite' });
    const counter = h('span', { class: 'note', id: 'skill-count' });
    const mode = h('select', { id: 'skill-mode' }, SKILL_MODES.map(([value, text]) => h('option', { value, text: say(`mode.${value}`, text) })));
    mode.value = draft.mode;
    const model = h('select', { id: 'skill-model' }, h('option', { value: '', text: say('modelDefault', 'The model you are chatting with') }));
    window.lumenSettings.ai.get().then((ai) => {
      for (const m of ai.models.filter((x) => !x.id.endsWith(':__more'))) model.append(h('option', { value: m.id, text: window.usageBars ? window.usageBars.annotate(m.group ? `${m.group} · ${m.label}` : m.label, m.id) : (m.group ? `${m.group} · ${m.label}` : m.label) }));
      model.value = draft.model;
      if (model.value !== draft.model && draft.model) { model.append(h('option', { value: draft.model, text: draft.model })); model.value = draft.model; }
    }).catch(() => {});
    const required = h('input', { type: 'checkbox', id: 'skill-required', checked: draft.inputRequired });
    const autoUse = h('input', { type: 'checkbox', id: 'skill-auto-use', checked: draft.autoUse });
    const contexts = ['page', 'selection', 'tabs', 'clipboard'].map((c) => {
      const box = h('input', { type: 'checkbox', 'data-context': c, id: `skill-ctx-${c}`, checked: draft.inputs.includes(c) });
      const names = { page: say('ctx.page', 'Page text'), selection: say('ctx.selection', 'Selected text'), tabs: say('ctx.tabs', 'Picked tabs (@)'), clipboard: say('ctx.clipboard', 'Clipboard') };
      return h('label', { class: 'skills-check' }, box, names[c]);
    });
    const cheat = h('div', { class: 'skills-vars', id: 'skill-vars' }, h('span', { class: 'note', text: say('varsTitle', 'Variables, filled in when the skill runs (click to insert):') }),
      SKILL_VARIABLES.map(([v, what]) => h('button', {
        type: 'button', class: 'skills-var', text: `{{${v}}}`, title: what,
        onclick: () => { const at = prompt.selectionStart ?? prompt.value.length; prompt.setRangeText(`{{${v}}}`, at, prompt.selectionEnd ?? at, 'end'); prompt.focus(); update(); },
      })));
    const formNote = h('span', { class: 'note', id: 'skill-error', role: 'alert' });

    const read = () => ({
      ...draft, name: name.value, title: title.value, description: description.value, prompt: prompt.value, mode: mode.value, model: model.value, inputRequired: required.checked, autoUse: autoUse.checked,
      inputs: contexts.map((l) => l.firstChild).filter((b) => b.checked).map((b) => b.dataset.context),
    });
    let timer = null;
    function update() {
      counter.textContent = say('count', '{n} of 8000 characters', { n: prompt.value.length });
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const r = await K.preview(read()).catch(() => null);
        previewBox.textContent = r?.ok ? r.prompt : r?.error || '';
      }, 120);
    }
    for (const el of [name, title, description, prompt, mode, required, ...contexts.map((l) => l.firstChild)]) el.addEventListener('input', update);

    const close = () => { clearTimeout(timer); editor.hidden = true; editor.replaceChildren(); toolbar.hidden = false; list.hidden = false; };
    const saveBtn = h('button', {
      class: 'primary', id: 'skill-save', text: say('save', 'Save'),
      onclick: async () => {
        const r = await K.save(read()).catch((err) => ({ ok: false, error: errText(err) }));
        if (!r.ok) { flash(formNote, r.error, 'err'); return; }
        skills = r.skills;
        close();
        render();
        flash(note, say('saved', 'Saved. Type /{name} in the chat to use it.', { name: r.skill.name }), 'ok');
      },
    });
    editor.replaceChildren(
      h('h3', { class: 'skills-heading', text: s?.id ? say('editing', 'Edit skill') : say('new', 'New skill') }),
      field('skill-name', say('name', 'Command'), h('span', { class: 'skills-slash-field' }, h('span', { class: 'skills-slash', text: '/' }), name)),
      field('skill-title', say('title', 'Title'), title),
      field('skill-description', say('description', 'Description'), description),
      field('skill-prompt', say('prompt', 'Prompt'), prompt),
      h('div', { class: 'skills-meta' }, counter),
      cheat,
      h('div', { class: 'skills-field' }, h('span', { class: 'skills-label', text: say('context', 'Also include') }), h('div', { class: 'skills-checks' }, contexts,
        h('label', { class: 'skills-check' }, required, say('inputRequired', 'It needs text after the command')))),
      h('div', { class: 'skills-field' }, h('label', { class: 'skills-check' }, autoUse, say('autoUse', 'AI can use this on its own')),
        h('span', { class: 'note', text: say('autoUseNote', 'The AI sees its name and description in every chat and loads it when your request matches, without a /command. It still asks before acting on a site.') })),
      h('div', { class: 'skills-two' }, field('skill-mode', say('mode', 'What it may do'), mode), field('skill-model', say('model', 'Model (optional)'), model)),
      h('div', { class: 'skills-field' }, h('span', { class: 'skills-label', text: say('preview', 'Preview, with sample values') }), previewBox),
      h('div', { class: 'item' }, saveBtn, h('button', { text: say('cancel', 'Cancel'), onclick: close }), formNote));
    toolbar.hidden = true;
    list.hidden = true;
    editor.hidden = false;
    update();
    (s?.id || s?.prompt ? title : name).focus();
    editor.scrollIntoView({ block: 'nearest' });
  }

  // ---------- import: a review dialog first, always ----------
  function review(result) {
    if (!result?.ok) { flash(note, result?.error || say('importFailed', 'That file could not be imported.'), 'err'); return; }
    const dlg = h('dialog', { class: 'skills-review', id: 'skills-review', 'aria-labelledby': 'skills-review-title' });
    const boxes = result.candidates.map((c, i) => {
      const box = h('input', { type: 'checkbox', checked: true, 'data-index': i, 'aria-label': say('importThis', 'Import {title}', { title: c.skill.title }) });
      return h('div', { class: 'skills-review-item' },
        h('label', { class: 'skills-check' }, box, h('strong', { text: c.skill.title }), h('span', { class: 'skill-slash', text: ` /${c.skill.name}` }), c.renamedFrom ? h('span', { class: 'note', text: ` ${say('renamed', '(renamed: /{name} is taken)', { name: c.renamedFrom })}` }) : null),
        c.skill.description ? h('p', { class: 'note', text: c.skill.description }) : null,
        h('p', { class: 'note', text: say('reviewMode', 'May do: {mode}. Reads: {inputs}.', { mode: modeText(c.skill.mode), inputs: c.skill.inputs.join(', ') || say('nothing', 'nothing from the page') }) }),
        c.ignoredCount ? h('p', { class: 'note skills-ignored', text: say('ignoredFiles', 'Left out of the folder ({n} files{scripts}): {names}. Lumen skills are instructions only; nothing in a skill folder is ever run.', { n: c.ignoredCount, scripts: c.scripts ? say('ignoredScripts', ', {n} of them scripts', { n: c.scripts }) : '', names: c.ignored.slice(0, 8).join(', ') + (c.ignoredCount > 8 ? ', …' : '') }) }) : null,
        h('pre', { class: 'code skills-review-prompt', tabindex: 0, text: c.skill.prompt }));
    });
    const rejects = result.rejected.map((r) => h('p', { class: 'err skills-rejected', text: say('rejected', 'Not imported: {name} {reason}', { name: r.name ? `“${r.name}”:` : `#${r.index + 1}:`, reason: r.reason }) }));
    const importBtn = h('button', {
      class: 'primary', id: 'skills-review-import', text: say('importSelected', 'Import selected'), disabled: boxes.length === 0,
      onclick: async () => {
        const picked = boxes.map((_, i) => i).filter((i) => dlg.querySelector(`input[data-index="${i}"]`).checked);
        const r = await K.importCommit(result.token, picked).catch((err) => ({ ok: false, error: errText(err) }));
        dlg.close();
        if (r.ok) { skills = r.skills; render(); flash(note, say('imported', 'Imported {n}.', { n: r.added }), 'ok'); } else flash(note, r.error, 'err');
      },
    });
    dlg.append(
      h('h3', { id: 'skills-review-title', text: say('reviewTitle', 'Review before importing') }),
      h('p', { class: 'note', text: say('reviewNote', 'These skills come from a file. Read each prompt: it is sent to your AI when you run the skill. Nothing runs until you use it.') }),
      h('p', { class: 'note', text: say('reviewAutoUse', 'Imported skills start with “AI can use this on its own” off. Turn it on in the editor if you want it.') }),
      ...boxes, ...rejects,
      h('div', { class: 'item' }, importBtn, h('button', { text: say('cancel', 'Cancel'), onclick: () => dlg.close() })));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // ---------- the toolbar ----------
  const toolbar = h('div', { class: 'item skills-toolbar' },
    h('button', { class: 'primary', id: 'skill-new', text: say('newSkill', 'New skill'), onclick: () => openEditor(null) }),
    h('button', { id: 'skills-import', text: say('import', 'Import…'), onclick: async () => { const r = await K.importPick().catch((err) => ({ ok: false, error: errText(err) })); if (!r.canceled) review(r); } }),
    h('button', { id: 'skills-import-md', text: say('importMd', 'Import SKILL.md…'), title: say('importMdTitle', 'Pick a skill folder (Claude Code, Agent Skills) or its SKILL.md'), onclick: async () => { const r = await K.importMdPick().catch((err) => ({ ok: false, error: errText(err) })); if (!r.canceled) review(r); } }),
    h('button', { id: 'skills-export', text: say('export', 'Export all…'), onclick: async () => { const r = await K.exportAll().catch((err) => ({ ok: false, error: errText(err) })); if (r.ok) flash(note, say('exported', 'Exported {n} skills.', { n: r.count }), 'ok'); else if (!r.canceled) flash(note, r.error, 'err'); } }),
    h('button', { id: 'skills-reset', text: say('resetAll', 'Reset built-ins'), title: say('resetAllTitle', 'Put every built-in skill back to its original text, and bring back any you deleted. Your own skills are not touched.'), onclick: async () => { if (!confirm(say('confirmReset', 'Reset the built-in skills to their original text? Skills you made are not touched.'))) return; const r = await K.reset(); skills = r.skills; render(); flash(note, r.skipped.length ? say('resetSkipped', 'Reset {n}. Left alone because you made a skill with the same name: {names}.', { n: r.reset, names: r.skipped.join(', ') }) : say('resetAllDone', 'Reset {n} built-in skills.', { n: r.reset }), 'ok'); } }),
    note);

  const intro = row(say('introTitle', 'Skills'), say('intro', 'Saved prompts. Type / in the chat (or right-click selected text on a page → Run skill) to use one. A skill only sends a message: it cannot change what Lumen may do, and it still asks before acting on a site.'));
  intro.dataset.search += ' skills slash command prompt reusable summarize translate';
  // ---------- SKILL.md, the AI using skills on its own, and learning ----------
  const ccBox = h('div', { class: 'skills-list skills-cc', id: 'skills-cc' });
  async function renderClaudeCode() {
    const r = await K.claudeCode().catch(() => ({ on: false, skills: [] }));
    if (!r.on) { ccBox.replaceChildren(); ccBox.hidden = true; return; }
    ccBox.hidden = false;
    const rows = r.skills.map((c) => (c.error
      ? h('div', { class: 'skill-row' }, h('div', { class: 'skill-text' }, h('span', { class: 'skill-title', text: c.folder }), h('span', { class: 'note err', text: c.error })))
      : h('div', { class: 'skill-row', 'data-skill': c.name }, h('div', { class: 'skill-text' },
        h('span', { class: 'skill-title' }, c.title, h('span', { class: 'skill-slash', text: ` /${c.name}` }), h('span', { class: 'skill-source', text: say('claudeCode', 'Claude Code, read-only') })),
        h('span', { class: 'note', text: c.hidden ? say('ccHidden', 'Not used: a Lumen skill or command already has this name.') : c.description })))));
    ccBox.replaceChildren(h('p', { class: 'note', text: say('ccFolder', 'From {folder}. Edit them in Claude Code.', { folder: r.folder }) }), ...(rows.length ? rows : [h('p', { class: 'note', text: say('ccNone', 'No skills found there.') })]));
  }
  const switches = h('div', { class: 'skills-switches' },
    toggle('skillsAutoUse', say('autoUseSetting', 'Let the AI use skills on its own'), say('autoUseSettingDesc', 'Skills marked “AI can use this on its own” are listed (name and one line) in each new chat, and the AI loads one when your request matches. Off: skills run only when you type their /command. Applies from the next new chat.'), undefined, { fallback: true }),
    toggle('skillsFromClaudeCode', say('fromClaudeCode', 'Use my Claude Code skills'), say('fromClaudeCodeDesc', 'Also offer the skills in ~/.claude/skills as /commands, and to the AI on its own. Read-only: Lumen reads only each SKILL.md and never runs the scripts beside it.'), () => renderClaudeCode()),
    toggle('skillsSuggest', say('suggest', 'Offer to save and improve skills'), say('suggestDesc', 'After a task that took many steps, a card under the reply offers “Save how I did this as a skill?”. After you correct a skill’s result, it offers to update the skill and shows the change first. Nothing is saved without your click.')),
    row(say('scriptsTitle', 'Instructions only'), say('scriptsNote', 'A Lumen skill is text for the AI. Scripts and other files in a skill folder are left out when you import it and are never run.')));

  // "Update the skill with what changed?": the proposed text as a line diff, accepted or not.
  function showUpdate(u) {
    if (!u || typeof u !== 'object' || !Array.isArray(u.diff)) return;
    const dlg = h('dialog', { class: 'skills-review skills-update', id: 'skills-update', 'aria-labelledby': 'skills-update-title' });
    const lines = u.diff.map((d) => h('div', { class: `diff-line diff-${d.op === '+' ? 'add' : d.op === '-' ? 'del' : 'same'}`, text: `${d.op} ${d.text}` }));
    const accept = h('button', {
      class: 'primary', id: 'skills-update-accept', text: say('updateAccept', 'Accept the change'),
      onclick: async () => {
        const r = await K.applyUpdate(u.token).catch((err) => ({ ok: false, error: errText(err) }));
        dlg.close();
        if (r.ok) { skills = r.skills; render(); flash(note, say('updated', 'Updated /{name}.', { name: u.name }), 'ok'); } else flash(note, r.error, 'err');
      },
    });
    dlg.append(
      h('h3', { id: 'skills-update-title', text: say('updateTitle', 'Update /{name}?', { name: u.name }) }),
      u.summary ? h('p', { class: 'note', text: u.summary }) : null,
      h('pre', { class: 'code skills-diff', tabindex: 0 }, lines),
      h('div', { class: 'item' }, accept, h('button', { text: say('updateKeep', 'Keep it as it is'), onclick: () => dlg.close() })));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  card.append(intro, switches, h('div', { class: 'skills-section' }, toolbar, h('div', { class: 'skills-search' }, search), list, editor, ccBox));
  render();
  renderClaudeCode();
  window.lumenSettings.skills.onUpdate(showUpdate);
  window.lumenSettings.skills.takeUpdate().then(showUpdate).catch(() => {});

  window.lumenSettings.skills.onChanged((next) => { if (Array.isArray(next)) { skills = next; render(); } });
  // "Create a skill from this chat" opens the editor prefilled; it is never saved silently.
  const takeDraft = (draft) => { if (draft && typeof draft === 'object') openEditor({ ...draft, id: undefined, source: 'user' }); };
  window.lumenSettings.skills.onDraft(takeDraft);
  window.lumenSettings.skills.takeDraft().then(takeDraft).catch(() => {});
}
