// [project templates] The job dashboard: the Applications view of a Job applications project (chat-project-page.js). Loaded the first
// time a job project's page is opened (with chat-job-board.css), never with the page itself.
//   window.chatJobBoard.draw(box, ctx) -> { refresh(), dispose() }
//     ctx: { api, id, tr(key, english, vars), openLink(url), toast(text), newChat(text) }
//   window.chatJobBoard.fuzzy(query, text) -> { score, hits } | null   (the palette's filter; unit-tested in test/units/job-board-units.js)
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
// [job dashboard look] Read top to bottom: one action bar (the views, Check email, Sync, Export, Edit profile, the Ctrl+K / ⌘K hint and
// Add posting), then Progress (the main numbers), then Needs attention (emails, follow-ups), Outcomes, the view, and Sources. Every card is
// the one .jb-panel. Ctrl+K / ⌘K opens the dashboard's command palette while the dashboard shows: the page claims the key from main
// (chatpage:palette-key, main.js) and gives it back when the dashboard goes; Ctrl+K in the address bar stays Lumen's command bar.
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
    sheet: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M2.5 10h11M6.5 6.5v7"/>',
    mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4.3 5.5-4.3"/>',
    sync: '<path d="M13 6.5A5 5 0 0 0 3.7 5M3 9.5A5 5 0 0 0 12.3 11"/><path d="M3.5 2.5V5h2.5M12.5 13.5V11H10"/>',
    save: '<path d="M8 2.5v7.5M5 7l3 3 3-3M3 12.5h10"/>',
    user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8"/>',
    go: '<path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/>',
    card: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M5 6.5h6M5 9h4"/>',
    link: '<path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>',
  };
  const icon = (name) => { const s = el('span', { className: 'jb-ic' }); s.setAttribute('aria-hidden', 'true'); s.innerHTML = `<svg viewBox="0 0 16 16">${ICON[name]}</svg>`; return s; };
  const remember = {
    get: (k, d) => { try { return localStorage.getItem(`lumen.jobBoard.${k}`) || d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`lumen.jobBoard.${k}`, v); } catch { /* private storage off: the choice lasts this visit */ } },
  };
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || '') || document.documentElement.classList.contains('platform-darwin');

  // The palette's filter: the query's letters in order in the text (spaces ignored). Matches at the start of a word and runs of letters
  // count more, gaps and a long text less. -> { score, hits: [indexes in text] } | null
  function fuzzy(query, text) {
    const q = String(query || '').toLowerCase().replace(/\s+/g, '');
    const t = String(text || '');
    const low = t.toLowerCase();
    if (!q) return { score: 0, hits: [] };
    const hits = [];
    let score = 0;
    let from = 0;
    let prev = -2;
    for (const ch of q) {
      // prefer the next match at a word start, if there is one before the plain next match runs out of room
      let at = low.indexOf(ch, from);
      if (at < 0) return null;
      const wordAt = (() => { for (let i = at; i < low.length; i++) if (low[i] === ch && (i === 0 || /[\s\-_/·.(]/.test(low[i - 1]))) return i; return -1; })();
      if (wordAt >= 0 && wordAt !== at && prev !== at - 1) at = wordAt;
      const wordStart = at === 0 || /[\s\-_/·.(]/.test(low[at - 1]);
      score += 1 + (at === prev + 1 ? 3 : 0) + (wordStart ? 4 : 0) + (at === 0 ? 2 : 0) - Math.min(3, (at - from) * 0.15);
      hits.push(at);
      prev = at;
      from = at + 1;
    }
    score -= t.length * 0.02;
    return { score, hits };
  }

  function draw(box, ctx) {
    const { api, id, tr } = ctx;
    const stageName = (s) => tr(`projecttpl.stage.${s}`, s);
    const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
    let data = null;
    let src = null; // the sources: { sheet, sheets, gmail, emailAt, suggestions }
    let autoDone = false; // (the dashboard's first draw syncs the sheet and checks email once, when they are due)
    let linking = false;
    let disposed = false;
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
      if (out?.ok && action === 'check-email' && out.suggestions?.length) root.querySelector('.jb-sug-box')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); // (what the button found, in view)
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
    const section = (key, title, aside, ...body) => {
      const h = el('h2', { className: 'jb-h', id: `jb-h-${key}-${id}`, textContent: title });
      const s = el('section', { className: `jb-sec jb-sec-${key}` }, el('div', { className: 'jb-sec-head' }, h, aside ? el('span', { className: 'jb-caption', textContent: aside }) : null), ...body);
      s.setAttribute('aria-labelledby', h.id);
      return s;
    };

    // ---- the parts
    const linkBtn = (label, iconName, run, className) => { const b = el('button', { type: 'button', className: `jb-link ${className}`, title: label }, icon(iconName)); b.setAttribute('aria-label', label); b.onclick = (ev) => { ev.stopPropagation(); run(); }; return b; };
    const postingBtn = (e) => (e.url ? linkBtn(tr('jobs.posting', 'Open the posting'), 'open', () => ctx.openLink(e.url), 'jb-posting') : null);
    const openResume = async (e) => { const out = await api.projectApplications(id, 'resume', { key: e.key }).catch(() => null); if (!out?.ok) say.textContent = tr('jobs.resumeFailed', 'Could not open the résumé.'); };
    const resumeBtn = (e) => (e.resume ? linkBtn(tr('jobs.resume', 'Open the tailored résumé: {name}', { name: e.resume }), 'doc', () => openResume(e), 'jb-resume') : null);
    function stageMenu(e) {
      const sel = el('select', { className: 'jb-stage-select' });
      sel.setAttribute('aria-label', tr('jobs.stageFor', 'Stage of {name}', { name: [e.company, e.role].filter(Boolean).join(', ') }));
      for (const s of STAGES) sel.append(el('option', { value: s, textContent: stageName(s), selected: s === e.stage }));
      sel.onchange = () => move(e.key, sel.value);
      sel.onclick = (ev) => ev.stopPropagation();
      return sel;
    }
    const tile = (value, label, { className = '', hint = '', big = false, extra = null } = {}) => el('div', { className: `jb-panel jb-tile ${className}`.trim(), title: hint }, el('span', { className: big ? 'jb-display jb-tile-n' : 'jb-tile-n', textContent: value }), el('span', { className: 'jb-tile-l', textContent: label }), extra);

    // Progress: the main numbers
    function progress() {
      const st = data.stats || {};
      const max = Math.max(1, ...(st.weeks || []));
      const bars = el('div', { className: 'jb-bars' });
      bars.setAttribute('role', 'img');
      bars.setAttribute('aria-label', tr('jobs.weeksLabel', 'Applications per week, the last 8 weeks: {list}', { list: (st.weeks || []).join(', ') }));
      (st.weeks || []).forEach((n, i) => { const b = el('span', { className: `jb-bar${i === 7 ? ' now' : ''}`, title: tr('jobs.weekBar', '{n} that week', { n }) }); b.style.setProperty('--h', `${Math.round((n / max) * 100)}%`); bars.append(b); });
      const weeksTile = el('div', { className: 'jb-panel jb-tile jb-tile-chart' }, bars, el('span', { className: 'jb-tile-l', textContent: tr('jobs.weeks', 'Last 8 weeks') }));
      return section('progress', tr('jobs.sec.progress', 'Progress'), st.saved ? tr('jobs.savedHint', '{n} saved for later', { n: st.saved }) : '',
        el('div', { className: 'jb-tiles main' },
          tile(String(st.week ?? 0), tr('jobs.week', 'Applied this week'), { big: true }),
          tile(String(st.month ?? 0), tr('jobs.month', 'This month'), { big: true }),
          tile(String(st.total ?? 0), tr('jobs.total', 'Total applied'), { big: true }),
          tile(st.responseRate === null || st.responseRate === undefined ? '–' : `${st.responseRate}%`, tr('jobs.rate', 'Response rate'), { className: 'rate', hint: tr('jobs.rateHint', 'Heard back (an interview, an offer or a rejection) out of all applied'), big: true }),
          weeksTile));
    }
    // Outcomes: what came back. The numbers are the tracker's (the sheet's Status cells, when one is linked: the truth); what the last
    // email check found and isn't applied yet shows under them ("+2 in email"), a click away from the emails, so an email never changes a
    // number on its own.
    function outcomes() {
      const st = data.stats || {};
      const waiting = (kind) => (src?.suggestions || []).filter((s) => s.kind === kind).length;
      const inEmail = (kind) => {
        const n = waiting(kind);
        if (!n) return null;
        const b = el('button', { type: 'button', className: 'jb-tile-more', textContent: tr('jobs.inEmail', '+{n} in email', { n }) });
        b.title = tr('jobs.inEmailHint', 'Found in your email, not applied yet. Check them in Needs attention.');
        b.onclick = () => root.querySelector('.jb-sug-box')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        return b;
      };
      const avg = st.avgDays === null || st.avgDays === undefined ? '–' : tr('jobs.days', '{n} d', { n: st.avgDays });
      return section('outcomes', tr('jobs.sec.outcomes', 'Outcomes'), st.answered ? tr('jobs.avgOf', 'Avg. from {n} dated answers', { n: st.answered }) : '',
        el('div', { className: 'jb-tiles' },
          tile(String(st.interviews ?? 0), tr('jobs.interviews', 'Interviews'), { className: 's-interview', extra: inEmail('interview') }),
          tile(String(st.offers ?? 0), tr('jobs.offers', 'Offers'), { className: 's-offer', extra: inEmail('offer') }),
          tile(String(st.rejections ?? 0), tr('jobs.rejections', 'Rejections'), { className: 's-rejected', extra: inEmail('rejected') }),
          tile(String(st.waiting ?? 0), tr('jobs.out.waiting', 'Waiting to hear back'), { hint: tr('jobs.out.waitingHint', 'Applied, no interview, offer or rejection yet') }),
          tile(String(st.closed ?? 0), tr('jobs.out.closed', 'Closed or skipped'), { hint: tr('jobs.out.closedHint', 'Withdrawn, skipped, or the posting closed') }),
          tile(avg, tr('jobs.avgDays', 'Avg. days to an answer'), { hint: tr('jobs.avgHint', 'From the day you applied to the first interview, offer or rejection, for the answers with a date') })));
    }

    // From your sheet: the linked sheet's own numbers (its Dashboard tab's counts, say: main reads its other tabs on each sync, job-sync.js
    // sheetMetrics), as the sheet lays them out: one card per block, a bar per line, so nothing in the sheet is left off the dashboard.
    function sheetNumbers() {
      const tabs = (src?.sheet?.metrics || []).filter((t) => t?.blocks?.length);
      if (!tabs.length) return null;
      const cards = el('div', { className: 'jb-sheet-grid' });
      for (const t of tabs) {
        for (const b of t.blocks) {
          const card = el('div', { className: 'jb-panel jb-sheet-card' }, el('strong', { className: 'jb-sub', textContent: b.title || t.tab }));
          if (b.text) card.append(el('span', { className: 'jb-sheet-text', textContent: b.text }));
          const max = Math.max(1, ...(b.rows || []).map((r) => Math.abs(r.n) || 0));
          const list = el('ul', { className: 'jb-sheet-rows' });
          for (const r of b.rows || []) {
            const bar = el('span', { className: 'jb-sheet-bar' }, el('i'));
            bar.firstChild.style.width = `${Math.round(((Math.abs(r.n) || 0) / max) * 100)}%`;
            list.append(el('li', { className: 'jb-sheet-row' }, el('span', { className: 'jb-sheet-label', textContent: r.label }), bar, el('span', { className: 'jb-sheet-n', textContent: r.value })));
          }
          if (b.rows?.length) card.append(list);
          cards.append(card);
        }
      }
      return section('sheet', tr('jobs.sec.sheet', 'From your sheet'), tabs.map((t) => t.tab).join(' · '), cards);
    }

    function followUps() {
      const due = data.followUps || [];
      if (!due.length) return null;
      const list = el('ul', { className: 'jb-list' });
      for (const e of due.slice(0, 6)) {
        list.append(el('li', { className: 'jb-row jb-follow-row' },
          el('span', { className: 'jb-follow-days', textContent: tr('jobs.waited', '{n} days', { n: e.waited }) }),
          el('span', { className: 'jb-follow-name' }, el('strong', { textContent: e.company || '?' }), e.role ? el('span', { textContent: ` · ${e.role}` }) : null),
          postingBtn(e), resumeBtn(e), stageMenu(e)));
      }
      const head = el('div', { className: 'jb-panel-head' }, icon('clock'), el('strong', { className: 'jb-sub', textContent: due.length === 1 ? tr('jobs.follow1', '1 follow-up due') : tr('jobs.followN', '{n} follow-ups due', { n: due.length }) }), el('span', { className: 'jb-caption', textContent: tr('jobs.followNote', 'Applied 2+ weeks ago with no answer. A short, polite check-in helps.') }));
      return el('div', { className: 'jb-panel jb-follow' }, head, list, due.length > 6 ? el('p', { className: 'jb-caption jb-more', textContent: tr('jobs.followMore', '{n} more in the table.', { n: due.length - 6 }) }) : null);
    }

    // Sources: what is linked and how it is doing (Sync and Check email are in the action bar)
    function sources() {
      if (!src) return null;
      const ico = (name, cls) => { const i = el('span', { className: `jb-src-ic ${cls}` }, icon(name)); i.setAttribute('aria-hidden', 'true'); return i; };
      const icoSheet = ico('sheet', 'sheet');
      const icoMail = ico('mail', 'mail');
      let sheetRow;
      if (!src.sheets && !src.sheet) {
        sheetRow = el('div', { className: 'jb-src' }, icoSheet, el('span', { className: 'jb-src-text', textContent: tr('jobs.sheet.connect', 'Track in a Google Sheet? Connect Google Sheets, then link your tracker: its rows count here and your changes go back to it.') }), small(tr('jobs.src.connectSheets', 'Connect Google Sheets'), () => act('connect')));
      } else if (src.sheet && !linking) {
        const s = src.sheet;
        const text = el('span', { className: 'jb-src-text' }, el('strong', { textContent: tr('jobs.sheet.linked', 'Your tracker sheet') }), el('span', { className: 'jb-muted', textContent: ` · ${s.tab ? `${s.tab} · ` : ''}${s.error ? '' : tr('jobs.sheet.at', 'synced {when}', { when: ago(s.at) })}` }));
        if (s.error) text.append(el('span', { className: 'jb-src-error', textContent: ` ${s.error}` }));
        const keep = el('label', { className: 'jb-check' }, el('input', { type: 'checkbox', checked: s.write !== false }), el('span', { textContent: tr('jobs.sheet.write', 'Keep the sheet updated') }));
        keep.querySelector('input').onchange = (e) => act('sheet-write', { write: e.target.checked });
        sheetRow = el('div', { className: 'jb-src' }, icoSheet, text, keep, linkBtn(tr('jobs.sheet.open', 'Open the sheet'), 'open', () => ctx.openLink(s.url), ''), small(tr('jobs.sheet.unlink', 'Unlink'), () => act('unlink-sheet'), 'jb-quiet'));
        if (!src.sheets) sheetRow.append(small(tr('jobs.src.connectSheets', 'Connect Google Sheets'), () => act('connect')));
      } else if (linking) {
        const url = el('input', { type: 'url', className: 'jb-in jb-in-url', placeholder: tr('jobs.sheet.url', 'The sheet’s address (docs.google.com/spreadsheets/d/…)') });
        const tab = el('input', { type: 'text', className: 'jb-in jb-in-tab', placeholder: tr('jobs.sheet.tab', 'Tab (optional: the first)') });
        url.setAttribute('aria-label', tr('jobs.sheet.url', 'The sheet’s address (docs.google.com/spreadsheets/d/…)'));
        tab.setAttribute('aria-label', tr('jobs.sheet.tab', 'Tab (optional: the first)'));
        const keep = el('label', { className: 'jb-check' }, el('input', { type: 'checkbox', checked: true }), el('span', { textContent: tr('jobs.sheet.write', 'Keep the sheet updated') }));
        const go = el('button', { type: 'submit', className: 'btn small primary', textContent: tr('jobs.sheet.linkGo', 'Link and sync') });
        const form = el('form', { className: 'jb-src jb-src-form jb-form' }, icoSheet, url, tab, keep, go, small(tr('chatpage.project.cancel', 'Cancel'), () => { linking = false; render(); }));
        form.onsubmit = (e) => { e.preventDefault(); if (!url.value.trim()) { url.focus(); return; } act('link-sheet', { url: url.value, tab: tab.value, write: keep.querySelector('input').checked }, go); };
        form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); linking = false; render(); } });
        form.append(el('p', { className: 'jb-note', textContent: tr('jobs.sheet.note', 'Lumen reads the first row for Company, Role, Status, Apply URL and Date Applied. Rows count toward your stats; moving a card here changes its Status cell, and an application logged here becomes a new row. Nothing else in the sheet is touched.') }));
        setTimeout(() => url.focus(), 0);
        sheetRow = form;
      } else {
        sheetRow = el('div', { className: 'jb-src' }, icoSheet, el('span', { className: 'jb-src-text', textContent: tr('jobs.sheet.none', 'Already tracking in a Google Sheet? Link it: its rows count here, and your changes go back to it.') }), small(tr('jobs.sheet.link', 'Link a Google Sheet'), () => startLinking(), 'primary'));
      }
      const mailRow = src.gmail
        ? el('div', { className: 'jb-src' }, icoMail, el('span', { className: 'jb-src-text' }, el('strong', { textContent: tr('jobs.email.title', 'Email') }), el('span', { className: 'jb-muted', textContent: ` · ${tr('jobs.email.at', 'checked {when}', { when: ago(src.emailAt) })} · ${tr('jobs.email.how', 'confirmations, interviews, offers and rejections in Gmail')}` })))
        : el('div', { className: 'jb-src' }, icoMail, el('span', { className: 'jb-src-text', textContent: tr('jobs.email.connect', 'Let your inbox update the tracker: connect Gmail (read-only) and Lumen finds confirmations, interviews, offers and rejections for you to apply.') }), small(tr('jobs.src.connectGmail', 'Connect Gmail'), () => act('connect')));
      return el('div', { className: 'jb-panel jb-sources' }, sheetRow, mailRow);
    }
    const startLinking = () => { linking = true; render(); root.querySelector('.jb-sec-sources')?.scrollIntoView({ block: 'nearest' }); };

    function suggestions() {
      const list = src?.suggestions || [];
      if (!list.length) return null;
      const what = (s) => ({ applied: tr('jobs.email.k.applied', 'Application received'), interview: tr('jobs.email.k.interview', 'Interview'), offer: tr('jobs.email.k.offer', 'Offer'), rejected: tr('jobs.email.k.rejected', 'Rejection') })[s.kind];
      const rows = el('ul', { className: 'jb-list' });
      for (const s of list.slice(0, 12)) {
        const action = s.key ? tr('jobs.email.move', 'Move to {stage}', { stage: stageName(s.stage) }) : tr('jobs.email.add', 'Add as {stage}', { stage: stageName(s.stage) });
        const apply = small(action, (b) => act('email-apply', { id: s.id }, b), 'primary');
        const ignore = small(tr('jobs.email.ignore', 'Ignore'), (b) => act('email-ignore', { id: s.id }, b), 'jb-quiet');
        // The company and subject open the email in Gmail (a new tab), to see what it is before applying.
        const main = el(s.link ? 'button' : 'span', { className: 'jb-sug-main' }, el('strong', { textContent: s.company }), s.role ? el('span', { className: 'jb-muted', textContent: ` · ${s.role}` }) : null, el('span', { className: 'jb-sug-subj', textContent: `“${s.subject}” · ${day(s.at)}` }));
        if (s.link) {
          main.type = 'button';
          main.title = tr('jobs.email.open', 'Open in Gmail: {from}', { from: s.from });
          main.onclick = () => ctx.openLink(s.link);
        } else main.title = s.from;
        rows.append(el('li', { className: `jb-row jb-sug s-${s.stage}` }, el('span', { className: 'jb-pill', textContent: what(s) }), main, apply, ignore));
      }
      const all = small(tr('jobs.email.applyAll', 'Apply all'), (b) => act('email-apply', { all: true }, b));
      return el('div', { className: 'jb-panel jb-sug-box' }, el('div', { className: 'jb-panel-head' }, icon('mail'), el('strong', { className: 'jb-sub', textContent: list.length === 1 ? tr('jobs.email.one', '1 email could update your tracker') : tr('jobs.email.many', '{n} emails could update your tracker', { n: list.length }) }), el('span', { className: 'jb-caption', textContent: tr('jobs.email.check2', 'Sorted from the subject and preview. Check before you apply.') }), el('span', { className: 'jb-grow' }), all), rows);
    }

    // The action bar: every page action, in one place on top
    const viewNames = () => ({ board: tr('jobs.board', 'Board'), table: tr('jobs.table', 'Table'), timeline: tr('jobs.timeline', 'Timeline'), find: tr('jobs.find', 'Find jobs') });
    function setView(v) { view = v; remember.set('view', v); render(); }
    const exportCsv = async () => { const out = await api.projectApplications(id, 'export').catch(() => null); say.textContent = out?.ok ? tr('projecttpl.apps.exported', 'Saved.') : out?.canceled ? '' : tr('projecttpl.apps.exportFailed', 'Could not save the file.'); };
    const editProfile = () => api.projectApplications(id, 'open').catch(() => null);
    const actBtn = (label, iconName, run, className = '') => { const b = el('button', { type: 'button', className: `jb-act ${className}`.trim() }, icon(iconName), el('span', { textContent: label })); b.onclick = () => run(b); return b; };
    function actionBar() {
      const switcher = el('div', { className: 'jb-switch' });
      switcher.setAttribute('role', 'tablist');
      switcher.setAttribute('aria-label', tr('jobs.views', 'Views'));
      const names = viewNames();
      for (const v of VIEWS) {
        const b = el('button', { type: 'button', className: `jb-switch-btn${v === view ? ' on' : ''}` }, icon(v), el('span', { textContent: names[v] }));
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(v === view));
        b.onclick = () => { setView(v); root.querySelector('.jb-switch-btn.on')?.focus(); };
        switcher.append(b);
      }
      const add = el('button', { type: 'button', className: 'jb-cta jb-add' }, icon('plus'), el('span', { textContent: tr('jobs.add', 'Add posting') }));
      add.onclick = () => addForm(add);
      const kbd = el('button', { type: 'button', className: 'jb-kbd', title: tr('jobs.pal.open', 'Search the dashboard and run an action') }, el('kbd', { textContent: MAC ? '⌘K' : 'Ctrl K' }));
      kbd.setAttribute('aria-label', tr('jobs.pal.label', 'Command palette ({key})', { key: MAC ? '⌘K' : 'Ctrl+K' }));
      kbd.setAttribute('aria-haspopup', 'dialog');
      kbd.onclick = () => openPalette(kbd);
      const bar = el('div', { className: 'jb-panel jb-actions' }, switcher, el('span', { className: 'jb-grow' }),
        src?.gmail ? actBtn(tr('jobs.email.check', 'Check email'), 'mail', (b) => act('check-email', null, b), 'jb-check-email') : null,
        src?.sheet && src?.sheets ? actBtn(tr('jobs.sheet.sync', 'Sync now'), 'sync', (b) => act('sync', null, b), 'jb-sync') : null,
        actBtn(tr('projecttpl.apps.export', 'Export CSV'), 'save', exportCsv, 'jb-export'),
        actBtn(tr('projecttpl.apps.profile', 'Edit profile'), 'user', editProfile, 'jb-profile'),
        kbd, add);
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', tr('jobs.actions', 'Dashboard actions'));
      return bar;
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
      const form = el('form', { className: 'jb-panel jb-addform jb-form' }, company, role, url, stage, save, cancel);
      cancel.onclick = () => { form.remove(); anchor?.isConnected ? anchor.focus() : root.querySelector('.jb-add')?.focus(); };
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
      root.querySelector('.jb-actions').after(form);
      company.focus();
    }

    function card(e) {
      const c = el('article', { className: `jb-panel jb-card s-${e.stage}`, draggable: true, tabIndex: 0 });
      c.dataset.key = e.key;
      c.setAttribute('aria-label', [e.company, e.role, stageName(e.stage)].filter(Boolean).join(', '));
      const when = e.stage === 'saved' ? tr('jobs.savedOn', 'Saved {when}', { when: day(e.at) }) : tr('jobs.appliedOn', 'Applied {when}', { when: day(e.applied || e.at) });
      c.append(...[
        el('div', { className: 'jb-card-top' }, el('strong', { className: 'jb-card-co', textContent: e.company || tr('jobs.noCompany', '(no company)'), title: e.company || '' })),
        e.role ? el('div', { className: 'jb-card-role', textContent: e.role, title: e.role }) : null,
        // The date and the controls share one line (the stage menu names rejected or withdrawn in Closed): a card is three short lines.
        el('div', { className: 'jb-card-foot' }, el('span', { className: 'jb-card-when', textContent: when }), postingBtn(e), resumeBtn(e), stageMenu(e))].filter(Boolean)); // (no role: no line)
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
        // A long column shows its first few (Closed fewer: it is history) and a button for the rest, so one column of 30 doesn't make
        // the page a long scroll to what is under the board. Opened stays open (remembered per column).
        const cap = col === 'closed' ? 3 : 6;
        const open = remember.get(`open.${col}`, '') === '1';
        for (const e of open ? items : items.slice(0, cap)) list.append(card(e));
        if (items.length > cap) {
          const more = el('button', { type: 'button', className: 'jb-col-more', textContent: open ? tr('jobs.showFewer', 'Show fewer') : tr('jobs.showAll', 'Show all {n}', { n: items.length }) });
          more.setAttribute('aria-expanded', String(open));
          more.onclick = () => { remember.set(`open.${col}`, open ? '' : '1'); render(); root.querySelector(`.jb-col.c-${col} .jb-col-more`)?.focus(); };
          list.append(more);
        }
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
        const tr2 = el('tr', { className: `s-${e.stage}` },
          el('td', { className: 'jb-td-co', textContent: e.company || '?' }),
          el('td', { textContent: e.role || '' }),
          el('td', {}, stageMenu(e)),
          el('td', { className: 'jb-td-date', textContent: day(e.at) }),
          el('td', { className: 'jb-td-wait', textContent: answer }),
          el('td', { className: 'jb-td-links' }, postingBtn(e), resumeBtn(e)));
        tr2.dataset.key = e.key;
        body.append(tr2);
      }
      const t = el('table', { className: 'jb-table' }, el('thead', {}, thead), body);
      return el('div', { className: 'jb-panel jb-table-wrap' }, t);
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
      return el('div', { className: 'jb-panel' }, out);
    }

    // ---- Find jobs
    const find = { state: null, listings: null, busy: '', form: { query: '', location: '', type: 'internship', days: '14' }, picked: new Set() };
    async function findState() { find.state = await api.projectApplications(id, 'search-state').catch(() => null); if (view === 'find' && root.isConnected) render(); }
    function findView() {
      const box = el('div', { className: 'jb-find' });
      const st = find.state;
      if (!st) { box.append(el('p', { className: 'jb-empty', textContent: tr('projecttpl.apps.loading', 'Loading…') })); findState(); return box; }
      const head = (title, text) => el('div', { className: 'jb-panel-head' }, el('strong', { className: 'jb-sub', textContent: title }), text ? el('span', { className: 'jb-caption', textContent: text }) : null);
      const useOwn = st.skill && !st.skill.ours;
      if (!st.skill && !st.installed) {
        const install = small(find.busy === 'install' ? tr('jobs.find.installing', 'Installing… (a minute or two)') : tr('jobs.find.install', 'Install Job search'), async () => {
          find.busy = 'install'; render();
          const out = await api.projectApplications(id, 'search-install').catch(() => null);
          find.busy = '';
          if (out?.state) find.state = out.state;
          say.textContent = out?.ok ? tr('jobs.find.installed', 'Job search is installed. Search below.') : out?.error || tr('jobs.src.failed', 'That didn’t work. Try again.');
          render();
        }, 'primary');
        install.disabled = find.busy === 'install';
        const mark = el('span', { className: 'jb-src-ic find' }, icon('find'));
        mark.setAttribute('aria-hidden', 'true');
        box.append(el('div', { className: 'jb-panel jb-find-offer' },
          mark,
          el('div', { className: 'jb-find-offer-text' },
            el('strong', { className: 'jb-sub', textContent: tr('jobs.find.noSkill', 'No job search skill yet') }),
            el('p', { textContent: tr('jobs.find.offer', 'Install Job search: JobSpy, the most-starred job scraper on GitHub (MIT), searches LinkedIn, Indeed, Google Jobs and ZipRecruiter from this computer. Lumen makes a Python environment of its own and installs {pkg} there, with a skill the AI uses. It needs Python 3.10 to 3.13. Or add a job skill of your own in Settings → Skills.', { pkg: st.package }) })),
          install));
        return box;
      }
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
      const form = el('form', { className: 'jb-find-form jb-form' }, q, loc, ...(useOwn ? [] : [type, days]), go);
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
      const searchPanel = el('div', { className: 'jb-panel jb-find' },
        useOwn ? head(tr('jobs.find.ownSkill', 'Searches with your skill /{name}', { name: st.skill.name }), tr('jobs.find.ownNote', 'It runs in a new chat in this project; the listings you keep are saved here as Saved.'))
          : head(tr('jobs.find.title', 'Find jobs'), tr('jobs.find.note', 'JobSpy searches the job boards from this computer. Listings aren’t checked: open one before applying.')),
        form,
        useOwn && !st.installed ? el('p', { className: 'jb-caption', textContent: tr('jobs.find.orInstall', 'Want to search right here instead? Remove or rename that skill and Find jobs offers Job search (JobSpy).') }) : null);
      box.append(searchPanel);
      if (find.listings?.length) {
        const fresh = find.listings.filter((l) => !l.tracked);
        const saveSome = async (urls, b) => {
          const out = await act('search-save', { urls }, b);
          if (out?.ok) { for (const l of find.listings) if (urls.includes(l.url)) l.tracked = true; say.textContent = tr('jobs.find.saved', 'Saved {n} to the tracker.', { n: out.saved }); render(); }
        };
        const bar = el('div', { className: 'jb-find-bar' }, el('span', { className: 'jb-caption', textContent: tr('jobs.find.count', '{n} postings · {fresh} new to your tracker', { n: find.listings.length, fresh: fresh.length }) }), el('span', { className: 'jb-grow' }), fresh.length ? small(tr('jobs.find.saveAll', 'Save all {n}', { n: fresh.length }), (b) => saveSome(fresh.map((l) => l.url), b)) : null);
        const list = el('ul', { className: 'jb-panel jb-find-list' });
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
      return el('p', { className: 'jb-caption jb-profile-line' }, p
        ? tr('projecttpl.apps.profileLine', 'Profile “{name}”: résumé {resume}, cover letter {cover}.', { name: p.name, resume: p.resume || tr('projecttpl.apps.none', 'not chosen yet'), cover: p.cover || tr('projecttpl.apps.none', 'not chosen yet') })
        : tr('projecttpl.apps.noProfile', 'No automation profile yet: Edit profile makes one.'));
    }

    function render() {
      if (!data) return; // (Find jobs' state can answer before the tracker does: the load draws it)
      const empty = !(data.entries || []).length;
      const attention = [suggestions(), followUps()].filter(Boolean);
      const viewTitle = { board: tr('jobs.sec.board', 'Pipeline'), table: tr('jobs.sec.table', 'All applications'), timeline: tr('jobs.sec.timeline', 'Activity'), find: tr('jobs.find', 'Find jobs') }[view];
      let content;
      if (view === 'find') content = findView();
      else if (empty) content = el('div', { className: 'jb-panel jb-empty-state' }, el('strong', { className: 'jb-sub', textContent: tr('jobs.emptyTitle', 'No applications yet') }), el('p', { textContent: tr('jobs.emptyText', 'Ask in a chat here: “tailor my résumé for this posting”. After you submit, the AI logs it and it shows up here. Or add a posting yourself to keep it for later.') }));
      else content = view === 'table' ? table() : view === 'timeline' ? timeline() : board();
      const keepForm = root.querySelector('.jb-addform');
      const parts = [
        actionBar(),
        keepForm,
        say,
        section('view', viewTitle, '', content), // (right under the switcher: picking a view changes what is next to it, not something a screen below)
        attention.length ? el('div', { className: 'jb-pair' }, section('attention', tr('jobs.sec.attention', 'Needs attention'), '', ...attention), outcomes()) : outcomes(), // (side by side on a wide page)
        progress(),
        sheetNumbers(),
        src ? section('sources', tr('jobs.sec.sources', 'Sources'), '', sources(), profileLine()) : section('sources', tr('jobs.sec.sources', 'Sources'), '', profileLine()),
      ];
      root.replaceChildren(...parts.filter(Boolean));
    }

    // ---- the command palette: Ctrl+K / ⌘K, or the hint button in the action bar
    let pal = null;
    function paletteItems() {
      const names = viewNames();
      const items = [];
      const g = { act: tr('jobs.pal.actions', 'Actions'), view: tr('jobs.pal.views', 'Views'), sec: tr('jobs.pal.sections', 'Sections'), app: tr('jobs.pal.apps', 'Applications') };
      const add = (group, iconName, title, run, hint = '') => items.push({ group, icon: iconName, title, run, hint });
      add(g.act, 'plus', tr('jobs.add', 'Add posting'), () => addForm(root.querySelector('.jb-add')));
      if (src?.gmail) add(g.act, 'mail', tr('jobs.email.check', 'Check email'), () => act('check-email'));
      if (src?.sheet && src?.sheets) add(g.act, 'sync', tr('jobs.pal.sync', 'Sync the tracker sheet'), () => act('sync'));
      if (src?.sheet?.url) add(g.act, 'open', tr('jobs.sheet.open', 'Open the sheet'), () => ctx.openLink(src.sheet.url));
      if (src?.sheets && !src?.sheet) add(g.act, 'link', tr('jobs.sheet.link', 'Link a Google Sheet'), startLinking);
      if (src && (!src.sheets || !src.gmail)) add(g.act, 'link', tr('jobs.pal.connect', 'Connect Google (Sheets, Gmail)'), () => act('connect'));
      if (src?.suggestions?.length) add(g.act, 'mail', tr('jobs.pal.applyAll', 'Apply all email suggestions ({n})', { n: src.suggestions.length }), () => act('email-apply', { all: true }));
      add(g.act, 'save', tr('projecttpl.apps.export', 'Export CSV'), exportCsv);
      add(g.act, 'user', tr('projecttpl.apps.profile', 'Edit profile'), editProfile);
      for (const v of VIEWS) add(g.view, v, tr('jobs.pal.show', 'Show {view}', { view: names[v] }), () => { setView(v); root.querySelector('.jb-sec-view')?.scrollIntoView({ block: 'start' }); }, v === view ? tr('jobs.pal.current', 'showing') : '');
      for (const [key, title] of [['progress', tr('jobs.sec.progress', 'Progress')], ['attention', tr('jobs.sec.attention', 'Needs attention')], ['outcomes', tr('jobs.sec.outcomes', 'Outcomes')], ['sources', tr('jobs.sec.sources', 'Sources')]]) {
        if (root.querySelector(`.jb-sec-${key}`)) add(g.sec, 'go', tr('jobs.pal.goto', 'Go to {section}', { section: title }), () => root.querySelector(`.jb-sec-${key}`)?.scrollIntoView({ block: 'start' }));
      }
      for (const e of data?.entries || []) {
        const name = [e.company || '?', e.role].filter(Boolean).join(' · ');
        add(g.app, 'card', name, () => showEntry(e.key), stageName(e.stage));
        items[items.length - 1].app = true;
      }
      return items;
    }
    // An application from the palette: its card on the board, focused and marked for a moment.
    function showEntry(key) {
      if (view !== 'board') setView('board');
      const c = root.querySelector(`.jb-card[data-key="${CSS.escape(key)}"]`);
      if (!c) return;
      c.scrollIntoView({ block: 'center', inline: 'center' });
      c.focus({ preventScroll: true });
      c.classList.add('flash');
      setTimeout(() => c.classList.remove('flash'), 1600);
    }
    function openPalette(from) {
      if (pal) { closePalette(); return; }
      if (!data) return;
      const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : from || null;
      const all = paletteItems();
      const listId = `jb-pal-list-${id}`;
      const input = el('input', { type: 'text', className: 'jb-pal-in', placeholder: tr('jobs.pal.placeholder', 'Search actions, views and applications…'), autocomplete: 'off', spellcheck: false });
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-controls', listId);
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-label', tr('jobs.pal.label', 'Command palette ({key})', { key: MAC ? '⌘K' : 'Ctrl+K' }));
      const list = el('ul', { className: 'jb-pal-list', id: listId });
      list.setAttribute('role', 'listbox');
      const foot = el('div', { className: 'jb-pal-foot' }, el('span', {}, el('kbd', { textContent: '↑↓' }), ` ${tr('jobs.pal.move', 'move')}`), el('span', {}, el('kbd', { textContent: 'Enter' }), ` ${tr('jobs.pal.run', 'run')}`), el('span', {}, el('kbd', { textContent: 'Esc' }), ` ${tr('jobs.pal.close', 'close')}`));
      const panel = el('div', { className: 'jb-panel jb-pal' }, el('div', { className: 'jb-pal-top' }, icon('find'), input), list, foot);
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', tr('jobs.pal.title', 'Dashboard commands'));
      const backdrop = el('div', { className: 'jb-pal-back jb-pal-scope' }, panel); // (jb-pal-scope: the desert colours, on <body>)
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closePalette(); });
      let shown = [];
      let sel = 0;
      const highlight = (text, hits) => {
        if (!hits?.length) return [document.createTextNode(text)];
        const out = [];
        const set = new Set(hits);
        let run = '';
        let marked = false;
        for (let i = 0; i <= text.length; i++) {
          const m = set.has(i);
          if (i === text.length || m !== marked) { if (run) out.push(marked ? el('mark', { textContent: run }) : document.createTextNode(run)); run = ''; marked = m; }
          if (i < text.length) run += text[i];
        }
        return out;
      };
      const paint = () => {
        list.replaceChildren();
        if (!shown.length) { list.append(el('li', { className: 'jb-pal-none', textContent: tr('jobs.pal.none', 'Nothing matches.') })); input.removeAttribute('aria-activedescendant'); return; }
        let lastGroup = '';
        shown.forEach((it, i) => {
          if (!input.value.trim() && it.group !== lastGroup) { const gh = el('li', { className: 'jb-pal-group', textContent: it.group }); gh.setAttribute('role', 'presentation'); list.append(gh); lastGroup = it.group; }
          const o = el('li', { className: 'jb-pal-opt', id: `${listId}-${i}` }, icon(it.icon), el('span', { className: 'jb-pal-t' }, ...highlight(it.title, it.hits)), it.hint || input.value.trim() ? el('span', { className: 'jb-pal-hint', textContent: it.hint || it.group }) : null);
          o.setAttribute('role', 'option');
          o.setAttribute('aria-selected', String(i === sel));
          o.addEventListener('mousemove', () => { if (sel !== i) { sel = i; mark(); } });
          o.addEventListener('click', () => runAt(i));
          list.append(o);
        });
        mark();
      };
      const mark = () => {
        list.querySelectorAll('.jb-pal-opt').forEach((o, i) => o.setAttribute('aria-selected', String(i === sel)));
        const cur = list.querySelector(`#${CSS.escape(`${listId}-${sel}`)}`);
        if (cur) { input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
      };
      const filter = () => {
        const q = input.value.trim();
        if (!q) { let apps = 0; shown = all.filter((it) => !it.app || apps++ < 8).map((it) => ({ ...it, hits: [] })); } // (empty: every action, view and section, and the first 8 applications)
        else shown = all.map((it) => { const m = fuzzy(q, it.title) || fuzzy(q, `${it.title} ${it.hint}`); return m ? { ...it, hits: m.hits.filter((h) => h < it.title.length), score: m.score } : null; }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 40);
        sel = 0;
        paint();
      };
      const runAt = (i) => { const it = shown[i]; if (!it) return; closePalette({ restore: false }); it.run(); };
      input.addEventListener('input', filter);
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        const n = shown.length;
        if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { sel = (sel + 1) % n; mark(); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { sel = (sel - 1 + n) % n; mark(); } }
        else if (e.key === 'Home' && n) { e.preventDefault(); sel = 0; mark(); }
        else if (e.key === 'End' && n) { e.preventDefault(); sel = n - 1; mark(); }
        else if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); runAt(sel); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
        else if (e.key === 'Tab') e.preventDefault(); // (keyboard-first: focus stays in the box)
      });
      pal = { backdrop, back };
      document.body.append(backdrop);
      filter();
      input.focus();
    }
    function closePalette({ restore = true } = {}) {
      if (!pal) return;
      const { backdrop, back } = pal;
      pal = null;
      backdrop.remove();
      if (restore && back?.isConnected) back.focus({ preventScroll: true });
    }
    // The key: main hands Ctrl+K / ⌘K over while the dashboard claims it (it never reaches the page otherwise); a keydown is the fallback.
    const onShortcut = (e) => { if (e.detail !== 'palette') return; if (!root.isConnected) { dispose(); return; } openPalette(); };
    const onKey = (e) => { if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || String(e.key).toLowerCase() !== 'k' || !root.isConnected) return; e.preventDefault(); openPalette(); };
    document.addEventListener('cp:shortcut', onShortcut);
    document.addEventListener('keydown', onKey);
    api.paletteKey?.(true);
    function dispose() {
      if (disposed) return;
      disposed = true;
      closePalette({ restore: false });
      document.removeEventListener('cp:shortcut', onShortcut);
      document.removeEventListener('keydown', onKey);
      api.paletteKey?.(false);
    }

    root.append(el('p', { className: 'jb-empty', textContent: tr('projecttpl.apps.loading', 'Loading…') }));
    if (view === 'find') findState();
    load();
    // (a chat logged one: drawn again, but never under a half-typed posting, an open stage menu or the palette)
    const busy = () => Boolean(pal) || linking || view === 'find' || Boolean(root.querySelector('.jb-addform')) || (root.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName));
    return { refresh: () => (root.isConnected && !busy() ? load() : null), dispose, palette: () => openPalette() };
  }

  window.chatJobBoard = { draw, fuzzy };
})();
