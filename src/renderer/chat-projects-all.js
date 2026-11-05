// lumen://chat > Projects > All projects: every project on one page, as cards (or a compact list), grouped Pinned, Recent, Temporary and
// Archived with their counts. Loaded the first time it is opened (chat-page.js adds this script and chat-projects-all.css), never with the page.
//   window.chatProjectsAll.open({ api, host })   host: { projects(), chats(), open(project), edit(project), flag(project, key, on), keep?(project),
//                                                       newProject(), closed() }
//   window.chatProjectsAll.close() / .isOpen() / .refresh()
// A card: the project's mark (a colour and its first letter), its name, Temp and when it goes, Pinned, when it was last used, how many chats and
// key documents it has, its top key documents and a line from its memory or its goal. Click it to open the project; its ⋯ menu has Open,
// Pin / Unpin, Rename…, Archive / Move out of archive and, for a temporary one, Keep as project. A find box, Recent / A–Z and Grid / List
// (both kept) sit above. Cards are drawn CHUNK at a time as the page scrolls, so a long list stays quick.
(() => {
  const tr = (key, english, vars) => { const out = window.chatTr ? window.chatTr(key, english) : english; return vars ? out.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : out; };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const CHUNK = 24;
  const MORE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>';
  const ICONS = {
    open: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>',
    pin: '<svg viewBox="0 0 16 16"><path d="M8 2.5l1.7 3.4 3.8.6-2.7 2.6.6 3.8L8 11.1l-3.4 1.8.6-3.8L2.5 6.5l3.8-.6z"/></svg>',
    pencil: '<svg viewBox="0 0 16 16"><path d="M3 13h2.5L12.5 6 10 3.5 3 10.5z"/></svg>',
    box: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3"/></svg>',
  };
  const KIND = { file: 'File', pdf: 'PDF', doc: 'Word', sheet: 'Sheet', slides: 'Slides', drive: 'Drive', onedrive: 'OneDrive', web: 'Web' };
  const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } } };
  const prefs = { query: '', archived: false };

  let page = null; // { root, api, host, summary, observer } while open

  // A steady colour for a project, from its id.
  const hueOf = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const ago = (ms) => {
    if (!ms) return '';
    const days = Math.floor((Date.now() - ms) / 86400000);
    if (days <= 0) return tr('projects.all.today', 'Used today');
    if (days === 1) return tr('projects.all.yesterday', 'Used yesterday');
    if (days < 30) return tr('projects.all.days', 'Used {n} days ago', { n: days });
    return tr('projects.all.on', 'Used {date}', { date: new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) });
  };
  const lastUsed = (p, chats) => { let t = Number(p.updated || p.created || 0); for (const c of chats) if (c.project === p.id && Number(c.updated) > t) t = Number(c.updated); return t; };

  // The groups, each sorted by the page's sort: Pinned, Recent (the rest), Temporary, Archived. A query keeps the projects whose name, goal
  // line, memory line or key documents have it.
  function groups(projects, chats, summary, { sort = 'recent', query = '' } = {}) {
    const q = query.trim().toLowerCase();
    const used = new Map(projects.map((p) => [p.id, lastUsed(p, chats)]));
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    const order = (a, b) => (sort === 'name' ? byName(a, b) : used.get(b.id) - used.get(a.id) || byName(a, b));
    const hay = (p) => [p.name, p.description || '', summary[p.id]?.line || '', ...(summary[p.id]?.docs || []).map((d) => d.label)].join(' ').toLowerCase();
    const pool = projects.filter((p) => !q || hay(p).includes(q));
    return [
      ['pinned', tr('projects.all.pinned', 'Pinned'), pool.filter((p) => !p.archived && p.pinned)],
      ['recent', tr('projects.all.recent', 'Recent'), pool.filter((p) => !p.archived && !p.pinned && !p.temporary)],
      ['temp', tr('projects.all.temp', 'Temporary'), pool.filter((p) => !p.archived && !p.pinned && p.temporary)],
      ['archived', tr('projects.all.archived', 'Archived'), pool.filter((p) => p.archived)],
    ].map(([key, title, list]) => ({ key, title, list: list.sort(order), used }));
  }

  // [project drive] Save to Drive from a card's menu; why it can't (Drive not connected) shows above the cards.
  async function driveToggle(p) {
    const v = await page.api.projectDrive(p.id, { on: !p.drive }).catch(() => null);
    page.say = v?.error === 'connect' ? tr('projectws.drive.connect', 'Connect Google Drive first: Settings → Apps and connections → Google Drive.') : v?.error === 'temporary' ? tr('projectws.drive.temp', 'Keep it as a project first: a temporary project isn’t saved to Drive.') : '';
    draw();
  }
  // [project drive] Import from Drive: the projects saved in Lumen/Projects, each with Import (a new project here).
  async function importBox() {
    const box = el('div', { className: 'pja-import' });
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', tr('projects.all.import', 'Import from Drive'));
    box.append(el('p', { className: 'pja-empty', textContent: tr('projects.all.importLoading', 'Looking in Google Drive…') }));
    page.root.querySelector('.pja-import')?.remove();
    page.root.querySelector('.pja-bar')?.after(box);
    const got = await page.api.driveList().catch(() => null);
    if (!got?.connected) { box.replaceChildren(el('p', { className: 'pja-empty', textContent: tr('projectws.drive.connect', 'Connect Google Drive first: Settings → Apps and connections → Google Drive.') })); return; }
    if (!got.saved.length) { box.replaceChildren(el('p', { className: 'pja-empty', textContent: got.error || tr('projects.all.importNone', 'No projects saved in Google Drive yet (Lumen/Projects).') })); return; }
    const list = el('ul', { className: 'pja-import-list' });
    for (const s of got.saved) {
      const go = el('button', { type: 'button', className: 'btn small pja-import-go', textContent: tr('projects.all.importOne', 'Import') });
      go.onclick = async () => {
        go.disabled = true;
        const out = await page.api.driveImport(s.id).catch(() => null);
        if (out?.project) { box.remove(); page.host.open(out.project); } else { go.disabled = false; go.textContent = out?.error || tr('projects.all.importFailed', 'Could not import'); }
      };
      list.append(el('li', { className: 'pja-import-row' }, el('span', { className: 'pja-import-name', textContent: s.name }), el('span', { className: 'pja-when', textContent: s.modified ? new Date(s.modified).toLocaleDateString() : '' }), go));
    }
    box.replaceChildren(el('p', { className: 'pja-import-head', textContent: tr('projects.all.importHead', 'Saved in Google Drive (Lumen/Projects). Import brings one back as a new project: its instructions, goal, defaults, sources, notes and key documents. Its chats stay in Drive as Markdown.') }), list);
  }
  function menuFor(p, anchor) {
    const { host } = page;
    const items = [{ label: tr('projectws.open', 'Open project'), icon: ICONS.open, run: () => host.open(p) }];
    if (!p.archived) items.push({ label: p.pinned ? tr('projectws.list.unpin', 'Unpin') : tr('projectws.list.pin', 'Pin to top'), icon: ICONS.pin, run: () => host.flag(p, 'pinned', !p.pinned) });
    items.push({ label: tr('projects.all.rename', 'Rename…'), icon: ICONS.pencil, run: () => host.edit(p) });
    items.push({ label: p.archived ? tr('projectws.list.unarchive', 'Move out of archive') : tr('projectws.list.archive', 'Archive'), icon: ICONS.box, run: () => host.flag(p, 'archived', !p.archived) });
    if (!p.temporary) items.push({ label: p.drive ? tr('projectws.drive.stop', 'Stop saving to Drive') : tr('projectws.drive.start', 'Save to Drive'), icon: ICONS.box, run: () => driveToggle(p) }); // [project drive]
    if (p.temporary && host.keep) items.push({ label: tr('projectws.temp.keep', 'Keep as project'), icon: ICONS.open, run: () => host.keep(p) });
    anchor.setAttribute('aria-expanded', 'true');
    window.chatProjects.menu({ anchor, label: p.name, items, onClose: () => { anchor.setAttribute('aria-expanded', 'false'); } });
  }

  // One project, as a card (grid) or a row (list).
  function item(p, used, chats, grid) {
    const sum = page.summary[p.id] || {};
    const chatCount = chats.filter((c) => c.project === p.id && !c.archived).length;
    const docs = sum.docs || [];
    const node = el(grid ? 'article' : 'div', { className: `${grid ? 'pja-card' : 'pja-row'}${p.pinned ? ' pinned' : ''}${p.archived ? ' archived' : ''}${p.temporary ? ' temp' : ''}` });
    node.dataset.project = p.id;
    node.setAttribute('role', 'listitem');
    const mark = el('span', { className: 'pja-mark', textContent: (p.name.trim()[0] || '?').toUpperCase() });
    mark.style.setProperty('--hue', String(hueOf(p.id)));
    mark.setAttribute('aria-hidden', 'true');
    const name = el('button', { type: 'button', className: 'pja-name', textContent: p.name, title: p.name });
    name.onclick = () => page.host.open(p);
    const badges = el('span', { className: 'pja-badges' });
    if (p.pinned) badges.append(el('span', { className: 'pja-badge pja-pinned', textContent: tr('projectws.list.pinned', 'Pinned') }));
    if (p.temporary) badges.append(el('span', { className: 'pja-badge pja-temp', textContent: tr('projectws.temp.chip', 'Temp'), title: p.expires && window.chatProjects.expiresText ? window.chatProjects.expiresText(p.expires) : '' }));
    if (p.drive) badges.append(el('span', { className: 'pja-badge pja-drive', textContent: tr('projects.all.drive', 'Drive'), title: p.driveError ? tr('projects.all.driveError', 'Not saved to Drive: {why}', { why: p.driveError }) : p.driveSaved ? tr('projects.all.driveSaved', 'Saved to Google Drive {when}', { when: new Date(p.driveSaved).toLocaleString() }) : tr('projects.all.driveOn', 'Saved to Google Drive') })); // [project drive]
    if (p.archived) badges.append(el('span', { className: 'pja-badge', textContent: tr('projects.all.archivedOne', 'Archived') }));
    const more = el('button', { type: 'button', className: 'icon-btn pja-more', title: tr('chats.more', 'More actions') });
    more.setAttribute('aria-label', `${tr('chats.more', 'More actions')}: ${p.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.innerHTML = MORE;
    more.onclick = (e) => { e.stopPropagation(); menuFor(p, more); };
    const line = sum.line || p.description || '';
    const counts = [tr(chatCount === 1 ? 'projects.all.chat' : 'projects.all.chats', chatCount === 1 ? '1 chat' : '{n} chats', { n: chatCount }), ...(sum.docCount ? [tr(sum.docCount === 1 ? 'projects.all.doc' : 'projects.all.docs', sum.docCount === 1 ? '1 key document' : '{n} key documents', { n: sum.docCount })] : [])].join(' · ');
    const when = [ago(used.get(p.id)), ...(p.temporary && p.expires && window.chatProjects.expiresText ? [window.chatProjects.expiresText(p.expires)] : [])].filter(Boolean).join(' · ');
    if (grid) {
      node.append(el('div', { className: 'pja-top' }, mark, el('div', { className: 'pja-title' }, name, badges), more));
      if (line) node.append(el('p', { className: 'pja-line', textContent: line }));
      if (docs.length) {
        const ul = el('ul', { className: 'pja-docs' });
        ul.setAttribute('aria-label', tr('projectws.places', 'Key documents'));
        for (const d of docs.slice(0, 3)) ul.append(el('li', { className: 'pja-doc' }, el('span', { className: 'pja-doc-kind', textContent: tr(`projectws.places.kind.${d.kind}`, KIND[d.kind] || 'Link') }), el('span', { className: 'pja-doc-name', textContent: d.label })));
        node.append(ul);
      }
      node.append(el('div', { className: 'pja-foot' }, el('span', { className: 'pja-when', textContent: when }), el('span', { className: 'pja-counts', textContent: counts })));
      node.addEventListener('click', (e) => { if (!e.target.closest('button') && !getSelection()?.toString()) page.host.open(p); });
    } else {
      node.append(mark, el('div', { className: 'pja-row-main' }, el('div', { className: 'pja-title' }, name, badges), el('span', { className: 'pja-line', textContent: line })), el('span', { className: 'pja-when', textContent: when }), el('span', { className: 'pja-counts', textContent: counts }), more);
    }
    return node;
  }

  // A group's items CHUNK at a time: the rest come as its last one scrolls into view.
  function fill(list, items, make) {
    let at = 0;
    const next = () => {
      const part = items.slice(at, at + CHUNK);
      at += part.length;
      list.append(...part.map(make));
      if (at < items.length) {
        const tail = el('div', { className: 'pja-sentinel' });
        tail.setAttribute('aria-hidden', 'true');
        tail.more = next;
        list.append(tail);
        if (page.observer) page.observer.observe(tail); else { tail.remove(); next(); }
      }
    };
    next();
  }

  function draw() {
    if (!page) return;
    const { host, root } = page;
    const projects = host.projects();
    const chats = host.chats();
    const sort = store.get('lumen.projects.sort', 'recent') === 'name' ? 'name' : 'recent';
    const grid = store.get('lumen.projects.view', 'grid') !== 'list';
    const keepFocus = document.activeElement?.classList.contains('pja-find');
    const head = el('header', { className: 'pja-head' });
    const back = el('button', { type: 'button', className: 'pjp-back' }, el('span', { className: 'pjp-back-arrow', textContent: '←' }), tr('projectws.back', 'Chats'));
    back.onclick = () => close();
    const title = el('h1', { className: 'pja-h1', textContent: tr('projects.all.title', 'All projects') });
    const total = el('span', { className: 'pja-total', textContent: tr(projects.length === 1 ? 'projects.all.count1' : 'projects.all.count', projects.length === 1 ? '1 project' : '{n} projects', { n: projects.length }) });
    const fresh = el('button', { type: 'button', className: 'btn small primary pja-new', textContent: tr('chatpage.project.new', 'New project') });
    fresh.onclick = () => host.newProject();
    const fromDrive = el('button', { type: 'button', className: 'btn small pja-import-btn', textContent: tr('projects.all.importBtn', 'Import from Drive…') }); // [project drive]
    fromDrive.onclick = () => importBox();
    head.append(back, el('div', { className: 'pja-head-row' }, title, total, el('span', { className: 'pja-grow' }), fromDrive, fresh));
    // the tools: find, sort, grid or list
    const find = el('input', { type: 'search', className: 'pja-find', value: prefs.query, placeholder: tr('projects.all.find', 'Find a project, a note or a document') });
    find.setAttribute('aria-label', tr('projects.all.find', 'Find a project, a note or a document'));
    find.addEventListener('input', () => { prefs.query = find.value; draw(); });
    find.addEventListener('keydown', (e) => { if (e.key === 'Escape' && find.value) { e.preventDefault(); e.stopPropagation(); prefs.query = ''; draw(); } });
    const sortBtn = el('button', { type: 'button', className: 'btn small pja-sort', textContent: sort === 'name' ? tr('projectws.list.sortName', 'A–Z') : tr('projectws.list.sortRecent', 'Recent') });
    sortBtn.title = sort === 'name' ? tr('projectws.list.sortNameTip', 'Sorted by name. Click to sort by most recent.') : tr('projectws.list.sortRecentTip', 'Most recent first. Click to sort by name.');
    sortBtn.onclick = () => { store.set('lumen.projects.sort', sort === 'name' ? 'recent' : 'name'); draw(); root.querySelector('.pja-sort')?.focus(); };
    const switcher = el('div', { className: 'pja-switch' });
    switcher.setAttribute('role', 'group');
    switcher.setAttribute('aria-label', tr('projects.all.view', 'Show as'));
    for (const [v, label] of [['grid', tr('projects.all.grid', 'Cards')], ['list', tr('projects.all.list', 'List')]]) {
      const b = el('button', { type: 'button', className: `pja-view-btn${(v === 'grid') === grid ? ' on' : ''}`, textContent: label });
      b.dataset.view = v;
      b.setAttribute('aria-pressed', String((v === 'grid') === grid));
      b.onclick = () => { store.set('lumen.projects.view', v); draw(); root.querySelector(`.pja-view-btn[data-view="${v}"]`)?.focus(); };
      switcher.append(b);
    }
    const bar = el('div', { className: 'pja-bar' }, find, sortBtn, switcher);
    const body = el('div', { className: 'pja-body' });
    page.observer?.disconnect();
    page.observer = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { page.observer.unobserve(e.target); const more = e.target.more; e.target.remove(); more?.(); } }, { root: null, rootMargin: '400px' }) : null;
    const gs = groups(projects, chats, page.summary, { sort, query: prefs.query });
    let shown = 0;
    for (const g of gs) {
      if (!g.list.length) continue;
      const archived = g.key === 'archived';
      const open = !archived || prefs.archived || Boolean(prefs.query.trim());
      const h = el('h2', { className: 'pja-group-h' });
      if (archived) {
        const t = el('button', { type: 'button', className: 'pja-group-toggle', textContent: `${g.title} (${g.list.length})` });
        t.setAttribute('aria-expanded', String(open));
        t.onclick = () => { prefs.archived = !prefs.archived; draw(); root.querySelector('.pja-group-toggle')?.focus(); };
        h.append(t);
      } else h.append(el('span', { textContent: g.title }), el('span', { className: 'pja-group-n', textContent: String(g.list.length) }));
      const section = el('section', { className: `pja-group pja-group-${g.key}` }, h);
      section.setAttribute('aria-label', `${g.title} (${g.list.length})`);
      if (open) {
        const list = el('div', { className: grid ? 'pja-grid' : 'pja-list' });
        list.setAttribute('role', 'list');
        section.append(list);
        fill(list, g.list, (p) => item(p, g.used, chats, grid));
      }
      body.append(section);
      shown += g.list.length;
    }
    if (!projects.length) body.append(el('p', { className: 'pja-empty', textContent: tr('projects.all.none', 'No projects yet. A project keeps the chats, files and notes of one piece of work together.') }));
    else if (!shown) body.append(el('p', { className: 'pja-empty', textContent: tr('projectws.list.none', 'No project matches.') }));
    const said = el('p', { className: 'pja-say', textContent: page.say || '' }); // ([project drive] why a card's Save to Drive didn't turn on)
    said.setAttribute('role', 'status');
    said.hidden = !page.say;
    root.replaceChildren(el('div', { className: 'pja-wrap' }, head, bar, said, body));
    if (keepFocus) { const f = root.querySelector('.pja-find'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  }

  async function loadSummary() {
    const out = await page.api.projectsOverview().catch(() => null);
    if (page && out) { page.summary = out; draw(); }
  }
  async function open({ api, host }) {
    close(false);
    const root = el('section', { className: 'pja', id: 'cp-projects-all' });
    root.setAttribute('aria-label', tr('projects.all.title', 'All projects'));
    page = { root, api, host, summary: {}, observer: null };
    document.querySelector('.cp-main').append(root);
    document.getElementById('chat-root').hidden = true;
    document.body.classList.add('cp-project-open');
    draw();
    root.querySelector('.pja-find')?.focus();
    loadSummary();
    return true;
  }
  function close(notify = true) {
    if (!page) return;
    const { root, host } = page;
    page.observer?.disconnect();
    page = null;
    root.remove();
    if (!window.chatProjectPage?.isOpen()) { const chat = document.getElementById('chat-root'); if (chat) chat.hidden = false; document.body.classList.remove('cp-project-open'); }
    if (notify) host.closed?.();
  }
  // The list changed (a chat, a project): redraw; the summary (memory lines, key documents) is read again too.
  function refresh() { if (page) { draw(); loadSummary(); } }

  window.chatProjectsAll = { open, close, isOpen: () => Boolean(page), refresh, groups };
})();
