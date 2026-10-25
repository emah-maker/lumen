// The sidebar's Notes panel: a small notepad kept on this computer (main: features/notes-hub.js, ai/notes.js). A list of notes with search,
// and an editor for one: plain text you can write Markdown in, a preview that draws it (headings, lists, quotes, code, formulas, and
// diagrams and pictures that were added from a chat), saved as you type. "Ask AI" sends the note to the chat.
// Loaded on first open by notes-loader.js (with notes.css); loaded after chat-core.js, whose globals (ask, decorateCode) it uses when clicked.
// Everything from a note is shown with textContent or the Markdown renderer (which escapes), never raw markup.
(() => {
  const api = window.assistant?.notes;
  const button = document.getElementById('notes-btn');
  const panel = document.getElementById('notes-panel');
  if (!api || !button || !panel) return;
  const T = (key, vars) => window.t(key, vars);
  const live = document.getElementById('task-live');
  const SAVE_DELAY = 500;
  const IMAGE_LINE = /^!\[([^\]\n]*)\]\(note-image:([a-f0-9]{16}\.(?:png|jpg|gif|webp))\)\s*$/;
  const CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3.5-4.5 4.5 4.5 4.5"/></svg>';
  const TRASH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8"/></svg>';

  let notes = [];
  let query = '';
  let open = null; // { id, base } while a note is in the editor: base is the text it was loaded or last saved with
  let mode = 'write'; // 'write' | 'preview'
  let dirty = false;
  let saving = null;
  let timer = 0;
  let undo = null; // { token } after a delete
  let ta = null; // the editor's textarea
  let statusEl = null;

  const h = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return node;
  };
  const icon = (svg, label, onclick, cls = 'icon-btn') => { const b = h('button', { type: 'button', className: cls, title: label, onclick }); b.setAttribute('aria-label', label); b.innerHTML = svg; return b; };
  const say = (text) => { if (live) { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); } };
  const when = (ms) => {
    const d = new Date(ms);
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // ---- saving: typing marks the note dirty and saves half a second after the last key; leaving the note, closing the panel or the window saves at once
  function setStatus(key) { if (statusEl) { statusEl.textContent = key ? T(key) : ''; statusEl.dataset.state = key || ''; } }
  function schedule() { dirty = true; setStatus('notes.saving'); clearTimeout(timer); timer = setTimeout(flush, SAVE_DELAY); }
  async function flush() {
    clearTimeout(timer);
    if (saving) await saving;
    if (!dirty || !open || !ta) return;
    const id = open.id;
    const text = ta.value;
    dirty = false;
    saving = api.act('save', { id, text, base: open.base }).catch(() => null).then((r) => {
      saving = null;
      if (!open || open.id !== id) return;
      if (!r?.ok) { dirty = true; setStatus('notes.saveFailed'); return; }
      open.base = r.note.text;
      if (r.note.text !== ta.value && ta.value === text) ta.value = r.note.text; // something was added to the end meanwhile (the AI, Add to notes): both are kept
      if (ta.value !== r.note.text) schedule(); else setStatus('notes.saved');
      refreshList();
    });
    await saving;
  }
  window.addEventListener('beforeunload', () => { if (dirty && open && ta) api.act('save', { id: open.id, text: ta.value, base: open.base }); });

  // ---- the list
  async function refreshList() {
    const r = await api.act('list', { query }).catch(() => null);
    if (!r?.ok) return;
    notes = r.notes;
    if (!panel.hidden && !open) renderListBody();
  }
  function noteRow(n) {
    const meta = `${when(n.updated)}${n.preview && n.preview !== n.title ? ` · ${n.preview}` : ''}`;
    return h('li', { className: 'nt-row' },
      h('button', { type: 'button', className: 'nt-open', onclick: () => openNote(n.id) },
        h('span', { className: 'nt-title', textContent: n.title || T('notes.untitled') }),
        h('span', { className: 'nt-meta', textContent: meta })));
  }
  function searchBox() {
    const input = h('input', { type: 'search', className: 'nt-search', id: 'nt-search', value: query, placeholder: T('notes.search') });
    input.setAttribute('aria-label', T('notes.search'));
    let t = 0;
    input.oninput = () => { clearTimeout(t); t = setTimeout(() => { query = input.value; refreshList(); }, 150); };
    return input;
  }
  function renderListBody() {
    const body = panel.querySelector('.nt-list-wrap');
    if (!body) return;
    body.replaceChildren(notes.length
      ? h('ul', { className: 'chat-items nt-list' }, ...notes.map(noteRow))
      : h('p', { className: 'chat-list-empty', textContent: T(query ? 'notes.noMatch' : 'notes.empty') }));
  }
  function head(title, ...right) {
    return h('div', { className: 'chat-list-head' }, h('h2', { textContent: title }), h('div', { className: 'nt-head-actions' }, ...right, icon(CLOSE, T('notes.close'), () => closePanel(true), 'icon-btn notes-close')));
  }
  function renderList() {
    const bar = h('div', { className: 'nt-bar' }, searchBox(), h('button', { type: 'button', className: 'btn nt-new', textContent: T('notes.new'), onclick: newNote }));
    const undoRow = undo ? h('div', { className: 'nt-undo', role: 'status' }, h('span', { textContent: T('notes.deleted') }),
      h('button', { type: 'button', className: 'btn', textContent: T('notes.undo'), onclick: async () => { const u = undo; undo = null; await api.act('undo', { token: u.token }); refreshList(); renderList(); } })) : null;
    panel.replaceChildren(head(T('notes.title')), bar, undoRow, h('div', { className: 'nt-list-wrap' }));
    renderListBody();
  }

  // ---- the editor
  async function newNote() {
    await leave();
    const r = await api.act('new', { text: '' }).catch(() => null);
    if (!r?.ok) return;
    undo = null;
    show(r.note, 'write');
  }
  async function openNote(id) {
    await leave();
    const r = await api.act('get', { id }).catch(() => null);
    if (!r?.ok) { refreshList(); return; }
    api.act('select', { id });
    show(r.note, 'write');
  }
  async function leave() { await flush(); open = null; ta = null; statusEl = null; }
  async function back() { await leave(); await refreshList(); renderList(); panel.querySelector('#nt-search')?.focus(); }

  // The note as it reads: Markdown through the chat's renderer, pictures from the notepad's own folder.
  function renderPreview(box, text) {
    box.replaceChildren();
    const parts = [];
    let buf = [];
    const cut = () => { if (buf.length) { parts.push({ text: buf.join('\n') }); buf = []; } };
    let fenced = false;
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      const m = !fenced && IMAGE_LINE.exec(line);
      if (m) { cut(); parts.push({ alt: m[1], name: m[2] }); } else buf.push(line);
    }
    cut();
    for (const part of parts) {
      if (part.name) {
        const fig = h('figure', { className: 'nt-pic' });
        const img = h('img', { alt: part.alt || T('notes.picture') });
        api.act('image', { name: part.name }).then((r) => { if (r?.ok) img.src = r.url; else fig.textContent = T('notes.pictureGone'); }).catch(() => {});
        fig.append(img);
        box.append(fig);
      } else {
        const div = h('div', { className: 'nt-md' });
        if (typeof window.renderMarkdown === 'function') div.innerHTML = window.renderMarkdown(part.text); else div.textContent = part.text;
        box.append(div);
        try { window.decorateCode?.(div); } catch { /* plain code blocks */ }
      }
    }
    if (!text.trim()) box.append(h('p', { className: 'chat-list-empty', textContent: T('notes.emptyNote') }));
  }

  function show(note, nextMode) {
    mode = nextMode;
    open = { id: note.id, base: note.text };
    dirty = false;
    ta = h('textarea', { className: 'nt-text', id: 'nt-text', value: note.text, spellcheck: true, placeholder: T('notes.placeholder') });
    ta.setAttribute('aria-label', T('notes.editor'));
    ta.addEventListener('input', schedule);
    ta.addEventListener('blur', () => { flush(); });
    statusEl = h('span', { className: 'nt-status', role: 'status' });
    const body = h('div', { className: 'nt-body msg assistant' });
    const write = h('button', { type: 'button', className: 'nt-tab nt-write', textContent: T('notes.write') });
    const prev = h('button', { type: 'button', className: 'nt-tab nt-preview', textContent: T('notes.preview') });
    const apply = async (m) => {
      mode = m;
      if (m === 'preview') { await flush(); renderPreview(body, ta.value); body.hidden = false; ta.hidden = true; } else { body.hidden = true; ta.hidden = false; ta.focus(); }
      write.setAttribute('aria-pressed', String(m === 'write'));
      prev.setAttribute('aria-pressed', String(m === 'preview'));
    };
    write.onclick = () => apply('write');
    prev.onclick = () => apply('preview');
    const question = h('input', { type: 'text', className: 'nt-question', id: 'nt-question', placeholder: T('notes.askPlaceholder') });
    question.setAttribute('aria-label', T('notes.askPlaceholder'));
    const askNow = async () => {
      await flush();
      const latest = await api.act('get', { id: open.id }).catch(() => null); // (what is stored: something may have been added a moment ago)
      const text = (latest?.ok ? latest.note.text : ta.value).trim();
      if (!text) return;
      const title = (note.title || text.split('\n')[0] || '').slice(0, 70);
      const q = question.value.trim() || T('notes.askDefault');
      question.value = '';
      closePanel(false);
      window.ask?.(T('notes.askPrompt', { title, text: text.slice(0, 20000), question: q }));
    };
    question.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); askNow(); } });
    const del = icon(TRASH, T('notes.delete'), async () => {
      const id = open.id;
      dirty = false;
      clearTimeout(timer);
      const r = await api.act('delete', { id }).catch(() => null);
      open = null; ta = null; statusEl = null;
      undo = r?.ok ? { token: r.token } : null;
      if (r?.ok) say(T('notes.deleted'));
      await refreshList();
      renderList();
    }, 'icon-btn nt-delete');
    panel.replaceChildren(
      head(T('notes.title'), del),
      h('div', { className: 'nt-bar' }, icon(BACK, T('notes.back'), back, 'icon-btn nt-back'), h('div', { className: 'nt-tabs', role: 'group' }, write, prev), statusEl),
      h('div', { className: 'nt-editor' }, ta, body),
      h('div', { className: 'nt-ask' }, question, h('button', { type: 'button', className: 'btn nt-ask-btn', textContent: T('notes.ask'), onclick: askNow })));
    apply(nextMode);
  }

  // ---- open and close
  function revealSidebar() { if (document.body.classList.contains('sidebar-hidden')) (window.showSidebarFor || (() => document.getElementById('toggle-sidebar')?.click()))(); }
  async function openPanel() {
    revealSidebar();
    await refreshList();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    const reopen = open && ta ? await api.act('get', { id: open.id }).catch(() => null) : null; // the note that was open comes back as it was
    if (reopen?.ok) show(reopen.note, mode);
    else { open = null; ta = null; renderList(); }
    (ta || panel.querySelector('#nt-search'))?.focus();
  }
  function closePanel(refocus) {
    if (panel.hidden) return;
    flush();
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('active');
    if (refocus) (button.offsetParent ? button : document.getElementById('more-actions') || button).focus();
  }
  const toggle = () => (panel.hidden ? openPanel() : closePanel(true));
  button.onclick = toggle;
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closePanel(true); } });
  panel.addEventListener('click', (e) => {
    const link = e.target.closest?.('.nt-body a[href]');
    if (!link) return;
    e.preventDefault();
    window.browser?.newTab?.(link.href);
  });

  // Something was added from elsewhere (a reply, the page, the AI): the list follows, and the open note takes what was added unless it is being typed in.
  let pending = 0;
  api.onChanged(() => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      if (panel.hidden) return;
      await refreshList();
      if (open && ta && !dirty && !saving) {
        const r = await api.act('get', { id: open.id }).catch(() => null);
        if (!r?.ok) { open = null; ta = null; renderList(); return; }
        if (r.note.text !== open.base && !dirty && open) {
          open.base = r.note.text;
          ta.value = r.note.text;
          const body = panel.querySelector('.nt-body');
          if (body && !body.hidden) renderPreview(body, r.note.text);
        }
      }
    }, 60);
  });

  window.notesUi = { toggle, open: openPanel, close: closePanel, flush };
  toggle(); // (the first click loaded this file: it opens the panel)
})();
