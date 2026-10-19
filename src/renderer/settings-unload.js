// Settings > Tabs > Page unloading: when unused tabs unload (or freeze), what never does, the site lists, how an unloaded tab looks and
// comes back, the manual controls and a live status panel. Uses settings.js's row helpers (h, tr, st, save, row, toggle, select, stackRow);
// settings.js calls buildUnloading(slot) while it builds the page. features/tab-sleep.js decides, main.js acts, at once on a change.
// Every string is a settings.unload.* key (locales/en.json).
const un = (key, english, vars) => tr(`settings.unload.${key}`, english, vars);

function unloadMinutesText(n) {
  if (n === 0) return un('never', 'Never');
  if (n >= 60 && n % 60 === 0) return n === 60 ? un('hour', '1 hour') : un('hours', '{n} hours', { n: n / 60 });
  return n === 1 ? un('minute', '1 minute') : un('minutes', '{n} minutes', { n });
}

// A select of presets with a "Custom…" choice that reveals a number box. `valid(n)`: the numbers the box takes. The chosen value is a
// number; `presets` lists the values the select offers by name (0 may be one: "Never" / "Unlimited").
function presetWithCustom({ key, label, presets, text, unitText, min, max, selectId, numberId }) {
  const sel = h('select', { id: selectId, 'aria-label': label },
    presets.map((n) => h('option', { value: String(n), text: text(n) })), h('option', { value: 'custom', text: un('custom', 'Custom…') }));
  const num = h('input', { type: 'number', id: numberId, min, max, step: 1, 'aria-label': `${label}: ${un('customValue', 'custom value')}` });
  const unit = unitText ? h('span', { class: 'note', text: unitText }) : null;
  let customOpen = false;
  const sync = () => {
    const v = st.prefs[key];
    sel.value = presets.includes(v) && !customOpen ? String(v) : 'custom';
    num.hidden = sel.value !== 'custom';
    if (unit) unit.hidden = num.hidden;
    if (!num.hidden && document.activeElement !== num) num.value = String(v);
  };
  sel.addEventListener('change', async () => {
    customOpen = sel.value === 'custom';
    if (!customOpen) await save(key, Number(sel.value));
    sync();
    if (customOpen) num.focus();
  });
  num.addEventListener('change', async () => {
    const n = Math.round(Number(num.value));
    if (num.value !== '' && Number.isFinite(n) && n >= min && n <= max) await save(key, n);
    customOpen = false;
    sync();
  });
  window.addEventListener('lumen-pref', (e) => { if (e.detail.key === key) sync(); });
  sync();
  return [sel, num, unit].filter(Boolean);
}

