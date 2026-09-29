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
async function refreshSetup() {
  const s = await window.assistant.getSettings();
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
  optional('setup-claude-code').disabled = !s.claudeCode;
}
optional('setup-claude-code').onclick = async () => {
  // Signed out a moment ago? Ask the CLI again first (the user may have just run /login).
  const status = await window.lumenExtras?.claudeCodeStatus?.(true).catch(() => null);
  if (status?.signedIn !== false && await window.assistant.setModel('claudecode:default')) await loadModels();
  refreshSetup();
};
$('setup-keys').onclick = openAiSettings;
// While the sign-in tab is open the button becomes Cancel (closing that tab cancels too).
let openRouterPending = false;
optional('setup-openrouter').onclick = async () => {
  const btn = optional('setup-openrouter');
  const title = btn.querySelector('.setup-name') || btn;
  if (openRouterPending) { window.assistant.cancelOpenRouterSignIn?.(); return; }
  openRouterPending = true;
  const label = title.textContent;
  title.textContent = t('setup.openrouter.cancel');
  try {
    const r = await window.assistant.openRouterSignIn();
    if (r?.ok) { await loadModels(); refreshSetup(); }
    else if (r?.message && !r.cancelled) alert(r.message);
  } catch (err) {
    alert(t('setup.openrouter.failed', { error: err?.message || err }));
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
  const who = ASSISTANTS[group === 'Your Claude account' ? 'Claude' : group === 'Your Grok account' ? 'Grok' : group] || ASSISTANTS.AI;
  if (assistantIdentity === who) return;
  const first = assistantIdentity === null;
  assistantIdentity = who;
  chatHost.identity?.(who, first); // the sidebar's toolbar button follows the model's company (app.js)
  const empty = document.querySelector('#empty .empty-title');
  if (empty) empty.textContent = chatHost.emptyText ? chatHost.emptyText(who.name) : t('sidebar.empty', { name: who.name });
  const pill = $('agent-pill-text');
  if (pill) pill.textContent = t('agent.usingTab', { name: who.name });
}

window.lumenPicker($('model'));

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
    groups.get(m.group).append(option);
  }
  // A single group needs no heading.
  select.replaceChildren(...(groups.size > 1 ? groups.values() : [...groups.values()].flatMap((g) => [...g.children])));
  if (modelReady) { select.value = s.model; select.pickerSync(); }
  const current = s.models.find((m) => m.id === s.model);
  select.title = current?.detail || '';
  prompt.placeholder = !current ? t('composer.setup') : t('composer.ask', { name: current.group === 'Claude' ? 'Claude' : current.label });
  setAssistantIdentity(current?.group);
}
window.assistant.onModelsUpdated?.(() => loadModels());
// "More models…" (OpenRouter): a searchable list of every model, under the picker.
async function openModelSearch() {
  document.querySelector('.model-search')?.remove();
  const box = Object.assign(document.createElement('div'), { className: 'picker-menu model-search' });
  const input = Object.assign(document.createElement('input'), { type: 'search', placeholder: t('models.search'), className: 'model-search-input' });
  input.setAttribute('aria-label', t('models.search'));
  const list = Object.assign(document.createElement('div'), { className: 'model-search-list', textContent: t('models.loading') });
  list.setAttribute('role', 'listbox');
  box.append(input, list);
  document.querySelector('.model-picker').append(box);
  input.focus();
  const close = () => { box.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  document.addEventListener('pointerdown', outside, true);
  let models = [];
  try { models = await window.assistant.openRouterModels(); } catch { list.textContent = t('models.loadFailed'); return; }
  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = models.filter((m) => words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w))).slice(0, 60);
    list.replaceChildren(...hits.map((m) => {
      const item = Object.assign(document.createElement('div'), { className: 'picker-item', tabIndex: -1, textContent: m.tools ? m.name : t('models.chatOnly', { name: m.name }), title: m.id });
      item.setAttribute('role', 'option');
      item.dataset.id = m.id;
      item.addEventListener('click', async () => {
        close();
        if (await window.assistant.setModel(`openrouter:${m.id}`)) await loadModels();
      });
      return item;
    }));
    if (!hits.length) list.textContent = t('models.none');
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') list.querySelector('.picker-item')?.click();
  });
  render();
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
  const switched = await window.assistant.setModel(select.value).catch(() => false);
  if (!switched) {
    // Not accepted (it disconnected a moment ago, say): show what main actually uses.
    await loadModels();
    return;
  }
  const label = select.selectedOptions[0].textContent;
  select.title = select.selectedOptions[0].title;
  // From main's list, not the <optgroup>: a lone group is drawn without one (see loadModels).
  const group = modelGroups.get(select.value) ?? select.selectedOptions[0].parentElement?.label;
  prompt.placeholder = t('composer.ask', { name: group === 'Claude' ? 'Claude' : select.selectedOptions[0].textContent });
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
// ---------- chat ----------

