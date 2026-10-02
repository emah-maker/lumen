// lumen://settings: a sidebar of categories with search, and one category per page (#category in the URL),
// like System Settings: a large title, then grouped lists of rows. Deep things open as sub-pages.
// Everything goes through window.lumenSettings (settings-preload.js); the backend is
// settings-backend.js.
const S = window.lumenSettings;
const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

let st = null; // prefs:get state
// A string from the page's table (renderer/i18n.js), or the English given here when it has none.
const tr = (key, english, vars) => {
  const text = window.t ? window.t(key, vars) : key;
  return text === key ? (vars ? english.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : english) : text;
};

async function save(key, value) {
  try {
    st = await S.set(key, value);
    applyPageClasses();
    refreshRestartNotes();
  } catch (err) {
    console.error(err);
  }
  return st;
}

// ---------- row builders ----------

function row(label, desc, ...controls) {
  const el = h('div', { class: 'row' },
    h('div', { class: 'text' }, h('span', { class: 'label', text: label }), desc ? h('span', { class: 'desc', text: desc }) : null),
    controls.length ? h('div', { class: 'controls' }, controls) : null);
  el.dataset.search = `${label} ${desc || ''}`.toLowerCase();
  return el;
}
function stackRow(label, desc, ...content) {
  const el = row(label, desc);
  el.classList.add('stack');
  el.append(...content);
  return el;
}
function toggle(key, label, desc, after) {
  const input = h('input', { type: 'checkbox', class: 'switch', id: `pref-${key}`, role: 'switch', 'aria-label': label });
  input.checked = Boolean(st.prefs[key]);
  input.addEventListener('change', async () => { await save(key, input.checked); after?.(input.checked); });
  const r = row(label, desc, input);
  r.querySelector('.label').addEventListener('click', () => input.click());
  return r;
}
function select(key, label, desc, options, { number = false, after } = {}) {
  const el = h('select', { id: `pref-${key}`, 'aria-label': label },
    options.map(([value, text]) => h('option', { value: String(value), text })));
  el.value = String(st.prefs[key]);
  el.addEventListener('change', async () => { await save(key, number ? Number(el.value) : el.value); after?.(el.value); });
  return row(label, desc, el);
}
const status = (id) => h('span', { class: 'note', id });
// Where each provider hands out API keys (Settings → AI and agents → API keys, "Get a key").
const KEY_PAGES = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  xai: 'https://console.x.ai/',
  gemini: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/keys',
};
const importSummary = (r) => tr('settings.import.done', 'Imported from {browser}: {bookmarks} and {history}.', {
  browser: r.label,
  bookmarks: tr(r.bookmarks === 1 ? 'import.bookmarks.one' : 'import.bookmarks.other', r.bookmarks === 1 ? '{count} bookmark' : '{count} bookmarks', { count: r.bookmarks.toLocaleString() }),
  history: tr(r.history === 1 ? 'import.history.one' : 'import.history.other', r.history === 1 ? '{count} history entry' : '{count} history entries', { count: r.history.toLocaleString() }),
});
const flash = (el, text, cls = 'ok') => { el.textContent = text; el.className = `note ${cls}`; };
const langName = (() => {
  let names;
  try { names = new Intl.DisplayNames([navigator.language], { type: 'language' }); } catch {}
  return (tag) => { try { return names?.of(tag) || tag; } catch { return tag; } };
})();
const bytes = (n) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------- sections ----------

// Categories in the sidebar, each made of slots (filled by the builders below) that show as grouped lists.
// [id, group title]: a builder appends to its slot and calls card.group('Title') to start another list.
const CATEGORIES = [
  { id: 'general', title: 'General', slots: [['default-browser', 'Default browser'], ['startup', 'On startup'], ['languages', 'Language'], ['import', 'Import'], ['behavior', 'Behavior']] },
  { id: 'appearance', title: 'Appearance', slots: [['appearance', 'Theme'], ['accessibility', 'Accessibility']] },
  { id: 'home', title: 'Home', slots: [['home', 'Background'], ['widgets', 'Widgets']] },
  { id: 'tabs', title: 'Tabs', slots: [['tabs-strip', 'Tab strip'], ['tabs-groups', 'Groups'], ['tabs-sleep', 'Memory']] },
  { id: 'privacy', title: 'Privacy and security', slots: [['privacy', 'Browsing data']] },
  { id: 'search', title: 'Search engine', slots: [['search', 'Search engine']] },
  { id: 'ai', title: 'AI and agents', slots: [['ai-model', 'Assistant'], ['ai-accounts', 'Accounts and keys'], ['ai-privacy', 'Privacy'], ['ai-agents', 'Agents and tools'], ['ai-more', 'More']] },
  { id: 'extensions', title: 'Extensions', slots: [['extensions', 'Installed']] },
  { id: 'downloads', title: 'Downloads', slots: [['downloads', 'Downloads']] },
  { id: 'updates', title: 'Updates', slots: [['about', 'Software update']] },
  { id: 'advanced', title: 'Advanced', slots: [['system', 'Performance'], ['experimental', 'Experimental'], ['automation', 'Automation'], ['advanced-more', 'Diagnostics'], ['reset', 'Reset']] },
];
// Sidebar icon glyphs (16px, drawn white on a colored rounded square; the color is in settings.css).
const CATEGORY_ICONS = {
  general: '<path d="M3 5h10M3 11h10"/><circle cx="6" cy="5" r="1.7"/><circle cx="10.5" cy="11" r="1.7"/>',
  appearance: '<circle cx="8" cy="8" r="5.2"/><path d="M8 2.8a5.2 5.2 0 0 0 0 10.4z" fill="currentColor"/>',
  home: '<path d="M2.5 7.6 8 3l5.5 4.6M4 6.8V13h8V6.8"/>',
  tabs: '<rect x="2" y="4.5" width="12" height="8.5" rx="2"/><path d="M2 7.6h12M5 4.5V3"/>',
  privacy: '<path d="M8 2 3.4 4v3.8c0 2.8 2 4.8 4.6 5.8 2.6-1 4.6-3 4.6-5.8V4z"/><path d="m6 8 1.6 1.6L10.2 6.8"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.3 3.3"/>',
  ai: '<path d="M8 1.8l1.4 3.7 3.8 1.5-3.8 1.5L8 12.2 6.6 8.5 2.8 7l3.8-1.5z"/><path d="M12.5 11.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/>',
  extensions: '<path d="M6 3h4v2.2a1.4 1.4 0 1 1 0 2.8V13H3V8.5h2.2a1.4 1.4 0 1 0 0-2.8H3V3z" transform="translate(1 0)"/>',
  downloads: '<path d="M8 2.8v7.4M5 7.6l3 3 3-3M3.4 13h9.2"/>',
  updates: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.6v2.7h-2.7"/>',
  advanced: '<circle cx="8" cy="8" r="2"/><path d="M8 2v1.8M8 12.2V14M2 8h1.8M12.2 8H14M3.8 3.8l1.3 1.3M10.9 10.9l1.3 1.3M12.2 3.8l-1.3 1.3M5.1 10.9l-1.3 1.3"/>',
};
// Old section ids (lumen://settings/<id>, and links from elsewhere in Lumen) -> where they live now.
// A category id opens that category; `focus` scrolls to a slot inside it; sub-page ids open the sub-page.
const ALIASES = {
  'you-and-ai': { cat: 'ai' }, antigravity: { cat: 'ai', focus: 'ai-agents' }, 'ai-keys': { cat: 'ai', focus: 'ai-accounts', focusEl: '#ai-keys button' },
  'default-browser': { cat: 'general', focus: 'default-browser', focusEl: '#default-browser-button' }, startup: { cat: 'general', focus: 'startup' }, languages: { cat: 'general', focus: 'languages' },
  accessibility: { cat: 'appearance', focus: 'accessibility' }, system: { cat: 'advanced', focus: 'system' },
  reset: { cat: 'advanced', focus: 'reset' }, about: { cat: 'updates' },
};
const DEFAULT_CATEGORY = 'general';
const categories = new Map(); // id -> { ...def, pane, link }
const slots = new Map(); // slot or sub-page id -> Slot
let forceRoute = null; // a widget's gear on the new-tab page opens Home > Widgets, whatever hash it used

// A run of grouped lists inside a category (or a sub-page). Builders append rows to it; the first append
// starts a list (titled `title`), and group() starts the next one.
class Slot {
  constructor(id, title, cat) {
    this.id = id; this.title = title; this.cat = cat; this.pending = title; this.card = null; this.groups = [];
    this.el = h('div', { class: 'slot', id: `sec-${id}` });
  }
  group(title) { this.pending = title || ''; this.card = null; return this; }
  append(...nodes) {
    if (!this.card) {
      this.card = h('div', { class: 'card' });
      const shown = this.pending && this.pending.toLowerCase() !== categories.get(this.cat).title.toLowerCase();
      const g = h('div', { class: 'group', 'data-title': this.pending || '' }, shown ? h('h3', { class: 'group-title', text: this.pending }) : null, this.card);
      this.el.append(g);
      this.groups.push(g);
    }
    this.card.append(...nodes);
  }
  querySelector(sel) { return this.el.querySelector(sel); }
  at(id) { return slots.get(id); }
  // A row with a chevron that opens a detail page (with a back button) instead of listing it all inline.
  subpage(id, label, desc, more = '') {
    const sub = new Slot(id, label, this.cat);
    sub.pending = ''; sub.isSub = true;
    slots.set(id, sub);
    const catTitle = categories.get(this.cat).title;
    const back = h('button', { class: 'back', type: 'button', 'aria-label': `${tr('settings.back', 'Back')}: ${catTitle}`, onclick: () => { location.hash = `#${this.cat}`; } },
      h('span', { class: 'chev', 'aria-hidden': 'true' }), catTitle);
    sub.pane = h('div', { class: 'pane subpane', id: `sub-${id}`, hidden: true }, h('div', { class: 'subhead' }, back), h('h1', { class: 'pane-title', text: label }), sub.el);
    $('sections').append(sub.pane);
    const link = row(label, desc, h('span', { class: 'chev', 'aria-hidden': 'true' }));
    link.classList.add('link');
    link.dataset.sub = id;
    link.dataset.search += ` ${more}`.toLowerCase();
    link.tabIndex = 0;
    link.setAttribute('role', 'link');
    link.addEventListener('click', () => { location.hash = `#${id}`; });
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = `#${id}`; } });
    sub.link = link;
    this.append(link);
    return sub;
  }
}
const visibleNow = (el) => el.offsetParent !== null; // on screen now (not in a hidden category or filtered out)

let gmailWatch = null; // the open Gmail editor's redraw on a connection change elsewhere (see gmailFields)
let gmailWatchOn = false;
async function buildAi(card) {
  let ai = await S.ai.get();
  // Rebuilt whenever the connected models change (a key added or removed, a sign-in), not just once.
  const modelOptions = () => [...new Set(ai.models.map((m) => m.group))].map((g) => h('optgroup', { label: g },
    ai.models.filter((m) => m.group === g).map((m) => { const o = h('option', { value: m.id, text: m.label, title: m.detail || '', selected: m.id === ai.model }); if (m.more) o.dataset.more = '1'; if (m.name) o.dataset.name = m.name; if (m.provider) o.dataset.provider = m.provider; if (m.detail) o.dataset.detail = m.detail; if (m.title) o.title = m.title; if (m.badges?.length) o.dataset.badges = m.badges.join(','); if (Number.isFinite(m.price)) o.dataset.price = String(m.price); if (m.context) o.dataset.context = String(m.context); return o; })));
  card.append(
    row('Model', 'The model the assistant in the sidebar uses.', h('select', {
      id: 'ai-model',
      'aria-label': 'Model',
      onchange: async (e) => { if (!(await S.ai.setModel(e.target.value).catch(() => false))) await refreshModels(); },
    }, modelOptions())),
  );
  const modelPicker = card.querySelector('#ai-model');
  modelPicker.parentElement.classList.add('picker-host');
  // "More models…" opens OpenRouter's whole catalog here too (renderer/model-catalog.js).
  let catalog = null;
  const openCatalog = (q = '') => {
    catalog ||= window.lumenModelCatalog({ mainSelect: modelPicker, anchor: settingsPicker.button, host: modelPicker.parentElement, fetchModels: () => S.ai.openRouterModels(), onBack: (q) => settingsPicker.open(q || ''), onFail: (text) => { const n = modelPicker.parentElement.querySelector('.catalog-fail') || modelPicker.parentElement.appendChild(h('span', { class: 'catalog-fail', role: 'status' })); flash(n, text, 'err'); } });
    catalog.open(q);
  };
  const settingsPicker = window.lumenPicker(modelPicker, {
    recentKey: 'model',
    extra: (q) => (q && [...modelPicker.options].some((o) => o.dataset.more) ? [{ label: tr('models.searchFor', 'Look for “{q}” on OpenRouter', { q }), detail: tr('models.more.detail', 'Every model OpenRouter has'), run: (text) => openCatalog(text) }] : []),
    onMore: () => openCatalog(),
  });
  const noModels = h('p', { class: 'note', id: 'ai-model-empty', text: tr('settings.ai.noModels', 'No AI connected yet. Add a key or sign in under Accounts and keys below.') });
  modelPicker.parentElement.append(noModels);
  const showEmpty = () => { noModels.hidden = ai.models.length > 0; modelPicker.hidden = !ai.models.length; settingsPicker.button?.toggleAttribute('hidden', !ai.models.length); };
  const refreshModels = async () => {
    ai = await S.ai.get();
    showEmpty();
    modelPicker.replaceChildren(...modelOptions());
    if (ai.model) modelPicker.value = ai.model;
    modelPicker.pickerSync?.();
  };
  showEmpty();
  S.ai.onModelsUpdated?.(() => { refreshModels(); catalog?.refreshOpen(); }); // picked in the sidebar, or a fresher catalog: Settings shows it too
  const adhd = h('input', { type: 'checkbox', class: 'switch', id: 'ai-adhd', role: 'switch', 'aria-label': 'Short, focused answers', checked: ai.adhdMode, onchange: (e) => S.ai.setAdhdMode(e.target.checked) });
  const grouping = h('select', { id: 'ai-grouping', 'aria-label': 'Group tabs automatically', onchange: (e) => { S.ai.setTabGrouping(e.target.value); topicRow.hidden = e.target.value !== 'topic'; } },
    [['off', 'Off'], ['site', 'By site'], ['topic', 'By topic']].map(([value, text]) => h('option', { value, text, selected: ai.tabGrouping === value })));
  const topicAi = h('input', { type: 'checkbox', class: 'switch', id: 'ai-topic-ai', role: 'switch', 'aria-label': 'Use AI to name and group topics', checked: ai.topicAi, onchange: (e) => S.ai.setTopicAi(e.target.checked) });
  const topicRow = row('Use AI to name and group topics', 'Sends only tab titles and site names (like example.com, never full addresses) to the cheapest model of your chat’s provider, or through your own Claude Code or Grok Build when you chat with one (no API key needed). Off: topics are found on this computer.', topicAi);
  topicRow.classList.add('sub-row');
  topicRow.hidden = ai.tabGrouping !== 'topic';
  const idleOrganize = h('input', { type: 'checkbox', class: 'switch', id: 'ai-organize-idle', role: 'switch', 'aria-label': 'Organize tabs automatically', checked: ai.organizeWhenIdle, onchange: (e) => S.ai.setOrganizeIdle(e.target.checked) });
  const idleRow = row('Organize tabs automatically', 'A few seconds after your tabs change, Lumen groups loose tabs on this computer (never with AI) and offers Undo. Only when they are a mix: tabs that are all one topic are left alone. On by default.', idleOrganize);
  const forgetBtn = h('button', { id: 'ai-forget-organize', text: 'Forget organize learning', onclick: async () => { await S.ai.forgetOrganizeLearning(); forgetBtn.textContent = 'Forgotten'; setTimeout(() => { forgetBtn.textContent = 'Forget organize learning'; }, 2000); } });
  const forgetRow = row('What Organize learned', 'When you drag a tab into or out of a group, or rename a group, Lumen remembers which sites and words go with which group name, on this computer only, so the next Organize prefers them.', forgetBtn);
  card.append(
    row('Short, focused answers', 'Answers lead with the next step and stay brief (ADHD mode). Applies to new chats.', adhd),
    select('maxSteps', tr('settings.ai.maxSteps', 'Max steps per task'), tr('settings.ai.maxStepsDesc', 'How many steps the assistant may take on one request before it wraps up with an answer. Unlimited still stops if it gets stuck in a loop, and you can always press Stop.'),
      [[0, tr('settings.ai.maxSteps.unlimited', 'Unlimited')], ...[30, 60, 120, 250].map((n) => [n, String(n)])], { number: true }),
    select('maxChatRuns', tr('settings.ai.maxChatRuns', 'Chats working at once'), tr('settings.ai.maxChatRunsDesc', 'Each tab has its own sidebar chat, and chats in different tabs can work at the same time. When this many are working, the next one waits its turn. Claude Code and Grok Build always take turns, one chat at a time.'),
      [1, 2, 3, 4, 6, 8].map((n) => [n, String(n)]), { number: true }),
    toggle('autoFallback', tr('settings.ai.autoFallback', 'Switch models automatically when one is unavailable'), tr('settings.ai.autoFallbackDesc', 'When the model you picked hits its usage limit or can’t be reached, Lumen can continue with another model you’ve connected (a lighter one from the same provider first, then your other providers) and goes back on its own once the first one recovers. The conversation so far, including page text and images, may then be sent to that provider (for example OpenAI or xAI). Off: you get the error and choose.')),
    toggle('autoCompact', tr('settings.ai.autoCompact', 'Compact long chats automatically'), tr('settings.ai.autoCompactDesc', 'When a chat with an API model (Claude, OpenAI, Grok, Gemini, OpenRouter) gets close to what the model can take in one request, its earlier part is summarized by the same model and the AI goes on from that summary, instead of the oldest messages being left out. The messages stay on screen. Type /compact to do it yourself at any time. Claude Code, Grok Build and Antigravity compact their own sessions.')),
    toggle('autoModel', 'Pick the Claude Code model for me', 'With no model chosen, simple requests use Haiku, most use Sonnet and hard ones use Opus. A model you pick is always used.'),
    toggle('claudeCodeFullAccess', tr('settings.ai.claudeCodeFullAccess', 'Give Claude Code full access to this computer'), tr('settings.ai.claudeCodeFullAccessDesc', 'Claude Code in the sidebar works as it does in your terminal: it can run commands, read and change any of your files, and use your own MCP servers, skills and slash commands, all without asking first. Only turn this on if you trust it with your computer: a web page it reads could try to trick it. Off by default; applies from the next message.')),
    toggle('grokWarmup', tr('settings.ai.grokWarmup', 'Warm up Grok Build when Lumen starts'), tr('settings.ai.grokWarmupDesc', 'Starts Grok Build’s setup in the background so your first message starts faster. Only while Grok Build is connected or chosen; nothing is sent to Grok.')),
    toggle('researchTabs', tr('settings.ai.researchTabs', 'Show AI research in tabs'), tr('settings.ai.researchTabsDesc', 'When the assistant searches the web or reads pages, open them as background tabs in one group so you can watch and keep the sources. Sites where you turned AI off are never opened. Your current tab is left alone.')),
    toggle('aiHandsOff', tr('settings.ai.handsOff', 'Don’t let the AI act on my pages'), tr('settings.ai.handsOffDesc', 'The AI can read pages you share, but it won’t click, type or navigate in your tabs. It works in tabs it opens itself. It also applies to programs connected through the Automation server.')),
    select('closeAiTabs', tr('settings.ai.closeAiTabs', 'Close tabs the AI opened when it finishes'), tr('settings.ai.closeAiTabsDesc', 'Off leaves them open (the tab menu and the chat list can still close them). Ask puts the question under the reply. Always closes them as soon as the AI is done, with Undo. A tab you clicked in, typed in, navigated, pinned or moved by hand is yours and stays, and so does the tab a chat lives in.'),
      ['off', 'ask', 'always'].map((v) => [v, tr(`settings.ai.closeAiTabs.${v}`, { off: 'Off', ask: 'Ask', always: 'Always' }[v])])),
  );
  card.at('tabs-groups').append(
    row('Group tabs automatically', 'By site: 3 or more tabs from one site. By topic: related tabs, such as recipes or one trip, once 4 or more are loose. Tabs you group or move by hand stay put.', grouping),
    topicRow,
    idleRow,
    toggle('organizeOnlyMixed', 'Only when topics are mixed', 'Leave loose tabs alone when they are all about one thing. Off: those get a group too.'),
    select('organizeDelaySeconds', 'Organize after', 'How long after your tabs change Lumen waits before grouping them.', [2, 5, 10, 30, 60].map((n) => [n, n < 60 ? `${n} seconds` : '1 minute']), { number: true }),
    forgetRow,
  );

  // [ai controls] Sites where the AI (the sidebar's and outside agents) can't read or act.
  const offList = h('div', { class: 'list', id: 'ai-off-sites' });
  const offInput = h('input', { type: 'text', class: 'grow', id: 'ai-off-add', placeholder: 'example.com', 'aria-label': 'Site to turn AI off on' });
  const renderOff = async (sites) => {
    sites ||= await S.ai.aiSites();
    offList.replaceChildren(...(sites.length ? sites.map((site) => h('div', { class: 'item', 'data-site': site },
      h('span', { class: 'grow', text: site }),
      h('button', { text: 'Turn on AI', onclick: async () => renderOff(await S.ai.setAiSite(site, false)) })))
      : [h('span', { class: 'note', text: 'None. The AI can work on any site you allow.' })]));
  };
  card.at('ai-privacy').append(stackRow('Sites where AI is off', 'The AI can’t read, click or type on these sites, their tabs aren’t sent with your messages or to Organize Tabs, and outside agents are refused too. Also in the sidebar and a tab’s right-click menu.', offList,
    h('div', { class: 'controls' }, offInput, h('button', {
      text: 'Turn off AI',
      onclick: async () => { const site = offInput.value.trim(); if (!site) return; offInput.value = ''; renderOff(await S.ai.setAiSite(site, true)); },
    }))));
  renderOff();

  // [signed-in sites] Hosts the AI may always read with your signed-in session (features/signed-in-sites.js).
  // Added only from the AI's approval card ("Always for <site>"); removed here.
  const signedList = h('div', { class: 'list', id: 'ai-signed-in-sites' });
  const clearSigned = h('button', { id: 'ai-signed-in-clear', text: 'Remove all', onclick: async () => renderSigned(await S.ai.clearSignedInSites()) });
  const renderSigned = async (sites) => {
    sites ||= await S.ai.signedInSites();
    clearSigned.hidden = !sites.length;
    signedList.replaceChildren(...(sites.length ? sites.map(({ host, added }) => h('div', { class: 'item', 'data-host': host },
      h('span', { class: 'grow', text: host }),
      added ? h('span', { class: 'note', text: `Added ${new Date(added).toLocaleDateString()}` }) : null,
      h('button', { text: 'Remove', 'aria-label': `Remove ${host}`, onclick: async () => renderSigned(await S.ai.removeSignedInSite(host)) })))
      : [h('span', { class: 'note', text: 'None. The AI reads pages signed out unless you allow a site when it asks.' })]));
  };
  card.at('ai-privacy').append(stackRow('Signed-in sites the AI can use', 'When the AI asks to read a page as you (your grades, your orders), you can allow it just once or always for that site. It then sees the page as you do; nothing is clicked, typed or submitted there without the usual approvals. Banks, payments, password managers and account-security pages are only ever allowed once. Outside agents never get this.', signedList,
    h('div', { class: 'controls' }, clearSigned)));
  renderSigned();

  // API keys: one line per provider; Edit opens the field in place.
  const keys = h('div', { class: 'list', id: 'ai-keys' });
  const renderKeys = () => {
    const entries = [['anthropic', { label: 'Anthropic (Claude)', stored: ai.hasStoredKey, env: ai.hasEnvKey }], ...Object.entries(ai.providerKeys)];
    keys.replaceChildren(...entries.map(([provider, info]) => {
      const line = h('div', { class: 'item key', 'data-provider': provider });
      const state = info.stored ? 'Saved' : info.env ? 'From environment' : 'Not set';
      const rowNote = status();
      const view = (message = '', cls = 'ok') => { line.replaceChildren(...[
        h('span', { class: 'grow' }, info.label, KEY_PAGES[provider] && !info.stored && !info.env ? h('a', { class: 'key-get', href: KEY_PAGES[provider], text: tr('settings.ai.getKey', 'Get a key'), onclick: (e) => { e.preventDefault(); S.openUrl(KEY_PAGES[provider]); } }) : null),
        h('span', { class: `note key-state${info.stored || info.env ? ' set' : ''}`, text: state }),
        h('button', { text: info.stored ? 'Change' : 'Add', 'aria-label': `${info.stored ? 'Change' : 'Add'} ${info.label} key`, onclick: edit }),
        provider === 'openrouter' && !info.stored ? h('button', {
          class: 'primary', text: 'Sign in', 'aria-label': 'Sign in with OpenRouter',
          // While the sign-in tab is open this is a Cancel button (closing that tab cancels too).
          onclick: async (e) => {
            const btn = e.target;
            if (btn.dataset.pending) { S.ai.cancelOpenRouterSignIn?.(); return; }
            btn.dataset.pending = '1';
            btn.textContent = 'Cancel';
            btn.classList.remove('primary');
            let r;
            try { r = await S.ai.openRouterSignIn(); } catch (err) { r = { ok: false, message: `OpenRouter sign-in failed: ${err.message}` }; }
            await refreshModels();
            renderKeys();
            if (!r.ok && !r.cancelled) keys.querySelector(`[data-provider="openrouter"]`)?.showMessage?.(r.message, 'err');
          },
        }) : null,
        message ? (flash(rowNote, message, cls), rowNote) : null,
      ].filter(Boolean)); };
      line.showMessage = (text, cls) => view(text, cls);
      const edit = () => {
        const input = h('input', { type: 'password', class: 'grow', autocomplete: 'off', placeholder: `${info.label} API key`, 'aria-label': `${info.label} API key` });
        const note = status();
        const put = async (value) => {
          try {
            flash(note, value ? 'Checking the key…' : '', '');
            const r = provider === 'anthropic' ? await S.ai.setKey(value) : await S.ai.setProviderKey(provider, value);
            await refreshModels();
            renderKeys();
            if (r?.unverified) keys.querySelector(`[data-provider="${provider}"]`)?.showMessage?.(`Saved. ${info.label} couldn’t be reached to check the key, so it’s checked on your first message.`, 'warn');
          } catch (err) { flash(note, String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); }
        };
        const saveKey = () => { if (input.value.trim()) put(input.value.trim()); else input.focus(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); else if (e.key === 'Escape') view(); });
        line.replaceChildren(...[
          h('span', { class: 'key-name', text: info.label }), input,
          h('button', { text: 'Save', onclick: saveKey }),
          info.stored ? h('button', { class: 'danger', text: 'Remove', onclick: () => put('') }) : null,
          h('button', { class: 'plain', text: 'Cancel', onclick: () => view() }),
          note,
        ].filter(Boolean));
        input.focus();
      };
      view();
      return line;
    }));
  };
  renderKeys();
  card.at('ai-accounts').append(stackRow('API keys', 'Any one is enough: every provider’s models can chat and use the browser tools (reading, clicking and typing, with your approval). Keys are encrypted with your OS keychain and sent only to their provider.', keys));

  // Anthropic CLI sign-in: status sits under the description, the button on the right.
  const cliNote = status('ai-cli-status');
  const cliButtons = h('div', { class: 'controls' });
  const renderCli = (s) => {
    cliNote.textContent = s.signedIn ? `Signed in${s.profile ? ` (profile “${s.profile}”)` : ''}.${s.shadowedBy ? ` Your ${s.shadowedBy} is used first.` : ''}` : s.installed ? 'Not signed in.' : 'The Anthropic CLI installs on first sign-in.';
    cliButtons.replaceChildren(s.signedIn
      ? h('button', { id: 'ai-cli-button', text: 'Sign out', onclick: async () => { renderCli(await S.ai.cliLogout()); await refreshModels(); } })
      : h('button', {
        id: 'ai-cli-button', class: 'primary', text: 'Sign in',
        // While the browser sign-in is waiting, this is a Cancel button.
        onclick: async (e) => {
          const btn = e.target;
          if (btn.dataset.pending) { S.ai.cliCancel?.(); return; }
          btn.dataset.pending = '1';
          btn.textContent = 'Cancel';
          btn.classList.remove('primary');
          flash(cliNote, 'Starting…', '');
          let r;
          try { r = await S.ai.cliLogin(); } catch (err) { r = { ok: false, message: err.message, signedIn: false }; }
          renderCli(r);
          await refreshModels();
          if (!r.ok && r.message) flash(cliNote, r.message, r.cancelled ? '' : 'err');
        },
      }));
  };
  S.ai.onCliProgress((text) => { cliNote.textContent = text; });
  const cliRow = row(tr('settings.ai.cli.title', 'Sign in with your Anthropic account'), tr('settings.ai.cli.desc', 'For Anthropic API access without copying a key: the Anthropic CLI signs you in to your Console account (pay as you go). To use a Claude Pro or Max plan instead, choose Claude Code in the model menu.'), cliButtons);
  cliRow.querySelector('.text').append(cliNote);
  card.at('ai-accounts').append(cliRow);
  S.ai.cliStatus().then(renderCli).catch(() => {});

  // AI agents over MCP, and automation tools over CDP
  const mcp = await S.ai.mcpInfo();
  const mcpToggle = h('input', { type: 'checkbox', class: 'switch', id: 'ai-mcp', role: 'switch', 'aria-label': 'Allow AI agents to connect', checked: mcp.enabled, onchange: (e) => S.ai.setMcpEnabled(e.target.checked) });
  const agents = card.at('ai-agents');
  agents.append(row('Allow AI agents to connect', 'Off by default. When on, Claude Code, Codex, Grok Build, Antigravity and other MCP clients on this computer can drive Lumen. They still need your OK for each new site. The Add buttons below turn this on.', mcpToggle));
  const snippets = h('div', { class: 'list', id: 'ai-snippets' }, mcp.snippets.map((snip) => {
    const copy = h('button', { text: 'Copy', onclick: async () => { await navigator.clipboard.writeText(snip.text).catch(() => {}); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1400); } });
    const note = status();
    // snip.addButton is the agent id ('claude' | 'codex' | 'grok' | 'antigravity'); 'json' (other clients) has none.
    const addLabel = `Add to ${snip.label}`;
    const add = snip.addButton ? h('button', {
      text: addLabel,
      onclick: async () => {
        add.disabled = true;
        add.textContent = 'Adding…';
        const r = await S.ai.addToAgent(snip.addButton).catch((err) => ({ ok: false, text: err.message }));
        add.textContent = r.already ? 'Already connected' : r.ok ? 'Added' : addLabel;
        add.disabled = Boolean(r.ok);
        if (r.ok) mcpToggle.checked = true; // connecting an agent turns agent connections on
        if (!r.already) flash(note, r.text, r.ok ? 'ok' : 'err');
      },
    }) : null;
    // Claude Code's own row also shows install/sign-in state, so "not signed in" doesn't look like
    // a broken Add button (the CLI itself gates sign-in; Lumen only checks, never reads, its status).
    const ccState = snip.id === 'claude' ? status() : null;
    if (ccState) {
      S.ai.claudeCodeStatus().then((s) => {
        ccState.textContent = !s.installed ? 'Not installed' : s.signedIn === false ? 'Installed · not signed in' : s.signedIn === true ? 'Installed · signed in' : 'Installed · sign-in unknown';
        ccState.className = `note${s.installed && s.signedIn === false ? ' err' : ''}`;
      }).catch(() => {});
    }
    return h('div', { class: 'snippet', 'data-snippet': snip.id },
      h('div', { class: 'item' }, h('span', { class: 'grow' }, snip.label, h('span', { class: 'note', text: ` · ${snip.hint}` })), ccState, add, copy),
      h('pre', { class: 'mono code', text: snip.text }),
      snip.secondary ? h('p', { class: 'note', text: snip.secondary }) : null,
      note);
  }));
  agents.subpage('connect-agents', tr('settings.connectAgents', 'Connect an AI agent'), 'Add Lumen to Claude Code, Codex, Grok Build, Antigravity and other MCP clients.', 'mcp claude codex gemini antigravity agy grok').append(stackRow('Connect an AI agent', 'Add Lumen to an agent’s MCP settings.', snippets));
  agents.subpage('mcp-servers', tr('settings.mcpServers', 'Tools from MCP servers'), 'Servers whose tools the sidebar’s AI can use.', 'mcp tools servers').append(buildMcpServers()); // settings-mcp-servers.js: tools from MCP servers, for the sidebar's AI

  buildAntigravity(agents, refreshModels);

  const auto = await S.ai.automationInfo();
  const autoToggle = h('input', { type: 'checkbox', class: 'switch', id: 'ai-automation', role: 'switch', 'aria-label': 'Allow automation tools', checked: auto.enabled });
  const port = h('input', { type: 'number', id: 'ai-automation-port', min: '1024', max: '65535', placeholder: '9222', 'aria-label': 'Automation port', value: String(auto.port) });
  const autoNote = status('ai-automation-status');
  let running = auto.running;
  let token = auto.token;
  // The address includes the proxy's secret token: without it every request is refused.
  const endpointFor = (p) => `http://127.0.0.1:${p}/${token}`;
  const copyUrl = h('button', { id: 'ai-automation-copy', text: 'Copy address', onclick: async () => { await navigator.clipboard.writeText(endpointFor(Number(port.value) || 9222)).catch(() => {}); copyUrl.textContent = 'Copied'; setTimeout(() => { copyUrl.textContent = 'Copy address'; }, 1400); } });
  const describe = (enabled, p) => {
    const endpoint = endpointFor(p);
    autoNote.className = 'note';
    if (!enabled) autoNote.textContent = running ? 'Turned off. The port is closed.' : '';
    else if (running?.error) flash(autoNote, running.error, 'err');
    else if (running?.listening && running.port === p) autoNote.textContent = `Listening on ${endpoint}. Playwright: chromium.connectOverCDP('${endpoint}')`;
    else autoNote.textContent = `Restart Lumen to open ${endpoint}.`;
  };
  const portRow = row('Port (localhost only)', 'Any program on this computer that has this address (it includes a secret key) can control your tabs and read what’s in them, including sites you’re signed in to. Turn it off when you’re done: turning it back on makes a new address.', port, copyUrl);
  portRow.querySelector('.text').append(autoNote);
  const saveAuto = async () => {
    const p = Number(port.value) || 9222;
    await S.ai.setAutomation({ enabled: autoToggle.checked, port: p });
    portRow.hidden = !autoToggle.checked;
    if (!autoToggle.checked) running = null;
    token = (await S.ai.automationInfo()).token; // turning it off and on again makes a new one
    describe(autoToggle.checked, p);
  };
  autoToggle.addEventListener('change', saveAuto);
  port.addEventListener('change', saveAuto);
  portRow.hidden = !auto.enabled;
  portRow.classList.add('sub-row');
  describe(auto.enabled, auto.port);
  card.at('automation').append(row('Allow automation tools (Chrome DevTools Protocol)', `For Playwright, Playwright MCP and other CDP tools. They see only your tabs, and unlike the AI in the sidebar they don’t ask before acting on a site.${auto.internalPort ? ' While on, other programs on this computer can reach Lumen’s internal debugging port too.' : ''} Takes effect after a restart.`, autoToggle), portRow);

  // Import
  const importRow = h('div', { class: 'controls', id: 'ai-import' });
  card.at('import').append(row('Import bookmarks and history', 'From another browser on this computer. Passwords and cookies are not imported.', importRow));
  S.ai.importBrowsers().then((found) => {
    const note = status('import-status');
    note.setAttribute('role', 'status');
    importRow.replaceChildren(...(found.length ? found.map((b) => h('button', {
      text: b.label,
      onclick: async (e) => {
        const btn = e.target;
        btn.disabled = true;
        flash(note, tr('welcome.import.running', 'Importing from {browser}…', { browser: b.label }), '');
        const r = S.ai.importQuiet ? await S.ai.importQuiet(b.id) : (await S.ai.importFrom(b.id), null);
        btn.disabled = false;
        if (r) flash(note, r.ok ? importSummary(r) : tr('settings.import.failed', 'Couldn’t import from {browser}: {error}', { browser: b.label, error: r.error }), r.ok ? 'ok' : 'err');
        else note.textContent = '';
      },
    })) : [h('span', { class: 'note', text: tr('welcome.import.none', 'No other browsers found on this computer.') })]), found.length ? note : '');
  }).catch(() => {});

  // Default browser (features/setup.js): what the system says now, and a button that asks it.
  const defaultNote = status('default-browser-status');
  const defaultButton = h('button', { id: 'default-browser-button', class: 'primary', text: tr('settings.default.button', 'Make default') });
  const renderDefault = async () => {
    const yes = await S.ai.isDefaultBrowser?.().catch(() => null);
    defaultButton.hidden = yes === true;
    flash(defaultNote, yes ? tr('welcome.default.done', 'Lumen is your default browser.') : tr('settings.default.not', 'Another browser is the default.'), '');
  };
  defaultButton.onclick = async () => {
    const r = await S.ai.makeDefaultBrowser?.().catch(() => null);
    if (r?.devBuild) { flash(defaultNote, tr('welcome.default.devBuild', 'This copy runs from source: use an installed Lumen to make it the default.'), ''); return; }
    if (r?.opened === 'windows-settings') flash(defaultNote, tr(r.ok ? 'welcome.default.windows' : 'welcome.default.windowsManual', 'In the Windows Settings window that opened, set Lumen as the default for HTTP and HTTPS links.'), '');
    else if (r?.isDefault) renderDefault();
    else if (r?.opened === 'system-prompt') flash(defaultNote, tr('welcome.default.confirm', 'Confirm in the dialog your system opened.'), '');
    else flash(defaultNote, r ? tr('welcome.default.notTaken', 'Your system didn’t make Lumen the default. Choose it in your system’s default-apps settings.') : tr('welcome.default.failed', 'Lumen couldn’t ask your system to make it the default. Try again, or choose it in your system’s default-apps settings.'), 'err');
  };
  window.addEventListener('focus', renderDefault); // (back from the system's settings)
  const defaultRow = row(tr('settings.default.title', 'Default browser'), tr('settings.default.desc', 'Links you open in other apps (mail, chat, documents) open in your default browser.'), defaultButton);
  defaultRow.querySelector('.text').append(defaultNote);
  card.at('default-browser').append(defaultRow);
  renderDefault();
}

