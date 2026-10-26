// lumen://chat > Projects > Open project: a project as a workspace for the AI (like Claude and ChatGPT projects, but it knows the browser).
// Loaded the first time a project is opened (chat-page.js adds this script and chat-project-page.css then), never with the page.
//   window.chatProjectPage.open({ api, id, host, focus? })   focus: 'instructions' puts the cursor in the instructions box
//     host: { chats(), projects(), openChat(id), newChat(project, text?), editFolder(project), moveChats(ids, projectId), moveToNewProject(chat), cleared?(),
//             undoToast(text, ms, undo), toast(text), models() -> [{ value, label }], closed(), refresh() }
//   window.chatProjectPage.close() / .isOpen() / .refresh()
// What it shows: a box that starts a chat in the project, its chats (pin, move, delete; a search looks in the chats and the files), and
// beside them the setup: its instructions (written in place), files (read on this computer into text the AI can search and read), pinned
// pages, folder, the defaults a new chat starts with, and what the AI saved in its chats (memory).
(() => {
  const tr = (key, english, vars) => { const out = window.chatTr ? window.chatTr(key, english) : english; return vars ? out.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : out; };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const KIND = { pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint', eml: 'Email', text: 'Text', image: 'Picture' };
  const ACCEPT = '.pdf,.docx,.pptx,.eml,.txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.yaml,.yml,.html,.htm,.rtf,.tex,.bib,.py,.js,.ts,.java,.c,.cpp,.h,.cs,.go,.rs,.rb,.sql,.ini,.toml,.png,.jpg,.jpeg,.gif,.webp';
  const MAX_BYTES = 60 * 1024 * 1024;

  let page = null; // { root, id, ... } while a project page is open

  const host = () => page.host;
  const card = (title, ...kids) => {
    const c = el('section', { className: 'pjp-card' });
    c.append(el('h2', { className: 'pjp-h', textContent: title }), ...kids);
    return c;
  };
  const note = (text) => el('p', { className: 'pjp-note', textContent: text });
  const status = () => { const s = el('p', { className: 'pjp-status' }); s.setAttribute('role', 'status'); return s; };
  const button = (label, run, className = '') => { const b = el('button', { type: 'button', className: `btn small ${className}`.trim(), textContent: label }); b.onclick = run; return b; };
  // A button that needs a second click ("Remove" > "Click again to remove").
  const twoStep = (label, again, run, className = '') => {
    const b = button(label, () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = again; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = label; } }, 4000); return; }
      b.disabled = true;
      run();
    }, className);
    return b;
  };

  // ---- instructions: written in place (a click in the box and type; it is saved when the box loses focus or with Save)
  function instructionsCard(data) {
    const { limits } = data;
    const text = el('textarea', { className: 'pjp-text', rows: 6, maxLength: limits.instructions, value: data.project.instructions || '', placeholder: tr('chatpage.project.hint', 'How should the AI work in this project? For example: answer in a formal tone, or the audience is first-year students.') });
    text.setAttribute('aria-label', tr('chatpage.project.instructions', 'Instructions'));
    const say = status();
    const count = el('span', { className: 'pjp-count' });
    let saved = text.value;
    const fit = () => { text.style.height = 'auto'; text.style.height = `${Math.min(Math.max(text.scrollHeight + 2, 120), 360)}px`; };
    const dirty = () => text.value !== saved;
    const save = button(tr('chatpage.project.save', 'Save'), async () => {
      if (!dirty()) return;
      save.disabled = true;
      const sending = text.value;
      const out = await page.api.saveProject({ id: page.id, name: data.project.name, instructions: sending }).catch(() => null);
      save.disabled = false;
      if (out && !out.error) { data.project = out; saved = sending; say.textContent = tr('projectws.saved', 'Saved.'); } else say.textContent = tr('chatpage.project.failed', 'Could not save the project.');
      show();
      if (out && !out.error) host().refresh();
    }, 'primary');
    save.classList.add('pjp-save');
    const show = () => {
      save.hidden = !dirty();
      count.textContent = `${text.value.length.toLocaleString()} / ${limits.instructions.toLocaleString()}`;
    };
    text.addEventListener('input', () => { say.textContent = ''; show(); fit(); });
    text.addEventListener('blur', () => { if (dirty()) save.click(); });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !isImeEnter(e)) { e.preventDefault(); save.click(); } });
    show();
    queueMicrotask(fit);
    const root = card(tr('chatpage.project.instructions', 'Instructions'), text,
      el('div', { className: 'pjp-line pjp-between' }, el('div', { className: 'pjp-line' }, save, say), count),
      note(tr('projectws.instructions.note', 'Sent to the AI with every chat in this project, on every model. Up to {n} characters. Together with the list of files and pages below, about {m} characters go with each message; anything longer is cut.', { n: limits.instructions, m: limits.instructions + limits.index })));
    root.classList.add('pjp-instructions');
    root.fit = fit;
    return root;
  }

  // ---- files
  function filesCard(data) {
    const body = el('div', { className: 'pjp-files' });
    const say = status();
    const input = el('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true, tabIndex: -1 });
    input.setAttribute('aria-hidden', 'true');
    const total = el('p', { className: 'pjp-note' });
    const list = el('ul', { className: 'pjp-list' });
    list.setAttribute('aria-label', tr('projectws.files', 'Files'));
    function draw(files, totals) {
      data.files = files;
      list.replaceChildren(...files.map((f) => {
        const li = el('li', { className: 'pjp-row' });
        li.dataset.file = f.id;
        const info = el('div', { className: 'pjp-row-main' },
          el('span', { className: 'pjp-row-name', textContent: f.name }),
          el('span', { className: 'pjp-row-meta', textContent: [KIND[f.kind] || f.kind, kb(f.size || 0), f.chars ? tr('projectws.chars', '{n} characters', { n: f.chars.toLocaleString() }) : ''].filter(Boolean).join(' · ') + (f.cut ? ` · ${tr('projectws.cut', 'cut: very long')}` : '') }));
        if (f.summary) info.append(el('span', { className: 'pjp-row-sum', textContent: f.summary }));
        li.append(info, twoStep(tr('projectws.remove', 'Remove'), tr('projectws.removeAgain', 'Click again to remove'), async () => {
          const out = await page.api.projectFileRemove(page.id, f.id).catch(() => null);
          if (out) draw(out.files, out.totals); else { say.textContent = tr('projectws.removeFailed', 'Could not remove the file.'); li.querySelector('button').disabled = false; }
        }));
        return li;
      }));
      total.textContent = files.length ? tr('projectws.totals', '{n} of {max} files. Read on this computer; kept encrypted in your Lumen profile, never uploaded.', { n: files.length, max: data.limits.files }) : tr('projectws.empty.files', 'No files yet. Add PDFs, Word and PowerPoint files, emails, text, Markdown, CSV or pictures, and the AI can search and read them in every chat of this project.');
    }
    async function add(fileList) {
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
        draw(out.files, out.totals);
      }
      say.textContent = [done ? tr('projectws.added', 'Added {n}.', { n: done }) : '', ...problems].filter(Boolean).join(' ');
      host().refresh();
    }
    input.onchange = () => { const picked = [...input.files]; input.value = ''; add(picked); };
    const drop = el('div', { className: 'pjp-drop' }, tr('projectws.drop', 'Drop files here'));
    const choose = button(tr('projectws.addFiles', 'Add files…'), () => input.click(), 'primary');
    const root = card(tr('projectws.files', 'Files'), body);
    body.append(el('div', { className: 'pjp-line' }, choose, drop), list, total, say, input);
    if (!data.keychain) body.prepend(note(tr('projectws.nokeychain', 'Files need your system’s secure storage (the keychain), which is not available here, so they cannot be kept.')));
    for (const type of ['dragenter', 'dragover']) root.addEventListener(type, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); root.classList.add('dropping'); } });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('dropping'); });
    root.addEventListener('drop', (e) => { e.preventDefault(); root.classList.remove('dropping'); add(e.dataTransfer?.files || []); });
    draw(data.files, data.totals);
    return root;
  }

  // ---- pinned pages
  function linksCard(data) {
    const list = el('ul', { className: 'pjp-list' });
    list.setAttribute('aria-label', tr('projectws.pages', 'Pinned pages'));
    const say = status();
    const url = el('input', { type: 'url', className: 'pjp-input', placeholder: tr('projectws.pages.url', 'https://…') });
    url.setAttribute('aria-label', tr('projectws.pages.url.label', 'Web address to pin'));
    function draw(project) {
      data.project = project;
      const links = project.links || [];
      list.replaceChildren(...links.map((l) => {
        let shown = l.url;
        try { shown = new URL(l.url).host; } catch { /* the address itself */ }
        const li = el('li', { className: 'pjp-row' });
        li.dataset.url = l.url;
        li.append(el('div', { className: 'pjp-row-main' }, el('span', { className: 'pjp-row-name', textContent: l.title || shown }), el('span', { className: 'pjp-row-meta', textContent: l.url })),
          twoStep(tr('projectws.remove', 'Remove'), tr('projectws.removeAgain', 'Click again to remove'), async () => {
            const out = await page.api.projectLink(page.id, { remove: l.url }).catch(() => null);
            if (out && !out.error) draw(out); else li.querySelector('button').disabled = false;
          }));
        return li;
      }));
      if (!links.length) list.append(el('li', { className: 'pjp-empty', textContent: tr('projectws.empty.pages', 'No pages yet. Pin a page and the AI can read it when a chat needs it.') }));
    }
    const submit = async () => {
      const value = url.value.trim();
      if (!value) return;
      const out = await page.api.projectLink(page.id, { add: { url: /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`, title: '' } }).catch(() => null);
      if (out && !out.error) { url.value = ''; say.textContent = ''; draw(out); host().refresh(); } else say.textContent = out?.error === 'full' ? tr('projectws.pages.full', 'A project holds up to 25 pages.') : tr('projectws.pages.invalid', 'That is not a web address (http or https).');
    };
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); submit(); } });
    const tab = button(tr('projectws.pages.tab', 'Add this tab'), async () => {
      const out = await page.api.projectAddTab(page.id).catch(() => null);
      if (out?.ok) { draw(out.project); say.textContent = out.already ? tr('projectws.pages.already', 'That page is already pinned.') : tr('projectws.pages.added', 'Pinned.'); host().refresh(); }
      else say.textContent = out?.reason === 'full' ? tr('projectws.pages.full', 'A project holds up to 25 pages.') : tr('projectws.pages.notweb', 'The tab you are looking at is not a web page.');
    });
    draw(data.project);
    return card(tr('projectws.pages', 'Pinned pages'), list, el('div', { className: 'pjp-line' }, url, button(tr('projectws.pages.add', 'Pin'), submit), tab), say,
      note(tr('projectws.pages.note', 'The AI reads a pinned page when a chat needs it (it asks first if it has read other pages, as usual). Nothing is fetched until then.')));
  }

  // ---- defaults
  function defaultsCard(data) {
    const d = data.project.defaults || {};
    const models = (host().models?.() || []).filter((m) => m.value);
    const model = el('select', { className: 'pjp-select' });
    model.setAttribute('aria-label', tr('projectws.defaults.model', 'Model for new chats'));
    model.append(el('option', { value: '', textContent: tr('projectws.defaults.usual', 'My usual model') }));
    for (const m of models) model.append(el('option', { value: m.value, textContent: m.label }));
    if (d.model && !models.some((m) => m.value === d.model)) model.append(el('option', { value: d.model, textContent: d.model }));
    model.value = d.model || '';
    const check = (label, on) => { const input = el('input', { type: 'checkbox', checked: on }); return { input, label: el('label', { className: 'pjp-check' }, input, el('span', { textContent: label })) }; };
    const plan = check(tr('projectws.defaults.plan', 'Plan first: the AI only reads and shows a plan before it acts'), d.plan === true);
    const conn = check(tr('projectws.defaults.connectors', 'Let its chats use my connected accounts (Gmail, Canvas…)'), d.connectors !== false);
    const mcp = check(tr('projectws.defaults.mcp', 'Let its chats use my MCP servers’ tools'), d.mcp !== false);
    const say = status();
    const save = async () => {
      const out = await page.api.projectDefaults(page.id, { model: model.value, plan: plan.input.checked, connectors: conn.input.checked, mcp: mcp.input.checked }).catch(() => null);
      say.textContent = out ? tr('projectws.saved', 'Saved.') : tr('chatpage.project.failed', 'Could not save the project.');
      if (out) data.project = out;
    };
    for (const n of [model, plan.input, conn.input, mcp.input]) n.onchange = save;
    return card(tr('projectws.defaults', 'Defaults'),
      el('label', { className: 'pjp-field' }, el('span', { textContent: tr('projectws.defaults.model', 'Model for new chats') }), model), plan.label, conn.label, mcp.label, say,
      note(tr('projectws.defaults.note', 'A new chat in this project starts with these. The model and Plan first can still be changed in the chat. The tools of another chat are not affected.')));
  }

  // ---- memory
  function memoryCard(data) {
    const list = el('ul', { className: 'pjp-list' });
    list.setAttribute('aria-label', tr('projectws.memory', 'Memory'));
    const draw = (entries) => {
      list.replaceChildren(...entries.map((e) => {
        const li = el('li', { className: 'pjp-row' });
        li.dataset.memory = e.id;
        li.append(el('div', { className: 'pjp-row-main' }, el('span', { className: 'pjp-row-name', textContent: e.text })),
          twoStep(tr('projectws.forget', 'Forget'), tr('projectws.forgetAgain', 'Click again to forget'), async () => {
            const ok = await page.api.projectMemoryForget(page.id, e.id).catch(() => false);
            if (ok) { data.memory = data.memory.filter((x) => x.id !== e.id); draw(data.memory); } else li.querySelector('button').disabled = false;
          }));
        return li;
      }));
      if (!entries.length) list.append(el('li', { className: 'pjp-empty', textContent: data.memoryOn ? tr('projectws.empty.memory', 'Nothing saved for this project yet. What the AI saves in a chat of this project is kept here.') : tr('projectws.memory.off', 'Memory is off. Turn it on in Settings → AI and agents → Memory, and what the AI saves in this project’s chats is kept here.') }));
    };
    draw(data.memory);
    return card(tr('projectws.memory', 'Memory'), list, note(tr('projectws.memory.note', 'Saved in this project’s chats, so only its chats see it, next to your general memory.')));
  }

  // ---- folder: where the project lives on this computer (set up and changed in the project's editor, host.editFolder)
  function folderCard(data) {
    const p = data.project;
    const body = [];
    if (p.folder) {
      body.push(el('p', { className: `pjp-path${p.folderMissing ? ' missing' : ''}`, textContent: p.folderMissing ? `${tr('chatpage.project.folder.missing', 'Folder missing')}: ${p.folder}` : p.folder }));
      body.push(el('div', { className: 'pjp-line' },
        p.folderMissing ? button(tr('chatpage.project.folder.missingFix', 'Folder missing…'), () => host().editFolder(data.project), 'primary') : button(tr('chatpage.project.folder.open', 'Open folder'), () => page.api.projectFolder(page.id, 'open').catch(() => null)),
        button(tr('projectws.folder.change', 'Change…'), () => host().editFolder(data.project))));
      body.push(note(tr('projectws.folder.note', 'Chats of this project are saved here as Markdown files unless you turn that off in the project’s settings.')));
    } else {
      body.push(note(tr('chatpage.project.folder.none', 'This project has no folder yet.')));
      body.push(el('div', { className: 'pjp-line' }, button(tr('projectws.folder.add', 'Add a folder…'), () => host().editFolder(data.project))));
    }
    const root = card(tr('chatpage.project.folder', 'Folder'), ...body);
    root.classList.add('pjp-folder');
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
  const myChats = () => host().chats().filter((c) => c.project === page.id && !c.archived).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
  function chatRow(c) {
    const li = el('li', { className: `pjp-chat${c.pinned ? ' pinned' : ''}` });
    li.dataset.chat = c.id;
    const open = el('button', { type: 'button', className: 'pjp-chat-open' },
      el('span', { className: 'pjp-chat-title', textContent: c.title || tr('chats.untitled', 'Chat') }),
      el('span', { className: 'pjp-chat-when', textContent: [c.pinned ? tr('chats.pinned', 'Pinned') : '', when(c.updated)].filter(Boolean).join(' · ') }));
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
    const emptyState = el('div', { className: 'pjp-empty-state' },
      el('p', { className: 'pjp-empty-title', textContent: tr('projectws.chats.empty.title', 'No chats yet') }),
      el('p', { className: 'pjp-note', textContent: tr('projectws.chats.empty.text', 'Write above to start the first one. You can also drag a chat from the list onto this project, or use a chat’s ⋯ menu.') }));
    const draw = () => {
      const mine = myChats();
      list.replaceChildren(...mine.map(chatRow));
      emptyState.hidden = mine.length > 0;
      list.hidden = !mine.length;
      count.textContent = mine.length ? String(mine.length) : '';
      if (page.sub) page.sub();
    };
    page.list = list;
    page.redraw = draw;
    draw();
    root.append(head, search.out, list, emptyState);
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
      const mine = ++seq;
      page.list.hidden = Boolean(q) || !myChats().length;
      page.root.querySelector('.pjp-empty-state').hidden = Boolean(q) || myChats().length > 0;
      out.hidden = !q;
      if (!q) return;
      const lower = q.toLowerCase();
      const inProject = (id) => host().chats().some((c) => c.id === id && c.project === page.id);
      const [chatHits, fileHits] = await Promise.all([page.api.search(q).catch(() => []), page.api.projectSearch(page.id, q).catch(() => [])]);
      if (mine !== seq) return;
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

  // ---- the box that starts a chat in this project (Enter sends; the chat opens with the project's instructions, files and defaults)
  function composer(data) {
    const form = el('form', { className: 'pjp-composer' });
    const text = el('textarea', { className: 'pjp-compose-text', rows: 2, placeholder: tr('projectws.compose.placeholder', 'Start a chat in {name}…', { name: data.project.name }) });
    text.setAttribute('aria-label', tr('projectws.compose.label', 'Message for a new chat in this project'));
    const go = el('button', { type: 'submit', className: 'btn primary pjp-go', textContent: tr('projectws.compose.go', 'Start chat') });
    form.append(text, el('div', { className: 'pjp-compose-bar' }, el('span', { className: 'pjp-compose-hint', textContent: tr('projectws.compose.hint', 'Uses this project’s instructions, files and defaults.') }), go));
    form.onsubmit = (e) => { e.preventDefault(); go.disabled = true; const v = text.value; host().newChat(page.data.project, v); };
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isImeEnter(e)) { e.preventDefault(); form.requestSubmit(); } });
    page.composerText = text;
    return form;
  }

  // ---- the page: a header (name, counts, settings, delete), then two columns. Left: the box that starts a chat and the project's chats.
  // Right: instructions, files, pinned pages, folder, defaults, memory. One column on a narrow window.
  async function open({ api, id, host: h, focus = '' }) {
    close(false);
    const data = await api.project(id).catch(() => null);
    if (!data) return false;
    const root = el('section', { className: 'pjp', id: 'cp-project-page' });
    page = { api, id, host: h, root, data, list: null, redraw: null, sub: null, composerText: null };
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
    const sub = el('p', { className: 'pjp-sub' });
    page.sub = () => {
      const n = myChats().length;
      const f = (page.data.files || []).length;
      sub.textContent = [tr(n === 1 ? 'projectws.count.chat' : 'projectws.count.chats', n === 1 ? '{n} chat' : '{n} chats', { n }), f ? tr(f === 1 ? 'projectws.count.file' : 'projectws.count.files', f === 1 ? '{n} file' : '{n} files', { n: f }) : ''].filter(Boolean).join(' · ');
    };
    const settings = button(tr('projectws.folder', 'Folder and more…'), () => h.editFolder(data.project));
    const del = twoStep(tr('chatpage.project.delete', 'Delete project'), tr('projectws.deleteAgain', 'Click again: its chats stay'), async () => {
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
    const head = el('header', { className: 'pjp-head' }, back,
      el('div', { className: 'pjp-head-row' }, el('div', { className: 'pjp-head-text' }, title, sub), el('div', { className: 'pjp-actions' }, settings, del)));
    const instructions = instructionsCard(data);
    const main = el('div', { className: 'pjp-main' }, composer(data), chatsSection());
    const side = el('aside', { className: 'pjp-side' }, instructions, filesCard(data), linksCard(data), folderCard(data), defaultsCard(data), memoryCard(data));
    side.setAttribute('aria-label', tr('projectws.side', 'Project setup'));
    page.sub();
    root.append(el('div', { className: 'pjp-wrap' }, head, el('div', { className: 'pjp-cols' }, main, side)));
    const mount = document.querySelector('.cp-main');
    document.getElementById('chat-root').hidden = true;
    mount.append(root);
    document.body.classList.add('cp-project-open');
    instructions.fit();
    if (focus === 'instructions') { const box = instructions.querySelector('.pjp-text'); instructions.scrollIntoView({ block: 'nearest' }); box.focus(); box.setSelectionRange(box.value.length, box.value.length); } else page.composerText.focus();
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
  const refresh = () => { if (page) page.redraw?.(); };

  window.chatProjectPage = { open, close, isOpen: () => Boolean(page), refresh, id: () => page?.id || null };
})();
