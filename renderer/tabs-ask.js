// "@" in the composer: ask across open tabs. Typing @ opens a picker of this window's tabs (plus
// "this tab" and "all tabs" and two quick actions); a pick becomes a removable chip above the
// composer, and on send the chosen tabs' text goes with the message (main reads it where the tab
// is, without switching to it; agent.js tabsContextFor). Shared by the sidebar and the full-page
// chat. The logic without the DOM is in tabs-ask-core.js. Loaded after chat-core.js.
(() => {
  const core = window.tabsAskCore;
  const prompt = document.getElementById('prompt');
  const picker = document.getElementById('tabs-picker');
  const chipsEl = document.getElementById('tab-chips');
  const confirmEl = document.getElementById('tabs-confirm');
  if (!core || !prompt || !picker || !chipsEl || !confirmEl || !window.assistant?.askTabs) return; // a surface without the composer bits or the bridge

  const CONFIRM_ALL_OVER = 8;
  const QUICK = [
    { kind: 'quick', id: 'summarize', title: () => t('tabs.quick.summarize'), prompt: () => t('tabs.quick.summarize.prompt') },
    { kind: 'quick', id: 'compare', title: () => t('tabs.quick.compare'), prompt: () => t('tabs.quick.compare.prompt') },
  ];
  let chips = [];
  let tabs = []; // the last list from main: { id, title, host, active, sleeping }
  let confirmedAll = false; // "@all tabs" over CONFIRM_ALL_OVER tabs asked once in this chat
  let mention = null;
  let rows = [];
  let index = 0;
  let seq = 0;

  async function refresh() {
    try { tabs = (await window.assistant.askTabs()) || []; } catch { tabs = []; }
    return tabs;
  }

  // ---------- chips ----------
  function renderChips() {
    chipsEl.hidden = chips.length === 0;
    chipsEl.replaceChildren(...chips.map((chip, i) => {
      const el = document.createElement('span');
      el.className = `tab-chip ${chip.kind}`;
      el.setAttribute('role', 'listitem');
      const name = chip.kind === 'all' ? t('tabs.all') : chip.kind === 'this' ? t('tabs.this') : chip.title || chip.host || t('tabs.untitled');
      const label = document.createElement('span');
      label.className = 'tab-chip-name';
      label.textContent = `@${name}`;
      label.title = chip.host ? `${name} — ${chip.host}` : name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tab-chip-remove';
      remove.setAttribute('aria-label', t('tabs.remove', { name }));
      remove.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>';
      const drop = () => { chips = core.removeChip(chips, i); renderChips(); prompt.focus(); };
      remove.onclick = drop;
      remove.addEventListener('keydown', (e) => { if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); drop(); } });
      el.append(label, remove);
      return el;
    }));
    chipsEl.setAttribute('aria-label', t('tabs.chips'));
    if (typeof updateSend === 'function') updateSend();
  }

  // ---------- the confirm for "@all tabs" over 8 tabs (once per chat) ----------
  function askConfirm(count, onYes) {
    confirmEl.hidden = false;
    confirmEl.replaceChildren();
    const text = Object.assign(document.createElement('span'), { textContent: t('tabs.confirmAll', { count }) });
    const yes = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: t('tabs.confirmAll.yes') });
    const no = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('tabs.confirmAll.no') });
    const close = () => { confirmEl.hidden = true; confirmEl.replaceChildren(); prompt.focus(); };
    yes.onclick = () => { confirmedAll = true; close(); onYes(); };
    no.onclick = close;
    confirmEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    confirmEl.append(text, no, yes);
    yes.focus();
  }

  function addPicked(item) {
    const apply = () => { chips = core.addChip(chips, item); renderChips(); };
    if (item.kind === 'all' && tabs.length > CONFIRM_ALL_OVER && !confirmedAll) askConfirm(tabs.length, apply);
    else apply();
  }

  // ---------- the picker ----------
  function closePicker() {
    mention = null;
    picker.hidden = true;
    picker.replaceChildren();
    if (prompt.getAttribute('aria-controls') !== 'tabs-picker') return; // the "/" menu's state (slash.js) is not ours to clear
    prompt.removeAttribute('aria-activedescendant');
    if (document.getElementById('slash-menu')) { // hand the box back to the "/" menu
      prompt.setAttribute('aria-controls', 'slash-menu');
      prompt.setAttribute('aria-expanded', 'false');
      return;
    }
    prompt.removeAttribute('aria-expanded');
    prompt.removeAttribute('aria-controls');
    prompt.removeAttribute('aria-autocomplete');
    if (prompt.getAttribute('role') === 'combobox') prompt.removeAttribute('role');
  }

  function rowText(row) {
    if (row.kind === 'this') return { title: t('tabs.this'), sub: t('tabs.this.sub') };
    if (row.kind === 'all') return { title: t('tabs.all'), sub: t('tabs.all.sub', { count: row.count }) };
    if (row.kind === 'quick') return { title: row.title(), sub: t('tabs.quick.sub') };
    return { title: row.title || row.host || t('tabs.untitled'), sub: `${row.host}${row.sleeping ? ` · ${t('tabs.asleep')}` : ''}` };
  }

  function renderPicker() {
    if (!mention) { closePicker(); return; }
    const words = mention.query.trim();
    rows = core.pickerItems(tabs, mention.query, chips);
    if (!words || QUICK.some((q) => q.title().toLowerCase().includes(words.toLowerCase()))) {
      if (tabs.length >= 2 && !chips.some((c) => c.kind === 'all')) rows.push(...QUICK.filter((q) => !words || q.title().toLowerCase().includes(words.toLowerCase())));
    }
    if (!rows.length) { closePicker(); return; }
    index = Math.min(index, rows.length - 1);
    picker.hidden = false;
    prompt.setAttribute('role', 'combobox');
    prompt.setAttribute('aria-expanded', 'true');
    prompt.setAttribute('aria-controls', 'tabs-picker');
    prompt.setAttribute('aria-autocomplete', 'list');
    picker.replaceChildren(...rows.map((row, i) => {
      const el = document.createElement('div');
      el.className = `tabs-opt ${row.kind}${i === index ? ' active' : ''}`;
      el.id = `tabs-opt-${i}`;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(i === index));
      const text = rowText(row);
      const title = Object.assign(document.createElement('span'), { className: 'tabs-opt-title', textContent: text.title });
      const sub = Object.assign(document.createElement('span'), { className: 'tabs-opt-sub', textContent: text.sub });
      if (row.kind === 'tab' && row.active) title.append(Object.assign(document.createElement('span'), { className: 'tabs-opt-badge', textContent: t('tabs.current') }));
      el.append(title, sub);
      el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); }); // the composer keeps its focus
      el.addEventListener('mousemove', () => { if (index !== i) { index = i; markActive(); } });
      return el;
    }));
    prompt.setAttribute('aria-activedescendant', `tabs-opt-${index}`);
    picker.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function markActive() {
    picker.querySelectorAll('.tabs-opt').forEach((el, i) => {
      el.classList.toggle('active', i === index);
      el.setAttribute('aria-selected', String(i === index));
    });
    prompt.setAttribute('aria-activedescendant', `tabs-opt-${index}`);
    picker.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const row = rows[i];
    if (!row || !mention) return;
    const out = core.removeMention(prompt.value, mention);
    prompt.value = out.text;
    prompt.setSelectionRange(out.caret, out.caret);
    closePicker();
    if (row.kind === 'quick') {
      // The quick actions attach every open tab and put the request in the composer, ready to send.
      addPicked({ kind: 'all', id: null, title: 'all tabs' });
      prompt.value = `${prompt.value}${prompt.value && !/\s$/.test(prompt.value) ? ' ' : ''}${row.prompt()}`;
    } else {
      addPicked(row);
    }
    prompt.dispatchEvent(new Event('input')); // autosize and the send button
    prompt.focus();
  }

  let stamp = 0;
  async function update() {
    const found = core.mentionAt(prompt.value, prompt.selectionStart);
    if (!found) { closePicker(); return; }
    const first = !mention;
    const changedQuery = !mention || mention.query !== found.query;
    mention = found;
    if (changedQuery) index = 0;
    if (first || Date.now() - stamp > 1500) {
      const mine = ++seq;
      stamp = Date.now();
      await refresh();
      if (mine !== seq || !mention) return; // a newer keystroke took over
    }
    renderPicker();
  }

  prompt.addEventListener('input', update);
  prompt.addEventListener('click', update);
  prompt.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) update(); });
  prompt.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== prompt) closePicker(); }, 120));
  // Before the composer's own Enter-to-send: while the picker is open the keys are its.
  prompt.addEventListener('keydown', (e) => {
    if (!picker.hidden && mention && rows.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopImmediatePropagation();
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        markActive();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.shiftKey && e.key === 'Enter') return;
        e.preventDefault(); e.stopImmediatePropagation();
        choose(index);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePicker(); return; }
    }
    // Backspace in an empty composer takes the last chip back off.
    if (e.key === 'Backspace' && chips.length && prompt.selectionStart === 0 && prompt.selectionEnd === 0) {
      e.preventDefault();
      chips = core.removeChip(chips, chips.length - 1);
      renderChips();
    }
  }, true);
  document.addEventListener('pointerdown', (e) => { if (!picker.hidden && !picker.contains(e.target) && e.target !== prompt) closePicker(); }, true);

  // ---------- what chat-core uses ----------
  // The chips as they stand, taken off the composer: { ids, names, gone } resolved against the tabs
  // open right now ("all tabs" and "this tab" are expanded here, at send time).
  async function take() {
    const taken = chips;
    if (!taken.length) return null;
    chips = [];
    renderChips();
    await refresh();
    const { ids, gone } = core.resolveChips(taken, tabs);
    const names = ids.map((id) => { const tab = tabs.find((x) => x.id === id); return { title: tab?.title || '', host: tab?.host || '' }; });
    return { ids, names, gone };
  }

  // A starter chip ("Summarize my open tabs"): every open tab goes with it, after the once-per-chat
  // confirm when there are many.
  async function askAll(text) {
    await refresh();
    const go = () => {
      const ids = tabs.map((x) => x.id);
      window.ask(text, [], { ids, names: tabs.map((x) => ({ title: x.title, host: x.host })), gone: [] });
    };
    if (tabs.length > CONFIRM_ALL_OVER && !confirmedAll) askConfirm(tabs.length, go);
    else go();
  }

  // The line under a sent message: how many tabs went along, and which. `info`: { ids, names } before
  // main answered, or main's tabs_attached list ([{ title, host, status }]) after.
  function describeSent(bubble, list, { final = false } = {}) {
    if (!bubble || !list.length) return;
    let line = bubble.querySelector('.msg-tabs');
    if (!line) {
      line = document.createElement('div');
      line.className = 'msg-tabs';
      bubble.append(line);
    }
    const read = final ? list.filter((x) => x.status === 'read' || x.status === 'cut') : list;
    const names = list.map((x) => x.title || x.host || t('tabs.untitled'));
    const unread = final ? list.length - read.length : 0;
    const head = t(read.length === 1 ? 'tabs.attached.one' : 'tabs.attached.other', { count: read.length });
    line.textContent = `${head}: ${names.join(', ')}${unread ? ` · ${t('tabs.notRead', { count: unread })}` : ''}`;
    line.title = list.map((x) => `${x.title || x.host}${x.status && x.status !== 'read' ? ` (${x.status})` : ''}`).join('\n');
  }

  function reset() {
    chips = [];
    confirmedAll = false;
    renderChips();
    closePicker();
    confirmEl.hidden = true;
    confirmEl.replaceChildren();
  }

  window.tabsAsk = { take, askAll, describeSent, reset, chips: () => chips.map((c) => ({ ...c })), open: () => update() };
  renderChips();
})();