// A Relaunch button in the row of a setting that only takes effect at launch; shown while that
// setting differs from what Lumen was started with (refreshRestartNotes).
function withRelaunch(row, key, id) {
  const button = h('button', { class: 'primary relaunch', text: 'Relaunch', hidden: true, onclick: () => S.relaunch() });
  button.dataset.key = key;
  if (id) button.id = id;
  row.querySelector('.controls').prepend(button);
  return row;
}

function buildAppearance(card) {
  card.group('Theme and color');
  card.append(select('theme', 'Theme', 'Lumen and the websites you visit follow this (websites see it as prefers-color-scheme). Open Google results reload to match.', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]));
  buildLook(card);
  card.group('Page display').append(
    select('defaultZoom', 'Page zoom', 'The default for every site. Sites you zoom by hand keep their own level.', st.zooms.map((z) => [z, `${Math.round(z * 100)}%`]), { number: true }),
    select('fontSize', 'Font size', 'The default text size websites start from. Applies to new tabs.', st.fontSizes.map((s) => [s, { 9: 'Very small', 12: 'Small', 16: 'Medium (recommended)', 20: 'Large', 24: 'Very large' }[s]]), { number: true }),
  );
  card.group('Toolbar').append(toggle('showBookmarkButton', 'Show bookmark button', 'The star in the address bar. Ctrl+D bookmarks either way.'));
  card.at('tabs-strip').append(toggle('compactTabs', 'Compact tabs', 'Shorter tabs in the tab strip.'));
  // Expert: Chromium's forced dark mode for pages.
  card.at('experimental').append(withRelaunch(toggle('forceDarkWebsites', 'Dark mode for all websites (experimental)', 'Chromium darkens sites that have no dark theme of their own. Takes effect after a relaunch.'), 'forceDarkWebsites'));
}