// A list of sites (patterns), with a box and an Add button, and "Add current site" (the page you were last on).
function siteListRow({ key, label, desc, empty, addLabel, listId, inputId }) {
  const list = h('div', { class: 'list', id: listId });
  const input = h('input', { type: 'text', class: 'grow', id: inputId, placeholder: 'example.com, *.example.com', 'aria-label': addLabel });
  const note = h('span', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const render = () => list.replaceChildren(...((st.prefs[key] || []).length ? st.prefs[key].map((host) => h('div', { class: 'item' },
    h('span', { class: 'grow', text: host }),
    h('button', { type: 'button', text: un('remove', 'Remove'), 'aria-label': `${un('remove', 'Remove')} ${host}`, onclick: async () => { await save(key, st.prefs[key].filter((x) => x !== host)); render(); } })))
    : [h('span', { class: 'note', text: empty })]));
  render();
  window.addEventListener('lumen-pref', (e) => { if (e.detail.key === key) render(); });
  const add = async (value) => {
    const text = String(value ?? input.value).trim();
    if (!text) return;
    const before = (st.prefs[key] || []).length;
    await save(key, [...(st.prefs[key] || []), text]);
    const grew = (st.prefs[key] || []).length > before;
    flash(note, grew ? '' : un('siteRejected', 'Not added: that is not a site, or it is already in the list.'), grew ? 'ok' : 'err');
    if (grew) input.value = '';
    render();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  const current = h('button', {
    type: 'button', id: `${inputId}-current`, text: un('addCurrent', 'Add current site'),
    onclick: async () => {
      const host = await S.tabSleep.currentSite();
      if (host) await add(host); else flash(note, un('noCurrentSite', 'No web page is open to add.'), 'err');
    },
  });
  const el = stackRow(label, desc, list, h('div', { class: 'controls' }, input, h('button', { type: 'button', id: `${inputId}-add`, text: un('addSite', 'Add site'), onclick: () => add() }), current), note);
  return el;
}

function buildUnloading(slot) {
  const C = st.tabSleepChoices;
  const off = () => st.prefs.tabSleep === false || st.prefs.tabSleepMode === 'off';
  const dependents = []; // [row, () => shown]: everything but the master switch, the status panel and the reset follows the master switch
  const follow = (el, shown = () => true) => { dependents.push([el, shown]); return el; };
  const refresh = () => {
    for (const [el, shown] of dependents) el.hidden = off() || !shown();
    for (const g of slot.groups) g.hidden = [...g.querySelectorAll('.row')].every((r) => r.hidden); // (a list with nothing in it: its title goes too)
  };
  window.addEventListener('lumen-pref', refresh);
  const kw = (el, words) => withKeywords(el, `unload unloading discard suspend sleep memory ram tabs ${words}`);

  // ---- 1. on or off, and when ----
  const master = kw(toggle('tabSleep', un('master', 'Unload inactive tabs'),
    un('masterDesc', 'Closes the page of a background tab you have not used for a while to free its memory; it reloads when you come back. Turn off to keep every tab loaded.'),
    (on) => { if (on && st.prefs.tabSleepMode === 'off') save('tabSleepMode', 'both'); refresh(); }), 'master on off enable');

  const afterControls = presetWithCustom({ key: 'tabSleepMinutes', label: un('after', 'Unload after'), presets: C.minutes.concat(0), text: unloadMinutesText, unitText: un('unitMinutes', 'minutes'), min: 1, max: C.maxMinutes, selectId: 'pref-tabSleepMinutes', numberId: 'pref-tabSleepMinutesCustom' });
  const perfNote = h('span', { class: 'note', id: 'unload-perf-note' });
  const after = kw(row(un('after', 'Unload after'), un('afterDesc', 'How long a background tab can go unused before it unloads. Never turns the timer off: low memory, the limit below and your site list still apply.'), ...afterControls), 'minutes hours time idle timer custom');
  after.querySelector('.text').append(perfNote);
  follow(after);

  const how = kw(select('tabSleepHow', un('how', 'How tabs unload'), un('howDesc', 'Unload closes the page and frees all its memory. Freeze keeps the page in memory, paused, so it wakes at once but frees less.'),
    [['unload', un('how.unload', 'Unload (frees the most memory)')], ['freeze', un('how.freeze', 'Freeze (keeps the page as it was)')]]), 'freeze pause');
  follow(how);
  const freezeFirst = kw(select('tabSleepFreezeFirstMinutes', un('freezeFirst', 'Freeze first, then unload'), un('freezeFirstDesc', 'An idle tab is frozen in memory for this long before it unloads, so coming back to it is instant. Costs some memory meanwhile.'),
    C.freezeFirst.map((n) => [n, n ? unloadMinutesText(n) : un('freezeFirst.off', 'Off (unload at once)')]), { number: true }), 'freeze instant');
  follow(freezeFirst, () => st.prefs.tabSleepHow !== 'freeze');
  window.addEventListener('lumen-pref', (e) => { if (e.detail.key === 'tabSleepHow') refresh(); });

  const capControls = presetWithCustom({ key: 'tabSleepMaxAwake', label: un('cap', 'Most background tabs kept loaded'), presets: [0, 5, 10, 20], text: (n) => (n ? String(n) : un('unlimited', 'Unlimited')), unitText: un('unitTabs', 'tabs'), min: 1, max: C.maxAwakeLimit, selectId: 'pref-tabSleepMaxAwake', numberId: 'pref-tabSleepMaxAwakeCustom' });
  const capNote = h('span', { class: 'note', id: 'unload-cap-note' });
  const cap = kw(row(un('cap', 'Most background tabs kept loaded'), un('capDesc', 'Beyond this many, the tabs unused longest unload (never one used in the last minute). Unlimited sets no cap.'), ...capControls), 'maximum limit live cap count');
  cap.querySelector('.text').append(capNote);
  follow(cap);
  const recent = kw(select('tabSleepKeepRecent', un('keepRecent', 'Always keep the latest tabs loaded'), un('keepRecentDesc', 'The tabs you used last are the ones you go back to, so the timer leaves them alone, and so does ordinary low memory (only very low memory, or your own GB limit, unloads them). The limit above can still unload them.'),
    C.keepRecent.map((n) => [n, n ? String(n) : un('none', 'None')]), { number: true }), 'recent latest');
  follow(recent);
  const ready = kw(select('tabReadyRecent', un('readyRecent', 'Keep the latest tabs ready'), un('readyRecentDesc', 'Windows parks a tab you are not looking at in a low-power state, so the first moment after you come back can be slow. Lumen keeps this many of your latest tabs out of that state (and the tab under your pointer, always). Costs a little battery; on battery only one, and none when memory is low or the window is hidden.'),
    C.readyRecent.map((n) => [n, n ? String(n) : un('readyNone', 'Only the tab under the pointer')]), { number: true }), 'ready latest recent power efficiency priority slow switch');
  follow(ready);

  // ---- 2. memory pressure ----
  const pressure = kw(select('tabSleepPressure', un('pressure', 'Unload sooner when memory is low'), un('pressureDesc', 'When free memory runs low, tabs unused for even a short time unload, oldest first. Low acts under 5% free (after 5 minutes unused), Medium under 10% (2 minutes), Aggressive under 20% (1 minute). On a Mac, Lumen follows the system’s own memory pressure.'),
    [['off', un('pressure.off', 'Off')], ['low', un('pressure.low', 'Low')], ['medium', un('pressure.medium', 'Medium')], ['aggressive', un('pressure.aggressive', 'Aggressive')]]), 'pressure low memory ram free');
  follow(pressure);
  const gb = kw(select('tabSleepLumenGb', un('lumenGb', 'Also when Lumen uses more than'), un('lumenGbDesc', 'Counts all of Lumen’s tabs and processes. Needs a memory level above Off.'),
    C.lumenGb.map((n) => [n, n ? un('gb', '{n} GB', { n }) : un('noLimit', 'No limit')]), { number: true }), 'gigabytes gb');
  follow(gb, () => st.prefs.tabSleepPressure !== 'off');
  window.addEventListener('lumen-pref', (e) => { if (e.detail.key === 'tabSleepPressure') refresh(); });

  // ---- 3. exceptions ----
  const locked = (id, label, desc) => {
    const input = h('input', { type: 'checkbox', class: 'switch', id, role: 'switch', checked: true, disabled: true, 'aria-label': label });
    return row(label, desc, h('span', { class: 'note', text: un('alwaysOn', 'Always on') }), input);
  };
  const exceptions = [
    kw(toggle('tabSleepKeepAudio', un('keepAudio', 'Tabs playing audio or video'), un('keepAudioDesc', 'A tab that is playing sound or video stays loaded.'), undefined, { fallback: true }), 'music sound media playing'),
    kw(toggle('tabSleepKeepPinned', un('keepPinned', 'Pinned tabs'), un('keepPinnedDesc', 'Pinned tabs stay loaded.'), undefined, { fallback: true }), 'pin'),
    kw(toggle('tabSleepKeepForms', un('keepForms', 'Tabs with unsaved input or a “Leave site?” prompt'), un('keepFormsDesc', 'A tab with typed, unsent text, or a page that would ask “Leave site?” before closing, stays loaded.'), undefined, { fallback: true }), 'form typed draft beforeunload leave'),
    locked('unload-keep-calls', un('keepCalls', 'Tabs in a call or sharing their screen'), un('keepCallsDesc', 'A tab using the camera or microphone, or sharing the screen, always stays loaded, so a call or a share is never cut.')),
    locked('unload-keep-agent', un('keepAgent', 'Tabs the AI agent or a background task is using'), un('keepAgentDesc', 'These always stay loaded, so a task is never interrupted.')),
    kw(toggle('tabSleepKeepTransfers', un('keepTransfers', 'Tabs with a download or upload in progress'), un('keepTransfersDesc', 'A tab downloading a file, or with a file chosen to upload, stays loaded.'), undefined, { fallback: true }), 'download upload transfer'),
    kw(toggle('tabSleepKeepGroups', un('keepGroups', 'Tabs in a tab group'), un('keepGroupsDesc', 'Tabs that belong to a group stay loaded. Off by default.')), 'group'),
  ];
  exceptions.forEach((e) => follow(e));

  // ---- 4. sites ----
  const keepSites = siteListRow({ key: 'tabSleepNever', label: un('keepSites', 'Always keep these sites loaded'), desc: un('neverDesc', 'Tabs on these sites stay loaded. A name covers its subdomains; * works as a wildcard, for example *.example.com or mail.*.'), empty: un('neverNone', 'No sites. You can also right-click a tab and choose “Never unload this site”.'), addLabel: un('neverAdd', 'Site to always keep loaded'), listId: 'unload-never', inputId: 'unload-never-add' });
  const soonSites = siteListRow({ key: 'tabSleepSoon', label: un('soon', 'Unload these sites sooner'), desc: un('soonDesc', 'Tabs on these sites unload after their own, shorter time (below), even if they are among your latest tabs. The always-keep list wins over this one.'), empty: un('soonNone', 'No sites.'), addLabel: un('soonAdd', 'Site to unload sooner'), listId: 'unload-soon', inputId: 'unload-soon-add' });
  const soonTime = kw(select('tabSleepSoonMinutes', un('soonAfter', 'Unload those sites after'), un('soonAfterDesc', 'Never longer than the usual time above.'), C.soonMinutes.map((n) => [n, unloadMinutesText(n)]), { number: true }), 'sooner shorter timer');
  [keepSites, soonSites, soonTime].forEach((e) => follow(kw(e, 'site domain wildcard list')));

  // ---- 5. how unloaded tabs look and come back ----
  const dim = kw(toggle('tabSleepDim', un('dim', 'Dim unloaded tabs in the tab strip'), un('dimDesc', 'An unloaded tab shows a dimmed icon and title, so you can tell it is not loaded.'), undefined, { fallback: true }), 'indicator favicon dimmed');
  const freed = kw(toggle('tabSleepShowFreed', un('showFreed', 'Show the memory freed when you hover an unloaded tab'), un('showFreedDesc', 'The hover card adds an estimate such as “about 120 MB freed”. It is approximate: tabs of one site can share memory.'), undefined, { fallback: true }), 'estimate hover megabytes');
  const onReturn = kw(select('tabSleepOnReturn', un('onReturn', 'When you switch to an unloaded tab'), un('onReturnDesc', 'Reload the page at once, or show a page with a Reload button and load nothing until you press it. Hovering a tab does not load it in the second case.'),
    [['reload', un('onReturn.reload', 'Reload immediately')], ['placeholder', un('onReturn.placeholder', 'Show a Reload button')]]), 'placeholder reload button');
  const restore = kw(row(un('restore', 'What comes back'), un('restoreDesc', 'A reloaded tab gets its Back and Forward history back, and the browser restores the scroll position and form fields it saved for the page. Pages that rebuild themselves when they load, such as a document being edited, may start fresh, and text you had not submitted is why such tabs are kept loaded above.')), 'scroll position form state restore');
  const preload = kw(select('tabPreload', un('preload', 'Preload tabs after startup'), un('preloadDesc', 'Once the first page has loaded and the computer is idle, Lumen loads the tabs next to it, one at a time, so they are ready when you click. Stops when memory is low, and is off while a Reload button is shown.'),
    C.preload.map((n) => [n, n ? String(n) : un('preload.off', 'Off')]), { number: true }), 'startup preload wake');
  [dim, freed, onReturn, restore, preload].forEach((e) => follow(e));

  // ---- 6. status, manual controls, reset ----
  const cell = (id, label) => h('div', { class: 'stat' }, h('span', { class: 'stat-value', id: `unload-stat-${id}`, text: '–' }), h('span', { class: 'stat-label', text: label }));
  const grid = h('div', { class: 'unload-stats', role: 'group', 'aria-label': un('status', 'Status') },
    cell('loaded', un('statLoaded', 'Loaded')), cell('unloaded', un('statUnloaded', 'Unloaded')), cell('exempt', un('statExempt', 'Exempt')),
    cell('used', un('statUsed', 'Memory used by tabs')), cell('freed', un('statFreed', 'Memory freed')), cell('free', un('statFree', 'Free memory')));
  const exemptNote = h('span', { class: 'note', id: 'unload-exempt-note' });
  const result = h('span', { class: 'note', id: 'unload-now-result', role: 'status', 'aria-live': 'polite' });
  const unloadNow = h('button', {
    type: 'button', id: 'unload-now', text: un('unloadNow', 'Unload all background tabs now'),
    onclick: async () => {
      unloadNow.disabled = true;
      try { const n = await S.tabSleep.unloadAll(); flash(result, n === 1 ? un('unloadedOne', 'Unloaded 1 tab.') : un('unloadedMany', 'Unloaded {n} tabs.', { n }), 'ok'); } catch { flash(result, un('unloadFailed', 'Could not unload tabs.'), 'err'); }
      unloadNow.disabled = false;
      poll(true);
    },
  });
  const statusRow = kw(stackRow(un('status', 'Status'), un('statusDesc', 'Tabs in all windows, updated while this page is open. Memory figures are approximate. Exempt tabs are loaded background tabs that would not unload now, because of the exceptions above or because they are a Lumen page.'),
    grid, exemptNote, h('div', { class: 'controls start' }, unloadNow, result)), 'status count loaded unloaded exempt memory used freed now');
  statusRow.id = 'unload-status';
  const EXEMPT_WHY = { audio: 'audio or video', transfer: 'download', pinned: 'pinned', site: 'always-keep site', group: 'tab group', popups: 'sign-in popup', ai: 'AI or task', internal: 'Lumen page', settings: 'Settings', loading: 'still loading', fullscreen: 'full screen', devtools: 'developer tools', capturing: 'call or screen share' };
  const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);
  const text = (id, v) => { const el = document.getElementById(`unload-stat-${id}`); if (el) el.textContent = v; };
  const showStatus = (s) => {
    if (!s) return;
    for (const [key, list] of Object.entries(s.lists || {})) { // a list changed elsewhere (the tab menu): show it
      if (JSON.stringify(st.prefs[key] || []) !== JSON.stringify(list)) { st.prefs[key] = list; window.dispatchEvent(new CustomEvent('lumen-pref', { detail: { key } })); }
    }
    text('loaded', String(s.loaded)); text('unloaded', String(s.unloaded)); text('exempt', String(s.exempt));
    text('used', `~${mb(s.usedMb)}`); text('freed', `~${mb(s.freedMb)}`); text('free', s.freePercent == null ? '–' : `${s.freePercent}%`);
    const why = Object.entries(s.reasons || {}).map(([k, n]) => `${n} ${tr(`settings.unload.why.${k}`, EXEMPT_WHY[k] || k)}`).join(', ');
    exemptNote.textContent = why ? un('exemptWhy', 'Exempt: {why}.', { why }) : '';
    // Performance mode shortens the time and sets a cap (features/performance.js): say so where those are set.
    const p = s.performance;
    perfNote.textContent = p && s.effectiveMinutes && (st.prefs.tabSleepMinutes === 0 || s.effectiveMinutes < st.prefs.tabSleepMinutes)
      ? un('perfAfter', 'Performance mode is on: tabs unload after {time}.', { time: unloadMinutesText(s.effectiveMinutes) }) : '';
    capNote.textContent = p && p.cap && (!st.prefs.tabSleepMaxAwake || p.cap < st.prefs.tabSleepMaxAwake)
      ? un('perfCap', 'Performance mode is on: at most {n} background tabs stay loaded.', { n: p.cap }) : '';
  };
  const poll = async (force) => {
    if (!force && (document.hidden || !statusRow.offsetParent)) return;
    try { showStatus(await S.tabSleep.status()); } catch { /* the page is closing */ }
  };
  // Refreshed every 3 seconds, and only while the section is on screen and the page is in front; once at the start for the Performance mode notes.
  let timer = 0;
  const loop = () => { clearTimeout(timer); timer = 0; if (document.hidden || !statusRow.offsetParent) return; poll(true).finally(() => { if (!timer && !document.hidden && statusRow.offsetParent) timer = setTimeout(loop, 3000); }); };
  if ('IntersectionObserver' in window) new IntersectionObserver(() => loop()).observe(statusRow);
  document.addEventListener('visibilitychange', loop);
  window.addEventListener('lumen-pref', () => { if (statusRow.offsetParent) poll(true); });
  poll(true);
  setTimeout(loop, 1000); // (the observer above starts the loop when the section is drawn; a page that draws no frames (hidden, minimized) still keeps the lists current while it is shown)

  const resetResult = h('span', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const reset = h('button', {
    type: 'button', id: 'unload-reset', text: un('reset', 'Reset to defaults'),
    onclick: async () => {
      Object.assign(st, await S.tabSleep.reset());
      for (const k of st.tabSleepChoices.keys) window.dispatchEvent(new CustomEvent('lumen-pref', { detail: { key: k } }));
      applyPageClasses();
      flash(resetResult, un('resetDone', 'Page unloading settings are back to their defaults.'), 'ok');
    },
  });
  const resetRow = row(un('resetLabel', 'Reset page unloading'), un('resetDesc', 'Puts every setting in this section back to its default. Your site lists are cleared too.'), reset, resetResult);

  slot.append(master, after, how, freezeFirst, cap, recent);
  slot.group(un('groupMemory', 'Memory pressure')).append(pressure, gb);
  slot.group(un('groupNever', 'Never unload these')).append(...exceptions);
  slot.group(un('groupSites', 'Sites')).append(keepSites, soonSites, soonTime);
  slot.group(un('groupLook', 'Unloaded tabs')).append(dim, freed, onReturn, restore, preload);
  slot.group(un('groupStatus', 'Status and controls')).append(statusRow, resetRow);
  refresh();
}
