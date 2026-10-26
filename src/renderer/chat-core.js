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
  optional('setup-antigravity').hidden = !window.assistant.useAntigravity || !agy.installed; // (not installed: the note below says how, like Codex and Grok Build)
  optional('setup-antigravity-detail').textContent = !agy.installed ? t('setup.antigravity.install') : agy.signedIn === false ? t('setup.antigravity.signedOut') : t('setup.antigravity.detail');
  // Codex (OpenAI's CLI): offered once it is found on this computer; the click turns it on in the sidebar.
  const cx = s.codex || {};
  optional('setup-codex').hidden = !cx.installed || !window.assistant.useCodex;
  optional('setup-codex-detail').textContent = cx.signedIn === false ? t('setup.codex.signedOut') : t('setup.codex.detail');
  // Nothing found on this computer: the options that need no install lead (styles.css .setup.cold); a note says how to bring a coding agent.
  $('setup').classList.toggle('cold', !s.claudeCode && !grok.installed && !agy.installed && !cx.installed);
  optional('setup-more').hidden = Boolean(grok.installed && agy.installed && cx.installed);
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
optional('setup-more-link').onclick = () => window.lumenPrefs?.openSettingsPage('antigravity'); // (Settings → AI and agents → Agents: where each one's install command and Download are)
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
    setup: true, // the toolbar button reads "Set up AI" (app.js identity) until a model is connected
    tint: 'var(--accent)',
    svg: '<svg viewBox="0 0 16 16" class="mark"><path d="M6.8 2.2l1.2 3.6 3.6 1.2-3.6 1.2-1.2 3.6-1.2-3.6L2 7l3.6-1.2z"/><path d="M12.5 10.2v4.2M10.4 12.3h4.2"/></svg>',
  },
  // Auto across providers is connected but nobody's name: the same neutral mark, and no "Set up AI".
  Auto: {
    name: 'Lumen',
    tint: 'var(--accent)',
    svg: '<svg viewBox="0 0 16 16" class="mark"><path d="M6.8 2.2l1.2 3.6 3.6 1.2-3.6 1.2-1.2 3.6-1.2-3.6L2 7l3.6-1.2z"/><path d="M12.5 10.2v4.2M10.4 12.3h4.2"/></svg>',
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
  // "Ask anything, or give <name> a task": the connected assistant's name; with Auto (or nothing known) it is Lumen, not "AI" or one provider.
  const emptyName = who === ASSISTANTS.AI || who === ASSISTANTS.Auto ? 'Lumen' : who.name;
  if (empty) empty.textContent = chatHost.emptyText ? chatHost.emptyText(emptyName) : t('sidebar.empty', { name: emptyName });
  const pill = $('agent-pill-text');
  if (pill && !document.body.classList.contains('mcp-active')) setPillText('agent.usingTab', 'agent.usingShort', who.name);
}

// The toolbar's "<AI> is using this tab" pill: the full words (also the pill's tooltip and, clipped in a narrow window, its
// accessible name) and the short label a compact toolbar shows instead (app.js fitToolbarPills).
function setPillText(key, shortKey, name) {
  const pill = $('agent-pill-text');
  if (!pill) return;
  pill.textContent = t(key, { name });
  const short = $('agent-pill-short');
  if (short) short.textContent = t(shortKey, { name });
  const box = $('agent-pill');
  if (box) box.title = pill.textContent;
}

// "Search every OpenRouter model": offered at the end of the list whenever OpenRouter is connected.
// The chat's own reasoning effort ('' = Auto), kept by main with the chat (settings:set-effort). The model menu shows it as an "Effort"
// row with the levels the picked model takes (main lists them per model: data-efforts), and as a quiet suffix on the button.
let chatEffort = '';
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// The open chat changed (another chat, a new one): the picker shows that chat's own effort. (undefined: no word on it, left as it is.)
function followChatEffort(level) {
  if (typeof level !== 'string' || level === chatEffort) return;
  chatEffort = level;
  $('model').pickerSync?.();
}
window.followChatEffort = followChatEffort;
const effortLevels = () => (($('model').selectedOptions[0]?.dataset.efforts) || '').split(',').filter(Boolean);
const modelPicker = window.lumenPicker($('model'), {
  recentKey: 'model',
  effort: {
    levels: effortLevels,
    // A level the picked model doesn't take shows (and is sent) as the nearest one it does, as main resolves it (ai/effort.js pick).
    value: () => {
      const levels = effortLevels();
      if (!chatEffort || !levels.length || levels.includes(chatEffort)) return chatEffort;
      const at = EFFORT_ORDER.indexOf(chatEffort);
      return levels.reduce((best, l) => (Math.abs(EFFORT_ORDER.indexOf(l) - at) < Math.abs(EFFORT_ORDER.indexOf(best) - at) ? l : best), levels[0]);
    },
    set: (level) => { chatEffort = level; window.assistant.setEffort?.(level)?.catch?.(() => {}); },
  },
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
  chatEffort = s.effort || '';
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
    if (m.lastUsed) option.dataset.lastUsed = m.lastUsed; // Auto's last choice, shown as "last used: …" (never as Auto's name)
    if (m.efforts?.length) option.dataset.efforts = m.efforts.join(','); // the levels this model takes (ai/effort.js offered)
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
  setAssistantIdentity(current?.auto && !current.autoScope ? 'Auto' : current?.group); // Auto across providers is nobody's name: the neutral mark (not "Set up AI": something is connected), not the provider it last used
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
  setAssistantIdentity(select.selectedOptions[0].dataset.auto && !group ? 'Auto' : group);
  modelReady = true; // picking a model from the (visible) picker means one is already connected
  refreshSetup();
  // The conversation carries over: the next message goes to the new model with the full history.
  // Mid-reply, the reply in progress finishes on the old model first (main says 'next-message').
  if (switched === 'next-message') {
    append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('models.switchNext', { name: label }) }));
  } else if (messages.querySelector('.msg')) {
    append(Object.assign(document.createElement('div'), { className: 'notice model-switch', textContent: t('models.switched', { name: label }) })); // (the chat page draws it as a divider)
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
  const mission = optional('mission-btn'); // lumen://tasks
  if (mission) mission.dataset.shortcut = navigator.platform.startsWith('Mac') ? '⇧⌘X' : t('shortcut.ctrlShiftX');
})();
// ---------- chat ----------

const messages = $('messages');
// [step labels] The step cards' code (step-labels.js, step-ui.js, step-ui.css) is not part of the start-up bundle: it loads the first time a message is sent or a
// chat with cards is drawn (the chat page lists it itself). A step that arrives before it has loaded gets a plain row.
let stepUILoad = null;
function loadStepUI() {
  if (window.stepUI) { window.stepUI.init(messages); return Promise.resolve(); } // click / Enter on a step opens its details
  if (stepUILoad) return stepUILoad;
  const head = document.head;
  head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'step-ui.css' }));
  const script = (src) => new Promise((resolve) => { head.append(Object.assign(document.createElement('script'), { src, onload: resolve, onerror: resolve })); });
  stepUILoad = script('step-labels.js').then(() => script('step-ui.js')).then(() => window.stepUI?.init(messages));
  return stepUILoad;
}
if (window.stepUI) window.stepUI.init(messages);
function plainStep(event, label) {
  const step = document.createElement('div');
  step.className = event.id ? 'step running' : 'step done';
  step.innerHTML = '<span class="step-detail"></span>';
  step.firstChild.textContent = label;
  step.title = label;
  if (event.id) { step.dataset.t0 = String(Date.now()); step.append(Object.assign(document.createElement('span'), { className: 'step-time' })); }
  appendToTurn(step);
  return step;
}
const prompt = $('prompt');
const send = $('send');
let running = false;
// Messages typed while a reply runs wait in a line (renderer/chat-queue.js); each shows as a bubble of its own under the reply.
// A copy of it is kept in localStorage (renderer/chat-queue.js createStore) while it holds anything: a reload of the UI, a crash or a restart
// must not forget a waiting message. What a gone view left comes back when its chat is shown again (restoreCarried).
const queueStore = (() => { try { return window.chatQueue.createStore(window.localStorage, document.body.classList.contains('chat-page') ? { key: `${window.chatQueue.STORE_KEY}.page` } : {}); } catch { return null; } })();
let queueBeat = 0;
function mirrorLine(list) {
  queueStore?.save(tempChatShown() ? [] : list); // (a temporary chat is never kept, nor what waits in it)
  if (list.length && !queueBeat) queueBeat = setInterval(() => { if (!line.length) { clearInterval(queueBeat); queueBeat = 0; return; } mirrorLine(line.list); }, window.chatQueue.BEAT_MS);
  else if (!list.length && queueBeat) { clearInterval(queueBeat); queueBeat = 0; }
}
const line = window.chatQueue.create(mirrorLine);
// This view going away on purpose (a reload, the window closing): what waits is carried at once, not after the beat has gone stale.
window.addEventListener('pagehide', () => { if (line.length && !tempChatShown()) queueStore?.save(line.list, 0); });
const queued = line.list;
const QUEUED = ':scope > .queued'; // (the waiting bubbles, and the bar over them)
let queueBar = null;
let incomingChatId = null; // while applySync redraws: the chat it draws (what waits in that chat's line stays)
// The chat this view shows, as main last said (a sync's view id, an event's chat id); null until known. `running` and `turn`
// are that chat's alone: an event or a queued message for another chat never touches them.
let shownChatId = null;
const forOtherChat = (id) => Boolean(id && shownChatId && id !== shownChatId);
// ---------- drafts: each chat keeps its own unsent text ----------
// What is typed (and the long pasted blocks waiting as chips) is saved per chat on every change (renderer/chat-drafts.js, localStorage), put
// away when another chat opens and back when this one does, also after a restart. 'draftHold' keeps the box from saving while it is empty
// between two chats (or before startChat).
// The sidebar and the full-page chat are one origin's localStorage: each has its own entry, or one saving its (older, or empty) composer on a sync
// overwrote what the other had typed for the same chat, and the next sync put that back in the box.
const drafts = (() => { try { return window.chatDrafts.create(window.localStorage, Date.now, document.body.classList.contains('chat-page') ? `${window.chatDrafts.KEY}.page` : window.chatDrafts.KEY); } catch { return null; } })();
let pastes = []; // long pasted blocks shown as chips and sent with the message (strings)
let draftHold = true;
let emptyOwner; // the id (null: not named yet) of the last empty chat whose box held text when it was left; undefined: none (see applySync)
let shownTemporary = false; // main said the chat shown here is a temporary one (applySync); the chat page also knows it (chatPageTools)
const tempChatShown = () => shownTemporary || Boolean(window.chatPageTools?.isTemporary?.());
// A temporary chat is never saved, so neither is what is typed in it: no draft is written for it, and one already stored under its id goes.
const saveDraft = () => {
  if (draftHold) return;
  if (tempChatShown()) { if (shownChatId) drafts?.clear(shownChatId); return; }
  drafts?.set(shownChatId, { text: prompt.value, pastes });
};
// Saved on every change (updateSend), and again when the box loses focus or the page goes away.
prompt.addEventListener('blur', () => saveDraft());
window.addEventListener('pagehide', () => saveDraft());
window.addEventListener('beforeunload', () => saveDraft());
// ---------- what else a chat keeps while another is shown (this window, in memory) ----------
// Besides the unsent text: the pictures and files waiting in the box, the "@" tab chips, how far the conversation was scrolled and which step
// cards and rows were open. They are put away when another chat takes the view and given back when this one is shown again, so a tab switch
// (or a chat opened from the list) leaves each chat as it was and one chat's pictures never go along into another. Not kept across a restart.
const viewStash = new Map(); // chat id ('new': not named yet) -> { attachments, chips, fromBottom, open }
const STASH_MAX = 60;
let pendingView = null; // { fromBottom, open } of the chat just shown, applied as soon as it is drawn
const stashKey = (id) => (id ? String(id) : 'new');
const foldables = () => [...messages.querySelectorAll('details, .step[data-more]')].reverse(); // (counted from the end: older parts drawn later don't shift them)
function stashView(id) {
  const kept = { attachments: attachments.slice(), chips: window.tabsAsk?.snapshot?.() || null };
  if (!lazyItems && !pendingView && messages.clientHeight > 0 && messages.querySelector('.msg')) { // (a chat not drawn yet, or the view hidden, has no position to keep)
    const fromBottom = Math.round(messages.scrollHeight - messages.scrollTop - messages.clientHeight);
    if (fromBottom > 48) kept.fromBottom = fromBottom;
    const open = [];
    foldables().forEach((el, i) => { if (el.tagName === 'DETAILS' ? el.open : el.getAttribute('aria-expanded') === 'true') open.push(i); });
    if (open.length) kept.open = open;
  }
  if (!kept.attachments.length && !kept.chips && kept.fromBottom === undefined && !kept.open) return;
  const key = stashKey(id);
  viewStash.delete(key);
  viewStash.set(key, kept);
  while (viewStash.size > STASH_MAX) viewStash.delete(viewStash.keys().next().value);
}
function stashRename(from, to) {
  const k = stashKey(from);
  const v = viewStash.get(k);
  if (!v || !to) return;
  viewStash.delete(k);
  if (!viewStash.has(stashKey(to))) viewStash.set(stashKey(to), v);
}
// Gives the chat now shown what it had: pictures and chips at once, the scroll and open cards once it is drawn (applyView).
function takeStash() {
  const key = stashKey(shownChatId);
  const kept = viewStash.get(key);
  if (!kept) return;
  viewStash.delete(key);
  if (kept.attachments?.length) attachments = [...kept.attachments, ...attachments].slice(0, MAX_ATTACH);
  if (kept.chips) window.tabsAsk?.restore?.(kept.chips);
  if (kept.fromBottom !== undefined || kept.open) pendingView = { fromBottom: kept.fromBottom || 0, open: kept.open || null };
}
// True when nothing is left to do. A position deeper than what is drawn yet waits for the older parts (drawEarlier calls this after each).
// The cards of a chat still running are built as its events replay, a moment after the chat is shown: each is opened when it appears.
let pendingOpen = null; // { idx: [counted from the end], until }
function reopenCards() {
  const p = pendingOpen;
  if (!p) return;
  if (Date.now() > p.until || !p.idx.length) { pendingOpen = null; return; }
  const all = foldables();
  p.idx = p.idx.filter((i) => {
    const el = all[i];
    if (!el) return true;
    if (el.tagName === 'DETAILS') el.open = true;
    else if (el.getAttribute('aria-expanded') !== 'true') el.click();
    return false;
  });
}
new MutationObserver(() => { if (pendingOpen) reopenCards(); }).observe(messages, { childList: true, subtree: true });
function applyView() {
  const p = pendingView;
  if (!p) return true;
  if (viewHidden() || !messages.clientHeight) return false; // (shown later: the composer's resize asks again)
  if (p.open) { pendingOpen = { idx: p.open, until: Date.now() + 4000 }; p.open = null; reopenCards(); }
  if (p.fromBottom > 0) {
    const want = messages.scrollHeight - messages.clientHeight - p.fromBottom;
    if (want < 0) { messages.scrollTop = 0; return false; }
    stuck = false;
    messages.scrollTop = want;
    jump.hidden = false;
  }
  pendingView = null;
  return true;
}
function restoreDraft() {
  draftHold = false;
  if (tempChatShown() && shownChatId) drafts?.clear(shownChatId);
  const d = tempChatShown() ? null : drafts?.get(shownChatId);
  if (d) {
    const carried = prompt.value.trim(); // (queued messages that came back to the box)
    prompt.value = [d.text.replace(/\s+$/, ''), carried].filter(Boolean).join('\n');
    pastes = d.pastes.slice();
  }
  takeStash();
  autosize();
  renderAttachments();
  renderScreenBtn();
  restoreCarried(); // (the chat is named and its box is open again: what a gone view left waiting in it)
  if (pendingView && !lazyItems) applyView();
}
// The chat just started here got its id: a draft typed meanwhile moves to it.
function nameChat(id) {
  if (!id || shownChatId) return;
  drafts?.rename(null, id);
  stashRename(null, id);
  shownChatId = id;
  line.claim(id); // (what was typed before the chat had a name is its own)
  // The chat this view comes back to (start-up, a reload) is named here too: an empty box shows the draft it was left with.
  if (!prompt.value && !pastes.length) restoreDraft();
  restoreCarried();
}
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
// The running pill: while the reply's live card is scrolled out of the chat, a small bar over the chat's edge says what the AI is doing (the card's own
// status line), for how long, and has Stop; a click on it brings the card back into view. It shows only for the chat in view, and only while the card works.
const runPill = (() => {
  const pill = Object.assign(document.createElement('div'), { className: 'run-pill', hidden: true });
  pill.setAttribute('role', 'group');
  pill.setAttribute('aria-label', t('runpill.label'));
  const main = Object.assign(document.createElement('button'), { type: 'button', className: 'run-pill-main', title: t('runpill.show') });
  const icon = Object.assign(document.createElement('span'), { className: 'run-pill-ico' });
  icon.setAttribute('aria-hidden', 'true');
  const text = Object.assign(document.createElement('span'), { className: 'run-pill-text' });
  const time = Object.assign(document.createElement('span'), { className: 'run-pill-time' });
  main.append(icon, text, time);
  const stop = Object.assign(document.createElement('button'), { type: 'button', className: 'run-pill-stop', textContent: t('composer.stop.short'), title: t('composer.stop') });
  pill.append(main, stop);
  messages.after(pill);
  let card = null; // the card being watched (renderer/step-ui.js)
  let side = null; // 'top' | 'bottom' | null (hidden)
  let io = null;
  let mo = null;
  let tickTimer = 0;
  const working = () => ['working', 'approval'].includes(card?.el.dataset.state);
  function paint() {
    if (!card) return;
    if (icon.dataset.k !== card.icon.dataset.k) { icon.dataset.k = card.icon.dataset.k || ''; icon.innerHTML = card.icon.innerHTML; }
    const label = card.statusText.textContent || card.title.textContent || '';
    if (text.textContent !== label) { text.textContent = label; main.setAttribute('aria-label', label + '. ' + t('runpill.show')); }
    const s = turn?.startedAt ? Math.max(0, Math.floor((Date.now() - turn.startedAt) / 1000)) : 0;
    const secs = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); // (m:ss, from the first second)
    if (time.textContent !== secs) time.textContent = secs;
  }
  function tick() { tickTimer = 0; if (side) { paint(); tickTimer = setTimeout(tick, 1000); } }
  function show(next) {
    if (next === side) return;
    side = next;
    pill.hidden = !next;
    if (!next) { clearTimeout(tickTimer); tickTimer = 0; return; }
    pill.dataset.side = next;
    pill.style.top = next === 'top' ? (messages.offsetTop + 8) + 'px' : '';
    paint();
    if (!tickTimer) tickTimer = setTimeout(tick, 1000);
  }
  function watch(next) {
    if (next === card) return;
    io?.disconnect();
    mo?.disconnect();
    io = mo = null;
    card = next;
    show(null);
    if (!card || typeof IntersectionObserver !== 'function') return;
    io = new IntersectionObserver((list) => {
      const e = list[list.length - 1];
      if (!e || !card || e.target !== card.el) return;
      const r = e.boundingClientRect;
      show(e.isIntersecting || !e.rootBounds || (!r.width && !r.height) || !working() ? null : window.chatQueue.pillSide(r, e.rootBounds));
    }, { root: messages });
    io.observe(card.el);
    mo = new MutationObserver(() => { if (!working()) show(null); else if (side) paint(); });
    mo.observe(card.statusText, { childList: true, characterData: true, subtree: true });
  }
  main.onclick = () => { if (card) card.el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('pref-reduce-motion') ? 'auto' : 'smooth' }); };
  stop.onclick = () => stopReply();
  return { sync() { watch(running && turn?.cards?.length ? turn.cards[turn.cards.length - 1] : null); } };
})();
for (const type of ['wheel', 'touchstart', 'pointerdown']) messages.addEventListener(type, () => { pendingView = null; pendingOpen = null; }, { passive: true }); // (the reader took over: the position kept is no longer wanted)
messages.addEventListener('scroll', () => {
  if (Date.now() - jumping < 700) { stuck = true; return; } // (a smooth jump's own scrolling)
  stuck = atBottom();
  jump.hidden = stuck || !messages.querySelector('.msg');
}, { passive: true });
let lazyItems = null; // a chat handed over while the sidebar was hidden, drawn when it is shown (applySync)
let historyTarget = null; // while an older slice is built: where append() puts what it makes (a fragment, put above the chat in one go)
let typedAt = -1e9; // when a key was last pressed in this window: the older part of a chat is not drawn under someone's typing
document.addEventListener('keydown', () => { typedAt = performance.now(); }, { capture: true, passive: true });
let historyDrawing = 0; // the chat being drawn newest first; a new chat (clearChatView) ends the one before
let restoring = false; // showHistory is adding a whole chat: one scroll at its end, not a layout per message (that was O(n^2) on a long chat)
function scrollToBottom(force = false) {
  if (restoring) return;
  if (force) stuck = true;
  if (stuck && (force || Date.now() - jumping >= 700)) messages.scrollTop = messages.scrollHeight; // (a smooth jump finishes first)
  jump.hidden = stuck || !messages.querySelector('.msg');
}