const messages = $('messages');
const prompt = $('prompt');
const send = $('send');
let running = false;
let turn = null; // DOM state for the in-progress assistant reply
let runId = 0; // events from older runs (after Stop or New chat) are ignored

function scrollToBottom() {
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
  if (nearBottom) messages.scrollTop = messages.scrollHeight;
}

function append(el) {
  $('empty').hidden = true;
  messages.append(el);
  scrollToBottom();
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

function updateSend() {
  send.disabled = !running && !prompt.value.trim() && attachments.length === 0;
}

// ---------- image attachments: paste or drop images into the sidebar ----------

const MAX_IMAGES = 5;
const MAX_EDGE = 1568; // larger images are downscaled by the API anyway; resizing first saves upload time
const MAX_BYTES = 3.5 * 1024 * 1024;
const PASSTHROUGH = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
let attachments = []; // { media_type, data (base64), url (data URL for previews) }

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

async function toAttachment(file) {
  const url = await readAsDataUrl(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const edge = Math.max(img.naturalWidth, img.naturalHeight);
  if (PASSTHROUGH.includes(file.type) && edge <= MAX_EDGE && file.size <= MAX_BYTES) {
    return { media_type: file.type, data: url.split(',')[1], url };
  }
  const scale = Math.min(1, MAX_EDGE / edge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const out = canvas.toDataURL(type, 0.9);
  return { media_type: type, data: out.split(',')[1], url: out };
}

async function addImages(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  for (const file of images) {
    if (attachments.length >= MAX_IMAGES) break;
    try {
      attachments.push(await toAttachment(file));
    } catch {
      // Unreadable image (e.g. an unsupported format); skip it.
    }
  }
  renderAttachments();
  return images.length > 0;
}

function renderAttachments() {
  const strip = $('attachments');
  strip.replaceChildren();
  strip.hidden = attachments.length === 0;
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment';
    const img = document.createElement('img');
    img.src = a.url;
    img.alt = t('composer.attachedImage', { n: i + 1 });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.setAttribute('aria-label', t('composer.removeImage', { n: i + 1 }));
    remove.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>';
    remove.onclick = () => { attachments.splice(i, 1); renderAttachments(); prompt.focus(); };
    chip.append(img, remove);
    strip.append(chip);
  });
  updateSend();
}

prompt.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith('image/'))) {
    e.preventDefault(); // text paste stays untouched; only images are intercepted
    await addImages(files);
  }
});
const sidebarEl = chatRoot;
sidebarEl.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
    e.preventDefault();
    sidebarEl.classList.add('dropping');
  }
});
sidebarEl.addEventListener('dragleave', (e) => { if (!sidebarEl.contains(e.relatedTarget)) sidebarEl.classList.remove('dropping'); });
sidebarEl.addEventListener('drop', async (e) => {
  sidebarEl.classList.remove('dropping');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  await addImages(e.dataTransfer.files);
  prompt.focus();
});

// Asks that arrive while a reply is running (Alt+Enter in the address bar, "Ask about selection",
// the new-tab page's Ask AI, a starter chip) wait their turn instead of disappearing.
const queued = [];
function sendQueued() {
  const next = queued.shift();
  if (!next) return;
  next.notice.remove();
  ask(next.text, next.images, next.tabs);
}

