// The chat itself, shared by the sidebar (index.html) and the full-page chat (chat-page.html): the
// model picker, the "set up an AI" card, messages and streaming, image attachments, approval cards,
// restored history and the composer. A classic script: its functions and lets are globals the other
// scripts of the page (app.js, chats.js, extras.js, chat-page.js) use, as they did inside app.js.
// Everything that differs between the two surfaces goes through `chatHost`, set by the page's own script:
//   running(on)        a reply started or ended
//   needSidebar()      an approval card arrived: reveal the sidebar if it is hidden
//   identity(who, first)  the model's company changed (the toolbar button follows it)
//   chatChanged()      the other view switched chats
//   emptyText(name)    the empty chat's title, if it says something other than the sidebar's
const $ = (id) => document.getElementById(id);
const optional = (id) => $(id) || document.createElement('span'); // an element this surface leaves out: writes go nowhere
const chatHost = (window.chatHost = {});
const chatRoot = document.querySelector('[data-chat-root]');

// The gear (and "Set up AI" on errors) open the AI section of Settings.
const openAiSettings = () => window.lumenPrefs?.openSettingsPage('you-and-ai');
$('open-settings').onclick = openAiSettings;

// "Set up an AI" in the empty sidebar, while nothing is connected: three equal ways in. `s.model`
// is main's single source of truth for "is anything usable right now" — no client-side guessing,
// so this can never disagree with the picker (see loadModels below).
// A problem with a sign-in from the setup card, said on the card (not a native alert).
function setupError(text) {
  const card = optional('setup');
  if (!card) return;
  let el = card.querySelector('.setup-error');
  if (!el) { el = Object.assign(document.createElement('div'), { className: 'error setup-error' }); el.setAttribute('role', 'alert'); card.append(el); }
  el.textContent = text;
}
function clearSetupError() { optional('setup').querySelector?.('.setup-error')?.remove(); }
for (const id of ['setup-claude-code', 'setup-openrouter', 'setup-keys', 'setup-grok', 'setup-antigravity', 'setup-codex']) optional(id).addEventListener('click', clearSetupError, true);
async function refreshSetup() {
  const s = await window.assistant.getSettings();
  if (s.model) clearSetupError();
  // A local engine (Claude Code, Grok Build) found but signed out can't answer yet: while it's the
  // pick, the card stays up.
  const signedOut = s.models.find((m) => m.id === 'claudecode:default')?.signedIn === false;
  const pickSignedOut = s.models.find((m) => m.id === s.model)?.signedIn === false;
  $('setup').hidden = Boolean(s.model) && !pickSignedOut;
  optional('setup-claude-code-detail').textContent = !s.claudeCode
    ? t('setup.claudeCode.install')
    : signedOut
      ? t('setup.claudeCode.signedOut')
      : t('setup.claudeCode.ready');
  optional('setup-claude-code').classList.toggle('missing', !s.claudeCode); // (still clickable: it looks again)
  optional('setup-claude-code-get').hidden = Boolean(s.claudeCode);
  // Grok Build, once it's found on this computer (the sidebar only: the full-page chat can't switch it on).
  const grok = s.grokBuild || {};
  optional('setup-grok').hidden = !grok.installed || !window.assistant.useGrokBuild;
  optional('setup-grok-detail').textContent = grok.signedIn === false ? t('setup.grok.signedOut') : t('setup.grok.detail');
  // Antigravity (Google's CLI, which replaces Gemini CLI): always offered in the sidebar; not found, it leads to Settings, where the install command is.
  const agy = s.antigravity || {};
  optional('setup-antigravity').hidden = !window.assistant.useAntigravity;
  optional('setup-antigravity-detail').textContent = !agy.installed ? t('setup.antigravity.install') : agy.signedIn === false ? t('setup.antigravity.signedOut') : t('setup.antigravity.detail');
  // Codex (OpenAI's CLI): offered once it is found on this computer; the click turns it on in the sidebar.
  const cx = s.codex || {};
  optional('setup-codex').hidden = !cx.installed || !window.assistant.useCodex;
  optional('setup-codex-detail').textContent = cx.signedIn === false ? t('setup.codex.signedOut') : t('setup.codex.detail');
  const ready = Boolean(s.model) && !pickSignedOut;
  if (welcoming) {
    $('setup').hidden = ready;
    const step = $('welcome-step-ai');
    step.classList.toggle('done', ready);
    $('welcome-ai-detail').textContent = ready
      ? t('welcome.ai.ready', { name: s.models.find((m) => m.id === s.model)?.label || s.model })
      : t('welcome.ai.detail');
  }
  if (pendingAsk && Date.now() - pendingAsk.at > 10 * 60 * 1000) { pendingAsk = null; optional('setup-pending').hidden = true; } // (old: not sent out of the blue)
  if (ready && pendingAsk && !running) {
    const p = pendingAsk;
    pendingAsk = null;
    optional('setup-pending').hidden = true;
    optional('setup').classList.remove('attention');
    await loadModels();
    if (prompt.value.trim() === p.text.trim()) { prompt.value = ''; autosize(); updateSend(); }
    ask(p.text, p.images, p.tabs);
  }
}
// A question asked before any AI was connected: kept (in the box too), and sent once one is.
let pendingAsk = null;

// ---------- first-run welcome (the sidebar only; features/setup.js) ----------

// A fresh install opens the sidebar on this: connect an AI (the setup card, inside step 1), import bookmarks and
// history, become the default browser. Every step can be skipped; Start browsing ends it for good.
const welcome = document.getElementById('welcome');
let welcoming = false;
async function showWelcome() {
  if (!welcome || welcoming) return;
  const st = await window.assistant.setup?.state().catch(() => null);
  if (!st?.welcome) return;
  welcoming = true;
  welcome.hidden = false;
  $('empty').classList.add('welcoming');
  $('welcome-ai-slot').append($('setup'));
  // Import: one button per browser found; the result is said in the step.
  const actions = $('welcome-import-actions');
  const note = $('welcome-import-note');
  if (!st.browsers?.length) { note.textContent = t('welcome.import.none'); $('welcome-step-import').classList.add('skipped'); }
  actions.replaceChildren(...(st.browsers || []).map((b) => {
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: b.label });
    btn.onclick = async () => {
      for (const other of actions.querySelectorAll('button')) other.disabled = true;
      note.className = 'welcome-note';
      note.textContent = t('welcome.import.running', { browser: b.label });
      const r = await window.assistant.setup.importFrom(b.id).catch((err) => ({ ok: false, error: err.message }));
      for (const other of actions.querySelectorAll('button')) other.disabled = false;
      note.textContent = r.ok ? t('welcome.import.done', {
        browser: r.label,
        bookmarks: t(r.bookmarks === 1 ? 'import.bookmarks.one' : 'import.bookmarks.other', { count: r.bookmarks.toLocaleString() }),
        history: t(r.history === 1 ? 'import.history.one' : 'import.history.other', { count: r.history.toLocaleString() }),
      }) : t('welcome.import.failed', { error: r.error });
      note.classList.toggle('err', !r.ok);
      if (r.ok) $('welcome-step-import').classList.add('done');
    };
    return btn;
  }));
  showDefault(st.isDefault || st.devBuild); // (a copy run from source doesn't offer it)
  refreshSetup();
  announce(`${t('welcome.title')}. ${t('welcome.lead')}`);
  welcome.querySelector('.setup-option:not(:disabled)')?.focus({ preventScroll: true });
}
function showDefault(isDefault) {
  if (!welcome) return;
  $('welcome-step-default').hidden = Boolean(isDefault); // (already the default: nothing to offer)
}
if (welcome) {
  $('welcome-make-default').onclick = async () => {
    const r = await window.assistant.setup.makeDefault().catch(() => null);
    const note = $('welcome-default-note');
    if (r?.devBuild) note.textContent = t('welcome.default.devBuild');
    else if (r?.opened === 'windows-settings') note.textContent = t(r.ok ? 'welcome.default.windows' : 'welcome.default.windowsManual');
    else if (r?.isDefault) showDefault(true);
    else if (r?.opened === 'system-prompt') note.textContent = t('welcome.default.confirm');
    else note.textContent = t(r ? 'welcome.default.notTaken' : 'welcome.default.failed'); // (never a click that seems to do nothing)
  };
  // Back from the system's Default apps page: did it take?
  // Back from system settings: the line goes if it took; otherwise its instruction is simply cleared.
  window.addEventListener('focus', () => { if (welcoming) window.assistant.setup.isDefault().then((yes) => { if (yes) showDefault(true); else $('welcome-default-note').textContent = ''; }).catch(() => {}); });
  $('welcome-done').onclick = () => finishWelcome();
  window.assistant.setup?.onWelcome?.(() => showWelcome());
}
function finishWelcome({ focus = true } = {}) {
  if (!welcoming) return;
  welcoming = false;
  window.assistant.setup.done().catch(() => {});
  welcome.hidden = true;
  $('empty').classList.remove('welcoming');
  $('empty').querySelector('.chips')?.before($('setup')); // the setup card back in its place
  refreshSetup();
  if (focus) prompt.focus();
}
optional('setup-claude-code').onclick = async () => {
  // Signed out a moment ago, or just installed? Ask again first (no restart needed).
  const status = await window.lumenExtras?.claudeCodeStatus?.(true).catch(() => null);
  if (status && !status.installed) { setupError(t('setup.claudeCode.notFound')); return; }
  if (status?.signedIn === false) { setupError(t('setup.claudeCode.stillSignedOut')); return; }
  if (await window.assistant.setModel('claudecode:default')) await loadModels();
  refreshSetup();
};
optional('setup-grok').onclick = async () => {
  const r = await window.assistant.useGrokBuild?.().catch(() => null);
  if (!r?.installed) { setupError(t('setup.grok.notFound')); return; }
  if (!r.signedIn) { setupError(t('setup.grok.signedOut')); return; }
  if (await window.assistant.setModel('grokbuild:default')) await loadModels();
  refreshSetup();
};
optional('setup-antigravity').onclick = async () => {
  const r = await window.assistant.useAntigravity?.().catch(() => null);
  if (!r?.installed) { window.lumenPrefs?.openSettingsPage('antigravity'); return; } // not installed: Settings shows Google's install command and a button
  if (!r.signedIn) { setupError(t('setup.antigravity.signedOut')); return; }
  if (await window.assistant.setModel('antigravity:default')) await loadModels();
  refreshSetup();
};
optional('setup-codex').onclick = async () => {
  const r = await window.assistant.useCodex?.().catch(() => null);
  if (!r?.installed) { setupError(t('setup.codex.notFound')); return; }
  if (!r.signedIn) { setupError(t('setup.codex.signedOut')); return; }
  if (await window.assistant.setModel('codex:default')) await loadModels();
  refreshSetup();
};
$('setup-keys').onclick = () => window.lumenPrefs?.openSettingsPage('ai-keys'); // (straight to the keys, first Add focused)
// While the sign-in tab is open the button becomes Cancel (closing that tab cancels too).
let openRouterPending = false;
optional('setup-openrouter').onclick = async () => {
  // (The full-page chat can't sign in itself, by design: Settings does it there.)
  if (!window.assistant.openRouterSignIn) { window.lumenPrefs?.openSettingsPage('ai-keys'); return; }
  const btn = optional('setup-openrouter');
  const title = btn.querySelector('.setup-name') || btn;
  if (openRouterPending) { window.assistant.cancelOpenRouterSignIn?.(); return; }
  openRouterPending = true;
  const label = title.textContent;
  title.textContent = t('setup.openrouter.cancel');
  try {
    const r = await window.assistant.openRouterSignIn();
    if (r?.ok) { await loadModels(); refreshSetup(); }
    else if (r?.message && !r.cancelled) setupError(r.message);
  } catch (err) {
    setupError(t('setup.openrouter.failed', { error: err?.message || err }));
  } finally {
    openRouterPending = false;
    title.textContent = label;
  }
};
window.assistant.onModelsUpdated?.(() => refreshSetup());

