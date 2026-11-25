// [project templates] The job dashboard: the Applications view of a Job applications project (chat-project-page.js). Loaded the first
// time a job project's page is opened (with chat-job-board.css), never with the page itself.
//   window.chatJobBoard.draw(box, ctx) -> { refresh() }
//     ctx: { api, id, tr(key, english, vars), openLink(url), toast(text) }
// What it shows: the stat tiles (applied this week and month, total, response rate, interviews, offers, rejections, the average days to
// an answer, and the last 8 weeks as small bars), the follow-ups due (applied two weeks ago or more, no answer), then one of three views:
// Board (Saved, Applied, Interview, Offer, Closed: drag a card to move it on, or use its stage menu), Table (sortable) and Timeline (every
// move, by day). Each row opens its posting and the tailored résumé it used. Everything comes from main ("chats:project-applications"):
// the tracker is kept on this computer with the automations, encrypted.
// [project templates] Sources: a Google Sheet the user already tracks in, linked here and kept in step both ways (main reads it when the
// dashboard opens, at most every 2 minutes, and writes Status cells and new rows when "Keep the sheet updated" is on), and Gmail: "Check
// email" sorts application emails into suggestions (received, interview, offer, rejection) the user applies or ignores (features/job-sync.js).
// [project templates] Find jobs, a fourth view (features/job-search.js): with a job skill of the user's own, a search starts a chat in the
// project with it (ctx.newChat); with none, it offers to install Job search (JobSpy), then searches right here: listings with Open and
// Save (to the tracker as Saved, and from there to the linked sheet).
(() => {
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter((k) => k !== null && k !== undefined && k !== false)); return n; };
  const COLUMNS = [['saved', ['saved']], ['applied', ['applied']], ['interview', ['interview']], ['offer', ['offer']], ['closed', ['rejected', 'withdrawn']]];
  const STAGE_OF_COLUMN = { saved: 'saved', applied: 'applied', interview: 'interview', offer: 'offer', closed: 'rejected' }; // (a card dropped on Closed is rejected; its menu has Withdrawn)
  const STAGES = ['saved', 'applied', 'interview', 'offer', 'rejected', 'withdrawn'];
  const VIEWS = ['board', 'table', 'timeline', 'find'];
  const DAY = 86400000;
  const ICON = {
    open: '<path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 3.5h-2a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/>',
    doc: '<path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 9h4M6 11h3"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
    board: '<rect x="2.5" y="3" width="3" height="10" rx="1"/><rect x="6.5" y="3" width="3" height="7" rx="1"/><rect x="10.5" y="3" width="3" height="5" rx="1"/>',
    table: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M2.5 10h11M6.5 3v10"/>',
    find: '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2 13.5 13.5"/>',
    timeline: '<path d="M4.5 2.5v11"/><circle cx="4.5" cy="4.5" r="1.4"/><circle cx="4.5" cy="8" r="1.4"/><circle cx="4.5" cy="11.5" r="1.4"/><path d="M7.5 4.5h6M7.5 8h5M7.5 11.5h6"/>',
  };
  const icon = (name) => { const s = el('span', { className: 'jb-ic' }); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<svg viewBox="0 0 16 16">${ICON[name]}</svg>`; return s; };
  const remember = {
    get: (k, d) => { try { return localStorage.getItem(`lumen.jobBoard.${k}`) || d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`lumen.jobBoard.${k}`, v); } catch { /* private storage off: the choice lasts this visit */ } },
  };

  function draw(box, ctx) {
    const { api, id, tr } = ctx;
    const stageName = (s) => tr(`projecttpl.stage.${s}`, s);
    const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
    let data = null;
    let src = null; // the sources: { sheet, sheets, gmail, emailAt, suggestions }
    let autoDone = false; // (the dashboard's first draw syncs the sheet and checks email once, when they are due)
    let linking = false;
    let view = VIEWS.includes(remember.get('view', 'board')) ? remember.get('view', 'board') : 'board';
    let sort = { key: 'at', dir: -1 };
    const root = el('div', { className: 'jb' });
    const say = el('p', { className: 'jb-status' });
    say.setAttribute('role', 'status');
    box.replaceChildren(root);

    async function load() {
      const got = await api.projectApplications(id, 'get').catch(() => null);
      if (!root.isConnected) return;
      if (!got) { root.replaceChildren(el('p', { className: 'jb-empty', textContent: tr('projecttpl.apps.failed', 'Could not read the tracker.') })); return; }
      data = got;
      src = await api.projectApplications(id, 'sources').catch(() => null);
      if (!root.isConnected) return;
      render();
      if (!autoDone && src) { autoDone = true; auto(); }
    }
    const MIN = 60000;
    async function auto() {
      let again = false;
      if (src.sheet && src.sheets && Date.now() - (src.sheet.at || 0) > 2 * MIN) { const r = await api.projectApplications(id, 'sync').catch(() => null); again ||= Boolean(r); }
      if (src.gmail && Date.now() - (src.emailAt || 0) > 30 * MIN) { const r = await api.projectApplications(id, 'check-email').catch(() => null); again ||= Boolean(r?.ok); }
      if (again && root.isConnected) await load();
    }
    async function act(action, arg, busyBtn) {
      if (busyBtn) busyBtn.disabled = true;
      const out = await api.projectApplications(id, action, arg).catch(() => null);
      if (busyBtn) busyBtn.disabled = false;
      if (!out?.ok) say.textContent = out?.error || tr('jobs.src.failed', 'That didn’t work. Try again.');
      else say.textContent = action === 'sync' || action === 'link-sheet' ? syncSays(out) : action === 'check-email' ? (out.suggestions.length ? tr('jobs.email.found', '{n} emails could update your tracker.', { n: out.suggestions.length }) : tr('jobs.email.none', 'Checked {n} emails: nothing new.', { n: out.checked })) : '';
      if (out?.ok && action === 'link-sheet') linking = false;
      await load();
      return out;
    }
    const syncSays = (r) => tr('jobs.sheet.synced', 'Synced: {added} new from the sheet, {moved} moved, {written} written back, {appended} added to the sheet.', { added: r.added || 0, moved: r.moved || 0, written: r.written || 0, appended: r.appended || 0 });
    const ago = (t) => { if (!t) return tr('jobs.src.never', 'not yet'); const m = Math.round((Date.now() - t) / MIN); return m < 1 ? tr('jobs.src.now', 'just now') : m < 60 ? tr('jobs.src.min', '{n} min ago', { n: m }) : m < 1440 ? tr('jobs.src.hours', '{n} h ago', { n: Math.round(m / 60) }) : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
    const small = (label, run, className = '') => { const b = el('button', { type: 'button', className: `btn small ${className}`.trim(), textContent: label }); b.onclick = () => run(b); return b; };
    async function move(key, stage) {
      const out = await api.projectApplications(id, 'stage', { key, stage }).catch(() => null);
      if (!out?.ok) say.textContent = tr('jobs.moveFailed', 'Could not move it.');
      await load();
    }

    // ---- the parts
    const linkBtn = (label, iconName, run, className) => { const b = el('button', { type: 'button', className: `jb-link ${className}`, title: label }, icon(iconName)); b.setAttribute('aria-label', label); b.onclick = (ev) => { ev.stopPropagation(); run(); }; return b; };
    const postingBtn = (e) => (e.url ? linkBtn(tr('jobs.posting', 'Open the posting'), 'open', () => ctx.openLink(e.url), 'jb-posting') : null);
    const resumeBtn = (e) => (e.resume ? linkBtn(tr('jobs.resume', 'Open the tailored résumé: {name}', { name: e.resume }), 'doc', async () => { const out = await api.projectApplications(id, 'resume', { key: e.key }).catch(() => null); if (!out?.ok) say.textContent = tr('jobs.resumeFailed', 'Could not open the résumé.'); }, 'jb-resume') : null);
    const stagePill = (s) => el('span', { className: `jb-pill s-${s}`, textContent: stageName(s) });
    function stageMenu(e) {
      const sel = el('select', { className: 'jb-stage-select' });
      sel.setAttribute('aria-label', tr('jobs.stageFor', 'Stage of {name}', { name: [e.company, e.role].filter(Boolean).join(', ') }));
      for (const s of STAGES) sel.append(el('option', { value: s, textContent: stageName(s), selected: s === e.stage }));
      sel.onchange = () => move(e.key, sel.value);
      sel.onclick = (ev) => ev.stopPropagation();
      return sel;
    }

    function tiles() {
      const st = data.stats || {};
      const tile = (value, label, className = '', hint = '') => { const t = el('div', { className: `jb-tile ${className}`.trim(), title: hint }, el('span', { className: 'jb-tile-n', textContent: value }), el('span', { className: 'jb-tile-l', textContent: label })); return t; };
      const max = Math.max(1, ...(st.weeks || []));
      const bars = el('div', { className: 'jb-bars' });
      bars.setAttribute('role', 'img');
      bars.setAttribute('aria-label', tr('jobs.weeksLabel', 'Applications per week, the last 8 weeks: {list}', { list: (st.weeks || []).join(', ') }));
      (st.weeks || []).forEach((n, i) => { const b = el('span', { className: `jb-bar${i === 7 ? ' now' : ''}`, title: tr('jobs.weekBar', '{n} that week', { n }) }); b.style.setProperty('--h', `${Math.round((n / max) * 100)}%`); bars.append(b); });
      const weeksTile = el('div', { className: 'jb-tile jb-tile-chart' }, bars, el('span', { className: 'jb-tile-l', textContent: tr('jobs.weeks', 'Last 8 weeks') }));
      return el('div', { className: 'jb-tiles' },
        tile(String(st.week ?? 0), tr('jobs.week', 'Applied this week'), 'hero'),
        tile(String(st.month ?? 0), tr('jobs.month', 'This month')),
        tile(String(st.total ?? 0), tr('jobs.total', 'Total applied'), '', st.saved ? tr('jobs.savedHint', '{n} saved for later', { n: st.saved }) : ''),
        tile(st.responseRate === null || st.responseRate === undefined ? '–' : `${st.responseRate}%`, tr('jobs.rate', 'Response rate'), 'rate', tr('jobs.rateHint', 'Heard back (an interview, an offer or a rejection) out of all applied')),
        tile(String(st.interviews ?? 0), tr('jobs.interviews', 'Interviews'), 's-interview'),
        tile(String(st.offers ?? 0), tr('jobs.offers', 'Offers'), 's-offer'),
        tile(String(st.rejections ?? 0), tr('jobs.rejections', 'Rejections'), 's-rejected'),
        tile(st.avgDays === null || st.avgDays === undefined ? '–' : tr('jobs.days', '{n} d', { n: st.avgDays }), tr('jobs.avgDays', 'Avg. days to an answer')),
        weeksTile);
    }

    function followUps() {
      const due = data.followUps || [];
      if (!due.length) return null;
      const list = el('ul', { className: 'jb-follow-list' });
      for (const e of due.slice(0, 6)) {
        list.append(el('li', { className: 'jb-follow-row' },
          el('span', { className: 'jb-follow-days', textContent: tr('jobs.waited', '{n} days', { n: e.waited }) }),
          el('span', { className: 'jb-follow-name' }, el('strong', { textContent: e.company || '?' }), e.role ? el('span', { textContent: ` · ${e.role}` }) : null),
          el('span', { className: 'jb-grow' }), postingBtn(e), resumeBtn(e), stageMenu(e)));
      }
      const head = el('div', { className: 'jb-follow-head' }, icon('clock'), el('strong', { textContent: due.length === 1 ? tr('jobs.follow1', '1 follow-up due') : tr('jobs.followN', '{n} follow-ups due', { n: due.length }) }), el('span', { className: 'jb-muted', textContent: tr('jobs.followNote', 'Applied 2+ weeks ago with no answer. A short, polite check-in helps.') }));
      return el('section', { className: 'jb-follow' }, head, list, due.length > 6 ? el('p', { className: 'jb-muted', textContent: tr('jobs.followMore', '{n} more in the table.', { n: due.length - 6 }) }) : null);
    }

    function sources() {
      if (!src) return null;
      const icoSheet = el('span', { className: 'jb-src-ic sheet', textContent: '▦' });
      const icoMail = el('span', { className: 'jb-src-ic mail', textContent: '✉' });
      for (const i of [icoSheet, icoMail]) i.setAttribute('aria-hidden', 'true');
      // the sheet
      let sheetRow;
      if (!src.sheets && !src.sheet) {
        sheetRow = el('div', { className: 'jb-src' }, icoSheet, el('span', { className: 'jb-src-text', textContent: tr('jobs.sheet.connect', 'Track in a Google Sheet? Connect Google Sheets, then link your tracker: its rows count here and your changes go back to it.') }), small(tr('jobs.src.connectSheets', 'Connect Google Sheets'), () => act('connect')));
      } else if (src.sheet && !linking) {
        const s = src.sheet;
        const text = el('span', { className: 'jb-src-text' }, el('strong', { textContent: tr('jobs.sheet.linked', 'Your tracker sheet') }), el('span', { className: 'jb-muted', textContent: ` · ${s.tab ? `${s.tab} · ` : ''}${s.error ? '' : tr('jobs.sheet.at', 'synced {when}', { when: ago(s.at) })}` }));
        if (s.error) text.append(el('span', { className: 'jb-src-error', textContent: ` ${s.error}` }));
        const keep = el('label', { className: 'jb-check' }, el('input', { type: 'checkbox', checked: s.write !== false }), el('span', { textContent: tr('jobs.sheet.write', 'Keep the sheet updated') }));
        keep.querySelector('input').onchange = (e) => act('sheet-write', { write: e.target.checked });
        const open = el('button', { type: 'button', className: 'jb-link', title: tr('jobs.sheet.open', 'Open the sheet') }, icon('open'));
        open.setAttribute('aria-label', tr('jobs.sheet.open', 'Open the sheet'));
        open.onclick = () => ctx.openLink(s.url);
        sheetRow = el('div', { className: 'jb-src' }, icoSheet, text, el('span', { className: 'jb-grow' }), keep, open, small(tr('jobs.sheet.sync', 'Sync now'), (b) => act('sync', null, b)), small(tr('jobs.sheet.unlink', 'Unlink'), () => act('unlink-sheet'), 'jb-quiet'));
        if (!src.sheets) sheetRow.append(small(tr('jobs.src.connectSheets', 'Connect Google Sheets'), () => act('connect')));
      } else if (linking) {
        const url = el('input', { type: 'url', className: 'jb-in jb-in-url', placeholder: tr('jobs.sheet.url', 'The sheet’s address (docs.google.com/spreadsheets/d/…)') });
        const tab = el('input', { type: 'text', className: 'jb-in jb-in-tab', placeholder: tr('jobs.sheet.tab', 'Tab (optional: the first)') });
        url.setAttribute('aria-label', tr('jobs.sheet.url', 'The sheet’s address (docs.google.com/spreadsheets/d/…)'));
        tab.setAttribute('aria-label', tr('jobs.sheet.tab', 'Tab (optional: the first)'));
        const keep = el('label', { className: 'jb-check' }, el('input', { type: 'checkbox', checked: true }), el('span', { textContent: tr('jobs.sheet.write', 'Keep the sheet updated') }));
        const go = el('button', { type: 'submit', className: 'btn small primary', textContent: tr('jobs.sheet.linkGo', 'Link and sync') });
        const form = el('form', { className: 'jb-src jb-src-form' }, icoSheet, url, tab, keep, go, small(tr('chatpage.project.cancel', 'Cancel'), () => { linking = false; render(); }));
        form.onsubmit = (e) => { e.preventDefault(); if (!url.value.trim()) { url.focus(); return; } act('link-sheet', { url: url.value, tab: tab.value, write: keep.querySelector('input').checked }, go); };
        form.append(el('p', { className: 'jb-src-note', textContent: tr('jobs.sheet.note', 'Lumen reads the first row for Company, Role, Status, Apply URL and Date Applied. Rows count toward your stats; moving a card here changes its Status cell, and an application logged here becomes a new row. Nothing else in the sheet is touched.') }));
        setTimeout(() => url.focus(), 0);
        sheetRow = form;
      } else {
        sheetRow = el('div', { className: 'jb-src' }, icoSheet, el('span', { className: 'jb-src-text', textContent: tr('jobs.sheet.none', 'Already tracking in a Google Sheet? Link it: its rows count here, and your changes go back to it.') }), small(tr('jobs.sheet.link', 'Link a Google Sheet'), () => { linking = true; render(); }, 'primary'));
      }
      // email
      const mailRow = src.gmail
        ? el('div', { className: 'jb-src' }, icoMail, el('span', { className: 'jb-src-text' }, el('strong', { textContent: tr('jobs.email.title', 'Email') }), el('span', { className: 'jb-muted', textContent: ` · ${tr('jobs.email.at', 'checked {when}', { when: ago(src.emailAt) })} · ${tr('jobs.email.how', 'confirmations, interviews, offers and rejections in Gmail')}` })), el('span', { className: 'jb-grow' }), small(tr('jobs.email.check', 'Check email'), (b) => act('check-email', null, b)))
        : el('div', { className: 'jb-src' }, icoMail, el('span', { className: 'jb-src-text', textContent: tr('jobs.email.connect', 'Let your inbox update the tracker: connect Gmail (read-only) and Lumen finds confirmations, interviews, offers and rejections for you to apply.') }), small(tr('jobs.src.connectGmail', 'Connect Gmail'), () => act('connect')));
      return el('section', { className: 'jb-sources' }, sheetRow, mailRow);
    }

    function suggestions() {
      const list = src?.suggestions || [];
      if (!list.length) return null;
      const what = (s) => ({ applied: tr('jobs.email.k.applied', 'Application received'), interview: tr('jobs.email.k.interview', 'Interview'), offer: tr('jobs.email.k.offer', 'Offer'), rejected: tr('jobs.email.k.rejected', 'Rejection') })[s.kind];
      const rows = el('ul', { className: 'jb-sug-list' });
      for (const s of list.slice(0, 12)) {
        const action = s.key ? tr('jobs.email.move', 'Move to {stage}', { stage: stageName(s.stage) }) : tr('jobs.email.add', 'Add as {stage}', { stage: stageName(s.stage) });
        const apply = small(action, (b) => act('email-apply', { id: s.id }, b), 'primary');
        const ignore = small(tr('jobs.email.ignore', 'Ignore'), (b) => act('email-ignore', { id: s.id }, b), 'jb-quiet');
        rows.append(el('li', { className: `jb-sug s-${s.stage}` },
          el('span', { className: 'jb-pill', textContent: what(s) }),
          el('span', { className: 'jb-sug-main' }, el('strong', { textContent: s.company }), s.role ? el('span', { className: 'jb-muted', textContent: ` · ${s.role}` }) : null, el('span', { className: 'jb-sug-subj', textContent: `“${s.subject}” · ${day(s.at)}`, title: s.from })),
          apply, ignore));
      }
      const all = small(tr('jobs.email.applyAll', 'Apply all'), (b) => act('email-apply', { all: true }, b));
      return el('section', { className: 'jb-sug-box' }, el('div', { className: 'jb-follow-head' }, el('strong', { textContent: list.length === 1 ? tr('jobs.email.one', '1 email could update your tracker') : tr('jobs.email.many', '{n} emails could update your tracker', { n: list.length }) }), el('span', { className: 'jb-muted', textContent: tr('jobs.email.check2', 'Sorted from the subject and preview. Check before you apply.') }), el('span', { className: 'jb-grow' }), all), rows);
    }

    function toolbar() {
      const switcher = el('div', { className: 'jb-switch' });
      switcher.setAttribute('role', 'tablist');
      switcher.setAttribute('aria-label', tr('jobs.views', 'Views'));
      const names = { board: tr('jobs.board', 'Board'), table: tr('jobs.table', 'Table'), timeline: tr('jobs.timeline', 'Timeline'), find: tr('jobs.find', 'Find jobs') };
      for (const v of VIEWS) {
        const b = el('button', { type: 'button', className: `jb-switch-btn${v === view ? ' on' : ''}` }, icon(v), el('span', { textContent: names[v] }));
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(v === view));
        b.onclick = () => { view = v; remember.set('view', v); render(); root.querySelector('.jb-switch-btn.on')?.focus(); };
        switcher.append(b);
      }
      const add = el('button', { type: 'button', className: 'btn small primary jb-add' }, icon('plus'), el('span', { textContent: tr('jobs.add', 'Add posting') }));
      add.onclick = () => addForm(add);
      const csv = el('button', { type: 'button', className: 'btn small jb-export', textContent: tr('projecttpl.apps.export', 'Export CSV') });
      csv.onclick = async () => { const out = await api.projectApplications(id, 'export').catch(() => null); say.textContent = out?.ok ? tr('projecttpl.apps.exported', 'Saved.') : out?.canceled ? '' : tr('projecttpl.apps.exportFailed', 'Could not save the file.'); };
      const profile = el('button', { type: 'button', className: 'btn small jb-profile', textContent: tr('projecttpl.apps.profile', 'Edit profile') });
      profile.onclick = () => api.projectApplications(id, 'open').catch(() => null);
      return el('div', { className: 'jb-toolbar' }, switcher, el('span', { className: 'jb-grow' }), add, csv, profile);
    }

    function addForm(anchor) {
      if (root.querySelector('.jb-addform')) { root.querySelector('.jb-addform input').focus(); return; }
      const company = el('input', { type: 'text', className: 'jb-in', maxLength: 120, placeholder: tr('jobs.company', 'Company') });
      const role = el('input', { type: 'text', className: 'jb-in', maxLength: 160, placeholder: tr('jobs.role', 'Role') });
      const url = el('input', { type: 'url', className: 'jb-in jb-in-url', maxLength: 2000, placeholder: tr('jobs.url', 'Posting address (https://…)') });
      for (const [i, label] of [[company, tr('jobs.company', 'Company')], [role, tr('jobs.role', 'Role')], [url, tr('jobs.url', 'Posting address (https://…)')]]) i.setAttribute('aria-label', label);
      const stage = el('select', { className: 'jb-in' });
      stage.setAttribute('aria-label', tr('jobs.stage', 'Stage'));
      for (const s of ['saved', 'applied']) stage.append(el('option', { value: s, textContent: stageName(s) }));
      const save = el('button', { type: 'submit', className: 'btn small primary', textContent: tr('jobs.addSave', 'Add') });
      const cancel = el('button', { type: 'button', className: 'btn small', textContent: tr('chatpage.project.cancel', 'Cancel') });
      const form = el('form', { className: 'jb-addform' }, company, role, url, stage, save, cancel);
      cancel.onclick = () => { form.remove(); anchor.focus(); };
      form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel.click(); } });
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (!company.value.trim() && !url.value.trim()) { company.focus(); return; }
        save.disabled = true;
        const out = await api.projectApplications(id, 'add', { company: company.value, role: role.value, url: url.value, stage: stage.value }).catch(() => null);
        save.disabled = false;
        if (!out?.ok) { say.textContent = out?.error || tr('jobs.addFailed', 'Could not add it.'); return; }
        await load();
      };
      root.querySelector('.jb-toolbar').after(form);
      company.focus();
    }

    function card(e) {
      const c = el('article', { className: `jb-card s-${e.stage}`, draggable: true, tabIndex: 0 });
      c.dataset.key = e.key;
      c.setAttribute('aria-label', [e.company, e.role, stageName(e.stage)].filter(Boolean).join(', '));
      const when = e.stage === 'saved' ? tr('jobs.savedOn', 'Saved {when}', { when: day(e.at) }) : tr('jobs.appliedOn', 'Applied {when}', { when: day(e.applied || e.at) });
      c.append(...[
        el('div', { className: 'jb-card-top' }, el('strong', { className: 'jb-card-co', textContent: e.company || tr('jobs.noCompany', '(no company)') }), e.stage === 'withdrawn' || e.stage === 'rejected' ? stagePill(e.stage) : null),
        e.role ? el('div', { className: 'jb-card-role', textContent: e.role }) : null,
        el('div', { className: 'jb-card-when', textContent: when }),
        el('div', { className: 'jb-card-foot' }, el('span', { className: 'jb-grow' }), postingBtn(e), resumeBtn(e), stageMenu(e))].filter(Boolean)); // (no role: no line)
      c.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/x-lumen-job', e.key); ev.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
      c.addEventListener('dragend', () => c.classList.remove('dragging'));
      c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !isImeEnter(ev) && ev.target === c && e.url) ctx.openLink(e.url); });
      return c;
    }

    function board() {
      const wrap = el('div', { className: 'jb-board' });
      for (const [col, stages] of COLUMNS) {
        const items = (data.entries || []).filter((e) => stages.includes(e.stage));
        const title = col === 'closed' ? tr('jobs.closed', 'Closed') : stageName(col);
        const list = el('div', { className: 'jb-col-list' });
        for (const e of items) list.append(card(e));
        if (!items.length) list.append(el('p', { className: 'jb-col-empty', textContent: col === 'saved' ? tr('jobs.savedEmpty', 'Postings to apply to later') : tr('jobs.dropHere', 'Drag a card here') }));
        const column = el('section', { className: `jb-col c-${col}` }, el('header', { className: 'jb-col-head' }, el('span', { className: 'jb-dot' }), el('span', { className: 'jb-col-title', textContent: title }), el('span', { className: 'jb-col-n', textContent: String(items.length) })), list);
        column.setAttribute('aria-label', `${title}: ${items.length}`);
        column.addEventListener('dragover', (ev) => { if (ev.dataTransfer.types.includes('text/x-lumen-job')) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; column.classList.add('over'); } });
        column.addEventListener('dragleave', (ev) => { if (!column.contains(ev.relatedTarget)) column.classList.remove('over'); });
        column.addEventListener('drop', (ev) => {
          ev.preventDefault();
          column.classList.remove('over');
          const key = ev.dataTransfer.getData('text/x-lumen-job');
          const e = (data.entries || []).find((x) => x.key === key);
          if (!e || stages.includes(e.stage)) return;
          const moving = root.querySelector(`.jb-card[data-key="${CSS.escape(key)}"]`);
          if (moving) { list.querySelector('.jb-col-empty')?.remove(); list.prepend(moving); } // (shown where it was dropped at once; the load that follows has the numbers)
          move(key, STAGE_OF_COLUMN[col]);
        });
        wrap.append(column);
      }
      return wrap;
    }

    function table() {
      const cols = [['company', tr('jobs.company', 'Company')], ['role', tr('jobs.role', 'Role')], ['stage', tr('jobs.stage', 'Stage')], ['at', tr('jobs.date', 'Date')], ['wait', tr('jobs.answer', 'Answer')], ['links', '']];
      const waitOf = (e) => (e.respondedAt && e.applied ? (e.respondedAt - e.applied) / DAY : e.applied && e.stage === 'applied' ? (Date.now() - e.applied) / DAY : -1);
      const val = (e, k) => (k === 'stage' ? STAGES.indexOf(e.stage) : k === 'at' ? e.at || 0 : k === 'wait' ? waitOf(e) : String(e[k] || '').toLowerCase());
      const rows = [...(data.entries || [])].sort((a, b) => { const x = val(a, sort.key); const y = val(b, sort.key); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
      const thead = el('tr');
      for (const [k, label] of cols) {
        if (k === 'links') { thead.append(el('th', { className: 'jb-th-links' })); continue; }
        const b = el('button', { type: 'button', className: 'jb-sort', textContent: label });
        b.onclick = () => { sort = { key: k, dir: sort.key === k ? -sort.dir : k === 'at' || k === 'wait' ? -1 : 1 }; render(); root.querySelector(`.jb-sort[data-k="${k}"]`)?.focus(); };
        b.dataset.k = k;
        const th = el('th', { scope: 'col' }, b);
        th.setAttribute('aria-sort', sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
        if (sort.key === k) b.append(el('span', { className: 'jb-arrow', textContent: sort.dir > 0 ? ' ↑' : ' ↓' }));
        thead.append(th);
      }
      const body = el('tbody');
      for (const e of rows) {
        const w = waitOf(e);
        const answer = e.respondedAt && e.applied ? tr('jobs.answeredIn', 'in {n} d', { n: Math.max(0, Math.round(w)) }) : e.stage === 'applied' && e.applied ? tr('jobs.waiting', 'waiting {n} d', { n: Math.floor(w) }) : '';
        body.append(el('tr', { className: `s-${e.stage}` },
          el('td', { className: 'jb-td-co', textContent: e.company || '?' }),
          el('td', { textContent: e.role || '' }),
          el('td', {}, stageMenu(e)),
          el('td', { className: 'jb-td-date', textContent: day(e.at) }),
          el('td', { className: 'jb-td-wait', textContent: answer }),
          el('td', { className: 'jb-td-links' }, postingBtn(e), resumeBtn(e))));
      }
      const t = el('table', { className: 'jb-table' }, el('thead', {}, thead), body);
      return el('div', { className: 'jb-table-wrap' }, t);
    }

    function timeline() {
      const items = data.timeline || [];
      if (!items.length) return el('p', { className: 'jb-empty', textContent: tr('jobs.timelineEmpty', 'Nothing has happened yet.') });
      const what = (it) => {
        const name = [it.company || '?', it.role].filter(Boolean).join(' · ');
        return ({ saved: tr('jobs.t.saved', 'Saved {name}', { name }), applied: tr('jobs.t.applied', 'Applied to {name}', { name }), interview: tr('jobs.t.interview', 'Interview with {name}', { name }), offer: tr('jobs.t.offer', 'Offer from {name}', { name }), rejected: tr('jobs.t.rejected', 'Rejected by {name}', { name }), withdrawn: tr('jobs.t.withdrawn', 'Withdrew from {name}', { name }) })[it.stage] || name;
      };
      const out = el('ol', { className: 'jb-timeline' });
      let lastDay = '';
      for (const it of items) {
        const d = new Date(it.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        if (d !== lastDay) { out.append(el('li', { className: 'jb-t-day', textContent: d })); lastDay = d; }
        const row = el('li', { className: `jb-t-item s-${it.stage}` }, el('span', { className: 'jb-dot' }), el('span', { className: 'jb-t-text', textContent: what(it) }), el('span', { className: 'jb-t-time', textContent: new Date(it.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }));
        if (it.url) { row.classList.add('linked'); row.tabIndex = 0; row.setAttribute('role', 'link'); row.onclick = () => ctx.openLink(it.url); row.onkeydown = (ev) => { if (ev.key === 'Enter' && !isImeEnter(ev)) ctx.openLink(it.url); }; }
        out.append(row);
      }
      return out;
    }

    // ---- Find jobs
    const find = { state: null, listings: null, busy: '', form: { query: '', location: '', type: 'internship', days: '14' }, picked: new Set() };
    async function findState() { find.state = await api.projectApplications(id, 'search-state').catch(() => null); if (view === 'find' && root.isConnected) render(); }
    function findView() {
      const box = el('section', { className: 'jb-find' });
      const st = find.state;
      if (!st) { box.append(el('p', { className: 'jb-empty', textContent: tr('projecttpl.apps.loading', 'Loading…') })); findState(); return box; }
      const head = (title, text) => el('div', { className: 'jb-find-head' }, el('strong', { textContent: title }), text ? el('span', { className: 'jb-muted', textContent: text }) : null);
      const useOwn = st.skill && !st.skill.ours;
      if (!st.skill && !st.installed) {
        const install = small(find.busy === 'install' ? tr('jobs.find.installing', 'Installing… (a minute or two)') : tr('jobs.find.install', 'Install Job search'), async (b) => {
          find.busy = 'install'; render();
          const out = await api.projectApplications(id, 'search-install').catch(() => null);
          find.busy = '';
          if (out?.state) find.state = out.state;
          say.textContent = out?.ok ? tr('jobs.find.installed', 'Job search is installed. Search below.') : out?.error || tr('jobs.src.failed', 'That didn’t work. Try again.');
          render();
        }, 'primary');
        install.disabled = find.busy === 'install';
        box.append(el('div', { className: 'jb-find-offer' },
          el('span', { className: 'jb-src-ic find', textContent: '⌕' }),
          el('div', { className: 'jb-find-offer-text' },
            el('strong', { textContent: tr('jobs.find.noSkill', 'No job search skill yet') }),
            el('p', { textContent: tr('jobs.find.offer', 'Install Job search: JobSpy, the most-starred job scraper on GitHub (MIT), searches LinkedIn, Indeed, Google Jobs and ZipRecruiter from this computer. Lumen makes a Python environment of its own and installs {pkg} there, with a skill the AI uses. It needs Python 3.10 to 3.13. Or add a job skill of your own in Settings → Skills.', { pkg: st.package }) })),
          install));
        return box;
      }
      if (useOwn) box.append(head(tr('jobs.find.ownSkill', 'Searches with your skill /{name}', { name: st.skill.name }), tr('jobs.find.ownNote', 'It runs in a new chat in this project; the listings you keep are saved here as Saved.')));
      else box.append(head(tr('jobs.find.title', 'Find jobs'), tr('jobs.find.note', 'JobSpy searches the job boards from this computer. Listings aren’t checked: open one before applying.')));
      const q = el('input', { type: 'text', className: 'jb-in jb-in-q', value: find.form.query, placeholder: tr('jobs.find.what', 'Role (mechanical engineering co-op)') });
      const loc = el('input', { type: 'text', className: 'jb-in', value: find.form.location, placeholder: tr('jobs.find.where', 'Where (Boston, MA)') });
      q.setAttribute('aria-label', tr('jobs.find.what', 'Role (mechanical engineering co-op)'));
      loc.setAttribute('aria-label', tr('jobs.find.where', 'Where (Boston, MA)'));
      const type = el('select', { className: 'jb-in' });
      type.setAttribute('aria-label', tr('jobs.find.type', 'Type'));
      for (const [v, label] of [['internship', tr('jobs.find.t.internship', 'Internship or co-op')], ['fulltime', tr('jobs.find.t.fulltime', 'Full-time')], ['', tr('jobs.find.t.any', 'Any type')]]) type.append(el('option', { value: v, textContent: label, selected: v === find.form.type }));
      const days = el('select', { className: 'jb-in' });
      days.setAttribute('aria-label', tr('jobs.find.days', 'Posted within'));
      for (const d of ['1', '3', '7', '14', '30']) days.append(el('option', { value: d, textContent: tr('jobs.find.daysN', 'Last {n} days', { n: d }), selected: d === find.form.days }));
      const go = el('button', { type: 'submit', className: 'btn small primary', textContent: find.busy === 'search' ? tr('jobs.find.searching', 'Searching… (up to a minute)') : useOwn ? tr('jobs.find.goChat', 'Search in a chat') : tr('jobs.find.go', 'Search') });
      go.disabled = find.busy === 'search';
      const form = el('form', { className: 'jb-find-form' }, q, loc, ...(useOwn ? [] : [type, days]), go);
      form.onsubmit = async (e) => {
        e.preventDefault();
        find.form = { query: q.value.trim(), location: loc.value.trim(), type: type.value, days: days.value };
        if (!find.form.query) { q.focus(); return; }
        if (useOwn) {
          ctx.newChat?.(`/${st.skill.name} ${find.form.query}${find.form.location ? ` in ${find.form.location}` : ''}\n\n${tr('jobs.find.chatAsk', 'Save each posting I want to keep with the applications tool (action add, stage saved).')}`);
          return;
        }
        find.busy = 'search'; render();
        const out = await api.projectApplications(id, 'search', { query: find.form.query, location: find.form.location, job_type: find.form.type, hours_old: Number(find.form.days) * 24, results: 30 }).catch(() => null);
        find.busy = '';
        find.listings = out?.ok ? out.listings : null;
        find.picked = new Set();
        say.textContent = out?.ok ? (out.listings.length ? '' : tr('jobs.find.none', 'Nothing found. Try other words, a wider place or more days.')) : out?.error || tr('jobs.src.failed', 'That didn’t work. Try again.');
        render();
      };
      box.append(form);
      if (useOwn && !st.installed) box.append(el('p', { className: 'jb-muted', textContent: tr('jobs.find.orInstall', 'Want to search right here instead? Remove or rename that skill and Find jobs offers Job search (JobSpy).') }));
      if (find.listings?.length) {
        const fresh = find.listings.filter((l) => !l.tracked);
        const saveSome = async (urls, b) => {
          const out = await act('search-save', { urls }, b);
          if (out?.ok) { for (const l of find.listings) if (urls.includes(l.url)) l.tracked = true; say.textContent = tr('jobs.find.saved', 'Saved {n} to the tracker.', { n: out.saved }); render(); }
        };
        const bar = el('div', { className: 'jb-find-bar' }, el('span', { className: 'jb-muted', textContent: tr('jobs.find.count', '{n} postings · {fresh} new to your tracker', { n: find.listings.length, fresh: fresh.length }) }), el('span', { className: 'jb-grow' }), fresh.length ? small(tr('jobs.find.saveAll', 'Save all {n}', { n: fresh.length }), (b) => saveSome(fresh.map((l) => l.url), b)) : null);
        const list = el('ul', { className: 'jb-find-list' });
        for (const l of find.listings) {
          const save = l.tracked ? el('span', { className: 'jb-pill s-saved', textContent: tr('jobs.find.inTracker', 'In tracker') }) : small(tr('jobs.find.save', 'Save'), (b) => saveSome([l.url], b), 'primary');
          const meta = [l.location, l.remote ? tr('jobs.find.remote', 'remote') : '', l.site, l.posted ? day(l.posted) : '', l.pay].filter(Boolean).join(' · ');
          list.append(el('li', { className: 'jb-find-row' },
            el('div', { className: 'jb-find-main' }, el('strong', { textContent: l.title }), el('span', { className: 'jb-find-co', textContent: l.company || '?' }), el('span', { className: 'jb-muted', textContent: meta })),
            linkBtn(tr('jobs.posting', 'Open the posting'), 'open', () => ctx.openLink(l.url), 'jb-posting'), save));
        }
        box.append(bar, list);
      }
      return box;
    }

    function profileLine() {
      const p = data.profile;
      return el('p', { className: 'jb-profile-line' }, p
        ? tr('projecttpl.apps.profileLine', 'Profile “{name}”: résumé {resume}, cover letter {cover}.', { name: p.name, resume: p.resume || tr('projecttpl.apps.none', 'not chosen yet'), cover: p.cover || tr('projecttpl.apps.none', 'not chosen yet') })
        : tr('projecttpl.apps.noProfile', 'No automation profile yet: Edit profile makes one.'));
    }

    function render() {
      if (!data) return; // (Find jobs' state can answer before the tracker does: the load draws it)
      const empty = !(data.entries || []).length;
      const parts = [tiles(), sources(), suggestions(), followUps(), toolbar(), profileLine()];
      if (view === 'find') parts.push(findView());
      else if (empty) parts.push(el('div', { className: 'jb-empty-state' }, el('strong', { textContent: tr('jobs.emptyTitle', 'No applications yet') }), el('p', { textContent: tr('jobs.emptyText', 'Ask in a chat here: “tailor my résumé for this posting”. After you submit, the AI logs it and it shows up here. Or add a posting yourself to keep it for later.') })));
      else parts.push(view === 'table' ? table() : view === 'timeline' ? timeline() : board());
      parts.push(say);
      root.replaceChildren(...parts.filter(Boolean));
    }

    root.append(el('p', { className: 'jb-empty', textContent: tr('projecttpl.apps.loading', 'Loading…') }));
    if (view === 'find') findState();
    load();
    // (a chat logged one: drawn again, but never under a half-typed posting or an open stage menu)
    const busy = () => linking || view === 'find' || Boolean(root.querySelector('.jb-addform')) || (root.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName));
    return { refresh: () => (root.isConnected && !busy() ? load() : null) };
  }

  window.chatJobBoard = { draw };
})();