function append(el, { force = false } = {}) {
  if (historyTarget) { historyTarget.append(el); return el; } // (an older slice of a chat being drawn: see drawEarlier)
  flushLazyHistory(); // (a chat synced while the sidebar was closed is drawn before anything is added to it)
  $('empty').hidden = true;
  // Queued messages ("Sends when this reply finishes") stay at the very end, under the running reply.
  const firstQueued = el.classList?.contains('queued') ? null : messages.querySelector(QUEUED);
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
  const state = window.agentPill.pillState({ running, target: agentTarget });
  document.body.classList.toggle('agent-away', state.away); // (the toolbar pill and the page's frame are only for the tab the AI is in; styles.css)
  if (!document.body.classList.contains('mcp-active')) setPillText(state.textKey, state.shortKey, assistantIdentity?.name || 'AI');
  if (!show) return;
  const name = agentTarget.title || agentTarget.host || t('agent.workingIn.untitled');
  el.replaceChildren(Object.assign(document.createElement('span'), { className: 'agent-dot' }), Object.assign(document.createElement('span'), { textContent: t('agent.workingIn', { name }) }));
  el.title = t('agent.workingIn.jump');
  el.setAttribute('aria-label', `${t('agent.workingIn', { name })}. ${t('agent.workingIn.jump')}`);
}
window.assistant.onAgentTarget?.((info) => { agentTarget = info || null; renderWorkingIn(); });
optional('working-in').onclick = () => window.assistant.showAgentTarget?.();

let runStateSeq = 0; // counts every change of what this view shows as running (setRunning) or as the chat (applySync): reconcile() drops an answer older than that
function setRunning(value) {
  if (running !== value) runStateSeq++;
  running = value;
  if (!value) agentTarget = null;
  renderWorkingIn();
  runPill.sync();
  document.body.classList.toggle('agent-active', value);
  chatHost.running?.(value); // the sidebar re-measures the page it frames (app.js)
  for (const x of messages.querySelectorAll('.msg-screen-x')) x.disabled = value; // (main never edits a chat mid-run)
  send.classList.toggle('stop', value);
  send.dataset.label = value ? t('composer.stop.short') : ''; // a word beside the square: "Stop"
  send.title = value ? t('composer.stop') : t('composer.send.title');
  send.setAttribute('aria-label', value ? t('composer.stop') : t('composer.send'));
  updateSend();
}

// "Send now" (Ctrl+Enter while a reply runs): shown only while one runs and something is typed.
const sendNowBtn = optional('send-now');
function updateSend() {
  const typed = Boolean(prompt.value.trim() || attachments.length || pastes.length);
  send.disabled = !running && !typed;
  sendNowBtn.hidden = !(running && typed);
  saveDraft();
}

// ---------- screen context: "what is this?" sends a screenshot of the tab ----------
// The words decide (ai/screen-intent.js, run on each keystroke; main decides again from the same words and the chat so far), and the
// camera button shows what will happen: lit softly when the words ask for it, solid when switched on, crossed when switched off.
// A click toggles what is shown now, for the next message only. Whether the tab may be shared (AI off for its site, Lumen's own
// pages) is main's call; when the button asked and it can't be, a notice says why.
const screenBtn = optional('screen-btn');
let screenMode = null; // 'on' | 'off' | null: the user's choice for the next message
function recentTurns() {
  return [...messages.querySelectorAll(':scope > .msg.user, :scope > .msg.assistant')].slice(-4).map((el) => ({ role: el.classList.contains('user') ? 'user' : 'assistant', text: (el.textContent || '').slice(0, 600) }));
}
function screenWanted() {
  try { return Boolean(window.screenIntent && prompt.value.trim() && window.screenIntent.wantsScreen(prompt.value, { lastTurns: recentTurns() }).screen); } catch { return false; }
}
function renderScreenBtn() {
  if (!screenBtn) return;
  const words = screenMode === null && screenWanted();
  const state = screenMode === 'on' ? 'on' : screenMode === 'off' ? 'off' : words ? 'auto' : 'idle';
  screenBtn.dataset.state = state;
  screenBtn.setAttribute('aria-pressed', String(state === 'on' || state === 'auto'));
  const title = t(`composer.screen.${state}`);
  screenBtn.title = title;
  screenBtn.setAttribute('aria-label', title);
}
function takeScreenMode() { const mode = screenMode; screenMode = null; renderScreenBtn(); return mode || undefined; }
if (screenBtn) {
  screenBtn.onclick = () => {
    const lit = screenBtn.dataset.state === 'on' || screenBtn.dataset.state === 'auto';
    screenMode = lit ? 'off' : 'on';
    renderScreenBtn();
    prompt.focus();
  };
}
// The line under a message that carried the tab: { id, kind: 'image' | 'text', title, thumb }. × takes the picture out of the chat.
function screenChip(bubble, info) {
  if (!bubble || !info || bubble.querySelector('.msg-screen')) return;
  const chip = document.createElement('div');
  chip.className = 'msg-screen';
  const title = info.title || t('chat.screen.untitled');
  const label = Object.assign(document.createElement('span'), { className: 'msg-screen-text', textContent: t(info.kind === 'text' ? 'chat.screen.text' : 'chat.screen.image', { title }), title });
  chip.append(label);
  if (info.thumb) chip.append(Object.assign(document.createElement('img'), { className: 'msg-screen-thumb', src: info.thumb, alt: '' }));
  const x = Object.assign(document.createElement('button'), { type: 'button', className: 'msg-screen-x', textContent: '×', title: t('chat.screen.remove') });
  x.setAttribute('aria-label', t('chat.screen.remove'));
  x.disabled = running;
  x.onclick = async () => {
    x.disabled = true;
    const ok = await window.assistant.dropScreen?.(info.id).catch(() => false);
    if (!ok) { x.disabled = running; return; }
    chip.classList.add('removed');
    label.textContent = t('chat.screen.removed');
    chip.querySelector('.msg-screen-thumb')?.remove();
    x.remove();
  };
  chip.append(x);
  bubble.append(chip);
}

// ---------- attachments: paste, drop or pick files for the message ----------
// Pictures go to the AI as pictures (downsized here); every file, pictures included, is also kept by Lumen under an
// opaque ref (main.js uploads:stash), so the AI can put it into a web page's file upload (upload_file) after the user
// has seen the names and the site. A file that is not a picture is never sent to the model: only its name and size.

const MAX_IMAGES = 5;
const MAX_ATTACH = 10; // pictures and other files together
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // main refuses a bigger file too
const MAX_EDGE = 1568; // larger images are downscaled by the API anyway; resizing first saves upload time
const MAX_BYTES = 3.5 * 1024 * 1024; // a PNG/JPEG/GIF/WebP under this and within MAX_EDGE goes as it is
const MAX_FILE_BYTES = 25 * 1024 * 1024; // a bigger file is refused before it is read
const MAX_SEND_CHARS = 6_500_000; // base64 characters of one image after conversion (main refuses 7 million)
const PASSTHROUGH = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_NAME = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|svg|ico|tiff?|heic|heif)$/i;
const HEIC_NAME = /\.(heic|heif)$/i;
let attachments = []; // a picture: { media_type, data (base64), url (data URL for previews), name, ref }; any other file: { file: true, name, size, type, ref }
const isFileItem = (a) => Boolean(a?.file);
const imageItems = (list) => list.filter((a) => !isFileItem(a));
const refsOf = (list) => list.map((a) => a.ref).filter(Boolean);
const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);
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
  el.replaceChildren(...lines.map((line) => (typeof line === 'string' ? Object.assign(document.createElement('div'), { textContent: line }) : line)));
  el.hidden = lines.length === 0;
  if (lines.length) attachNoteTimer = setTimeout(() => showAttachNote([]), 12000);
}

// Keeps the file's own bytes in main under a ref (main.js uploads:stash). -> { ok, ref, name, size, type } | { ok: false, error }
async function stashFile(file) {
  try {
    const data = await file.arrayBuffer();
    return (await window.assistant.uploads?.stash({ name: file.name || '', type: file.type || '', data })) || { ok: false };
  } catch { return { ok: false }; }
}

// Adds `files` (any kind) to the message; returns whether any was added. A picture goes as a picture (and is kept as a
// file too); a picture that can't be shown (HEIC, too big, a sixth) and any other file becomes a file chip. Says what it left out.
async function addFiles(files) {
  const list = [...files];
  const problems = [];
  let over = 0;
  let added = 0;
  for (const file of list) {
    if (attachments.length >= MAX_ATTACH) { over++; continue; }
    if (!file.size) { problems.push(attachProblem(file, 'empty')); continue; }
    if (file.size > MAX_UPLOAD_BYTES) { problems.push(t('composer.attach.bigFile', { name: imageLabel(file), max: 100 })); continue; }
    let picture = null;
    if (isImageFile(file) && imageItems(attachments).length < MAX_IMAGES && !isHeic(file) && file.size <= MAX_FILE_BYTES) {
      try { picture = await toAttachment(file); } catch { picture = null; } // (kept as a file instead)
    }
    const kept = await stashFile(file);
    if (picture) {
      if (kept.ok) picture.ref = kept.ref;
      attachments.push(picture);
    } else if (kept.ok) {
      attachments.push({ file: true, name: kept.name, size: kept.size, type: kept.type, ref: kept.ref });
    } else {
      problems.push(kept.error || attachProblem(file, 'unreadable'));
      continue;
    }
    added++;
  }
  if (over) problems.push(t('composer.attach.limit', { max: MAX_ATTACH, n: over }));
  renderAttachments();
  showAttachNote(problems);
  return added > 0;
}

// A Word, Excel or PowerPoint file in the box shows its first page beside its name (main draws it: features/office-thumb.js; asked once per file).
const attachThumbs = new Map(); // ref -> data: URL | null
const OFFICE_NAME = /\.(?:docx|xlsx|pptx)$/i;
const PNG_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
function showChipThumb(ref, url) {
  const chip = [...$('attachments').children].find((c) => c.dataset.ref === ref);
  if (!chip || chip.querySelector('.attachment-thumb')) return;
  const text = Object.assign(document.createElement('span'), { className: 'attachment-text' });
  text.append(...chip.querySelectorAll('.attachment-ext, .attachment-name, .attachment-size'));
  chip.classList.add('has-thumb');
  chip.prepend(Object.assign(document.createElement('img'), { className: 'attachment-thumb', src: url, alt: '', decoding: 'async' }), text);
}
function requestChipThumb(a) {
  if (!a.ref || !OFFICE_NAME.test(a.name || '') || typeof window.assistant.uploads?.thumb !== 'function') return;
  if (attachThumbs.has(a.ref)) { const url = attachThumbs.get(a.ref); if (url) showChipThumb(a.ref, url); return; }
  attachThumbs.set(a.ref, null);
  Promise.resolve(window.assistant.uploads.thumb(a.ref)).then((r) => {
    const url = r && typeof r.dataUrl === 'string' && PNG_URL.test(r.dataUrl) ? r.dataUrl : null;
    if (!url) return;
    attachThumbs.set(a.ref, url);
    showChipThumb(a.ref, url);
  }).catch(() => {});
}

function renderAttachments() {
  const strip = $('attachments');
  strip.replaceChildren();
  strip.hidden = attachments.length === 0 && pastes.length === 0;
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = isFileItem(a) ? 'attachment attachment-file' : 'attachment';
    chip.setAttribute('role', 'listitem');
    if (a.name) chip.title = a.name;
    if (isFileItem(a)) { // a file that isn't shown to the AI: its name and size
      chip.setAttribute('aria-label', t('composer.attachedFile', { n: i + 1, name: a.name, size: fileSize(a.size) }));
      const ext = (/\.([a-z0-9]{1,5})$/i.exec(a.name || '') || [])[1];
      chip.append(
        Object.assign(document.createElement('span'), { className: 'attachment-ext', textContent: (ext || 'file').toUpperCase() }),
        Object.assign(document.createElement('span'), { className: 'attachment-name', textContent: a.name }),
        Object.assign(document.createElement('span'), { className: 'attachment-size', textContent: fileSize(a.size) }),
      );
      if (a.ref) chip.dataset.ref = a.ref;
    } else {
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = a.name ? t('composer.attachedNamed', { n: i + 1, name: a.name }) : t('composer.attachedImage', { n: i + 1 });
      chip.append(img);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', t('composer.removeImage', { n: i + 1 }));
    remove.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>';
    remove.onclick = () => { const [gone] = attachments.splice(i, 1); if (gone?.ref) window.assistant.uploads?.discard(gone.ref); renderAttachments(); showAttachNote([]); prompt.focus(); };
    chip.append(remove);
    strip.append(chip);
    if (isFileItem(a)) requestChipThumb(a);
  });
  // A long pasted block: a chip like a file's, sent as part of the message (the model reads it; a file chip it would not).
  pastes.forEach((text, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment attachment-file attachment-paste';
    chip.setAttribute('role', 'listitem');
    chip.title = text.slice(0, 300);
    const size = t('composer.paste.size', { n: text.length.toLocaleString() });
    chip.setAttribute('aria-label', t('composer.paste.chip', { size }));
    chip.append(
      Object.assign(document.createElement('span'), { className: 'attachment-ext', textContent: 'TXT' }),
      Object.assign(document.createElement('span'), { className: 'attachment-name', textContent: t('composer.paste.name') }),
      Object.assign(document.createElement('span'), { className: 'attachment-size', textContent: size }),
    );
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', t('composer.paste.remove'));
    remove.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>';
    remove.onclick = () => { pastes.splice(i, 1); renderAttachments(); prompt.focus(); };
    chip.append(remove);
    strip.append(chip);
  });
  strip.setAttribute('role', 'list');
  strip.setAttribute('aria-label', t('composer.attachments'));
  const attachBtn = $('attach');
  if (attachBtn) {
    const full = attachments.length >= MAX_ATTACH;
    attachBtn.disabled = full;
    attachBtn.title = full ? t('composer.attach.full', { max: MAX_ATTACH }) : t('composer.attach.title', { max: MAX_ATTACH });
  }
  updateSend();
  document.dispatchEvent(new CustomEvent('lumen:attachments', { detail: { count: attachments.length } })); // (the background button can't carry images)
}

window.chatAttachments = { count: () => attachments.length, max: MAX_ATTACH, note: (lines) => showAttachNote(lines) }; // (renderer/tasks.js: a background task can't carry images)

// The attach button: a file picker (Tab to it, then Enter or Space).
{
  const attachBtn = $('attach');
  const picker = $('attach-input');
  if (attachBtn && picker) {
    attachBtn.onclick = () => picker.click();
    picker.addEventListener('change', async () => {
      const files = [...picker.files];
      picker.value = ''; // (the same file can be picked again)
      if (files.length) await addFiles(files);
      prompt.focus();
    });
    renderAttachments(); // (the tooltip states the limit)
  }
  const phoneBtn = $('from-phone'); // [phone wifi] a QR for the phone; what it sends comes into this composer when the sheet closes
  if (phoneBtn) phoneBtn.onclick = () => window.browser?.phoneWifi?.();
}

