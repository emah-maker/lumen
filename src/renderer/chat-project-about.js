// [about you] A project's About you view, in lumen://chat: what the AI knows about the user without asking again (features/project-about.js).
// It edits the project's profile, the same one Automations fill forms from ("Edit profile"): the base résumé and cover letter (files on this
// computer, never changed: tailored copies are new files), a résumé in Google Drive, résumé highlights, the profile's boxes in groups, and the
// saved answers. Each box saves when you leave it. Loaded the first time the view or the Overview's card needs it (chat-project-page.js).
// Theme tokens only (styles.css).
(() => {
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const btn = (label, run, className = '') => { const b = el('button', { type: 'button', className: `btn small ${className}`.trim(), textContent: label }); b.onclick = run; return b; };
  const link = (label, run) => { const b = el('button', { type: 'button', className: 'pjp-link', textContent: label }); b.onclick = run; return b; };

  function view(holder, { api, id, tr, onSaved = () => {} }) {
    let about = null;
    let failed = false;
    let editing = -1; // the saved answer being edited (-2: a new one)
    const say = el('p', { className: 'pab-status' });
    say.setAttribute('role', 'status');
    const root = el('div', { className: 'pab' });
    holder.replaceChildren(root);
    const card = (title, tip, ...actions) => {
      const c = el('section', { className: 'pjp-card pab-card' });
      c.append(el('div', { className: 'pjp-card-head' }, el('h2', { className: 'pjp-h', textContent: title }), el('span', { className: 'pjp-grow' }), ...actions));
      if (tip) c.append(el('p', { className: 'pjp-note', textContent: tip }));
      return c;
    };
    async function send(change, okText = tr('projectws.saved', 'Saved.')) {
      say.textContent = '';
      const out = await api.projectAbout(id, change).catch((err) => ({ ok: false, error: String(err?.message || err) }));
      if (!out || out.ok === false) { say.textContent = out?.error || tr('chatpage.project.failed', 'Could not save the project.'); return false; }
      about = out.about;
      if (out.project) onSaved(out.project);
      say.textContent = okText;
      return true;
    }
    const keep = (fn) => { const key = document.activeElement?.dataset?.key; fn(); if (key) root.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus(); };

    // the base files: résumé and cover letter on this computer, and a résumé in Drive
    function filesCard() {
      const c = card(tr('about.files', 'Résumé and cover letter'), tr('about.files.tip', 'Your own files, never changed. For each posting the AI makes a tailored copy in the project’s Tailored résumés folder and changes only the copy.'));
      const fileRow = (label, file, pick, clear) => el('div', { className: 'pab-file' },
        el('div', { className: 'pab-file-main' }, el('span', { className: 'pab-file-label', textContent: label }), el('span', { className: `pab-file-name${file ? '' : ' none'}`, textContent: file ? file.name : tr('about.files.none', 'Not chosen yet'), title: file?.path || '' })),
        btn(file ? tr('about.files.change', 'Change…') : tr('about.files.choose', 'Choose file…'), () => send({ pick }).then(() => draw()), file ? '' : 'primary'),
        ...(file ? [link(tr('projectws.remove', 'Remove'), () => send({ clear }).then(() => draw()))] : []));
      c.append(fileRow(tr('about.files.resume', 'Base résumé'), about.resume, 'resume', 'resume'), fileRow(tr('about.files.cover', 'Cover letter base'), about.cover, 'cover', 'cover'));
      // Drive
      const drive = about.resumeDrive;
      const driveRow = el('div', { className: 'pab-file' });
      if (drive) {
        driveRow.append(el('div', { className: 'pab-file-main' }, el('span', { className: 'pab-file-label', textContent: tr('about.files.drive', 'Résumé in Google Drive') }), el('span', { className: 'pab-file-name', textContent: drive.name })),
          link(tr('projectws.sources.open', 'Open'), () => window.assistant?.openLink?.(`https://drive.google.com/file/d/${drive.id}/view`)), link(tr('projectws.remove', 'Remove'), () => send({ resumeDrive: null }).then(() => draw())));
      } else {
        const url = el('input', { type: 'url', className: 'pjp-input pab-input', placeholder: tr('about.files.drive.placeholder', 'Paste a Google Drive or Docs link to your résumé') });
        url.setAttribute('aria-label', tr('about.files.drive', 'Résumé in Google Drive'));
        const go = btn(tr('projectws.sources.add.go', 'Add'), async () => { if (await send({ resumeDrive: { url: url.value } })) draw(); });
        url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); go.click(); } }); // (not while an IME is composing)
        driveRow.append(el('div', { className: 'pab-file-main' }, el('span', { className: 'pab-file-label', textContent: tr('about.files.drive', 'Résumé in Google Drive') }), el('span', { className: 'pjp-note', textContent: tr('about.files.drive.note', 'Optional. The AI reads it for facts with the Drive connector; tailored copies are made from the file on this computer.') })), url, go);
      }
      c.append(driveRow);
      return c;
    }
    function highlightsCard() {
      const c = card(tr('about.highlights', 'Résumé highlights'), tr('about.highlights.tip', 'Skills, projects and numbers in your own words. The AI may use them in applications and never adds to them.'));
      const area = el('textarea', { className: 'pjp-input pab-area', rows: 5, maxLength: 4000, value: about.highlights, placeholder: tr('about.highlights.placeholder', 'For example: SolidWorks and MATLAB; led a 4-person Formula SAE suspension redesign that cut 1.2 kg; 2 co-ops in manufacturing.') });
      area.setAttribute('aria-label', tr('about.highlights', 'Résumé highlights'));
      area.dataset.key = 'highlights';
      area.addEventListener('change', () => send({ highlights: area.value }));
      c.append(area);
      return c;
    }
    function fieldsCard() {
      const c = card(tr('about.fields', 'About you'), tr('about.fields.tip', 'The AI uses these instead of asking you again, and automations fill forms from them. Saved when you leave a box.'), link(tr('projecttpl.apps.profile', 'Edit profile'), () => api.projectApplications?.(id, 'open')));
      const grid = el('div', { className: 'pab-groups' });
      for (const g of about.groups) {
        const box = el('fieldset', { className: 'pab-group' }, el('legend', { textContent: tr(`about.group.${g.id}`, g.label) }));
        for (const f of g.fields) {
          const input = el('input', { type: 'text', className: 'pjp-input pab-input', value: f.value, maxLength: 2000 });
          input.dataset.key = `f:${f.key}`;
          input.addEventListener('change', () => send({ fields: { [f.key]: input.value } }));
          box.append(el('label', { className: 'pab-field' }, el('span', { textContent: tr(`automations.field.${f.key}`, f.label) }), input));
        }
        grid.append(box);
      }
      // [about you] demographic (EEO) questions: what the AI and automations do with gender, race or ethnicity, veteran and disability
      const demo = el('fieldset', { className: 'pab-group' }, el('legend', { textContent: tr('about.demographics', 'Demographic questions') }));
      const pick = el('select', { className: 'pjp-input pab-input' });
      pick.dataset.key = 'demographics';
      for (const [v, label] of [['saved', tr('about.demographics.saved', 'Use my saved answers')], ['decline', tr('about.demographics.decline', 'Choose “Decline to self-identify”')], ['ask', tr('about.demographics.ask', 'Ask me')]]) pick.append(el('option', { value: v, textContent: label, selected: about.demographics === v }));
      pick.addEventListener('change', () => send({ demographics: pick.value }));
      demo.append(el('label', { className: 'pab-field' }, el('span', { textContent: tr('about.demographics.label', 'Gender, race or ethnicity, veteran, disability') }), pick),
        el('p', { className: 'pjp-note', textContent: tr('about.demographics.tip', 'The AI never picks these for you. Saved answers are the ones in Saved answers below.') }));
      grid.append(demo);
      c.append(grid);
      return c;
    }
    function answersCard() {
      const c = card(tr('about.answers', 'Saved answers'), tr('about.answers.tip', 'Answers to application questions you approved (“Why this company?”, “Describe a project”). The AI adapts them instead of starting over, and automations reuse them.'), btn(tr('about.answers.add', 'Add answer'), () => { editing = -2; keep(draw); root.querySelector('[data-key="a:new:q"]')?.focus(); }));
      const list = el('ul', { className: 'pab-answers' });
      list.setAttribute('aria-label', tr('about.answers', 'Saved answers'));
      const editor = (a, idx) => {
        const q = el('input', { type: 'text', className: 'pjp-input pab-input', value: a?.question || '', maxLength: 300, placeholder: tr('about.answers.q', 'The question') });
        const ans = el('textarea', { className: 'pjp-input pab-area', rows: 4, maxLength: 2000, value: a?.answer || '', placeholder: tr('about.answers.a', 'Your answer') });
        q.dataset.key = `a:${idx < 0 ? 'new' : idx}:q`;
        q.setAttribute('aria-label', tr('about.answers.q', 'The question'));
        ans.setAttribute('aria-label', tr('about.answers.a', 'Your answer'));
        const save = btn(tr('about.save', 'Save'), async () => { if (await send({ answer: { question: q.value, answer: ans.value, ...(a ? { was: a.question } : {}) } })) { editing = -1; draw(); } }, 'primary');
        const cancel = btn(tr('chatpage.project.cancel', 'Cancel'), () => { editing = -1; draw(); });
        const li = el('li', { className: 'pab-answer editing' }, q, ans, el('div', { className: 'pjp-line' }, save, cancel));
        li.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.click(); } });
        return li;
      };
      if (editing === -2) list.append(editor(null, -1));
      about.answers.forEach((a, i) => {
        if (editing === i) { list.append(editor(a, i)); return; }
        const open = el('button', { type: 'button', className: 'pab-answer-main' }, el('span', { className: 'pab-answer-q', textContent: a.question }), el('span', { className: 'pab-answer-a', textContent: a.answer }));
        open.dataset.key = `a:${i}`;
        open.title = tr('about.answers.edit', 'Edit');
        open.onclick = () => { editing = i; draw(); root.querySelector(`[data-key="a:${i}:q"]`)?.focus(); };
        list.append(el('li', { className: 'pab-answer' }, open, link(tr('projectws.remove', 'Remove'), () => send({ removeAnswer: a.question }).then(() => draw()))));
      });
      if (!about.answers.length && editing !== -2) c.append(el('p', { className: 'ptl-empty pab-empty', textContent: tr('about.answers.none', 'None yet. When you approve a long answer in a chat, the AI saves it here; or add one yourself.') }));
      c.append(list);
      return c;
    }
    function draw() {
      if (failed) { root.replaceChildren(el('p', { className: 'pab-empty', textContent: tr('about.failed', 'Could not read your profile.') }), btn(tr('projecttools.retry', 'Try again'), load)); return; }
      if (!about) { root.replaceChildren(el('p', { className: 'pjp-note', textContent: tr('projecttpl.apps.loading', 'Loading…') })); return; }
      root.replaceChildren(el('div', { className: 'pab-pair' }, filesCard(), highlightsCard()), fieldsCard(), answersCard(), say);
    }
    async function load() {
      failed = false;
      let out = await api.projectAbout(id).catch(() => null);
      if (out && !out.about && out.ok !== false) out = await api.projectAbout(id, { create: true }).catch(() => null); // (a job project whose profile went missing gets a new one)
      if (!holder.isConnected) return;
      if (!out?.about) failed = true; else about = out.about;
      draw();
    }
    draw();
    load();
    return { refresh: load };
  }

  window.chatProjectAbout = { view };
})();
