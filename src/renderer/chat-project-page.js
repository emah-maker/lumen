// lumen://chat > Projects > Open project: a project as a workspace for the AI (like Claude and ChatGPT projects, but it knows the browser).
// Loaded the first time a project is opened (chat-page.js adds this script and chat-project-page.css then), never with the page.
//   window.chatProjectPage.open({ api, id, host })   host: { chats(), projects(), openChat(id), newChat(project), editFolder(project), moveChats(ids, projectId),
//                                                       undoToast(text, ms, undo), toast(text), models() -> [{ value, label }], closed(), refresh() }
//   window.chatProjectPage.close() / .isOpen() / .refresh()
// What it shows: the project's instructions, its files (read on this computer into text the AI can search and read), its pinned pages,
// the defaults a new chat starts with, what the AI saved in its chats (memory), and its chats. A search looks in the chats and the files.
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

  // ---- instructions
  function instructionsCard(data) {
    const { limits } = data;
    const text = el('textarea', { className: 'pjp-text', rows: 6, maxLength: limits.instructions, value: data.project.instructions || '', placeholder: tr('chatpage.project.hint', 'How should the AI work in this project? For example: answer in a formal tone, or the audience is first-year students.') });
    text.setAttribute('aria-label', tr('chatpage.project.instructions', 'Instructions'));
    const say = status();
    const save = button(tr('chatpage.project.save', 'Save'), async () => {
      save.disabled = true;
      const out = await page.api.saveProject({ id: page.id, name: data.project.name, instructions: text.value }).catch(() => null);
      save.disabled = false;
      say.textContent = out && !out.error ? tr('projectws.saved', 'Saved.') : tr('chatpage.project.failed', 'Could not save the project.');
      if (out && !out.error) data.project = out;
    }, 'primary');
    return card(tr('chatpage.project.instructions', 'Instructions'), text,
      note(tr('projectws.instructions.note', 'Sent to the AI with every chat in this project, on every model. Up to {n} characters. Together with the list of files and pages below, about {m} characters go with each message; anything longer is cut.', { n: limits.instructions, m: limits.instructions + limits.index })),
      el('div', { className: 'pjp-line' }, save, say));
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
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
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

  // ---- chats
  function chatsCard() {
    const list = el('ul', { className: 'pjp-list pjp-chats' });
    list.setAttribute('aria-label', tr('projectws.chats', 'Chats'));
    const draw = () => {
      const mine = host().chats().filter((c) => c.project === page.id && !c.archived);
      list.replaceChildren(...mine.map((c) => {
        const li = el('li', { className: 'pjp-row' });
        li.dataset.chat = c.id;
        const open = el('button', { type: 'button', className: 'pjp-chat-open', textContent: c.title || tr('chats.untitled', 'Chat') });
        open.onclick = () => host().openChat(c.id);
        const when = c.updated ? new Date(c.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
        const move = el('select', { className: 'pjp-select pjp-move' });
        move.setAttribute('aria-label', `${tr('chatpage.project.move', 'Move to project')}: ${c.title || ''}`);
        move.append(el('option', { value: '', textContent: tr('chatpage.project.move', 'Move to project') }));
        for (const p of host().projects()) if (p.id !== page.id) move.append(el('option', { value: p.id, textContent: p.name }));
        move.append(el('option', { value: '__none', textContent: tr('chatpage.project.none', 'Remove from project') }));
        move.onchange = async () => { const v = move.value; if (v) await host().moveChats([c.id], v === '__none' ? null : v); };
        li.append(open, el('span', { className: 'pjp-row-meta', textContent: when }), move);
        return li;
      }));
      if (!mine.length) list.append(el('li', { className: 'pjp-empty', textContent: tr('chatpage.project.empty', 'No chats in this project yet. Start one here, or move a chat in from its ⋯ menu.') }));
    };
    draw();
    chatsCard.redraw = draw;
    return card(tr('projectws.chats', 'Chats'), list);
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
      page.grid.hidden = Boolean(q);
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

  // ---- the page
  async function open({ api, id, host: h }) {
    close(false);
    const data = await api.project(id).catch(() => null);
    if (!data) return false;
    const root = el('section', { className: 'pjp', id: 'cp-project-page' });
    page = { api, id, host: h, root, grid: null, data };
    root.setAttribute('aria-label', data.project.name);
    const back = el('button', { type: 'button', className: 'btn small pjp-back', textContent: `← ${tr('projectws.back', 'Chats')}` });
    back.onclick = () => close();
    const title = el('input', { type: 'text', className: 'pjp-title', value: data.project.name, maxLength: 60 });
    title.setAttribute('aria-label', tr('chatpage.project.name', 'Project name'));
    const rename = async () => {
      const name = title.value.trim();
      if (!name) { title.value = data.project.name; return; }
      if (name === data.project.name) return;
      const out = await api.saveProject({ id, name }).catch(() => null);
      if (out && !out.error) { data.project = out; root.setAttribute('aria-label', out.name); h.refresh(); } else title.value = data.project.name;
    };
    title.addEventListener('blur', rename);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } else if (e.key === 'Escape') { title.value = data.project.name; title.blur(); } });
    const fresh = button(tr('chatpage.project.newChat', 'New chat here'), () => h.newChat(data.project), 'primary');
    const folder = button(tr('projectws.folder', 'Folder and more…'), () => h.editFolder(data.project));
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
    const head = el('header', { className: 'pjp-head' }, back, title, el('div', { className: 'pjp-actions' }, fresh, folder, del));
    const search = searchBox();
    const grid = el('div', { className: 'pjp-grid' }, instructionsCard(data), filesCard(data), linksCard(data), defaultsCard(data), memoryCard(data), chatsCard());
    page.grid = grid;
    root.append(head, el('div', { className: 'pjp-search' }, search.input), search.out, grid);
    const main = document.querySelector('.cp-main');
    document.getElementById('chat-root').hidden = true;
    main.append(root);
    document.body.classList.add('cp-project-open');
    title.blur();
    back.focus();
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
  const refresh = () => { if (page) chatsCard.redraw?.(); };

  window.chatProjectPage = { open, close, isOpen: () => Boolean(page), refresh, id: () => page?.id || null };
})();
