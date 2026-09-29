// The composer's "/" menu: type "/" at the start of the message box, pick a command, and it runs.
// A small module of its own so any feature can add commands without touching this file:
//
//   const off = window.slashCommands.register({
//     name: 'watch',                  // what is typed after "/": lower case letters, digits, hyphens
//     label: 'Watch a page',          // the menu's title for it (and searched)
//     description: 'Tell me when it changes.', // one line under it (and searched)
//     takesInput: true,               // true: picking it shows a chip with an argument field;
//                                     //       false/omitted: picking it runs at once (Tab still adds the field)
//     hint: 'What to watch for',      // the argument field's placeholder
//     check(state) { return null; },  // optional: a sentence when it can't run now ("Select some text first"),
//                                     //   else null; `state` is what setContextLoader's function returned
//     async run({ input, extra, ask, notify }) {   // input: the text after the command; extra: what activate() was given
//       ask('...');                   // send a message through the normal chat path
//       return { ok: false, message: 'Why not' };  // optional: keep the chip and say why
//     },
//   });                               // off() removes it
//
//   slashCommands.setContextLoader(async () => state)   // asked each time the menu opens (checks use it)
//   slashCommands.activate(name, extra)                 // put a command's chip in the composer, as if picked
//   slashCommands.list()
//
// Keyboard: Up/Down move, Enter or Tab pick, Esc closes. The message box is a combobox and the menu a
// listbox, so a screen reader hears the highlighted command and any "can't run" reason.
(() => {
  const promptEl = document.getElementById('prompt');
  const composer = document.getElementById('composer');
  if (!promptEl || !composer) return;
  const tr = (key, fallback, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    return text === key ? (vars ? fallback.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : fallback) : text;
  };

  const commands = new Map();
  let loader = null;
  let state = null; // the loader's last answer
  let open = false;
  let shown = []; // the commands in the menu now
  let index = 0;
  let active = null; // { cmd, extra }: the chip in the composer
  let composing = false;
  let hintTimer = null;

  // ---------- the menu, the chip, the hint ----------
  const menu = Object.assign(document.createElement('div'), { id: 'slash-menu', className: 'slash-menu', hidden: true });
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', tr('slash.label', 'Commands'));
  const hint = Object.assign(document.createElement('div'), { className: 'slash-hint', hidden: true });
  hint.setAttribute('role', 'status');
  const chip = Object.assign(document.createElement('div'), { className: 'slash-chip', hidden: true });
  const chipName = Object.assign(document.createElement('span'), { className: 'slash-chip-name' });
  const chipRemove = Object.assign(document.createElement('button'), { type: 'button', className: 'slash-chip-x', textContent: '×' });
  chipRemove.setAttribute('aria-label', tr('slash.remove', 'Remove the command'));
  const chipHint = Object.assign(document.createElement('span'), { className: 'slash-chip-hint' });
  chip.append(chipName, chipHint, chipRemove);
  composer.prepend(menu);
  promptEl.before(hint, chip);
  promptEl.setAttribute('role', 'combobox');
  promptEl.setAttribute('aria-autocomplete', 'list');
  promptEl.setAttribute('aria-controls', 'slash-menu');
  promptEl.setAttribute('aria-expanded', 'false');

  function notify(text) {
    clearTimeout(hintTimer);
    hint.textContent = text || '';
    hint.hidden = !text;
    if (text) hintTimer = setTimeout(() => { hint.hidden = true; }, 8000);
  }

  const reason = (cmd) => { try { return cmd.check ? cmd.check(state || {}) : null; } catch { return null; } };

  function render() {
    menu.replaceChildren(...shown.map((cmd, i) => {
      const why = reason(cmd);
      const item = document.createElement('div');
      item.id = `slash-opt-${i}`;
      item.className = `slash-item${why ? ' unavailable' : ''}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(i === index));
      if (why) item.setAttribute('aria-description', why);
      const name = Object.assign(document.createElement('span'), { className: 'slash-name', textContent: `/${cmd.name}` });
      const text = Object.assign(document.createElement('span'), { className: 'slash-text', textContent: cmd.description || cmd.label || '' });
      item.append(name, text);
      if (why) item.append(Object.assign(document.createElement('span'), { className: 'slash-flag', textContent: why }));
      item.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the message box focused
      item.addEventListener('click', () => { index = i; pick(false); });
      return item;
    }));
    const current = menu.children[index];
    if (current) { promptEl.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); }
    else promptEl.removeAttribute('aria-activedescendant');
  }

  function openMenu(query) {
    shown = window.slashMatch.rank([...commands.values()], query);
    index = 0;
    open = shown.length > 0;
    menu.hidden = !open;
    promptEl.setAttribute('aria-expanded', String(open));
    if (!open) { promptEl.removeAttribute('aria-activedescendant'); return; }
    render();
    if (loader && !menu.dataset.loading) { // the page's state (selection, ...) makes the "can't run" reasons; it arrives a moment later
      menu.dataset.loading = '1';
      Promise.resolve(loader()).then((s) => { state = s; if (open) render(); }).catch(() => {}).finally(() => { delete menu.dataset.loading; });
    }
  }
  function closeMenu() {
    open = false;
    menu.hidden = true;
    promptEl.setAttribute('aria-expanded', 'false');
    promptEl.removeAttribute('aria-activedescendant');
  }

  // ---------- the chip ----------
  let saved = null; // the message box's own placeholder and label, put back when the chip goes
  function setChip(cmd, extra = null) {
    active = cmd ? { cmd, extra } : null;
    chip.hidden = !cmd;
    chipName.textContent = cmd ? `/${cmd.name}` : '';
    chipHint.textContent = cmd ? (cmd.hint || tr('slash.argument', 'Add details (optional), then press Enter')) : '';
    chip.title = cmd ? [cmd.label, cmd.description].filter(Boolean).join(': ') : '';
    if (cmd) {
      saved ||= { placeholder: promptEl.placeholder, label: promptEl.getAttribute('aria-label') };
      promptEl.placeholder = chipHint.textContent;
      promptEl.setAttribute('aria-label', `${cmd.label || cmd.name}. ${chipHint.textContent}`);
    } else if (saved) {
      promptEl.placeholder = saved.placeholder;
      if (saved.label) promptEl.setAttribute('aria-label', saved.label);
      saved = null;
    }
    notify('');
    window.updateSend?.();
  }
  chipRemove.addEventListener('click', () => { setChip(null); promptEl.focus(); });

  // Picks the highlighted command. `wantField` (Tab): always the chip with an argument field.
  async function pick(wantField) {
    const cmd = shown[index];
    if (!cmd) return;
    const why = reason(cmd);
    if (why) { notify(why); return; } // "Select some text first": say so instead of sending an empty variable
    closeMenu();
    promptEl.value = '';
    autosizeBox();
    if (cmd.takesInput || wantField) { setChip(cmd); promptEl.focus(); return; }
    await execute(cmd, '', null);
  }

  const autosizeBox = () => { if (typeof window.autosize === 'function') window.autosize(); };

  async function execute(cmd, input, extra) {
    const why = reason(cmd);
    if (why) { notify(why); return false; }
    let result;
    try {
      result = await cmd.run({ input, extra, ask: (text, images) => window.ask(text, images), notify });
    } catch (err) {
      result = { ok: false, message: String(err?.message || err) };
    }
    if (result && result.ok === false) { notify(result.message || tr('slash.failed', 'That did not run.')); return false; }
    setChip(null);
    promptEl.value = '';
    autosizeBox();
    window.updateSend?.();
    return true;
  }

  // ---------- typing ----------
  promptEl.addEventListener('compositionstart', () => { composing = true; });
  promptEl.addEventListener('compositionend', () => { composing = false; });
  promptEl.addEventListener('input', () => {
    notify('');
    if (composing) return;
    if (active) { closeMenu(); return; }
    const parsed = window.slashMatch.parse(promptEl.value, (name) => commands.has(name));
    if (parsed.kind === 'menu') openMenu(parsed.query);
    else if (parsed.kind === 'chip') { closeMenu(); setChip(commands.get(parsed.name)); promptEl.value = parsed.rest; autosizeBox(); }
    else closeMenu();
  });
  promptEl.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== promptEl) closeMenu(); }, 120));
  // Capture: these keys mean something here before the chat's own Enter-to-send sees them.
  promptEl.addEventListener('keydown', (e) => {
    if (e.isComposing || composing) return;
    const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { swallow(); index = (index + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; render(); }
      else if (e.key === 'Enter' && !e.shiftKey) { swallow(); pick(false); }
      else if (e.key === 'Tab' && !e.shiftKey) { swallow(); pick(true); }
      else if (e.key === 'Escape') { swallow(); closeMenu(); }
      return;
    }
    if (!active) return;
    if (e.key === 'Enter' && !e.shiftKey) { swallow(); execute(active.cmd, promptEl.value.trim(), active.extra); }
    else if (e.key === 'Escape') { swallow(); setChip(null); }
    else if (e.key === 'Backspace' && promptEl.value === '' && promptEl.selectionStart === 0) { swallow(); setChip(null); }
  }, true);
  // The send button: with a chip (or the menu open) it does what Enter does.
  composer.addEventListener('submit', (e) => {
    if (active) { e.preventDefault(); e.stopImmediatePropagation(); execute(active.cmd, promptEl.value.trim(), active.extra); }
    else if (open) { e.preventDefault(); e.stopImmediatePropagation(); pick(false); }
  }, true);
  // The send button stays lit while a command waits for its (possibly empty) argument.
  const updateBase = window.updateSend;
  if (typeof updateBase === 'function') {
    window.updateSend = function updateSend(...args) {
      const result = updateBase.apply(this, args);
      if (active) document.getElementById('send').disabled = false;
      return result;
    };
  }

  // ---------- the API ----------
  window.slashCommands = {
    register(cmd) {
      if (!cmd || !/^[a-z0-9-]{1,32}$/.test(cmd.name) || typeof cmd.run !== 'function') throw new Error('A slash command needs a lower case name and a run function.');
      commands.set(cmd.name, cmd);
      return () => { if (commands.get(cmd.name) === cmd) commands.delete(cmd.name); };
    },
    unregister(name) { commands.delete(name); if (active?.cmd.name === name) setChip(null); },
    list: () => [...commands.values()],
    setContextLoader(fn) { loader = fn; },
    activate(name, extra) {
      const cmd = commands.get(name);
      if (!cmd) return false;
      closeMenu();
      promptEl.value = '';
      setChip(cmd, extra || null);
      promptEl.focus();
      return true;
    },
    notify,
  };
})();