// ---------- model picker ----------

// ---------- the toolbar AI button follows the model's company ----------

// Simple monochrome marks (drawn here, sized for 16px), tinted per company.
const ASSISTANTS = {
  // Nothing connected: no provider to privilege, so a neutral mark instead of defaulting to Claude's.
  AI: {
    name: 'AI',
    tint: 'currentColor',
    svg: '<svg viewBox="0 0 16 16" class="mark"><circle cx="8" cy="8" r="5.25"/></svg>',
  },
  Claude: {
    name: 'Claude',
    tint: '#d97757',
    svg: '<svg viewBox="0 0 16 16" class="mark"><path d="M8 2.5v11M2.5 8h11M4.1 4.1l7.8 7.8M11.9 4.1l-7.8 7.8"/></svg>',
  },
  OpenAI: {
    name: 'ChatGPT',
    tint: 'currentColor',
    svg: '<svg viewBox="0 0 16 16" class="mark"><g transform="translate(8 8)"><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(60)"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(120)"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(180)"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(240)"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(300)"/></g></svg>',
  },
  Grok: {
    name: 'Grok',
    tint: 'currentColor',
    svg: '<svg viewBox="0 0 16 16" class="mark"><path d="M3.2 13.4 12.8 2.6" stroke-width="1.8"/><path d="M3.4 2.6 6.9 6.8"/><path d="M9.1 9.2 12.6 13.4"/></svg>',
  },
  OpenRouter: {
    name: 'OpenRouter',
    tint: 'currentColor',
    // A neutral routing glyph: one line branching to three.
    svg: '<svg viewBox="0 0 16 16" class="mark"><path d="M2.5 8h4.5M7 8c2 0 2.5-4 5-4M7 8c2 0 2.5 4 5 4M7 8h5"/><circle cx="13" cy="4" r="1"/><circle cx="13" cy="8" r="1"/><circle cx="13" cy="12" r="1"/></svg>',
  },
  Antigravity: {
    name: 'Antigravity',
    tint: 'currentColor',
    // A neutral mark: an arch with a spark above it.
    svg: '<svg viewBox="0 0 16 16" class="mark"><path d="M3 13.2 8 3.4l5 9.8"/><path d="M5.6 9.6h4.8"/><circle cx="8" cy="1.8" r=".8"/></svg>',
  },
  Codex: {
    name: 'Codex',
    tint: 'currentColor',
    // OpenAI's blossom, as ChatGPT's mark, with a prompt caret in the middle.
    svg: '<svg viewBox="0 0 16 16" class="mark"><g transform="translate(8 8)"><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(120)"/><path d="M0-5.6a2.8 2.8 0 0 1 2.8 2.8v3.4" transform="rotate(240)"/></g><path d="M6.6 6.8 8.4 8 6.6 9.2"/></svg>',
  },
  Gemini: {
    name: 'Gemini',
    tint: 'url(#gemini-grad)',
    svg: '<svg viewBox="0 0 16 16" class="mark filled"><defs><linearGradient id="gemini-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#a86bff"/></linearGradient></defs><path d="M8 1.6C8.5 5 11 7.5 14.4 8 11 8.5 8.5 11 8 14.4 7.5 11 5 8.5 1.6 8 5 7.5 7.5 5 8 1.6Z"/></svg>',
  },
};
let assistantIdentity = null;

function setAssistantIdentity(group) {
  // Claude Code answers as Claude, Grok Build as Grok. No group (nothing connected) or an unknown
  // one: the neutral mark.
  const who = ASSISTANTS[group === 'Your Claude account' ? 'Claude' : group === 'Your Grok account' ? 'Grok' : group === 'Your Google account' ? 'Antigravity' : group === 'Your OpenAI account' ? 'Codex' : group] || ASSISTANTS.AI;
  if (assistantIdentity === who) return;
  const first = assistantIdentity === null;
  assistantIdentity = who;
  chatHost.identity?.(who, first); // the sidebar's toolbar button follows the model's company (app.js)
  const empty = document.querySelector('#empty .empty-title');
  if (empty) empty.textContent = chatHost.emptyText ? chatHost.emptyText(who.name) : t('sidebar.empty', { name: who.name });
  const pill = $('agent-pill-text');
  if (pill && !document.body.classList.contains('mcp-active')) pill.textContent = t('agent.usingTab', { name: who.name });
}

// "Search every OpenRouter model": offered at the end of the list whenever OpenRouter is connected.
const modelPicker = window.lumenPicker($('model'), {
  recentKey: 'model',
  onMore: () => openModelSearch(), // "More models…" opens the catalog; it is never the select's value, even for a frame
  // (The OpenRouter group has its own "More models…" row; a search adds a way to look the words up there too.)
  extra: (q) => (q && modelGroups.has('openrouter:__more') ? [{ label: t('models.searchFor', { q }), detail: t('models.more.detail'), run: (text) => openModelSearch(text) }] : []),
});

// Whether there is any model to talk to right now (main's settings:get is the single source of
// truth); ask() below checks this before sending, instead of letting a request fail with an error.
let modelReady = false;
let modelGroups = new Map(); // model id -> its group ("Claude", "OpenAI", "Your Claude account", …)

async function loadModels() {
  const s = await window.assistant.getSettings();
  modelGroups = new Map(s.models.map((m) => [m.id, m.group]));
  const select = $('model');
  const picker = select.closest('.model-picker');
  modelReady = Boolean(s.model);
  if (picker) picker.hidden = !modelReady; // nothing connected: no picker, not an empty one
  const groups = new Map();
  for (const m of s.models) {
    if (!groups.has(m.group)) groups.set(m.group, Object.assign(document.createElement('optgroup'), { label: m.group }));
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.label;
    option.title = m.detail;
    // The picker's row (picker.js): readable name, the id or a note under it, and badges.
    if (m.name) option.dataset.name = m.name;
    if (m.provider) option.dataset.provider = m.provider;
    if (m.detail) option.dataset.detail = m.detail;
    if (m.badges?.length) option.dataset.badges = m.badges.join(',');
    if (Number.isFinite(m.price)) option.dataset.price = String(m.price); // searched by value
    if (m.context) option.dataset.context = String(m.context);
    if (m.title) option.title = m.title;
    if (m.more) option.dataset.more = '1';
    if (m.auto) option.dataset.auto = '1'; // Auto, or a provider's own Auto: the model is chosen per message
    groups.get(m.group).append(option);
  }
  // A single group needs no heading.
  select.replaceChildren(...(groups.size > 1 ? groups.values() : [...groups.values()].flatMap((g) => [...g.children])));
  if (modelReady) { select.value = s.model; select.pickerSync(); }
  const current = s.models.find((m) => m.id === s.model);
  select.title = current?.detail || '';
  // [model fallback] The picked model is unavailable for now: the picker shows the one really answering, marked as temporary.
  if (s.fallback) {
    const hint = t('models.fallbackHint', { name: s.fallback.to, from: s.fallback.from });
    select.title = hint;
    modelPicker.button.title = hint;
    modelPicker.button.dataset.temporary = '1';
  } else delete modelPicker.button.dataset.temporary;
  prompt.placeholder = !current ? t('composer.setup') : current.auto ? t('composer.askAuto') : t('composer.ask', { name: current.group === 'Claude' ? 'Claude' : current.label });
  setAssistantIdentity(current?.group);
}
window.assistant.onModelsUpdated?.(() => { loadModels(); catalog?.refreshOpen(); });
// "More models…" (OpenRouter): every model OpenRouter has, in the same picker (renderer/model-catalog.js), opened
// under the model button.
let catalog = null;
function openModelSearch(query = '') {
  catalog ||= window.lumenModelCatalog({
    mainSelect: $('model'), anchor: modelPicker.button, host: document.querySelector('.model-picker'),
    fetchModels: () => window.assistant.openRouterModels(), onBack: (q) => modelPicker.open(q || ''),
    onFail: (text) => append(Object.assign(document.createElement('div'), { className: 'notice', textContent: text })),
  });
  catalog.open(query);
}

// The "Switch back" / "Retry" buttons of fallback notices. Only the newest notice's is live: an older one would
// override the model answering now, or one the user picked since.
const fallbackButtons = new Set();
function retireFallbackButtons(except = null) {
  for (const b of fallbackButtons) if (b !== except || !b.isConnected) { b.remove(); fallbackButtons.delete(b); }
}

$('model').addEventListener('change', async (e) => {
  const select = e.target;
  if (select.value === 'openrouter:__more') {
    const s = await window.assistant.getSettings();
    select.value = s.model;
    select.pickerSync();
    openModelSearch();
    return;
  }
  retireFallbackButtons(); // a model picked by hand: an earlier notice's "Switch back" must not override it
  const switched = await window.assistant.setModel(select.value).catch(() => false);
  if (!switched) {
    // Not accepted (it disconnected a moment ago, say): show what main actually uses.
    await loadModels();
    return;
  }
  const label = select.selectedOptions[0].dataset.name || select.selectedOptions[0].textContent; // the readable name the picker shows
  select.title = select.selectedOptions[0].title;
  // From main's list, not the <optgroup>: a lone group is drawn without one (see loadModels).
  const group = modelGroups.get(select.value) ?? select.selectedOptions[0].parentElement?.label;
  prompt.placeholder = select.selectedOptions[0].dataset.auto ? t('composer.askAuto') : t('composer.ask', { name: group === 'Claude' ? 'Claude' : label });
  setAssistantIdentity(group);
  modelReady = true; // picking a model from the (visible) picker means one is already connected
  refreshSetup();
  // The conversation carries over: the next message goes to the new model with the full history.
  // Mid-reply, the reply in progress finishes on the old model first (main says 'next-message').
  if (switched === 'next-message') {
    append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('models.switchNext', { name: label }) }));
  } else if (messages.querySelector('.msg')) {
    append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('models.switched', { name: label }) }));
  }
  prompt.focus();
});
// The header's More menu (full page, dock, AI settings): opens under its button, closes on a pick, Escape or a click outside.
(() => {
  const btn = optional('more-actions');
  const menu = optional('more-menu');
  if (!btn || !menu) return;
  const items = () => [...menu.querySelectorAll('.menu-item')].filter((b) => getComputedStyle(b).display !== 'none');
  const close = (refocus) => { if (menu.hidden) return; menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); };
  const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); items()[0]?.focus(); };
  btn.addEventListener('click', () => (menu.hidden ? open() : close(true)));
  menu.addEventListener('click', (e) => { if (e.target.closest('.menu-item')) close(false); });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close(false); }, true);
  menu.addEventListener('focusout', (e) => { if (!menu.contains(e.relatedTarget) && e.relatedTarget !== btn) close(false); });
  for (const item of menu.querySelectorAll('.menu-item')) item.removeAttribute('title'); // the row already says it
  const full = optional('open-chat-page');
  if (full) full.dataset.shortcut = navigator.platform.startsWith('Mac') ? '⇧⌘L' : t('shortcut.ctrlShiftL');
})();
// ---------- chat ----------

const messages = $('messages');
const prompt = $('prompt');
const send = $('send');
let running = false;
// The chat this view shows, as main last said (a sync's view id, an event's chat id); null until known. `running` and `turn`
// are that chat's alone: an event or a queued message for another chat never touches them.
let shownChatId = null;
const forOtherChat = (id) => Boolean(id && shownChatId && id !== shownChatId);
let turn = null; // DOM state for the in-progress assistant reply
let runId = 0; // events from older runs (after Stop or New chat) are ignored