prompt.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault(); // text paste stays untouched; only files (pictures included) are intercepted
    await addFiles(files);
    return;
  }
  // A long block of text goes into the box as usual; a line under it offers to move it to a chip instead (as Claude.ai does).
  const text = (e.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n');
  if (window.chatDrafts.isLongPaste(text)) setTimeout(() => offerPasteChip(text));
});
function offerPasteChip(text) {
  if (!prompt.value.includes(text)) return;
  const line = document.createElement('div');
  line.className = 'paste-offer';
  const button = Object.assign(document.createElement('button'), { type: 'button', className: 'notice-action', textContent: t('composer.paste.attach') });
  line.append(Object.assign(document.createElement('span'), { textContent: t('composer.paste.offer', { n: text.length.toLocaleString() }) }), ' ', button);
  button.onclick = () => {
    const at = prompt.value.indexOf(text);
    if (at === -1) { showAttachNote([]); return; } // (edited or removed since)
    prompt.value = (prompt.value.slice(0, at) + prompt.value.slice(at + text.length)).replace(/\n{3,}/g, '\n\n');
    pastes.push(text);
    autosize();
    renderAttachments();
    renderScreenBtn();
    showAttachNote([]);
    prompt.focus();
  };
  showAttachNote([line]);
}
const sidebarEl = chatRoot;
// Any file dropped on the chat joins the message (it no longer opens in a tab).
const dragHasFiles = (dt) => [...(dt?.items || [])].some((i) => i.kind === 'file');
sidebarEl.addEventListener('dragover', (e) => {
  if (dragHasFiles(e.dataTransfer)) {
    e.preventDefault();
    sidebarEl.classList.add('dropping');
  }
});
sidebarEl.addEventListener('dragleave', (e) => { if (!sidebarEl.contains(e.relatedTarget)) sidebarEl.classList.remove('dropping'); });
sidebarEl.addEventListener('drop', async (e) => {
  sidebarEl.classList.remove('dropping');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  await addFiles(e.dataTransfer.files);
  prompt.focus();
});

// Asks that arrive while a reply is running (Alt+Enter in the address bar, "Ask about selection", the new-tab page's Ask AI, a starter chip, or
// what is typed in the box: Enter) wait their turn instead of disappearing. Each shows under the reply as your own bubble, dimmed, with a clock
// and "Queued · 2nd"; Send now, Edit and × sit on it. The line itself (order, owner chat, merging) is renderer/chat-queue.js (`line`, above).
function queueUp(entry) {
  const bubble = userBubble(entry.text, entry.images, entry.tabs);
  bubble.className = 'queued-bubble queued';
  entry.label = Object.assign(document.createElement('span'), { className: 'queue-label' });
  entry.meta = Object.assign(document.createElement('div'), { className: 'queue-meta' });
  entry.meta.append(entry.label);
  bubble.append(entry.meta);
  entry.bubble = bubble;
  append(bubble);
  setMark(bubble, 'queued');
  line.add(entry);
  if (!entry.fresh) queueControls(entry);
  renderQueue();
  return entry;
}
// "Queued", "Queued · 2nd", ...: the places in this chat's line; and the bar that sends several as one turn.
function renderQueue() {
  const mine = line.mine(forOtherChat);
  mine.forEach((q, i) => { q.label.textContent = i ? t('chat.queued.nth', { n: window.chatQueue.ordinal(i + 1) }) : t('chat.queued.label'); });
  const several = mine.filter(window.chatQueue.mergeable);
  if (several.length < 2) { queueBar?.remove(); queueBar = null; return; }
  if (!queueBar) {
    queueBar = Object.assign(document.createElement('div'), { className: 'queue-bar queued' });
    queueBar.append(document.createElement('span'), Object.assign(document.createElement('button'), { type: 'button', className: 'queue-btn', textContent: t('chat.queued.sendAll'), title: t('chat.queued.sendAll.title'), onclick: sendAllNow }));
  }
  queueBar.firstChild.textContent = t('chat.queued.count', { n: several.length });
  mine[mine.length - 1].bubble.after(queueBar);
}
// Edit (back into the composer) and × (dropped) on a message waiting for the current reply to finish.
function queueControls(entry) {
  const drop = () => { line.remove(entry); entry.bubble.remove(); renderQueue(); };
  const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'queue-btn', textContent: t('chat.queued.edit') });
  edit.onclick = () => {
    drop();
    prompt.value = prompt.value.trim() ? `${prompt.value.replace(/\s+$/, '')}\n${entry.text}` : entry.text; // (a draft is kept)
    if (entry.images?.length) { attachments = [...attachments, ...entry.images].slice(0, MAX_ATTACH); renderAttachments(); }
    autosize();
    updateSend();
    prompt.focus();
  };
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'queue-btn', textContent: '×', title: t('chat.queued.cancel') });
  cancel.setAttribute('aria-label', t('chat.queued.cancel'));
  cancel.onclick = () => { for (const ref of refsOf(entry.images || [])) window.assistant.uploads?.discard(ref); drop(); };
  const now = Object.assign(document.createElement('button'), { type: 'button', className: 'queue-btn', textContent: t('chat.queued.sendNow'), title: t('composer.sendNow.title') });
  now.onclick = () => sendNow(entry);
  const actions = Object.assign(document.createElement('span'), { className: 'queue-actions' });
  actions.append(now, edit, cancel);
  entry.meta.append(actions);
}
// Send now: `entry` goes first in the line and the running reply is stopped through the Stop button's own path
// (agent:stop: a CLI engine is interrupted or its process tree ended, an API request aborted), so the reply's 'done'
// sends it as the next turn. What the reply had said stays on screen, marked interrupted, and in the history (agent.js).
function sendNow(entry) {
  if (!line.promote(entry)) return;
  const first = messages.querySelector(QUEUED);
  if (first && first !== entry.bubble) first.before(entry.bubble);
  renderQueue();
  if (!running) return; // (the reply ended meanwhile: the line moves on by itself)
  for (const b of entry.bubble.querySelectorAll('.queue-btn')) b.disabled = true;
  if (turn) turn.interrupted = true;
  window.assistant.stop(shownChatId || undefined);
}
// "Send all as one": the messages waiting in this chat become ONE message (their texts one after the other, all their pictures and files),
// which stops the reply and goes next, like Send now. One that carries a plan to run, or opens a new chat, keeps its own turn.
function sendAllNow() {
  const merged = window.chatQueue.merge(line.mine(forOtherChat), MAX_ATTACH);
  if (!merged) return;
  for (const q of merged.merged) { line.remove(q); q.bubble.remove(); }
  const { text, images, tabs, screen, chatId } = merged;
  sendNow(queueUp({ text, images, tabs, screen, opts: null, chatId }));
}
function sendQueued() {
  if (running) return; // (a message typed in the meantime started its own turn: the line goes on when that one ends)
  // No AI connected (signed out, or its key gone while the reply ran): ask() would only park the text where nothing shows it. It is unsent text in the box instead.
  if (!modelReady) { queuedToDraft(); return; }
  // Only what was typed in the chat shown now goes: a message queued in another chat belongs to that chat's run.
  const next = line.take(forOtherChat);
  if (!next) return;
  next.bubble.remove();
  if (next.fresh) {
    // A question from the new-tab page that waited for the running reply: now start its new chat (what else is still waiting comes back to the box, as with any chat switch).
    $('new-chat').click();
  }
  renderQueue();
  ask(next.text, next.images, next.tabs, next.screen, next.opts);
}

// Ask AI from the new-tab page: the question starts a new chat instead of joining the open one (the
// old one stays in the chat list). If a reply is still running it is not stopped: the question waits
// its turn like any queued message, then opens the new chat.
// `files`: pictures from the new-tab box (File objects), put through the composer's own attach path (addFiles) so they are stored and sent like any picture added here.
async function askInNewChat(text, files = []) {
  let images = [];
  if (files.length) { // (the box's own pictures wait aside while these are prepared)
    const aside = attachments;
    attachments = [];
    await addFiles(files);
    images = attachments;
    attachments = aside;
    renderAttachments();
  }
  if (running) { queueUp({ text, images, tabs: null, fresh: true, chatId: shownChatId }); return; }
  $('new-chat').click();
  ask(text, images);
}

// [ask ai new chat] A question that comes with its own context ("Ask AI about this", the command bar): it starts a new chat, unless the open one is
// still empty. A reply running in the open chat is not stopped: it goes on there, in History.
function askInFreshChat(text) {
  if (!$('empty').hidden) $('new-chat').click();
  return ask(text);
}

// `tabs` (renderer/tabs-ask.js take()): the tabs picked with "@" — { ids, names, gone } — whose text goes along.
// `opts` [plan mode]: { approvedPlan } when Run plan sends a plan (renderer/plan-mode.js); otherwise the "Plan first" chip decides.
function ask(text, images = [], tabs = null, screen, opts = null) {
  if (running) return queueUp({ text, images, tabs, screen, opts, chatId: shownChatId }); // (for Send now)
  // Nothing connected: the question is kept (back in the box) and sent as soon as an AI is connected.
  if (!modelReady) {
    pendingAsk = { text, images, tabs, screen, at: Date.now() };
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
  lastAsk = { text, images, tabs, screen };
  startTurn(text, images, tabs);
  // Run ids stay unique across chats: a chat left running still sends events under its own id.
  runId = Math.max(runId + 1, Date.now());
  shownChatId = null; // (main may switch to this window's tab's chat as the message arrives: the first event names the chat)
  const planOpts = opts?.approvedPlan ? { approvedPlan: opts.approvedPlan } : opts?.plan === true || window.planModeUI?.forSend() ? { plan: true } : undefined; // [plan mode] (/plan sends opts.plan)
  window.assistant.ask(text, runId, imageItems(images).map(({ media_type, data }) => ({ media_type, data })), tabs?.ids?.length ? tabs.ids : undefined, refsOf(images), screen, planOpts);
}

// Tools that change something (a click, typing, opening or closing tabs): running them again isn't harmless.
const ACTING_TOOLS = new Set(['click', 'click_at', 'type_text', 'press_key', 'fill_form', 'upload_file', 'navigate', 'open_tab', 'close_tab', 'switch_tab', 'go_back', 'go_forward', 'reload', 'run_script', 'group_tabs', 'ungroup_tabs', 'hover', 'scroll']);
// Thinking: all the thinking blocks between two steps (or with nothing visible between them) are ONE row, "Thought for 3s" (the blocks' times added,
// each block's words in order when it is opened). Blocks with no words (empty or hidden reasoning) get no row of their own: they only add their time
// to the row beside them, and a lone one under a second shows nothing. In a run that uses tools the row sits in the card's step list, in its place.
// turn.seg = { texts: [one string per block], ms: closed blocks' time, since: start of the open block (0 when none), row, div }
function thinkingRow(seg) {
  if (seg.row) return seg.row;
  const details = document.createElement('details');
  details.className = 'thinking';
  details.innerHTML = '<summary></summary><div></div>';
  details.firstChild.textContent = t('chat.thinking');
  seg.row = details;
  seg.div = details.querySelector('div');
  if (!window.stepUI?.bare(turn, details)) appendToTurn(details);
  return details;
}
function thinkingEvent(text) {
  const seg = turn.seg || (turn.seg = { texts: [], ms: 0, since: 0, row: null, div: null });
  if (!seg.since) { seg.since = Date.now(); seg.texts.push(''); }
  const chunk = String(text || '');
  if (chunk.trim() || seg.texts.some((s) => s.trim())) {
    const last = seg.texts.length - 1;
    const first = !seg.texts[last].trim() && chunk.trim() && seg.texts.slice(0, last).some((s) => s.trim());
    thinkingRow(seg);
    if (first) seg.div.textContent += '\n\n'; // (a new block of words: apart from the one before)
  }
  seg.texts[seg.texts.length - 1] += chunk;
  if (seg.div && chunk) seg.div.textContent += chunk;
}
// The answer or a step comes: the open block ends and its row says how long it all took, "Thought for 4s".
function settleThinking() {
  const seg = turn?.seg;
  if (!seg || !seg.since) return;
  seg.ms += Date.now() - seg.since;
  seg.since = 0;
  const secs = Math.round(seg.ms / 1000);
  if (!seg.row && secs < 1) return; // (no words and under a second: nothing to show)
  thinkingRow(seg).firstChild.textContent = t('chat.thoughtFor', { n: Math.max(1, secs) });
}
function endThinking() { settleThinking(); if (turn) turn.seg = null; }
// Retry (after an error) and Regenerate (the latest reply): the last exchange is taken back in main and on screen,
// then asked again, as if it had never been sent.
let lastAsk = null;
// [versions] The versions main kept when it took an exchange back: the next turn shows the switch (chat-actions.js). { at, n, cur, same }
let pendingVersions = null;
// `version`: a Regenerate, which keeps the reply it replaces as an earlier version (Retry after an error keeps nothing).
async function askAgain(version = false) {
  if (running || !lastAsk) return false;
  const again = lastAsk;
  let result;
  if (version && window.assistant.rewindUser) {
    const out = await window.assistant.rewindUser(messages.querySelectorAll('.msg.user').length - 1, again.text);
    result = out?.result;
    pendingVersions = result === 'rewound' && out.versions ? { ...out.versions, same: true } : null;
  } else result = await window.assistant.rewind?.(again.text);
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
  ask(again.text, again.images, again.tabs, again.screen);
  return true;
}

// Edit (the latest message you sent, once its reply is done): the bubble becomes a text box in place, as in
// Claude.ai and ChatGPT. Nothing is taken back until Send; Cancel or Esc leaves everything as it was. The composer
// (and whatever is typed there) is untouched.
function editLast() {
  editBubble([...messages.querySelectorAll('.msg.user')].pop());
}
// Any message of yours can be edited: what followed it is kept as another version (the ‹ 2/3 › switch), and the edited message
// starts the branch the chat goes on from.
function editBubble(bubble) {
  if (running || !bubble || bubble.classList.contains('editing') || bubble.dataset.skill) return; // (a skill runs again with Regenerate)
  const again = askOf(bubble) || (bubble === [...messages.querySelectorAll('.msg.user')].pop() ? lastAsk : null);
  if (!again) return;
  for (const b of messages.querySelectorAll('.msg.user.editing')) b.cancelEdit?.(); // (one edit at a time)
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
    let result;
    pendingVersions = null;
    if (window.assistant.rewindUser) {
      const out = await window.assistant.rewindUser([...messages.querySelectorAll('.msg.user')].indexOf(bubble), again.text);
      result = out?.result;
      if (result === 'rewound' && out.versions) pendingVersions = { ...out.versions, same: text === again.text.trim() };
    } else result = await window.assistant.rewind?.(again.text);
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
    if (isImeEnter(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel.onclick(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.onclick(); }
  });
}
// Each message you sent: the time, Copy and Edit in a row under the bubble (not inside it, so it's no part of its text), and the
// version switch when it was asked again (chat-actions.js). info: { at, versions }
function markEditable(bubble, info = {}) {
  window.chatActions?.userRow(bubble, info);
}
// What a user bubble asked (for Regenerate and Edit after a restore or a chat switch).
const bubbleAsks = new WeakMap();
function askOf(bubble) {
  return bubble ? bubbleAsks.get(bubble) || null : null;
}

// The user's bubble and the working line for a turn that is now running.
// The files a message carried, under its pictures: a chip each with the name and size.
function fileChips(files) {
  const row = document.createElement('div');
  row.className = 'msg-files';
  for (const f of files) row.append(Object.assign(document.createElement('span'), { className: 'msg-file', textContent: `${f.name} · ${fileSize(f.size)}`, title: f.name }));
  return row;
}
// A message's mark, as in a messaging app (renderer/chat-queue.js advance): a clock while it waits for the reply before it, one check once it
// is sent to the engine, two when the AI took it up (its reply began). It only moves forward.
const MARKS = {
  queued: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6"/><path d="M6 3.5V6l1.7 1"/></svg>',
  sent: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 6.4 5 8.8l4.4-5.2"/></svg>',
  read: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5 3.3 8.8 7.5 3.8M5.2 8.3l.5.5 4.7-5.3"/></svg>',
};
function setMark(bubble, status) {
  if (!bubble) return;
  const next = window.chatQueue.advance(bubble.dataset.st, status);
  if (!next || next === bubble.dataset.st) return;
  bubble.dataset.st = next;
  let mark = bubble.querySelector(':scope > .msg-status');
  if (!mark) { mark = document.createElement('span'); mark.className = 'msg-status'; bubble.append(mark); }
  const label = next === 'queued' ? t('chat.mark.queued') : next === 'sent' ? t('chat.mark.sent') : t('chat.mark.read'); // (keys written out: test/e2e/a11y.js finds the keys in use by their text)
  mark.innerHTML = MARKS[next];
  mark.title = label;
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', label);
}
// Your message as a bubble: the one being sent, or one waiting in the line.
function userBubble(text, images, tabs = null) {
  const bubble = document.createElement('div');
  bubble.className = 'msg user';
  const pictures = imageItems(images);
  if (pictures.length) {
    const row = document.createElement('div');
    row.className = 'msg-images';
    for (const [i, a] of pictures.entries()) {
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = t('chat.imageN', { n: i + 1 });
      window.genImages?.zoomable(img);
      row.append(img);
    }
    bubble.append(row);
  }
  const files = images.filter(isFileItem);
  if (files.length) bubble.append(fileChips(files));
  if (text) bubble.append(document.createTextNode(text));
  if (tabs?.ids?.length) window.tabsAsk?.describeSent(bubble, tabs.names || []); // "3 tabs attached: …"
  bubbleAsks.set(bubble, { text, images, tabs });
  return bubble;
}
function startTurn(text, images, tabs = null) {
  loadStepUI();
  const bubble = userBubble(text, images, tabs);
  dropReplyActions(); // only the latest reply can be regenerated
  for (const b of messages.querySelectorAll('.notice-continue')) b.remove(); // (a Continue left under an earlier reply)
  for (const b of messages.querySelectorAll('.msg.user.editing')) b.cancelEdit?.(); // (an edit left open)
  append(bubble, { force: true }); // your own message always comes into view
  const versions = pendingVersions;
  pendingVersions = null;
  markEditable(bubble, { at: Date.now(), versions });
  setMark(bubble, 'sent');
  beginTurn();
  turn.userBubble = bubble;
  turn.versions = versions; // (a Regenerate: the switch goes on its reply, see labelReply)
}

// Regenerate and Retry (with another model) of an earlier reply, and the actions-only row of one that said nothing: none while a reply runs.
function dropReplyActions() {
  for (const b of messages.querySelectorAll('.reply-regen, .reply-retry, .reply-actions-only')) b.remove();
}

// The working line's passing status. `runNow`: the chat waits for a free slot (the cap on chats working at once), and a button starts it now.
function setStatus(working, text, runNow = false) {
  if (text) working.dataset.status = text; else delete working.dataset.status;
  working.querySelector('.run-now')?.remove();
  if (!text || !runNow || !window.assistant?.chats?.runNow) return;
  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'run-now', textContent: t('chat.runNow'), title: t('chat.runNow.title') });
  btn.onclick = () => { btn.disabled = true; window.assistant.chats.runNow().catch(() => {}).finally(() => { btn.disabled = false; }); };
  working.append(btn);
}

