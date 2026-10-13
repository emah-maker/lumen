// lumen://chat > Projects: named groups of chats that share instructions (like Claude Projects and ChatGPT Projects). Only the page
// uses this file. The data lives in main (features/chat-store.js: `projects` and each chat's optional `project`); this draws the
// rail's Projects block, the editor (name and instructions) and the "Move to project" picker, and calls the chat page's api.
//   window.chatProjects.render({ host, projects, chats, active, expanded?, current?, onSelect(id|null), onToggle?(id), onOpen?(id), onAdd(), onEdit(project), onNewChat(project) })
//     expanded: Set of project ids shown open (their chats listed under them: rows to open, and to drag out: chat-project-drag.js)
//   window.chatProjects.editor({ api, project, onDone(result) })    result: { saved } or { removed }
//   window.chatProjects.picker({ api, chat, projects, anchor, onPick?(projectId|null), onDone(), onNew(), onClose?() })
(() => {
  const tr = (key, english) => (window.chatTr ? window.chatTr(key, english) : english);
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>';
  const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
  const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
  const icon = (html) => { const s = el('span', { className: 'cp-pj-icon' }); s.innerHTML = html; return s; };

  // ---- the rail's block: a heading with +, then one row per project; the chosen project's own actions sit under it
  function render({ host, projects, chats, active, expanded = new Set(), current = null, onSelect, onToggle = null, onOpen = null, onAdd, onEdit, onNewChat }) {
    const counts = new Map();
    for (const c of chats) if (c.project && !c.archived) counts.set(c.project, (counts.get(c.project) || 0) + 1);
    const head = el('div', { className: 'cp-pj-head' });
    const add = el('button', { type: 'button', className: 'icon-btn cp-pj-add', title: tr('chatpage.project.new', 'New project') });
    add.setAttribute('aria-label', tr('chatpage.project.new', 'New project'));
    add.innerHTML = PLUS;
    add.onclick = onAdd;
    head.append(el('span', { className: 'cp-pj-title', textContent: tr('chatpage.projects', 'Projects') }), add);
    const rows = [head];
    for (const p of projects) {
      const on = p.id === active;
      const open = expanded.has(p.id);
      const wrap = el('div', { className: `cp-pj-item${open ? ' open' : ''}` });
      wrap.dataset.project = p.id;
      const row = el('button', { type: 'button', className: `cp-pj${on ? ' on' : ''}`, title: p.name });
      row.dataset.id = p.id;
      row.setAttribute('aria-pressed', String(on));
      row.append(icon(FOLDER), el('span', { className: 'cp-pj-name', textContent: p.name }), el('span', { className: 'cp-pj-count', textContent: counts.get(p.id) ? String(counts.get(p.id)) : '' }));
      row.onclick = () => onSelect(on ? null : p.id);
      wrap.append(row);
      if (onToggle) {
        const chev = el('button', { type: 'button', className: 'cp-pj-chev', title: tr(open ? 'chatpage.project.collapse' : 'chatpage.project.expand', open ? 'Hide chats' : 'Show chats') });
        chev.setAttribute('aria-label', `${tr(open ? 'chatpage.project.collapse' : 'chatpage.project.expand', open ? 'Hide chats' : 'Show chats')}: ${p.name}`);
        chev.setAttribute('aria-expanded', String(open));
        chev.innerHTML = CHEVRON;
        chev.onclick = (e) => { e.stopPropagation(); onToggle(p.id); };
        wrap.append(chev);
      }
      rows.push(wrap);
      if (open && onOpen) {
        const list = el('div', { className: 'cp-pj-chats' });
        list.dataset.project = p.id;
        const mine = chats.filter((c) => c.project === p.id && !c.archived);
        for (const c of mine) {
          const b = el('button', { type: 'button', className: `cp-pj-chat${c.id === current ? ' current' : ''}`, title: c.title || '' });
          b.dataset.id = c.id;
          b.append(el('span', { className: 'cp-pj-chat-title', textContent: c.title || tr('chats.untitled', 'Chat') }));
          b.onclick = () => onOpen(c.id);
          list.append(b);
        }
        if (!mine.length) list.append(el('p', { className: 'cp-pj-chats-empty', textContent: tr('chatpage.project.emptyShort', 'No chats yet. Drag one here.') }));
        rows.push(list);
      }
      if (on) {
        const bar = el('div', { className: 'cp-pj-bar' });
        const instr = el('button', { type: 'button', className: 'cp-pj-act', textContent: tr(p.instructions ? 'chatpage.project.instructions' : 'chatpage.project.addInstructions', p.instructions ? 'Instructions' : 'Add instructions') });
        instr.onclick = () => onEdit(p);
        const fresh = el('button', { type: 'button', className: 'cp-pj-act', textContent: tr('chatpage.project.newChat', 'New chat here') });
        fresh.onclick = () => onNewChat(p);
        bar.append(fresh, instr);
        rows.push(bar);
      }
    }
    host.hidden = false;
    host.classList.toggle('empty', !projects.length);
    host.replaceChildren(...rows);
  }

  // ---- the editor: a small dialog over the page
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
    const row = el('div', { className: 'cp-pj-buttons' });
    const save = el('button', { type: 'submit', className: 'btn primary', textContent: tr('chatpage.project.save', 'Save') });
    const cancel = el('button', { type: 'button', className: 'btn', textContent: tr('chatpage.project.cancel', 'Cancel') });
    row.append(cancel, save);
    if (project) {
      const del = el('button', { type: 'button', className: 'btn cp-pj-delete', textContent: tr('chatpage.project.delete', 'Delete project') });
      let armed = false;
      del.onclick = async () => {
        if (!armed) { armed = true; del.textContent = tr('chatpage.project.deleteConfirm', 'Click again: its chats stay'); setTimeout(() => { armed = false; del.textContent = tr('chatpage.project.delete', 'Delete project'); }, 4000); return; }
        del.disabled = true;
        const ok = await api.removeProject(project.id).catch(() => false);
        if (ok) { close(); onDone({ removed: project.id }); } else del.disabled = false;
      };
      row.prepend(del);
    }
    box.append(heading, name, text, note, row);
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
    box.onsubmit = async (e) => {
      e.preventDefault();
      if (!name.value.trim()) { name.focus(); return; }
      save.disabled = true;
      const out = await api.saveProject({ id: project?.id, name: name.value, instructions: text.value }).catch(() => null);
      if (out) { close(); onDone({ saved: out }); } else { save.disabled = false; note.textContent = tr('chatpage.project.failed', 'Could not save the project.'); }
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

  window.chatProjects = { render, editor, picker };
})();