// `tabs` (renderer/tabs-ask.js take()): the tabs picked with "@" — { ids, names, gone } — whose text goes along.
function ask(text, images = [], tabs = null) {
  if (running) {
    const notice = append(Object.assign(document.createElement('div'), { className: 'notice queued', textContent: t('chat.queued', { text: text.length > 60 ? `${text.slice(0, 59)}…` : text || t('chat.image') }) }));
    queued.push({ text, images, tabs, notice });
    return;
  }
  // Nothing connected: show the setup card instead of sending a message that can only error.
  if (!modelReady) {
    if (!messages.querySelector('.msg')) { refreshSetup(); return; }
    append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('chat.setupNeeded') }));
    return;
  }
  if (tabs?.gone?.length) append(Object.assign(document.createElement('div'), { className: 'notice', textContent: t('tabs.gone', { names: tabs.gone.join(', ') }) }));
  startTurn(text, images, tabs);
  window.assistant.ask(text, ++runId, images.map(({ media_type, data }) => ({ media_type, data })), tabs?.ids?.length ? tabs.ids : undefined);
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
  append(bubble);
  beginTurn();
}

// The working line and turn state of a reply that is now running (its user bubble already shown).
function beginTurn() {
  const working = document.createElement('div');
  working.className = 'working';
  working.innerHTML = '<span></span><span></span><span></span>';
  turn = { text: null, textSource: '', thinking: null, working: append(working), steps: new Map() };
  setRunning(true);
}

function moveWorkingToEnd() {
  if (turn?.working) messages.append(turn.working);
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
  const stable = window.markdownStableLength(source);
  const done = el.stableLen || 0;
  if (el.headNodes === undefined || stable < done) { el.innerHTML = ''; el.headNodes = 0; el.stableLen = 0; }
  while (el.childNodes.length > el.headNodes) el.lastChild.remove();
  if (stable > el.stableLen) {
    el.insertAdjacentHTML('beforeend', window.renderMarkdown(source.slice(el.stableLen, stable)));
    el.stableLen = stable;
    el.headNodes = el.childNodes.length;
  }
  const tail = settledMarkdown(source.slice(el.stableLen));
  if (tail) el.insertAdjacentHTML('beforeend', window.renderMarkdown(tail));
}

// The bubble's final draw, at once and with nothing held back, before a copy button or label goes in.
function flushStreaming(el) {
  if (!el || el.source === undefined || el.flushed) return;
  el.renderPending = false;
  el.flushed = true;
  el.innerHTML = window.renderMarkdown(el.source);
}

function endStream() {
  flushStreaming(turn?.text);
  turn?.text?.classList.remove('streaming');
}

window.assistant.onEvent((event) => {
  // An approval card answered or cancelled from an older run (after Stop or New chat) still has to
  // clear, or the toolbar's "waiting for approval" badge stayed on.
  if (event.type === 'approval_done') { resolveApproval(event.approvalId, event.ok); return; }
  if (!turn || event.runId !== runId) return;
  switch (event.type) {
    case 'turn_start':
    case 'text_block':
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
        turn.thinking = append(details).querySelector('div');
      }
      turn.thinking.textContent += event.text;
      moveWorkingToEnd();
      break;
    }
    case 'text': {
      if (!turn.text) turn.text = append(Object.assign(document.createElement('div'), { className: 'msg assistant streaming' }));
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
      finishReply(turn.text, turn.textSource);
      const label = event.label || (TOOL_LABELS[event.name] || (() => event.name))(event.input || {});
      const step = document.createElement('div');
      step.className = event.id ? 'step running' : 'step done';
      if (event.id) turn.steps.set(event.id, step);
      step.innerHTML = '<span class="step-detail"></span>';
      step.firstChild.textContent = label;
      step.title = label;
      append(step);
      endStream();
      turn.text = null;
      turn.textSource = '';
      moveWorkingToEnd();
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
      showApproval(event.approvalId, event.host, { action: event.action, title: event.title, query: event.query, args: event.args, tainted: event.tainted });
      moveWorkingToEnd();
      break;
    case 'notice': {
      const notice = append(Object.assign(document.createElement('div'), { className: 'notice', textContent: event.text }));
      if (event.action === 'continue') {
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('chat.continue') });
        button.onclick = () => { button.remove(); ask(t('chat.continuePrompt')); };
        notice.append(' ', button);
      }
      break;
    }
    case 'error': {
      const error = append(Object.assign(document.createElement('div'), { className: 'error', textContent: event.text }));
      if (event.action === 'settings') {
        const button = Object.assign(document.createElement('button'), { className: 'btn', textContent: t('chat.setupAi') });
        button.onclick = openAiSettings;
        error.append(button);
      }
      break;
    }
    case 'done':
      finishReply(turn.text, turn.textSource);
      labelReply(turn.text, event.model);
      endStream();
      for (const step of turn.steps.values()) if (step.classList.contains('running')) step.className = 'step stopped';
      turn.working.remove();
      if (event.undo) window.showRunUndo?.(append, event.undo); // [ai controls] extras.js
      turn = null;
      setRunning(false);
      setTimeout(sendQueued);
      break;
  }
});

