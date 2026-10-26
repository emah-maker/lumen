// lumen://chat > Projects > Open project: a project's home base, the page you work from (like the projects of Claude and ChatGPT, but it knows the browser).
// Loaded the first time a project is opened (chat-page.js adds this script and chat-project-page.css then), never with the page.
//   window.chatProjectPage.open({ api, id, host, focus? })   focus: 'instructions' opens the instructions for editing
//     host: { chats(), projects(), openChat(id), newChat(project, text?, { model?, files? }), editFolder(project), moveChats(ids, projectId), moveToNewProject(chat),
//             cleared?(), undoToast(text, ms, undo), toast(text), models() -> [{ value, label }], currentModel?(), closed(), refresh() }
//   window.chatProjectPage.close() / .isOpen() / .refresh() / .id()
// What it shows, top to bottom: the header (name, a one-line goal, and the quick actions: New chat, Add files, Open folder, ⋯), the box that
// starts a chat in the project (model, attach), "Continue where you left off" (the latest chats as cards: what was said last, when, and a mark
// while one is working), the chats with a search that looks in them and in the files, and beside them an overview of what the AI works from:
// instructions (read here, edited on request), files, pinned pages, the folder, the defaults a new chat starts with, and what the AI saved
// in the project's chats (memory). Nothing here is a form that is always open.
(() => {
  const tr = (key, english, vars) => { const out = window.chatTr ? window.chatTr(key, english) : english; return vars ? out.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : out; };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const KIND = { pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint', eml: 'Email', text: 'Text', image: 'Picture' };
  const ACCEPT = '.pdf,.docx,.pptx,.eml,.txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.yaml,.yml,.html,.htm,.rtf,.tex,.bib,.py,.js,.ts,.java,.c,.cpp,.h,.cs,.go,.rs,.rb,.sql,.ini,.toml,.png,.jpg,.jpeg,.gif,.webp';
  const MAX_BYTES = 60 * 1024 * 1024;
  const SHOWN_FILES = 5; // the Files card lists this many; "Show all" has the rest
  const SHOWN_CHATS = 30; // the chat list shows this many; "Show all" has the rest
  const ICON = {
    folder: '<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    clip: '<path d="M10.5 5.5 6 10a1.5 1.5 0 0 0 2.1 2.1l4.6-4.6a3 3 0 0 0-4.2-4.2L3.8 8.2a4.5 4.5 0 0 0 6.4 6.4l3-3"/>',
    send: '<path d="M8 12.5v-9M4 7l4-4 4 4"/>',
    more: '<circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/>',
    x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    info: '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.4M8 5.3v.1"/>',
    open: '<path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 3.5h-2a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/>',
    globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.7 1.6 2.5 3.4 2.5 5.5S9.7 11.9 8 13.5C6.3 11.9 5.5 10.1 5.5 8S6.3 4.1 8 2.5z"/>',
    sliders: '<path d="M2.5 4.5h11M2.5 11.5h11"/><circle cx="10.5" cy="4.5" r="1.6"/><circle cx="5.5" cy="11.5" r="1.6"/>',
  };
  const icon = (name, className = '') => { const s = el('span', { className: `pjp-ic ${className}`.trim() }); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<svg viewBox="0 0 16 16">${ICON[name]}</svg>`; return s; };

  let page = null; // { root, id, ... } while a project page is open

  const host = () => page.host;
  // A card: a heading row (title, a small "what is this" tooltip, then the card's own buttons) over its body.
  const card = (title, { tip = '', actions = [], className = '' } = {}) => {
    const c = el('section', { className: `pjp-card ${className}`.trim() });
    const head = el('div', { className: 'pjp-card-head' }, el('h2', { className: 'pjp-h', textContent: title }));
    if (tip) { const i = el('span', { className: 'pjp-tip', title: tip, tabIndex: 0 }); i.setAttribute('role', 'img'); i.setAttribute('aria-label', tip); i.append(icon('info')); head.append(i); }
    head.append(el('span', { className: 'pjp-grow' }), ...actions);
    const body = el('div', { className: 'pjp-card-body' });
    c.append(head, body);
    c.head = head;
    c.body = body;
    return c;
  };
  const note = (text) => el('p', { className: 'pjp-note', textContent: text });
  const status = () => { const s = el('p', { className: 'pjp-status' }); s.setAttribute('role', 'status'); return s; };
  const button = (label, run, className = '') => { const b = el('button', { type: 'button', className: `btn small ${className}`.trim(), textContent: label }); b.onclick = run; return b; };
  const quiet = (label, run, className = '') => { const b = el('button', { type: 'button', className: `pjp-link ${className}`.trim(), textContent: label }); b.onclick = run; return b; };
  // A button that needs a second click ("Remove" > "Click again to remove").
  const twoStep = (label, again, run, className = '') => {
    const b = button(label, () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = again; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = label; } }, 4000); return; }
      b.disabled = true;
      run();
    }, className);
    return b;
  };
  const grow = (text, min, max) => { text.style.height = 'auto'; text.style.height = `${Math.min(Math.max(text.scrollHeight + 2, min), max)}px`; };

  // ---- instructions: read as text, edited when asked (Edit, or a click on the text); Ctrl+Enter saves, Escape leaves
  function instructionsCard(data) {
    const { limits } = data;
    const tip = tr('projectws.instructions.note', 'Sent to the AI with every chat in this project, on every model. Up to {n} characters. Together with the list of files and pages, about {m} characters go with each message; anything longer is cut.', { n: limits.instructions, m: limits.instructions + limits.index });
    const edit = button(tr('projectws.edit', 'Edit'), () => start());
    const root = card(tr('chatpage.project.instructions', 'Instructions'), { tip, actions: [edit], className: 'pjp-instructions' });
    const say = status();
    const view = () => {
      page.editing.delete('instructions');
      const text = data.project.instructions || '';
      edit.hidden = false;
      edit.textContent = text ? tr('projectws.edit', 'Edit') : tr('projectws.instructions.add', 'Add');
      if (!text) { root.body.replaceChildren(note(tr('projectws.instructions.empty', 'No instructions yet. Say how the AI should work here: the tone, who it is for, what to avoid.')), say); return; }
      const read = el('p', { className: 'pjp-instr-text clamped', textContent: text, tabIndex: 0, title: tr('projectws.instructions.click', 'Click to edit') });
      read.onclick = () => { if (!getSelection()?.toString()) start(); };
      read.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); start(); } });
      const more = quiet(tr('projectws.showMore', 'Show more'), () => { const open = read.classList.toggle('clamped'); more.textContent = open ? tr('projectws.showMore', 'Show more') : tr('projectws.showLess', 'Show less'); more.setAttribute('aria-expanded', String(!open)); });
      more.hidden = true;
      root.body.replaceChildren(read, more, say);
      requestAnimationFrame(() => { more.hidden = read.scrollHeight <= read.clientHeight + 1 && read.classList.contains('clamped'); });
    };
    function start() {
      page.editing.add('instructions');
      edit.hidden = true;
      const text = el('textarea', { className: 'pjp-text', rows: 6, maxLength: limits.instructions, value: data.project.instructions || '', placeholder: tr('chatpage.project.hint', 'How should the AI work in this project? For example: answer in a formal tone, or the audience is first-year students.') });
      text.setAttribute('aria-label', tr('chatpage.project.instructions', 'Instructions'));
      const count = el('span', { className: 'pjp-count' });
      const save = button(tr('chatpage.project.save', 'Save'), async () => {
        save.disabled = true;
        const sending = text.value;
        const out = await page.api.saveProject({ id: page.id, name: data.project.name, instructions: sending }).catch(() => null);
        save.disabled = false;
        if (out && !out.error) { data.project = out; say.textContent = tr('projectws.saved', 'Saved.'); view(); host().refresh(); } else say.textContent = tr('chatpage.project.failed', 'Could not save the project.');
      }, 'primary');
      const cancel = button(tr('chatpage.project.cancel', 'Cancel'), () => { say.textContent = ''; view(); });
      const show = () => { count.textContent = `${text.value.length.toLocaleString()} / ${limits.instructions.toLocaleString()}`; };
      text.addEventListener('input', () => { say.textContent = ''; show(); grow(text, 120, 360); });
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !isImeEnter(e)) { e.preventDefault(); save.click(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.click(); }
      });
      root.body.replaceChildren(text, el('div', { className: 'pjp-line pjp-between' }, el('span', { className: 'pjp-note', textContent: tr('projectws.instructions.line', 'Sent with every chat in this project.') }), count), el('div', { className: 'pjp-line pjp-end' }, say, cancel, save));
      show();
      grow(text, 120, 360);
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    }
    root.start = start;
    view();
    return root;
  }

  // ---- files: the first few, with a way to the rest; dropped on the card or added with its button
  function filesCard(data) {
    const say = status();
    const input = el('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true, tabIndex: -1 });
    input.setAttribute('aria-hidden', 'true');
    const add = button(tr('projectws.addFiles', 'Add files…'), () => input.click());
    const root = card(tr('projectws.files', 'Files'), { tip: tr('projectws.files.note', 'Read on this computer and kept as text, encrypted in your Lumen profile; never uploaded. The AI searches and reads them in every chat of this project, and only then does a passage go to your AI provider.'), actions: [add], className: 'pjp-files' });
    const count = el('span', { className: 'pjp-badge' });
    root.head.querySelector('h2').after(count);
    const list = el('ul', { className: 'pjp-list' });
    list.setAttribute('aria-label', tr('projectws.files', 'Files'));
    const foot = el('div', { className: 'pjp-line' });
    let all = false;
    const empty = el('div', { className: 'pjp-drop' }, el('span', { className: 'pjp-drop-title', textContent: tr('projectws.drop', 'Drop files here') }), el('span', { className: 'pjp-note', textContent: tr('projectws.empty.files.short', 'PDF, Word, PowerPoint, email, text, CSV or pictures. The AI can search and read them in every chat here.') }));
    function draw(files = data.files) {
      data.files = files;
      count.textContent = files.length ? String(files.length) : '';
      count.hidden = !files.length;
      const shown = all ? files : files.slice(0, SHOWN_FILES);
      list.replaceChildren(...shown.map((f) => {
        const li = el('li', { className: 'pjp-row' });
        li.dataset.file = f.id;
        const info = el('div', { className: 'pjp-row-main' },
          el('span', { className: 'pjp-row-name', textContent: f.name, title: f.name }),
          el('span', { className: 'pjp-row-meta', textContent: [KIND[f.kind] || f.kind, kb(f.size || 0), f.chars ? tr('projectws.chars', '{n} characters', { n: f.chars.toLocaleString() }) : ''].filter(Boolean).join(' · ') + (f.cut ? ` · ${tr('projectws.cut', 'cut: very long')}` : '') }));
        if (f.summary) info.append(el('span', { className: 'pjp-row-sum', textContent: f.summary }));
        li.append(el('span', { className: 'pjp-kind', textContent: (KIND[f.kind] || f.kind || '').slice(0, 4) }), info, twoStep(tr('projectws.remove', 'Remove'), tr('projectws.removeAgain', 'Click again to remove'), async () => {
          const out = await page.api.projectFileRemove(page.id, f.id).catch(() => null);
          if (out) { draw(out.files); data.totals = out.totals; host().refresh(); } else { say.textContent = tr('projectws.removeFailed', 'Could not remove the file.'); li.querySelector('button').disabled = false; }
        }, 'pjp-row-btn'));
        return li;
      }));
      list.hidden = !files.length;
      empty.hidden = Boolean(files.length);
      foot.replaceChildren(...(files.length > SHOWN_FILES ? [quiet(all ? tr('projectws.showLess', 'Show less') : tr('projectws.showAll', 'Show all {n}', { n: files.length }), () => { all = !all; draw(); })] : []), ...(files.length ? [el('span', { className: 'pjp-note', textContent: tr('projectws.totals.short', '{n} of {max} files', { n: files.length, max: data.limits.files }) })] : []));
    }
    async function addAll(fileList) {
      const files = [...fileList];
      if (!files.length) return;
      say.textContent = '';
      const problems = [];
      let done = 0;
      for (let i = 0; i < files.length; i += 2) {
        const batch = [];
        for (const f of files.slice(i, i + 2)) {
          if (f.size > MAX_BYTES) { problems.push(`${f.name}: ${tr('projectws.tooBig', 'too large (over {n} MB)', { n: MAX_BYTES / 1048576 })}`); continue; }
          try { batch.push({ name: f.name, bytes: await f.arrayBuffer() }); } catch { problems.push(`${f.name}: ${tr('projectws.unreadable', 'could not be read')}`); }
        }
        say.textContent = tr('projectws.reading', 'Reading {n} of {total}…', { n: Math.min(i + 1, files.length), total: files.length });
        if (!batch.length) continue;
        const out = await page.api.projectFilesAdd(page.id, batch).catch(() => null);
        if (!out) { problems.push(tr('projectws.addFailed', 'Could not add the files.')); continue; }
        for (const r of out.results) if (r.ok) done++; else problems.push(`${r.name}: ${r.error}`);
        data.totals = out.totals;
        draw(out.files);
      }
      say.textContent = [done ? tr('projectws.added', 'Added {n}.', { n: done }) : '', ...problems].filter(Boolean).join(' ');
      host().refresh();
    }
    input.onchange = () => { const picked = [...input.files]; input.value = ''; addAll(picked); };
    root.pick = () => input.click();
    root.body.append(empty, list, foot, say, input);
    if (!data.keychain) root.body.prepend(note(tr('projectws.nokeychain', 'Files need your system’s secure storage (the keychain), which is not available here, so they cannot be kept.')));
    for (const type of ['dragenter', 'dragover']) root.addEventListener(type, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); root.classList.add('dropping'); } });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('dropping'); });
    root.addEventListener('drop', (e) => { e.preventDefault(); root.classList.remove('dropping'); addAll(e.dataTransfer?.files || []); });
    draw();
    return root;
  }

  // ---- pinned pages
  function linksCard(data) {
    const list = el('ul', { className: 'pjp-list' });
    list.setAttribute('aria-label', tr('projectws.pages', 'Pinned pages'));
    const say = status();
    const url = el('input', { type: 'url', className: 'pjp-input', placeholder: tr('projectws.pages.url', 'https://…') });
    url.setAttribute('aria-label', tr('projectws.pages.url.label', 'Web address to pin'));
    const form = el('div', { className: 'pjp-line pjp-pin-form', hidden: true });
    const tab = button(tr('projectws.pages.tab', 'Add this tab'), async () => {
      const out = await page.api.projectAddTab(page.id).catch(() => null);
      if (out?.ok) { draw(out.project); say.textContent = out.already ? tr('projectws.pages.already', 'That page is already pinned.') : tr('projectws.pages.added', 'Pinned.'); host().refresh(); } else say.textContent = out?.reason === 'full' ? tr('projectws.pages.full', 'A project holds up to 25 pages.') : tr('projectws.pages.notweb', 'The tab you are looking at is not a web page.');
    });
    const pin = button(tr('projectws.pages.new', 'Pin a page…'), () => { form.hidden = !form.hidden; if (!form.hidden) url.focus(); });
    const root = card(tr('projectws.pages', 'Pinned pages'), { tip: tr('projectws.pages.note', 'The AI reads a pinned page when a chat needs it (it asks first if it has read other pages, as usual). Nothing is fetched until then.'), actions: [tab, pin], className: 'pjp-pages' });
    const count = el('span', { className: 'pjp-badge' });
    root.head.querySelector('h2').after(count);
    function draw(project) {
      data.project = project;
      const links = project.links || [];
      count.textContent = links.length ? String(links.length) : '';
      count.hidden = !links.length;
      list.replaceChildren(...links.map((l) => {
        let shown = l.url;
        try { shown = new URL(l.url).host; } catch { /* the address itself */ }
        const li = el('li', { className: 'pjp-row' });
        li.dataset.url = l.url;
        const open = el('button', { type: 'button', className: 'pjp-row-open', title: l.url });
        open.append(icon('globe', 'pjp-row-ic'), el('span', { className: 'pjp-row-main' }, el('span', { className: 'pjp-row-name', textContent: l.title || shown }), el('span', { className: 'pjp-row-meta', textContent: l.title ? shown : l.url })));
        open.onclick = () => window.assistant?.openLink?.(l.url);
        li.append(open, twoStep(tr('projectws.remove', 'Remove'), tr('projectws.removeAgain', 'Click again to remove'), async () => {
          const out = await page.api.projectLink(page.id, { remove: l.url }).catch(() => null);
          if (out && !out.error) { draw(out); host().refresh(); } else li.querySelector('button:last-child').disabled = false;
        }, 'pjp-row-btn'));
        return li;
      }));
      list.hidden = !links.length;
      empty.hidden = Boolean(links.length);
    }
    const empty = note(tr('projectws.empty.pages', 'No pages yet. Pin a page and the AI can read it when a chat needs it.'));
    const submit = async () => {
      const value = url.value.trim();
      if (!value) return;
      const out = await page.api.projectLink(page.id, { add: { url: /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`, title: '' } }).catch(() => null);
      if (out && !out.error) { url.value = ''; say.textContent = ''; form.hidden = true; draw(out); host().refresh(); } else say.textContent = out?.error === 'full' ? tr('projectws.pages.full', 'A project holds up to 25 pages.') : tr('projectws.pages.invalid', 'That is not a web address (http or https).');
    };
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); form.hidden = true; pin.focus(); } });
    form.append(url, button(tr('projectws.pages.add', 'Pin'), submit, 'primary'));
    root.body.append(empty, list, form, say);
    draw(data.project);
    return root;
  }

  // ---- folder: where the project lives on this computer (set up and changed in the project's editor, host.editFolder)
  function folderCard(data) {
    const p = data.project;
    const root = card(tr('chatpage.project.folder', 'Folder'), { tip: p.folder ? tr('projectws.folder.note', 'Chats of this project are saved here as Markdown files unless you turn that off in the project’s settings.') : '', className: 'pjp-folder' });
    if (p.folder) {
      root.body.append(el('p', { className: `pjp-path${p.folderMissing ? ' missing' : ''}`, textContent: p.folderMissing ? `${tr('chatpage.project.folder.missing', 'Folder missing')}: ${p.folder}` : p.folder, title: p.folder }));
      root.body.append(el('div', { className: 'pjp-line' },
        p.folderMissing ? button(tr('chatpage.project.folder.missingFix', 'Folder missing…'), () => host().editFolder(data.project), 'primary') : button(tr('chatpage.project.folder.open', 'Open folder'), () => page.api.projectFolder(page.id, 'open').catch(() => null)),
        button(tr('projectws.folder.change', 'Change…'), () => host().editFolder(data.project))));
    } else {
      root.body.append(note(tr('chatpage.project.folder.none', 'This project has no folder yet.')));
      root.body.append(el('div', { className: 'pjp-line' }, button(tr('projectws.folder.add', 'Add a folder…'), () => host().editFolder(data.project))));
    }
    return root;
  }

  // ---- defaults: a summary, and the controls when asked
  function defaultsCard(data) {
    const models = (host().models?.() || []).filter((m) => m.value && !m.value.includes('__'));
    const label = (value) => (value ? models.find((m) => m.value === value)?.label || value : tr('projectws.defaults.usual', 'My usual model'));
    const edit = button(tr('projectws.edit', 'Edit'), () => { editing = !editing; draw(); });
    const root = card(tr('projectws.defaults', 'Defaults'), { tip: tr('projectws.defaults.note', 'A new chat in this project starts with these. The model and Plan first can still be changed in the chat. The tools of another chat are not affected.'), actions: [edit], className: 'pjp-defaults' });
    let editing = false;
    const say = status();
    function draw() {
      edit.textContent = editing ? tr('projectws.done', 'Done') : tr('projectws.edit', 'Edit');
      const d = data.project.defaults || {};
      if (!editing) {
        const bits = [label(d.model), d.plan ? tr('projectws.defaults.plan.on', 'Plan first') : '', d.connectors === false ? tr('projectws.defaults.connectors.off', 'No connected accounts') : '', d.mcp === false ? tr('projectws.defaults.mcp.off', 'No MCP tools') : ''].filter(Boolean);
        root.body.replaceChildren(el('p', { className: 'pjp-summary', textContent: bits.join(' · ') }), say);
        return;
      }
      const model = el('select', { className: 'pjp-select' });
      model.setAttribute('aria-label', tr('projectws.defaults.model', 'Model for new chats'));
      model.append(el('option', { value: '', textContent: tr('projectws.defaults.usual', 'My usual model') }));
      for (const m of models) model.append(el('option', { value: m.value, textContent: m.label }));
      if (d.model && !models.some((m) => m.value === d.model)) model.append(el('option', { value: d.model, textContent: d.model }));
      model.value = d.model || '';
      const check = (text, on) => { const input = el('input', { type: 'checkbox', checked: on }); return { input, label: el('label', { className: 'pjp-check' }, input, el('span', { textContent: text })) }; };
      const plan = check(tr('projectws.defaults.plan', 'Plan first: the AI only reads and shows a plan before it acts'), d.plan === true);
      const conn = check(tr('projectws.defaults.connectors', 'Let its chats use my connected accounts (Gmail, Canvas…)'), d.connectors !== false);
      const mcp = check(tr('projectws.defaults.mcp', 'Let its chats use my MCP servers’ tools'), d.mcp !== false);
      const save = async () => {
        const out = await page.api.projectDefaults(page.id, { model: model.value, plan: plan.input.checked, connectors: conn.input.checked, mcp: mcp.input.checked }).catch(() => null);
        say.textContent = out ? tr('projectws.saved', 'Saved.') : tr('chatpage.project.failed', 'Could not save the project.');
        if (out) { data.project = out; page.syncModel?.(); }
      };
      for (const n of [model, plan.input, conn.input, mcp.input]) n.onchange = save;
      root.body.replaceChildren(el('label', { className: 'pjp-field' }, el('span', { textContent: tr('projectws.defaults.model', 'Model for new chats') }), model), plan.label, conn.label, mcp.label, say);
    }
    draw();
    return root;
  }

  // ---- memory: what the AI saved in this project's chats
  function memoryCard(data) {
    const list = el('ul', { className: 'pjp-list' });
    list.setAttribute('aria-label', tr('projectws.memory', 'Memory'));
    const root = card(tr('projectws.memory', 'Memory'), { tip: tr('projectws.memory.note', 'Saved in this project’s chats, so only its chats see it, next to your general memory.'), className: 'pjp-memory' });
    const count = el('span', { className: 'pjp-badge' });
    root.head.querySelector('h2').after(count);
    const empty = note(data.memoryOn ? tr('projectws.empty.memory', 'Nothing saved for this project yet. What the AI saves in a chat of this project is kept here.') : tr('projectws.memory.off', 'Memory is off. Turn it on in Settings → AI → Instructions and memory, and what the AI saves in this project’s chats is kept here.'));
    const draw = (entries) => {
      count.textContent = entries.length ? String(entries.length) : '';
      count.hidden = !entries.length;
      list.replaceChildren(...entries.map((e) => {
        const li = el('li', { className: 'pjp-row' });
        li.dataset.memory = e.id;
        li.append(el('div', { className: 'pjp-row-main' }, el('span', { className: 'pjp-row-text', textContent: e.text })),
          twoStep(tr('projectws.forget', 'Forget'), tr('projectws.forgetAgain', 'Click again to forget'), async () => {
            const ok = await page.api.projectMemoryForget(page.id, e.id).catch(() => false);
            if (ok) { data.memory = data.memory.filter((x) => x.id !== e.id); draw(data.memory); } else li.querySelector('button').disabled = false;
          }, 'pjp-row-btn'));
        return li;
      }));
      list.hidden = !entries.length;
      empty.hidden = Boolean(entries.length);
    };
    root.body.append(empty, list);
    draw(data.memory);
    return root;
  }

  // ---- chats
  const when = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return tr('chats.yesterday', 'Yesterday');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  };
  const mine = () => host().chats().filter((c) => c.project === page.id && !c.archived);
  const myChats = () => mine().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
  const BADGE = { running: ['Running', 'projectws.badge.running'], queued: ['Waiting for a turn', 'projectws.badge.queued'], approval: ['Needs your OK', 'projectws.badge.approval'], unread: ['New reply', 'projectws.badge.unread'] };
  const badgeOf = (c) => (BADGE[c.badge] ? el('span', { className: `pjp-badge-live ${c.badge}`, textContent: tr(BADGE[c.badge][1], BADGE[c.badge][0]) }) : null);
  function chatRow(c) {
    const li = el('li', { className: `pjp-chat${c.pinned ? ' pinned' : ''}` });
    li.dataset.chat = c.id;
    const live = badgeOf(c);
    const open = el('button', { type: 'button', className: 'pjp-chat-open' },
      el('span', { className: 'pjp-chat-title', textContent: c.title || tr('chats.untitled', 'Chat') }),
      el('span', { className: 'pjp-chat-when' }, ...(live ? [live] : []), document.createTextNode([c.pinned ? tr('chats.pinned', 'Pinned') : '', when(c.updated)].filter(Boolean).join(' · '))));
    open.onclick = () => host().openChat(c.id);
    const acts = el('div', { className: 'pjp-chat-acts' });
    const label = c.title || tr('chats.untitled', 'Chat');
    const act = (name, text, run) => { const b = window.chatIconButton(name, `${text}: ${label}`); b.title = text; b.onclick = run; return b; };
    acts.append(
      act(c.pinned ? 'unpin' : 'pin', c.pinned ? tr('chats.unpin', 'Unpin') : tr('chats.pin', 'Pin to top'), async (e) => {
        e.currentTarget.disabled = true;
        const ok = await page.api.pin(c.id, !c.pinned).catch(() => false);
        if (ok === false) e.currentTarget.disabled = false; else host().refresh();
      }),
      act('project', tr('chatpage.project.move', 'Move to project'), (e) => {
        window.chatProjects.picker({ api: page.api, chat: c, projects: host().projects(), anchor: e.currentTarget, onPick: (pid) => host().moveChats([c.id], pid), onDone() {}, onNew: (chat) => host().moveToNewProject(chat) });
      }),
      act('delete', tr('chats.delete', 'Delete'), async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        const out = await page.api.remove(c.id).catch(() => null);
        if (!out) { b.disabled = false; host().toast(tr('chats.deleteFailed', 'Could not delete')); return; }
        if (out.cleared) host().cleared?.();
        if (out.undo) host().undoToast(tr('chats.deleted', 'Chat deleted'), out.undoMs || 8000, async () => { const ok = await page.api.undoRemove(c.id); host().refresh(); return ok; });
        host().refresh();
      }));
    li.append(open, acts);
    return li;
  }

  // "Continue where you left off": the chats that are working first, then the latest, as cards with what was said last.
  function recentSection() {
    const root = el('section', { className: 'pjp-recent' });
    root.setAttribute('aria-labelledby', 'pjp-recent-h');
    const head = el('div', { className: 'pjp-sec-head' }, el('h2', { className: 'pjp-h pjp-h-big', id: 'pjp-recent-h', textContent: tr('projectws.recent', 'Continue where you left off') }));
    const grid = el('div', { className: 'pjp-cards' });
    root.append(head, grid);
    let timer = null;
    const pick = () => {
      const all = mine();
      const working = all.filter((c) => c.badge === 'running' || c.badge === 'queued' || c.badge === 'approval').sort((a, b) => (b.updated || 0) - (a.updated || 0));
      const rest = all.filter((c) => !working.includes(c)).sort((a, b) => (b.updated || 0) - (a.updated || 0));
      return [...working, ...rest].slice(0, 4);
    };
    // what each card says is read in main once (with the page) and again when a card's chat changed
    async function snippets(cards) {
      const stale = cards.filter((c) => page.snipAt[c.id] !== c.updated);
      if (!stale.length || page.snipBusy) return;
      const me = page;
      me.snipBusy = true;
      const seen = Object.fromEntries(stale.map((c) => [c.id, c.updated]));
      const data = await me.api.project(me.id).catch(() => null);
      me.snipBusy = false;
      if (me !== page || !data) return;
      for (const [id, text] of Object.entries(data.snippets || {})) me.snips[id] = text;
      for (const id of Object.keys(seen)) me.snipAt[id] = seen[id];
      draw(false);
    }
    function draw(ask = true) {
      const cards = pick();
      root.hidden = !cards.length;
      grid.replaceChildren(...cards.map((c) => {
        const b = el('button', { type: 'button', className: `pjp-chat-card${c.badge === 'running' ? ' live' : ''}` });
        b.dataset.chat = c.id;
        const live = badgeOf(c);
        b.append(
          el('span', { className: 'pjp-cc-title', textContent: c.title || tr('chats.untitled', 'Chat') }),
          el('span', { className: 'pjp-cc-snip', textContent: page.snips[c.id] || '' }),
          el('span', { className: 'pjp-cc-foot' }, ...(live ? [live] : []), el('span', { className: 'pjp-cc-when', textContent: when(c.updated) })));
        b.onclick = () => host().openChat(c.id);
        return b;
      }));
      if (ask) { clearTimeout(timer); timer = setTimeout(() => { if (page) snippets(cards); }, 500); }
    }
    root.draw = draw;
    return root;
  }

  // The chats section: a heading with the count and the search box, the rows (or an empty state), and the search's results in their place.
  function chatsSection() {
    const root = el('section', { className: 'pjp-chats-sec' });
    root.setAttribute('aria-labelledby', 'pjp-chats-h');
    const count = el('span', { className: 'pjp-chats-count' });
    const head = el('div', { className: 'pjp-chats-head' }, el('h2', { className: 'pjp-h pjp-h-big', id: 'pjp-chats-h', textContent: tr('projectws.chats', 'Chats') }), count);
    const search = searchBox();
    head.append(search.input);
    const list = el('ul', { className: 'pjp-chat-list' });
    list.setAttribute('aria-label', tr('projectws.chats', 'Chats'));
    const more = el('div', { className: 'pjp-more', hidden: true });
    const emptyState = el('div', { className: 'pjp-empty-state' },
      el('p', { className: 'pjp-empty-title', textContent: tr('projectws.chats.empty.title', 'No chats yet') }),
      el('p', { className: 'pjp-note', textContent: tr('projectws.chats.empty.text', 'Write above to start the first one. You can also drag a chat from the list onto this project, or use a chat’s ⋯ menu.') }));
    let all = false;
    const draw = () => {
      const rows = myChats();
      const shown = all ? rows : rows.slice(0, SHOWN_CHATS);
      list.replaceChildren(...shown.map(chatRow));
      emptyState.hidden = rows.length > 0;
      list.hidden = !rows.length || Boolean(search.input.value.trim());
      more.hidden = rows.length <= SHOWN_CHATS || list.hidden;
      more.replaceChildren(...(rows.length > SHOWN_CHATS ? [button(all ? tr('projectws.showLess', 'Show less') : tr('projectws.chats.showAll', 'Show all {n} chats', { n: rows.length }), () => { all = !all; draw(); })] : []));
      count.textContent = rows.length ? String(rows.length) : '';
      page.recent?.draw();
      if (page.sub) page.sub();
    };
    page.list = list;
    page.redraw = draw;
    draw();
    root.append(head, search.out, list, more, emptyState);
    return root;
  }

  // ---- search: the project's chats and files
  function searchBox() {
    const input = el('input', { type: 'search', className: 'pjp-input pjp-search-input', placeholder: tr('projectws.search', 'Search this project’s chats and files') });
    input.setAttribute('aria-label', tr('projectws.search', 'Search this project’s chats and files'));
    const out = el('div', { className: 'pjp-results', hidden: true });
    out.setAttribute('aria-live', 'polite');
    let timer = null;
    let seq = 0;
    const run = async () => {
      const q = input.value.trim();
      const me = ++seq;
      page.list.hidden = Boolean(q) || !myChats().length;
      page.root.querySelector('.pjp-more').hidden = Boolean(q) || page.root.querySelector('.pjp-more').childElementCount === 0;
      page.root.querySelector('.pjp-empty-state').hidden = Boolean(q) || myChats().length > 0;
      out.hidden = !q;
      if (!q) return;
      const lower = q.toLowerCase();
      const inProject = (id) => host().chats().some((c) => c.id === id && c.project === page.id);
      const [chatHits, fileHits] = await Promise.all([page.api.search(q).catch(() => []), page.api.projectSearch(page.id, q).catch(() => [])]);
      if (me !== seq) return;
      const byTitle = host().chats().filter((c) => c.project === page.id && (c.title || '').toLowerCase().includes(lower)).map((c) => ({ id: c.id, snippet: '' }));
      const chats = [...byTitle, ...(Array.isArray(chatHits) ? chatHits : []).filter((h) => inProject(h.id) && !byTitle.some((b) => b.id === h.id))];
      const rows = [];
      if (chats.length) {
        rows.push(el('h3', { className: 'pjp-h3', textContent: tr('projectws.chats', 'Chats') }));
        for (const h of chats.slice(0, 20)) {
          const c = host().chats().find((x) => x.id === h.id);
          const b = el('button', { type: 'button', className: 'pjp-hit' }, el('span', { className: 'pjp-row-name', textContent: c?.title || tr('chats.untitled', 'Chat') }), el('span', { className: 'pjp-row-sum', textContent: h.snippet || '' }));
          b.dataset.chat = h.id;
          b.onclick = () => host().openChat(h.id);
          rows.push(b);
        }
      }
      if (fileHits.length) {
        rows.push(el('h3', { className: 'pjp-h3', textContent: tr('projectws.files', 'Files') }));
        for (const h of fileHits) rows.push(el('div', { className: 'pjp-hit file' }, el('span', { className: 'pjp-row-name', textContent: h.file }), el('span', { className: 'pjp-row-sum', textContent: h.snippet })));
      }
      if (!rows.length) rows.push(el('p', { className: 'pjp-note', textContent: tr('projectws.search.none', 'Nothing in this project matches.') }));
      out.replaceChildren(...rows);
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
    return { input, out };
  }

  // ---- the box that starts a chat in this project: the real composer's parts (message, attach, model), Enter sends
  function composer(data) {
    const form = el('form', { className: 'pjp-composer' });
    const text = el('textarea', { className: 'pjp-compose-text', rows: 3, placeholder: tr('projectws.compose.placeholder', 'Start a chat in {name}…', { name: data.project.name }) });
    text.setAttribute('aria-label', tr('projectws.compose.label', 'Message for a new chat in this project'));
    const picked = el('div', { className: 'pjp-attached', hidden: true });
    let files = [];
    const drawFiles = () => {
      picked.hidden = !files.length;
      picked.replaceChildren(...files.map((f, i) => {
        const x = el('button', { type: 'button', className: 'pjp-chip-x' });
        x.setAttribute('aria-label', tr('projectws.compose.detach', 'Remove {name}', { name: f.name }));
        x.append(icon('x'));
        x.onclick = () => { files.splice(i, 1); drawFiles(); text.focus(); };
        return el('span', { className: 'pjp-chip' }, el('span', { className: 'pjp-chip-name', textContent: f.name, title: f.name }), x);
      }));
    };
    const input = el('input', { type: 'file', multiple: true, hidden: true, tabIndex: -1 });
    input.setAttribute('aria-hidden', 'true');
    input.onchange = () => { files = [...files, ...input.files].slice(0, 10); input.value = ''; drawFiles(); };
    const attach = el('button', { type: 'button', className: 'icon-btn pjp-attach', title: tr('projectws.compose.attach', 'Attach files') });
    attach.setAttribute('aria-label', tr('projectws.compose.attach', 'Attach files'));
    attach.append(icon('clip'));
    attach.onclick = () => input.click();
    // The model a new chat starts on: the project's default, else the one in use. A pick here is for this chat only.
    const model = el('select', { className: 'pjp-model' });
    model.setAttribute('aria-label', tr('projectws.compose.model', 'Model for this chat'));
    let touched = false;
    const fill = () => {
      const models = (host().models?.() || []).filter((m) => m.value && !m.value.includes('__'));
      const want = page.data.project.defaults?.model || host().currentModel?.() || models[0]?.value || '';
      model.replaceChildren(...models.map((m) => el('option', { value: m.value, textContent: m.label })));
      if (want && !models.some((m) => m.value === want)) model.append(el('option', { value: want, textContent: want }));
      if (!touched) model.value = want;
    };
    fill();
    model.hidden = !model.options.length;
    model.onchange = () => { touched = true; };
    page.syncModel = () => { if (!touched) fill(); };
    const go = el('button', { type: 'submit', className: 'btn primary pjp-go', title: tr('projectws.compose.go', 'Start chat') });
    go.setAttribute('aria-label', tr('projectws.compose.go', 'Start chat'));
    go.append(icon('send'));
    form.append(text, picked, el('div', { className: 'pjp-compose-bar' }, el('div', { className: 'pjp-compose-left' }, attach, model), el('span', { className: 'pjp-compose-hint', textContent: tr('projectws.compose.hint', 'Uses this project’s instructions, files and defaults.') }), go), input);
    const grows = () => grow(text, 72, 240);
    text.addEventListener('input', grows);
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!text.value.trim() && !files.length) { text.focus(); return; }
      go.disabled = true;
      host().newChat(page.data.project, text.value, { model: touched ? model.value : '', files });
    };
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isImeEnter(e)) { e.preventDefault(); form.requestSubmit(); } });
    // files dropped on the box are attached to the chat it starts
    form.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.stopPropagation(); form.classList.add('dropping'); } });
    form.addEventListener('dragleave', (e) => { if (!form.contains(e.relatedTarget)) form.classList.remove('dropping'); });
    form.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); e.stopPropagation(); form.classList.remove('dropping'); files = [...files, ...e.dataTransfer.files].slice(0, 10); drawFiles(); });
    page.composerText = text;
    return form;
  }

  // ---- the page: the header, then the box, the latest chats and all of them on the left, the overview on the right (under them on a narrow window)
  async function open({ api, id, host: h, focus = '' }) {
    close(false);
    const data = await api.project(id).catch(() => null);
    if (!data) return false;
    const root = el('section', { className: 'pjp', id: 'cp-project-page' });
    page = { api, id, host: h, root, data, list: null, redraw: null, sub: null, composerText: null, recent: null, side: null, editing: new Set(), snips: { ...(data.snippets || {}) }, snipAt: {}, snipBusy: false, cards: {} };
    for (const c of h.chats()) if (c.project === id) page.snipAt[c.id] = c.updated;
    root.setAttribute('aria-label', data.project.name);
    const back = el('button', { type: 'button', className: 'pjp-back' });
    back.append(el('span', { className: 'pjp-back-arrow', textContent: '←' }), tr('projectws.back', 'Chats'));
    back.onclick = () => close();
    const title = el('input', { type: 'text', className: 'pjp-title', value: data.project.name, maxLength: 60 });
    title.setAttribute('aria-label', tr('chatpage.project.name', 'Project name'));
    const rename = async () => {
      const name = title.value.trim();
      if (!name) { title.value = data.project.name; return; }
      if (name === data.project.name) return;
      const out = await api.saveProject({ id, name }).catch(() => null);
      if (out && !out.error) { data.project = out; root.setAttribute('aria-label', out.name); page.composerText?.setAttribute('placeholder', tr('projectws.compose.placeholder', 'Start a chat in {name}…', { name: out.name })); h.refresh(); } else title.value = data.project.name;
    };
    title.addEventListener('blur', rename);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); title.blur(); } else if (e.key === 'Escape') { title.value = data.project.name; title.blur(); } });
    const desc = el('input', { type: 'text', className: 'pjp-desc', value: data.project.description || '', maxLength: 200, placeholder: tr('projectws.desc.placeholder', 'Add a goal or a short description…') });
    desc.setAttribute('aria-label', tr('projectws.desc.label', 'What this project is for'));
    const saveDesc = async () => {
      const text = desc.value.trim();
      if (text === (data.project.description || '')) return;
      const out = await api.saveProject({ id, name: data.project.name, description: text }).catch(() => null);
      if (out && !out.error) { data.project = out; desc.value = out.description || ''; h.refresh(); } else desc.value = data.project.description || '';
    };
    desc.addEventListener('blur', saveDesc);
    desc.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); desc.blur(); } else if (e.key === 'Escape') { desc.value = data.project.description || ''; desc.blur(); } });
    const sub = el('p', { className: 'pjp-sub' });
    page.sub = () => {
      const n = mine().length;
      const f = (page.data.files || []).length;
      const l = (page.data.project.links || []).length;
      const part = (count, one, many) => (count ? tr(count === 1 ? one[0] : many[0], count === 1 ? one[1] : many[1], { n: count }) : '');
      sub.textContent = [part(n, ['projectws.count.chat', '{n} chat'], ['projectws.count.chats', '{n} chats']) || tr('projectws.count.none', 'No chats yet'), part(f, ['projectws.count.file', '{n} file'], ['projectws.count.files', '{n} files']), part(l, ['projectws.count.page', '{n} pinned page'], ['projectws.count.pages', '{n} pinned pages'])].filter(Boolean).join(' · ');
    };
    // quick actions
    const fresh = el('button', { type: 'button', className: 'btn small primary pjp-new-chat' });
    fresh.append(icon('plus'), document.createTextNode(tr('projectws.newChat', 'New chat')));
    fresh.onclick = () => { fresh.disabled = true; h.newChat(page.data.project, ''); };
    const addFiles = el('button', { type: 'button', className: 'btn small pjp-add-files' });
    addFiles.append(icon('clip'), document.createTextNode(tr('projectws.addFiles.short', 'Add files')));
    addFiles.onclick = () => { page.side.querySelector('.pjp-files').pick(); };
    const folder = el('button', { type: 'button', className: 'btn small pjp-open-folder', hidden: !data.project.folder });
    folder.append(icon('open'), document.createTextNode(tr('chatpage.project.folder.open', 'Open folder')));
    folder.onclick = () => { if (page.data.project.folderMissing) h.editFolder(page.data.project); else api.projectFolder(id, 'open').catch(() => null); };
    const more = el('button', { type: 'button', className: 'btn small icon pjp-more-btn', title: tr('chats.more', 'More actions') });
    more.setAttribute('aria-label', tr('chats.more', 'More actions'));
    more.setAttribute('aria-haspopup', 'menu');
    more.append(icon('more'));
    const confirm = el('div', { className: 'pjp-confirm', hidden: true });
    confirm.setAttribute('role', 'alert');
    const askDelete = () => {
      confirm.hidden = false;
      const del = button(tr('chatpage.project.delete', 'Delete project'), async () => {
        del.disabled = true;
        const ok = await api.removeProject(id).catch(() => false);
        if (!ok) { del.disabled = false; return; }
        const name = data.project.name;
        close();
        h.undoToast(tr('projectws.deleted', 'Deleted “{name}”', { name }), 10000, async () => {
          const back2 = await api.restoreProject(id).catch(() => null);
          h.refresh();
          return Boolean(back2);
        });
        h.refresh();
      }, 'danger');
      const keep = button(tr('chatpage.project.cancel', 'Cancel'), () => { confirm.hidden = true; more.focus(); });
      confirm.replaceChildren(el('span', { textContent: tr('projectws.deleteAsk', 'Delete this project? Its chats stay, out of any project.') }), el('span', { className: 'pjp-grow' }), keep, del);
      del.focus();
    };
    more.onclick = () => {
      window.chatProjects.menu({
        anchor: more, label: data.project.name,
        items: [
          { label: tr('projectws.folder', 'Folder and more…'), icon: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>', run: () => h.editFolder(page.data.project) },
          { label: tr('chatpage.project.delete', 'Delete project'), icon: '<svg viewBox="0 0 16 16"><path d="M3.5 5h9M6.5 5V3.5h3V5M5 5l.5 8h5L11 5"/></svg>', run: askDelete },
        ],
        onClose: () => { if (!document.activeElement || document.activeElement === document.body) more.focus(); },
      });
    };
    const mark = el('div', { className: 'pjp-mark' });
    mark.append(icon('folder'));
    const head = el('header', { className: 'pjp-head' }, back,
      el('div', { className: 'pjp-head-row' },
        mark,
        el('div', { className: 'pjp-head-text' }, title, desc, sub),
        el('div', { className: 'pjp-actions' }, fresh, addFiles, folder, more)),
      confirm);
    page.recent = recentSection();
    const main = [composer(data), page.recent, chatsSection()];
    const instructions = instructionsCard(data);
    const side = el('aside', { className: 'pjp-side' }, instructions, filesCard(data), linksCard(data), folderCard(data), defaultsCard(data), memoryCard(data));
    side.setAttribute('aria-label', tr('projectws.side', 'Project overview'));
    page.side = side;
    page.sub();
    page.recent.draw();
    root.append(el('div', { className: 'pjp-wrap' }, head, el('div', { className: 'pjp-cols' }, ...main, side)));
    const mount = document.querySelector('.cp-main');
    document.getElementById('chat-root').hidden = true;
    mount.append(root);
    document.body.classList.add('cp-project-open');
    page.instructions = instructions;
    if (focus === 'instructions') { instructions.scrollIntoView({ block: 'nearest' }); instructions.start(); } else page.composerText.focus();
    return true;
  }
  function close(notify = true) {
    if (!page) return;
    const { root, host: h } = page;
    page = null;
    root.remove();
    const chat = document.getElementById('chat-root');
    if (chat) chat.hidden = false;
    document.body.classList.remove('cp-project-open');
    if (notify) h.closed?.();
  }
  // The chats changed (a run started, a reply came, a chat moved) or the project did, in this view or in the sidebar: the lists redraw, and the
  // header and the overview follow an edit made elsewhere (never while something here is being edited).
  async function refresh() {
    if (!page) return;
    page.redraw?.();
    const shown = page.host.projects().find((p) => p.id === page.id);
    if (!shown) return;
    const mineNow = page.data.project;
    if (shown.updated === mineNow.updated && shown.name === mineNow.name && shown.folderMissing === mineNow.folderMissing) return;
    if (page.editing.size || page.syncing) return;
    page.syncing = true;
    const fresh = await page.api.project(page.id).catch(() => null);
    const me = page;
    if (!me || me !== page || !fresh) { if (me) me.syncing = false; return; }
    me.syncing = false;
    if (me.editing.size) return;
    me.data.project = fresh.project;
    me.data.files = fresh.files;
    me.data.totals = fresh.totals;
    me.data.memory = fresh.memory;
    me.root.setAttribute('aria-label', fresh.project.name);
    const title = me.root.querySelector('.pjp-title');
    const desc = me.root.querySelector('.pjp-desc');
    if (title && document.activeElement !== title) title.value = fresh.project.name;
    if (desc && document.activeElement !== desc) desc.value = fresh.project.description || '';
    me.composerText?.setAttribute('placeholder', tr('projectws.compose.placeholder', 'Start a chat in {name}…', { name: fresh.project.name }));
    const folderBtn = me.root.querySelector('.pjp-open-folder');
    if (folderBtn) folderBtn.hidden = !fresh.project.folder;
    const next = [instructionsCard(me.data), filesCard(me.data), linksCard(me.data), folderCard(me.data), defaultsCard(me.data), memoryCard(me.data)];
    me.side.replaceChildren(...next);
    me.syncModel?.();
    me.sub?.();
  }

  window.chatProjectPage = { open, close, isOpen: () => Boolean(page), refresh, id: () => page?.id || null };
})();
