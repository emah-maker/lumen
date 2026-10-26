// lumen://chat > Projects: named groups of chats that share instructions (like Claude Projects and ChatGPT Projects). Only the page
// uses this file. The data lives in main (features/chat-store.js: `projects` and each chat's optional `project`); this draws the
// rail's Projects block, the editor (name and instructions) and the "Move to project" picker, and calls the chat page's api.
//   window.chatProjects.render({ host, projects, chats, active, expanded?, current?, onSelect(id|null), onToggle?(id), onOpen?(id), onAdd(), onEdit(project), onNewChat(project), onPage?(project), onInstructions?(project) })
//     onPage: the project's own page (chat-project-page.js: instructions, files, pinned pages, memory, defaults, chats); a click on a row opens it
//     onInstructions: the page with its instructions box in focus (the row's ⋯ menu)
//     expanded: Set of project ids shown open (their chats listed under them: rows to open, and to drag out: chat-project-drag.js)
//   window.chatProjects.editor({ api, project, onDone(result) })    result: { saved } or { removed }
//   window.chatProjects.picker({ api, chat, projects, anchor, onPick?(projectId|null), onDone(), onNew(), onClose?() })
(() => {
  const tr = (key, english, vars) => { const out = window.chatTr ? window.chatTr(key, english) : english; return vars ? out.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : out; };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>';
  const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
  const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
  const MORE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>';
  const NOTE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5h9M3.5 6.5h9M3.5 9.5h9M3.5 12.5h5"/></svg>';
  const PENCIL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h2.5L12.5 6 10 3.5 3 10.5z"/></svg>';
  const SHOWN_CHATS = 5; // chats listed under an open project; "Show all" opens its page
  const icon = (html) => { const s = el('span', { className: 'cp-pj-icon' }); s.innerHTML = html; return s; };

  // ---- the rail's block: a heading with +, then one row per project. A row is the project's name (opens its page), a count, and, on
  // hover or focus, "+" (new chat here) and "⋯" (open, new chat, instructions, rename and folder); the chevron lists its chats under it.
  function render({ host, projects, chats, active, expanded = new Set(), current = null, onSelect, onToggle = null, onOpen = null, onAdd, onEdit, onNewChat, onPage = null, onInstructions = null, onImport = null }) {
    const counts = new Map();
    for (const c of chats) if (c.project && !c.archived) counts.set(c.project, (counts.get(c.project) || 0) + 1);
    const head = el('div', { className: 'cp-pj-head' });
    const add = el('button', { type: 'button', className: 'icon-btn cp-pj-add', title: tr('chatpage.project.new', 'New project') });
    add.setAttribute('aria-label', tr('chatpage.project.new', 'New project'));
    add.innerHTML = PLUS;
    add.onclick = onAdd;
    const tools = el('span', { className: 'cp-pj-head-tools' });
    if (onImport) {
      const imp = el('button', { type: 'button', className: 'icon-btn cp-pj-add cp-pj-import', title: tr('projectws.import', 'Open folder as project…') });
      imp.setAttribute('aria-label', tr('projectws.import', 'Open folder as project…'));
      imp.innerHTML = FOLDER;
      imp.onclick = onImport;
      tools.append(imp);
    }
    tools.append(add);
    head.append(el('span', { className: 'cp-pj-title', textContent: tr('chatpage.projects', 'Projects') }), tools);
    const rows = [head];
    for (const p of projects) {
      const on = p.id === active;
      const open = expanded.has(p.id);
      const wrap = el('div', { className: `cp-pj-item${open ? ' open' : ''}` });
      wrap.dataset.project = p.id;
      const row = el('button', { type: 'button', className: `cp-pj${on ? ' on' : ''}`, title: p.name });
      row.dataset.id = p.id;
      if (p.folderMissing) { row.title = `${p.name}: ${tr('chatpage.project.folder.missing', 'Folder missing')}`; row.classList.add('folder-missing'); } // [project folders] Locate… / Recreate are in the project's editor
      if (on) row.setAttribute('aria-current', 'page');
      row.append(icon(FOLDER), el('span', { className: 'cp-pj-name', textContent: p.name }), el('span', { className: 'cp-pj-count', textContent: counts.get(p.id) ? String(counts.get(p.id)) : '' }));
      row.onclick = () => (onPage ? onPage(p) : onSelect?.(on ? null : p.id));
      wrap.append(row);
      if (onToggle) {
        const chev = el('button', { type: 'button', className: 'cp-pj-chev', title: tr(open ? 'chatpage.project.collapse' : 'chatpage.project.expand', open ? 'Hide chats' : 'Show chats') });
        chev.setAttribute('aria-label', `${tr(open ? 'chatpage.project.collapse' : 'chatpage.project.expand', open ? 'Hide chats' : 'Show chats')}: ${p.name}`);
        chev.setAttribute('aria-expanded', String(open));
        chev.innerHTML = CHEVRON;
        chev.onclick = (e) => { e.stopPropagation(); onToggle(p.id); };
        wrap.append(chev);
      }
      // the hover actions, at the row's right (over its count)
      const tools = el('div', { className: 'cp-pj-tools' });
      const fresh = el('button', { type: 'button', className: 'icon-btn cp-pj-new', title: tr('chatpage.project.newChat', 'New chat here') });
      fresh.setAttribute('aria-label', `${tr('chatpage.project.newChat', 'New chat here')}: ${p.name}`);
      fresh.innerHTML = PLUS;
      fresh.onclick = (e) => { e.stopPropagation(); onNewChat(p); };
      const more = el('button', { type: 'button', className: 'icon-btn cp-pj-more', title: tr('chats.more', 'More actions') });
      more.setAttribute('aria-label', `${tr('chats.more', 'More actions')}: ${p.name}`);
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.innerHTML = MORE;
      more.onclick = (e) => {
        e.stopPropagation();
        const items = [];
        if (onPage) items.push({ label: tr('projectws.open', 'Open project'), icon: FOLDER, run: () => onPage(p) });
        items.push({ label: tr('chatpage.project.newChat', 'New chat here'), icon: PLUS, run: () => onNewChat(p) });
        if (p.folderMissing) items.push({ label: tr('chatpage.project.folder.missingFix', 'Folder missing…'), icon: FOLDER, run: () => onEdit(p) });
        items.push({ label: tr(p.instructions ? 'chatpage.project.instructions' : 'chatpage.project.addInstructions', p.instructions ? 'Instructions' : 'Add instructions'), icon: NOTE, run: () => (onInstructions ? onInstructions(p) : onEdit(p)) });
        items.push({ label: tr('chatpage.project.renameFolder.menu', 'Rename and folder…'), icon: PENCIL, run: () => onEdit(p) });
        wrap.classList.add('menu-open');
        more.setAttribute('aria-expanded', 'true');
        menu({ anchor: more, label: p.name, items, onClose: () => { wrap.classList.remove('menu-open'); more.setAttribute('aria-expanded', 'false'); if (!document.activeElement || document.activeElement === document.body) more.focus(); } });
      };
      tools.append(fresh, more);
      wrap.append(tools);
      rows.push(wrap);
      if (open && onOpen) {
        const list = el('div', { className: 'cp-pj-chats' });
        list.dataset.project = p.id;
        const mine = chats.filter((c) => c.project === p.id && !c.archived);
        for (const c of mine.slice(0, SHOWN_CHATS)) {
          const b = el('button', { type: 'button', className: `cp-pj-chat${c.id === current ? ' current' : ''}`, title: c.title || '' });
          b.dataset.id = c.id;
          b.append(el('span', { className: 'cp-pj-chat-title', textContent: c.title || tr('chats.untitled', 'Chat') }));
          b.onclick = () => onOpen(c.id);
          list.append(b);
        }
        if (mine.length > SHOWN_CHATS && onPage) { // (the rest are on the project's page)
          const all = el('button', { type: 'button', className: 'cp-pj-all', textContent: tr('projectws.rail.all', 'Show all ({n})', { n: mine.length }) });
          all.setAttribute('aria-label', `${all.textContent}: ${p.name}`);
          all.onclick = () => onPage(p);
          list.append(all);
        }
        if (!mine.length) list.append(el('p', { className: 'cp-pj-chats-empty', textContent: tr('chatpage.project.emptyShort', 'No chats yet. Drag one here.') }));
        rows.push(list);
      }
    }
    host.hidden = false;
    host.classList.toggle('empty', !projects.length);
    host.replaceChildren(...rows);
  }

  // A small menu next to a button: items are { label, icon, run }. Arrow keys move, Escape closes (focus goes back), a click away closes.
  function menu({ anchor, label, items, onClose = null }) {
    document.querySelector('.cp-pj-pick.cp-pj-actions')?.remove();
    const box = el('div', { className: 'cp-pj-pick cp-pj-actions' });
    box.setAttribute('role', 'menu');
    box.setAttribute('aria-label', label);
    for (const it of items) {
      const b = el('button', { type: 'button', className: 'cp-pj-pick-item' });
      b.setAttribute('role', 'menuitem');
      b.append(icon(it.icon), el('span', { className: 'cp-pj-pick-label', textContent: it.label }));
      b.onclick = () => { close(); it.run(); };
      box.append(b);
    }
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    const h = box.offsetHeight;
    box.style.left = `${Math.max(8, Math.min(r.right - box.offsetWidth, window.innerWidth - box.offsetWidth - 8))}px`;
    box.style.top = `${r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
    const close = () => { const was = box.isConnected; box.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); if (was) onClose?.(); };
    const away = (e) => { if (!box.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
    const key = (e) => {
      const list = [...box.querySelectorAll('button')];
      const at = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus(); }
      else if (e.key === 'Tab') close();
    };
    setTimeout(() => document.addEventListener('pointerdown', away, true));
    document.addEventListener('keydown', key, true);
    box.querySelector('button')?.focus();
    return close;
  }

  // ---- the editor: a small dialog over the page
  // [project folders] Besides the name and instructions it shows the project's real folder (made when the project is, or an existing one
  // picked), whether chats are saved in it as Markdown (plain files: said here), the folder the AI works in, and "Folder missing" with
  // Locate… and Recreate. Renaming a project whose folder Lumen made offers to rename the folder too.
  function editor({ api, project, onDone }) {
    document.querySelector('.cp-pj-dialog')?.remove();
    const back = el('div', { className: 'cp-pj-dialog' });
    const box = el('form', { className: 'cp-pj-box' });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const heading = el('h2', { textContent: project ? tr('chatpage.project.edit', 'Project') : tr('chatpage.project.new', 'New project') });
    box.setAttribute('aria-label', heading.textContent);
    const name = el('input', { type: 'text', className: 'cp-pj-input', maxLength: 60, value: project?.name || '', placeholder: tr('chatpage.project.name', 'Project name') });
    name.setAttribute('aria-label', tr('chatpage.project.name', 'Project name'));
    const text = el('textarea', { className: 'cp-pj-text', rows: 7, maxLength: 4000, value: project?.instructions || '', placeholder: tr('chatpage.project.hint', 'How should the AI work in this project? For example: answer in a formal tone, or the audience is first-year students.') });
    text.setAttribute('aria-label', tr('chatpage.project.instructions', 'Instructions'));
    const note = el('p', { className: 'cp-pj-note', textContent: tr('chatpage.project.note', 'Sent to the AI with every chat in this project. Chats you move out of it stop using them.') });
    note.setAttribute('role', 'status');
    const row = el('div', { className: 'cp-pj-buttons' });
    const save = el('button', { type: 'submit', className: 'btn primary', textContent: tr('chatpage.project.save', 'Save') });
    const cancel = el('button', { type: 'button', className: 'btn', textContent: tr('chatpage.project.cancel', 'Cancel') });
    row.append(cancel, save);
    let current = project; // (the project as it is now: Locate, Recreate and the rest answer with a newer copy)
    let pickedFolder = null; // a folder picked in this dialog, saved with Save (new project: instead of making one; edit: instead of the current one)
    let confirmed = false; // the home folder or a drive was named: the next Save uses it
    let mirrorOn = project ? project.mirror !== false : true;
    let portableOn = project ? project.portable === true : true; // (a new project's folder keeps its instructions and sources as plain files)
    const small = (label, run, props = {}) => { const b = el('button', { type: 'button', className: 'btn small', textContent: label, ...props }); b.onclick = run; return b; };

    // ---- the folder section
    const folderBox = el('div', { className: 'cp-pj-folder' });
    const folderNote = el('p', { className: 'cp-pj-warn' });
    folderNote.setAttribute('role', 'status');
    const say = (msg) => { folderNote.textContent = msg || ''; };
    const reasonText = (r) => ({
      home: tr('chatpage.project.folder.home', 'That is your home folder. Click Save again to use it anyway.'),
      root: tr('chatpage.project.folder.root', 'That is a whole drive. Click Save again to use it anyway.'),
      missing: tr('chatpage.project.folder.gone', 'That folder is not there.'),
      'not-folder': tr('chatpage.project.folder.notFolder', 'That is not a folder.'),
      invalid: tr('chatpage.project.folder.invalid', 'That folder cannot be used.'),
    }[r] || tr('chatpage.project.folder.failed', 'Could not use that folder.'));
    function drawFolder() {
      const parts = [el('h3', { textContent: tr('chatpage.project.folder', 'Folder') })];
      const shown = pickedFolder || current?.folder || '';
      if (shown) {
        const missing = !pickedFolder && current?.folderMissing;
        parts.push(el('p', { className: `cp-pj-path${missing ? ' missing' : ''}`, textContent: missing ? `${tr('chatpage.project.folder.missing', 'Folder missing')}: ${shown}` : shown }));
        const line = el('div', { className: 'cp-pj-line' });
        if (current && !pickedFolder) {
          if (missing) {
            line.append(small(tr('chatpage.project.folder.locate', 'Locate…'), async () => {
              const out = await api.projectFolder(current.id, 'locate').catch(() => null);
              if (out?.ok && out.project) { current = out.project; say(''); drawFolder(); } else if (out && out.reason !== 'canceled') say(reasonText(out.reason));
            }));
            line.append(small(tr('chatpage.project.folder.recreate', 'Recreate'), async () => {
              const out = await api.projectFolder(current.id, 'recreate').catch(() => null);
              if (out?.ok) { current = { ...current, folderMissing: false }; say(''); drawFolder(); } else say(tr('chatpage.project.folder.recreateFailed', 'Could not make the folder again.'));
            }));
          } else line.append(small(tr('chatpage.project.folder.open', 'Open folder'), () => api.projectFolder(current.id, 'open').catch(() => null)));
        }
        line.append(small(project ? tr('chatpage.project.folder.other', 'Use a different folder…') : tr('chatpage.project.folder.again', 'Make a new folder instead'), async () => {
          if (!project && pickedFolder) { pickedFolder = null; confirmed = false; drawFolder(); return; }
          const dir = await api.pickProjectFolder().catch(() => null);
          if (dir) { pickedFolder = dir; confirmed = false; say(''); drawFolder(); }
        }));
        parts.push(line);
      } else if (!project) {
        parts.push(el('p', { className: 'cp-pj-path', textContent: tr('chatpage.project.folder.new', 'A new folder with the project’s name is made in your Projects folder (Settings → AI and agents).') }));
        parts.push(el('div', { className: 'cp-pj-line' }, small(tr('chatpage.project.folder.existing', 'Use an existing folder…'), async () => {
          const dir = await api.pickProjectFolder().catch(() => null);
          if (dir) { pickedFolder = dir; confirmed = false; say(''); drawFolder(); }
        })));
      } else {
        parts.push(el('p', { className: 'cp-pj-path', textContent: tr('chatpage.project.folder.none', 'This project has no folder yet.') }));
        parts.push(el('div', { className: 'cp-pj-line' },
          small(tr('chatpage.project.folder.make', 'Make a folder'), () => { makeFolder = true; say(tr('chatpage.project.folder.willMake', 'A folder is made when you save.')); }),
          small(tr('chatpage.project.folder.existing', 'Use an existing folder…'), async () => {
            const dir = await api.pickProjectFolder().catch(() => null);
            if (dir) { pickedFolder = dir; confirmed = false; say(''); drawFolder(); }
          })));
      }
      // chats as Markdown files
      const check = el('label', { className: 'cp-pj-check' });
      const input = el('input', { type: 'checkbox', checked: mirrorOn });
      input.onchange = () => { mirrorOn = input.checked; };
      check.append(input, el('span', { textContent: tr('chatpage.project.mirror', 'Save chats as Markdown files in this folder') }));
      parts.push(check);
      // instructions, sources and settings as plain files (INSTRUCTIONS.md, AGENTS.md, sources.md, Sources/, project.json)
      const plain = el('label', { className: 'cp-pj-check cp-pj-portable' });
      const plainInput = el('input', { type: 'checkbox', checked: portableOn });
      plainInput.onchange = () => { portableOn = plainInput.checked; plainNote.hidden = !portableOn; };
      plain.append(plainInput, el('span', { textContent: tr('projectws.portable', 'Keep instructions and sources as plain files in this folder') }));
      const plainNote = el('p', { className: 'cp-pj-note', hidden: !portableOn, textContent: tr('projectws.portable.note', 'INSTRUCTIONS.md and AGENTS.md (the name coding agents look for), sources.md, project.json and the files you add in Sources/. They are plain files and are not encrypted: anyone who can open the folder can read them. Lumen reads them again when you change them in another program. Files already added keep only their text, encrypted in Lumen; they are not copied out.') });
      parts.push(plain, plainNote);
      parts.push(el('p', { className: 'cp-pj-note', textContent: tr('chatpage.project.mirror.note', 'These files are plain text and are not encrypted: anyone who can open the folder can read them. Chats outside projects are never saved this way. They go in a Chats folder; a chat moved out of the project goes to Chats/Removed, a deleted one to Chats/Deleted.') }));
      if (current?.folder && !pickedFolder) {
        const status = el('span', { className: 'cp-pj-note' });
        status.setAttribute('role', 'status');
        parts.push(el('div', { className: 'cp-pj-line' }, small(tr('chatpage.project.mirror.all', 'Write all now'), async (e) => {
          e.currentTarget.disabled = true;
          status.textContent = tr('chatpage.project.mirror.writing', 'Writing…');
          const out = await api.projectFolder(current.id, 'write-all').catch(() => null);
          e.currentTarget.disabled = false;
          status.textContent = out?.ok ? tr('chatpage.project.mirror.done', 'Wrote {n} chats.', { n: out.count }) : tr('chatpage.project.mirror.failed', 'Could not write the chats.');
        }), status));
      }
      // where the AI works
      if (current) {
        const here = current.workFolder || current.folder || '';
        parts.push(el('p', { className: 'cp-pj-note', textContent: here ? `${tr('chatpage.project.work', 'The AI works in')}: ${here}` : tr('chatpage.project.work.none', 'The AI has no working folder in this project.') }));
        const line = el('div', { className: 'cp-pj-line' }, small(tr('chatpage.project.work.change', 'Change working folder…'), async () => {
          const out = await api.projectFolder(current.id, 'work').catch(() => null);
          if (out?.ok && out.project) { current = out.project; say(''); drawFolder(); return; }
          if (out?.reason === 'home' || out?.reason === 'root') {
            say(reasonText(out.reason).replace(/ Click Save again.*/, ''));
            const sure = small(tr('chatpage.project.work.anyway', 'Use it anyway'), async () => {
              const again = await api.saveProject({ id: current.id, name: current.name, workFolder: out.path, confirmedWork: true }).catch(() => null);
              if (again && !again.error) { current = again; say(''); drawFolder(); }
            });
            folderBox.append(sure);
          } else if (out && out.reason !== 'canceled') say(reasonText(out.reason));
        }));
        if (current.workFolder) line.append(small(tr('chatpage.project.work.reset', 'Use the project folder'), async () => {
          const out = await api.projectFolder(current.id, 'work-clear').catch(() => null);
          if (out?.ok && out.project) { current = out.project; drawFolder(); }
        }));
        parts.push(line);
      }
      parts.push(folderNote);
      folderBox.replaceChildren(...parts);
    }
    let makeFolder = false;
    drawFolder();

    if (project) {
      const del = el('button', { type: 'button', className: 'btn cp-pj-delete', textContent: tr('chatpage.project.delete', 'Delete project') });
      let armed = false;
      del.onclick = async () => {
        if (!armed) { armed = true; del.textContent = tr('chatpage.project.deleteConfirm', 'Click again: its chats and its folder stay'); setTimeout(() => { armed = false; del.textContent = tr('chatpage.project.delete', 'Delete project'); }, 4000); return; }
        del.disabled = true;
        const ok = await api.removeProject(project.id).catch(() => false);
        if (ok) { close(); onDone({ removed: project.id }); } else del.disabled = false;
      };
      row.prepend(del);
    }
    box.append(heading, name, text, note, folderBox, row);
    back.append(box);
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); onDone({}); }
      else if (e.key === 'Tab') { // (the dialog keeps focus)
        const f = [...box.querySelectorAll('input, textarea, button:not(:disabled)')];
        const at = f.indexOf(document.activeElement);
        if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && at === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) { close(); onDone({}); } });
    cancel.onclick = () => { close(); onDone({}); };

    // Renaming a project whose folder Lumen made: offer to rename the folder to match (never when something is in the way: it keeps its name).
    function offerRename(saved) {
      const heading2 = el('h2', { textContent: tr('chatpage.project.renameFolder', 'Rename the folder too?') });
      const msg = el('p', { className: 'cp-pj-note', textContent: tr('chatpage.project.renameFolder.note', 'The project’s folder is {path}. Rename it to match the new name? Nothing in it changes.', { path: saved.folder }) });
      msg.setAttribute('role', 'status');
      const keep = el('button', { type: 'button', className: 'btn', textContent: tr('chatpage.project.renameFolder.keep', 'Keep the folder name') });
      const yes = el('button', { type: 'button', className: 'btn primary', textContent: tr('chatpage.project.renameFolder.yes', 'Rename folder') });
      const done = () => { close(); onDone({ saved }); };
      keep.onclick = done;
      yes.onclick = async () => {
        yes.disabled = keep.disabled = true;
        const out = await api.projectFolder(saved.id, 'rename').catch(() => null);
        if (out?.ok) { if (out.project) saved = out.project; done(); return; }
        msg.textContent = out?.reason === 'exists' ? tr('chatpage.project.renameFolder.exists', 'A folder with that name is already there, so the folder keeps its name.')
          : out?.reason === 'busy' ? tr('chatpage.project.renameFolder.busy', 'The folder is in use (open in another program?), so it keeps its name.')
            : tr('chatpage.project.renameFolder.no', 'The folder keeps its name.');
        keep.textContent = tr('chatpage.project.renameFolder.close', 'Close');
        keep.disabled = false;
        yes.remove();
      };
      box.replaceChildren(heading2, msg, el('div', { className: 'cp-pj-buttons' }, keep, yes));
      yes.focus();
    }
    box.onsubmit = async (e) => {
      e.preventDefault();
      if (!name.value.trim()) { name.focus(); return; }
      save.disabled = true;
      const payload = { id: project?.id, name: name.value, instructions: text.value, mirror: mirrorOn, portable: portableOn };
      if (!project) { if (pickedFolder) { payload.folderMode = 'existing'; payload.folder = pickedFolder; payload.confirmed = confirmed; } }
      else if (pickedFolder) { payload.folder = pickedFolder; payload.confirmed = confirmed; }
      else if (makeFolder && !project.folder) payload.folderMode = 'new';
      const out = await api.saveProject(payload).catch(() => null);
      if (out?.error) {
        save.disabled = false;
        if (out.error === 'home' || out.error === 'root') confirmed = true;
        say(reasonText(out.error));
        return;
      }
      if (!out) { save.disabled = false; note.textContent = tr('chatpage.project.failed', 'Could not save the project.'); return; }
      if (project?.folderCreated && !pickedFolder && !current?.folderMissing && out.folder && out.name !== project.name) { offerRename(out); return; }
      close();
      onDone({ saved: out });
    };
    document.body.append(back);
    name.focus();
  }

  // ---- "Move to project" from a chat row's menu: a small list next to it
  function picker({ api, chat, projects, anchor, onPick = null, onDone, onNew, onClose = null }) {
    document.querySelector('.cp-pj-pick')?.remove();
    const menu = el('div', { className: 'cp-pj-pick' });
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', tr('chatpage.project.move', 'Move to project'));
    const item = (label, on, run, className = '') => {
      const b = el('button', { type: 'button', className: `cp-pj-pick-item ${className}`.trim(), textContent: label });
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(on));
      b.onclick = async () => { close(); await run(); };
      return b;
    };
    const set = (id) => async () => { if (onPick) await onPick(id); else { await api.setProject(chat.id, id).catch(() => false); onDone(); } };
    for (const p of projects) menu.append(item(p.name, p.id === chat.project, set(p.id)));
    if (chat.project) menu.append(item(tr('chatpage.project.none', 'Remove from project'), false, set(null), 'none'));
    menu.append(item(tr('chatpage.project.newEllipsis', 'New project…'), false, async () => onNew(chat), 'new'));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
    const close = () => { const was = menu.isConnected; menu.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); if (was) onClose?.(); };
    const away = (e) => { if (!menu.contains(e.target)) close(); };
    const key = (e) => {
      const list = [...menu.querySelectorAll('button')];
      const at = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus(); }
    };
    setTimeout(() => document.addEventListener('pointerdown', away, true));
    document.addEventListener('keydown', key, true);
    menu.querySelector('button')?.focus();
  }

  window.chatProjects = { render, editor, picker, menu };
})();