// Following the conversation: while the view sits at the bottom it stays there as replies stream in; scrolled up
// to read, it stays put and a "Jump to latest" button offers the way back.
let stuck = true;
const atBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
const jump = Object.assign(document.createElement('button'), { type: 'button', className: 'jump-latest', hidden: true });
jump.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg>';
jump.setAttribute('aria-label', t('chat.jumpLatest'));
jump.title = t('chat.jumpLatest');
let jumping = 0; // (a jump's own scroll events don't count as the user scrolling away)
const catchUp = () => { if (stuck && jumping) messages.scrollTop = messages.scrollHeight; };
// The user scrolling (wheel, touch, keys) during a jump takes over: the jump no longer holds the view.
for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) messages.addEventListener(type, (e) => { if (type === 'keydown' && e.target !== messages) return; if (jumping) { jumping = 0; messages.removeEventListener('scrollend', catchUp); } }, { passive: true });
jump.addEventListener('click', () => {
  stuck = true;
  jumping = Date.now();
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches && messages.scrollHeight - messages.scrollTop - messages.clientHeight < messages.clientHeight * 6;
  messages.scrollTo({ top: messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); // (a long way down: at once)
  if (!atBottom()) { // (the reply grew meanwhile: the end, once the smooth scroll stops)
    messages.removeEventListener('scrollend', catchUp);
    messages.addEventListener('scrollend', catchUp, { once: true });
  }
  jump.hidden = true;
});
messages.after(jump);
messages.addEventListener('scroll', () => {
  if (Date.now() - jumping < 700) { stuck = true; return; } // (a smooth jump's own scrolling)
  stuck = atBottom();
  jump.hidden = stuck || !messages.querySelector('.msg');
}, { passive: true });
function scrollToBottom(force = false) {
  if (force) stuck = true;
  if (stuck && (force || Date.now() - jumping >= 700)) messages.scrollTop = messages.scrollHeight; // (a smooth jump finishes first)
  jump.hidden = stuck || !messages.querySelector('.msg');
}

function append(el, { force = false } = {}) {
  $('empty').hidden = true;
  // Queued messages ("Sends when this reply finishes") stay at the very end, under the running reply.
  const firstQueued = el.classList?.contains('queued') ? null : messages.querySelector(':scope > .notice.queued');
  if (firstQueued) firstQueued.before(el);
  else messages.append(el);
  scrollToBottom(force);
  return el;
}

// "Working in: <site>": while a task runs, which tab it works in. The AI stays in the tab it started in
// when the user switches away, so this says where it is and jumps there. Only the sidebar has it.
let agentTarget = null; // { id, title, host, front } from main, or null
function renderWorkingIn() {
  const el = optional('working-in');
  const show = Boolean(running && agentTarget);
  el.hidden = !show;
  document.body.classList.toggle('agent-away', show && !agentTarget.front);
  const pill = $('agent-pill-text');
  if (pill && !document.body.classList.contains('mcp-active')) pill.textContent = show && !agentTarget.front ? t('agent.usingOther', { name: assistantIdentity?.name || 'AI' }) : t('agent.usingTab', { name: assistantIdentity?.name || 'AI' });
  if (!show) return;
  const name = agentTarget.title || agentTarget.host || t('agent.workingIn.untitled');
  el.replaceChildren(Object.assign(document.createElement('span'), { className: 'agent-dot' }), Object.assign(document.createElement('span'), { textContent: t('agent.workingIn', { name }) }));
  el.title = t('agent.workingIn.jump');
  el.setAttribute('aria-label', `${t('agent.workingIn', { name })}. ${t('agent.workingIn.jump')}`);
}
window.assistant.onAgentTarget?.((info) => { agentTarget = info || null; renderWorkingIn(); });
optional('working-in').onclick = () => window.assistant.showAgentTarget?.();

function setRunning(value) {
  running = value;
  if (!value) agentTarget = null;
  renderWorkingIn();
  document.body.classList.toggle('agent-active', value);
  chatHost.running?.(value); // the sidebar re-measures the page it frames (app.js)
  send.classList.toggle('stop', value);
  send.title = value ? t('composer.stop') : t('composer.send.title');
  send.setAttribute('aria-label', value ? t('composer.stop') : t('composer.send'));
  updateSend();
}

// "Send now" (Ctrl+Enter while a reply runs): shown only while one runs and something is typed.
const sendNowBtn = optional('send-now');
function updateSend() {
  const typed = Boolean(prompt.value.trim() || attachments.length);
  send.disabled = !running && !typed;
  sendNowBtn.hidden = !(running && typed);
}

// ---------- image attachments: paste, drop or pick images for the message ----------

const MAX_IMAGES = 5;
const MAX_EDGE = 1568; // larger images are downscaled by the API anyway; resizing first saves upload time
const MAX_BYTES = 3.5 * 1024 * 1024; // a PNG/JPEG/GIF/WebP under this and within MAX_EDGE goes as it is
const MAX_FILE_BYTES = 25 * 1024 * 1024; // a bigger file is refused before it is read
const MAX_SEND_CHARS = 6_500_000; // base64 characters of one image after conversion (main refuses 7 million)
const PASSTHROUGH = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_NAME = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|svg|ico|tiff?|heic|heif)$/i;
const HEIC_NAME = /\.(heic|heif)$/i;
let attachments = []; // { media_type, data (base64), url (data URL for previews), name }
let attachNoteTimer = null;

// Some systems give a dropped photo no MIME type: the name decides then.
const isImageFile = (f) => Boolean(f) && (String(f.type).startsWith('image/') || (!f.type && IMAGE_NAME.test(f.name || '')));
const isHeic = (f) => /^image\/hei[cf]/.test(f.type) || HEIC_NAME.test(f.name || '');
const imageLabel = (f) => f.name || t('chat.image');

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

// A reason an image could not be added (attachProblem says it in words).
const imageError = (code) => Object.assign(new Error(code), { code });

const PNG_PASS_BYTES = 1_000_000; // a PNG over this goes through the canvas (and becomes a JPEG when it has no transparency)
// Any pixel that is not fully opaque? (Read in rows, stopping at the first one.)
function hasAlpha(ctx, canvas) {
  try {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
    return false;
  } catch { return true; } // unreadable: keep it as PNG
}

// Canvas -> { media_type, data, url } within the size main accepts, or null. Pictures with transparency keep it
// as PNG; photos (and anything too big as PNG) become JPEG on white.
function encodeCanvas(canvas, wantPng) {
  let flat = null;
  const onWhite = () => {
    if (flat) return flat;
    flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const ctx = flat.getContext('2d');
    ctx.fillStyle = '#fff'; // (a JPEG has no transparent pixels: they would turn black)
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    return flat;
  };
  const attempts = wantPng ? [['image/png'], ['image/jpeg', 0.85], ['image/jpeg', 0.7]] : [['image/jpeg', 0.9], ['image/jpeg', 0.75], ['image/jpeg', 0.6]];
  for (const [type, quality] of attempts) {
    const out = (type === 'image/png' ? canvas : onWhite()).toDataURL(type, quality);
    const data = out.split(',')[1] || '';
    if (data && data.length <= MAX_SEND_CHARS) return { media_type: type, data, url: out };
  }
  return null;
}

async function toAttachment(file) {
  if (isHeic(file)) throw imageError('heic');
  if (!file.size) throw imageError('empty');
  if (file.size > MAX_FILE_BYTES) throw imageError('big');
  const url = await readAsDataUrl(file);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { throw imageError('unreadable'); }
  const w = img.naturalWidth || 1024; // (an SVG without a size)
  const h = img.naturalHeight || Math.round(w * 0.75);
  const edge = Math.max(w, h);
  const name = file.name || '';
  // A big opaque PNG (a screenshot: several MB) is re-encoded as a JPEG below: the model reads it as well and it uploads in a fraction of the time.
  const heavyPng = file.type === 'image/png' && file.size > PNG_PASS_BYTES;
  if (PASSTHROUGH.includes(file.type) && edge <= MAX_EDGE && file.size <= MAX_BYTES && !heavyPng) {
    return { media_type: file.type, data: url.split(',')[1], url, name };
  }
  let scale = Math.min(1, MAX_EDGE / edge);
  let wantPng = file.type !== 'image/jpeg' && file.type !== 'image/bmp'; // (a JPEG has no transparency to keep)
  for (let tries = 0; tries < 3; tries++, scale *= 0.7) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: heavyPng });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (heavyPng && wantPng && !hasAlpha(ctx, canvas)) wantPng = false;
    const encoded = encodeCanvas(canvas, wantPng);
    if (encoded) return { ...encoded, name };
  }
  throw imageError('big');
}

function attachProblem(file, code) {
  const key = { heic: 'composer.attach.heic', empty: 'composer.attach.empty', big: 'composer.attach.big', notImage: 'composer.attach.notImage' }[code] || 'composer.attach.unreadable';
  return t(key, { name: imageLabel(file), max: 25 });
}

// What happened to the last pick, under the thumbnails (and read out): an image that couldn't be added is
// always said, never skipped silently.
function showAttachNote(lines) {
  const el = $('attachment-note');
  if (!el) return;
  clearTimeout(attachNoteTimer);
  el.replaceChildren(...lines.map((line) => Object.assign(document.createElement('div'), { textContent: line })));
  el.hidden = lines.length === 0;
  if (lines.length) attachNoteTimer = setTimeout(() => showAttachNote([]), 12000);
}

// Adds the images among `files`; returns whether there was any to add. Says what it left out.
async function addImages(files, { announceOthers = true } = {}) {
  const list = [...files];
  const images = list.filter(isImageFile);
  const problems = [];
  if (announceOthers) for (const f of list.filter((x) => !isImageFile(x))) problems.push(attachProblem(f, 'notImage'));
  let over = 0;
  for (const file of images) {
    if (attachments.length >= MAX_IMAGES) { over++; continue; }
    try {
      attachments.push(await toAttachment(file));
    } catch (err) {
      problems.push(attachProblem(file, err?.code));
    }
  }
  if (over) problems.push(t('composer.attach.limit', { max: MAX_IMAGES, n: over }));
  renderAttachments();
  showAttachNote(problems);
  return images.length > 0;
}

function renderAttachments() {
  const strip = $('attachments');
  strip.replaceChildren();
  strip.hidden = attachments.length === 0;
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment';
    chip.setAttribute('role', 'listitem');
    if (a.name) chip.title = a.name;
    const img = document.createElement('img');
    img.src = a.url;
    img.alt = a.name ? t('composer.attachedNamed', { n: i + 1, name: a.name }) : t('composer.attachedImage', { n: i + 1 });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', t('composer.removeImage', { n: i + 1 }));
    remove.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>';
    remove.onclick = () => { attachments.splice(i, 1); renderAttachments(); showAttachNote([]); prompt.focus(); };
    chip.append(img, remove);
    strip.append(chip);
  });
  strip.setAttribute('role', 'list');
  strip.setAttribute('aria-label', t('composer.attachments'));
  const attachBtn = $('attach');
  if (attachBtn) {
    const full = attachments.length >= MAX_IMAGES;
    attachBtn.disabled = full;
    attachBtn.title = full ? t('composer.attach.full', { max: MAX_IMAGES }) : t('composer.attach.title', { max: MAX_IMAGES });
  }
  updateSend();
  document.dispatchEvent(new CustomEvent('lumen:attachments', { detail: { count: attachments.length } })); // (the background button can't carry images)
}

window.chatAttachments = { count: () => attachments.length, note: (lines) => showAttachNote(lines) }; // (renderer/tasks.js: a background task can't carry images)

// The attach button: a file picker (Tab to it, then Enter or Space).
{
  const attachBtn = $('attach');
  const picker = $('attach-input');
  if (attachBtn && picker) {
    attachBtn.onclick = () => picker.click();
    picker.addEventListener('change', async () => {
      const files = [...picker.files];
      picker.value = ''; // (the same file can be picked again)
      if (files.length) await addImages(files);
      prompt.focus();
    });
    renderAttachments(); // (the tooltip states the limit)
  }
}