// The working line and turn state of a reply that is now running (its user bubble already shown).
function beginTurn() {
  dropReplyActions(); // (also a chat opened mid-run: its history ended on your message, so it showed the actions-only row)
  const working = document.createElement('div');
  working.className = 'working';
  working.setAttribute('role', 'status');
  working.setAttribute('aria-label', t('chat.thinking'));
  turn = { text: null, textSource: '', seg: null, working: append(working), steps: new Map(), cards: [], card: null, plain: null, startedAt: Date.now() };
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
  if (!turn.userBubble && lastUser) { turn.userBubble = lastUser; setMark(lastUser, live.partial ? 'read' : 'sent'); } // (a chat opened mid-run: its last message)
  if (live.queued?.status && turn.working) setStatus(turn.working, live.queued.status, live.queued.runNow);
  runId = live.runId;
  if (live.target) { agentTarget = live.target; renderWorkingIn(); } // "Working in: <site>" at once
  for (const a of live.approvals || []) showApproval(a.approvalId, a.host, { action: a.action, title: a.title, query: a.query, args: a.args, tainted: a.tainted, noAlways: a.noAlways, note: a.note, fields: a.fields, upload: a.upload, detail: a.detail, allowLabel: a.allowLabel, helper: a.helper });
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
  runPill.sync();
  const firstQueued = messages.querySelector(QUEUED); // (they stay under it)
  if (firstQueued) { if (w.nextElementSibling !== firstQueued) firstQueued.before(w); }
  else if (messages.lastElementChild !== w) messages.append(w);
}

// The working line shows while the AI works, not while it waits on the user's answer to an approval card.
function syncWorking() {
  turn?.working?.classList.toggle('waiting', approvals.size > 0);
  window.stepUI?.refreshAll(turn); // (a card says "Needs your OK" while a card waits)
}

// Adds a piece of the running reply above the working line, which stays last without ever moving.
const sendRows = new Map(); // [connectors] the "sending in 10 s" rows still counting down, by send id
function appendToTurn(el) {
  if (!turn?.working?.isConnected) return append(el);
  $('empty').hidden = true;
  turn.working.before(el);
  scrollToBottom();
  return el;
}

// A step's elapsed time, at the end of its row: ticking from 3 s while it runs, final once it is done (renderer/step-time.js says
// nothing under a second). One timer for all running steps, off when none is.
let stepClock = 0;
function showStepTime(step, final = false) {
  const slot = step.querySelector('.step-time');
  const t0 = Number(step.dataset.t0);
  if (!slot || !t0) return;
  const ms = Date.now() - t0;
  const text = window.stepTime ? window.stepTime.format(ms) : '';
  slot.textContent = !final && ms < 1000 ? '' : text;
  if (final) { slot.title = text ? t('chat.step.took', { time: text }) : ''; step.dataset.start = String(t0); step.dataset.t1 = String(Date.now()); delete step.dataset.t0; } // (a group of steps adds up its members' start and end)
}
function startStepClock() {
  if (stepClock) return;
  stepClock = setInterval(() => {
    const running = messages.querySelectorAll('.step.running[data-t0]');
    if (!running.length) { clearInterval(stepClock); stepClock = 0; return; }
    for (const step of running) showStepTime(step);
  }, 1000);
}

// [annotate] A finished annotate step: "Drew N marks on the page" with Show again / Clear (the drawing is in the tab itself).
function annotateChip(step) {
  const count = Number(step.dataset.marks) || 0;
  if (!count) return; // clear only
  const label = t(count === 1 ? 'tool.annotate.done.one' : 'tool.annotate.done.other', { count });
  step.firstChild.textContent = label;
  step.title = label;
  if (!window.assistant?.annotate) return;
  for (const [action, key] of [['show', 'tool.annotate.show'], ['clear', 'tool.annotate.clear']]) {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'step-action', textContent: t(key) });
    button.onclick = () => { button.disabled = true; window.assistant.annotate(action).finally(() => { button.disabled = false; }); };
    step.append(button);
  }
}