// ---------- [look] accent color and the new-tab page ----------
const ACCENT_SWATCHES = [['blue', 'Blue'], ['indigo', 'Indigo'], ['purple', 'Purple'], ['pink', 'Pink'], ['red', 'Red'], ['orange', 'Orange'], ['green', 'Green'], ['teal', 'Teal'], ['graphite', 'Graphite']];
const BACKGROUND_CHOICES = [['plain', 'Plain'], ['aurora', 'Aurora'], ['dusk', 'Dusk'], ['ocean', 'Ocean'], ['forest', 'Forest'], ['sunset', 'Sunset'], ['graphite', 'Graphite']];
// The animated effect's look: a color (automatic, the accent, rainbow, a preset or any), how many,
// how fast, how big, and whether the pointer moves them.
const EFFECT_SWATCHES = [['#ffffff', 'White'], ['#64d2ff', 'Cyan'], ['#bf5af2', 'Purple'], ['#ff6482', 'Pink'], ['#ffd60a', 'Gold'], ['#30d158', 'Green']];
function buildEffectOptions() {
  const box = h('div', { class: 'effect-options', id: 'effect-options' });
  const modes = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Effect color' });
  const swatches = h('div', { class: 'swatches' });
  const custom = h('input', { type: 'color', class: 'swatch-custom', id: 'effect-color-custom', 'aria-label': 'Custom effect color', title: 'Any color' });
  const render = () => {
    const current = st.prefs.newTabEffectColor;
    for (const b of box.querySelectorAll('[data-color]')) b.setAttribute('aria-checked', String(b.dataset.color === current));
    custom.classList.toggle('on', /^#/.test(current) && !EFFECT_SWATCHES.some(([v]) => v === current));
    if (/^#/.test(current)) custom.value = current;
  };
  const pickColor = async (value) => { await save('newTabEffectColor', value); render(); };
  for (const [value, label] of [['auto', 'Automatic'], ['accent', 'Accent'], ['rainbow', 'Rainbow']]) {
    modes.append(h('button', { type: 'button', role: 'radio', 'data-color': value, text: label, onclick: () => pickColor(value) }));
  }
  for (const [value, label] of EFFECT_SWATCHES) {
    const b = h('button', { type: 'button', role: 'radio', class: 'swatch', 'data-color': value, title: label, 'aria-label': label, onclick: () => pickColor(value) });
    b.style.background = value; // (the page's CSP has no inline style attributes)
    swatches.append(b);
  }
  custom.addEventListener('change', () => pickColor(custom.value.toLowerCase()));
  swatches.append(custom);
  box.append(
    stackRow('Effect color', 'Automatic is white over a background and your text color on Plain.', modes, swatches),
    select('newTabEffectAmount', 'Amount', null, [['few', 'Few'], ['normal', 'Normal'], ['many', 'Many']]),
    select('newTabEffectSpeed', 'Speed', null, [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']]),
    select('newTabEffectSize', 'Size', null, [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']]),
    toggle('newTabEffectInteract', 'React to the pointer', 'Particles reach for it, stars light up, bubbles and snow move aside.'),
  );
  render();
  return box;
}
function applyPageAccent() {
  const hex = st?.accent && (matchMedia('(prefers-color-scheme: dark)').matches ? st.accent.dark : st.accent.light);
  const style = document.documentElement.style;
  if (!hex) { style.removeProperty('--accent'); style.removeProperty('--accent-soft'); style.removeProperty('--ring'); return; }
  const n = parseInt(hex.slice(1), 16);
  style.setProperty('--accent', hex);
  style.setProperty('--accent-soft', `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / 0.14)`);
  style.setProperty('--ring', `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / 0.3)`);
}
function buildLook(card) {
  // Accent: one swatch per color, plus any color.
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Accent color' });
  const custom = h('input', { type: 'color', class: 'swatch-custom', 'aria-label': 'Custom accent color', title: 'Any color' });
  const renderSwatches = () => {
    const current = st.prefs.accentColor;
    for (const b of swatches.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === current));
    custom.classList.toggle('on', /^#/.test(current));
    custom.value = /^#/.test(current) ? current : st.accent?.light || '#007aff';
  };
  for (const [value, label] of ACCENT_SWATCHES) {
    swatches.append(h('button', { type: 'button', role: 'radio', class: `swatch accent-${value}`, 'data-value': value, title: label, 'aria-label': label,
      onclick: async () => { await save('accentColor', value); renderSwatches(); } }));
  }
  custom.addEventListener('change', async () => { await save('accentColor', custom.value); renderSwatches(); });
  swatches.append(custom);
  card.append(row('Accent color', 'Buttons, links, the selected tab and focus rings, across Lumen and its pages.', swatches));
  renderSwatches();
}

// [look] A row of choices for one setting (radio buttons, arrow keys move between them), saved at once.
// `content(value, label)` draws a choice; `after` runs once one is saved.
function choices(key, label, cls, options, content, after) {
  const group = h('div', { class: cls, role: 'radiogroup', 'aria-label': label, id: `pref-${key}` });
  const buttons = options.map(([value, text]) => h('button', { type: 'button', role: 'radio', 'data-value': String(value), 'aria-label': text, title: text,
    onclick: async () => { paint(String(value)); await save(key, value); after?.(value); } }, content(value, text)));
  const paint = (v) => { for (const b of buttons) { const on = b.dataset.value === v; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; } };
  group.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = buttons[(i + step + buttons.length) % buttons.length];
    next.click();
    next.focus();
  });
  group.append(...buttons);
  paint(String(st.prefs[key]));
  group.repaint = () => paint(String(st.prefs[key]));
  return group;
}
// [look] The clock's styles and the greeting's fonts (features/clock-styles.js lists them; newtab.html draws them),
// each previewed in its own face; settings.css has the same font stacks.
function buildClockStyle() {
  const styles = (st.clockStyles || []).map((s) => [s.id, s.label]);
  const fonts = (st.greetingFonts || []).map((f) => [f.id, f.label]);
  const greetingFace = (v) => (v === 'match' ? (st.prefs.newTabClockStyle === 'bold' ? 'classic' : st.prefs.newTabClockStyle) : v);
  let greetingTiles = null;
  const clockTiles = choices('newTabClockStyle', 'Clock style', 'clock-tiles', styles, (v, text) => [
    h('span', { class: `ct-face cs-${v}`, 'aria-hidden': 'true' }, v === 'bold' ? [h('span', { text: '09' }), h('span', { text: '41' })] : '9:41'),
    h('span', { class: 'ct-label', text }),
  ], () => { // "Match clock" follows the new face
    const match = greetingTiles?.querySelector('[data-value="match"] .ct-face');
    if (match) match.className = `ct-face gf-${greetingFace('match')}`;
  });
  greetingTiles = fonts.length ? choices('newTabGreetingFont', 'Greeting font', 'clock-tiles greeting-tiles', fonts, (v, text) => [
    h('span', { class: `ct-face gf-${greetingFace(v)}`, 'aria-hidden': 'true', text: 'Hello' }),
    h('span', { class: 'ct-label', text }),
  ]) : null;
  const seg = (key, label, options) => choices(key, label, 'segctl', options, (v, text) => text);
  return { clock: [
    stackRow('Clock style', 'The clock’s typeface and layout. Classic is the original look.', clockTiles),
    row('Hours', 'Automatic follows your system language.', seg('newTabClockHours', 'Hours', [['auto', 'Automatic'], ['12', '12-hour'], ['24', '24-hour']])),
    toggle('newTabClockSeconds', 'Show seconds', null),
    toggle('newTabClockDate', 'Show the date', 'The date with the clock. In Thin it sits above the time.'),
    row('Behind the clock', 'A card behind the clock and date. Glass blurs the background behind it.', seg('newTabClockCard', 'Behind the clock', [['none', 'None'], ['soft', 'Soft'], ['glass', 'Glass']])),
    toggle('newTabClockShadow', 'Stronger text shadow', 'Makes the clock and greeting easier to read over a background or picture.'),
  ], greeting: greetingTiles ? [stackRow('Greeting font', 'The typeface of “Good evening”. Match clock uses the clock’s.', greetingTiles)] : [] };
}

// Home: the new-tab page's background, clock, greeting and sections, and its widgets (a sub-page).
async function buildHome(card) {

  // The new-tab page: background, clock, greeting, sections.
  const tiles = h('div', { class: 'bg-tiles', role: 'radiogroup', 'aria-label': 'New tab background' });
  const picture = h('div', { class: 'controls' });
  const renderTiles = () => {
    for (const t of tiles.querySelectorAll('button')) t.setAttribute('aria-checked', String(t.dataset.value === st.prefs.newTabBackground));
    const has = Boolean(st.prefs.newTabImage);
    picture.replaceChildren(...[
      h('button', { id: 'pick-wallpaper', text: has ? 'Change picture…' : 'Use a picture…', onclick: async () => { try { st = await S.pickWallpaper(); } catch (err) { alertLine(picture, err.message); } renderTiles(); } }),
      has ? h('button', { text: 'Remove picture', onclick: async () => { st = await S.removeWallpaper(); renderTiles(); } }) : null,
    ].filter(Boolean));
    tiles.querySelector('[data-value="image"]').hidden = !has;
  };
  for (const [value, label] of [...BACKGROUND_CHOICES, ['image', 'Your picture']]) {
    tiles.append(h('button', { type: 'button', role: 'radio', class: `bg-tile bg-${value}`, 'data-value': value, 'aria-label': label, title: label,
      onclick: async () => { await save('newTabBackground', value); renderTiles(); } }, h('span', { text: label })));
  }
  card.group('Background').append(stackRow('New tab background', 'Behind the new-tab page. A picture is resized and kept in your Lumen profile; it never leaves this computer.', tiles, picture));
  card.append(select('newTabWidgetGlass', 'Widget cards', 'How see-through the widget cards are. Clear is as transparent as possible while text stays readable; it looks best on a gradient or your own picture.',
    [['solid', 'Solid'], ['frosted', 'Frosted glass'], ['clear', 'Clear']]));
  const effectOptions = buildEffectOptions();
  card.append(select('newTabEffect', 'Animated effect', 'Moving particles over the background. Light on purpose: few particles, at most 30 frames a second, paused while the tab is hidden, and still with Reduce motion. It never covers the search box or the cards.',
    [['none', 'None'], ['particles', 'Particles'], ['stars', 'Stars'], ['bubbles', 'Bubbles'], ['snow', 'Snow']], { after: (v) => { effectOptions.hidden = v === 'none'; } }), effectOptions);
  effectOptions.hidden = st.prefs.newTabEffect === 'none';
  card.group('New tab page');
  const name = h('input', { type: 'text', id: 'pref-newTabName', class: 'grow', placeholder: 'Your name', maxlength: '40', 'aria-label': 'Name for the greeting' });
  name.value = st.prefs.newTabName || '';
  name.addEventListener('change', () => save('newTabName', name.value));
  const clockStyle = buildClockStyle();
  card.append(
    toggle('newTabClock', 'Show a clock on the new-tab page', null),
    select('newTabClockSize', 'Clock size', 'How big the clock is. It grows into the space above it, so the search box and your cards stay put; where cards leave no room, it is drawn a step smaller. In Edit layout you can also drag its corner.', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Extra large']]),
    ...clockStyle.clock, // [look]
    select('newTabSearchWidth', 'Search bar width', 'The width of the search bar and the column it sits in. Automatic fills the column. A wider bar is drawn only as wide as the cards beside it allow (the setting is kept for wider windows). In Edit layout you can also drag its edges.', [...new Set([480, 560, 640, 720, 800, 960, st.prefs.newTabSearchWidth])].sort((x, y) => (x === 640 ? -1 : y === 640 ? 1 : x - y)).map((w) => [w, w === 640 ? 'Automatic' : `${w} px`]), { number: true }),
    toggle('newTabHeader', 'Show the clock, date and greeting', 'Turn off to hide the whole top of the page: the clock, the date and the “Good evening” line.'),
    row('Greeting', '“Good evening, …” on the new-tab page. Leave it empty for no name.', name),
    ...clockStyle.greeting, // [look]
    toggle('newTabFavorites', 'Show favorites', 'Your bookmarks on the new-tab page.'),
    toggle('newTabFrequent', 'Show frequently visited sites', null),
    toggle('newTabPrivacy', 'Show ads and trackers blocked', null),
    toggle('newTabWidgetsPacked', 'Keep widgets packed', 'On: cards slide up into gaps as you move and resize them. Off (default): a card stays exactly where you put it, in any row.'),
  );
  renderTiles();
  const widgets = card.at('widgets');
  const sub = widgets.subpage('widgets', 'Widgets', 'Weather, calendar, tasks, headlines, music, mail and more, as cards on the new-tab page.', 'weather calendar todoist clock rss spotify gmail slack github stocks crypto tradingview chart notes countdown timer pomodoro custom recipe embed');
  try { await buildWidgets(sub); } catch (err) { sub.append(row('Widgets', String(err?.message || err))); }
}

// ---------- [widgets] cards on the new-tab page (features/widgets.js) ----------
// Lumen fetches their data itself; the page gets display data only, and tokens stay encrypted in
// the browser (they are sent in, never read back). Places, Todoist filters and colours are chosen here
// (and from a card's gear in edit mode on the new-tab page, which opens this editor).
const WIDGET_ICONS = {
  weather: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="6" r="2.6"/><path d="M6 1.2v1M1.2 6h1M2.6 2.6l.7.7M9.4 2.6l-.7.7"/><path d="M6.5 14h5.3a2.6 2.6 0 0 0 .3-5.2 3.5 3.5 0 0 0-6.6 1A2.2 2.2 0 0 0 6.5 14z"/></svg>',
  worldclock: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.2V8l2.6 1.6M2 8h12M8 2c-2 1.8-2 10.2 0 12M8 2c2 1.8 2 10.2 0 12"/></svg>',
  calendar: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2.2"/><path d="M2 6.5h12M5.5 1.6v2.6M10.5 1.6v2.6"/></svg>',
  todoist: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="m5.4 8.1 1.8 1.8 3.5-3.7"/></svg>',
  spotify: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M4.9 6.2c2.2-.7 4.7-.5 6.6.6M5.3 8.3c1.8-.5 3.7-.3 5.2.5M5.7 10.3c1.4-.4 2.7-.2 3.9.4"/></svg>',
  gmail: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2"/><path d="m2.4 4.4 5.6 4.2 5.6-4.2"/></svg>',
  slack: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 2 5 14M11 2l-1.2 12M2.6 5.6h11.2M2.2 10.4h11.2"/></svg>',
  github: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.7"/><circle cx="4.5" cy="12.5" r="1.7"/><circle cx="11.5" cy="6" r="1.7"/><path d="M4.5 5.2v5.6M11.5 7.7c0 2.4-3.2 2-6 3.4"/></svg>',
  feed: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5a9.5 9.5 0 0 1 9.5 9.5M3 7.5a5.5 5.5 0 0 1 5.5 5.5"/><circle cx="3.8" cy="12.2" r="1"/></svg>',
  muse: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l1.4 3.7 3.8 1.5-3.8 1.5L8 12.2 6.6 8.5 2.8 7l3.8-1.5z"/><path d="M12.5 11.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/></svg>',
  stocks: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12.5 6 8l2.6 2.6L14 4.5M10.5 4.5H14V8"/></svg>',
  crypto: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6.4 5v6M6.4 5h2.3a1.5 1.5 0 0 1 0 3H6.4m0 0h2.6a1.5 1.5 0 0 1 0 3H6.4M7.6 4v1M7.6 11v1"/></svg>',
  notes: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h7.5L13 5v8.5H3z"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3"/></svg>',
  countdown: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1.8h6M5 14.2h6M5.5 1.8c0 3.4 5 3.8 5 6.2s-5 2.8-5 6.2M10.5 1.8c0 3.4-5 3.8-5 6.2s5 2.8 5 6.2"/></svg>',
  timer: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="9" r="5.2"/><path d="M8 9V6.2M6.5 1.8h3M12.2 4.4l1-1"/></svg>',
  custom: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5 2 8l3.5 4.5M10.5 3.5 14 8l-3.5 4.5"/></svg>',
  tradingview: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10M4 5.5h-1.2M4 10h1.2M8 2v12M8 4.5H6.8M8 11h1.2M12 4v8M12 6h-1.2M12 9.5h1.2"/></svg>',
  embed: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="11" rx="2.2"/><path d="M1.8 5.8h12.4M4 4.2h.01M5.6 4.2h.01"/></svg>',
};
const WIDGET_HEIGHTS = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['tall', 'Tall']];
const WIDGET_SPANS = [['2', 'A third'], ['3', 'Half'], ['4', 'Two thirds'], ['6', 'Full width']];
const WIDGET_COLORS = [['calendar', 'Default'], ['match', 'Match screen'], ['accent', 'Accent only'], ['mono', 'Monochrome']];
const TODO_SOURCES = [['todayOverdue', 'Today and overdue'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['inbox', 'Inbox'], ['project', 'A project'], ['label', 'A label'], ['all', 'All tasks'], ['custom', 'A Todoist filter']];
const TODO_FIELDS = [['due', 'Due date and time'], ['project', 'Project name and color'], ['labels', 'Labels'], ['priority', 'Priority color'], ['description', 'Description'], ['subtasks', 'Subtask count'], ['recurring', 'Repeat icon']];
function widgetIcon(type) {
  const span = h('span', { class: `widget-icon wi-${type}` });
  span.innerHTML = WIDGET_ICONS[type] || ''; // constant markup
  return span;
}
async function buildWidgets(card) {
  let ws = await S.widgets.state();
  const WS = window.WidgetSummary;
  const list = h('div', { class: 'card widget-list', id: 'widget-list' });
  const formHost = h('div', { class: 'widget-form-host' });
  const add = h('button', { class: 'primary', id: 'widget-add', text: 'Add widget…', onclick: () => openForm() });
  const listNote = h('span', { class: 'note', role: 'status', id: 'widget-list-note' });
  const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  // One row per widget on the page: icon, name, what it is set to, and a chevron to its own page.
  const renderList = () => {
    const open = Boolean(formHost.firstChild);
    home.hidden = open;
    add.disabled = ws.widgets.length >= ws.max;
    add.title = add.disabled ? `The page holds up to ${ws.max} widgets. Remove one to add another.` : '';
    if (!ws.widgets.length) { list.replaceChildren(h('div', { class: 'row widget-empty' }, h('div', { class: 'text' }, h('span', { class: 'label', text: 'No widgets yet' }), h('span', { class: 'desc', text: 'Add the weather, your tasks, a calendar, headlines and more. They appear as cards on the new-tab page.' })))); return; }
    list.replaceChildren(...ws.widgets.map((w, i) => {
      const acct = WS.accountStatus(w, ws);
      const move = (dir) => (e) => { e.stopPropagation(); S.widgets.move(w.id, dir).then((next) => { ws = next; renderList(); }); };
      const item = h('div', { class: 'row link widget-item', 'data-id': w.id, 'data-type': w.type, tabindex: '0', role: 'link', 'aria-label': `${w.title}. ${WS.widgetSummary(w, ws)}. Open its settings` },
        widgetIcon(w.type),
        h('div', { class: 'text widget-text' }, h('span', { class: 'label widget-title', text: w.title }), h('span', { class: `desc${acct && !acct.connected ? ' needs' : ''}`, text: WS.widgetSummary(w, ws) })),
        h('div', { class: 'widget-actions' },
          h('button', { class: 'plain icon', text: '↑', 'aria-label': `Move ${w.title} up`, title: 'Move up', disabled: i === 0, onclick: move(-1) }),
          h('button', { class: 'plain icon', text: '↓', 'aria-label': `Move ${w.title} down`, title: 'Move down', disabled: i === ws.widgets.length - 1, onclick: move(1) }),
          h('span', { class: 'chev', 'aria-hidden': 'true' })));
      item.addEventListener('click', () => openForm(w));
      item.addEventListener('keydown', (e) => { if (e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openForm(w); } });
      return item;
    }));
  };
  const closeForm = () => { formGuard = null; formHost.replaceChildren(); renderList(); window.scrollTo?.({ top: 0 }); };
  // The open form's "are there unsaved changes?" (null when no form is open): closing the Settings tab asks first.
  let formGuard = null;
  window.addEventListener('beforeunload', (e) => { if (formGuard?.()) { e.preventDefault(); e.returnValue = ''; } });
  const sel = (id, label, options, value) => {
    const s = h('select', { id, 'aria-label': label }, options.map(([v, t]) => h('option', { value: String(v), text: t })));
    s.value = String(value);
    return s;
  };
  // A segmented control for two to four choices. Reads and writes .value like a select, and fires "change".
  const segment = (id, label, options, value) => {
    const el = h('div', { class: 'segctl', id, role: 'radiogroup', 'aria-label': label });
    let cur = String(value);
    const buttons = options.map(([v, t]) => h('button', { type: 'button', role: 'radio', 'data-value': String(v), text: t, onclick: () => { paint(String(v)); el.dispatchEvent(new Event('change', { bubbles: true })); } }));
    const paint = (v) => { cur = v; for (const b of buttons) { const on = b.dataset.value === v; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; } };
    Object.defineProperty(el, 'value', { get: () => cur, set: (v) => { paint(String(v)); } });
    el.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = buttons[(buttons.findIndex((b) => b.dataset.value === cur) + step + buttons.length) % buttons.length];
      next.click();
      next.focus();
    });
    paint(cur);
    el.append(...buttons);
    return el;
  };
  // An on/off row (a switch). .querySelector('input').checked is its value.
  const tog = (id, label, checked, desc) => {
    const input = h('input', { type: 'checkbox', class: 'switch', id, role: 'switch', 'aria-label': label, checked: Boolean(checked) });
    const r = row(label, desc, input);
    r.querySelector('.label').addEventListener('click', () => input.click());
    return r;
  };
  const chk = (id, label, checked) => h('label', { class: 'check' }, h('input', { type: 'checkbox', id, checked: Boolean(checked) }), label);

  // Add or edit: a type, its fields, and Check before Save.
  function openForm(existing = null, initialType = null) {
    let type = existing?.type || initialType || 'weather';
    const note = h('span', { class: 'note', role: 'status', id: 'widget-note' });
    const fields = h('div', { class: 'widget-fields' });
    const title = h('input', { type: 'text', id: 'widget-title', placeholder: 'Automatic', maxlength: '60', 'aria-label': 'Card title' });
    title.value = existing?.customTitle || '';
    const inputs = {};
    // Grouped sections of rows, like the rest of Settings: setting = label (and a muted line) with its control on the right;
    // block = label with the content below it; section = a titled inset list; advanced = the same, collapsed.
    const setting = (label, control, hint, ...more) => row(label, hint, control, ...more);
    const block = (label, hint, ...content) => stackRow(label, hint, ...content);
    const section = (title, rows, foot) => h('div', { class: 'group wf-section' }, title ? h('h3', { class: 'group-title', text: title }) : null, h('div', { class: 'card' }, rows.filter(Boolean)), foot ? h('p', { class: 'wf-foot', text: foot }) : null);
    const advanced = (rows, foot, open = false) => h('details', { class: 'group wf-advanced', ...(open ? { open: '' } : {}) }, h('summary', { text: 'Advanced' }), h('div', { class: 'card' }, rows.filter(Boolean)), foot ? h('p', { class: 'wf-foot', text: foot }) : null);
    // "Where do I get this?" under a row's muted line; opens one fixed page by name.
    const helpLink = (r, key, text) => { r.querySelector('.text').append(h('button', { type: 'button', class: 'linkish', text, onclick: () => S.widgets.help(key) })); return r; };
    let places = (existing?.type === 'weather' && existing.wx?.places ? existing.wx.places : []).map((p) => ({ ...p }));
    let projects = [];
    let clockPlaces = (existing?.type === 'worldclock' && existing.wc?.places ? existing.wc.places : []).map((p) => ({ ...p }));
    const colors = sel('widget-colors', 'Card colors', WIDGET_COLORS, existing?.colors || 'calendar');

    // ---- weather: places, units, sections ----
    function weatherFields(same) {
      const wx = same?.wx || {};
      const placesBox = h('div', { class: 'wx-edit-places', id: 'widget-places' });
      const results = h('div', { class: 'wx-edit-results', id: 'widget-results' });
      const drawPlaces = () => {
        placesBox.replaceChildren(...places.map((p, i) => h('div', { class: 'item wx-edit-place' },
          h('span', { class: 'grow', text: p.here ? `My location${p.name && p.name !== 'My location' ? ` (${p.name})` : ''}` : p.name }),
          h('input', { type: 'text', class: 'wx-nick', maxlength: '30', placeholder: 'Nickname (optional)', 'aria-label': `Nickname for ${p.name}`, value: p.nick || '', onchange: (e) => { places[i] = { ...places[i], nick: e.target.value.trim() || undefined }; } }),
          h('button', { class: 'plain icon', text: '↑', 'aria-label': `Move ${p.name} up`, disabled: i === 0, onclick: () => { [places[i - 1], places[i]] = [places[i], places[i - 1]]; drawPlaces(); } }),
          h('button', { class: 'plain icon', text: '↓', 'aria-label': `Move ${p.name} down`, disabled: i === places.length - 1, onclick: () => { [places[i + 1], places[i]] = [places[i], places[i + 1]]; drawPlaces(); } }),
          h('button', { class: 'danger', text: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: () => { places.splice(i, 1); drawPlaces(); } }))));
        if (!places.length) placesBox.append(h('p', { class: 'note', text: 'No places yet. Search for a city below, or use your location.' }));
        const saved = (ws.savedPlaces || []).filter((s) => !places.some((p) => !p.here && Math.abs(p.lat - s.lat) < 0.01 && Math.abs(p.lon - s.lon) < 0.01));
        results.replaceChildren(...saved.map((s) => h('button', { class: 'plain', text: `+ ${s.nick || s.name}`, title: 'A place you used before', onclick: () => { if (places.length < 6) { places.push({ ...s }); drawPlaces(); } } })));
      };
      inputs.city = h('input', { type: 'text', id: 'widget-city', placeholder: 'City or ZIP code', maxlength: '80', 'aria-label': 'Search for a place' });
      inputs.city.value = places.length ? '' : same?.place || '';
      const found = h('div', { class: 'wx-edit-found', id: 'widget-found' });
      const search = async () => {
        const q = inputs.city.value.trim();
        if (q.length < 2) return;
        found.replaceChildren(h('span', { class: 'note', text: 'Searching…' }));
        try {
          const out = await S.widgets.search(q);
          found.replaceChildren(...(out.length ? out.map((r) => h('button', { class: 'plain', text: `+ ${r.name}`, onclick: () => { if (places.length < 6 && !places.some((p) => !p.here && Math.abs(p.lat - r.lat) < 0.01 && Math.abs(p.lon - r.lon) < 0.01)) places.push({ name: r.name, lat: r.lat, lon: r.lon }); found.replaceChildren(); inputs.city.value = ''; drawPlaces(); } })) : [h('span', { class: 'note', text: `No place called “${q}” was found.` })]));
        } catch (err) { found.replaceChildren(h('span', { class: 'note error', text: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })); }
      };
      inputs.city.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      const here = h('button', { id: 'widget-here', text: 'Use my location', onclick: () => { if (places.length < 6 && !places.some((p) => p.here)) places.push({ here: true, name: 'My location' }); drawPlaces(); } });
      const consentNote = h('span', { class: 'note', id: 'widget-location-note' });
      const drawConsent = () => {
        const loc = ws.location || { consent: 'unset', service: 'an IP service', here: '' };
        consentNote.textContent = loc.consent === 'granted' ? `My location is on: Lumen asks ${loc.service} which city your network is in${loc.here ? ` (last answer: ${loc.here})` : ''}.`
          : loc.consent === 'denied' ? 'My location is off.' : `Lumen asks ${loc.service} which city your network is in. ${loc.service} sees your IP address; nothing else is sent. Nothing is asked until you allow it.`;
        consent.replaceChildren(
          loc.consent === 'granted' ? null : h('button', { id: 'widget-location-allow', text: 'Allow', onclick: async () => { ws = await S.widgets.location('allow'); drawConsent(); } }),
          loc.consent === 'denied' ? null : h('button', { id: 'widget-location-deny', text: loc.consent === 'granted' ? 'Turn off' : 'Not now', onclick: async () => { ws = await S.widgets.location('deny'); drawConsent(); } }),
        );
      };
      const consent = h('span', { class: 'widget-consent' });
      drawConsent();
      inputs.units = segment('widget-units', 'Temperature', [['f', '°F'], ['c', '°C']], same?.units || wx.units || (/^en-US$/i.test(navigator.language) ? 'f' : 'c'));
      inputs.wind = segment('widget-wind', 'Wind speed', [['auto', 'Auto'], ['mph', 'mph'], ['kmh', 'km/h'], ['ms', 'm/s']], wx.wind || 'auto');
      inputs.clock = segment('widget-clock', 'Time format', [['auto', 'System'], ['12', '12-hour'], ['24', '24-hour']], wx.clock || 'auto');
      inputs.days = segment('widget-days', 'Days in the forecast', [[7, '7 days'], [10, '10 days']], wx.days || 7);
      inputs.hours = segment('widget-hours', 'Hours in the hourly strip', [[12, '12 hours'], [24, '24 hours']], wx.hours || 12);
      inputs.view = segment('widget-view', 'When there are several places', [['auto', 'Automatic'], ['cycle', 'One at a time'], ['list', 'List']], wx.view || 'auto');
      const show = wx.show || {};
      inputs.show = {
        now: tog('widget-show-now', 'Current conditions', show.now !== false),
        hourly: tog('widget-show-hourly', 'Hourly forecast', show.hourly !== false),
        daily: tog('widget-show-daily', 'Daily forecast', show.daily !== false),
        details: tog('widget-show-details', 'Details', show.details !== false, 'Wind, humidity, UV index, sunrise and sunset.'),
      };
      drawPlaces();
      const addBar = h('div', { class: 'widget-inline' }, inputs.city, h('button', { id: 'widget-search', text: 'Search', onclick: search }), here);
      const locRow = setting('Use my location', consent);
      locRow.querySelector('.text').append(consentNote);
      fields.replaceChildren(
        section('Places', [
          h('div', { class: 'row stack' }, placesBox),
          block('Add a place', 'Up to 6. With more than one, the card can step through them or list them. Forecasts come from Open-Meteo (free, no account); only the place is sent.', addBar, found, results),
          locRow,
        ]),
        section('Show', Object.values(inputs.show), 'The card also shows more or less depending on its size.'),
        section('Units', [setting('Temperature', inputs.units), setting('Wind speed', inputs.wind), setting('Time format', inputs.clock)]),
        section('Forecast', [setting('Days shown', inputs.days), setting('Hours in the hourly strip', inputs.hours), setting('When there are several places', inputs.view, 'Automatic chooses by the card’s size.')]));
    }
    // ---- world clock: places, clock format, what each row shows ----
    function clockFields(same) {
      const wc = same?.wc || {};
      const placesBox = h('div', { class: 'wx-edit-places', id: 'widget-places' });
      const found = h('div', { class: 'wx-edit-found', id: 'widget-found' });
      const drawPlaces = () => {
        placesBox.replaceChildren(...clockPlaces.map((p, i) => h('div', { class: 'item wx-edit-place' },
          h('span', { class: 'grow', text: p.tz ? `${p.name} (${p.tz})` : p.name }),
          h('input', { type: 'text', class: 'wx-nick', maxlength: '30', placeholder: tr('widgets.worldclock.nickname', 'Nickname'), 'aria-label': tr('widgets.worldclock.nicknameFor', 'Nickname for {name}', { name: p.name }), value: p.nick || '', onchange: (e) => { clockPlaces[i] = { ...clockPlaces[i], nick: e.target.value.trim() || undefined }; } }),
          h('button', { class: 'plain icon', text: '↑', 'aria-label': `Move ${p.name} up`, disabled: i === 0, onclick: () => { [clockPlaces[i - 1], clockPlaces[i]] = [clockPlaces[i], clockPlaces[i - 1]]; drawPlaces(); } }),
          h('button', { class: 'plain icon', text: '↓', 'aria-label': `Move ${p.name} down`, disabled: i === clockPlaces.length - 1, onclick: () => { [clockPlaces[i + 1], clockPlaces[i]] = [clockPlaces[i], clockPlaces[i + 1]]; drawPlaces(); } }),
          h('button', { class: 'danger', text: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: () => { clockPlaces.splice(i, 1); drawPlaces(); } }))));
        if (!clockPlaces.length) placesBox.append(h('p', { class: 'note', text: tr('widgets.worldclock.noPlaces', 'No places yet: search below.') }));
      };
      inputs.city = h('input', { type: 'text', id: 'widget-city', placeholder: tr('widgets.worldclock.search', 'City or ZIP code'), maxlength: '80', 'aria-label': tr('widgets.worldclock.searchLabel', 'Search for a place') });
      const search = async () => {
        const q = inputs.city.value.trim();
        if (q.length < 2) return;
        found.replaceChildren(h('span', { class: 'note', text: 'Searching…' }));
        try {
          const out = await S.widgets.search(q);
          found.replaceChildren(...(out.length ? out.map((r) => h('button', { class: 'plain', text: `+ ${r.name}`, onclick: () => { if (clockPlaces.length < 8 && !clockPlaces.some((p) => Math.abs(p.lat - r.lat) < 0.01 && Math.abs(p.lon - r.lon) < 0.01)) clockPlaces.push({ name: r.name, lat: r.lat, lon: r.lon, ...(r.tz ? { tz: r.tz } : {}) }); found.replaceChildren(); inputs.city.value = ''; drawPlaces(); } })) : [h('span', { class: 'note', text: `No place called “${q}” was found.` })]));
        } catch (err) { found.replaceChildren(h('span', { class: 'note error', text: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })); }
      };
      inputs.city.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
      inputs.clock = segment('widget-clock', 'Time format', [['auto', 'System'], ['12', '12-hour'], ['24', '24-hour']], wc.clock || 'auto');
      const show = wc.show || {};
      inputs.seconds = tog('widget-show-seconds', tr('widgets.worldclock.seconds', 'Seconds'), wc.seconds === true);
      inputs.show = {
        date: tog('widget-show-date', tr('widgets.worldclock.date', 'Date'), show.date !== false),
        offset: tog('widget-show-offset', tr('widgets.worldclock.offset', 'Hours ahead or behind you'), show.offset !== false),
        sun: tog('widget-show-sun', tr('widgets.worldclock.sun', 'Sunrise and sunset'), show.sun !== false),
      };
      drawPlaces();
      fields.replaceChildren(
        section(tr('widgets.worldclock.places', 'Places'), [
          h('div', { class: 'row stack' }, placesBox),
          block('Add a place', tr('widgets.worldclock.hint', 'Sunrise and sunset come from Open-Meteo (free, no account); only the place goes to it. The time itself is worked out on the page and needs no network.'),
            h('div', { class: 'widget-inline' }, inputs.city, h('button', { id: 'widget-search', text: 'Search', onclick: search })), found),
        ]),
        section(tr('widgets.worldclock.show', 'Show'), [setting('Time format', inputs.clock), inputs.seconds, ...Object.values(inputs.show)]));
    }
    // ---- todoist: what to show ----
    function todoFields(same) {
      const t = same?.todo || {};
      const f = t.fields || {};
      inputs.token = h('input', { type: 'password', id: 'widget-token', autocomplete: 'off', spellcheck: 'false', placeholder: ws.secrets.todoist ? 'Saved. Paste a new token to replace it' : 'Paste your API token', 'aria-label': 'Todoist API token' });
      inputs.source = sel('widget-source', 'Which tasks', TODO_SOURCES, t.source || 'todayOverdue');
      inputs.days = h('input', { type: 'number', id: 'widget-tdays', min: '1', max: '30', value: String(t.days || 7), 'aria-label': 'Days ahead' });
      inputs.project = sel('widget-project', 'Project', [[t.projectId || '', t.projectName || 'Load projects…']], t.projectId || '');
      inputs.label = h('input', { type: 'text', id: 'widget-label', maxlength: '60', placeholder: 'label', value: t.label || '', 'aria-label': 'Label name' });
      inputs.query = h('input', { type: 'text', id: 'widget-query', maxlength: '200', placeholder: 'e.g. (today | overdue) & p1', value: t.query || '', 'aria-label': 'Todoist filter' });
      const load = h('button', { id: 'widget-load-projects', text: 'Load projects', onclick: async () => {
        try {
          projects = await S.widgets.projects(inputs.token.value);
          inputs.project.replaceChildren(...projects.map((p) => h('option', { value: p.id, text: p.name })));
          inputs.project.value = t.projectId && projects.some((p) => p.id === t.projectId) ? t.projectId : projects[0]?.id || '';
          inputs.quickProject.replaceChildren(h('option', { value: '', text: 'Inbox (Todoist’s default)' }), ...projects.map((p) => h('option', { value: p.id, text: p.name })));
          inputs.quickProject.value = t.quickProjectId || '';
          flash(note, `${projects.length} projects loaded.`, 'ok');
        } catch (err) { flash(note, clean(err), 'err'); }
      } });
      const daysRow = setting('Days ahead', inputs.days);
      const projectRow = setting('Project', inputs.project, 'Needs your token: press Load projects to fill the list.', load);
      const labelRow = setting('Label', inputs.label, 'The label’s name, without the @.');
      const queryRow = setting('Filter', inputs.query, 'Todoist’s own filter language, like “today & p1”.');
      const syncSource = () => {
        const v = inputs.source.value;
        daysRow.hidden = v !== 'upcoming';
        projectRow.hidden = v !== 'project';
        labelRow.hidden = v !== 'label';
        queryRow.hidden = v !== 'custom';
      };
      inputs.source.addEventListener('change', syncSource);
      syncSource();
      inputs.group = sel('widget-group', 'Group by', [['none', 'No grouping'], ['project', 'Project'], ['due', 'Due date'], ['priority', 'Priority'], ['label', 'Label']], t.group || 'none');
      inputs.sort = sel('widget-sort', 'Sort by', [['due', 'Due date'], ['priority', 'Priority'], ['project', 'Project'], ['manual', 'Todoist’s own order'], ['created', 'Date added']], t.sort || 'due');
      inputs.density = segment('widget-density', 'Spacing', [['comfortable', 'Comfortable'], ['compact', 'Compact']], t.density || 'comfortable');
      inputs.max = sel('widget-max', 'Tasks shown', [[5, '5'], [10, '10'], [20, '20'], [50, '50'], [0, 'All (scrolls)']], t.max ?? 10);
      inputs.fields = Object.fromEntries(TODO_FIELDS.map(([k, label]) => [k, tog(`widget-field-${k}`, label, f[k] ?? ({ due: true, priority: true, recurring: true }[k] || false))]));
      inputs.showDone = tog('widget-showdone', 'Tasks completed today', t.showDone, 'Keep them on the card, crossed out.');
      inputs.overdueRed = tog('widget-overdue', 'Overdue in red', t.overdueRed !== false);
      inputs.showCount = tog('widget-showcount', 'Task count in the title', t.showCount);
      inputs.quick = segment('widget-quick', 'Add-task box', [['off', 'Off'], ['top', 'Top'], ['bottom', 'Bottom']], t.quick || 'off');
      inputs.quickProject = sel('widget-quickproject', 'New tasks go to', [['', 'Inbox (Todoist’s default)'], ...(t.quickProjectId ? [[t.quickProjectId, 'The chosen project']] : [])], t.quickProjectId || '');
      const tokenRow = helpLink(setting('API token', inputs.token, ws.secrets.todoist ? 'Connected: a token is saved. Paste a new one only to replace it.' : 'Not connected yet. Paste your personal API token.'), 'todoist', 'Where do I find it?');
      fields.replaceChildren(
        section('Account', [tokenRow], 'Stored encrypted by your system. It never reaches the new-tab page.'),
        section('Tasks', [setting('Show', inputs.source), daysRow, projectRow, labelRow, queryRow, setting('Tasks shown', inputs.max), setting('Sort by', inputs.sort), setting('Group by', inputs.group)]),
        section('Each task shows', Object.values(inputs.fields)),
        section('Also', [inputs.showDone, inputs.overdueRed, inputs.showCount, setting('Spacing', inputs.density)]),
        advanced([setting('Add-task box', inputs.quick, 'A box on the card to add tasks, typed like Todoist’s quick add: “Pay rent tomorrow 9am”.'), setting('New tasks go to', inputs.quickProject, 'Press Load projects above to pick a project.')]));
    }
    // ---- spotify: the user's own Client ID, then Connect (OAuth PKCE in a tab; the token stays in the browser) ----
    function spotifyFields(same) {
      const sp = () => ws.spotify || {};
      inputs.clientId = h('input', { type: 'text', id: 'widget-clientid', autocomplete: 'off', spellcheck: 'false', maxlength: '64', placeholder: '32-character Client ID', value: same?.clientId || '', 'aria-label': 'Your own Spotify app’s Client ID' });
      inputs.art = tog('widget-spotify-art', 'Album art', same ? same.art !== false : true);
      // 'web' shows Spotify's own site in the card (sign in there, nothing to set up); 'api' is Lumen's own now-playing card.
      inputs.mode = segment('widget-spotify-mode', 'How Spotify is shown', [['web', 'Web player'], ['api', 'Now playing card']], same ? same.mode || 'api' : 'web');
      const modeRow = block('How to show Spotify', 'Web player: Spotify’s own site in the card. You sign in on Spotify’s site and there is nothing to set up (recommended). Now playing card: Lumen’s own card, using Spotify’s API.', inputs.mode);
      const status = h('span', { class: 'sp-status', role: 'status', id: 'widget-spotify-status' });
      const login = h('button', { id: 'widget-spotify-connect', class: 'primary big', text: 'Log in with Spotify' });
      const disconnect = h('button', { id: 'widget-spotify-disconnect', class: 'danger', text: 'Disconnect' });
      const oneLine = h('span', { class: 'note', text: 'Lumen opens Spotify’s sign-in in your browser; you approve, and you’re back here.' });
      const premium = h('span', { class: 'note', text: 'Play, pause, next and previous need Spotify Premium.' });
      const loginRow = h('div', { class: 'row stack sp-login' }, h('div', { class: 'sp-actions' }, login, disconnect), status, oneLine, premium);
      // Own-app path, in plain steps: create the app, register the address, paste its Client ID.
      const redirect = sp().redirect || '';
      const copy = h('button', { type: 'button', id: 'widget-spotify-copy', text: 'Copy', onclick: async () => { try { await navigator.clipboard.writeText(redirect); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select it to copy'; } setTimeout(() => { copy.textContent = 'Copy'; }, 1800); } });
      const loginOwn = h('button', { id: 'widget-spotify-login-own', text: 'Log in', title: 'Log in through your own app' });
      const steps = h('div', { class: 'row stack sp-steps' },
        h('span', { class: 'note', text: 'Lumen’s own Spotify app works for accounts on its list (Spotify limits it to 25 people). Your own free app has no such limit for you. No client secret is needed.' }),
        h('div', { class: 'widget-inline' }, h('button', { type: 'button', id: 'widget-spotify-dashboard', text: 'Open Spotify Developer Dashboard', onclick: () => S.widgets.help('spotify') })),
        h('ol', { class: 'sp-list' },
          h('li', { text: 'Create an app there. Any name and description will do.' }),
          h('li', {}, 'Add this Redirect URI and tick “Web API”: ', h('code', { class: 'sp-redirect', text: redirect }), ' ', copy),
          h('li', {}, 'Paste the app’s Client ID: ', h('span', { class: 'widget-inline' }, inputs.clientId, loginOwn))));
      const ownId = () => /^[0-9a-fA-F]{32}$/.test(inputs.clientId.value.trim());
      let waited = false;
      const drawStatus = () => {
        const on = Boolean(ws.secrets.spotify);
        const name = sp().name;
        status.textContent = on ? (name ? `Connected as ${name}` : 'Connected') : 'Not logged in';
        status.className = `sp-status${on ? ' on' : ''}`;
        login.hidden = on;
        disconnect.hidden = !on;
        oneLine.hidden = on;
        if (on && !name && !waited) { waited = true; setTimeout(async () => { try { ws = await S.widgets.state(); drawStatus(); } catch { /* the name is only nice to have */ } }, 1500); }
      };
      const start = async () => {
        if (!sp().shared && !ownId()) { flash(note, 'Paste your app’s Client ID in step 3 first.', 'warn'); inputs.clientId.focus(); return; }
        login.disabled = loginOwn.disabled = true;
        flash(note, 'Waiting for Spotify in the tab that just opened…', 'ok');
        try {
          const r = await S.widgets.spotifySignIn(inputs.clientId.value);
          ws = await S.widgets.state();
          drawStatus();
          flash(note, r.message || (r.ok ? 'Spotify is connected.' : 'Spotify sign-in did not finish.'), r.ok ? 'ok' : 'warn');
        } catch (err) { flash(note, clean(err), 'err'); }
        login.disabled = loginOwn.disabled = false;
      };
      login.addEventListener('click', start);
      loginOwn.addEventListener('click', () => { if (!ownId()) { flash(note, 'That doesn’t look like a Client ID: it is 32 letters and digits.', 'warn'); inputs.clientId.focus(); return; } start(); });
      disconnect.addEventListener('click', async () => { await S.widgets.spotifyDisconnect(); ws = await S.widgets.state(); drawStatus(); flash(note, 'Spotify is disconnected.', 'ok'); });
      drawStatus();
      const apiBox = h('div', { class: 'wf-mode-api' },
        section('Account', [loginRow]),
        section('Can’t sign in? Use your own Spotify app', [steps]),
        section('Show', [inputs.art]));
      const webNote = h('p', { class: 'wf-foot wf-mode-web', text: 'The card shows open.spotify.com. Sign in there once; Lumen never sees your Spotify password or token.' });
      const syncMode = () => { apiBox.hidden = inputs.mode.value !== 'api'; webNote.hidden = inputs.mode.value !== 'web'; };
      inputs.mode.addEventListener('change', syncMode);
      syncMode();
      fields.replaceChildren(section('Mode', [modeRow]), webNote, apiBox);
    }
    // ---- gmail: your own Google Cloud OAuth client, then Connect (opens your browser) ----
    function gmailFields(same) {
      const g = same || {};
      const connected = () => Boolean(ws.connections?.gmail);
      inputs.clientId = h('input', { type: 'text', id: 'widget-clientid', autocomplete: 'off', spellcheck: 'false', maxlength: '300', placeholder: '1234567890-abc.apps.googleusercontent.com', 'aria-label': tr('settings.gmail.clientId', 'Google OAuth Client ID'), value: g.clientId || '' });
      inputs.clientSecret = h('input', { type: 'password', id: 'widget-clientsecret', autocomplete: 'off', spellcheck: 'false', maxlength: '300', placeholder: ws.secrets?.gmail ? tr('settings.gmail.secretSaved', 'Saved. Paste a new secret to replace it.') : tr('settings.gmail.secretHint', 'Client secret'), 'aria-label': tr('settings.gmail.clientSecret', 'Google OAuth client secret') });
      inputs.count = sel('widget-gmail-count', tr('settings.gmail.count', 'Messages shown'), [3, 4, 5, 6, 8, 10].map((n) => [n, String(n)]), g.count || 5);
      inputs.snippets = tog('widget-gmail-snippets', tr('settings.gmail.snippets', 'Show a short preview under each subject'), g.snippets !== false);
      const status = h('span', { class: 'sp-status', role: 'status', id: 'widget-gmail-status' });
      // builtin: Lumen was built with its own Google client, so "Sign in with Google" needs no setup and
      // the user's own Google Cloud client moves under Advanced (it still wins when its Client ID is filled in).
      const builtin = Boolean(ws.gmailClient?.builtin);
      const own = () => Boolean(inputs.clientId.value.trim());
      // Connected, it stays: "Sign in again" switches account or mends a sign-in Google ended.
      const connectLabel = () => (connected() || ws.gmailSignedOut ? tr('settings.gmail.signInAgain', 'Sign in again') : builtin && !own() ? tr('settings.gmail.signIn', 'Sign in with Google') : tr('settings.gmail.connect', 'Connect Gmail'));
      const connect = h('button', { id: 'widget-gmail-connect', class: 'primary big', text: connectLabel() });
      const cancel = h('button', { id: 'widget-gmail-cancel', text: tr('settings.gmail.cancel', 'Cancel'), hidden: true });
      const disconnect = h('button', { class: 'danger', id: 'widget-gmail-disconnect', text: tr('settings.gmail.disconnect', 'Disconnect') });
      const accountRow = h('div', { class: 'row stack sp-login' }, h('div', { class: 'sp-actions' }, connect, cancel, disconnect), status,
        h('span', { class: 'note', text: tr('settings.gmail.readOnly', 'Read-only: Lumen can see sender, subject and a preview, and cannot send, delete or change anything. Google’s sign-in opens in your browser.') }),
        // Said before the user tries, not after five silent minutes: until Google approves it, not every account can use it.
        builtin && !ws.gmailClient?.verified ? h('span', { class: 'note', id: 'widget-gmail-unverified', text: tr('settings.gmail.unverified', 'Google is still reviewing Lumen’s sign-in. If Google says Lumen “hasn’t verified this app”, choose Advanced › Go to Lumen. If it says “Access blocked”, use your own Google Cloud client under Advanced.') }) : null);
      const adv = advanced([
        builtin ? h('div', { class: 'row stack' }, h('span', { class: 'note', text: tr('settings.gmail.ownHint', 'Optional. Sign in with Google works without this. To use a Google Cloud project of your own instead, paste its Desktop app client here; it is then used instead of Lumen’s.') })) : null,
        helpLink(setting(tr('settings.gmail.clientId', 'Google OAuth Client ID'), inputs.clientId, builtin ? 'Leave empty to use Lumen’s own Google sign-in.' : 'Gmail needs a Google Cloud project of your own. Enable the Gmail API and create an OAuth client of type Desktop app.'), 'gmail', 'Open Google Cloud Console'),
        setting(tr('settings.gmail.clientSecret', 'Google OAuth client secret'), inputs.clientSecret, 'From the same client. Stored encrypted by your system.'),
      ], tr('settings.gmail.limits', 'Because you use your own Google Cloud project, Google’s limits for unverified apps apply: while the project is in Testing, only test users you add can connect, Google shows a “hasn’t verified this app” warning, and the connection ends every 7 days, so you connect again then. Publishing the project removes the 7-day limit.'), !builtin && !g.clientId);
      adv.querySelector('summary').textContent = builtin ? tr('settings.gmail.advancedOwn', 'Advanced: use your own Google Cloud client') : tr('settings.advanced', 'Advanced');
      inputs.clientId.addEventListener('input', () => { connect.textContent = connectLabel(); const n = accountRow.querySelector('#widget-gmail-unverified'); if (n) n.hidden = own(); }); // the review note is about Lumen's client only
      const draw = () => {
        disconnect.hidden = !connected();
        connect.textContent = connectLabel();
        connect.className = connected() ? '' : 'primary big';
        if (!status.textContent) {
          status.textContent = connected() ? (ws.gmailAccount ? tr('settings.gmail.connectedAs', 'Connected as {email}.', { email: ws.gmailAccount }) : tr('settings.gmail.connected', 'A Google account is connected.'))
            : ws.gmailSignedOut ? tr('settings.gmail.signedOut', 'Google signed Lumen out of {email}. Sign in again to see your inbox.', { email: ws.gmailSignedOut }) : tr('settings.gmail.notConnected', 'Not connected yet.');
          status.className = `sp-status${connected() ? ' on' : ''}`;
        }
      };
      connect.addEventListener('click', async () => {
        if (!builtin && !own()) { adv.open = true; flash(status, tr('settings.gmail.needClient', 'First add your Google Cloud Client ID and secret under Advanced.'), 'warn'); inputs.clientId.focus(); return; }
        connect.disabled = true;
        cancel.hidden = false;
        flash(status, tr('settings.gmail.waiting', 'Finish signing in, in your browser. Lumen is waiting…'), 'ok');
        // After a minute, what may have happened (Google never comes back when it blocks the sign-in).
        const hint = setTimeout(() => flash(status, builtin && !own() && !ws.gmailClient?.verified ? tr('settings.gmail.stillWaiting', 'Still waiting. If Google says Lumen “hasn’t verified this app”, choose Advanced › Go to Lumen. If it says “Access blocked”, use your own Google Cloud client under Advanced.') : tr('settings.gmail.stillWaitingOwn', 'Still waiting. Finish signing in, in your browser, or Cancel and try again.'), 'warn'), 60000);
        try {
          const r = await S.widgets.gmailConnect({ clientId: inputs.clientId.value, clientSecret: inputs.clientSecret.value });
          ws = r.state;
          inputs.clientSecret.value = '';
          inputs.clientSecret.placeholder = tr('settings.gmail.secretSaved', 'Saved. Paste a new secret to replace it.');
          status.textContent = '';
          flash(status, r.message, 'ok');
        } catch (err) {
          if (/cancel/i.test(clean(err))) status.textContent = ''; // the user's own Cancel: back to how it was
          else flash(status, clean(err), 'err');
        }
        clearTimeout(hint);
        connect.disabled = false;
        cancel.hidden = true;
        draw();
      });
      cancel.addEventListener('click', () => S.widgets.gmailCancel());
      // Two steps: the first click asks, a second within 4 s disconnects.
      let armed = 0;
      disconnect.addEventListener('click', async () => {
        if (!armed) {
          disconnect.textContent = tr('settings.gmail.disconnectConfirm', 'Disconnect? Click again');
          armed = setTimeout(() => { armed = 0; disconnect.textContent = tr('settings.gmail.disconnect', 'Disconnect'); }, 4000);
          return;
        }
        clearTimeout(armed);
        armed = 0;
        disconnect.textContent = tr('settings.gmail.disconnect', 'Disconnect');
        ws = await S.widgets.gmailDisconnect();
        status.textContent = '';
        flash(status, ws?.gmailClient?.revoked === false
          ? tr('settings.gmail.disconnectedLocal', 'Disconnected on this computer. Google didn’t confirm the revoke; remove Lumen at myaccount.google.com/permissions to be sure.')
          : tr('settings.gmail.disconnected', 'Disconnected. Google confirmed Lumen no longer has access.'), 'ok');
        draw();
      });
      draw();
      // A connection that changed elsewhere (Google ended it, the card signed in) shows here at once.
      gmailWatch = async () => {
        if (!accountRow.isConnected || connect.disabled || armed) return; // a sign-in or a confirm is under way
        const next = await S.widgets.state();
        const was = `${Boolean(ws.connections?.gmail)}|${ws.gmailAccount || ''}|${ws.gmailSignedOut || ''}`;
        const now = `${Boolean(next.connections?.gmail)}|${next.gmailAccount || ''}|${next.gmailSignedOut || ''}`;
        ws = next;
        if (was === now) return; // nothing about this account changed: its message stays
        status.textContent = '';
        draw();
      };
      if (!gmailWatchOn) { gmailWatchOn = true; S.widgets.onChanged?.(() => gmailWatch?.()); } // one listener per page, whatever editor is open
      fields.replaceChildren(
        section(tr('settings.gmail.account', 'Account'), [accountRow]),
        section(tr('settings.gmail.show', 'Show'), [setting(tr('settings.gmail.count', 'Messages shown'), inputs.count), inputs.snippets]),
        adv);
    }
    // ---- slack: sign in (OAuth v2 with your own Slack app), then what to show ----
    function slackFields(same) {
      const sc = same?.slack || {};
      let st = ws.slack || {};
      const picked = new Map((sc.channels || []).map((c) => [c.id, c.name]));
      inputs.token = h('input', { type: 'password', id: 'widget-token', autocomplete: 'off', spellcheck: 'false', placeholder: 'xoxp-… (optional)', 'aria-label': 'Slack user token' });
      const clientId = h('input', { type: 'text', id: 'slack-client-id', autocomplete: 'off', spellcheck: 'false', placeholder: '1234567890.1234567890', value: st.clientId || '', 'aria-label': 'Slack app Client ID' });
      const clientSecret = h('input', { type: 'password', id: 'slack-client-secret', autocomplete: 'off', spellcheck: 'false', placeholder: st.hasSecret ? 'Saved. Paste a new secret to replace it' : 'Client Secret', 'aria-label': 'Slack app Client Secret' });
      const redirect = h('input', { type: 'url', id: 'slack-redirect', spellcheck: 'false', value: st.redirect || '', 'aria-label': 'Slack redirect URL' });
      const pasted = h('input', { type: 'text', id: 'slack-pasted', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the address you landed on', 'aria-label': 'Address after approving' });
      const status = h('span', { class: 'sp-status', role: 'status', id: 'slack-status' });
      const drawStatus = () => {
        st = ws.slack || st;
        if (st.connected && st.reconnect) flash(status, `Slack no longer accepts the sign-in${st.team ? ` for ${st.team}` : ''}. Log in again to reconnect.`, 'warn');
        else if (st.connected) flash(status, `Connected${st.team ? ` to ${st.team}` : ''}${st.canRefresh ? ' (renews itself)' : ''}. Read-only.`, 'ok');
        else if (st.waiting) flash(status, 'Approve in the browser tab that opened, then paste the address it ends on.', 'note');
        else { status.textContent = 'Not connected.'; status.className = 'sp-status'; }
        disconnect.hidden = !st.connected;
        open.textContent = st.connected ? 'Log in again' : 'Log in with Slack';
        open.classList.toggle('primary', !st.connected);
        pastedRow.hidden = !st.waiting;
      };
      const open = h('button', { type: 'button', id: 'slack-open', class: 'primary big', text: 'Log in with Slack', onclick: async () => {
        if (!clientId.value.trim() && !st.clientId) { adv.open = true; flash(status, 'First add your Slack app’s Client ID and secret under Advanced.', 'warn'); clientId.focus(); return; }
        try {
          const r = await S.widgets.slackStart({ clientId: clientId.value, clientSecret: clientSecret.value, redirect: redirect.value });
          ws = r.state; clientSecret.value = ''; drawStatus();
        } catch (err) { flash(status, clean(err), 'err'); }
      } });
      const finish = h('button', { type: 'button', id: 'slack-finish', text: 'Finish', onclick: async () => {
        try {
          const r = await S.widgets.slackFinish(pasted.value);
          ws = r.state; pasted.value = ''; drawStatus(); flash(status, r.message, 'ok');
        } catch (err) { flash(status, clean(err), 'err'); }
      } });
      const disconnect = h('button', { type: 'button', class: 'danger', id: 'slack-disconnect', text: 'Disconnect', onclick: async () => { ws = await S.widgets.slackDisconnect(); drawStatus(); } });
      const pastedRow = setting('Finish signing in', pasted, 'Slack ends on a page that may not load. That is fine: copy its address from the address bar and paste it here.', finish);
      const chBox = h('div', { class: 'widget-checks', id: 'slack-channels' });
      const drawChannels = (items) => {
        chBox.replaceChildren(...items.map((c) => {
          const l = chk(`slack-ch-${c.id}`, `${c.private ? '🔒 ' : '#'}${c.name}`, picked.has(c.id));
          l.querySelector('input').dataset.id = c.id;
          l.querySelector('input').dataset.name = c.name;
          l.querySelector('input').addEventListener('change', (e) => { if (e.target.checked) picked.set(c.id, c.name); else picked.delete(c.id); });
          return l;
        }));
      };
      drawChannels([...picked].map(([id, name]) => ({ id, name, private: false })));
      const load = h('button', { type: 'button', id: 'slack-load', text: 'Load my channels', onclick: async () => {
        try { drawChannels(await S.widgets.slackChannels()); } catch (err) { flash(status, clean(err), 'err'); }
      } });
      inputs.slackPicked = picked;
      inputs.dms = tog('widget-slack-dms', 'Unread direct messages', sc.dms !== false);
      inputs.mentions = tog('widget-slack-mentions', 'Mentions of you', sc.mentions !== false, 'In the channels chosen below.');
      inputs.count = segment('widget-slack-count', 'Recent messages', [[3, '3'], [5, '5'], [8, '8'], [10, '10']], sc.count || 5);
      const accountRow = h('div', { class: 'row stack sp-login' }, h('div', { class: 'sp-actions' }, open, disconnect), status,
        h('span', { class: 'note', text: 'Read-only: nothing can be posted. Slack’s sign-in opens in your browser.' }));
      const adv = advanced([
        helpLink(setting('Slack app Client ID', clientId, 'Slack needs an app of your own (Create New App). Keep it private, not distributed.'), 'slack', 'Open Slack API apps'),
        setting('Client Secret', clientSecret, 'From the app’s Basic Information page. Stored encrypted by your system.'),
        setting('Redirect URL', redirect, 'Add this address under OAuth & Permissions. Slack requires https.'),
        setting('Or a user token', inputs.token, 'Skip signing in: paste the User OAuth Token from the app’s OAuth & Permissions page. It doesn’t renew itself.'),
      ], 'User Token Scopes to add: ' + ((st.scopes || []).join(', ') || 'channels:read, channels:history, im:read, im:history, users:read') + '. Everything is stored encrypted by your system and never reaches the new-tab page.', !st.connected && !st.clientId);
      drawStatus();
      fields.replaceChildren(
        section('Account', [accountRow, pastedRow]),
        section('Show', [inputs.dms, inputs.mentions, setting('Recent messages', inputs.count)]),
        section('Channels', [block('Channels to follow', 'Up to 4 channels you are in; their recent messages show on the card.', h('div', { class: 'widget-inline' }, load), chBox)]),
        adv);
    }
    // ---- github: token and which lists ----
    function githubFields(same) {
      const g = same?.gh || {};
      inputs.token = h('input', { type: 'password', id: 'widget-token', autocomplete: 'off', spellcheck: 'false', placeholder: ws.secrets.github ? tr('settings.widgets.github.tokenSaved', 'Saved. Paste a new token to replace it.') : tr('settings.widgets.github.tokenPlaceholder', 'Paste your GitHub token'), 'aria-label': tr('settings.widgets.github.tokenLabel', 'GitHub access token') });
      inputs.reviews = tog('widget-gh-reviews', tr('settings.widgets.github.reviews', 'Review requests'), g.reviews !== false);
      inputs.assigned = tog('widget-gh-assigned', tr('settings.widgets.github.assigned', 'Assigned issues and pull requests'), g.assigned !== false);
      inputs.notifications = tog('widget-gh-notifications', tr('settings.widgets.github.notifications', 'Unread notification count'), g.notifications !== false, 'Needs a classic token with the notifications scope.');
      inputs.hideDrafts = tog('widget-gh-drafts', tr('settings.widgets.github.hideDrafts', 'Hide draft pull requests in review requests'), g.hideDrafts);
      inputs.max = segment('widget-gh-max', tr('settings.widgets.github.max', 'Items per list'), [[5, '5'], [10, '10'], [20, '20']], g.max ?? 10);
      const tokenRow = helpLink(setting(tr('settings.widgets.github.token', 'Access token'), inputs.token, ws.secrets.github ? 'Connected: a token is saved. Paste a new one only to replace it.' : 'Not connected yet. Create a token with read-only access to Issues and Pull requests.'), 'github', 'Create a token on GitHub');
      fields.replaceChildren(
        section('Account', [tokenRow], 'Stored encrypted by your system. It is sent only to api.github.com and never reaches the new-tab page.'),
        section(tr('settings.widgets.github.show', 'Show'), [inputs.reviews, inputs.assigned, inputs.notifications, inputs.hideDrafts, setting(tr('settings.widgets.github.max', 'Items per list'), inputs.max)], tr('settings.widgets.github.showHelp', 'Lists are refreshed every few minutes. If GitHub’s rate limit is reached, Lumen waits until it resets.')),
        advanced([
          block('Token permissions', null, h('span', { class: 'note', text: tr('settings.widgets.github.tokenHelp', 'Create a fine-grained personal access token at github.com/settings/personal-access-tokens: pick the repositories to include (or All repositories) and grant read-only Issues and Pull requests (Metadata: read is added automatically). No write permissions are needed. Unread notifications work only with a classic token that has the notifications scope, because GitHub doesn’t offer notifications to fine-grained tokens; without one, the card shows the two lists and says so. Stored encrypted by your system; it never reaches the new-tab page and is sent only to api.github.com.') })),
          block(tr('settings.widgets.github.privacyLabel', 'Private repositories'), null, h('span', { class: 'note', text: tr('settings.widgets.github.privacy', 'Titles of issues and pull requests from private repositories are fetched too, and Lumen keeps them in memory (they are not written to settings.json) and passes them to your new-tab pages to show them, so they can appear in a new tab’s history on this device. To keep a repository off the card, don’t give the token access to it.') })),
        ]));
    }
    // ---- muse: Meta's model: key, saved prompt, model, web search ----
    function museFields(same) {
      const m = same?.muse || {};
      inputs.token = h('input', { type: 'password', id: 'widget-token', autocomplete: 'off', spellcheck: 'false', placeholder: ws.secrets.muse ? tr('widgets.muse.keySaved', 'Saved. Paste a new key to replace it.') : tr('widgets.muse.keyPaste', 'Paste your Meta API key'), 'aria-label': tr('widgets.muse.key', 'Meta API key') });
      inputs.prompt = h('textarea', { id: 'widget-muse-prompt', rows: '3', maxlength: '1000', 'aria-label': tr('widgets.muse.prompt', 'Saved prompt') });
      inputs.prompt.value = m.prompt || 'Give me a short daily brief: three or four bullet points on what matters today in technology and world news, one line each.';
      inputs.model = h('input', { type: 'text', id: 'widget-muse-model', maxlength: '64', spellcheck: 'false', placeholder: 'muse-spark-1.3', 'aria-label': tr('widgets.muse.model', 'Model') });
      inputs.model.value = m.model || 'muse-spark-1.3';
      inputs.search = tog('widget-muse-search', 'Web search', m.search, tr('widgets.muse.searchHelp', 'Web search uses a different Meta endpoint and can cost more.'));
      const tokenRow = helpLink(setting(tr('widgets.muse.key', 'Meta API key'), inputs.token, ws.secrets.muse ? 'Connected: a key is saved. Paste a new one only to replace it.' : 'Not connected yet. Create a key in Meta’s developer console (Meta Model API).'), 'muse', 'Get a key at dev.meta.ai');
      fields.replaceChildren(
        section('Account', [tokenRow], 'Stored encrypted by your system. It never reaches the new-tab page or your settings file.'),
        section('Question', [block(tr('widgets.muse.prompt', 'Saved prompt'), tr('widgets.muse.promptHelp', 'Answered on the card. Keep it short: answers are capped at a few hundred words.'), inputs.prompt), inputs.search]),
        advanced([
          setting(tr('widgets.muse.model', 'Model'), inputs.model, tr('widgets.muse.modelHelp', 'Default muse-spark-1.3. Other names from dev.meta.ai work too (muse-spark-1.2, muse-spark-1.1).')),
          block(tr('widgets.muse.privacy', 'What is sent, and the cost'), null, h('span', { class: 'note', text: tr('widgets.muse.privacyHelp', 'Your prompt and every question you type go to Meta, and so do the answers it returns. Each answer uses your key’s credit (about $1.25 per million tokens in and $4.25 per million out, at the time of writing). The card asks about every six hours at most, or when you press Refresh or Ask; check Meta’s current terms and limits.') })),
        ]));
    }
    // ---- stocks and crypto: a watchlist, the data provider's key, the paper portfolio's starting cash ----
    function marketFields(same) {
      const crypto = type === 'crypto';
      const provider = crypto ? 'CoinGecko' : 'Twelve Data';
      const saved = ws.secrets[crypto ? 'coingecko' : 'twelvedata'];
      inputs.token = h('input', { type: 'password', id: 'widget-token', autocomplete: 'off', spellcheck: 'false', placeholder: saved ? 'Saved. Paste a new key to replace it.' : crypto ? 'Optional: a free Demo API key' : 'Paste your API key', 'aria-label': `${provider} API key` });
      inputs.list = h('input', { type: 'text', id: 'widget-watchlist', maxlength: '400', placeholder: crypto ? 'bitcoin, ethereum, solana' : 'AAPL, MSFT, NVDA', 'aria-label': crypto ? 'Coin ids' : 'Stock symbols', value: crypto ? (same?.mk?.coins || []).map((c) => `${c.id}=${c.sym}`).join(', ') : (same?.mk?.symbols || []).join(', ') });
      const hasTrades = Boolean(same?.pf?.trades?.length);
      inputs.startCash = h('input', { type: 'number', id: 'widget-startcash', min: '1000', max: '1000000000', step: '1000', value: String(same?.pf?.cash0 || 100000), disabled: hasTrades, 'aria-label': 'Starting paper cash in dollars' });
      const keyLabel = crypto ? 'CoinGecko API key' : 'Twelve Data API key';
      const keyRow = helpLink(setting(keyLabel, inputs.token, crypto
        ? (saved ? 'A key is saved. Paste a new one only to replace it.' : 'Optional. Without a key the request limit is lower; a free Demo key raises it.')
        : (saved ? 'Connected: a key is saved. Paste a new one only to replace it.' : 'Not connected yet. A free account gives you a key.')), crypto ? 'coingecko' : 'twelvedata', crypto ? 'Get a free Demo key' : 'Get a free key at twelvedata.com');
      const listRow = block(crypto ? 'Coins' : 'Symbols', crypto
        ? 'Up to 12. CoinGecko ids separated by commas, like “bitcoin, ethereum”. Add =TICKER to name one: “ethereum=ETH”. Refreshed every 2 minutes.'
        : 'Up to 8 tickers separated by commas. Refreshed every 15 minutes, hourly while the market is closed. The free plan allows 8 requests a minute and 800 a day, one per symbol.', inputs.list);
      const cashRow = setting('Starting paper cash', inputs.startCash, hasTrades ? 'Reset the portfolio on the card to change it.' : 'Dollars, for the simulated portfolio. Default $100,000.');
      const about = block('About the data', null, h('span', { class: 'note', text: `The symbols on the watchlist are sent to ${provider}, from Lumen, to get prices${crypto ? '' : ' (along with your key)'}. Your use of the data is under ${provider}’s terms for your own ${crypto ? 'key or keyless access' : 'account and key'}, not Lumen’s. Paper trading is simulated: no real orders, nothing is bought or sold anywhere. Not investment advice. Quotes ${crypto ? 'can lag by a minute or more' : 'on the free plan are delayed'}.` }));
      fields.replaceChildren(...(crypto
        ? [section('Watchlist', [listRow]), section('Paper portfolio', [cashRow]), advanced([keyRow, about], 'The key is stored encrypted by your system and never reaches the new-tab page.')]
        : [section('Account', [keyRow], 'Stored encrypted by your system. It never reaches the new-tab page.'), section('Watchlist', [listRow]), section('Paper portfolio', [cashRow]), advanced([about])]));
    }
    const renderFields = () => {
      for (const b of types.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.type === type));
      note.textContent = '';
      note.className = 'note';
      for (const k of Object.keys(inputs)) delete inputs[k];
      const same = existing?.type === type ? existing : null;
      if (type === 'weather') {
        weatherFields(same);
      } else if (type === 'worldclock') {
        clockFields(same);
      } else if (type === 'calendar') {
        inputs.url = h('input', { type: 'url', id: 'widget-url', placeholder: 'webcal://… or https://….ics', 'aria-label': 'Calendar address (ICS)' });
        inputs.url.value = same?.url || '';
        fields.replaceChildren(section('Calendar', [helpLink(setting('Calendar link', inputs.url, 'The “subscribe” or “secret address in iCal format” link from Google Calendar, Outlook, iCloud, Fantastical or Muse. Today’s and upcoming events show.'), 'calendar', 'Where do I find it?')], 'Lumen fetches the calendar itself; the new-tab page never goes online.'));
      } else if (type === 'todoist') {
        todoFields(same);
      } else if (type === 'spotify') {
        spotifyFields(same);
      } else if (type === 'gmail') {
        gmailFields(same);
      } else if (type === 'slack') {
        slackFields(same);
      } else if (type === 'github') {
        githubFields(same);
      } else if (type === 'feed') {
        const presets = ws.feedPresets || [];
        const custom = same && !same.preset;
        inputs.preset = sel('widget-feed', tr('settings.widgets.feed.pick', 'Feed'), [...presets.map((p) => [p.id, p.name]), ['', tr('settings.widgets.feed.custom', 'Custom address…')]], same ? same.preset || '' : presets[0]?.id || '');
        inputs.url = h('input', { type: 'url', id: 'widget-url', placeholder: 'https://example.com/feed.xml', maxlength: '2000', 'aria-label': tr('settings.widgets.feed.url', 'Feed address (RSS or Atom)') });
        inputs.url.value = custom ? same.url : '';
        inputs.count = sel('widget-feed-count', tr('settings.widgets.feed.count', 'Headlines shown'), [3, 5, 8, 10, 12].map((n) => [n, String(n)]), same?.count || 8);
        const urlRow = setting(tr('settings.widgets.feed.url', 'Feed address (RSS or Atom)'), inputs.url, tr('settings.widgets.feed.urlHint', 'Only used with Custom address. Must be https://.'));
        const syncRow = () => { urlRow.hidden = inputs.preset.value !== ''; };
        inputs.preset.addEventListener('change', syncRow);
        syncRow();
        fields.replaceChildren(section('Headlines', [setting(tr('settings.widgets.feed.pick', 'Feed'), inputs.preset), urlRow, setting(tr('settings.widgets.feed.count', 'Headlines shown'), inputs.count)], tr('settings.widgets.feed.pickHint', 'Lumen fetches the feed itself; the new-tab page never goes online. Headlines open in a new tab.')));
      } else if (type === 'muse') {
        museFields(same);
      } else if (type === 'stocks' || type === 'crypto') {
        marketFields(same);
      } else if (type === 'notes') {
        fields.replaceChildren(section('Note', [h('div', { class: 'row' }, h('span', { class: 'note', text: 'Type straight on the card. It saves as you go, stays on this computer and never goes online.' }))]));
      } else if (type === 'countdown') {
        const cd = same?.cd || {};
        inputs.label = h('input', { type: 'text', id: 'widget-cd-label', maxlength: '60', placeholder: 'Vacation', 'aria-label': 'What it counts to', value: cd.label || '' });
        inputs.date = h('input', { type: 'date', id: 'widget-cd-date', 'aria-label': 'Date', value: cd.date || '' });
        inputs.time = h('input', { type: 'time', id: 'widget-cd-time', 'aria-label': 'Time (optional)', value: cd.time || '' });
        fields.replaceChildren(section('Countdown', [setting('Name', inputs.label, 'Shown under the number, like “days until Vacation”.'), setting('Date', inputs.date), setting('Time', inputs.time, 'Optional. With a time, the last day counts down in hours, minutes and seconds.')], 'Counted on this computer; nothing goes online.'));
      } else if (type === 'timer') {
        const tm = same?.tm || {};
        inputs.mode = sel('widget-tm-mode', 'Kind', [['pomodoro', 'Pomodoro (focus, then a break)'], ['timer', 'Plain timer']], tm.pomodoro === false ? 'timer' : 'pomodoro');
        inputs.work = h('input', { type: 'number', id: 'widget-tm-work', min: '1', max: '180', step: '1', value: String(tm.work || 25), 'aria-label': 'Minutes' });
        inputs.rest = h('input', { type: 'number', id: 'widget-tm-rest', min: '1', max: '60', step: '1', value: String(tm.rest || 5), 'aria-label': 'Break minutes' });
        const restRow = setting('Break minutes', inputs.rest);
        const sync = () => { restRow.hidden = inputs.mode.value !== 'pomodoro'; };
        inputs.mode.addEventListener('change', sync);
        sync();
        fields.replaceChildren(section('Timer', [setting('Kind', inputs.mode), setting('Minutes', inputs.work, 'How long a focus session (or the timer) lasts.'), restRow], 'It keeps running while the new-tab page is closed: it counts to a moment, not in the page.'));
      } else if (type === 'custom') {
        const examples = ws.recipeExamples || [];
        inputs.recipe = h('textarea', { id: 'widget-recipe', rows: '12', spellcheck: 'false', class: 'code', 'aria-label': 'Recipe (JSON)', placeholder: '{ "name": "…", "url": "https://…", "view": "stats", "stats": [ { "label": "…", "path": "…" } ] }' });
        inputs.recipe.value = same?.recipe ? JSON.stringify(same.recipe, null, 2) : examples[0] ? JSON.stringify(examples[0], null, 2) : '';
        const pickers = h('div', { class: 'seg' }, examples.map((ex) => h('button', { type: 'button', text: ex.name, onclick: () => { inputs.recipe.value = JSON.stringify(ex, null, 2); inputs.recipe.dispatchEvent(new Event('input', { bubbles: true })); } })));
        fields.replaceChildren(section('Recipe', [
          block('Start from an example', null, pickers),
          block('Recipe (JSON)', 'One https address that answers JSON, and what to show from it: "stats" (up to 6 numbers or words, each a path like rates.EUR) or a "list" (a path to an array, and each item’s title, detail and link). Test checks it against the real answer. The format is in docs/custom-widgets.md, so recipes can be shared as plain text.', inputs.recipe),
        ], 'Lumen fetches the address itself, without your cookies, and shows only text from it: a recipe can’t run code.'));
      } else if (type === 'tradingview') {
        const tv = same?.tv || {};
        inputs.symbol = h('input', { type: 'text', id: 'widget-tv-symbol', maxlength: '52', spellcheck: 'false', autocomplete: 'off', placeholder: 'NASDAQ:AAPL', 'aria-label': 'Symbol', value: tv.view === 'watchlist' ? '' : tv.symbol || '' });
        inputs.view = sel('widget-tv-view', 'Style', [['chart', 'Full chart'], ['mini', 'Mini chart'], ['watchlist', 'Watchlist']], tv.view || 'chart');
        inputs.interval = sel('widget-tv-interval', 'Interval', [['1', '1 minute'], ['5', '5 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['D', '1 day'], ['W', '1 week'], ['M', '1 month']], tv.interval || 'D');
        inputs.theme = sel('widget-tv-theme', 'Theme', [['auto', 'Follow light and dark mode'], ['light', 'Light'], ['dark', 'Dark']], tv.theme || 'auto');
        // Watchlist: the symbols as TradingView's own "Export list" writes them, one "###Name" line per section.
        inputs.symbols = h('textarea', { id: 'widget-tv-symbols', rows: '8', spellcheck: 'false', class: 'code', 'aria-label': 'Symbols', placeholder: '###Indices\nSPCFD:SPX\nTVC:NDQ\n###Stocks\nNASDAQ:AAPL\nNASDAQ:TSLA' });
        inputs.symbols.value = Array.isArray(tv.symbols) ? tv.symbols.join('\n') : '';
        inputs.chart = h('input', { type: 'checkbox', class: 'switch', id: 'widget-tv-chart', role: 'switch', 'aria-label': 'Chart on top', checked: tv.chart === true });
        inputs.sync = h('input', { type: 'checkbox', class: 'switch', id: 'widget-tv-sync', role: 'switch', 'aria-label': 'Keep in sync with TradingView', checked: tv.sync !== false });
        let linked = tv.list || null; // { id, name } of the account list these symbols came from
        inputs.tvLinked = () => linked;
        const lists = h('select', { id: 'widget-tv-lists', 'aria-label': 'Your TradingView watchlists', hidden: true });
        const tvNote = h('span', { class: 'note', role: 'status', id: 'widget-tv-note', text: linked ? `From “${linked.name}” in your TradingView account.` : '' });
        let got = [];
        let filling = false; // the import writing the box, not the person typing in it
        const use = (l) => {
          linked = l ? { id: l.id, name: l.name } : null;
          if (l) inputs.symbols.value = l.symbols.join('\n');
          flash(tvNote, l ? `${l.count} symbols from “${l.name}”.` : '', 'ok');
          filling = true;
          inputs.symbols.dispatchEvent(new Event('input', { bubbles: true })); // autosave sees the change
          filling = false;
        };
        lists.addEventListener('change', () => use(got.find((l) => String(l.id) === lists.value)));
        const signIn = h('button', { type: 'button', id: 'widget-tv-signin', text: 'Sign in to TradingView', hidden: true, onclick: () => S.openUrl('https://www.tradingview.com/accounts/signin/') });
        const load = h('button', { type: 'button', id: 'widget-tv-import', text: 'Import from TradingView', onclick: async () => {
          load.disabled = true;
          flash(tvNote, 'Reading your TradingView watchlists…', '');
          try {
            const r = await S.widgets.tvLists();
            got = r.lists || [];
            signIn.hidden = r.signedIn;
            if (!r.signedIn) { lists.hidden = true; flash(tvNote, 'You’re not signed in to TradingView in Lumen. Sign in, then press Import again.', 'err'); return; }
            if (!got.length) { lists.hidden = true; flash(tvNote, 'Your TradingView account has no watchlists with symbols yet.', 'err'); return; }
            lists.replaceChildren(...got.map((l) => h('option', { value: String(l.id), text: `${l.name} (${l.count})` })));
            lists.hidden = got.length < 2;
            const pickOne = got.find((l) => linked && l.id === linked.id) || got.find((l) => l.active) || got[0];
            lists.value = String(pickOne.id);
            use(pickOne);
          } catch (err) { flash(tvNote, clean(err), 'err'); } finally { load.disabled = false; }
        } });
        // Typing over an imported list unlinks it: the card then shows exactly what's typed.
        inputs.symbols.addEventListener('input', () => { if (!filling && linked) { linked = null; flash(tvNote, 'Edited here, so it no longer syncs with TradingView. Import again to link it.', ''); } });
        const symbolRow = block('Symbol', 'As TradingView writes it: NASDAQ:AAPL, NYSE:SPY, BINANCE:BTCUSDT, FX:EURUSD, or just AAPL. You can also change it on the chart itself.', inputs.symbol);
        const listRows = [
          block('Symbols', 'One per line or separated by commas, up to 60. A line like ###Tech starts a section (each section is a tab). You can paste the .txt from TradingView’s “Export list”, or import a list straight from your account.', inputs.symbols, h('div', { class: 'sp-actions' }, load, lists, signIn), tvNote),
          setting('Keep in sync', inputs.sync, 'For an imported list: Lumen reads it from your TradingView account every 15 minutes, so symbols you add or remove there show up here.'),
          setting('Chart on top', inputs.chart, 'A chart of the row you pick above the list. Off, it’s just the list, like TradingView’s home-screen widget.'),
        ];
        const intervalRow = setting('Interval', inputs.interval, 'The bar size the full chart opens with (the mini chart and the watchlist pick a date range near it).');
        const syncView = () => { const w = inputs.view.value === 'watchlist'; symbolRow.hidden = w; for (const r of listRows) r.hidden = !w; };
        inputs.view.addEventListener('change', syncView);
        fields.replaceChildren(
          section('Chart', [
            symbolRow, ...listRows,
            setting('Style', inputs.view, 'The full chart has TradingView’s tools and date ranges; the mini chart is a small price line; the watchlist is rows of symbols with price and change.'),
            intervalRow,
            setting('Theme', inputs.theme),
          ], 'No key. The chart is TradingView’s own page in a frame: TradingView sees that you opened it, and its quotes come under TradingView’s terms. Importing reads only your watchlists’ names and symbols, with your TradingView sign-in in Lumen. Not investment advice.'));
        syncView();
      } else {
        inputs.url = h('input', { type: 'url', id: 'widget-url', placeholder: 'https://…', 'aria-label': 'Web page address' });
        inputs.url.value = same?.url || '';
        inputs.height = segment('widget-height', 'Card height', WIDGET_HEIGHTS, same?.height || 'medium');
        fields.replaceChildren(section('Page', [setting('Address', inputs.url, 'Any https page, like a dashboard or your Muse board. Sites that refuse to be shown in a frame get an Open button instead.'), setting('Height', inputs.height)]));
      }
    };
    const width = h('select', { id: 'widget-span', 'aria-label': 'Card width' }, WIDGET_SPANS.map(([v, t]) => h('option', { value: v, text: t })));
    const syncWidth = () => { width.value = String(existing?.type === type ? existing.span : type === 'embed' ? 6 : 3); };
    const val = (c) => c?.querySelector?.('input')?.checked;
    const same0 = () => (existing?.type === type ? existing : null); // Notes: editing the card's title keeps the text
    const input = () => {
      const base = { type, title: title.value, span: width.value, colors: colors.value };
      if (type === 'weather') {
        return { ...base, city: inputs.city?.value, units: inputs.units.value, wx: { places, units: inputs.units.value, wind: inputs.wind.value, clock: inputs.clock.value, days: Number(inputs.days.value), hours: Number(inputs.hours.value), view: inputs.view.value, show: Object.fromEntries(Object.entries(inputs.show).map(([k, c]) => [k, val(c)])) } };
      }
      if (type === 'worldclock') {
        return { ...base, city: inputs.city?.value, wc: { places: clockPlaces, clock: inputs.clock.value, seconds: val(inputs.seconds), show: Object.fromEntries(Object.entries(inputs.show).map(([k, c]) => [k, val(c)])) } };
      }
      if (type === 'muse') return { ...base, token: inputs.token.value, muse: { prompt: inputs.prompt.value, model: inputs.model.value, search: val(inputs.search) } };
      if (type === 'todoist') {
        const p = inputs.project.selectedOptions[0];
        const q = inputs.quickProject.selectedOptions[0];
        return { ...base, token: inputs.token.value, todo: {
          source: inputs.source.value, days: Number(inputs.days.value), projectId: inputs.project.value, projectName: p?.value ? p.textContent : '', label: inputs.label.value, query: inputs.query.value,
          group: inputs.group.value, sort: inputs.sort.value, density: inputs.density.value, max: Number(inputs.max.value), fields: Object.fromEntries(Object.entries(inputs.fields).map(([k, c]) => [k, val(c)])),
          showDone: val(inputs.showDone), overdueRed: val(inputs.overdueRed), showCount: val(inputs.showCount), quick: inputs.quick.value, quickProjectId: q?.value || '',
        } };
      }
      if (type === 'spotify') return { ...base, mode: inputs.mode.value, clientId: inputs.clientId.value, art: val(inputs.art) };
      if (type === 'gmail') {
        return { ...base, clientId: inputs.clientId.value, clientSecret: inputs.clientSecret.value, count: Number(inputs.count.value), snippets: val(inputs.snippets) };
      }
      if (type === 'slack') {
        return { ...base, token: inputs.token.value, slack: { channels: [...inputs.slackPicked].map(([id, name]) => ({ id, name })), dms: val(inputs.dms), mentions: val(inputs.mentions), count: Number(inputs.count.value) } };
      }
      if (type === 'github') {
        return { ...base, token: inputs.token.value, gh: { reviews: val(inputs.reviews), assigned: val(inputs.assigned), notifications: val(inputs.notifications), hideDrafts: val(inputs.hideDrafts), max: Number(inputs.max.value) } };
      }
      if (type === 'feed') return { ...base, feed: inputs.preset.value, url: inputs.url.value, count: Number(inputs.count.value) };
      if (type === 'stocks' || type === 'crypto') {
        return { ...base, token: inputs.token.value, mk: { [type === 'crypto' ? 'coins' : 'symbols']: inputs.list.value, startCash: Number(inputs.startCash.value) } };
      }
      if (type === 'notes') return { ...base, note: same0()?.note };
      if (type === 'countdown') return { ...base, cd: { label: inputs.label.value, date: inputs.date.value, time: inputs.time.value } };
      if (type === 'timer') return { ...base, tm: { pomodoro: inputs.mode.value === 'pomodoro', work: Number(inputs.work.value), rest: Number(inputs.rest.value) } };
      if (type === 'custom') return { ...base, recipe: inputs.recipe.value };
      if (type === 'tradingview') {
        const tv = { symbol: inputs.symbol.value, view: inputs.view.value, interval: inputs.interval.value, theme: inputs.theme.value };
        if (tv.view === 'watchlist') Object.assign(tv, { symbols: inputs.symbols.value, chart: inputs.chart.checked, list: inputs.tvLinked() || undefined, sync: inputs.sync.checked });
        return { ...base, tv };
      }
      return { ...base, url: inputs.url?.value, height: inputs.height?.value };
    };
    // Disable every button while a check or save runs, and put back exactly the ones that were already off.
    const busy = (on) => {
      for (const b of form.querySelectorAll('button')) {
        if (on) { b.dataset.wasOff = b.disabled ? '1' : ''; b.disabled = true; } else { b.disabled = b.dataset.wasOff === '1'; delete b.dataset.wasOff; }
      }
    };
    const check = h('button', { id: 'widget-check', text: 'Test', title: 'Try these settings without saving', onclick: async () => {
      busy(true);
      note.textContent = 'Testing…';
      note.className = 'note';
      const r = await S.widgets.test(input()).catch((err) => ({ ok: false, error: true, message: err.message }));
      busy(false);
      flash(note, r.message, r.ok ? 'ok' : r.error ? 'err' : 'warn');
    } });
    const save = h('button', { class: 'primary', id: 'widget-save', text: existing ? 'Save' : 'Add to page', onclick: async () => {
      busy(true);
      note.textContent = 'Saving…';
      note.className = 'note';
      try {
        const r = await S.widgets.save(input(), existing?.id || null);
        ws = r.state;
        closeForm();
        flash(listNote, /^Saved/i.test(r.message || '') ? r.message : `Saved. ${r.message || ''}`.trim(), 'ok');
      } catch (err) {
        busy(false);
        flash(note, clean(err), 'err');
      }
    } });
    // Picking a kind: its name and what it does, one row each (the settings for it appear below).
    const types = h('div', { class: 'seg type-list', role: 'radiogroup', 'aria-label': 'Kind of widget' },
      [...ws.types].sort((a, b) => WS.ORDER.indexOf(a.type) - WS.ORDER.indexOf(b.type)).map((t) => h('button', { type: 'button', role: 'radio', 'data-type': t.type, onclick: () => { type = t.type; renderFields(); syncWidth(); } },
        widgetIcon(t.type), h('span', { class: 'type-text' }, h('span', { class: 'type-name', text: WS.kindName(t.type) }), h('span', { class: 'type-hint', text: WS.kindHint(t.type) })))));
    let removeArmed = null;
    const removeBtn = existing ? h('button', { class: 'danger', id: 'widget-remove', text: 'Remove widget', onclick: async () => {
      if (!removeArmed) { removeBtn.textContent = 'Click again to remove'; removeArmed = setTimeout(() => { removeArmed = null; removeBtn.textContent = 'Remove widget'; }, 3500); return; }
      clearTimeout(removeArmed);
      ws = await S.widgets.remove(existing.id);
      closeForm();
      flash(listNote, `${existing.title} removed.`, 'ok');
    } }) : null;
    const back = h('button', { class: 'back', type: 'button', 'aria-label': 'Back to Widgets', onclick: () => requestClose() }, h('span', { class: 'chev', 'aria-hidden': 'true' }), 'Widgets');
    const leave = h('div', { class: 'leave-bar', role: 'alertdialog', 'aria-label': 'Unsaved changes', hidden: '' },
      h('span', { class: 'grow', text: existing ? 'These changes couldn’t be saved yet.' : 'This widget isn’t on your page yet.' }),
      h('button', { class: 'primary', text: existing ? 'Try saving again' : 'Add to page', onclick: () => { leave.hidden = true; save.click(); } }),
      h('button', { class: 'danger', text: 'Discard', onclick: () => closeForm() }),
      h('button', { text: 'Keep editing', onclick: () => { leave.hidden = true; } }));
    const form = h('div', { class: 'widget-form', id: 'widget-form' },
      h('div', { class: 'subhead' }, back),
      h('div', { class: 'widget-head' }, existing ? widgetIcon(existing.type) : null, h('div', { class: 'grow' },
        h('h2', { class: 'sub-label', text: existing ? `Edit ${existing.title}` : 'New widget' }),
        h('span', { class: 'note', text: existing ? `${WS.kindName(existing.type)} · ${WS.widgetSummary(existing, ws)}` : 'Pick what to show, then set it up.' }))),
      existing ? null : section('Choose a widget', [h('div', { class: 'row stack' }, types)]),
      fields,
      section('Card', [
        setting('Title', title, 'Shown at the top of the card. Leave empty to use the widget’s name.'),
        setting('Width', width, 'You can also drag its edges in Edit layout on the new-tab page.'),
        setting('Card colors', colors, 'Default, or tinted from your accent color and background. Colors inside the card, like priorities, stay.'),
      ]),
      removeBtn ? section(null, [h('div', { class: 'row' }, h('div', { class: 'text' }, h('span', { class: 'label', text: 'Remove this widget' }), h('span', { class: 'desc', text: 'Takes it off the new-tab page. Any saved token stays until you sign out of the service.' })), removeBtn)]) : null,
      h('div', { class: 'widget-buttons' }, note, h('span', { class: 'grow' }), h('button', { text: 'Cancel', onclick: () => requestClose() }), check, save), leave);
    formHost.replaceChildren(form);
    renderFields();
    syncWidth();
    // ---- autosave (a widget already on the page) and the unsaved-changes prompt ----
    // What the form would save, as text: changed means different from what was last saved (or opened).
    const snapshot = () => { try { return JSON.stringify({ type, ...input() }); } catch { return ''; } };
    let baseline = snapshot();
    const dirty = () => snapshot() !== baseline;
    let autoTimer = null;
    let autoRun = null; // the save in flight
    const autoSave = () => {
      clearTimeout(autoTimer);
      autoTimer = null;
      if (!existing || !dirty()) return Promise.resolve(true);
      if (autoRun) return autoRun.then(() => autoSave());
      const sent = snapshot();
      note.textContent = 'Saving…';
      note.className = 'note';
      autoRun = S.widgets.save(input(), existing.id).then((r) => {
        ws = r.state;
        baseline = sent;
        existing = ws.widgets.find((x) => x.id === existing.id) || existing;
        renderList();
        flash(note, 'Saved automatically.', 'ok');
        return true;
      }, (err) => { flash(note, `Not saved yet: ${clean(err)}`, 'err'); return false; }).finally(() => { autoRun = null; });
      return autoRun;
    };
    const later = (ms) => { if (!existing) return; clearTimeout(autoTimer); autoTimer = setTimeout(autoSave, ms); };
    // Typing waits a moment; a picked option or a switch saves at once. Keys and secrets save when you leave the field,
    // so a half-pasted key is never sent to the service.
    form.addEventListener('input', (e) => { if (e.target.type !== 'password') later(1000); });
    form.addEventListener('change', () => later(250));
    form.addEventListener('click', (e) => { if (e.target.closest('button') && !e.target.closest('.widget-buttons, .leave-bar, .subhead')) later(600); }); // added or removed places, example recipes
    formGuard = () => dirty();
    // Leaving with changes that aren't saved: save them, throw them away, or stay.
    async function requestClose() {
      if (existing && dirty()) { if (await autoSave()) { closeForm(); flash(listNote, 'Saved.', 'ok'); return; } }
      if (!dirty()) { closeForm(); return; }
      leave.hidden = false;
      leave.querySelector('button')?.focus();
    }
    renderList();
    if (!existing) (inputs.city || inputs.url || inputs.list || inputs.symbol || inputs.label || inputs.recipe || inputs.token || inputs.clientId)?.focus();
    window.scrollTo?.({ top: 0 });
  }

  const reset = h('button', { id: 'widget-reset', text: 'Reset layout', title: 'Every widget its default size, packed in order, and every section back in the center', onclick: async () => { ws = await S.widgets.resetLayout(); renderList(); flash(listNote, 'Layout reset.', 'ok'); } });
  const addRow = row('Add a widget', 'Weather, tasks, calendar, headlines, music, mail, stocks and more.', add);
  addRow.querySelector('.text').append(listNote);
  const home = h('div', { class: 'widget-home' },
    h('div', { class: 'group' }, h('h3', { class: 'group-title', text: 'On your new-tab page' }), list),
    h('div', { class: 'group' }, h('div', { class: 'card' }, addRow)),
    h('div', { class: 'group' }, h('h3', { class: 'group-title', text: 'Layout' }), h('div', { class: 'card' }, row('Reset layout', 'Every widget back to its default size, packed in order. To move or resize cards, use Edit layout on the new-tab page.', reset))));
  card.el.append(home, formHost);
  renderList();
  const target = ws.edit && ws.widgets.find((w) => w.id === ws.edit);
  if (target) { openForm(target); forceRoute = 'widgets'; } // a card's gear on the new-tab page
  else if (ws.create && ws.types.some((t) => t.type === ws.create)) { openForm(null, ws.create); forceRoute = 'widgets'; } // its Add widget picker
}
function alertLine(host, text) {
  host.querySelector('.note.error')?.remove();
  host.append(h('span', { class: 'note error', role: 'alert', text }));
}

async function buildSearch(card) {
  const ai = await S.ai.get();
  const el = h('select', { id: 'pref-searchEngine', 'aria-label': 'Search engine', onchange: (e) => S.ai.setSearchEngine(e.target.value) },
    ai.searchEngines.map((e) => h('option', { value: e.id, text: e.label, selected: e.id === ai.searchEngine })));
  card.append(row('Search engine used in the address bar', 'Also used by the new-tab page and “Search for…” in the context menu.', el));
}

function buildStartup(card) {
  const list = h('div', { class: 'list', id: 'startup-pages' });
  const input = h('input', { type: 'url', class: 'grow', id: 'startup-add', placeholder: 'https://example.com', 'aria-label': tr('settings.startup.addPage', 'Page to open on startup') });
  const renderPages = () => list.replaceChildren(...st.prefs.startupPages.map((url, i) => h('div', { class: 'item' },
    h('span', { class: 'grow mono', text: url }),
    h('button', { text: 'Remove', onclick: async () => { await save('startupPages', st.prefs.startupPages.filter((_, j) => j !== i)); renderPages(); } }))));
  const radios = [['restore', 'Continue where you left off'], ['newtab', 'Open the New Tab page'], ['pages', 'Open a specific page or set of pages']].map(([value, text]) => {
    const r = h('input', { type: 'radio', name: 'startup', value, id: `startup-${value}`, checked: st.prefs.startup === value, onchange: () => save('startup', value) });
    return h('label', { class: 'check' }, r, text);
  });
  renderPages();
  card.append(stackRow('On startup', 'What Lumen opens when it starts.', ...radios));
  card.append(stackRow('Pages to open', 'Used with “Open a specific page or set of pages”.', list,
    h('div', { class: 'controls' }, input, h('button', {
      text: 'Add page',
      onclick: async () => {
        const url = input.value.trim();
        if (!/^https?:\/\//i.test(url)) return;
        await save('startupPages', [...st.prefs.startupPages, url]);
        input.value = '';
        renderPages();
      },
    }))));
}

async function buildPrivacy(card) {
  // Clear browsing data
  const range = h('select', { id: 'clear-range', 'aria-label': 'Time range' },
    [['hour', 'Last hour'], ['day', 'Last 24 hours'], ['week', 'Last 7 days'], ['month', 'Last 4 weeks'], ['all', 'All time']].map(([v, t]) => h('option', { value: v, text: t })));
  const box = (id, text, checked) => h('label', { class: 'check' }, h('input', { type: 'checkbox', id, checked }), text);
  const result = status('clear-status');
  card.append(stackRow('Clear browsing data', 'For a time range, cookies and site data are removed for the sites you visited or that stored cookies in that time (all of that site’s data, not only the recent part). Cached images and files are always cleared for all time: Electron has no time range for the cache.',
    h('div', { class: 'controls start' }, h('span', { class: 'note', text: 'Time range' }), range),
    box('clear-history', 'Browsing history', true), box('clear-cookies', 'Cookies and other site data', false),
    box('clear-cache', 'Cached images and files', true), box('clear-downloads', 'Download list', false),
    h('div', { class: 'controls' }, result, h('button', {
      class: 'primary', id: 'clear-go', text: 'Clear data',
      onclick: async () => {
        const done = await S.clearData({ range: range.value, history: $('clear-history').checked, cookies: $('clear-cookies').checked, cache: $('clear-cache').checked, downloads: $('clear-downloads').checked });
        const parts = [];
        if (done.history !== undefined) parts.push(`${done.history} history entr${done.history === 1 ? 'y' : 'ies'}`);
        if (done.cookies) parts.push(done.sites !== undefined ? `cookies and site data of ${done.sites} site${done.sites === 1 ? '' : 's'}` : 'cookies and site data');
        if (done.cache) parts.push('cache');
        if (done.downloads !== undefined) parts.push(`${done.downloads} download${done.downloads === 1 ? '' : 's'}`);
        flash(result, parts.length ? `Cleared ${parts.join(', ')}.` : 'Nothing selected.');
      },
    }))));

  card.group('Tracking and connections').append(
    toggle('blockThirdPartyCookies', 'Block third-party cookies (best effort)', 'Lumen stops sending cookies with requests to other sites embedded in a page. Those sites can still set cookies, and scripts inside their frames can still read them: Electron has no full third-party cookie switch.'),
    toggle('sendDoNotTrack', 'Send a “Do Not Track” request', 'Adds DNT: 1 to every request. Most sites ignore it.'),
    toggle('sendGpc', 'Send Global Privacy Control', 'Adds Sec-GPC: 1 to every request. In some places (e.g. California) sites must honor it as an opt-out of data sale.'),
    toggle('httpsOnly', 'Always use secure connections', 'Upgrades http:// addresses to https:// and warns before loading a site that has no secure version. Local addresses are left alone.'),
  );

  // [passwords] Saved passwords (features/passwords.js): off by default, encrypted with the OS keychain.
  await buildPasswords(card);

  // Safe Browsing (features/safe-browsing.js)
  const sbNote = status('safe-browsing-status');
  const sbKey = h('div', { class: 'controls' });
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const renderSb = (s) => {
    if (!s.enabled) sbNote.textContent = 'Off.';
    else if (!s.hasKey) sbNote.textContent = 'Inactive: add a Google Safe Browsing API key below.';
    else if (s.error) sbNote.textContent = `Couldn’t update the lists: ${s.error}. Pages still load; Lumen will try again.`;
    else if (!s.entries) sbNote.textContent = s.syncing ? 'Downloading Google’s lists…' : 'Waiting for Google’s lists.';
    else sbNote.textContent = `Active. ${s.entries.toLocaleString()} entries, updated ${ago(s.lastUpdate)}.`;
    sbNote.className = `note${s.enabled && (!s.hasKey || s.error) ? ' err' : ''}`;
    const input = h('input', { type: 'password', class: 'grow', id: 'safe-browsing-key', autocomplete: 'off', placeholder: s.keyStored ? 'Key saved' : s.keyEnv ? 'From GOOGLE_SAFE_BROWSING_API_KEY' : 'Google API key', 'aria-label': 'Google Safe Browsing API key' });
    const keyNote = status();
    const put = async (value) => {
      try { renderSb(await S.ai.setSafeBrowsingKey(value)); } catch (err) { flash(keyNote, String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); }
    };
    sbKey.replaceChildren(...[input,
      h('button', { text: 'Save key', id: 'safe-browsing-save', onclick: () => { if (input.value.trim()) put(input.value.trim()); else input.focus(); } }),
      s.keyStored ? h('button', { class: 'danger', text: 'Remove', onclick: () => put('') }) : null,
      keyNote].filter(Boolean));
  };
  card.group('Safe Browsing').append(
    toggle('safeBrowsing', 'Warn about dangerous sites (Google Safe Browsing)',
      'Lumen downloads Google’s lists of suspected phishing and malware sites and checks each page against them on your computer. Only when an address matches the lists does Lumen send Google a short, partial hash of it, never the address itself, and without your cookies. Needs your own Google API key with the Safe Browsing API enabled (free, for non-commercial use). No list is perfect: some unsafe sites may be missed, and some safe sites flagged in error.',
      async () => renderSb(await S.ai.safeBrowsing())),
    stackRow('Safe Browsing API key', 'Encrypted with your OS keychain. Create one in the Google Cloud console.', sbNote, sbKey),
  );
  S.ai.safeBrowsing().then(renderSb).catch(() => {});

  // Ad blocker
  const allowList = h('div', { class: 'list', id: 'adblock-allow' });
  const allowInput = h('input', { type: 'text', class: 'grow', id: 'adblock-add', placeholder: 'example.com', 'aria-label': tr('settings.adblock.addSite', 'Site to allow ads on') });
  const renderAllow = () => allowList.replaceChildren(...(st.prefs.adblockAllow.length ? st.prefs.adblockAllow.map((host) => h('div', { class: 'item' },
    h('span', { class: 'grow', text: host }),
    h('button', { text: 'Remove', onclick: async () => { await save('adblockAllow', st.prefs.adblockAllow.filter((x) => x !== host)); renderAllow(); } })))
    : [h('span', { class: 'note', text: 'No sites. Ads are blocked everywhere.' })]));
  renderAllow();
  card.group('Ads and trackers').append(
    toggle('adblock', 'Block ads and trackers', 'Built-in blocker using uBlock Origin-compatible filter lists.'),
    stackRow('Sites allowed to show ads', 'The blocker is off on these sites.', allowList,
      h('div', { class: 'controls' }, allowInput, h('button', {
        text: 'Add site',
        onclick: async () => { const host = allowInput.value.trim(); if (!host) return; await save('adblockAllow', [...st.prefs.adblockAllow, host]); allowInput.value = ''; renderAllow(); },
      }))),
  );

  // Site permissions
  const defaults = h('div', { class: 'list' });
  for (const [perm, label] of Object.entries(st.permissions)) {
    const sel = h('select', { id: `perm-default-${perm}`, 'aria-label': `${label} default` },
      h('option', { value: 'ask', text: 'Ask' }), h('option', { value: 'block', text: 'Block' }));
    sel.value = st.prefs.permissionDefaults[perm] || 'ask';
    sel.addEventListener('change', () => save('permissionDefaults', { ...st.prefs.permissionDefaults, [perm]: sel.value }));
    defaults.append(h('div', { class: 'item' }, h('span', { class: 'grow', text: label }), sel));
  }
  const granted = h('div', { class: 'list', id: 'site-permissions' });
  const renderGranted = async () => {
    const list = await S.sitePermissions();
    granted.replaceChildren(...(list.length ? list.map((p) => h('div', { class: 'item', 'data-origin': p.origin, 'data-permission': p.permission },
      h('span', { class: 'grow' }, p.origin, h('span', { class: 'note', text: ` · ${p.label}: ${p.allowed ? 'Allowed' : 'Blocked'}` })),
      h('button', { text: 'Revoke', class: 'revoke', onclick: async () => { await S.revokePermission(p.origin, p.permission); renderGranted(); } })))
      : [h('span', { class: 'note', text: 'No sites have asked yet.' })]));
  };
  const permissions = card.group('Site permissions').subpage('site-permissions', 'Site permissions', 'What sites may ask for, and which you allowed or blocked.', 'camera microphone location notifications revoke');
  permissions.append(stackRow('Default for new sites', 'Ask shows a prompt the first time a site asks; Block refuses without asking.', defaults));
  permissions.append(stackRow('Site permissions', 'What you allowed or blocked. Revoke to be asked again.', granted));
  renderGranted();

  // [site data] Every site that keeps cookies, with Remove (features/site-data.js).
  const sites = h('div', { class: 'list', id: 'site-data' });
  const filter = h('input', { type: 'search', id: 'site-data-filter', placeholder: 'Filter sites', 'aria-label': 'Filter sites' });
  let siteList = [];
  const renderSites = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = siteList.filter((s) => !q || s.site.includes(q));
    sites.replaceChildren(...(shown.length ? shown.map((s) => h('div', { class: 'item', 'data-site': s.site },
      h('span', { class: 'grow' }, s.site, h('span', { class: 'note', text: ` · ${s.cookies === 1 ? '1 cookie' : `${s.cookies} cookies`}` })),
      h('button', { text: 'Remove', class: 'revoke', 'aria-label': `Remove cookies and site data for ${s.site}`, onclick: async () => { siteList = (await S.clearSite(s.site)).list; renderSites(); } })))
      : [h('span', { class: 'note', text: q ? 'No sites match.' : 'No sites have stored cookies.' })]));
  };
  filter.addEventListener('input', renderSites);
  const loadSites = async () => { siteList = await S.siteData(); renderSites(); };
  const data = card.group('Site data').subpage('site-data', 'Site data', 'The sites that keep cookies on this computer, and removing one of them.', 'cookies storage website data remove manage');
  data.append(stackRow('Sites with cookies', 'Remove deletes a site’s cookies (you’ll be signed out of it) and what it stored on this computer. Clear browsing data removes everything at once.', filter, sites));
  loadSites();
}

// [passwords] Privacy and security → Passwords: the Save passwords switch, and a sub-page listing saved
// logins (site and username; Show and Copy ask for Touch ID or a confirmation first), with Edit, Delete,
// Import from a CSV export and Delete all. Passwords stay in the main process except the one being shown.
async function buildPasswords(card) {
  const P = S.passwords;
  let pw = await P.state();
  const WHY = {
    unavailable: 'Your system’s secure storage (the Keychain on macOS, data protection on Windows) isn’t available, so Lumen can’t keep passwords safely. Saving passwords stays off.',
    'basic-text': 'No system keyring (GNOME Keyring or KWallet) was found, so Lumen can’t keep passwords safely. Saving passwords stays off.',
  };
  const note = status('passwords-status');
  const renderNote = () => {
    const why = pw.refused || pw.unavailable;
    if (why) flash(note, WHY[why] || WHY.unavailable, 'err');
    else if (pw.error) flash(note, pw.error, 'err');
    else flash(note, pw.count ? `${pw.count} saved password${pw.count === 1 ? '' : 's'}.` : 'No saved passwords.', '');
  };
  const input = h('input', { type: 'checkbox', class: 'switch', id: 'pref-savePasswords', role: 'switch', 'aria-label': 'Save passwords' });
  input.checked = pw.enabled;
  input.addEventListener('change', async () => {
    input.disabled = true;
    try { pw = await P.setEnabled(input.checked); } finally { input.disabled = false; }
    input.checked = pw.enabled;
    renderNote();
    renderLogins();
  });
  const toggleRow = row('Save passwords', 'Offers to save a password when you sign in to a site, and fills it in when you click the key in the address bar. Never in private windows, and never on sites without a secure connection. Passwords are encrypted with your system’s keychain, and the AI in the sidebar, outside agents and page tools can’t read them.', input);
  toggleRow.querySelector('.label').addEventListener('click', () => input.click());
  toggleRow.querySelector('.text').append(note); // how many are saved, or why it can't turn on
  card.group('Passwords').append(toggleRow);
  renderNote();

  const page = card.subpage('passwords', 'Saved passwords', 'See, edit and delete saved passwords, or import them.', 'passwords logins keychain import csv username');
  const search = h('input', { type: 'search', class: 'grow', id: 'passwords-search', placeholder: 'Search sites and usernames', 'aria-label': 'Search saved passwords' });
  const list = h('div', { class: 'list', id: 'passwords-list' });
  const result = status('passwords-result');
  const errText = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const MASK = '••••••••';
  let logins = [];
  const item = (l) => {
    const secret = h('span', { class: 'mono', text: MASK, 'aria-label': 'Password hidden' });
    let hideTimer = null;
    const hide = () => { clearTimeout(hideTimer); secret.textContent = MASK; secret.setAttribute('aria-label', 'Password hidden'); showBtn.textContent = 'Show'; };
    const showBtn = h('button', {
      text: 'Show', 'aria-label': `Show the password for ${l.site}`,
      onclick: async () => {
        if (secret.textContent !== MASK) { hide(); return; }
        const value = await P.reveal(l.id).catch(() => null);
        if (value == null) return;
        secret.textContent = value;
        secret.removeAttribute('aria-label');
        showBtn.textContent = 'Hide';
        hideTimer = setTimeout(hide, 30000); // shown for 30 seconds at most
      },
    });
    const el = h('div', { class: 'item', 'data-site': l.site },
      h('span', { class: 'grow' }, l.site, h('span', { class: 'note', text: ` · ${l.username || 'no username'}` })),
      secret, showBtn,
      h('button', { text: 'Copy', 'aria-label': `Copy the password for ${l.site}`, onclick: async () => { if (await P.copy(l.id).catch(() => false)) flash(result, 'Copied. The clipboard is cleared in 30 seconds.'); } }),
      h('button', { text: 'Edit', 'aria-label': `Edit the login for ${l.site}`, onclick: () => el.replaceWith(editor(l)) }),
      h('button', { class: 'danger', text: 'Delete', 'aria-label': `Delete the login for ${l.site}`, onclick: async () => { logins = await P.remove(l.id); renderLogins(false); } }));
    return el;
  };
  const editor = (l) => {
    const user = h('input', { type: 'text', class: 'grow', value: l.username, autocomplete: 'off', 'aria-label': 'Username' });
    const pass = h('input', { type: 'password', class: 'grow', autocomplete: 'new-password', placeholder: 'New password (empty: keep it)', 'aria-label': 'New password' });
    const err = status();
    return h('div', { class: 'item', 'data-site': l.site },
      h('span', { text: l.site }), user, pass,
      h('button', { class: 'primary', text: 'Save', onclick: async () => {
        try { logins = await P.update(l.id, { username: user.value, ...(pass.value ? { password: pass.value } : {}) }); renderLogins(false); } catch (e) { flash(err, errText(e), 'err'); }
      } }),
      h('button', { text: 'Cancel', onclick: () => renderLogins(false) }), err);
  };
  async function renderLogins(reload = true) {
    if (reload) logins = await P.list().catch(() => []);
    const q = search.value.trim().toLowerCase();
    const shown = logins.filter((l) => !q || l.site.includes(q) || l.username.toLowerCase().includes(q));
    list.replaceChildren(...(shown.length ? shown.map(item) : [h('span', { class: 'note', text: logins.length ? 'No saved passwords match.' : 'No saved passwords.' })]));
    pw = await P.state();
    renderNote();
    renderNever();
  }
  search.addEventListener('input', () => renderLogins(false));
  const never = h('div', { class: 'list', id: 'passwords-never' });
  const renderNever = () => never.replaceChildren(...(pw.never.length ? pw.never.map((site) => h('div', { class: 'item' },
    h('span', { class: 'grow', text: site }),
    h('button', { text: 'Remove', 'aria-label': `Remove ${site}`, onclick: async () => { pw = await P.removeNever(site); renderNever(); } })))
    : [h('span', { class: 'note', text: 'None.' })]));
  const IMPORT_ERRORS = {
    columns: 'That file has no url, username and password columns. Export a CSV from Chrome (Password Manager → Settings → Export) or Apple Passwords (File → Export).',
    empty: 'That file is empty.', 'too-big': 'That file is too big for a passwords export.', unreadable: 'Lumen couldn’t read that file.',
    unavailable: 'Your system’s secure storage isn’t available, so nothing was imported.',
  };
  page.append(stackRow('Saved passwords', 'Only on this computer, encrypted with your system’s keychain. Show and Copy ask for Touch ID where the Mac has it, and for a confirmation otherwise.',
    h('div', { class: 'controls' }, search), list,
    h('div', { class: 'controls' }, result,
      h('button', { id: 'passwords-import', text: 'Import from CSV…', onclick: async () => {
        const r = await P.importCsv().catch((e) => ({ error: 'save', message: errText(e) }));
        if (r.cancelled) return;
        if (r.error) flash(result, IMPORT_ERRORS[r.error] || r.message || 'Import failed.', 'err');
        else flash(result, `Imported ${r.added} new, ${r.updated} updated${r.unchanged ? `, ${r.unchanged} already saved` : ''}${r.skipped ? `, ${r.skipped} skipped (not a secure web site)` : ''}. Delete the CSV file now: it isn’t encrypted.`);
        renderLogins();
      } }),
      h('button', { class: 'danger', id: 'passwords-delete-all', text: 'Delete all saved passwords', onclick: async () => { pw = await P.removeAll(); renderLogins(); } }))));
  page.append(stackRow('Never saved for', 'Sites where you chose “Never for this site”. Remove one to be asked again.', never));
  renderLogins();
}

// Settings → AI → Agents and tools: the Antigravity CLI (Google's coding agent, which replaces Gemini CLI). Installed? The official install
// command is shown, and runs only on the click.
function buildAntigravity(slot, refreshModels) {
  const agyNote = status('ai-agy-status');
  const agyCommand = h('pre', { class: 'mono code', id: 'ai-agy-command', text: '' });
  const agyButtons = h('div', { class: 'controls' });
  const renderAgy = (s) => {
    agyNote.className = 'note';
    agyNote.textContent = !s.installed ? tr('settings.ai.agyMissing', 'Not installed.') : s.enabled ? tr('settings.ai.agyOn', 'Installed and offered in the model menu. If it asks you to sign in, run agy in a terminal and sign in with your Google account.') : tr('settings.ai.agyFound', 'Installed. Not offered in the model menu yet.');
    agyCommand.textContent = s.installCommand || '';
    agyCommand.hidden = Boolean(s.installed);
    const buttons = [];
    if (!s.installed) {
      buttons.push(h('button', {
        id: 'ai-agy-install', class: 'primary', text: tr('settings.ai.agyInstall', 'Run this command'),
        onclick: async (e) => {
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = tr('settings.ai.agyInstalling', 'Installing…');
          const r = await S.ai.antigravityInstall().catch((err) => ({ ok: false, output: err.message }));
          renderAgy(await S.ai.antigravityStatus(true));
          if (!r.ok) flash(agyNote, r.output || tr('settings.ai.agyInstallFailed', 'The installer did not finish.'), 'err');
          await refreshModels();
        },
      }));
    } else if (!s.enabled) {
      buttons.push(h('button', { id: 'ai-agy-use', class: 'primary', text: tr('settings.ai.agyUse', 'Use in the sidebar'), onclick: async () => { await S.ai.useAntigravity(); renderAgy(await S.ai.antigravityStatus(true)); await refreshModels(); } }));
    }
    buttons.push(h('button', { id: 'ai-agy-check', text: tr('settings.ai.agyCheck', 'Check again'), onclick: async () => { renderAgy(await S.ai.antigravityStatus(true)); await refreshModels(); } }));
    agyButtons.replaceChildren(...buttons);
  };
  const agyRow = row(tr('settings.ai.agy', 'Antigravity (replaces Gemini CLI)'), tr('settings.ai.agyDesc', 'Google’s coding agent, signed in with your own Google account: Lumen never sees the login. In the sidebar it gets Lumen’s browser tools only, like Claude Code and Grok Build. The install command below is Google’s own; it runs only when you click the button.'), agyButtons);
  agyRow.querySelector('.text').append(agyCommand, agyNote);
  S.ai.antigravityStatus(false).then(renderAgy).catch(() => {});
  slot.append(agyRow);
}

async function buildDownloads(card) {
  const where = h('span', { class: 'mono', id: 'download-dir' });
  const showDir = () => { where.textContent = st.prefs.downloadDir || st.defaultDownloadDir; };
  showDir();
  card.append(
    stackRow('Location', null, where, h('div', { class: 'controls' },
      h('button', { text: 'Change…', onclick: async () => { st = await S.pickDownloadDir(); showDir(); } }),
      h('button', { text: 'Use Downloads folder', onclick: async () => { await save('downloadDir', ''); showDir(); } }))),
    toggle('askWhereToSave', 'Ask where to save each file before downloading', null),
  );
  const list = h('div', { class: 'list', id: 'downloads-list' });
  const render = async () => {
    const items = await S.downloads();
    list.replaceChildren(...(items.length ? items.map((d) => h('div', { class: 'item' },
      h('span', { class: 'grow', text: d.name }),
      h('span', { class: 'note', text: d.state === 'progressing' ? (d.total ? `${Math.round((d.received / d.total) * 100)}%` : 'Downloading') : d.state === 'completed' ? bytes(d.total || d.received) : d.state }),
      d.state === 'completed' ? h('button', { text: 'Show in folder', onclick: () => S.showDownload(d.id) }) : null))
      : [h('span', { class: 'note', text: 'No downloads yet.' })]));
  };
  card.append(stackRow('Recent downloads', 'Kept across restarts. The toolbar’s download button shows them too, and you can drag files out of it.', list, h('div', { class: 'controls' },
    h('button', { id: 'downloads-clear', text: 'Clear list', onclick: async () => { await S.clearDownloads(); render(); } }))));
  render();
}

// ---------- [usage] Usage: the plan's limits and Lumen's share (features/usage.js) ----------
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));
const dollars = (n) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0');
const ENGINE_NAMES = { claudecode: 'Claude Code', grokbuild: 'Grok Build', anthropic: 'Claude (API key)' };
function meterRow(label, percent, note) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const fill = h('i');
  fill.style.width = `${p}%`; // through the CSSOM: the page's CSP drops inline style attributes
  const bar = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p)), 'aria-label': label }, fill);
  bar.classList.toggle('high', p >= 80);
  return stackRow(label, note, h('div', { class: 'meter-line' }, bar, h('span', { class: 'meter-value', text: `${Math.round(p)}%` })));
}
// Grok Build: it publishes no plan limits, so these rows are Lumen's own use (from its log), an optional
// budget the user sets, and Grok's own limit-reached message. None of it is "plan remaining".
function grokUsageRows(u, refresh) {
  const g = u.grok;
  if (!g) return [];
  const rows = [];
  rows.push(row('Grok Build', 'Grok doesn’t share your plan’s limits, so this shows Lumen’s own use; set a budget to get a progress bar.'));
  if (g.limit) {
    const when = g.limit.resetsAt ? `resets at ${new Date(g.limit.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'no reset time was given';
    rows.push(row('Grok limit reached', `${when}. ${g.limit.text || ''} This clears after your next Grok reply that works.`.trim()));
  }
  const line = (label, w) => `${label}: ${w.turns} turn${w.turns === 1 ? '' : 's'} · ${tokens(w.tokens)} tokens · ${dollars(w.costUSD)} at API prices`;
  rows.push(row('Lumen’s Grok use', g.windows?.d7?.turns
    ? `${line('Last 5 hours', g.windows.h5)}. ${line('Last 7 days', g.windows.d7)}. This is Lumen’s own use, not what’s left of your plan.`
    : 'No Grok chats in Lumen in the last 7 days.'));
  const cfg = g.budget?.config || { unit: 'usd', daily: 0, weekly: 0 };
  for (const p of g.budget?.status?.periods || []) {
    const fmt = g.budget.status.unit === 'tokens' ? (n) => `${tokens(Math.round(n))} tokens` : dollars;
    rows.push(meterRow(p.kind === 'daily' ? 'Grok daily budget' : 'Grok weekly budget', p.percent, `${fmt(p.used)} of ${fmt(p.limit)} · resets ${new Date(p.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`));
  }
  const unit = h('select', { id: 'usage-budget-unit', 'aria-label': 'Budget unit' }, h('option', { value: 'usd', text: 'Dollars (API prices)' }), h('option', { value: 'tokens', text: 'Tokens' }));
  unit.value = cfg.unit;
  const amount = (id, label, value) => h('input', { type: 'number', id, min: '0', step: 'any', placeholder: 'None', 'aria-label': label, value: value ? String(value) : '' });
  const daily = amount('usage-budget-daily', 'Daily budget', cfg.daily);
  const weekly = amount('usage-budget-weekly', 'Weekly budget', cfg.weekly);
  rows.push(stackRow('Grok budget (optional)', 'Counts Lumen’s own Grok use. The sidebar bar becomes a progress bar toward it (a day ends at midnight, a week on Monday), turns amber at 80% and red at 100%, and never blocks anything. Leave both empty for none.',
    h('div', { class: 'controls' }, unit, h('label', { class: 'note', text: 'Daily' }), daily, h('label', { class: 'note', text: 'Weekly' }), weekly,
      h('button', { id: 'usage-budget-save', text: 'Save budget', onclick: async () => { await S.setUsageBudget({ unit: unit.value, daily: daily.value, weekly: weekly.value }); refresh(); } }))));
  return rows;
}
async function buildUsage(card) {
  const body = h('div', { class: 'usage' });
  const render = async (refresh) => {
    body.replaceChildren(row('Checking your usage…', null));
    const u = await S.usage({ refresh }).catch((err) => ({ error: err.message }));
    if (!u || u.error) { body.replaceChildren(row('Usage isn’t available', u?.error || 'No answer.')); return; }
    const parts = [];
    // The plan (from `claude /usage`, or the latest turn's reading).
    if (u.plan?.available && u.plan.limits.length) {
      for (const l of u.plan.limits) parts.push(meterRow(l.label === 'Current session' ? '5-hour limit (current session)' : l.label, l.percent, l.resets ? `Resets ${l.resets}` : null));
    } else if (u.meter) {
      parts.push(meterRow('5-hour limit', u.meter.percent, `Resets ${new Date(u.meter.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`));
    } else {
      parts.push(row('Your Claude plan', u.plan?.reason ? `Couldn’t read it: ${u.plan.reason}` : 'Chat once with “Claude · your account (Claude Code)” to see your limits here.'));
    }
    const EXTRA = { 'in use': 'In use: you’re past your plan’s limit and on extra usage.', rejected: 'Off for your plan: at the limit, Claude waits for the reset.', allowed: 'Available: past the limit, Claude can keep going on extra usage.' };
    if (u.status?.overage) parts.push(row('Extra usage', EXTRA[u.status.overage] || String(u.status.overage).replace(/_/g, ' ')));

    // Lumen's share.
    const w = u.lumen.window;
    const share = w.limitPoints != null
      ? `≈ ${w.limitPoints < 1 ? '<1' : Math.round(w.limitPoints)} of those points came from Lumen's sidebar${w.unknown ? ` (${w.unknown} turn${w.unknown === 1 ? '' : 's'} couldn’t be measured)` : ''}.`
      : w.turns ? 'How far each turn moved the meter shows up after your next chat.' : 'No Claude Code chats in Lumen in this window.';
    parts.push(row('Lumen’s sidebar, this 5-hour window', `${w.turns} turn${w.turns === 1 ? '' : 's'} · ${tokens(w.tokens)} tokens · ${dollars(w.costUSD)} at API prices. ${share}`));
    const mcp = (u.plan?.contributions || []).map((c) => `${c.lumen}% in the last ${c.period}`).join(', ');
    const machine = navigator.platform.startsWith('Mac') ? 'Mac' : navigator.platform.startsWith('Win') ? 'PC' : 'computer';
    if (mcp) parts.push(row('Claude Code driving Lumen (MCP)', `Share of this ${machine}’s Claude Code usage from Lumen’s browser tools: ${mcp}.`));

    const engines = Object.entries(u.lumen.byEngine);
    const list = h('div', { class: 'list', id: 'usage-engines' }, engines.length
      ? engines.map(([id, e]) => h('div', { class: 'item' },
        h('span', { class: 'grow', text: ENGINE_NAMES[id] || id }),
        h('span', { class: 'note', text: `${e.turns} turn${e.turns === 1 ? '' : 's'} · ${tokens(e.tokens)} tokens${e.costUSD ? ` · ${dollars(e.costUSD)} at API prices` : ''}` })))
      : [h('span', { class: 'note', text: 'Nothing yet.' })]);
    parts.push(stackRow('Lumen, last 7 days', 'Plans don’t bill per token; the API-price figure is only a yardstick for how heavy the use was.', list));
    parts.push(...grokUsageRows(u, () => render(false)));
    parts.push(row('', null,
      h('button', { id: 'usage-refresh', text: 'Refresh', onclick: () => render(true) }),
      h('button', { text: 'Clear Lumen’s usage log', onclick: async () => { await S.clearUsage(); render(false); } })));
    body.replaceChildren(...parts);
  };
  card.append(row('What counts', 'Limits are shared by everything on your Claude account: Claude Code in a terminal, claude.ai and the Claude apps. The share from Lumen is approximate.'), body);
  render(false);
}

const COMMON_LANGUAGES = ['en-US', 'en-GB', 'fr', 'de', 'es', 'it', 'pt-BR', 'pt-PT', 'nl', 'sv', 'da', 'nb', 'fi', 'pl', 'cs', 'ru', 'uk', 'tr', 'el', 'ar', 'he', 'hi', 'ja', 'ko', 'zh-CN', 'zh-TW', 'vi', 'th', 'id'];

function buildLanguages(card) {
  const list = h('div', { class: 'list', id: 'languages-list' });
  const add = h('select', { id: 'language-add', 'aria-label': 'Add a language' });
  const preview = h('span', { class: 'note mono', id: 'accept-language' });
  const render = () => {
    const langs = st.prefs.languages;
    list.replaceChildren(...(langs.length ? langs.map((l, i) => h('div', { class: 'item' },
      h('span', { class: 'grow', text: `${langName(l)} (${l})` }),
      h('button', { text: 'Move up', disabled: i === 0, onclick: async () => { const next = [...langs]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; await save('languages', next); render(); } }),
      h('button', { text: 'Remove', onclick: async () => { await save('languages', langs.filter((x) => x !== l)); render(); } })))
      : [h('span', { class: 'note', text: `Using your system language (${st.systemLocale}).` })]));
    add.replaceChildren(h('option', { value: '', text: 'Add a language…' }),
      ...COMMON_LANGUAGES.filter((l) => !langs.includes(l)).map((l) => h('option', { value: l, text: `${langName(l)} (${l})` })));
    preview.textContent = st.acceptLanguagePreview ? `Accept-Language: ${st.acceptLanguagePreview}` : '';
  };
  add.addEventListener('change', async () => { if (!add.value) return; await save('languages', [...st.prefs.languages, add.value]); render(); });
  render();
  card.append(stackRow('Preferred languages', 'Websites see these, in this order, when they choose a language (the Accept-Language header).', list, h('div', { class: 'controls' }, preview, add)));

  card.append(toggle('spellcheck', 'Check spelling when you type', 'Misspelled words are underlined; right-click one for suggestions.', () => renderSpell()));
  const spell = h('div', { class: 'list', id: 'spellcheck-languages' });
  const renderSpell = () => {
    if (st.platform === 'darwin') {
      spell.replaceChildren(h('span', { class: 'note', text: 'macOS checks spelling in the languages set in System Settings.' }));
      return;
    }
    const active = st.spellcheckActive;
    spell.replaceChildren(...st.spellcheckAvailable.map((l) => {
      const box = h('input', { type: 'checkbox', value: l, checked: active.includes(l), disabled: !st.prefs.spellcheck });
      box.addEventListener('change', async () => {
        const chosen = [...spell.querySelectorAll('input:checked')].map((b) => b.value);
        if (!chosen.length) { box.checked = true; return; }
        await save('spellcheckLanguages', chosen);
        renderSpell();
      });
      return h('label', { class: 'check' }, box, `${langName(l)} (${l})`);
    }));
  };
  renderSpell();
  card.append(stackRow('Spell check languages', null, spell));
  buildTranslate(card);
}

// Page translation (features/translate.js): offer, target language, and what the user allowed.
function buildTranslate(card) {
  const TARGETS = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['pl', 'Polish'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['zh-CN', 'Chinese (Simplified)'], ['zh-TW', 'Chinese (Traditional)'], ['ja', 'Japanese'], ['ko', 'Korean'], ['vi', 'Vietnamese'], ['id', 'Indonesian'], ['th', 'Thai'], ['el', 'Greek']];
  const listRow = (key, title, none, label = (v) => v) => {
    const list = h('div', { class: 'list', id: `pref-${key}` });
    const render = () => list.replaceChildren(...(st.prefs[key].length ? st.prefs[key].map((value) => h('div', { class: 'item' },
      h('span', { class: 'grow', text: label(value) }),
      h('button', { text: 'Remove', onclick: async () => { await save(key, st.prefs[key].filter((x) => x !== value)); render(); } })))
      : [h('span', { class: 'note', text: none })]));
    render();
    return stackRow(title, null, list);
  };
  card.group('Translation').append(
    toggle('translateOffer', tr('settings.translate.offer', 'Offer to translate pages'), tr('settings.translate.offerDesc', 'When a page is in another language than yours, show a translate button and a bar. Nothing is sent anywhere until you click Translate. Translating on this device never sends the page’s text anywhere; before Lumen sends it to your AI provider, or opens Google Translate, it asks.')),
    select('translateTarget', tr('settings.translate.target', 'Translate pages into'), null,
      [['', tr('settings.translate.targetDefault', 'Lumen’s language')], ...TARGETS.map(([code, name]) => [code, `${langName(code)}` === code ? name : langName(code)])]),
    select('translateEngine', tr('settings.translate.engine', 'Translate with'), tr('settings.translate.engineDesc', 'On this device uses Mozilla’s open-source translator (the one in Firefox): private, and works offline once a language pack is downloaded. Your connected AI is the other choice, and the fallback when there is no pack for a language.'),
      [['local', tr('settings.translate.engine.local', 'On this device')], ['ai', tr('settings.translate.engine.ai', 'My connected AI')]]),
    toggle('translateLocalAuto', tr('settings.translate.auto', 'Download language packs without asking'), tr('settings.translate.autoDesc', 'On-device translation needs a language pack from Mozilla, about 20 to 55 MB for each direction, downloaded once. Off: Lumen asks before each download.')),
    listRow('translateNever', tr('settings.translate.never', 'Sites never offered translation'), tr('settings.translate.neverNone', 'No sites.')),
    listRow('translateConsent', tr('settings.translate.consent', 'Allowed to receive page text'), tr('settings.translate.consentNone', 'None yet: Lumen asks the first time you translate.'), (v) => (v === 'google' ? 'Google Translate' : v)),
  );
  buildTranslatePacks(card);
}

// Settings → Translation → the language packs on this device (features/translate-local.js): what is
// downloaded and how big, delete, and "Download for offline".
let offTranslateProgress = null; // stops the previous card's progress listener
function buildTranslatePacks(card) {
  if (!S.translatePacks) return;
  const list = h('div', { class: 'list', id: 'translate-packs' });
  const total = h('span', { class: 'note', id: 'translate-packs-total' });
  const pickLang = h('select', { id: 'translate-offline-language', 'aria-label': tr('settings.translate.offline', 'Download for offline') });
  const go = h('button', { id: 'translate-offline-go', text: tr('settings.translate.offline.go', 'Download') });
  const stop = h('button', { id: 'translate-offline-cancel', text: tr('settings.translate.offline.cancel', 'Cancel'), hidden: true });
  const note = status('translate-offline-status');
  let busy = false;
  let downloadingCode = '';
  // Delete asks twice (a second click within 4 seconds): a pack is 20 to 55 MB of download.
  const confirmDelete = (label, confirmLabel, action, cls = 'danger', id) => {
    const b = h('button', { class: cls, text: label, 'aria-label': label, ...(id ? { id } : {}) }); // the name stays put; the live region says "Click again"
    const announce = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' }); // screen readers hear "Click again" (one region per button)
    const wrap = h('span', { class: 'confirm-delete' }, b, announce);
    wrap.style.display = 'contents';
    let timer = 0;
    const reset = () => { clearTimeout(timer); timer = 0; b.textContent = label; b.removeAttribute('data-armed'); announce.textContent = ''; };
    b.addEventListener('click', () => {
      if (!timer) { b.textContent = confirmLabel; b.dataset.armed = '1'; announce.textContent = confirmLabel; timer = setTimeout(reset, 4000); return; }
      reset();
      action();
    });
    return wrap;
  };
  const arrow = (a, b) => `${a === 'en' ? langName('en') : langName(a)} → ${b === 'en' ? langName('en') : langName(b)}`;
  const render = (data) => {
    list.replaceChildren(...(data.installed.length ? data.installed.map((p) => h('div', { class: 'item' },
      h('span', { class: 'grow', text: `${arrow(p.from, p.to)} · ${bytes(p.bytes)}` }),
      confirmDelete(tr('settings.translate.packs.delete', 'Delete'), tr('settings.translate.packs.deleteSure', 'Delete? Click again'), async () => render(await S.translatePacks.remove(p.from, p.to)))))
      : [h('span', { class: 'note', text: tr('settings.translate.packs.none', 'None yet. A pack downloads the first time you translate to or from a language.') })]));
    total.textContent = data.installed.length ? tr('settings.translate.packs.total', 'Using {size} in total.', { size: bytes(data.used) }) : '';
    sizes = new Map(data.languages.map((l) => [l.code, l.missing || l.bytes]));
    const chosen = pickLang.value;
    pickLang.replaceChildren(...data.languages.map((l) => h('option', { value: l.code, text: `${langName(l.code)}${l.missing ? ` (${bytes(l.missing)})` : ` (${tr('settings.translate.offline.have', 'downloaded')})`}`, disabled: !l.missing })));
    if (chosen && data.languages.some((l) => l.code === chosen && l.missing)) pickLang.value = chosen;
    go.disabled = busy || !data.languages.some((l) => l.missing);
    if (data.error && !data.languages.length) flash(note, tr('settings.translate.offline.registry', 'Couldn’t reach Mozilla’s list of language packs. Check your connection.'), 'err');
  };
  // One listener for the life of this card: a rebuilt page drops the previous one first.
  offTranslateProgress?.();
  let sizes = new Map(); // language -> total bytes of its packs, for "Spanish (23 MB) 40%"
  const progressText = (code, percent) => tr('settings.translate.offline.progress', 'Downloading {language} ({size})… {percent}%', { language: langName(code), size: bytes(sizes.get(code)), percent });
  offTranslateProgress = S.translatePacks.onProgress((info) => {
    if (busy && info.code === downloadingCode) flash(note, progressText(info.code, Math.round(info.fraction * 100)), 'note');
  });
  go.addEventListener('click', async () => {
    if (busy || !pickLang.value) return;
    busy = true;
    downloadingCode = pickLang.value;
    go.disabled = true;
    stop.hidden = false;
    flash(note, progressText(downloadingCode, 0), 'note');
    let out;
    try { out = await S.translatePacks.download(downloadingCode); } catch (err) { out = { failed: String(err?.message || err), ...(await S.translatePacks.list()) }; }
    busy = false;
    downloadingCode = '';
    stop.hidden = true;
    render(out);
    if (out.failed) {
      const offline = navigator.onLine === false || /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|no data for|timed out/i.test(out.failed);
      flash(note, offline ? tr('settings.translate.offline.offlineFailed', 'Couldn’t download: you appear to be offline. Check your connection and try again.') : tr('settings.translate.offline.failed', 'Couldn’t download: {error}', { error: out.failed }), 'err');
    }
    else if (out.cancelled) flash(note, tr('settings.translate.offline.cancelled', 'Cancelled.'), 'note');
    else flash(note, tr('settings.translate.offline.done', 'Downloaded.'));
  });
  stop.addEventListener('click', () => { if (downloadingCode) S.translatePacks.cancel(downloadingCode); });
  S.translatePacks.list().then(render).catch(() => {});
  card.append(
    stackRow(tr('settings.translate.packs', 'Language packs on this device'), tr('settings.translate.packsDesc', 'Downloaded from Mozilla, stored in Lumen’s data folder, and used only by on-device translation.'), list,
      h('div', { class: 'controls' }, total, confirmDelete(tr('settings.translate.packs.deleteAll', 'Delete all'), tr('settings.translate.packs.deleteAllSure', 'Delete all packs? Click again'), async () => render(await S.translatePacks.removeAll()), 'danger', 'translate-packs-delete-all'))),
    stackRow(tr('settings.translate.offline', 'Download for offline'), tr('settings.translate.offlineDesc', 'Get a language’s packs (to and from English) now, so translating works with no connection. Two languages without a pack between them go through English.'),
      h('div', { class: 'controls start' }, pickLang, go, stop, note)),
  );
}

function buildAccessibility(card) {
  card.append(
    toggle('reduceMotion', 'Reduce motion', 'Turns off animations in Lumen (tabs, sidebar, these pages).'),
    select('minimumFontSize', 'Minimum font size', 'Websites can’t make text smaller than this. Applies to new tabs.', [[0, 'None'], [6, '6'], [9, '9'], [12, '12'], [16, '16'], [20, '20'], [24, '24']], { number: true }),
    toggle('focusRings', 'Show a focus ring', 'Always outline the focused control in Lumen, not only when using the keyboard.'),
  );
}

function buildSystem(card) {
  card.append(withRelaunch(toggle('hardwareAcceleration', 'Use graphics acceleration when available', 'Turn off if pages flicker or draw incorrectly. Takes effect after a relaunch.'), 'hardwareAcceleration', 'relaunch'));
  const perfRow = select('performanceMode', tr('settings.performance.label', 'Performance mode'), tr('settings.performance.desc', 'Runs Lumen lighter on a slow computer: background tabs sleep sooner, smaller caches, no blur or animation. Auto turns it on when needed.'),
    [['auto', tr('settings.performance.auto', 'Auto')], ['on', tr('settings.performance.on', 'Always on')], ['off', tr('settings.performance.off', 'Off')]], { after: () => showPerfNote() });
  const perfNote = h('span', { class: 'note', id: 'performance-note' });
  const showPerfNote = () => {
    const p = st.performance;
    const WHY_KEYS = { memory: 'settings.performance.why.memory', cpu: 'settings.performance.why.cpu', gpu: 'settings.performance.why.gpu', throttled: 'settings.performance.why.throttled' };
    const why = (p?.reasons || []).filter((r) => WHY_KEYS[r.key]).map((r) => tr(WHY_KEYS[r.key], { memory: 'this PC has {gb} GB of memory', cpu: 'this PC has {count} processor cores', gpu: 'graphics acceleration is not available', throttled: 'the PC is limiting its speed' }[r.key], r.vars));
    perfNote.textContent = p?.active ? (why.length ? tr('settings.performance.on.because', 'Performance mode is on because {why}.', { why: why.join(', ') }) : tr('settings.performance.on.note', 'Performance mode is on.')) : '';
  };
  showPerfNote();
  perfRow.querySelector('.text').append(perfNote);
  card.append(perfRow);
  card.at('tabs-sleep').append(toggle('tabSleep', 'Put unused tabs to sleep', 'Frees up memory from background tabs left untouched for a while; switching back reloads them.'));
  if (st.platform === 'darwin') {
    card.at('behavior').append(toggle('keepRunningInBackground', 'Keep Lumen running when its window is closed', 'Lumen stays in the Dock; click it to open a window.'));
  }

  // Proxy
  card.group('Network');
  const p = st.prefs.proxy;
  const mode = h('select', { id: 'proxy-mode', 'aria-label': 'Proxy' },
    [['system', 'Use system settings'], ['direct', 'No proxy'], ['auto_detect', 'Detect automatically'], ['fixed_servers', 'Manual'], ['pac_script', 'Configuration script (PAC)']].map(([v, t]) => h('option', { value: v, text: t })));
  mode.value = p.mode;
  const rules = h('input', { type: 'text', class: 'grow', id: 'proxy-rules', placeholder: 'http=proxy:8080;https=proxy:8080 or socks5://proxy:1080', value: p.rules });
  const bypass = h('input', { type: 'text', class: 'grow', id: 'proxy-bypass', placeholder: 'Bypass: localhost, *.internal', value: p.bypass });
  const pac = h('input', { type: 'url', class: 'grow', id: 'proxy-pac', placeholder: 'https://example.com/proxy.pac', value: p.pacUrl });
  const note = status('proxy-status');
  const sync = () => {
    rules.hidden = bypass.hidden = mode.value !== 'fixed_servers';
    pac.hidden = mode.value !== 'pac_script';
  };
  sync();
  mode.addEventListener('change', sync);
  card.append(stackRow('Proxy', 'Applies to every tab straight away.', h('div', { class: 'controls start' }, mode), rules, bypass, pac,
    h('div', { class: 'controls' }, note, h('button', {
      id: 'proxy-apply', text: 'Apply',
      onclick: async () => { await save('proxy', { mode: mode.value, rules: rules.value, bypass: bypass.value, pacUrl: pac.value }); flash(note, 'Applied.'); },
    }))));
}

async function buildExtensions(card) {
  const list = h('div', { class: 'list', id: 'extensions-list' });
  const render = (items) => list.replaceChildren(...(items.length ? items.map((e) => h('div', { class: 'item' },
    h('span', { class: 'grow' }, e.name, h('span', { class: 'note', text: ` ${e.version}${e.description ? ` · ${e.description}` : ''}` })),
    e.options ? h('button', { text: 'Options', onclick: () => S.extensionOptions(e.id) }) : null,
    h('button', { class: 'danger', text: 'Remove', onclick: async () => render(await S.removeExtension(e.id)) })))
    : [h('span', { class: 'note', text: 'No extensions installed.' })]));
  render(await S.extensions());
  card.append(stackRow('Installed extensions', 'Chrome Web Store extensions. Removing one deletes it and its data. Extensions can’t be paused: Electron has no disable switch.', list,
    h('div', { class: 'controls' }, h('button', { text: 'Open Chrome Web Store', onclick: () => S.openUrl('https://chromewebstore.google.com/') }))));
}

function buildReset(card) {
  const note = status('reset-status');
  const button = h('button', { class: 'danger', id: 'reset', text: 'Reset settings' });
  button.addEventListener('click', async () => {
    if (!button.dataset.armed) {
      button.dataset.armed = '1';
      button.textContent = 'Confirm reset';
      setTimeout(() => { delete button.dataset.armed; button.textContent = 'Reset settings'; }, 4000);
      return;
    }
    st = await S.reset();
    flash(note, 'Settings restored to their defaults.');
    setTimeout(() => location.reload(), 600);
  });
  card.append(row('Restore settings to their original defaults', 'Resets appearance, search engine, startup, privacy, site permissions, languages and system settings. Bookmarks, history, API keys and sign-ins stay.', note, button));
}

async function buildAbout(card) {
  await buildUpdates(card); // renderer/settings-updates.js
  card.group('About Lumen');
  const a = await S.about();
  const versions = h('table', { id: 'about-versions' },
    h('tr', {}, h('th', { text: 'Component' }), h('th', { text: 'Version' })),
    [['Lumen', a.version], ['Electron', a.versions.electron], ['Chromium', a.versions.chrome], ['Node.js', a.versions.node], ['V8', a.versions.v8], ['Anthropic CLI (pinned)', a.cliPinned], ['OS', a.os]]
      .map(([k, v]) => h('tr', { 'data-component': k }, h('td', { text: k }), h('td', { class: 'mono', text: v }))));
  card.append(stackRow('Lumen', 'Every AI, one browser. Free software under the GPL-3.0 license.', versions));
  // For a bug report: the versions as plain text, and where to file it.
  const details = () => [...versions.querySelectorAll('tr[data-component]')].map((r) => `${r.cells[0].textContent}: ${r.cells[1].textContent}`).join('\n');
  const copyDetails = h('button', { id: 'about-copy', type: 'button', text: 'Copy version details', onclick: async () => {
    try { await navigator.clipboard.writeText(details()); copyDetails.textContent = 'Copied'; } catch { copyDetails.textContent = 'Select the table to copy it'; }
    setTimeout(() => { copyDetails.textContent = 'Copy version details'; }, 1600);
  } });
  const issues = 'https://github.com/emah-maker/lumen/issues';
  const report = h('a', { id: 'about-report', href: issues, text: 'Report a problem', onclick: (e) => { e.preventDefault(); S.openUrl(issues); } });
  card.append(row('Found a problem?', 'Copy the version details and include them in your report.', report, copyDetails));
  card.append(stackRow('Build', null, h('table', {},
    [['App', a.appPath], ['Executable', a.exePath], ['Profile', a.userData], ['Packaged', a.packaged ? 'Yes' : 'No (development)']]
      .map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: 'mono', text: v }))))));

  // Task manager
  const table = h('table', { id: 'task-manager' });
  const render = async () => {
    const procs = await S.taskManager();
    table.replaceChildren(h('tr', {}, h('th', { text: 'Process' }), h('th', { class: 'num', text: 'Memory' }), h('th', { class: 'num', text: 'CPU' }), h('th', { class: 'num', text: 'PID' }), h('th', {})),
      ...procs.map((p) => h('tr', {},
        h('td', { text: p.name }), h('td', { class: 'num', text: bytes(p.memoryKB * 1024) }), h('td', { class: 'num', text: `${p.cpu}%` }), h('td', { class: 'num', text: p.pid }),
        h('td', {}, p.tabIds.length === 1 ? h('button', { text: 'Restart', title: 'End this tab’s process and reload it', onclick: async () => { await S.restartTab(p.tabIds[0]); setTimeout(render, 800); } }) : null))));
  };
  slots.get('task-manager').append(stackRow('Task manager', 'Every Lumen process, with memory (working set) and CPU.', table));
  await render();
  const timer = setInterval(() => { if (visibleNow(table) && !document.hidden && !query()) render(); }, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer));
}

async function buildInternals(card) {
  const data = await S.internals();
  card.append(stackRow('GPU features', data.hardwareAcceleration ? 'Graphics acceleration is on.' : 'Graphics acceleration is off (System settings).',
    h('table', { id: 'gpu-status' }, Object.entries(data.gpuFeatures).map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: /enabled/.test(v) ? 'ok' : 'note', text: v }))))));
  if (data.gpuDevices.length) {
    card.append(stackRow('GPU devices', null, h('table', {}, data.gpuDevices.map((d) => h('tr', {},
      h('td', { class: 'mono', text: `vendor 0x${d.vendorId.toString(16)} · device 0x${d.deviceId.toString(16)}` }), h('td', { text: d.active ? 'Active' : '' }), h('td', { class: 'mono', text: d.driver }))))));
  }
  for (const s of data.sessions) {
    card.append(stackRow(`Session: ${s.name}`, null, h('table', { id: 'session-info' },
      [['Persistent', s.persistent ? 'Yes' : 'No'], ['Storage', s.storagePath || '(in memory)'], ['Cache', bytes(s.cacheBytes)], ['Cookies', s.cookies ?? '—'],
        ['Proxy for https://example.com', s.proxyForExample], ['Spell check', s.spellcheck ? 'On' : 'Off'], ['User agent', s.userAgent]]
        .map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: 'mono', text: String(v) }))))));
  }
  if (data.commandLine.length) card.append(stackRow('Command-line switches', null, h('span', { class: 'mono', text: data.commandLine.join(' ') })));
}