prompt.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some(isImageFile)) {
    e.preventDefault(); // text paste stays untouched; only images are intercepted
    await addImages(files, { announceOthers: false });
  }
});
const sidebarEl = chatRoot;
// (Other files dropped here are left to the window, which opens them in a tab; a file with no type may be a photo.)
const dragHasImages = (dt) => [...(dt?.items || [])].some((i) => i.kind === 'file' && (i.type === '' || i.type.startsWith('image/')));
sidebarEl.addEventListener('dragover', (e) => {
  if (dragHasImages(e.dataTransfer)) {
    e.preventDefault();
    sidebarEl.classList.add('dropping');
  }
});
sidebarEl.addEventListener('dragleave', (e) => { if (!sidebarEl.contains(e.relatedTarget)) sidebarEl.classList.remove('dropping'); });
sidebarEl.addEventListener('drop', async (e) => {
  sidebarEl.classList.remove('dropping');
  if (![...e.dataTransfer.files].some(isImageFile)) return;
  e.preventDefault();
  await addImages(e.dataTransfer.files); // (a file that came with the images and is not one is named in the note)
  prompt.focus();
});

// Asks that arrive while a reply is running (Alt+Enter in the address bar, "Ask about selection",
// the new-tab page's Ask AI, a starter chip) wait their turn instead of disappearing.
const queued = [];
// Edit (back into the composer) and × (dropped) on a message waiting for the current reply to finish.
function queueControls(entry) {
  const drop = () => { const i = queued.indexOf(entry); if (i !== -1) queued.splice(i, 1); entry.notice.remove(); };
  const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'queue-btn', textContent: t('chat.queued.edit') });
  edit.onclick = () => {
    drop();
    prompt.value = prompt.value.trim() ? `${prompt.value.replace(/\s+$/, '')}\n${entry.text}` : entry.text; // (a draft is kept)
    if (entry.images?.length) { attachments = [...attachments, ...entry.images].slice(0, MAX_IMAGES); renderAttachments(); }
    autosize();
    updateSend();
    prompt.focus();
  };
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'queue-btn', textContent: '×', title: t('chat.queued.cancel') });
  cancel.setAttribute('aria-label', t('chat.queued.cancel'));
  cancel.onclick = drop;
  const now = Object.assign(document.createElement('button'), { type: 'button', className: 'queue-btn', textContent: t('chat.queued.sendNow'), title: t('composer.sendNow.title') });
  now.onclick = () => sendNow(entry);
  entry.notice.append(' ', now, edit, cancel);
}
// Send now: `entry` goes first in the line and the running reply is stopped through the Stop button's own path
// (agent:stop: a CLI engine is interrupted or its process tree ended, an API request aborted), so the reply's 'done'
// sends it as the next turn. What the reply had said stays on screen, marked interrupted, and in the history (agent.js).
function sendNow(entry) {
  const i = queued.indexOf(entry);
  if (i === -1) return;
  if (i > 0) { queued.splice(i, 1); queued.unshift(entry); }
  const first = messages.querySelector(':scope > .notice.queued');
  if (first && first !== entry.notice) first.before(entry.notice);
  if (!running) return; // (the reply ended meanwhile: the line moves on by itself)
  for (const b of entry.notice.querySelectorAll('.queue-btn')) b.disabled = true;
  if (turn) turn.interrupted = true;
  window.assistant.stop();
}
function sendQueued() {
  // Only what was typed in the chat shown now goes: a message queued in another chat belongs to that chat's run.
  const mine = queued.findIndex((q) => !forOtherChat(q.chatId));
  if (mine === -1) return;
  const next = queued.splice(mine, 1)[0];
  next.notice.remove();
  if (next.fresh) {
    // A question from the new-tab page that waited for the running reply: now start its new chat. The
    // New chat button empties the view (notices of anything else still queued included), so put those back.
    const rest = queued.splice(0);
    $('new-chat').click();
    for (const q of rest) { append(q.notice); queued.push(q); }
  }
  ask(next.text, next.images, next.tabs);
}

// Ask AI from the new-tab page: the question starts a new chat instead of joining the open one (the
// old one stays in the chat list). If a reply is still running it is not stopped: the question waits
// its turn like any queued message, then opens the new chat.
function askInNewChat(text) {
  if (running) {
    const notice = append(Object.assign(document.createElement('div'), { className: 'notice queued', textContent: t('chat.queued', { text: text.length > 60 ? `${text.slice(0, 59)}…` : text }) }));
    queued.push({ text, images: [], tabs: null, notice, fresh: true, chatId: shownChatId });
    return;
  }
  $('new-chat').click();
  ask(text);
}

// `tabs` (renderer/tabs-ask.js take()): the tabs picked with "@" — { ids, names, gone } — whose text goes along.
function ask(text, images = [], tabs = null) {
  if (running) {
    const notice = append(Object.assign(document.createElement('div'), { className: 'notice queued', textContent: t('chat.queued', { text: text.length > 60 ? `${text.slice(0, 59)}…` : text || t('chat.image') }) }));
    const entry = { text, images, tabs, notice, chatId: shownChatId };
    queued.push(entry);
    queueControls(entry);
    return entry; // (for Send now)
  }
  // Nothing connected: the question is kept (back in the box) and sent as soon as an AI is connected.
  if (!modelReady) {
    pendingAsk = { text, images, tabs, at: Date.now() };
    if (!prompt.value.trim() && text) { prompt.value = text; autosize(); updateSend(); }
    const pending = optional('setup-pending');
    pending.textContent = t('setup.pending');
    pending.hidden = false;
    optional('setup').classList.remove('attention');
    void optional('setup').offsetWidth; // (the highlight plays again on a second try)
    optional('setup').classList.add('attention');
    if (!messages.querySelector('.msg')) { refreshSetup(); return; }
    append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('chat.setupNeeded') }));
    return;
  }
  if (tabs?.gone?.length) append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('tabs.gone', { names: tabs.gone.join(', ') }) }));
  lastAsk = { text, images, tabs };
  startTurn(text, images, tabs);
  // Run ids stay unique across chats: a chat left running still sends events under its own id.
  runId = Math.max(runId + 1, Date.now());
  shownChatId = null; // (main may switch to this window's tab's chat as the message arrives: the first event names the chat)
  window.assistant.ask(text, runId, images.map(({ media_type, data }) => ({ media_type, data })), tabs?.ids?.length ? tabs.ids : undefined);
}

// Tools that change something (a click, typing, opening or closing tabs): running them again isn't harmless.
const ACTING_TOOLS = new Set(['click', 'click_at', 'type_text', 'press_key', 'fill_form', 'navigate', 'open_tab', 'close_tab', 'switch_tab', 'go_back', 'go_forward', 'reload', 'run_script', 'group_tabs', 'ungroup_tabs', 'hover', 'scroll']);
// The thinking block's summary once the answer starts: "Thought for 4s".
function settleThinking() {
  const box = turn?.thinking?.parentElement;
  if (!box || !turn.thinkingSince || box.dataset.settled) return;
  box.dataset.settled = '1';
  box.firstChild.textContent = t('chat.thoughtFor', { n: Math.max(1, Math.round((Date.now() - turn.thinkingSince) / 1000)) });
}
// Retry (after an error) and Regenerate (the latest reply): the last exchange is taken back in main and on screen,
// then asked again, as if it had never been sent.
let lastAsk = null;
async function askAgain() {
  if (running || !lastAsk) return false;
  const again = lastAsk;
  const result = await window.assistant.rewind?.(again.text);
  // 'absent': the message never reached the history (it failed first): nothing to take back there, so it is
  // simply asked again; anything else (a run going, no reply) changes nothing.
  if (result !== 'rewound' && result !== 'absent') return false;
  if (result === 'absent') { // only after a failure (Retry): a Regenerate that finds nothing to take back does nothing
    const us = messages.querySelectorAll('.msg.user');
    let failed = false;
    for (let n = us[us.length - 1]?.nextElementSibling; n; n = n.nextElementSibling) if (n.querySelector?.('.error, .notice.stopped') || n.classList.contains('error') || n.classList.contains('stopped') || n.classList.contains('reply-actions-only')) { failed = true; break; }
    if (!failed) {
      for (const b of messages.querySelectorAll('.reply-regen')) b.remove();
      append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('chat.nothingToRegenerate') }));
      return false;
    }
  }
  const users = messages.querySelectorAll('.msg.user');
  const from = users[users.length - 1];
  if (from) { while (from.nextSibling) from.nextSibling.remove(); from.remove(); }
  ask(again.text, again.images, again.tabs);
  return true;
}