// A step whose tool has no line above: its name in plain words and its main argument (renderer/step-labels.js generic), else "Using a tool".
const unknownLabel = (event) => { try { return window.stepLabels?.defaults?.generic(event.name, event.input || {}) || t('step.tool'); } catch { return t('step.tool'); } };
const TOOL_LABELS = {
  read_page: () => t('tool.read_page'),
  screenshot: () => t('tool.screenshot'),
  navigate: (i) => t('tool.navigate', { url: window.stepLabels?.hostOf(i.url || '') ?? i.url }), // (the site, not the whole address)
  click: () => t('tool.click'),
  type_text: (i) => t('tool.type_text', { text: i.text }),
  press_key: (i) => t('tool.press_key', { key: i.key }),
  scroll: (i) => t('tool.scroll', { direction: i.direction }),
  go_back: () => t('tool.go_back'),
  list_tabs: () => t('tool.list_tabs'),
  open_tab: (i) => t('tool.open_tab', { url: window.stepLabels?.hostOf(i.url || '') ?? i.url }),
  switch_tab: (i) => t('tool.switch_tab', { tab: i.tab_id }),
  wait: (i) => t('tool.wait', { seconds: i.seconds }),
  web_search: (i) => t('tool.web_search', { query: i.query ?? '' }),
  find: (i) => t('tool.find', { query: i.query ?? '' }),
  batch: (i) => t('tool.batch', { count: i.steps?.length || t('tool.batch.several') }),
  fill_form: () => t('tool.fill_form'),
  click_at: () => t('tool.click_at'),
  hover: () => t('tool.hover'),
  annotate: () => t('tool.annotate'),
  upload_file: () => t('tool.upload_file'),
  go_forward: () => t('tool.go_forward'),
  reload: () => t('tool.reload'),
  close_tab: (i) => t('tool.close_tab', { tab: i.tab_id }),
  group_tabs: (i) => t('tool.group_tabs', { name: i.name ?? '' }),
  ungroup_tabs: () => t('tool.ungroup_tabs'),
  read_urls: () => t('tool.read_urls'),
  read_pdf: () => t('tool.read_pdf'),
  video_overview: () => t('tool.video_overview'),
  video_frames: () => t('tool.video_frames'),
  read_tabs: (i) => t(i.ids?.length === 1 ? 'tool.read_tabs.one' : 'tool.read_tabs.other', { count: i.ids?.length || 0 }),
  run_script: () => t('tool.run_script'),
  wait_for: (i) => (i.text ? t('tool.wait_for', { text: i.text }) : t('tool.wait_for.page')),
  get_console: () => t('tool.get_console'),
  get_network: () => t('tool.get_network'),
  handle_dialog: () => t('tool.handle_dialog'),
  analyze_posts: () => t('tool.analyze_posts'),
  find_sources: (i) => t(i.related ? 'tool.find_sources.related' : 'tool.find_sources', { query: i.query ?? '' }),
  propose_plan: () => t('tool.propose_plan'), // [plan mode]
  research_board: (i) => t(`tool.research_board.${['add', 'quote', 'star', 'remove', 'list', 'cite'].includes(i.action) ? i.action : 'list'}`),
  delegate: (i) => t('tool.delegate', { count: Array.isArray(i.tasks) ? i.tasks.length : 0 }),
  parallel_tasks: (i) => t('tool.parallelTasks', { count: Array.isArray(i.tasks) ? Math.min(i.tasks.length, 3) : 0 }), // [acting helpers]
  helper: (i) => t(i.doing === 'read_urls' ? 'tool.helper.reading' : i.doing === 'web_search' ? 'tool.helper.searching' : 'tool.helper', { n: i.n ?? '', task: i.task ?? '' }),
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
  window.tabRef?.decorate(root, root?._tabs); // [tab chips] [[tab:ID]] in the AI's own words: a chip for the tab
  window.genImages?.decorate(root); // ![](…) in a reply: data pictures drawn, web pictures offered
  window.researchUi?.decorate(root); // a ```sources block (/research): the research board's entries with their quality chips
  window.codeExtras?.decorateTables(root); // a wide table: a Fit / Scroll switch
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
    window.chatCanvas?.decorate(pre, head, b); // lumen://chat only: "Open in canvas" for a long block or an HTML/SVG page
    pre.replaceWith(box);
    box.append(head, pre);
    window.codeExtras?.decorate(box, pre, { finished: colour || !root.classList?.contains('streaming') }); // Wrap button; ```mermaid as a diagram
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

let finishedRun = null; // { runId, turn }: the run that just ended, so a thumbnail that lands after its 'done' still reaches its Browser card
let earlyEnded = null; // { runId, bubble }: the run whose reply ended on reply_complete, until its 'done' (lateDone)
let aiTabsRunId = null; // the run whose "tabs the AI opened" row may still arrive after its 'done'
window.assistant.onEvent((event) => {
  // An approval card answered or cancelled from an older run (after Stop or New chat) still has to
  // clear, or the toolbar's "waiting for approval" badge stayed on.
  if (event.type === 'approval_done') { resolveApproval(event.approvalId, event.ok, event.names); return; }
  // [ai manners] Always: main closed the tabs the AI opened after the run (the turn is over by then): say so, with Undo.
  if (event.type === 'ai_tabs_closed') { if (!turn && event.runId === aiTabsRunId) window.showAiTabsClosed?.(append, event); return; }
  // [skills] After a run ended (opt-in, Settings → Skills): "Save how I did this as a skill?" or "Update the skill?" (skills.js)
  if (event.type === 'skill_offer') { if (!turn && event.runId === aiTabsRunId && !forOtherChat(event.chatId)) window.showSkillOffer?.(append, event); return; }
  if (event.type === 'done' && earlyEnded && event.runId === earlyEnded.runId) { if (!forOtherChat(event.chatId)) lateDone(event); else earlyEnded = null; return; }
  // A picture the engine made, found once its reply text was already whole (reply_complete: agent.js enginePictures runs after the
  // text): drawn under that reply, not dropped with the finished turn.
  if (event.type === 'image' && earlyEnded && event.runId === earlyEnded.runId) { if (!forOtherChat(event.chatId)) latePicture(event); return; }
  if (event.type === 'file' && earlyEnded && event.runId === earlyEnded.runId) { if (!forOtherChat(event.chatId)) lateFile(event); return; } // [ai files]
  // [activity cards] The card's last frame can arrive a moment after 'done' (a capture under way when the run ended): the card takes it.
  if (event.type === 'card_files' && finishedRun && event.runId === finishedRun.runId && (!turn || event.runId !== runId)) { if (!forOtherChat(event.chatId)) window.stepUI?.filesMade(finishedRun.turn, event.files); return; } // (the files a run wrote, after its reply was whole)
  if (event.type === 'thumb' && finishedRun && event.runId === finishedRun.runId && (!turn || event.runId !== runId)) { if (!forOtherChat(event.chatId)) window.stepUI?.thumb(finishedRun.turn, event); return; }
  if (!turn || event.runId !== runId || forOtherChat(event.chatId)) return;
  if (event.chatId && !shownChatId) nameChat(event.chatId); // (a chat just started here: its first event names it)
  // A passing status on the working line ("Starting Claude Code…"): gone as soon as the reply shows anything.
  if (event.type === 'auto') { turn.auto = { label: event.label, reason: event.reason }; return; } // [auto model] which model Auto chose for this reply: its label and tooltip (labelReply)
  if (event.type === 'status') { if (turn.working) setStatus(turn.working, event.text, event.runNow); return; }
  if (turn.working?.dataset.status && ['text', 'thinking', 'tool', 'approval', 'error', 'done'].includes(event.type)) setStatus(turn.working, '');
  if (turn.userBubble && window.chatQueue.countsAsRead(event.type)) setMark(turn.userBubble, 'read'); // (the AI took the message up)
  switch (event.type) {
    case 'turn_start':
    case 'text_block':
      settleThinking();
      endStream();
      if (turn.text && turn.textSource?.trim()) turn.lastSaid = { el: turn.text, text: turn.text.textContent }; // (an engine that ends a block before its step: that block is the step's narration)
      turn.text = null; // next text starts a fresh block after any tool steps
      if (event.type === 'text_block') window.stepUI?.endCard(turn); // (narration does not end the card either: one turn is one card, which stays until the turn ends, see step-ui.js endCard)
      turn.textSource = '';
      break;
    case 'thinking': {
      thinkingEvent(event.text);
      moveWorkingToEnd();
      break;
    }
    case 'image': { // a picture the AI made (or a tool returned): main saved it; drawn here below what was said
      endThinking();
      finishReply(turn.text, turn.textSource);
      endStream(); // (its streaming dot goes: the text before a picture is whole)
      turn.text = null; // words after the picture start a new block under it
      turn.textSource = '';
      const bubble = Object.assign(document.createElement('div'), { className: 'msg assistant gen-pics' });
      bubble.append(window.genImages.figure({ id: event.id, alt: event.alt || '', ...(event.credit ? { credit: event.credit } : {}), ...(event.caption ? { caption: event.caption } : {}) }));
      appendToTurn(bubble);
      turn.pics = bubble;
      announce(t('genimg.made'));
      break;
    }
    case 'file': { // [ai files] a file the AI made, or one its reply names: a card under what was said (renderer/ai-files.js)
      if (!window.aiFiles || !event.file) break;
      endThinking();
      finishReply(turn.text, turn.textSource);
      endStream(); // (its streaming dot goes: the text before a file card is whole)
      turn.text = null;
      turn.textSource = '';
      const bubble = Object.assign(document.createElement('div'), { className: 'msg assistant ai-files' });
      const cardEl = window.aiFiles.card(event.file, { live: true });
      bubble.append(cardEl);
      appendToTurn(bubble);
      if (event.main) window.aiFiles.autoOpen(event.file, cardEl);
      window.stepUI?.fileMade(turn, event.file); // the Terminal / Files card offers it too
      announce(t('aifile.added', { name: event.file.name }));
      break;
    }
    case 'text': {
      endThinking();
      if (!turn.text) { turn.text = appendToTurn(Object.assign(document.createElement('div'), { className: 'msg assistant streaming' })); window.stepUI?.endCard(turn); }
      turn.textSource += event.text;
      renderStreaming(turn.text, turn.textSource);
      break;
    }
    case 'retry':
      // The turn is being asked again (see agent.js loop): drop what it had streamed so far.
      turn.text?.remove();
      turn.seg?.row?.remove();
      turn.seg = null;
      turn.text = null;
      turn.textSource = '';
      break;
    case 'tool': {
      settleThinking(); // (it thought, then acted: "Thought for 3s", not "Thinking" for ever)
      finishReply(turn.text, turn.textSource);
      turn.approvalsWaiting ||= () => approvals.size > 0;
      const fallback = (TOOL_LABELS[event.name] || (() => unknownLabel(event)))(event.input || {}); // (never a raw tool name)
      const said = turn.text && turn.textSource?.trim() ? { el: turn.text, text: turn.text.textContent } : turn.lastSaid?.el.isConnected ? turn.lastSaid : null;
      turn.lastSaid = null; // (words before a step: that step's live line in the card, not a bubble)
      const step = window.stepUI ? window.stepUI.add(turn, { ...event, label: event.label || fallback }, { messages, append: appendToTurn, task: lastAsk?.text, runId }) : plainStep(event, event.label || fallback);
      turn.seg = null; // (thinking after this step is a row of its own, after it)
      if (said && window.stepUI?.narrate(turn, said.text)) said.el.remove();
      if (!event.id) step.className = 'step done';
      if (event.name === 'connector_done' && /^https:\/\//.test(String(event.link || ''))) step.append(' ', Object.assign(document.createElement('a'), { className: 'step-link', href: event.link, textContent: t('step.connectorOpen') })); // [connectors] what a write made, with its link
      if (ACTING_TOOLS.has(event.name)) step.dataset.acts = '1'; // it changes something on a page (Regenerate asks first)
      if (event.id) { turn.steps.set(event.id, step); startStepClock(); } // how long it has been going / took
      if (event.name === 'annotate') { step.dataset.tool = 'annotate'; step.dataset.marks = String(Array.isArray(event.input?.marks) ? event.input.marks.length : 0); }
      endStream();
      turn.text = null;
      turn.textSource = '';
      break;
    }
    case 'desktop_card': { // [desktop apps] another program: the turn's one activity card follows it (its window as the preview, its state in the status bar)
      if (window.stepUI?.desktop(turn, event, { messages, append: appendToTurn, runId })) { endThinking(); break; }
      const drawn = window.desktopCard?.update(event);
      if (!drawn) break;
      if (drawn.created) {
        endThinking();
        finishReply(turn.text, turn.textSource);
        endStream();
        turn.text = null;
        turn.textSource = '';
        const bubble = Object.assign(document.createElement('div'), { className: 'msg assistant desktop-cards' });
        bubble.append(drawn.card);
        appendToTurn(bubble);
        announce(t('desktopcard.announce', { app: event.app || '' }));
      }
      break;
    }
    case 'tool_update': { // a step shown early (its input still streaming) gets its real label
      const step = turn.steps.get(event.id);
      if (!step) break;
      const fallback = (TOOL_LABELS[event.name] || (() => unknownLabel(event)))(event.input || {}); // (never a raw tool name)
      if (window.stepUI) window.stepUI.update(turn, step, { ...event, label: event.label || fallback }); else if (event.label) { step.firstChild.textContent = event.label; step.title = event.label; }
      if (ACTING_TOOLS.has(event.name)) step.dataset.acts = '1';
      break;
    }
    case 'tool_done': {
      const step = turn.steps.get(event.id);
      if (!step) break;
      step.classList.remove('running', 'done', 'failed', 'stopped');
      step.classList.add(event.ok ? 'done' : event.stopped ? 'stopped' : 'failed');
      showStepTime(step, true);
      const plain = window.stepUI?.done(turn, step, event); // a built-in tool's failure reads as a sentence with a short reason
      if (event.ok && step.dataset.tool === 'annotate') annotateChip(step); // "Drew 4 marks" with Show again / Clear
      if (!event.ok && event.error && !plain) {
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
    case 'card_files': // the files the run wrote: clickable in its Files card
      window.stepUI?.filesMade(turn, event.files);
      break;
    case 'thumb': // the tab the AI works in, as a small picture for its Browser card
      window.stepUI?.thumb(turn, event);
      break;
    case 'screen_attached': // [screen context] the tab's screenshot (or its text) went along with the message
      screenChip([...messages.querySelectorAll('.msg.user')].pop(), event);
      break;
    case 'tabs_attached': // main read the picked tabs: what actually went along (a sleeping tab only by address)
      window.tabsAsk?.describeSent([...messages.querySelectorAll('.msg.user')].pop(), event.tabs || [], { final: true });
      break;
    case 'helper_card': // [acting helpers] one compact card per helper that acts in a tab of its own (agent.js parallelTasks)
      showHelperCard(event);
      break;
    case 'plan': { // [plan mode] propose_plan: the plan as a card with Run plan / Edit / Keep planning (renderer/plan-mode.js)
      endThinking();
      finishReply(turn.text, turn.textSource);
      endStream();
      turn.text = null;
      turn.textSource = '';
      const card = window.planModeUI?.card(event.plan);
      if (card) appendToTurn(card);
      break;
    }
    case 'approval':
      chatHost.needSidebar?.(); // a hidden sidebar left the task waiting with only a badge as a hint (app.js opens it)
      announce(event.helper ? `${t('approval.helper', { n: event.helper })} ${event.title || t('chat.approvalWaiting')}` : event.title || t('chat.approvalWaiting'));
      showApproval(event.approvalId, event.host, { action: event.action, title: event.title, query: event.query, args: event.args, tainted: event.tainted, noAlways: event.noAlways, upload: event.upload, note: event.note, fields: event.fields, detail: event.detail, allowLabel: event.allowLabel, denyLabel: event.denyLabel, helper: event.helper });
      moveWorkingToEnd();
      syncWorking();
      break;
    case 'send_grant': { // [connectors] the user said in this chat that the AI may send emails without asking: a standing row with Stop (agent.js recordTyped)
      if (!event.on || !window.assistant.sendStop || messages.querySelector('.send-grant:not(.ended)')) break;
      const row = appendToTurn(Object.assign(document.createElement('div'), { className: 'notice send-grant', textContent: t('send.grant') }));
      const stop = Object.assign(document.createElement('button'), { type: 'button', className: 'notice-action', textContent: t('send.stop') });
      stop.onclick = () => { window.assistant.sendStop(); stop.remove(); row.classList.add('ended'); row.textContent = t('send.stopped'); };
      row.append(' ', stop);
      break;
    }
    case 'send_pending': { // [connectors] an email goes out in 10 seconds unless Undo is pressed ("Sending to … — Undo")
      if (!window.assistant.sendUndo) break;
      const row = appendToTurn(Object.assign(document.createElement('div'), { className: 'notice send-pending', role: 'status' }));
      const undo = Object.assign(document.createElement('button'), { type: 'button', className: 'notice-action', textContent: t('send.undo') });
      const until = Date.now() + (Number(event.ms) || 10000);
      const text = () => t('send.pending', { to: String(event.to || '').slice(0, 120), s: Math.max(0, Math.ceil((until - Date.now()) / 1000)) });
      const label = Object.assign(document.createElement('span'), { textContent: text() });
      const tick = setInterval(() => { label.textContent = text(); }, 1000);
      undo.onclick = () => { undo.disabled = true; window.assistant.sendUndo(event.id); };
      row.append(label, ' ', undo);
      sendRows.set(event.id, { row, tick });
      break;
    }
    case 'send_pending_done': {
      const r = sendRows.get(event.id);
      if (!r) break;
      sendRows.delete(event.id);
      clearInterval(r.tick);
      r.row.textContent = t(event.result === 'undo' ? 'send.cancelled' : event.result === 'go' ? 'send.going' : 'send.stoppedSend');
      break;
    }
    case 'memory': { // [memory] the AI saved, changed or forgot a memory (ai/memory.js): said in the chat, with Undo, and Forget for what it kept
      const key = { add: 'memory.remembered', update: 'memory.updated', forget: 'memory.forgot' }[event.action];
      if (!key || !window.assistant.memory) break;
      const note = appendToTurn(Object.assign(document.createElement('div'), { className: 'notice memory-note', textContent: t(key, { text: event.text || '' }) }));
      const action = (label, done, run) => {
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'notice-action', textContent: label });
        button.onclick = async () => {
          for (const b of note.querySelectorAll('button')) b.disabled = true;
          const ok = await run().catch(() => false);
          for (const b of note.querySelectorAll('button')) b.remove();
          note.append(` ${ok ? done : t('memory.changedSince')}`);
        };
        note.append(' ', button);
      };
      if (event.token) action(t('memory.undo'), t('memory.undone'), () => window.assistant.memory.undo(event.token));
      if (event.action !== 'forget') action(t('memory.forget'), t('memory.forgotten'), () => window.assistant.memory.forget(event.id));
      break;
    }
    case 'notice': {
      if (event.stopped) turn.stopped = true;
      // A chain of "couldn't reach X, switched to Y" lines in a row says one thing: keep the newest only.
      if (event.fallback) for (const old of [...messages.querySelectorAll('.notice[data-fallback]')]) if (old.nextElementSibling === turn.working || old.nextElementSibling?.matches?.('.notice[data-fallback]')) old.remove();
      const notice = appendToTurn(Object.assign(document.createElement('div'), { className: event.stopped ? 'notice stopped' : 'notice', textContent: event.stopped ? t(turn.interrupted ? 'chat.interrupted' : 'chat.stopped') : event.text }));
      if (event.fallback) notice.dataset.fallback = '1';
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
      if (event.action === 'continue' || (event.stopped && lastAsk)) { // (after Stop too: the reply so far stays, and this asks it to go on)
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn notice-continue', textContent: t('chat.continue') });
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
  dropEmptyBubbles();
  finishReply(turn.text, turn.textSource, { latest: true });
  // A reply that ended on a step or a notice (stopped, or its last act was a tool) can be asked again too.
  if (!turn.failed && !turn.text?.querySelector?.('.reply-regen') && lastAsk && !turn.text?.source?.trim()) {
    const row = Object.assign(document.createElement('div'), { className: 'msg assistant reply-actions-only' });
    row.append(regenButton());
    turn.working.before(row);
  }
  if (!turn.failed) announce(turn.stopped || [...turn.steps.values()].some((s) => s.classList.contains('running') || s.classList.contains('stopped')) ? t('chat.replyStopped') : t('chat.replyDone'));
  labelReply(turn.text, event.model, event.auto || turn.auto, { at: Date.now(), versions: turn.versions });
  scrollToBottom(); // (the reply's copy button and label were added below its end)
  endStream();
  for (const old of messages.querySelectorAll(':scope > .msg.assistant.streaming')) { flushStreaming(old); old.classList.remove('streaming'); } // (a block a card or step moved on from)
  for (const step of turn.steps.values()) if (step.classList.contains('running')) step.className = 'step stopped';
  window.stepUI?.finalize(turn, { ...event, reply: turn.text?.source || '' });
  turn.working.remove();
  if (early) earlyEnded = { runId: event.runId, bubble: turn.text };
  else {
    if (event.undo) window.showRunUndo?.(append, event.undo); // [ai controls] extras.js
    aiTabsRunId = event.runId;
    if (event.aiTabs && event.aiTabs.mode !== 'close') window.showAiTabs?.(append, event.aiTabs, event.runId); // [ai manners] extras.js
  }
  // After Stop, or a reply that failed, the waiting messages are not sent on their own: they come back to the box (below).
  const backToBox = Boolean((turn.stopRequested || turn.failed) && !turn.interrupted);
  finishedRun = { runId, turn };
  turn = null;
  clearTimeout(stopTimer);
  setRunning(false);
  // They come back as a draft, to send or edit (the user just said stop, or the engine just failed: the next ones would likely fail too).
  // A question from the new-tab page that waits for a new chat of its own still goes.
  if (backToBox) { queuedToDraft(); if (line.mine(forOtherChat).some((q) => q.fresh)) setTimeout(sendQueued); } else setTimeout(sendQueued);
}

// [stop always works] The Stop button, Esc and Stop in the toolbar all come here. Main aborts the run (agent.js stop: the engine, its tools and
// its child processes); the reply's 'done' then ends the view. If nothing has ended it after STOP_WAIT_MS (the run was already gone in main, or its
// 'done' was lost), main is asked what is true (reconcile) and, if the view still says "running", it is cleared here: the reply is marked stopped,
// the dot and the working line go, the composer is free.
const STOP_WAIT_MS = 2000;
let stopTimer = null;
function stopReply() {
  window.assistant.stop(shownChatId || undefined);
  if (!running) return;
  if (turn) turn.stopRequested = true;
  const mine = runId;
  clearTimeout(stopTimer);
  stopTimer = setTimeout(async () => {
    if (!running || runId !== mine) return;
    try { await reconcile(); } catch {}
    if (!running || runId !== mine) return;
    if (!turn) { setRunning(false); return; } // (a Stop with no reply on screen: only the state is stale)
    turn.stopped = true;
    if (!turn.failed) appendToTurn(Object.assign(document.createElement('div'), { className: 'notice stopped', textContent: t('chat.stopped') }));
    finishTurn({ runId: mine }, { early: false });
  }, STOP_WAIT_MS);
}
window.chatStopReply = stopReply;
// The messages waiting for a reply that was stopped come back to the box (as clearChatView does for a chat that was left).
function queuedToDraft() {
  const mine = line.drain((q) => !q.fresh && !forOtherChat(q.chatId));
  for (const q of mine) q.bubble.remove();
  renderQueue();
  entriesToBox(mine);
}
// Messages that cannot go out now, as unsent text in the box (and their pictures as attachments): the box has a Send button.
function entriesToBox(list) {
  if (!list.some((q) => q.text || q.images?.length)) return;
  const texts = list.map((q) => q.text).filter(Boolean);
  if (texts.length) prompt.value = [prompt.value.replace(/\s+$/, ''), ...texts].filter(Boolean).join('\n');
  const images = list.flatMap((q) => q.images || []);
  if (images.length) { attachments = [...attachments, ...images].slice(0, MAX_ATTACH); renderAttachments(); }
  autosize();
  updateSend();
}
// What a view that is gone (reloaded, closed, crashed, the app restarted) left waiting in this chat (queueStore): still running here, it waits
// again as bubbles and goes out in its turn; otherwise it comes back to the box as unsent text. Once, by whoever shows the chat first.
function restoreCarried() {
  if (!queueStore || !shownChatId || draftHold || tempChatShown()) return;
  const got = queueStore.carried(shownChatId, { take: true });
  if (!got.length) return;
  const entries = got.map((e) => ({ ...e, images: (e.images || []).map((a) => (a.media_type && a.data ? { ...a, url: `data:${a.media_type};base64,${a.data}` } : a)) }));
  const rest = [];
  for (const e of entries) {
    if (running && !e.fresh) queueUp({ text: e.text, images: e.images, tabs: e.tabs, screen: e.screen, opts: e.opts, chatId: shownChatId });
    else rest.push(e);
  }
  entriesToBox(rest);
  if (entries.some((e) => e.imagesLost)) append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('chat.queued.imagesLost') }));
  if (!running && line.length) setTimeout(sendQueued);
}
setTimeout(() => restoreCarried(), window.chatQueue.STALE_MS + 1000); // (what a view that closed a moment ago left looked alive until now)


// The 'done' of a run whose reply ended early (reply_complete): the model label, Undo and the opened-tabs row. A message sent
// in between has its own turn on screen by now: the label still goes on the earlier reply, but its Undo / tabs row is left out
// (it would land under the new message), as the chat history keeps what the run did.
// An assistant bubble that never got any words (a block that was only blank, or one a step moved on from) is a thin empty bar: gone when the run ends.
function dropEmptyBubbles() {
  for (const b of messages.querySelectorAll(':scope > .msg.assistant:not(.reply-actions-only):not(.gen-pics):not(.ai-files):not(.desktop-cards)')) {
    if (b === turn?.text && turn.textSource?.trim()) continue; // (words that are still being drawn)
    if (b.textContent.trim() || b.querySelector('img, svg, video, canvas, button, table, hr, figure, math, pre')) continue;
    if (b === turn?.text) { turn.text = null; turn.textSource = ''; }
    b.remove();
  }
}
function lateDone(event) {
  const { bubble } = earlyEnded;
  earlyEnded = null;
  labelReply(bubble, event.model, event.auto, { at: Date.now() });
  if (turn) return;
  if (event.undo) window.showRunUndo?.(append, event.undo);
  aiTabsRunId = event.runId;
  if (event.aiTabs && event.aiTabs.mode !== 'close') window.showAiTabs?.(append, event.aiTabs, event.runId);
}

// A picture for a reply that already ended early (see onEvent): placed after that reply's text (or its last late picture), so a
// message sent meanwhile stays below it; with no anchor left on screen it goes at the end like a live one.
function latePicture(event) {
  const pic = Object.assign(document.createElement('div'), { className: 'msg assistant gen-pics' });
  pic.append(window.genImages.figure({ id: event.id, alt: event.alt || '', ...(event.credit ? { credit: event.credit } : {}), ...(event.caption ? { caption: event.caption } : {}) }));
  const anchor = earlyEnded.pics || earlyEnded.bubble;
  if (anchor?.isConnected) anchor.after(pic); else append(pic);
  earlyEnded.pics = pic;
  announce(t('genimg.made'));
}

// A file card for a reply that already ended early (see latePicture): placed after that reply's text or its last late card.
function lateFile(event) {
  if (!window.aiFiles || !event.file) return;
  const bubble = Object.assign(document.createElement('div'), { className: 'msg assistant ai-files' });
  const cardEl = window.aiFiles.card(event.file, { live: true });
  bubble.append(cardEl);
  const anchor = earlyEnded.files || earlyEnded.pics || earlyEnded.bubble;
  if (anchor?.isConnected) anchor.after(bubble); else append(bubble);
  earlyEnded.files = bubble;
  if (event.main) window.aiFiles.autoOpen(event.file, cardEl);
  announce(t('aifile.added', { name: event.file.name }));
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
// `extra`: { at, feedback, versions }, for the strip under the reply (chat-actions.js: version switch, time, thumbs).
function labelReply(bubble, modelId, auto = null, extra = {}) {
  flushStreaming(bubble);
  if (!bubble) return;
  if (modelId && !bubble.querySelector('.reply-model')) addModelLabel(bubble, modelId, auto);
  window.chatActions?.replyMeta(bubble, extra);
}
// A model's name as the picker shows it; null until the picker has it (the list loads a moment after the page).
function modelName(modelId) {
  const option = [...$('model').options].find((o) => o.value === modelId);
  if (!option) return null;
  // From main's list, not the <optgroup>: a lone group is drawn without one (see loadModels).
  const group = modelGroups.get(modelId) ?? option.parentElement?.label;
  // Local engines (Claude Code, Grok Build) already name themselves.
  return group === 'Claude' ? `Claude ${option.textContent}`
    : !group || /^Your .* account$/.test(group) ? option.textContent
    : `${group} · ${option.textContent}`;
}
// A reopened chat shows where you switched models, as the live chat did ("Now using X"): before the message whose reply came from a
// different model than the reply before it. Replies Auto chose (the model can differ without you switching) never count.
function markModelSwitches(entries) {
  let prev = null;
  for (const { bubble, item } of entries) {
    if (item.auto || !item.model) { prev = null; continue; }
    const name = prev && prev !== item.model ? modelName(item.model) : null;
    prev = item.model;
    if (!name) continue;
    let ask = bubble.previousElementSibling;
    while (ask && !ask.matches('.msg.user')) ask = ask.previousElementSibling;
    if (ask) ask.before(Object.assign(document.createElement('div'), { className: 'notice model-switch restored', textContent: t('models.switched', { name }) }));
  }
}
function addModelLabel(bubble, modelId, auto) {
  const name = modelName(modelId) ?? modelId;
  // [auto model] A reply Auto chose the model for says so ("Auto · Claude Haiku 5.5"), and why in its tooltip.
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
    askAgain(true);
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
      const text = (window.markdownPlainScripts ? window.markdownPlainScripts(source) : source).trim(); // the markdown as written (lists, code, formulas as their LaTeX), as ChatGPT and Claude copy it
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
  window.chatActions?.noteButton(bubble, source); // "Add to notes" (renderer/chat-actions.js)
}

// ---------- permissions: how much the sidebar's AI asks (the bolt in the sidebar head) ----------
// Three levels (features/permission-mode.js): Ask (default), Auto-allow actions (no per-site cards), Bypass permissions (every
// approval card is answered allow, and a step says so; agent.js askApproval). The bolt opens a small menu; turning a level up takes
// a second click on the same line within 4 s, turning it down takes one. The composer shows a badge while Bypass is on.

const PERM_MODES = ['ask', 'auto', 'bypass'];
const PERM_ICONS = { // a shield (asks first), a bolt (acts on its own), a warning triangle (asks nothing)
  ask: '<path d="M8 1.8 3 3.8v4c0 3 2.2 5 5 6.2 2.8-1.2 5-3.2 5-6.2v-4z"/>',
  auto: '<path d="M9 1.8 3.6 9h4l-.6 5.2L12.4 7h-4z"/>',
  bypass: '<path d="M8 2 14.2 13H1.8z"/><path d="M8 6.3v3.2M8 11.3v.2"/>',
};
let permMode = 'ask';
let permArmed = null; // { mode, timer }: the level waiting for its confirming click
const permMenu = Object.assign(document.createElement('div'), { className: 'perm-menu', id: 'perm-menu', hidden: true });
permMenu.setAttribute('role', 'menu');
permMenu.setAttribute('aria-label', t('sidebar.perm.title'));
const permItems = new Map();
for (const mode of PERM_MODES) {
  const item = Object.assign(document.createElement('button'), { type: 'button', className: 'perm-item', id: `perm-${mode}` });
  item.dataset.mode = mode;
  item.setAttribute('role', 'menuitemradio');
  item.innerHTML = '<span class="perm-name"></span><span class="perm-desc"></span>';
  item.onclick = () => chooseMode(mode);
  permItems.set(mode, item);
  permMenu.append(item);
}
const permSettings = Object.assign(document.createElement('button'), { type: 'button', className: 'perm-item perm-settings', id: 'perm-settings' });
permSettings.setAttribute('role', 'menuitem');
permSettings.innerHTML = '<span class="perm-name"></span>';
permSettings.firstChild.textContent = t('sidebar.perm.settings');
permSettings.onclick = () => { closePermMenu(false); window.lumenPrefs?.openSettingsPage('ask-before-acting'); };
permMenu.append(permSettings);
permMenu.append(Object.assign(document.createElement('p'), { className: 'perm-note', id: 'perm-note', textContent: t('sidebar.perm.note') }));
const permButton = $('auto-allow');
(permButton.closest('.sidebar-head') || permButton.parentElement).append(permMenu);
permButton.setAttribute('aria-haspopup', 'menu');
permButton.setAttribute('aria-expanded', 'false');

// ---------- helpers: whether the AI may hand read-only jobs to helpers working side by side (the delegate tool) ----------
// The same setting as Settings → AI and agents → "Let the AI use helpers to work in parallel" (aiSubagents): main keeps it and tells every view,
// so the two follow each other. Off: the next message is sent without the tool.
const helpersButton = $('helpers-btn');
let helpersMode = 'auto'; // off | auto | on (Auto: the AI gets helpers for a request with several separate parts)
const HELPERS_NEXT = { auto: 'on', on: 'off', off: 'auto' };
const HELPERS_STATE = { auto: 'sidebar.state.auto', on: 'sidebar.state.on', off: 'sidebar.state.off' };
const helpersModeOf = (v) => (v === true || v === 'on' ? 'on' : v === false || v === 'off' ? 'off' : 'auto');
function renderHelpers() {
  if (!helpersButton) return;
  helpersButton.setAttribute('aria-checked', helpersMode === 'auto' ? 'mixed' : String(helpersMode === 'on')); // a labelled row in the More menu: "Helpers  Auto" (mixed: the AI decides)
  helpersButton.title = t(`sidebar.helpers.${helpersMode}`);
  const state = $('helpers-state');
  if (state) state.textContent = t(HELPERS_STATE[helpersMode]);
}
if (helpersButton) {
  helpersButton.onclick = async () => {
    const got = await window.assistant.helpers?.(HELPERS_NEXT[helpersMode]);
    if (got != null) helpersMode = helpersModeOf(got);
    renderHelpers();
  };
  window.addEventListener('lumen:helpers', (e) => { helpersMode = helpersModeOf(e.detail); renderHelpers(); }); // Settings → AI and agents changed it
  window.assistant.helpers?.().then((mode) => { if (mode != null) helpersMode = helpersModeOf(mode); renderHelpers(); });
  renderHelpers();
}

// The composer's persistent indicator: only while Bypass is on; it switches to the next mode, like the header's button.
const permBadge = document.createElement('button');
permBadge.type = 'button';
permBadge.className = 'bypass-badge';
permBadge.id = 'bypass-badge';
permBadge.hidden = true;
permBadge.title = t('composer.bypass.title');
permBadge.innerHTML = '<span class="bb-pill"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 14.2 13H1.8z"/><path d="M8 6.3v3.2M8 11.3v.2"/></svg><span class="bb-text" aria-hidden="true"></span><span class="bb-full"></span></span>';
permBadge.querySelector('.bb-text').textContent = t('composer.bypass.short'); // compact on screen; the full words are read aloud
permBadge.querySelector('.bb-full').textContent = t('composer.bypass');
permBadge.addEventListener('click', () => cycleMode()); // [mode cycle] the same click as the header's button (Settings: right-click the button, or the Settings row of its menu)
if ($('composer-status')) $('composer-status').append(permBadge); // the quiet status line above the box (usage on the left, this on the right)
else $('hands-off')?.after(permBadge);

function disarmPerm() {
  if (permArmed) clearTimeout(permArmed.timer);
  permArmed = null;
}
function renderPerm() {
  permButton.dataset.mode = permMode;
  permButton.setAttribute('aria-pressed', String(permMode !== 'ask'));
  // [mode cycle] One click goes to the next mode (Ask > Auto > Bypass > Ask); the tooltip names it. Going up asks for a second click first.
  const next = nextMode();
  const nextName = t(`sidebar.perm.${next}`);
  let tip = permArmed ? t('sidebar.perm.cycle.confirm', { mode: nextName }) : t('sidebar.perm.cycle', { mode: nextName, now: t(`sidebar.perm.${permMode}`) });
  if (permMode === 'bypass') tip += `
${t('sidebar.perm.bypass.desc')}`; // what Bypass means, on hover
  permButton.title = tip;
  permButton.dataset.next = next;
  permButton.classList.toggle('armed', Boolean(permArmed));
  permButton.setAttribute('aria-label', `${t('sidebar.perm.label', { mode: t(`sidebar.perm.${permMode}`) })}. ${tip}`); // the name says the state, not only the feature
  // Visible state: the icon of the mode and its name, always ("Ask", "Auto", "Bypass").
  permButton.querySelector('svg').innerHTML = PERM_ICONS[permMode];
  let stateLabel = permButton.querySelector('.perm-state');
  if (!stateLabel) { stateLabel = Object.assign(document.createElement('span'), { className: 'perm-state' }); permButton.append(stateLabel); }
  stateLabel.textContent = permArmed ? t('sidebar.perm.armed', { mode: t(`sidebar.perm.short.${next}`) }) : t(`sidebar.perm.short.${permMode}`);
  permBadge.hidden = permMode !== 'bypass';
  permBadge.title = tip;
  permBadge.dataset.mode = permMode;
  for (const [mode, item] of permItems) {
    const armed = permArmed?.mode === mode;
    item.setAttribute('aria-checked', String(mode === permMode));
    item.classList.toggle('armed', armed);
    item.classList.toggle('danger', mode === 'bypass');
    item.querySelector('.perm-name').textContent = t(`sidebar.perm.${mode}`);
    item.querySelector('.perm-desc').textContent = armed ? t('sidebar.perm.confirm') : t(`sidebar.perm.${mode}.desc`);
  }
}
async function setPermMode(mode) {
  const got = await window.assistant.permissionMode?.(mode);
  permMode = PERM_MODES.includes(got) ? got : permMode;
  renderPerm();
}
const nextMode = () => PERM_MODES[(PERM_MODES.indexOf(permMode) + 1) % PERM_MODES.length];
// [mode cycle] The header button and the composer's Bypass badge both come here. Going up keeps the confirming second click the
// menu always had (a line that says so, 4 s); going down (Bypass > Ask) is one click.
function cycleMode() { chooseMode(nextMode()); }
function chooseMode(mode) {
  if (mode === permMode) { closePermMenu(); return; }
  const raising = PERM_MODES.indexOf(mode) > PERM_MODES.indexOf(permMode);
  if (raising && permArmed?.mode !== mode) {
    disarmPerm();
    permArmed = { mode, timer: setTimeout(() => { permArmed = null; renderPerm(); }, 4000) };
    renderPerm();
    return;
  }
  disarmPerm();
  setPermMode(mode);
  closePermMenu();
}
function openPermMenu() {
  permMenu.hidden = false;
  permButton.setAttribute('aria-expanded', 'true');
  renderPerm();
  permItems.get(permMode)?.focus();
}
function closePermMenu(refocus = true) {
  if (permMenu.hidden) return;
  permMenu.hidden = true;
  disarmPerm();
  permButton.setAttribute('aria-expanded', 'false');
  renderPerm();
  if (refocus) permButton.focus();
}
permButton.onclick = () => cycleMode();
permButton.addEventListener('contextmenu', (e) => { e.preventDefault(); if (permMenu.hidden) openPermMenu(); else closePermMenu(); }); // the full menu (and Settings) is a right-click away
permButton.addEventListener('keydown', (e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && permMenu.hidden) { e.preventDefault(); openPermMenu(); } }); // ...or an arrow key
document.addEventListener('mousedown', (e) => { if (!permMenu.hidden && !permMenu.contains(e.target) && !permButton.contains(e.target)) closePermMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !permMenu.hidden) { e.preventDefault(); closePermMenu(); } });
permMenu.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...permItems.values(), permSettings];
  const at = items.indexOf(document.activeElement);
  items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
});
// A card's "Allow on all sites" turns Auto-allow on (it never lowers Bypass).
const setAutoAllow = (on) => setPermMode(on ? 'auto' : 'ask');
window.addEventListener('lumen:permission-mode', (e) => { if (PERM_MODES.includes(e.detail)) { permMode = e.detail; renderPerm(); } }); // Settings → AI and agents changed it
window.assistant.permissionMode?.().then((mode) => { if (PERM_MODES.includes(mode)) permMode = mode; renderPerm(); });
renderPerm();