// ---------- restart notes, page classes ----------

function refreshRestartNotes() {
  for (const button of document.querySelectorAll('button.relaunch')) button.hidden = !st.restartNeeded.includes(button.dataset.key);
}
function applyPageClasses() {
  document.documentElement.classList.toggle('reduce-motion', Boolean(st.prefs.reduceMotion || st.performance?.active));
  applyPageAccent(); // [look]
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (st) applyPageAccent(); });

// ---------- navigation and search ----------

let view = { cat: DEFAULT_CATEGORY, sub: null }; // what the right pane shows
const query = () => $('search').value.trim().toLowerCase();
const REMEMBER = 'lumen.settings.category';
const remembered = () => { try { const id = localStorage.getItem(REMEMBER); return categories.has(id) ? id : null; } catch { return null; } };
const remember = (id) => { try { localStorage.setItem(REMEMBER, id); } catch {} };

function show() {
  const words = query().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  document.body.classList.toggle('searching', searching);
  const catTitle = (slot) => categories.get(slot.cat).title.toLowerCase();
  const hitsBySlot = new Map();
  for (const slot of slots.values()) {
    let hits = 0;
    for (const g of slot.groups) {
      const rows = [...g.querySelectorAll('.row')];
      if (!searching) {
        for (const r of rows) r.classList.remove('filtered');
        g.hidden = false;
        continue;
      }
      const titleHit = words.every((w) => `${g.dataset.title} ${slot.isSub ? slot.title : ''} ${catTitle(slot)}`.toLowerCase().includes(w));
      let n = 0;
      for (const r of rows) {
        const hit = titleHit || words.every((w) => `${r.dataset.search} ${catTitle(slot)}`.includes(w));
        r.classList.toggle('filtered', !hit);
        if (hit) n++;
      }
      g.hidden = rows.length ? n === 0 : !titleHit;
      hits += rows.length ? n : (titleHit ? 1 : 0);
    }
    hitsBySlot.set(slot, hits);
  }
  // A sub-page's content shows in place while searching, so its link row is only needed when it matches by itself.
  if (searching) {
    for (const slot of slots.values()) {
      if (!slot.isSub || !hitsBySlot.get(slot)) continue;
      slot.link.classList.add('filtered');
      const g = slot.link.closest('.group');
      if (g && ![...g.querySelectorAll('.row')].some((r) => !r.classList.contains('filtered'))) g.hidden = true;
    }
  }
  let any = false;
  for (const [id, c] of categories) {
    const own = c.slots.reduce((sum, [sid]) => sum + (hitsBySlot.get(slots.get(sid)) || 0), 0);
    const subs = [...slots.values()].filter((s) => s.isSub && s.cat === id).reduce((sum, s) => sum + (hitsBySlot.get(s) || 0), 0);
    const hits = own + subs;
    c.pane.hidden = searching ? hits === 0 : id !== view.cat || Boolean(view.sub);
    any ||= hits > 0;
    c.link.classList.toggle('dim', searching && hits === 0);
    if (!searching && id === view.cat) c.link.setAttribute('aria-current', 'page'); else c.link.removeAttribute('aria-current');
  }
  for (const slot of slots.values()) if (slot.isSub) slot.pane.hidden = searching ? !hitsBySlot.get(slot) : view.sub !== slot.id;
  $('no-results').hidden = !searching || any;
}