// While a reply streams, hold back a trailing link that hasn't finished arriving
// ("[text](https://…" with no closing parenthesis yet), so raw markdown never flashes.
function settledMarkdown(source) {
  const open = source.lastIndexOf('[');
  if (open === -1) return source;
  const tail = source.slice(open);
  if (/^\[[^\]\n]*$/.test(tail) || /^\[[^\]\n]*\]\([^)\s]*$/.test(tail)) return source.slice(0, open);
  return source;
}

// Which model wrote a reply: a quiet label, since a chat can move between models.
function labelReply(bubble, modelId) {
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
  bubble.append(Object.assign(document.createElement('span'), { className: 'reply-model', textContent: name }));
}

// ---------- copy a reply ----------

const COPY_ICON = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>';

function finishReply(bubble, source) {
  flushStreaming(bubble);
  if (!bubble || !source || !source.trim() || bubble.querySelector('.reply-copy')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reply-copy';
  button.title = t('chat.copy');
  button.setAttribute('aria-label', t('chat.copy'));
  button.innerHTML = COPY_ICON;
  button.onclick = async () => {
    try {
      const html = window.renderMarkdown(source);
      const text = bubble.innerText.trim() || source;
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
$('auto-allow').onclick = () => setAutoAllow(!autoAllow);
window.assistant.autoAllow?.().then((on) => { autoAllow = Boolean(on); renderAutoAllow(); });

// ---------- inline approval before Claude acts on a new site ----------

const approvals = new Map(); // approvalId -> { card, host }

// `action: 'open'`: the AI has read page content in this chat and wants to open a new site (which
// could carry that content there), or search for `query`; `action: 'script'`: it wants to run a
// script on a site after reading page content; anything else is the usual "interact with this site" card.
function showApproval(approvalId, host, { action, title: openTitle, query, args, tainted } = {}) {
  if (action === 'tool') return showToolApproval(approvalId, host, { title: openTitle, args, tainted });
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
  const always = Object.assign(document.createElement('button'), { type: 'button', className: 'btn approval-always', textContent: t('approval.always') });
  always.title = t('approval.always.title');
  deny.onclick = () => answer(false);
  allow.onclick = () => answer(true);
  always.onclick = () => { always.disabled = true; setAutoAllow(true); answer(true); };
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === card) { e.preventDefault(); answer(true); }
    else if (e.key === 'Escape') { e.preventDefault(); answer(false); }
  });

  actions.append(deny, always, allow);
  card.append(title, detail, actions);
  append(card);
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
  card.setAttribute('aria-label', heading || `Use ${host}?`);
  const title = Object.assign(document.createElement('p'), { className: 'approval-title', textContent: heading || `Use ${host}?` });
  const detail = Object.assign(document.createElement('p'), {
    className: 'approval-detail',
    textContent: terminal
      ? 'This runs for real on your computer, with your permissions:'
      : tainted
        ? 'It has read page content in this chat. Check that these details are what you want to send to this server:'
        : 'This server gets these details:',
  });
  const pre = Object.assign(document.createElement('pre'), { className: 'approval-args', textContent: args || '{}' });
  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const deny = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: "Don't allow" });
  const allow = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: 'Allow once' });
  const always = tainted && !terminal ? null : Object.assign(document.createElement('button'), { type: 'button', className: 'btn approval-always', textContent: terminal ? 'Allow for this chat' : 'Always allow this tool', title: terminal ? 'Stop asking for terminal commands for the rest of this chat. Resets when you start a new chat.' : 'Stop asking for this tool (it still asks after the AI reads a page). Change it in Settings → You and AI.' });
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
  append(card);
  approvals.set(approvalId, { card, host, tool: true });
  scrollToBottom();
}