// ---------- inline approval before Claude acts on a new site ----------

const approvals = new Map(); // approvalId -> { card, host }

// `action: 'open'`: the AI has read page content in this chat and wants to open a new site (which
// could carry that content there), or search for `query`; `action: 'script'`: it wants to run a
// script on a site after reading page content; anything else is the usual "interact with this site" card.
function showApproval(approvalId, host, opts = {}) {
  showApprovalCard(approvalId, host, opts);
  if (opts.helper) markHelperApproval(approvalId, opts.helper);
}

// [acting helpers] A card a helper is waiting on says which one: "Helper 2: Allow Claude to interact with shop.example?"
function markHelperApproval(approvalId, n) {
  const card = approvals.get(approvalId)?.card;
  const title = card?.querySelector('.approval-title');
  if (!title) return;
  const tag = t('approval.helper', { n });
  title.textContent = `${tag} ${title.textContent}`;
  card.setAttribute('aria-label', `${tag} ${card.getAttribute('aria-label') || title.textContent}`);
  card.dataset.helper = String(n);
}

// ---------- [acting helpers] helper cards: one per helper that acts in a background tab of its own (parallel_tasks) ----------
// Its number and job, what it is doing now, a chip for its tab (a click shows the tab, in the sidebar) and Stop (that helper only;
// Stop in the chat stops them all). The card stays after the helper is done, with how it ended.
const helperCards = new Map(); // event.key -> card
function showHelperCard(e) {
  let card = helperCards.get(e.key);
  if (!card || !card.isConnected) {
    card = Object.assign(document.createElement('div'), { className: 'helper-card' });
    card.setAttribute('role', 'group');
    const head = Object.assign(document.createElement('div'), { className: 'helper-card-head' });
    const name = Object.assign(document.createElement('span'), { className: 'helper-card-name', textContent: t('helper.name', { n: e.n }) });
    const state = Object.assign(document.createElement('span'), { className: 'helper-card-state' });
    head.append(name, state);
    const task = Object.assign(document.createElement('p'), { className: 'helper-card-task', textContent: e.task || '' });
    const step = Object.assign(document.createElement('p'), { className: 'helper-card-step' });
    const actions = Object.assign(document.createElement('div'), { className: 'helper-card-actions' });
    const chip = Object.assign(document.createElement('button'), { type: 'button', className: 'helper-card-tab', textContent: t('helper.tab'), hidden: true });
    chip.title = t('helper.tabTitle');
    chip.onclick = () => { const id = Number(card.dataset.tab); if (Number.isInteger(id)) window.browser?.switchTab?.(id); };
    if (!window.browser?.switchTab) chip.disabled = true; // (the full-page chat has no tab strip to switch in)
    const stop = Object.assign(document.createElement('button'), { type: 'button', className: 'btn helper-card-stop', textContent: t('helper.stop') });
    stop.onclick = () => { stop.disabled = true; window.assistant.stopHelper?.(e.key); };
    actions.append(chip, stop);
    card.append(head, task, step, actions);
    appendToTurn(card);
    helperCards.set(e.key, card);
  }
  const ended = ['done', 'timeout', 'failed', 'stopped'].includes(e.status);
  const label = t(`helper.status.${ended ? e.status : 'working'}`);
  card.querySelector('.helper-card-state').textContent = label;
  card.querySelector('.helper-card-step').textContent = ended ? '' : e.step || '';
  card.setAttribute('aria-label', `${t('helper.name', { n: e.n })}: ${label}`);
  card.classList.toggle('ended', ended);
  if (Number.isInteger(e.tabId)) { card.dataset.tab = String(e.tabId); card.querySelector('.helper-card-tab').hidden = false; }
  if (ended) card.querySelector('.helper-card-stop').hidden = true;
}

function showApprovalCard(approvalId, host, { action, title: openTitle, query, args, tainted, noAlways, upload, phase, undone, detail: cardDetail, allowLabel, denyLabel, warn, note, fields } = {}) {
  if (action === 'content-loss') return showContentLossApproval(approvalId, host, { title: openTitle, detail: args, phase, undone }); // [content guard]
  if (action === 'upload' || action === 'upload-pick') return showUploadApproval(approvalId, host, { action, upload }); // [uploads]
  if (action === 'tool') return showToolApproval(approvalId, host, { title: openTitle, args, tainted, noAlways, note, fields, allowLabel, denyLabel, warn, detail: note === 'close' ? cardDetail : undefined }); // ([close guard] the AI closing a tab of the user's: its own sentence under the title)
  if (action === 'app') return showToolApproval(approvalId, host, { title: openTitle, args, detail: cardDetail, noAlways, allowLabel, app: true }); // [desktop apps] Allow the AI to use <app>? Once / Always / No
  if (action === 'signin') return showSignInApproval(approvalId, host, { noAlways }); // [signed-in sites]
  if (action === 'file') return showFileApproval(approvalId, host, { title: openTitle }); // [screen context]
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

// [content guard] ai/content-guard.js: a change that would remove, or has removed, content the AI didn't write (text, images, tables).
// phase 'before': about to happen (Go ahead / Don't do it). phase 'after': it happened and was put back for now when it could be
// (Keep the change / Undo it); when it couldn't be put back the choice is only whether the run carries on. Escape is the safe answer
// (don't / undo / stop); Enter on the card does nothing, so a key pressed for something else can't keep a loss.
function showContentLossApproval(approvalId, host, { title: heading, detail: text, phase, undone }) {
  const before = phase === 'before';
  const card = document.createElement('div');
  card.className = 'approval approval-content-loss';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', heading || host);
  const title = Object.assign(document.createElement('p'), { className: 'approval-title', textContent: heading || host });
  const detail = Object.assign(document.createElement('p'), { className: 'approval-detail', textContent: text || '' });
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const no = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: before ? t('approval.content.dont') : undone ? t('approval.content.undo') : t('approval.content.stop') });
  const yes = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: before ? t('approval.content.go') : undone ? t('approval.content.keep') : t('approval.content.continue') });
  const answer = (ok) => {
    if (card.classList.contains('answered')) return;
    card.classList.add('answered');
    no.disabled = true;
    yes.disabled = true;
    window.assistant.approve?.(approvalId, ok);
  };
  no.onclick = () => answer(false);
  yes.onclick = () => answer(true);
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); answer(false); } });
  actions.append(no, yes);
  card.append(title, detail, actions);
  append(card, { force: true }); // waiting for you: always in view
  approvals.set(approvalId, { card, host });
  scrollToBottom();
}