function route() {
  let id = location.hash.slice(1);
  let focus = null;
  let focusEl = null;
  if (forceRoute && (!id || id === 'appearance' || id === 'home')) id = forceRoute;
  forceRoute = null;
  const sub = slots.get(id);
  if (sub?.isSub) view = { cat: sub.cat, sub: id };
  else if (categories.has(id)) view = { cat: id, sub: null };
  else if (ALIASES[id]) { view = { cat: ALIASES[id].cat, sub: null }; focus = ALIASES[id].focus; focusEl = ALIASES[id].focusEl; }
  else view = { cat: remembered() || DEFAULT_CATEGORY, sub: null };
  remember(view.cat);
  if (query()) $('search').value = '';
  show();
  const title = view.sub ? slots.get(view.sub).title : categories.get(view.cat).title;
  document.title = tr('settings.docTitle', 'Settings · {section}', { section: title });
  const target = focus && $(`sec-${focus}`);
  if (target) target.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
  // (Its row may still be loading: looked for over the next second.)
  if (focusEl) for (let i = 0, tries = 10; i < tries; i++) setTimeout(() => { const el = document.querySelector(focusEl); if (el && document.activeElement !== el && !el.dataset.routed) { el.dataset.routed = '1'; el.focus(); el.scrollIntoView({ block: 'center' }); } }, i * 100);
}