// Edit (the latest message you sent, once its reply is done): the bubble becomes a text box in place, as in
// Claude.ai and ChatGPT. Nothing is taken back until Send; Cancel or Esc leaves everything as it was. The composer
// (and whatever is typed there) is untouched.
function editLast() {
  if (running || !lastAsk) return;
  const bubble = [...messages.querySelectorAll('.msg.user')].pop();
  if (!bubble || bubble.classList.contains('editing') || bubble.dataset.skill) return; // (a skill runs again with Regenerate)
  const again = lastAsk;
  const kept = [...bubble.childNodes];
  const box = Object.assign(document.createElement('textarea'), { className: 'msg-edit-box', value: again.text, rows: 1 });
  box.setAttribute('aria-label', t('chat.editMessage.title'));
  const fit = () => { box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 240)}px`; };
  const send = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: t('chat.editMessage.send') });
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('chat.editMessage.cancel') });
  const row = Object.assign(document.createElement('div'), { className: 'msg-edit-actions' });
  row.append(cancel, send);
  const actions = bubble.nextElementSibling?.classList.contains('msg-user-actions') ? bubble.nextElementSibling : null;
  const restore = () => {
    bubble.classList.remove('editing');
    bubble.replaceChildren(...kept);
    if (actions) actions.hidden = false;
    bubble.cancelEdit = null;
  };
  bubble.cancelEdit = restore;
  bubble.classList.add('editing');
  for (const n of kept) if (n.nodeType === Node.TEXT_NODE) n.remove();
  const tabsLine = bubble.querySelector(':scope > .msg-tabs');
  if (tabsLine) tabsLine.before(box, row); else bubble.append(box, row);
  if (actions) actions.hidden = true;
  fit();
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  box.addEventListener('input', () => { fit(); send.disabled = !box.value.trim() && !again.images?.length; });
  cancel.onclick = () => { restore(); (actions?.querySelector('button') || prompt).focus(); };
  send.onclick = async () => {
    const text = box.value.trim();
    if ((!text && !again.images?.length) || running) return;
    if (!modelReady) { restore(); append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('chat.setupNeeded') })); return; }
    send.disabled = true;
    const result = await window.assistant.rewind?.(again.text);
    if (result !== 'rewound' && result !== 'absent') {
      restore();
      append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('chat.editFailed') }));
      return;
    }
    while (bubble.nextSibling) bubble.nextSibling.remove();
    bubble.remove();
    ask(text, again.images || [], again.tabs);
    prompt.focus();
  };
  box.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.onclick(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.onclick(); }
  });
}
// The latest message you sent: Edit, in a row under the bubble (not inside it, so it's no part of its text).
function markEditable(bubble) {
  for (const b of messages.querySelectorAll('.msg-user-actions')) b.remove(); // only the latest message
  if (!bubble) return;
  const row = Object.assign(document.createElement('div'), { className: 'msg-user-actions' });
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'msg-edit', textContent: t('chat.editMessage') });
  b.title = t('chat.editMessage.title');
  b.onclick = () => editLast();
  row.append(b);
  bubble.after(row);
}
// What a user bubble asked (for Regenerate and Edit after a restore or a chat switch).
const bubbleAsks = new WeakMap();
function askOf(bubble) {
  return bubble ? bubbleAsks.get(bubble) || null : null;
}

// The user's bubble and the working line for a turn that is now running.
function startTurn(text, images, tabs = null) {
  const bubble = document.createElement('div');
  bubble.className = 'msg user';
  if (images.length) {
    const row = document.createElement('div');
    row.className = 'msg-images';
    for (const [i, a] of images.entries()) {
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = t('chat.imageN', { n: i + 1 });
      row.append(img);
    }
    bubble.append(row);
  }
  if (text) bubble.append(document.createTextNode(text));
  if (tabs?.ids?.length) window.tabsAsk?.describeSent(bubble, tabs.names || []); // "3 tabs attached: …"
  bubbleAsks.set(bubble, { text, images, tabs });
  for (const b of messages.querySelectorAll('.reply-regen, .reply-actions-only')) b.remove(); // only the latest reply can be regenerated
  for (const b of messages.querySelectorAll('.msg.user.editing')) b.cancelEdit?.(); // (an edit left open)
  append(bubble, { force: true }); // your own message always comes into view
  markEditable(bubble);
  beginTurn();
}

// The working line and turn state of a reply that is now running (its user bubble already shown).
function beginTurn() {
  const working = document.createElement('div');
  working.className = 'working';
  working.setAttribute('role', 'status');
  working.setAttribute('aria-label', t('chat.thinking'));
  turn = { text: null, textSource: '', thinking: null, working: append(working), steps: new Map() };
  setRunning(true);
}

// A chat opened while its reply is still running (it was left mid-run, features/chat-runs.js): the
// events that follow belong to it, and any approval card it waits on shows again.
function resumeLive(live) {
  if (!live || turn) return;
  const lastUser = [...messages.querySelectorAll('.msg.user')].pop();
  if (askOf(lastUser)) lastAsk = askOf(lastUser);
  // Waiting for a free slot (features/tab-chats.js): its message is not in the saved chat yet, so it is shown here.
  if (live.queued && live.queued.text && askOf(lastUser)?.text !== live.queued.text) { lastAsk = { text: live.queued.text, images: [], tabs: null }; startTurn(live.queued.text, []); } else beginTurn();
  if (live.queued?.status && turn.working) turn.working.dataset.status = live.queued.status;
  runId = live.runId;
  if (live.target) { agentTarget = live.target; renderWorkingIn(); } // "Working in: <site>" at once
  for (const a of live.approvals || []) showApproval(a.approvalId, a.host, { action: a.action, title: a.title, query: a.query, args: a.args, tainted: a.tainted });
  // What it has said since its last step, so a chat switched back to shows its words, not only a spinner.
  if (live.partial && !live.queued) { turn.text = appendToTurn(Object.assign(document.createElement('div'), { className: 'msg assistant streaming' })); turn.textSource = live.partial; renderStreaming(turn.text, live.partial); }
  moveWorkingToEnd();
  syncWorking();
}

// Keeps the working line last in the turn. Only moves it when something landed after it: re-appending
// a node that is already last still removes and re-inserts it, which restarts its CSS animation (a
// visible flicker on every streamed frame).
function moveWorkingToEnd() {
  const w = turn?.working;
  if (!w) return;
  const firstQueued = messages.querySelector(':scope > .notice.queued'); // (they stay under it)
  if (firstQueued) { if (w.nextElementSibling !== firstQueued) firstQueued.before(w); }
  else if (messages.lastElementChild !== w) messages.append(w);
}

// The working line shows while the AI works, not while it waits on the user's answer to an approval card.
function syncWorking() {
  turn?.working?.classList.toggle('waiting', approvals.size > 0);
}

// Adds a piece of the running reply above the working line, which stays last without ever moving.
function appendToTurn(el) {
  if (!turn?.working?.isConnected) return append(el);
  $('empty').hidden = true;
  turn.working.before(el);
  scrollToBottom();
  return el;
}

const TOOL_LABELS = {
  read_page: () => t('tool.read_page'),
  screenshot: () => t('tool.screenshot'),
  navigate: (i) => t('tool.navigate', { url: i.url }),
  click: () => t('tool.click'),
  type_text: (i) => t('tool.type_text', { text: i.text }),
  press_key: (i) => t('tool.press_key', { key: i.key }),
  scroll: (i) => t('tool.scroll', { direction: i.direction }),
  go_back: () => t('tool.go_back'),
  list_tabs: () => t('tool.list_tabs'),
  open_tab: (i) => t('tool.open_tab', { url: i.url }),
  switch_tab: (i) => t('tool.switch_tab', { tab: i.tab_id }),
  wait: (i) => t('tool.wait', { seconds: i.seconds }),
  web_search: (i) => t('tool.web_search', { query: i.query ?? '' }),
  find: (i) => t('tool.find', { query: i.query ?? '' }),
  batch: (i) => t('tool.batch', { count: i.steps?.length || t('tool.batch.several') }),
  fill_form: () => t('tool.fill_form'),
  click_at: () => t('tool.click_at'),
  hover: () => t('tool.hover'),
  go_forward: () => t('tool.go_forward'),
  reload: () => t('tool.reload'),
  close_tab: (i) => t('tool.close_tab', { tab: i.tab_id }),
  group_tabs: (i) => t('tool.group_tabs', { name: i.name ?? '' }),
  ungroup_tabs: () => t('tool.ungroup_tabs'),
  read_urls: () => t('tool.read_urls'),
  read_pdf: () => t('tool.read_pdf'),
  read_tabs: (i) => t(i.ids?.length === 1 ? 'tool.read_tabs.one' : 'tool.read_tabs.other', { count: i.ids?.length || 0 }),
  run_script: () => t('tool.run_script'),
  wait_for: (i) => t('tool.wait_for', { text: i.text ?? '' }),
};

// Rendering a long reply's whole markdown on every streamed chunk grew slower and slower (the work
// is quadratic in its length), so a streaming reply redraws at most once per frame, and a very long
// one every 120 ms.
// The bubble keeps its own source (el.source), so a draw that lands after the reply moved on to a
// tool step still shows every character of this bubble.
function renderStreaming(el, source) {
  el.source = source;
  if (el.renderPending) return;
  el.renderPending = true;
  const draw = () => {
    if (!el.renderPending) return; // flushStreaming already drew it
    el.renderPending = false;
    drawTail(el);
    moveWorkingToEnd();
    scrollToBottom();
  };
  // Performance mode (pref-lite on <html>) redraws every 100 ms however short the reply.
  if (document.documentElement.classList.contains('pref-lite')) setTimeout(draw, 100);
  else if (source.length - (el.stableLen || 0) > 12000) setTimeout(draw, 120);
  else requestAnimationFrame(draw);
}

// Finished blocks (everything up to the last blank line outside a code fence) are rendered once and
// left in the DOM; each frame replaces only the nodes after them and parses only the tail text.
function drawTail(el) {
  const source = el.source;
  const stable = window.markdownStableLength(source, el.stableMemo || (el.stableMemo = {})); // (resumes where the last frame stopped)
  const done = el.stableLen || 0;
  if (el.headNodes === undefined || stable < done) { el.innerHTML = ''; el.headNodes = 0; el.stableLen = 0; }
  while (el.childNodes.length > el.headNodes) el.lastChild.remove();
  if (stable > el.stableLen) {
    el.insertAdjacentHTML('beforeend', window.renderMarkdown(source.slice(el.stableLen, stable)));
    el.stableLen = stable;
    decorateCode(el, { colour: true }); // (finished blocks: coloured now, not when the reply ends)
    el.headNodes = el.childNodes.length;
  }
  const tail = settledMarkdown(source.slice(el.stableLen));
  if (tail) el.insertAdjacentHTML('beforeend', window.renderMarkdown(tail));
  decorateCode(el); // (a block's header is there while it streams: nothing moves when the reply ends)
}

// The bubble's final draw, at once and with nothing held back, before a copy button or label goes in.
function flushStreaming(el) {
  if (!el || el.source === undefined || el.flushed) return;
  el.renderPending = false;
  el.flushed = true;
  el.innerHTML = window.renderMarkdown(el.source);
  decorateCode(el);
}
// Each code block in a finished reply: its language, and a Copy button for just that code.
// `colour`: colour these blocks even while the reply streams (they're finished: the stable part of the reply).
function decorateCode(root, { colour = false } = {}) {
  window.genImages?.decorate(root); // ![](…) in a reply: data pictures drawn, web pictures offered
  for (const pre of root?.querySelectorAll?.('pre:not(.math-src):not(.code-ready)') || []) {
    pre.classList.add('code-ready');
    const box = Object.assign(document.createElement('div'), { className: 'code-block' });
    const head = Object.assign(document.createElement('div'), { className: 'code-head' });
    head.append(Object.assign(document.createElement('span'), { className: 'code-lang', textContent: pre.dataset.lang || t('chat.code') }));
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'code-copy', textContent: t('chat.copyCode') });
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent); b.textContent = t('chat.copied'); } catch { b.textContent = t('chat.copyFailed'); }
      setTimeout(() => { b.textContent = t('chat.copyCode'); }, 1400);
    });
    head.append(b);
    pre.replaceWith(box);
    box.append(head, pre);
    const code = pre.querySelector('code');
    if (code && window.highlightCode && (colour || !root.classList?.contains('streaming'))) window.highlightCode(code, pre.dataset.lang);
  }
  // A finished reply's blocks, decorated while they streamed, get their colours now.
  if (window.highlightCode && !root?.classList?.contains('streaming')) for (const code of root?.querySelectorAll?.('.code-block pre:not(.math-src) > code:not([data-hl])') || []) window.highlightCode(code, code.parentElement.dataset.lang);
}

function endStream() {
  flushStreaming(turn?.text);
  turn?.text?.classList.remove('streaming');
  if (turn?.text) decorateCode(turn.text); // its code blocks' colours, now that they are final
}

let earlyEnded = null; // { runId, bubble }: the run whose reply ended on reply_complete, until its 'done' (lateDone)
let aiTabsRunId = null; // the run whose "tabs the AI opened" row may still arrive after its 'done'
window.assistant.onEvent((event) => {
  // An approval card answered or cancelled from an older run (after Stop or New chat) still has to
  // clear, or the toolbar's "waiting for approval" badge stayed on.
  if (event.type === 'approval_done') { resolveApproval(event.approvalId, event.ok); return; }
  // [ai manners] Always: main closed the tabs the AI opened after the run (the turn is over by then): say so, with Undo.
  if (event.type === 'ai_tabs_closed') { if (!turn && event.runId === aiTabsRunId) window.showAiTabsClosed?.(append, event); return; }
  if (event.type === 'done' && earlyEnded && event.runId === earlyEnded.runId) { if (!forOtherChat(event.chatId)) lateDone(event); else earlyEnded = null; return; }
  if (!turn || event.runId !== runId || forOtherChat(event.chatId)) return;
  if (event.chatId && !shownChatId) shownChatId = event.chatId; // (a chat just started here: its first event names it)
  // A passing status on the working line ("Starting Claude Code…"): gone as soon as the reply shows anything.
  if (event.type === 'auto') { turn.auto = { label: event.label, reason: event.reason }; return; } // [auto model] which model Auto chose for this reply: its label and tooltip (labelReply)
  if (event.type === 'status') { if (turn.working) { if (event.text) turn.working.dataset.status = event.text; else delete turn.working.dataset.status; } return; }
  if (turn.working?.dataset.status && ['text', 'thinking', 'tool', 'approval', 'error', 'done'].includes(event.type)) delete turn.working.dataset.status;
  switch (event.type) {
    case 'turn_start':
    case 'text_block':
      settleThinking();
      endStream();
      turn.text = null; // next text starts a fresh block after any tool steps
      turn.textSource = '';
      turn.thinking = null;
      break;
    case 'thinking': {
      if (!turn.thinking) {
        const details = document.createElement('details');
        details.className = 'thinking';
        details.innerHTML = '<summary></summary><div></div>';
        details.firstChild.textContent = t('chat.thinking');
        turn.thinking = appendToTurn(details).querySelector('div');
        turn.thinkingSince = Date.now();
      }
      turn.thinking.textContent += event.text;
      moveWorkingToEnd();
      break;
    }
    case 'image': { // a picture the AI made (or a tool returned): main saved it; drawn here below what was said
      settleThinking();
      finishReply(turn.text, turn.textSource);
      turn.text = null; // words after the picture start a new block under it
      turn.textSource = '';
      const bubble = Object.assign(document.createElement('div'), { className: 'msg assistant gen-pics' });
      bubble.append(window.genImages.figure({ id: event.id, alt: event.alt || '', ...(event.credit ? { credit: event.credit } : {}), ...(event.caption ? { caption: event.caption } : {}) }));
      appendToTurn(bubble);
      turn.pics = bubble;
      announce(t('genimg.made'));
      break;
    }
    case 'text': {
      settleThinking();
      if (!turn.text) turn.text = appendToTurn(Object.assign(document.createElement('div'), { className: 'msg assistant streaming' }));
      turn.textSource += event.text;
      renderStreaming(turn.text, turn.textSource);
      break;
    }
    case 'retry':
      // The turn is being asked again (see agent.js loop): drop what it had streamed so far.
      turn.text?.remove();
      turn.thinking?.closest('details')?.remove();
      turn.text = null;
      turn.textSource = '';
      turn.thinking = null;
      break;
    case 'tool': {
      settleThinking(); // (it thought, then acted: "Thought for 3s", not "Thinking" for ever)
      finishReply(turn.text, turn.textSource);
      const label = event.label || (TOOL_LABELS[event.name] || (() => event.name))(event.input || {});
      const step = document.createElement('div');
      step.className = event.id ? 'step running' : 'step done';
      if (ACTING_TOOLS.has(event.name)) step.dataset.acts = '1'; // it changes something on a page (Regenerate asks first)
      if (event.id) turn.steps.set(event.id, step);
      step.innerHTML = '<span class="step-detail"></span>';
      step.firstChild.textContent = label;
      step.title = label;
      appendToTurn(step);
      endStream();
      turn.text = null;
      turn.textSource = '';
      break;
    }
    case 'tool_update': { // a step shown early (its input still streaming) gets its real label
      const step = turn.steps.get(event.id);
      if (!step) break;
      const label = event.label || (TOOL_LABELS[event.name] || (() => event.name))(event.input || {});
      step.firstChild.textContent = label;
      step.title = label;
      if (ACTING_TOOLS.has(event.name)) step.dataset.acts = '1';
      break;
    }
    case 'tool_done': {
      const step = turn.steps.get(event.id);
      if (!step) break;
      step.className = event.ok ? 'step done' : event.stopped ? 'step stopped' : 'step failed';
      if (!event.ok && event.error) {
        const lines = String(event.error).split('\n').map((l) => l.trim()).filter(Boolean);
        const reason = lines.find((l) => /failed/i.test(l) && !/^\d+ of \d+ fields failed:?$/i.test(l)) || lines[0] || '';
        const why = document.createElement('span');
        why.className = 'step-error';
        why.textContent = reason;
        why.title = lines.join('\n');
        step.append(why);
      }
      break;
    }
    case 'tabs_attached': // main read the picked tabs: what actually went along (a sleeping tab only by address)
      window.tabsAsk?.describeSent([...messages.querySelectorAll('.msg.user')].pop(), event.tabs || [], { final: true });
      break;
    case 'approval':
      chatHost.needSidebar?.(); // a hidden sidebar left the task waiting with only a badge as a hint (app.js opens it)
      announce(event.title || t('chat.approvalWaiting'));
      showApproval(event.approvalId, event.host, { action: event.action, title: event.title, query: event.query, args: event.args, tainted: event.tainted, noAlways: event.noAlways });
      moveWorkingToEnd();
      syncWorking();
      break;
    case 'notice': {
      if (event.stopped) turn.stopped = true;
      const notice = appendToTurn(Object.assign(document.createElement('div'), { className: event.stopped ? 'notice stopped' : 'notice', textContent: event.stopped ? t(turn.interrupted ? 'chat.interrupted' : 'chat.stopped') : event.text }));
      if (event.fallback) retireFallbackButtons(); // an older "Switch back" would undo whatever is answering now
      if (event.fallback) loadModels(); // [model fallback] the picker follows the model that is answering now (or the pick, once it is back)
      if (event.fallback && event.fallback.kind !== 'back' && event.fallback.from !== event.fallback.to) {
        // One quiet way back: picks the original model again (this also ends its cooldown, see settings:set-model); the next message tries it.
        const name = event.fallback.fromName || event.fallback.from;
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'notice-action', textContent: t(event.fallback.kind === 'unreachable' ? 'chat.fallbackRetry' : 'chat.fallbackBack', { name }) });
        fallbackButtons.add(button);
        button.onclick = async () => {
          button.disabled = true;
          retireFallbackButtons(button); // the others are for switches that are over
          const ok = await window.assistant.setModel(event.fallback.from).catch(() => false);
          await loadModels();
          if (ok) button.replaceWith(Object.assign(document.createElement('span'), { textContent: t('chat.fallbackBackDone', { name }) }));
          else button.remove();
        };
        notice.append(' ', button);
      }
      if (event.action === 'continue') {
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('chat.continue') });
        button.onclick = () => { button.remove(); ask(t('chat.continuePrompt')); };
        notice.append(' ', button);
      }
      break;
    }
    case 'error': {
      const errorEl = Object.assign(document.createElement('div'), { className: 'error', textContent: event.text });
      errorEl.setAttribute('role', 'alert');
      if (event.details) { // the plain line first, the engine's own words behind a toggle
        const more = Object.assign(document.createElement('details'), { className: 'error-details' });
        more.append(Object.assign(document.createElement('summary'), { textContent: t('chat.errorDetails') }), Object.assign(document.createElement('pre'), { textContent: event.details }));
        errorEl.append(more);
      }
      const error = appendToTurn(errorEl);
      turn.failed = true;
      if (event.action === 'settings') {
        const button = Object.assign(document.createElement('button'), { className: 'btn', textContent: t('chat.setupAi') });
        button.onclick = openAiSettings;
        error.append(button);
      } else if (lastAsk) {
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('chat.retry') });
        button.onclick = async () => { button.disabled = true; if (!(await askAgain())) button.disabled = false; };
        error.append(button);
      }
      break;
    }
    case 'reply_complete': // the engine's reply is whole; its 'done' (cost, undo, label) follows a moment later
      finishTurn(event, { early: true });
      break;
    case 'done':
      finishTurn(event, { early: false });
      break;
  }
});

// The end of the running reply's view: the text finished, the working line gone, the composer free, the next queued
// message sent. `early`: a Claude Code reply whose text is complete while its process still sends its last line
// (reply_complete); the run's own 'done' then only adds what it carries (late 'done' in onEvent).
function finishTurn(event, { early }) {
  settleThinking();
  finishReply(turn.text, turn.textSource, { latest: true });
  // A reply that ended on a step or a notice (stopped, or its last act was a tool) can be asked again too.
  if (!turn.failed && !turn.text?.querySelector?.('.reply-regen') && lastAsk && !turn.text?.source?.trim()) {
    const row = Object.assign(document.createElement('div'), { className: 'msg assistant reply-actions-only' });
    row.append(regenButton());
    turn.working.before(row);
  }
  if (!turn.failed) announce(turn.stopped || [...turn.steps.values()].some((s) => s.classList.contains('running') || s.classList.contains('stopped')) ? t('chat.replyStopped') : t('chat.replyDone'));
  labelReply(turn.text, event.model, event.auto || turn.auto);
  scrollToBottom(); // (the reply's copy button and label were added below its end)
  endStream();
  for (const step of turn.steps.values()) if (step.classList.contains('running')) step.className = 'step stopped';
  turn.working.remove();
  if (early) earlyEnded = { runId: event.runId, bubble: turn.text };
  else {
    if (event.undo) window.showRunUndo?.(append, event.undo); // [ai controls] extras.js
    aiTabsRunId = event.runId;
    if (event.aiTabs && event.aiTabs.mode !== 'close') window.showAiTabs?.(append, event.aiTabs, event.runId); // [ai manners] extras.js
  }
  turn = null;
  setRunning(false);
  setTimeout(sendQueued);
}

// The 'done' of a run whose reply ended early (reply_complete): the model label, Undo and the opened-tabs row. A message sent
// in between has its own turn on screen by now: the label still goes on the earlier reply, but its Undo / tabs row is left out
// (it would land under the new message), as the chat history keeps what the run did.
function lateDone(event) {
  const { bubble } = earlyEnded;
  earlyEnded = null;
  labelReply(bubble, event.model, event.auto);
  if (turn) return;
  if (event.undo) window.showRunUndo?.(append, event.undo);
  aiTabsRunId = event.runId;
  if (event.aiTabs && event.aiTabs.mode !== 'close') window.showAiTabs?.(append, event.aiTabs, event.runId);
}

// While a reply streams, hold back a trailing link that hasn't finished arriving
// ("[text](https://…" with no closing parenthesis yet), so raw markdown never flashes.
function settledMarkdown(source) {
  // A formula still being written ($…, $$…, \(…, \[…, \begin{…}) waits until it closes, instead of flashing its LaTeX.
  const openAt = window.markdownOpenMath?.(source) ?? -1;
  if (openAt !== -1) return settledMarkdown(source.slice(0, openAt));
  const open = source.lastIndexOf('[');
  if (open === -1) return source;
  const tail = source.slice(open);
  if (/^\[[^\]\n]*$/.test(tail) || /^\[[^\]\n]*\]\([^)\s]*$/.test(tail)) return source.slice(0, open);
  return source;
}

// Which model wrote a reply: a quiet label, since a chat can move between models.
function labelReply(bubble, modelId, auto = null) {
  flushStreaming(bubble);
  if (!bubble || !modelId || bubble.querySelector('.reply-model')) return;
  const option = [...$('model').options].find((o) => o.value === modelId);
  // From main's list, not the <optgroup>: a lone group is drawn without one (see loadModels).
  const group = modelGroups.get(modelId) ?? option?.parentElement?.label;
  // Local engines (Claude Code, Grok Build) already name themselves.
  const name = !option ? modelId
    : group === 'Claude' ? `Claude ${option.textContent}`
    : !group || /^Your .* account$/.test(group) ? option.textContent
    : `${group} · ${option.textContent}`;
  // [auto model] A reply Auto chose the model for says so ("Auto · Claude Haiku 4.5"), and why in its tooltip.
  const span = Object.assign(document.createElement('span'), { className: 'reply-model', textContent: auto ? t('models.auto.reply', { name }) : name });
  if (auto?.reason) { span.title = auto.reason; span.dataset.auto = '1'; }
  bubble.append(span);
}

// Screen readers: the messages list itself is quiet (streamed text would be read out piece by piece), so the
// moments that matter are said once here: a reply finished, or the task waits on an approval.
const liveNote = Object.assign(document.createElement('div'), { className: 'sr-only' });
liveNote.setAttribute('role', 'status');
liveNote.setAttribute('aria-live', 'polite');
liveNote.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
document.body.append(liveNote);
function announce(text) {
  liveNote.textContent = '';
  setTimeout(() => { liveNote.textContent = text; }, 50); // (a repeat of the same words is still read)
}

// ---------- copy a reply ----------

const COPY_ICON = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5"/></svg>';
const REGEN_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>';

// Regenerate: asks the latest message again. A turn that acted on pages (clicks, typing) would do so again:
// the first click says so, the second runs it.
function regenButton() {
  const regen = Object.assign(document.createElement('button'), { type: 'button', className: 'reply-regen', title: t('chat.regenerate') });
  regen.setAttribute('aria-label', t('chat.regenerate'));
  regen.innerHTML = REGEN_ICON;
  // A turn that acted on pages (clicks, typing) would do so again: the first click says so, the second runs it.
  regen.onclick = () => {
    const users = messages.querySelectorAll('.msg.user');
    let acted = false;
    for (let n = users[users.length - 1]?.nextElementSibling; n; n = n.nextElementSibling) if (n.dataset?.acts) { acted = true; break; }
    if (acted && !regen.dataset.armed) {
      regen.dataset.armed = '1';
      regen.classList.add('armed');
      regen.title = t('chat.regenerateActs');
      regen.dataset.confirm = t('chat.regenerateActs'); // shown beside it (not only on hover)
      regen.setAttribute('aria-label', t('chat.regenerateActs'));
      setTimeout(() => { delete regen.dataset.armed; regen.classList.remove('armed'); regen.title = t('chat.regenerate'); regen.setAttribute('aria-label', t('chat.regenerate')); }, 4000);
      return;
    }
    askAgain();
  };
  return regen;
}

function finishReply(bubble, source, { latest = false } = {}) {
  flushStreaming(bubble);
  const pictureOnly = Boolean(bubble) && !source?.trim() && Boolean(bubble.querySelector('.gen-img'));
  if (!bubble || (!pictureOnly && (!source || !source.trim())) || bubble.querySelector('.reply-copy, .reply-regen')) return;
  // The latest reply can be asked for again (a different answer to the same message).
  if (latest && lastAsk) bubble.append(regenButton());
  if (pictureOnly) return; // (nothing to copy as text: the picture has Save and Copy)
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reply-copy';
  button.title = t('chat.copy');
  button.setAttribute('aria-label', t('chat.copy'));
  button.innerHTML = COPY_ICON;
  button.onclick = async () => {
    try {
      const html = window.renderMarkdown(source);
      const text = source.trim(); // the markdown as written (lists, code, formulas as their LaTeX), as ChatGPT and Claude copy it
      if (window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      button.innerHTML = CHECK_ICON;
      button.classList.add('copied');
      setTimeout(() => { button.innerHTML = COPY_ICON; button.classList.remove('copied'); }, 1400);
    } catch {
      button.title = t('chat.copyFailed');
    }
  };
  bubble.append(button);
}

// ---------- auto-allow actions: the sidebar's AI acts on any site without asking ----------

let autoAllow = false;
function renderAutoAllow() {
  const button = $('auto-allow');
  button.setAttribute('aria-pressed', String(autoAllow));
  button.title = autoAllow
    ? t('sidebar.autoAllow.on')
    : t('sidebar.autoAllow.off');
}
async function setAutoAllow(on) {
  autoAllow = Boolean(await window.assistant.autoAllow?.(on));
  renderAutoAllow();
}
// Turning on "act on any site without asking" takes a second click within 4 s (turning it off takes one).
let autoArmed = 0;
$('auto-allow').onclick = () => {
  const btn = $('auto-allow');
  if (autoAllow) { setAutoAllow(false); return; }
  if (!autoArmed) {
    btn.classList.add('armed');
    btn.title = t('sidebar.autoAllow.confirm');
    btn.dataset.confirm = t('sidebar.autoAllow.confirm');
    autoArmed = setTimeout(() => { autoArmed = 0; btn.classList.remove('armed'); renderAutoAllow(); }, 4000);
    return;
  }
  clearTimeout(autoArmed);
  autoArmed = 0;
  btn.classList.remove('armed');
  setAutoAllow(true);
};
window.assistant.autoAllow?.().then((on) => { autoAllow = Boolean(on); renderAutoAllow(); });

// ---------- inline approval before Claude acts on a new site ----------

const approvals = new Map(); // approvalId -> { card, host }

// `action: 'open'`: the AI has read page content in this chat and wants to open a new site (which
// could carry that content there), or search for `query`; `action: 'script'`: it wants to run a
// script on a site after reading page content; anything else is the usual "interact with this site" card.
function showApproval(approvalId, host, { action, title: openTitle, query, args, tainted, noAlways } = {}) {
  if (action === 'tool') return showToolApproval(approvalId, host, { title: openTitle, args, tainted });
  if (action === 'signin') return showSignInApproval(approvalId, host, { noAlways }); // [signed-in sites]
  // Grok Build asking to run a real terminal command (grok-build.js's PreToolUse gate): same card as
  // an MCP tool's, but "always" only lasts this chat (not a persisted Settings toggle), so its own copy.
  if (action === 'terminal') return showToolApproval(approvalId, host, { title: openTitle, args, terminal: true });
  const card = document.createElement('div');
  card.className = 'approval';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  const agentName = assistantIdentity?.name || t('approval.theAi');
  const opening = action === 'open';
  const scripting = action === 'script';
  const pdf = action === 'pdf';
  const heading = pdf ? openTitle || t('approval.pdf', { name: agentName, file: host }) : opening
    ? openTitle || (host ? t('approval.open', { name: agentName, host }) : t('approval.openNew', { name: agentName }))
    : scripting ? openTitle || t('approval.script', { name: agentName, host })
      : t('approval.interact', { name: agentName, host });
  card.setAttribute('aria-label', heading);

  const title = document.createElement('p');
  title.className = 'approval-title';
  title.textContent = heading;
  const detail = document.createElement('p');
  detail.className = 'approval-detail';
  detail.textContent = query !== undefined
    ? t('approval.detail.search', { query, host })
    : pdf ? t('approval.detail.pdf')
    : opening ? t('approval.detail.open')
      : scripting ? t('approval.detail.script')
        : t('approval.detail.interact');

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const deny = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('approval.deny') });
  const allow = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: t('approval.allow') });
  const answer = (ok) => {
    if (card.classList.contains('answered')) return;
    card.classList.add('answered');
    deny.disabled = true;
    allow.disabled = true;
    window.assistant.approve?.(approvalId, ok);
  };
  // Always allow: this one, and turns on auto-allow for every site (the bolt in the sidebar head).
  const always = Object.assign(document.createElement('button'), { type: 'button', className: 'btn approval-always', textContent: t('approval.allSites') });
  always.title = t('approval.always.title');
  deny.onclick = () => answer(false);
  allow.onclick = () => answer(true);
  // Every site, from now on: a second click confirms (the first says what it means, in the button itself).
  let alwaysArmed = false;
  always.onclick = () => {
    if (!alwaysArmed) { alwaysArmed = true; always.textContent = t('approval.allSites.confirm'); always.classList.add('armed'); return; }
    always.disabled = true; setAutoAllow(true); answer(true);
  };
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === card) { e.preventDefault(); answer(true); }
    else if (e.key === 'Escape') { e.preventDefault(); answer(false); }
  });

  actions.append(deny, always, allow);
  card.append(title, detail, actions);
  append(card, { force: true }); // waiting for you: always in view
  approvals.set(approvalId, { card, host });
  // Never focused for the user: Enter on the card means Allow, and a card that grabbed focus while
  // someone was typing a follow-up turned their Enter into an approval. Keyboard users Tab to it.
  scrollToBottom();
}

// A tool from an MCP server the user added (agent.js allowExternal): the card shows exactly what
// would be sent. "Always allow" is per tool and isn't offered once the chat has read page content.
function showToolApproval(approvalId, host, { title: heading, args, tainted, terminal = false }) {
  const card = document.createElement('div');
  card.className = terminal ? 'approval approval-tool approval-terminal' : 'approval approval-tool';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', heading || t('approval.tool.use', { host }));
  const title = Object.assign(document.createElement('p'), { className: 'approval-title', textContent: heading || t('approval.tool.use', { host }) });
  const detail = Object.assign(document.createElement('p'), {
    className: 'approval-detail',
    textContent: terminal
      ? t('approval.tool.terminal')
      : tainted
        ? t('approval.tool.tainted')
        : t('approval.tool.details'),
  });
  const pre = Object.assign(document.createElement('pre'), { className: 'approval-args', textContent: args || '{}' });
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const deny = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('approval.deny') });
  const allow = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: t('approval.once') });
  const always = tainted && !terminal ? null : Object.assign(document.createElement('button'), { type: 'button', className: 'btn approval-always', textContent: terminal ? t('approval.terminal.always') : t('approval.tool.always'), title: terminal ? t('approval.terminal.always.title') : t('approval.tool.always.title') });
  const answer = (ok) => {
    if (card.classList.contains('answered')) return;
    card.classList.add('answered');
    for (const b of [deny, allow, always]) if (b) b.disabled = true;
    window.assistant.approve?.(approvalId, ok);
  };
  deny.onclick = () => answer(false);
  allow.onclick = () => answer(true);
  if (always) always.onclick = () => answer('always');
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === card) { e.preventDefault(); answer(true); }
    else if (e.key === 'Escape') { e.preventDefault(); answer(false); }
  });
  actions.append(...[deny, always, allow].filter(Boolean));
  card.append(title, detail, pre, actions);
  append(card, { force: true }); // waiting for you: always in view
  approvals.set(approvalId, { card, host, tool: true });
  scrollToBottom();
}

// [signed-in sites] read_urls as_user (features/signed-in-sites.js): may the AI read `host` with the
// user's own signed-in session? No is the default (Enter and Escape both mean No); "Always" is left off
// for banks, payments, password managers and account-security pages.
function showSignInApproval(approvalId, host, { noAlways = false } = {}) {
  const card = document.createElement('div');
  card.className = 'approval approval-signin';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  const agentName = assistantIdentity?.name || t('approval.theAi');
  const heading = t('approval.signin', { name: agentName, host });
  card.setAttribute('aria-label', heading);
  const title = Object.assign(document.createElement('p'), { className: 'approval-title', textContent: heading });
  const detail = Object.assign(document.createElement('p'), { className: 'approval-detail', textContent: t(noAlways ? 'approval.detail.signinSensitive' : 'approval.detail.signin') });
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const button = (text, cls) => Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: text });
  const deny = button(t('approval.signin.no'), 'btn primary');
  const once = button(t('approval.signin.once'), 'btn');
  const always = noAlways ? null : button(t('approval.signin.always', { host }), 'btn approval-always');
  const answer = (ok) => {
    if (card.classList.contains('answered')) return;
    card.classList.add('answered');
    for (const b of [deny, once, always]) if (b) b.disabled = true;
    window.assistant.approve?.(approvalId, ok);
  };
  deny.onclick = () => answer(false);
  once.onclick = () => answer(true);
  if (always) always.onclick = () => answer('always');
  card.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' && e.target === card) || e.key === 'Escape') { e.preventDefault(); answer(false); }
  });
  actions.append(...[always, once, deny].filter(Boolean));
  card.append(title, detail, actions);
  append(card, { force: true }); // waiting for you: always in view
  approvals.set(approvalId, { card, host, signin: true });
  scrollToBottom();
}

function resolveApproval(approvalId, ok) {
  const entry = approvals.get(approvalId);
  if (!entry) return;
  approvals.delete(approvalId);
  const { card, host, tool, signin } = entry;
  card.className = ok ? 'approval resolved' : 'approval resolved denied';
  card.removeAttribute('tabindex');
  card.removeAttribute('role');
  card.removeAttribute('aria-label');
  card.textContent = signin ? t(ok === 'always' ? 'approval.signin.allowedAlways' : ok ? 'approval.signin.allowedOnce' : 'approval.signin.denied', { host }) // [signed-in sites]
    : tool ? (ok ? t('approval.allowedTool', { host }) : t('approval.deniedTool', { host })) : ok ? t('approval.allowed', { host }) : t('approval.denied', { host });
  syncWorking();
  if (document.activeElement === document.body) prompt.focus();
}

// ---------- chat restored from the last session ----------

// Also used by renderer/chats.js to show a chat picked from the history list.
function showHistory(items) {
  if (!Array.isArray(items) || !items.length || messages.querySelector('.msg')) return;
  for (const item of items) {
    const bubble = document.createElement('div');
    if (item.role === 'user') {
      bubble.className = 'msg user';
      const images = (item.images || []).filter((src) => typeof src === 'string' && src.startsWith('data:image/'));
      if (images.length) {
        const row = document.createElement('div');
        row.className = 'msg-images';
        images.forEach((src, i) => row.append(Object.assign(document.createElement('img'), { src, alt: t('chat.imageN', { n: i + 1 }) })));
        bubble.append(row);
      }
      if (item.text) bubble.append(document.createTextNode(item.text));
      bubbleAsks.set(bubble, { text: item.text || '', images: images.map((src) => { const [, media_type, data] = src.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/) || []; return { media_type, data, url: src }; }).filter((a) => a.data), tabs: null });
    } else if (item.role === 'assistant' && (item.text || item.generated?.length)) {
      if (!item.text) { // only pictures
        bubble.className = 'msg assistant gen-pics restored';
        for (const pic of item.generated) bubble.append(window.genImages.figure(pic));
        append(bubble);
        continue;
      }
      if (item.steps) {
        const summary = document.createElement('div');
        summary.className = 'step done restored';
        summary.innerHTML = '<span class="step-detail"></span>';
        summary.firstChild.textContent = t(item.steps === 1 ? 'chat.usedActions.one' : 'chat.usedActions.other', { count: item.steps });
        append(summary);
      }
      bubble.className = 'msg assistant';
      bubble.innerHTML = window.renderMarkdown(item.text);
      decorateCode(bubble);
      finishReply(bubble, item.text);
      if (item.generated?.length) { // the words, then the pictures under them
        bubble.classList.add('restored');
        append(bubble);
        const pics = Object.assign(document.createElement('div'), { className: 'msg assistant gen-pics restored' });
        for (const pic of item.generated) pics.append(window.genImages.figure(pic));
        append(pics);
        continue;
      }
    } else {
      continue;
    }
    bubble.classList.add('restored');
    append(bubble);
  }
  // Its last exchange can be asked again: the last message, with its images.
  const lastIndex = items.length - 1;
  let u = lastIndex - 1;
  while (u >= 0 && items[u].role !== 'user') u--;
  const lastUser = u >= 0 ? items[u] : null;
  // (A reply of only pictures is its own bubble; with words, the words' bubble is the reply and the pictures sit under it.)
  const lastReply = items[lastIndex]?.role === 'assistant' && !items[lastIndex].text
    ? [...messages.querySelectorAll('.msg.assistant.gen-pics.restored')].pop()
    : [...messages.querySelectorAll('.msg.assistant.restored:not(.gen-pics)')].pop();
  if (lastUser && (lastUser.text || lastUser.images?.length) && lastReply && items[lastIndex]?.role === 'assistant') {
    const imgs = (lastUser.images || []).filter((src) => typeof src === 'string' && /^data:image\/[a-z+.-]+;base64,/.test(src)).map((src) => {
      const [, media_type, data] = src.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/);
      return { media_type, data, url: src };
    });
    lastAsk = { text: lastUser.text || '', images: imgs, tabs: null };
    if (items[lastIndex].acted) { const step = document.createElement('div'); step.className = 'step done restored'; step.dataset.acts = '1'; step.hidden = true; lastReply.before(step); }
    lastReply.querySelector('.reply-copy')?.remove();
    finishReply(lastReply, items[items.length - 1].text, { latest: true });
    markEditable([...messages.querySelectorAll('.msg.user')].pop());
  } else if (items[lastIndex]?.role === 'user' && (items[lastIndex].text || items[lastIndex].images?.length)) {
    // It ends on your message: its reply stopped before saying anything. Regenerate and Edit still work.
    const lastBubble = [...messages.querySelectorAll('.msg.user')].pop();
    lastAsk = askOf(lastBubble);
    if (lastAsk) {
      markEditable(lastBubble);
      const row = Object.assign(document.createElement('div'), { className: 'msg assistant reply-actions-only restored' });
      row.append(regenButton());
      append(row);
    }
  }
  messages.scrollTop = messages.scrollHeight;
}
window.assistant.onHistory?.(({ items } = {}) => showHistory(items));

// A turn that started in the other view (the sidebar or the chat page) shows here too: the same
// events follow, tagged with its run id.
window.assistant.onRunStart?.(({ text, runId: id, images, chatId: chat } = {}) => {
  if (running || forOtherChat(chat)) return; // (a turn of a chat this view has moved off is not this chat's running state)
  if (chat && !shownChatId) shownChatId = chat;
  const shown = (images || []).map((a) => ({ ...a, url: `data:${a.media_type};base64,${a.data}` }));
  lastAsk = { text: String(text || ''), images: shown, tabs: null }; // started in the other view: this is the chat's last message now
  startTurn(String(text || ''), shown);
  runId = id;
});
// The other view opened another chat, started a new one, or deleted this one.
function applySync(view) {
  clearChatView();
  shownChatId = view?.id || null; // running/turn start over from this chat's own run (view.live), never the previous chat's
  showHistory(view?.items);
  resumeLive(view?.live);
  window.chatList?.refreshUsage(view?.usage || '');
  chatHost.chatChanged?.();
}
window.assistant.onSync?.(({ view } = {}) => applySync(view));
// Asks main which chat this window's front tab shows and what its run is doing, and takes it when it is not what is shown
// here (a tab switch can reach this view late or not at all while another chat's tool is acting). `settled` is false when it
// changed the view.
async function reconcile() {
  let answer = null;
  try { answer = await window.assistant.resync?.(); } catch {}
  const view = answer?.view;
  if (!view || !view.id) return true;
  const live = Boolean(view.live);
  if (view.id === shownChatId && live === running) return true;
  if (!shownChatId && live === running) { shownChatId = view.id; return true; } // (a chat not named yet: now it is)
  applySync(view);
  return false;
}

// Links in replies open in a new tab.
messages.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link) return;
  e.preventDefault();
  if (window.assistant.openLink) window.assistant.openLink(link.href); // the chat page has no browser bridge
  else window.browser.newTab(link.href);
});

new ResizeObserver(() => {
  chatRoot.style.setProperty('--composer-h', `${$('composer').offsetHeight}px`);
}).observe($('composer'));

function autosize() {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`;
}
// Claude Code's process starts while the user types (main: agent.prewarm, a no-op for any other engine); at most every 20 s.
let prewarmAt = 0;
// The composer's text so far is passed along (the model guess routes it); the main side backs off after failures.
// The words typed re-route a guessed warm-up at a first phrase (12 characters) and again at a sentence (40), and
// when the box loses focus with text in it; main keeps the process unless they route to another model.
let prewarmStage = 0;
const prewarm = (force = false) => {
  const length = prompt.value.trim().length;
  const stage = length >= 40 ? 2 : length >= 12 ? 1 : 0;
  const reroute = stage > prewarmStage;
  if (running || (!force && !reroute && Date.now() - prewarmAt < 20000)) return;
  if (force && prompt.value === prewarmSent) return; // (blur with nothing new typed: nothing to re-route)
  prewarmAt = Date.now();
  prewarmStage = Math.max(prewarmStage, stage);
  prewarmSent = prompt.value;
  try { window.assistant?.prewarm?.(prompt.value); } catch {}
};
let prewarmSent = '';
prompt.addEventListener('blur', () => { if (prompt.value.trim()) prewarm(true); else prewarmStage = 0; });
prompt.addEventListener('focus', () => { prewarm(); if (running) reconcile(); }); // (a Stop button that belongs to another chat goes as soon as the box is used)
prompt.addEventListener('input', () => { prewarm(); autosize(); updateSend(); });
prompt.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // Japanese, Chinese, Korean input: Enter confirms the text, not the message
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // While a reply runs, Enter sends what was typed after it (queued); it never stops the reply (the button does).
    // Ctrl+Enter (Cmd+Enter on a Mac) is Send now: the reply stops and this message goes next.
    if (running) {
      if (!(prompt.value.trim() || attachments.length)) return;
      const now = e.ctrlKey || e.metaKey;
      // The running state shown may be another chat's (a tab switch that did not reach this view): main's view of this tab's chat decides.
      reconcile().then((settled) => { if (running) sendComposer({ now }); else if (!settled || prompt.value.trim() || attachments.length) $('composer').requestSubmit(); });
      return;
    }
    $('composer').requestSubmit();
  } else if (e.key === 'Escape' && running && !prompt.value) {
    e.preventDefault();
    e.stopPropagation(); // (and doesn't also leave the full-page chat)
    window.assistant.stop(); // Esc in an empty composer stops the reply
  }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (running) { window.assistant.stop(); return; } // the button, while running, is Stop
  sendComposer();
});
sendNowBtn.onclick = () => { sendComposer({ now: true }); prompt.focus(); };
async function sendComposer({ now = false } = {}) {
  const text = prompt.value.trim();
  if (!text && attachments.length === 0) return;
  const images = attachments;
  attachments = [];
  renderAttachments();
  showAttachNote([]);
  prompt.value = '';
  autosize();
  const tabs = window.tabsAsk ? await window.tabsAsk.take() : null; // the "@" chips, resolved against the tabs open now
  if (running) { const entry = ask(text, images, tabs); if (now && entry) sendNow(entry); } // (queued for after the reply, or Send now)
  else if (!(await askOnNewTopic(text, images, tabs))) ask(text, images, tabs);
  updateSend();
}