// A tool from an MCP server the user added (agent.js allowExternal): the card shows exactly what
// would be sent. "Always allow" is per tool and isn't offered once the chat has read page content.
// [connectors] A write in a connected service (note 'connector') with `fields`: where it goes, then its text in boxes the user can
// edit; Allow sends what the boxes hold. Only a real click allows it (no Enter, no scripted click).
function showToolApproval(approvalId, host, { title: heading, args, tainted, terminal = false, detail: ownDetail, noAlways = false, allowLabel, denyLabel, warn = '', app = false, note = '', fields = null }) {
  const card = document.createElement('div');
  card.className = terminal ? 'approval approval-tool approval-terminal' : 'approval approval-tool';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', heading || t('approval.tool.use', { host }));
  const editing = note === 'connector' && Array.isArray(fields?.list) && fields.list.length > 0;
  const title = Object.assign(document.createElement('p'), { className: 'approval-title', textContent: heading || t('approval.tool.use', { host }) });
  const detail = Object.assign(document.createElement('p'), {
    className: 'approval-detail',
    textContent: ownDetail ? String(ownDetail)
      : terminal
      ? t('approval.tool.terminal')
      : tainted
        ? t('approval.tool.tainted')
        : note === 'connector' ? `${t('approval.connector.details')}${editing ? ` ${t('approval.connector.edit')}` : ''}` : t('approval.tool.details'), // (a connected service: the change it would make, in the user's own account)
  });
  const pre = Object.assign(document.createElement('pre'), { className: 'approval-args', textContent: editing ? String(fields.fixed || '') : args || '{}' });
  const boxes = editing ? fields.list.filter((f) => f && typeof f.key === 'string').map((f) => {
    const box = Object.assign(document.createElement(f.multiline ? 'textarea' : 'input'), { className: 'approval-edit', value: String(f.value ?? ''), maxLength: Number(f.max) || 200, spellcheck: true });
    if (f.multiline) box.rows = Math.min(12, Math.max(3, String(f.value ?? '').split('\n').length + 1)); else box.type = 'text';
    box.dataset.key = f.key;
    box.setAttribute('aria-label', String(f.label || f.key));
    const label = Object.assign(document.createElement('label'), { className: 'approval-edit-label' });
    label.append(Object.assign(document.createElement('span'), { textContent: String(f.label || f.key) }), box);
    return { key: f.key, box, label };
  }) : [];
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const deny = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: denyLabel ? String(denyLabel) : t('approval.deny') });
  const allow = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: allowLabel ? String(allowLabel) : t(app ? 'approval.app.once' : 'approval.once') });
  const always = (tainted && !terminal) || noAlways ? null : Object.assign(document.createElement('button'), { type: 'button', className: 'btn approval-always', textContent: app ? t('approval.app.always') : terminal ? t('approval.terminal.always') : t('approval.tool.always'), title: app ? t('approval.app.always.title') : terminal ? t('approval.terminal.always.title') : t('approval.tool.always.title') });
  const answer = (ok) => {
    if (card.classList.contains('answered')) return;
    card.classList.add('answered');
    for (const b of [deny, allow, always]) if (b) b.disabled = true;
    window.assistant.approve?.(approvalId, ok);
  };
  deny.onclick = () => answer(false);
  allow.onclick = note === 'connector'
    ? (e) => { if (e.isTrusted) answer(editing ? { edits: Object.fromEntries(boxes.map((b) => [b.key, b.box.value])) } : true); } // (a real click only)
    : () => answer(true);
  if (always) always.onclick = () => answer('always');
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === card && note !== 'connector' && note !== 'close') { e.preventDefault(); answer(true); }
    else if (e.key === 'Escape' && !/^(INPUT|TEXTAREA)$/.test(e.target?.tagName || '')) { e.preventDefault(); answer(false); } // (Escape in a box being edited keeps the card and its edits)
  });
  actions.append(...[deny, always, allow].filter(Boolean));
  const warning = warn ? Object.assign(document.createElement('p'), { className: 'approval-warn', role: 'alert', textContent: String(warn) }) : null; // [connectors] a send to an address the user didn't type
  card.append(title, ...(warning ? [warning] : []), detail, ...(editing && !fields.fixed ? [] : [pre]), ...boxes.map((b) => b.label), actions);
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

// [screen context] "Share <file> with the AI?": the message points at a file on this computer in the tab in front (agent.js screenAskFile).
// Answers: Don't allow (false), Allow for this chat (true), Allow always for this file ('always', kept in Settings). Enter and Escape don't answer for
// you: the card is about a file of yours, so it is only ever answered by a click.
function showFileApproval(approvalId, host, { title: heading } = {}) {
  const card = document.createElement('div');
  card.className = 'approval approval-file';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  const shown = heading || t('approval.file', { file: host });
  card.setAttribute('aria-label', shown);
  const title = Object.assign(document.createElement('p'), { className: 'approval-title', textContent: shown });
  const detail = Object.assign(document.createElement('p'), { className: 'approval-detail', textContent: t('approval.detail.file') });
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const button = (text, cls) => Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: text });
  const deny = button(t('approval.file.no'), 'btn');
  const once = button(t('approval.file.chat'), 'btn primary');
  const always = button(t('approval.file.always'), 'btn approval-always');
  const answer = (ok) => {
    if (card.classList.contains('answered')) return;
    card.classList.add('answered');
    for (const b of [deny, once, always]) b.disabled = true;
    window.assistant.approve?.(approvalId, ok);
  };
  deny.onclick = () => answer(false);
  once.onclick = () => answer(true);
  always.onclick = () => answer('always');
  actions.append(deny, always, once);
  card.append(title, detail, actions);
  append(card, { force: true }); // waiting for you: always in view
  approvals.set(approvalId, { card, host, file: true });
  scrollToBottom();
}

// [uploads] upload_file (features/upload-files.js, agent.js uploadFile). Two cards:
//   'upload'       the AI wants to put files the user attached to this chat into a page: the names and the site, Upload / Don't upload.
//   'upload-pick'  it needs a file the user has not attached: "Choose file…" opens the OS picker (the user picks; the AI only learns
//                  the name), Cancel declines. The field's label and accepted types say what is being asked for.
function showUploadApproval(approvalId, host, { action, upload = {} }) {
  const picking = action === 'upload-pick';
  const card = document.createElement('div');
  card.className = 'approval approval-upload';
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  const agentName = assistantIdentity?.name || t('approval.theAi');
  const names = (upload.files || []).map((f) => f.name).join(', ');
  const text = picking ? t('approval.upload.pick', { name: agentName, host }) : t('approval.upload.send', { name: agentName, names, host });
  const shownHeading = text;
  card.setAttribute('aria-label', shownHeading);
  const title = Object.assign(document.createElement('p'), { className: 'approval-title', textContent: shownHeading });
  card.append(title);
  if (!picking) {
    const list = document.createElement('ul');
    list.className = 'approval-files';
    for (const f of upload.files || []) list.append(Object.assign(document.createElement('li'), { textContent: `${f.name} · ${fileSize(f.size)}` }));
    card.append(list);
  } else if (upload.label || upload.acceptText) {
    const what = [upload.label ? t('approval.upload.for', { label: upload.label }) : '', upload.acceptText ? t('approval.upload.accepts', { types: upload.acceptText }) : '', upload.multiple ? t('approval.upload.several') : ''].filter(Boolean).join(' · ');
    card.append(Object.assign(document.createElement('p'), { className: 'approval-what', textContent: what }));
  }
  card.append(Object.assign(document.createElement('p'), { className: 'approval-detail', textContent: picking ? t('approval.detail.uploadPick') : t('approval.detail.uploadSend') }));
  const problem = Object.assign(document.createElement('p'), { className: 'approval-problem', hidden: true });
  problem.setAttribute('role', 'alert');
  card.append(problem);
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const deny = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: picking ? t('approval.cancel') : t('approval.upload.deny') });
  const go = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: picking ? t('approval.upload.choose') : t('approval.upload.allow') });
  const lock = () => { card.classList.add('answered'); deny.disabled = true; go.disabled = true; };
  const entry = { card, host, upload: true, picking };
  deny.onclick = () => { if (card.classList.contains('answered')) return; lock(); window.assistant.approve?.(approvalId, false); };
  go.onclick = async () => {
    if (card.classList.contains('answered')) return;
    if (!picking) { lock(); window.assistant.approve?.(approvalId, true); return; }
    go.disabled = true; // (while the picker is open)
    problem.hidden = true;
    let result;
    try { result = await window.assistant.uploads?.choose(approvalId); } catch { result = null; }
    if (result?.ok) { entry.names = result.names || []; lock(); return; } // (main answered the AI's call; approval_done follows)
    go.disabled = false;
    if (result?.error) { problem.textContent = result.error; problem.hidden = false; }
    go.focus();
  };
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); deny.click(); }
    else if (e.key === 'Enter' && e.target === card && !picking) { e.preventDefault(); go.click(); }
  });
  actions.append(deny, go);
  card.append(actions);
  append(card, { force: true }); // waiting for you: always in view
  approvals.set(approvalId, entry);
  scrollToBottom();
}

function resolveApproval(approvalId, ok, names) {
  const entry = approvals.get(approvalId);
  if (!entry) return;
  approvals.delete(approvalId);
  if (names) entry.names = names; // [uploads] the file the user chose
  const { card, host, tool, signin, file } = entry;
  card.className = ok ? 'approval resolved' : 'approval resolved denied';
  card.removeAttribute('tabindex');
  card.removeAttribute('role');
  card.removeAttribute('aria-label');
  card.textContent = entry.upload ? (entry.picking ? (ok ? t('approval.upload.chosen', { host, names: (entry.names || []).join(', ') }) : t('approval.upload.notChosen', { host })) : (ok ? t('approval.upload.allowed', { host }) : t('approval.upload.denied', { host })))
    : file ? t(ok === 'always' ? 'approval.file.allowedAlways' : ok ? 'approval.file.allowed' : 'approval.file.denied', { host }) // [screen context]
    : signin ? t(ok === 'always' ? 'approval.signin.allowedAlways' : ok ? 'approval.signin.allowedOnce' : 'approval.signin.denied', { host }) // [signed-in sites]
    : tool ? (ok ? t('approval.allowedTool', { host }) : t('approval.deniedTool', { host })) : ok ? t('approval.allowed', { host }) : t('approval.denied', { host });
  syncWorking();
  if (document.activeElement === document.body) prompt.focus();
}

// ---------- chat restored from the last session ----------

// The files a saved message carried (main keeps them under their refs): chips, and the refs again if the message is asked again.
const restoredFiles = (files) => (Array.isArray(files) ? files : []).filter((f) => f && typeof f.ref === 'string' && typeof f.name === 'string').map((f) => ({ file: true, name: f.name, size: Number(f.size) || 0, type: String(f.type || ''), ref: f.ref }));

// Also used by renderer/chats.js to show a chat picked from the history list.
function showHistory(items, loaded = false) {
  if (!loaded && !window.stepUI && Array.isArray(items) && items.some((i) => i && i.cards)) { loadStepUI().then(() => showHistory(items, true)); return; } // (a chat with cards waits for their code)
  restoring = true;
  try { renderHistory(items); } finally { restoring = false; }
  scrollToBottom(); // (the "jump to latest" button follows where the view ended)
  if (pendingView) applyView(); // (the chat comes back where it was left)
}
// A long chat is drawn newest first: the last few exchanges at once (about a screenful), the older ones a slice at a time after it, above them,
// so opening or switching to a long chat never holds the window up for the whole chat (one slice is a few milliseconds of work).
const FIRST_DRAW = { chars: 3000, items: 1 }; // the newest part: at least this much (characters of text, or items), then to the start of an exchange
const LATER_DRAW = { chars: 2500, items: 1 }; // each slice of the older part
const itemSize = (item) => (item.text ? item.text.length : 0) + (item.images?.length || 0) * 400 + (item.generated?.length || 0) * 400 + 120;
// Where the newest part starts (0: the whole chat is drawn at once). It begins at one of your messages, so every part is whole exchanges.
function historySplit(items, { chars, items: count } = FIRST_DRAW) {
  let start = items.length;
  let size = 0;
  while (start > 0 && (items.length - start < count || size < chars)) { start--; size += itemSize(items[start]); }
  while (start > 0 && items[start].role !== 'user') start--;
  return start;
}
function renderHistory(items) {
  if (!Array.isArray(items) || !items.length || messages.querySelector('.msg')) return;
  const cut = historySplit(items);
  const newest = renderLatest(cut ? items.slice(cut) : items);
  if (cut) drawEarlier(items.slice(0, cut), newest);
}
function drawEarlier(older, newest) {
  const mine = ++historyDrawing;
  let end = older.length;
  let below = newest; // the first reply entry of what is drawn below the next slice (a model switch between two slices is marked from it)
  let handle = null;
  const cancel = () => { if (handle == null) return; if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle); clearTimeout(handle); handle = null; };
  const step = (idle) => {
    cancel();
    if (mine !== historyDrawing || !messages.isConnected) return;
    if (idle && (navigator.scheduling?.isInputPending?.() || performance.now() - typedAt < 600)) { later(); return; } // (a key is waiting, or someone is typing: the older messages wait)
    const start = historySplit(older.slice(0, end), LATER_DRAW);
    const slice = older.slice(start, end);
    const fragment = document.createDocumentFragment();
    const userEntries = [];
    const replyEntries = [];
    historyTarget = fragment;
    try { drawItems(slice, userEntries, replyEntries); } finally { historyTarget = null; }
    decorateEntries(userEntries, replyEntries);
    if (below && replyEntries.length) markModelSwitches([replyEntries[replyEntries.length - 1], below]);
    // Put in above everything drawn so far, keeping what is on screen where it is.
    const first = [...messages.children].find((el) => el.id !== 'empty');
    const before = messages.scrollHeight;
    const top = messages.scrollTop;
    messages.insertBefore(fragment, first || null);
    const atTop = top <= 1; // (held at the very top, as with Home: it stays there and the next slice follows at once, down to the first message)
    messages.scrollTop = atTop ? 0 : top + (messages.scrollHeight - before);
    const waiting = pendingView ? !applyView() : false; // (a position further up than was drawn: the older parts come at once)
    if (replyEntries.length) below = replyEntries[0];
    end = start;
    if (end > 0) { if (atTop || waiting) { cancel(); handle = setTimeout(step, 0); } else later(); }
  };
  // Older slices wait for idle time (a tab switch, a key or a scroll comes first); a quick scroll to the top asks for the next slice at once.
  const later = () => { cancel(); handle = typeof requestIdleCallback === 'function' ? requestIdleCallback(() => step(true), { timeout: 400 }) : setTimeout(() => step(true), 50); };
  const onScroll = () => { if (mine !== historyDrawing || end <= 0) messages.removeEventListener('scroll', onScroll); else if (messages.scrollTop < 400) step(); };
  messages.addEventListener('scroll', onScroll, { passive: true });
  later();
}
function drawItems(items, userEntries, replyEntries) {
  // A turn's narration lines (text before its steps) were the card's live line while it ran: a card that is drawn again has no bubbles for them,
  // only the final answer, under the card.
  const narration = new Set();
  let before = [];
  for (const it of items) {
    if (it.role === 'user') before = [];
    else if (it.role === 'assistant') {
      if (it.cards && Array.isArray(it.tools) && it.tools.length && window.stepUI) { for (const n of before) narration.add(n); before = []; }
      else if (it.text && !it.tools?.length && !it.generated?.length && !it.outFiles?.length && !('steps' in it)) before.push(it);
      else before = [];
    }
  }
  for (const item of items) {
    if (item.plan && window.planModeUI) { // [plan mode] a proposed plan: its card again, after any words that came with it
      if (item.text && !narration.has(item)) drawItems([{ ...item, plan: null }], userEntries, replyEntries);
      append(window.planModeUI.card(item.plan));
      continue;
    }
    if (narration.has(item)) continue;
    const bubble = document.createElement('div');
    if (item.role === 'user') {
      bubble.className = 'msg user';
      const images = (item.images || []).filter((src) => typeof src === 'string' && src.startsWith('data:image/'));
      if (images.length) {
        const row = document.createElement('div');
        row.className = 'msg-images';
        images.forEach((src, i) => { const im = Object.assign(document.createElement('img'), { src, alt: t('chat.imageN', { n: i + 1 }) }); window.genImages?.zoomable(im); row.append(im); });
        bubble.append(row);
      }
      const files = restoredFiles(item.files);
      if (files.length) bubble.append(fileChips(files));
      if (item.text) bubble.append(document.createTextNode(item.text));
      if (item.screen) screenChip(bubble, { id: item.screen.id, kind: item.screen.kind, title: item.screen.title, thumb: typeof item.screen.image === 'string' && item.screen.image.startsWith('data:image/') ? item.screen.image : '' });
      bubbleAsks.set(bubble, { text: item.text || '', images: [...images.map((src) => { const [, media_type, data] = src.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/) || []; return { media_type, data, url: src }; }).filter((a) => a.data), ...files], tabs: null });
      if (item.read) setMark(bubble, 'read'); // (a chat saved before the marks existed shows none)
      userEntries.push({ bubble, item });
    } else if (item.role === 'assistant' && (item.text || item.generated?.length || item.outFiles?.length)) {
      const fileCards = () => { // [ai files] the file cards of a restored reply, under it
        if (!window.aiFiles || !item.outFiles?.length) return;
        const box = Object.assign(document.createElement('div'), { className: 'msg assistant ai-files restored' });
        for (const f of item.outFiles) box.append(window.aiFiles.card(f, { live: false }));
        append(box);
      };
      if (!item.text) { // only pictures (and files)
        if (item.generated?.length) {
          bubble.className = 'msg assistant gen-pics restored';
          for (const pic of item.generated) bubble.append(window.genImages.figure(pic));
          append(bubble);
        }
        fileCards();
        continue;
      }
      if (window.chatActions) { for (const node of window.chatActions.details(item)) append(node); } // its thinking (collapsed) and the steps it took
      else if (item.steps) {
        const summary = document.createElement('div');
        summary.className = 'step done restored';
        summary.innerHTML = '<span class="step-detail"></span>';
        summary.firstChild.textContent = t(item.steps === 1 ? 'chat.usedActions.one' : 'chat.usedActions.other', { count: item.steps });
        append(summary);
      }
      bubble.className = 'msg assistant';
      bubble.innerHTML = window.renderMarkdown(item.text);
      bubble._tabs = item.tabs || null; // [tab chips] the tabs it names, as they were
      decorateCode(bubble);
      finishReply(bubble, item.text);
      if ('steps' in item) replyEntries.push({ bubble, item }); // (the reply that closes its exchange; a text before a step has none)
      if (item.generated?.length) { // the words, then the pictures under them
        bubble.classList.add('restored');
        append(bubble);
        const pics = Object.assign(document.createElement('div'), { className: 'msg assistant gen-pics restored' });
        for (const pic of item.generated) pics.append(window.genImages.figure(pic));
        append(pics);
        fileCards();
        continue;
      }
      if (item.outFiles?.length) { bubble.classList.add('restored'); append(bubble); fileCards(); continue; }
    } else {
      continue;
    }
    bubble.classList.add('restored');
    append(bubble);
  }
}
// The newest part of the chat, with what belongs to its end: the last message can be asked again, a cut-off run can go on.
function renderLatest(items) {
  const userEntries = []; // [{ bubble, item }]: each message of yours, for its row (time, Copy, Edit, versions)
  const replyEntries = []; // [{ bubble, item }]: each reply that closes an exchange, for its model, time and thumbs
  drawItems(items, userEntries, replyEntries);
  // Its last exchange can be asked again: the last message, with its images.
  const lastIndex = items.length - 1;
  let u = lastIndex - 1;
  while (u >= 0 && items[u].role !== 'user') u--;
  const lastUser = u >= 0 ? items[u] : null;
  // (A reply of only pictures is its own bubble; with words, the words' bubble is the reply and the pictures sit under it.)
  const lastReply = items[lastIndex]?.role === 'assistant' && !items[lastIndex].text
    ? [...messages.querySelectorAll('.msg.assistant.gen-pics.restored')].pop()
    : [...messages.querySelectorAll('.msg.assistant.restored:not(.gen-pics)')].pop();
  if (lastUser && (lastUser.text || lastUser.images?.length || lastUser.files?.length) && lastReply && items[lastIndex]?.role === 'assistant') {
    const imgs = (lastUser.images || []).filter((src) => typeof src === 'string' && /^data:image\/[a-z+.-]+;base64,/.test(src)).map((src) => {
      const [, media_type, data] = src.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/);
      return { media_type, data, url: src };
    });
    lastAsk = { text: lastUser.text || '', images: [...imgs, ...restoredFiles(lastUser.files)], tabs: null };
    if (items[lastIndex].acted) { const step = document.createElement('div'); step.className = 'step done restored'; step.dataset.acts = '1'; step.hidden = true; lastReply.before(step); }
    lastReply.querySelector('.reply-copy')?.remove();
    finishReply(lastReply, items[items.length - 1].text, { latest: true });
  } else if (items[lastIndex]?.role === 'user' && (items[lastIndex].text || items[lastIndex].images?.length || items[lastIndex].files?.length)) {
    // It ends on your message: its reply stopped before saying anything. Regenerate and Edit still work.
    const lastBubble = [...messages.querySelectorAll('.msg.user')].pop();
    lastAsk = askOf(lastBubble);
    if (lastAsk) {
      const row = Object.assign(document.createElement('div'), { className: 'msg assistant reply-actions-only restored' });
      row.append(regenButton());
      append(row);
    }
  }
  // The Stop of a run that was cut off: the reply so far is there, and it can go on.
  const lastItem = items[lastIndex];
  if (lastAsk && lastItem?.role === 'assistant' && /\[This reply was interrupted\.\]\s*$/.test(lastItem.text || '')) {
    const notice = Object.assign(document.createElement('div'), { className: 'notice stopped restored', textContent: t('chat.stopped') });
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn notice-continue', textContent: t('chat.continue') });
    button.onclick = () => { button.remove(); ask(t('chat.continuePrompt')); };
    notice.append(' ', button);
    append(notice);
  }
  decorateEntries(userEntries, replyEntries);
  messages.scrollTop = messages.scrollHeight;
  return replyEntries[0] || null;
}
// Under each reply and message: model, time, thumbs, versions (chat-actions.js).
function decorateEntries(userEntries, replyEntries) {
  for (const { bubble, item } of replyEntries) labelReply(bubble, item.model, item.auto, { at: item.at, feedback: item.feedback });
  markModelSwitches(replyEntries);
  for (const { bubble, item } of userEntries) {
    let versions = item.versions && item.versions.n > 1 ? item.versions : null;
    if (versions && versions.same !== false) { // asked again (Regenerate): the switch goes on its reply
      const reply = window.chatActions?.finalReplyOf(bubble);
      if (reply) { window.chatActions.replyMeta(reply, { versions }); versions = null; } else versions = { ...versions, same: false };
    }
    markEditable(bubble, { at: item.at, versions });
  }
}
window.assistant.onHistory?.(({ items, chatId } = {}) => { showHistory(items); if (chatId && !shownChatId) nameChat(chatId); }); // (start-up: the chat this window comes back to is named, so its draft and view are kept under it)

