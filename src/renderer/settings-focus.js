// Settings → General → Focus mode: start a session, the sites it blocks, recurring schedules ("weekdays 7-9 pm") and the focus log.
// Loaded before settings.js and mounted by its builder list (BUILDS: 'focus'); it uses that file's h(), row(), stackRow(), tr(), flash() and
// st helpers. The backend is features/focus.js (settings:focus*); the lists are the focusSites and focusSchedules settings. While a session is on
// the lists are locked (main refuses the change too), so editing them is not a way out of it.

async function buildFocus(card) {
  const F = window.lumenSettings.focus;
  const DEFAULT_SITES = ['youtube.com', 'youtu.be', 'reddit.com', 'tiktok.com', 'instagram.com', 'x.com', 'twitter.com', 'facebook.com', 'twitch.tv', 'netflix.com'];
  let info = await F.get();
  const lengths = [25, 45, 60, 90, 120, 180];
  const lengthLabel = (m) => (m % 60 === 0 ? tr(m === 60 ? 'focus.dur.hour' : 'focus.dur.hours', m === 60 ? '1 hour' : '{n} hours', { n: m / 60 }) : tr('focus.dur.minutes', '{n} minutes', { n: m }));
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayName = (d) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 0, 4 + d)); // (4 January 2026 is a Sunday)
  const timeName = (hhmm) => { const [hh, mm] = hhmm.split(':').map(Number); return new Date(2000, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const daysName = (days) => {
    const key = days.join(',');
    return key === '1,2,3,4,5' ? tr('focus.days.weekdays', 'Weekdays') : key === '0,1,2,3,4,5,6' ? tr('focus.days.every', 'Every day') : key === '0,6' ? tr('focus.days.weekends', 'Weekends') : days.map(dayName).join(', ');
  };
  const failText = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const locked = () => Boolean(info.state.active);

  // ---- start
  const statusLine = h('span', { class: 'note', id: 'focus-status', role: 'status' });
  const lengthSelect = h('select', { id: 'focus-length', 'aria-label': tr('settings.focus.length', 'How long') }, lengths.map((m) => h('option', { value: String(m), text: lengthLabel(m) })));
  lengthSelect.value = '60';
  const startButton = h('button', { class: 'primary', id: 'focus-start', type: 'button', text: tr('settings.focus.start', 'Start'), onclick: async () => {
    startButton.disabled = true;
    try { await F.start(Number(lengthSelect.value)); await reload(); } catch (err) { flash(statusLine, failText(err), 'err'); }
    startButton.disabled = false;
  } });
  const drawStatus = () => {
    const s = info.state;
    statusLine.className = 'note';
    statusLine.textContent = s.active
      ? tr(s.source === 'schedule' ? 'settings.focus.onSchedule' : 'settings.focus.on', s.source === 'schedule' ? 'On until {time} (a schedule). Change the lists when it ends.' : 'On until {time}. Change the lists when it ends.', { time: clock(s.until) })
      : s.next ? tr('settings.focus.nextStart', 'Off. The next schedule starts {time}.', { time: `${dayName(new Date(s.next).getDay())} ${clock(s.next)}` }) : tr('settings.focus.off', 'Off. Nothing is blocked until you start it.');
    startButton.disabled = s.active;
    lengthSelect.disabled = s.active;
  };

  // ---- the sites
  const siteList = h('div', { class: 'list', id: 'focus-sites' });
  const siteInput = h('input', { type: 'text', class: 'grow', id: 'focus-site-add', placeholder: 'example.com', 'aria-label': tr('settings.focus.addSite', 'Site to block') });
  const siteNote = h('span', { class: 'note', id: 'focus-sites-note', role: 'status' });
  const setSites = async (list) => {
    try { st = await S.set('focusSites', list); siteNote.textContent = ''; } catch (err) { flash(siteNote, failText(err), 'err'); }
    drawSites();
  };
  const sites = () => st.prefs.focusSites || [];
  function drawSites() {
    const list = sites();
    siteList.replaceChildren(...(list.length ? list.map((host) => h('div', { class: 'item', 'data-site': host },
      h('span', { class: 'grow', text: host }),
      h('button', { text: tr('settings.focus.remove', 'Remove'), disabled: locked(), onclick: () => setSites(list.filter((x) => x !== host)) })))
      : [h('span', { class: 'note', text: tr('settings.focus.noSites', 'No sites: focus mode blocks nothing.') })]));
    siteInput.disabled = locked();
    addSiteButton.disabled = locked();
    resetSites.disabled = locked();
  }
  const addSite = () => { const host = siteInput.value.trim(); if (!host) { flash(siteNote, tr('settings.needSite', 'Type a site first, for example example.com.'), 'err'); siteInput.focus(); return; } siteInput.value = ''; setSites([...new Set([...sites(), host])]); };
  const addSiteButton = h('button', { id: 'focus-site-button', type: 'button', text: tr('settings.focus.add', 'Add'), onclick: addSite });
  siteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); addSite(); } });
  const resetSites = h('button', { id: 'focus-sites-reset', type: 'button', text: tr('settings.focus.restore', 'Restore the default list'), onclick: () => setSites(DEFAULT_SITES) });

  // ---- schedules
  const scheduleList = h('div', { class: 'list', id: 'focus-schedules' });
  const scheduleNote = h('span', { class: 'note', id: 'focus-schedules-note', role: 'status' });
  const schedules = () => st.prefs.focusSchedules || [];
  const setSchedules = async (list) => {
    try { st = await S.set('focusSchedules', list); scheduleNote.textContent = ''; } catch (err) { flash(scheduleNote, failText(err), 'err'); }
    await reload();
  };
  function drawSchedules() {
    const list = schedules();
    scheduleList.replaceChildren(...(list.length ? list.map((s) => {
      const on = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `${daysName(s.days)} ${timeName(s.from)}`, checked: s.on !== false, disabled: locked(), onchange: (e) => setSchedules(list.map((x) => (x.id === s.id ? { ...x, on: e.target.checked } : x))) });
      return h('div', { class: 'item', 'data-schedule': s.id },
        h('span', { class: 'grow', text: `${daysName(s.days)}, ${timeName(s.from)} – ${timeName(s.to)}` }), on,
        h('button', { text: tr('settings.focus.remove', 'Remove'), disabled: locked(), onclick: () => setSchedules(list.filter((x) => x.id !== s.id)) }));
    }) : [h('span', { class: 'note', text: tr('settings.focus.noSchedules', 'No schedules.') })]));
    for (const el of scheduleForm.querySelectorAll('input, button')) el.disabled = locked();
  }
  const phraseInput = h('input', { type: 'text', class: 'grow', id: 'focus-phrase', placeholder: tr('settings.focus.phrasePlaceholder', 'weekdays 7–9 pm'), 'aria-label': tr('settings.focus.phrase', 'Schedule in words') });
  const addPhrase = async () => {
    const text = phraseInput.value.trim();
    if (!text) return;
    const parsed = await F.phrase(text).catch(() => null);
    if (!parsed) { flash(scheduleNote, tr('settings.focus.phraseBad', 'Try something like “weekdays 7–9 pm” or “mon, wed 4:30–6 pm”.'), 'err'); return; }
    phraseInput.value = '';
    setSchedules([...schedules(), { ...parsed, on: true }]);
  };
  phraseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); addPhrase(); } });
  const dayBoxes = [1, 2, 3, 4, 5, 6, 0].map((d) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: String(d), 'data-day': String(d), checked: d >= 1 && d <= 5 }), dayName(d)));
  const fromInput = h('input', { type: 'time', id: 'focus-from', value: '19:00', 'aria-label': tr('settings.focus.from', 'From') });
  const toInput = h('input', { type: 'time', id: 'focus-to', value: '21:00', 'aria-label': tr('settings.focus.to', 'Until') });
  const scheduleForm = h('div', { class: 'controls start', id: 'focus-schedule-form' },
    ...dayBoxes, fromInput, h('span', { class: 'note', text: tr('settings.focus.until', 'until') }), toInput,
    h('button', { id: 'focus-schedule-add', type: 'button', text: tr('settings.focus.addSchedule', 'Add schedule'), onclick: () => {
      const days = dayBoxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
      if (!days.length || !fromInput.value || !toInput.value || fromInput.value === toInput.value) { flash(scheduleNote, tr('settings.focus.scheduleBad', 'Pick at least one day and two different times.'), 'err'); return; }
      setSchedules([...schedules(), { days, from: fromInput.value, to: toInput.value, on: true }]);
    } }));

  // ---- the log
  const logList = h('div', { class: 'list', id: 'focus-log' });
  function drawLog() {
    const rows = info.log.filter((e) => e && e.type).slice(0, 12).map((e) => {
      const when = new Date(e.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      const text = e.type === 'start' ? tr('settings.focus.log.start', 'Started, {n} min', { n: e.minutes })
        : e.type === 'allow' ? tr('settings.focus.log.allow', 'Allowed {site} for {n} min', { site: e.site, n: e.minutes })
          : e.how === 'early' ? tr('settings.focus.log.early', 'Ended early after {n} min', { n: e.minutes }) : tr('settings.focus.log.end', 'Ended');
      return h('div', { class: 'item', 'data-type': e.type }, h('span', { class: 'grow', text: text }), h('span', { class: 'note', text: when }));
    });
    logList.replaceChildren(...(rows.length ? rows : [h('span', { class: 'note', text: tr('settings.focus.log.none', 'Nothing yet.') })]));
  }

  async function reload() {
    info = await F.get();
    drawStatus(); drawSites(); drawSchedules(); drawLog();
  }

  card.append(
    withKeywords(stackRow(tr('settings.focus.title', 'Focus mode'), tr('settings.focus.desc', 'For a homework session: sites that pull you away are blocked until the timer ends. Start it here, from the toolbar button, or by typing “focus for 90 minutes” in the chat. Nothing is blocked until you start it.'),
      h('div', { class: 'controls start' }, lengthSelect, startButton), statusLine), 'focus homework study distraction block timer pomodoro youtube reddit'),
    withKeywords(stackRow(tr('settings.focus.sites', 'Blocked sites'), tr('settings.focus.sitesDesc', 'These sites, and their subdomains, show a calm page instead while focus mode is on. “I need this for school” opens one for 10 minutes and is noted in the log below.'),
      siteList, h('div', { class: 'controls start' }, siteInput, addSiteButton, resetSites), siteNote), 'focus block sites list youtube reddit tiktok instagram twitter facebook twitch netflix'),
    withKeywords(stackRow(tr('settings.focus.schedules', 'Schedules'), tr('settings.focus.schedulesDesc', 'Focus mode starts by itself at these times and ends when they do. Type one in words, or pick the days and times.'),
      scheduleList, h('div', { class: 'controls start' }, phraseInput, h('button', { id: 'focus-phrase-add', type: 'button', text: tr('settings.focus.add', 'Add'), onclick: addPhrase })), scheduleForm, scheduleNote), 'focus schedule recurring weekdays evening study time'),
    stackRow(tr('settings.focus.log', 'Focus log'), tr('settings.focus.logDesc', 'When focus mode started and ended, and every time you used “I need this for school”. It stays on this computer.'), logList),
  );
  drawStatus(); drawSites(); drawSchedules(); drawLog();
  setInterval(() => { F.get().then((next) => { if (JSON.stringify(next.state) !== JSON.stringify(info.state) || next.log.length !== info.log.length) { info = next; drawStatus(); drawSites(); drawSchedules(); drawLog(); } }).catch(() => {}); }, 10000);
}