// A typed message with nothing in common with the open chat (renderer/chat-topic.js) starts a new
// chat, as the New chat button would; the last one stays in the chat list. The notice it leaves has
// a way back: the message moves to the last chat and is asked there. The sidebar only (it has the
// chat list), and never for images or "@" tabs, which are hard to judge by their words.
async function askOnNewTopic(text, images, tabs) {
  if (running || images.length || tabs?.ids?.length || !text || !window.chatTopic || !window.chatList?.openChat) return false;
  if (!messages.querySelector('.msg.assistant:not(.streaming)')) return false;
  const said = [...messages.querySelectorAll('.msg.user, .msg.assistant')].map((el) => el.textContent);
  if (!window.chatTopic.isNewTopic(text, said)) return false;
  const previous = await window.assistant.chats?.list().then((r) => r.current).catch(() => null);
  if (!previous || running) return false;
  $('new-chat').click();
  const notice = append(Object.assign(document.createElement('div'), { className: 'notice topic-split' }));
  const back = Object.assign(document.createElement('button'), { type: 'button', className: 'notice-action', textContent: t('chat.newTopic.back') });
  notice.append(Object.assign(document.createElement('span'), { textContent: t('chat.newTopic') }), ' ', back);
  back.onclick = async () => {
    back.disabled = true;
    if (running) window.assistant.stop();
    // The chat just started for it goes (it holds only this message), then the last one opens.
    const current = await window.assistant.chats.list().then((r) => r.current).catch(() => null);
    if (current && current !== previous) await window.assistant.chats.remove(current).catch(() => {});
    if (await window.chatList.openChat(previous)) ask(text);
    else back.disabled = false;
  };
  ask(text);
  return true;
}

