// Scheduling from the full-page chat (lumen://chat). The sidebar has the whole Routines editor (renderer/routines.js); this page
// has no tasks panel, so it gets a compact "Schedule this" dialog instead, reached four ways:
//   - the clock button beside Copy on a finished reply (the message that led to the reply becomes the request),
//   - the /routine command (text like "every weekday at 8am: news brief" opens the dialog filled in),
//   - an offer above the composer while the message being typed starts with a schedule phrase,
// and the dialog itself, which saves through assistant.routines (features/chat-preload.js -> chat-page.js registerRoutines).
// Loaded after chat-commands.js. window.routinePhrase (routine-phrase.js) is the cheap check that keeps the IPC for likely phrases only.
(() => {
  const api = window.assistant?.routines;
  const composer = document.getElementById('composer');
  const input = document.getElementById('prompt');
  if (!api || !composer || !input) return;
  const T = (key, vars) => window.t(key, vars);
  const h = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return node;
  };
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  const dayName = (d) => new Intl.DateTimeFormat([], { weekday: 'short' }).format(new Date(2026, 0, 4 + d)); // 4 January 2026 is a Sunday
  const timeText = (hhmm) => { const [hh, mm] = String(hhmm || '08:00').split(':').map(Number); return new Date(2026, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const stamp = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  // "Weekdays at 8:00 AM", "Every 3 hours", "Mon, Thu at 9:15 AM"
  function scheduleText(s) {
    if (!s) return '';
    if (s.repeat === 'hours') return s.hours === 1 ? T('routines.schedule.hour') : T('routines.schedule.hours', { n: s.hours });
    const time = timeText(s.time);
    if (s.repeat === 'daily') return T('routines.schedule.daily', { time });
    if (s.repeat === 'weekdays') return T('routines.schedule.weekdays', { time });
    if (s.repeat === 'weekly') return T('routines.schedule.weekly', { days: DAY_ORDER.filter((d) => (s.days || []).includes(d)).map(dayName).join(', '), time });
    return '';
  }
  // "every weekday at 8am: check my email" -> { when: 'every weekday at 8am', request: 'check my email' }
  function splitPhrase(text, parsed) {
    const src = String(text || '').trim();
    const rest = parsed?.prompt || '';
    const when = rest && src.endsWith(rest) ? src.slice(0, src.length - rest.length).replace(/[\s:,\-–—]+$/, '') : src;
    return { when, request: rest };
  }
  const nameFrom = (request) => {
    const line = String(request || '').trim().split('\n')[0].replace(/\s+/g, ' ');
    return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
  };

  // ---- the dialog (built once, reused)
  let sheet = null;
  let els = null;
  let returnTo = null;
  let onSaved = null;
  let seq = 0; // the newest preview asked for; an older answer is dropped
  let found = null; // { schedule } the schedule the When box was last read as, or null
  let previewTimer = 0;
  let saving = false;

  function build() {
    const name = h('input', { type: 'text', id: 'rc-name', maxLength: 80, placeholder: T('routines.field.name.placeholder') });
    const request = h('textarea', { id: 'rc-request', rows: 4, maxLength: 8000, placeholder: T('routines.chat.request.placeholder') });
    const when = h('input', { type: 'text', id: 'rc-when', maxLength: 200, placeholder: T('routines.chat.when.placeholder'), autocomplete: 'off', spellcheck: false });
    when.setAttribute('aria-describedby', 'rc-when-help rc-preview');
    const preview = h('p', { id: 'rc-preview', className: 'rc-preview' });
    preview.setAttribute('role', 'status');
    preview.setAttribute('aria-live', 'polite');
    const error = h('p', { id: 'rc-error', className: 'rc-error', hidden: true });
    error.setAttribute('role', 'alert');
    const create = h('button', { type: 'button', id: 'rc-create', className: 'btn primary', textContent: T('routines.create.button') });
    const cancel = h('button', { type: 'button', id: 'rc-cancel', className: 'btn', textContent: T('tasks.create.cancel') });
    const saved = h('p', { id: 'rc-saved', className: 'rc-saved', hidden: true, textContent: T('routines.chat.saved') });
    saved.setAttribute('role', 'status');
    const done = h('button', { type: 'button', id: 'rc-done', className: 'btn primary', textContent: T('shortcuts.chat.close'), hidden: true });
    const label = (id, text, control, extra) => h('div', { className: 'rc-field' }, h('label', { htmlFor: id, textContent: text }), control, extra);
    const form = h('div', { className: 'rc-form' },
      label('rc-name', T('routines.field.name'), name),
      label('rc-request', T('routines.chat.request'), request),
      label('rc-when', T('routines.chat.when'), when, h('p', { id: 'rc-when-help', className: 'rc-help', textContent: T('routines.chat.when.help') })),
      preview,
      h('p', { className: 'rc-help', textContent: T('routines.create.whileOpen') }),
      error);
    const actions = h('div', { className: 'rc-actions' }, cancel, create, done);
    const card = h('div', { className: 'shortcut-card rc-card', id: 'rc-dialog' },
      h('h2', { id: 'rc-title', textContent: T('routines.fromReply') }), form, saved, actions);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'rc-title');
    sheet = h('div', { className: 'shortcut-sheet rc-sheet', id: 'rc-sheet', hidden: true }, card);
    els = { name, request, when, preview, error, create, cancel, saved, done, form, card };
    when.addEventListener('input', () => { found = null; queuePreview(); });
    for (const el of [name, request]) el.addEventListener('input', () => { els.error.hidden = true; });
    create.onclick = save;
    for (const el of [name, when]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); save(); } });
    cancel.onclick = close;
    done.onclick = close;
    sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) close(); });
    sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const stops = [...card.querySelectorAll('input, textarea, button')].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.append(sheet);
  }

  const showError = (text) => { els.error.textContent = text; els.error.hidden = !text; };

  // The When box, read by main (features/routines.js parseScheduleText); the line under it says what was understood and when it runs next.
  function queuePreview(now = false) {
    clearTimeout(previewTimer);
    const text = els.when.value.trim();
    if (!text) { seq++; found = null; els.preview.textContent = ''; els.preview.classList.remove('bad'); return Promise.resolve(); }
    const run = async () => {
      const mine = ++seq;
      const out = await api.preview(text).catch(() => null);
      if (mine !== seq || !sheet || sheet.hidden) return;
      const parsed = out?.parsed;
      if (!parsed) {
        found = null;
        els.preview.classList.add('bad');
        els.preview.textContent = out?.error || T('routines.chat.unreadable');
        return;
      }
      found = { schedule: parsed.schedule, rest: parsed.prompt || '' };
      els.preview.classList.remove('bad');
      const next = (out.next || []).map(stamp).join(', ');
      els.preview.textContent = [T('routines.chat.understood', { schedule: scheduleText(parsed.schedule) }), next ? T('routines.next', { times: next }) : ''].filter(Boolean).join(' ');
    };
    if (now) return run();
    return new Promise((resolve) => { previewTimer = setTimeout(() => { run().then(resolve); }, 250); });
  }

  async function save() {
    if (saving) return;
    showError('');
    const request = els.request.value.trim();
    if (!els.when.value.trim()) { showError(T('routines.chat.error.when')); els.when.focus(); return; }
    saving = true;
    els.create.disabled = true;
    try {
      await queuePreview(true); // (the box as it stands now, not as it was 250 ms ago)
      if (!found) { showError(els.preview.textContent || T('routines.chat.unreadable')); els.when.focus(); return; }
      const prompt = request || found.rest;
      if (!prompt) { showError(T('routines.chat.error.request')); els.request.focus(); return; }
      const res = await api.create({ title: els.name.value.trim() || nameFrom(prompt) || T('routines.title'), prompt, schedule: found.schedule, enabled: true });
      if (!res?.ok) { showError(res?.error || T('routines.chat.error.request')); return; }
      els.form.hidden = true;
      els.create.hidden = true;
      els.cancel.hidden = true;
      els.saved.hidden = false;
      els.done.hidden = false;
      els.done.focus();
      try { onSaved?.(res); } catch { /* the dialog is the answer: a failing follower changes nothing */ }
    } catch (err) {
      showError(String(err?.message || err));
    } finally {
      saving = false;
      els.create.disabled = false;
    }
  }

  function close() {
    if (!sheet || sheet.hidden) return;
    clearTimeout(previewTimer);
    seq++;
    sheet.hidden = true;
    onSaved = null;
    (returnTo && returnTo.isConnected ? returnTo : input).focus();
  }

  // opts: { request, when, name, onSaved(result) }
  function open(opts = {}) {
    if (!sheet) build();
    returnTo = document.activeElement && document.activeElement !== document.body ? document.activeElement : input;
    onSaved = typeof opts.onSaved === 'function' ? opts.onSaved : null;
    found = null;
    saving = false;
    els.form.hidden = false;
    els.create.hidden = false;
    els.cancel.hidden = false;
    els.create.disabled = false;
    els.saved.hidden = true;
    els.done.hidden = true;
    showError('');
    els.request.value = String(opts.request || '').slice(0, 8000);
    els.name.value = String(opts.name || nameFrom(opts.request) || '').slice(0, 80);
    els.when.value = String(opts.when || '').slice(0, 200);
    els.preview.textContent = '';
    els.preview.classList.remove('bad');
    sheet.hidden = false;
    if (els.when.value) queuePreview(true);
    (els.when.value ? els.request : els.when).focus();
  }

  // ---- /routine [every weekday at 8am:] what to do
  window.slashCommands?.register({
    name: 'routine',
    label: T('routines.slash.label'),
    description: T('routines.slash.description'),
    takesInput: true,
    hint: T('routines.slash.hint'),
    async run({ input: text }) {
      const src = String(text || '').trim();
      let parsed = null;
      if (src) { try { parsed = (await api.preview(src))?.parsed || null; } catch { parsed = null; } }
      if (parsed) { const { when, request } = splitPhrase(src, parsed); open({ when, request }); } else open({ request: src });
      return { ok: true };
    },
  });

  // ---- "Schedule this" beside Copy on a finished reply: the message that led to it, as a routine.
  const CLOCK = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M3 2.5 1.5 4M13 2.5 14.5 4"/></svg>';
  const requestBefore = (bubble) => {
    for (let n = bubble.previousElementSibling; n; n = n.previousElementSibling) if (n.classList?.contains('msg') && n.classList.contains('user')) return n.textContent.trim();
    return '';
  };
  const finishBase = window.finishReply;
  if (typeof finishBase === 'function') {
    window.finishReply = function finishReply(bubble, ...rest) {
      const result = finishBase.call(this, bubble, ...rest);
      if (bubble?.querySelector(':scope > .reply-copy') && !bubble.querySelector(':scope > .reply-routine')) {
        const b = h('button', { type: 'button', className: 'reply-routine', title: T('routines.fromReply') });
        b.setAttribute('aria-label', T('routines.fromReply'));
        b.innerHTML = CLOCK;
        b.onclick = () => { const text = requestBefore(bubble); open({ request: text }); };
        bubble.append(b);
      }
      return result;
    };
  }

  // ---- the offer: "Make this a routine?" above the composer while the message starts with a schedule phrase
  const bar = h('div', { id: 'rc-offer', className: 'rc-offer', hidden: true });
  bar.setAttribute('role', 'status');
  const offerText = h('span', { className: 'rc-offer-text', textContent: T('routines.offer.text') });
  const offerYes = h('button', { type: 'button', id: 'rc-offer-yes', className: 'btn primary', textContent: T('routines.offer.button') });
  const offerNo = h('button', { type: 'button', id: 'rc-offer-no', className: 'btn', textContent: T('routines.offer.dismiss') });
  bar.append(offerText, offerYes, offerNo);
  composer.prepend(bar);
  let offered = null; // { text, parsed }: what the bar is for right now
  let dismissed = ''; // the phrase the user said "Not now" to; the bar stays away until the phrase changes
  let offerTimer = 0;
  let offerSeq = 0;
  const headOf = (text) => { const m = /^[^:,\n]*/.exec(String(text).trim()); return (m ? m[0] : '').trim().toLowerCase(); }; // the phrase part: what "Not now" is remembered by
  const hideOffer = () => { offerSeq++; offered = null; bar.hidden = true; };
  function checkOffer() {
    clearTimeout(offerTimer);
    const text = input.value;
    if (!window.routinePhrase?.looksScheduled(text) || composer.querySelector('.slash-chip:not([hidden])') || headOf(text) === dismissed) { hideOffer(); return; }
    offerTimer = setTimeout(async () => {
      const mine = ++offerSeq;
      const out = await api.preview(text.trim()).catch(() => null);
      if (mine !== offerSeq || input.value !== text) return;
      if (!out?.parsed) { offered = null; bar.hidden = true; return; }
      offered = { text, parsed: out.parsed };
      bar.hidden = false;
    }, 400);
  }
  input.addEventListener('input', checkOffer);
  composer.addEventListener('submit', hideOffer, true);
  offerNo.onclick = () => { if (offered) dismissed = headOf(offered.text); hideOffer(); input.focus(); };
  offerYes.onclick = () => {
    if (!offered) return;
    const { text, parsed } = offered;
    const { when, request } = splitPhrase(text, parsed);
    hideOffer();
    open({
      when, request,
      onSaved: () => { if (input.value === text) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); } dismissed = ''; },
    });
  };

  window.lumenRoutines = { open, scheduleText };
})();