function resolveApproval(approvalId, ok) {
  const entry = approvals.get(approvalId);
  if (!entry) return;
  approvals.delete(approvalId);
  const { card, host, tool } = entry;
  card.className = ok ? 'approval resolved' : 'approval resolved denied';
  card.removeAttribute('tabindex');
  card.removeAttribute('role');
  card.removeAttribute('aria-label');
  card.textContent = tool ? (ok ? t('approval.allowedTool', { host }) : t('approval.deniedTool', { host })) : ok ? t('approval.allowed', { host }) : t('approval.denied', { host });
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
    } else if (item.role === 'assistant' && item.text) {
      if (item.steps) {
        const summary = document.createElement('div');
        summary.className = 'step done restored';
        summary.innerHTML = '<span class="step-detail"></span>';
        summary.firstChild.textContent = t(item.steps === 1 ? 'chat.usedActions.one' : 'chat.usedActions.other', { count: item.steps });
        append(summary);
      }
      bubble.className = 'msg assistant';
      bubble.innerHTML = window.renderMarkdown(item.text);
      finishReply(bubble, item.text);
    } else {
      continue;
    }
    bubble.classList.add('restored');
    append(bubble);
  }
  messages.scrollTop = messages.scrollHeight;
}
window.assistant.onHistory?.(({ items } = {}) => showHistory(items));

// A turn that started in the other view (the sidebar or the chat page) shows here too: the same
// events follow, tagged with its run id.
window.assistant.onRunStart?.(({ text, runId: id, images } = {}) => {
  if (running) return;
  startTurn(String(text || ''), (images || []).map((a) => ({ ...a, url: `data:${a.media_type};base64,${a.data}` })));
  runId = id;
});
// The other view opened another chat, started a new one, or deleted this one.
window.assistant.onSync?.(({ view } = {}) => {
  clearChatView();
  showHistory(view?.items);
  window.chatList?.refreshUsage(view?.usage || '');
  chatHost.chatChanged?.();
});

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
prompt.addEventListener('input', () => { autosize(); updateSend(); });
prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (running) { window.assistant.stop(); return; }
  const text = prompt.value.trim();
  if (!text && attachments.length === 0) return;
  const images = attachments;
  attachments = [];
  renderAttachments();
  prompt.value = '';
  autosize();
  const tabs = window.tabsAsk ? await window.tabsAsk.take() : null; // the "@" chips, resolved against the tabs open now
  ask(text, images, tabs);
  updateSend();
});

document.querySelectorAll('.chip').forEach((chip) => {
  // A starter that works on all open tabs sends them along (after the once-per-chat confirm when there are many).
  chip.onclick = () => (chip.dataset.allTabs && window.tabsAsk ? window.tabsAsk.askAll(chip.dataset.prompt) : ask(chip.dataset.prompt));
});

// Empties the sidebar for a new chat or another one from the history list (renderer/chats.js).
function clearChatView() {
  runId++;
  for (const id of [...approvals.keys()]) resolveApproval(id, false); // clears the toolbar badge too
  approvals.clear();
  for (const q of queued.splice(0)) q.notice.remove();
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