document.querySelectorAll('.chip').forEach((chip) => {
  // A starter that works on all open tabs sends them along (after the once-per-chat confirm when there are many).
  chip.onclick = () => (chip.dataset.allTabs && window.tabsAsk ? window.tabsAsk.askAll(chip.dataset.prompt) : ask(chip.dataset.prompt));
});

// Empties the sidebar for a new chat or another one from the history list (renderer/chats.js).
function clearChatView() {
  runId++;
  shownChatId = null; // (whoever opens a chat names it next; until then its first event does)
  lastAsk = null; // another chat: its last message isn't known here
  for (const id of [...approvals.keys()]) resolveApproval(id, false); // clears the toolbar badge too
  approvals.clear();
  const unsent = queued.splice(0);
  for (const q of unsent) q.notice.remove();
  // Messages still waiting for the other chat's reply aren't lost: they come back to the box, to send here or not.
  if (unsent.some((q) => q.text || q.images?.length)) {
    const texts = unsent.map((q) => q.text).filter(Boolean);
    if (texts.length) prompt.value = [prompt.value.replace(/\s+$/, ''), ...texts].filter(Boolean).join('\n');
    const images = unsent.flatMap((q) => q.images || []);
    if (images.length) { attachments = [...attachments, ...images].slice(0, MAX_IMAGES); renderAttachments(); }
    autosize();
    updateSend();
  }
  messages.querySelectorAll(':scope > :not(#empty)').forEach((el) => el.remove());
  window.tabsAsk?.reset(); // "@" chips and the once-per-chat "all tabs" confirm start over
  $('empty').hidden = false;
  turn = null;
  setRunning(false);
}
$('new-chat').onclick = () => {
  window.assistant.reset();
  clearChatView();
  window.chatList?.refreshUsage('');
  prompt.focus();
};

// Called once by the page's script after it has set its chatHost hooks.
function startChat() {
  refreshSetup();
  loadModels();
}