// A turn that started in the other view (the sidebar or the chat page) shows here too: the same
// events follow, tagged with its run id.
window.assistant.onRunStart?.(({ text, runId: id, images, files, chatId: chat } = {}) => {
  if (running || forOtherChat(chat)) return; // (a turn of a chat this view has moved off is not this chat's running state)
  if (chat && !shownChatId) nameChat(chat);
  const shown = [...(images || []).map((a) => ({ ...a, url: `data:${a.media_type};base64,${a.data}` })), ...restoredFiles(files)];
  lastAsk = { text: String(text || ''), images: shown, tabs: null }; // started in the other view: this is the chat's last message now
  startTurn(String(text || ''), shown);
  runId = id;
});
// The other view opened another chat, started a new one, or deleted this one.
// A chat that arrives while this view is hidden (the sidebar closed: main sends the chat of each tab you switch to) is drawn when the view is
// shown, not now: drawing every message of a long chat on every tab switch was the biggest cost of a switch in the browser window. A running
// chat (view.live) is drawn at once, as its events need the page; so is any chat while the view is on screen.
// (app.js's body class: the sidebar is closed, whatever its warm-up layout (.prewarm) is doing; the chat page has no such class and is always shown)
const viewHidden = () => document.body.classList.contains('sidebar-hidden') && !document.body.classList.contains('chat-full');
new MutationObserver(() => { if (!viewHidden()) flushLazyHistory(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] }); // (the sidebar opens, or the chat goes full-page: the chat held back is drawn)
function flushLazyHistory() {
  if (!lazyItems) { if (pendingView) applyView(); return; }
  const items = lazyItems;
  lazyItems = null;
  showHistory(items);
}
function applySync(view) {
  runStateSeq++;
  const wasChat = shownChatId;
  // The chat this view already shows (or the one not started yet, which main has given an id): the box, its attachments and its pasted blocks are
  // left exactly as they are; only the messages are drawn again. Emptying and refilling it from storage lost the text typed in the meantime.
  const sameChat = Boolean(view?.id) && (view.id === shownChatId || (!shownChatId && !view.live && !view.items?.length));
  const unnamed = sameChat && !shownChatId;
  incomingChatId = view?.id || null;
  const ownRun = Boolean(view?.live && running && view.live.runId === runId); // (this view's own run, drawn again: before its first event named the chat, this view had no id for it)
  clearChatView({ keepBox: sameChat, ownRun });
  incomingChatId = null;
  if (sameChat && unnamed) { drafts?.rename(null, view.id); stashRename(null, view.id); }
  shownTemporary = Boolean(view?.temporary);
  shownChatId = view?.id || null; // running/turn start over from this chat's own run (view.live), never the previous chat's
  line.claim(shownChatId);
  window.planModeUI?.chatShown(view, sameChat); // [plan mode] the chip follows the chat
  if (sameChat) saveDraft();
  // An empty chat that was never saved is gone when its tab is left (its file never existed), and the tab comes back to a new empty chat with an id of
  // its own: the text typed in the box of the empty chat left last moves to it. (Otherwise it sat under a dead id and the box came back empty.)
  // (Not into a temporary chat: what was typed in a saved chat stays with it, and the temporary one never keeps a draft.)
  else if (view?.id && !view.temporary && !view.live && !view.items?.length && emptyOwner !== undefined && emptyOwner !== view.id && !drafts?.get(view.id)) { drafts?.rename(emptyOwner, view.id); stashRename(emptyOwner, view.id); }
  if (emptyOwner !== undefined && view?.id && !view.temporary && !view.live && !view.items?.length) emptyOwner = undefined; // (taken, or the box already has its own)
  if (!view?.live && Array.isArray(view?.items) && view.items.length) {
    // Kept for now: drawn after the next paint when the view is on screen (the tab strip and the page area come first), or when it is shown.
    lazyItems = view.items;
    $('empty').hidden = true; // (the chat has messages: it is not the empty one)
    if (!viewHidden()) requestAnimationFrame(() => setTimeout(flushLazyHistory, 0));
  } else showHistory(view?.items);
  resumeLive(view?.live);
  if (!running && line.length) setTimeout(sendQueued); // (the run ended while the view was redrawn, so no 'done' will send what waits)
  restoreCarried();
  window.chatList?.refreshUsage(view?.usage || '');
  chatHost.synced?.(view); // (the chat page: a temporary chat shows its badge)
  if ((view?.id || null) !== wasChat) window.chatList?.refreshOpen?.(); // (an open chat list marks the chat of this tab now)
  window.chatFolders?.refresh(view?.workFolder); // [work folder] the composer's folder chip follows the chat
  followChatEffort(view?.effort); // the chat's own reasoning effort follows the chat
  chatHost.chatChanged?.();
}
window.assistant.onSync?.(({ view } = {}) => applySync(view));
// Asks main which chat this window's front tab shows and what its run is doing, and takes it when it is not what is shown
// here (a tab switch can reach this view late or not at all while another chat's tool is acting). `settled` is false when it
// changed the view.
async function reconcile(late = false) {
  let answer = null;
  const seq = runStateSeq;
  try { answer = await window.assistant.resync?.(); } catch {}
  const view = answer?.view;
  if (!view || !view.id) return true;
  // The view moved on (a run began or ended, another chat was drawn) while main was answering: that answer describes a moment that is gone.
  // Taking it redrew the chat from a snapshot taken mid-run, wiping the reply that had just finished (Send now: the follow-up and its answer).
  if (seq !== runStateSeq) return true;
  return takeView(view, { late });
}
// How long a run that main says is over, in the chat shown here, may wait for its own 'done' before this view takes main's snapshot instead.
const DONE_GRACE_MS = 1500;
function takeView(view, { late = false } = {}) {
  const action = window.runState.reconcileAction(view, shownChatId, running);
  if (action === 'keep') return true;
  // The run just ended in main (a key refused at once, a fast failure) and its 'error' and 'done' are still on the way here, or only the 'done' is:
  // taking main's snapshot now redrew the chat and wiped the error it had just shown. Wait for the 'done'; only a run still shown as
  // running after DONE_GRACE_MS lost it, and then main's view is taken.
  if (!late && running && turn && view.id === shownChatId && !view.live) {
    const mine = runId;
    setTimeout(() => { if (running && runId === mine) reconcile(true).catch(() => {}); }, DONE_GRACE_MS);
    return true;
  }
  // A reply that was just stopped (Stop, or Send now) is already over in main while its 'done' is still on the way here: that is not a stale
  // view. Taking main's view now redraws the chat and drops the message waiting to go next (Send now's follow-up never left).
  if (running && turn && (turn.stopRequested || turn.interrupted) && view.id === shownChatId && !view.live) return true;
  if (action === 'adopt') { nameChat(view.id); return true; } // (a chat not named yet: now it is)
  applySync(view);
  return false;
}
window.chatTakeView = takeView; // app.js: the sidebar opens on this tab's chat that is working / waiting / unread (assistant.sidebarTarget)

// Links in replies open in a new tab.
messages.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link) return;
  e.preventDefault();
  if (window.assistant.openLink) window.assistant.openLink(link.href); // the chat page has no browser bridge
  else window.browser.newTab(link.href);
});

// The height is read once, before anything is written (a write restyles every message, and a read after it forces that at once), and the
// variable is only set when the height moved.
let composerHeight = -1;
new ResizeObserver(() => {
  const height = $('composer').offsetHeight;
  if (height !== composerHeight) { composerHeight = height; chatRoot.style.setProperty('--composer-h', `${height}px`); if (stuck && !restoring) messages.scrollTop = messages.scrollHeight; } // (the chat's bottom padding is the composer's height: a view following the end stays there. Left ~100 px up, the next scroll event read it as scrolled away and the tab kept that offset)
  if (height) flushLazyHistory(); // (the sidebar shown: the chat it was handed while hidden)
  if (height && running) reconcile(); // (the sidebar shown again: it may have missed the end of a run)
}).observe($('composer'));

// The box sizes itself (CSS field-sizing: content, with a one-line minimum and a cap of 40% of the window), so nothing is measured
// here: no scrollHeight read while the box is hidden or narrow, nothing to recompute on a resize, a draft restore, a zoom or a font
// load. Callers keep calling this; it only drops a fixed height that an older version of the box may have left behind.
function autosize() {
  if (prompt.style.height) prompt.style.height = '';
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
// A view that comes back (window focus, the page visible) asks main what runs.
window.addEventListener('focus', () => { if (running) reconcile(); });
let sidebarWasHidden = document.body.classList.contains('sidebar-hidden');
new MutationObserver(() => {
  const hidden = document.body.classList.contains('sidebar-hidden');
  if (sidebarWasHidden && !hidden && running) reconcile(); // (the sidebar shown again: it may have missed the end of a run)
  sidebarWasHidden = hidden;
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('visibilitychange', () => { if (!document.hidden && running) reconcile(); });
prompt.addEventListener('focus', () => { prewarm(); if (running) reconcile(); }); // (a Stop button that belongs to another chat goes as soon as the box is used)
prompt.addEventListener('input', () => { prewarm(); autosize(); updateSend(); renderScreenBtn(); });
prompt.addEventListener('keydown', (e) => {
  if (isImeEnter(e)) return; // Japanese, Chinese, Korean input: Enter confirms the text, not the message
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
    stopReply(); // Esc in an empty composer stops the reply
  } else if (e.key === 'ArrowUp' && !prompt.value && !running && !attachments.length && !pastes.length && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && messages.querySelector('.msg.user')) {
    e.preventDefault();
    editLast(); // Up in an empty composer edits the message you sent last (Claude.ai, ChatGPT)
  }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (running) {
    // The Stop shown may be stale (the reply ended while this view was hidden and missed it): main's truth decides, and a
    // click on a stale Stop is a Send. A really running reply is stopped.
    const settled = await reconcile();
    if (running) { if (settled) stopReply(); return; }
  }
  sendComposer();
});
sendNowBtn.onclick = () => { sendComposer({ now: true }); prompt.focus(); };
async function sendComposer({ now = false } = {}) {
  const typed = prompt.value.trim();
  if (!typed && attachments.length === 0 && pastes.length === 0) return;
  if (typed && attachments.length === 0 && pastes.length === 0 && window.focusPhrase?.parseStart(typed) && window.focusUi) { // [focus] "focus for 90 minutes" starts focus mode here (renderer/focus.js)
    prompt.value = '';
    renderAttachments();
    autosize();
    await window.focusUi.tryStart(typed);
    return;
  }
  const text = window.chatDrafts.withPastes(typed, pastes);
  const hadPastes = pastes.length > 0; // (a pasted block is the message's subject, not the words of a new topic)
  const images = attachments;
  attachments = [];
  pastes = [];
  prompt.value = '';
  renderAttachments(); // (saves the empty draft)
  showAttachNote([]);
  autosize();
  const tabs = window.tabsAsk ? await window.tabsAsk.take() : null; // the "@" chips, resolved against the tabs open now
  const screen = takeScreenMode(); // [screen context] the camera button's choice for this message
  if (running) { const entry = ask(text, images, tabs, screen); if (now && entry) sendNow(entry); } // (queued for after the reply, or Send now)
  else if (hadPastes || !(await askOnNewTopic(text, images, tabs))) ask(text, images, tabs, screen);
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
    if (running) window.assistant.stop(shownChatId || undefined);
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
// `keepBox`: the same chat is drawn again (applySync): its box is not touched at all.
function clearChatView({ keepBox = false, ownRun = false } = {}) {
  // The same chat drawn again (a sync while a reply runs): what waits in its line stays waiting, put back under the redrawn view. A message typed
  // before the chat's first event named it has no owner yet: it is this chat's when the run being drawn is this view's own.
  const staying = line.drain((q) => keepBox || Boolean(incomingChatId && q.chatId === incomingChatId) || (ownRun && q.chatId == null));
  // Leaving a chat: its own waiting messages go back to ITS box, saved with its draft just below (they used to land in the box of the next chat).
  if (!keepBox) queuedToDraft();
  if (!keepBox) {
    if (!lazyItems && !messages.querySelector('.msg') && prompt.value.trim()) emptyOwner = shownChatId; // (kept while other chats are shown in between)
    saveDraft(); // (this chat's unsent text stays with it; the next chat gets its own, shown after the callers name it)
    stashView(shownChatId); // (and so do its pictures, chips, scroll position and open cards)
    pendingView = null;
    pendingOpen = null;
    attachments = [];
    draftHold = true;
    shownTemporary = false; // (saveDraft above still knew the chat being left; the next one's view says what it is)
    prompt.value = '';
    pastes = [];
    autosize();
    renderAttachments();
    queueMicrotask(restoreDraft);
  }
  runId++;
  shownChatId = null; // (whoever opens a chat names it next; until then its first event does)
  lastAsk = null; // another chat: its last message isn't known here
  for (const id of [...approvals.keys()]) resolveApproval(id, false); // clears the toolbar badge too
  approvals.clear();
  const unsent = line.drain();
  for (const q of unsent) q.bubble.remove();
  queueBar = null; // (its element goes with the rest of the view)
  // Messages still waiting for the other chat's reply aren't lost: they come back to the box, to send here or not.
  entriesToBox(unsent);
  lazyItems = null;
  historyDrawing++;
  messages.querySelectorAll(':scope > :not(#empty)').forEach((el) => el.remove());
  window.tabsAsk?.reset(); // "@" chips and the once-per-chat "all tabs" confirm start over
  $('empty').hidden = false;
  turn = null;
  setRunning(false);
  for (const q of staying) { messages.append(q.bubble); line.add(q); $('empty').hidden = true; }
  if (staying.length) renderQueue();
}
$('new-chat').onclick = () => {
  window.assistant.reset();
  followChatEffort(''); // a new chat starts on Auto
  clearChatView();
  window.planModeUI?.chatShown(null, false); // [plan mode] a new chat starts as Settings says
  window.chatList?.refreshUsage('');
  prompt.focus();
};

// Called once by the page's script after it has set its chatHost hooks.
function startChat() {
  restoreDraft();
  refreshSetup();
  loadModels();
}