async function init() {
  if (!S) {
    $('unavailable').hidden = false;
    $('search').disabled = true;
    return;
  }
  st = await S.get();
  window.setI18n?.(await S.strings?.().catch(() => null)); // renderer/i18n.js
  applyPageClasses();
  // The sidebar and the pages, in order. Titles in the system's language; English (above) when a locale lacks one.
  for (const def of CATEGORIES) {
    def.title = tr(`settings.section.${def.id}`, def.title);
    const icon = h('span', { class: `ic ic-${def.id}`, 'aria-hidden': 'true' });
    icon.innerHTML = `<svg viewBox="0 0 16 16">${CATEGORY_ICONS[def.id]}</svg>`; // constant markup
    const link = h('a', { href: `#${def.id}`, 'data-section': def.id }, icon, h('span', { class: 'nav-label', text: def.title }));
    $('nav').append(link);
    const pane = h('div', { class: 'pane', id: `cat-${def.id}`, hidden: true }, h('h1', { class: 'pane-title', text: def.title }));
    categories.set(def.id, { ...def, pane, link });
    $('sections').append(pane);
  }
  for (const def of CATEGORIES) {
    const c = categories.get(def.id);
    for (const [sid, stitle] of def.slots) {
      const slot = new Slot(sid, stitle, def.id);
      slots.set(sid, slot);
      c.pane.append(slot.el);
    }
  }
  // Sub-pages that are whole builders of their own.
  const mount = (parent, id, label, desc, more) => slots.get(parent).subpage(id, label, desc, more);
  mount('ai-more', 'skills', tr('settings.section.skills', 'Skills'), 'Saved prompts you run from the chat with /.', 'prompts commands');
  mount('ai-more', 'usage', 'Usage', 'Your Claude plan’s limits and how much of them Lumen used.', 'plan limits tokens claude grok cost');
  mount('advanced-more', 'task-manager', 'Task manager', 'Every Lumen process, with memory and CPU.', 'processes memory cpu restart tab');
  mount('advanced-more', 'internals', tr('settings.section.internals', 'Internals'), 'Graphics status, devices and browser sessions.', 'gpu graphics session cache cookies user agent');
  const BUILDS = [
    ['ai-model', buildAi], ['skills', buildSkills], ['usage', buildUsage], ['appearance', buildAppearance], ['home', buildHome],
    ['search', buildSearch], ['startup', buildStartup], ['privacy', buildPrivacy], ['downloads', buildDownloads], ['languages', buildLanguages],
    ['accessibility', buildAccessibility], ['system', buildSystem], ['extensions', buildExtensions], ['reset', buildReset], ['about', buildAbout],
    ['internals', buildInternals],
  ];
  await Promise.all(BUILDS.map(async ([sid, build]) => {
    const slot = slots.get(sid);
    try {
      await build(slot);
    } catch (err) {
      slot.append(row(tr('settings.loadFailed', 'Couldn’t load this section'), String(err?.message || err)));
    }
  }));
  refreshRestartNotes();
  $('search').addEventListener('input', show);
  // Ctrl+F or "/" focuses search; Escape clears it.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
      e.preventDefault();
      $('search').focus();
      $('search').select();
    } else if (e.key === 'Escape' && document.activeElement === $('search') && $('search').value) {
      $('search').value = '';
      show();
    }
  });
  window.addEventListener('hashchange', route);
  route();
  document.body.dataset.ready = '1';
}

init();
