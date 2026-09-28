// lumen://settings: a left nav, search, and one section per page (#section in the URL).
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
const sections = new Map(); // id -> { title, el, card, build }

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
const flash = (el, text, cls = 'ok') => { el.textContent = text; el.className = `note ${cls}`; };
const langName = (() => {
  let names;
  try { names = new Intl.DisplayNames([navigator.language], { type: 'language' }); } catch {}
  return (tag) => { try { return names?.of(tag) || tag; } catch { return tag; } };
})();
const bytes = (n) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------- sections ----------

const SECTIONS = [
  { id: 'you-and-ai', title: 'You and AI', build: buildAi },
  { id: 'appearance', title: 'Appearance', build: buildAppearance },
  { id: 'search', title: 'Search engine', build: buildSearch },
  { id: 'startup', title: 'On startup', build: buildStartup },
  { id: 'privacy', title: 'Privacy and security', build: buildPrivacy },
  { id: 'downloads', title: 'Downloads', build: buildDownloads },
  { id: 'languages', title: 'Languages', build: buildLanguages },
  { id: 'accessibility', title: 'Accessibility', build: buildAccessibility },
  { id: 'system', title: 'System', build: buildSystem },
  { id: 'extensions', title: 'Extensions', build: buildExtensions },
  { id: 'reset', title: 'Reset settings', build: buildReset },
  { id: 'about', title: 'About Lumen', build: buildAbout },
  { id: 'internals', title: 'Internals', build: buildInternals },
];

async function buildAi(card) {
  let ai = await S.ai.get();
  // Rebuilt whenever the connected models change (a key added or removed, a sign-in), not just once.
  const modelOptions = () => [...new Set(ai.models.map((m) => m.group))].map((g) => h('optgroup', { label: g },
    ai.models.filter((m) => m.group === g && !m.id.endsWith(':__more')).map((m) => h('option', { value: m.id, text: m.label, title: m.detail || '', selected: m.id === ai.model }))));
  card.append(
    row('Model', 'The model the assistant in the sidebar uses.', h('select', {
      id: 'ai-model',
      'aria-label': 'Model',
      onchange: async (e) => { if (!(await S.ai.setModel(e.target.value).catch(() => false))) await refreshModels(); },
    }, modelOptions())),
  );
  const modelPicker = card.querySelector('#ai-model');
  modelPicker.parentElement.classList.add('picker-host');
  window.lumenPicker(modelPicker, { label: (o) => (o.parentElement.label ? `${o.parentElement.label} · ${o.textContent}` : o.textContent) });
  const refreshModels = async () => {
    ai = await S.ai.get();
    modelPicker.replaceChildren(...modelOptions());
    if (ai.model) modelPicker.value = ai.model;
    modelPicker.pickerSync?.();
  };
  const adhd = h('input', { type: 'checkbox', class: 'switch', id: 'ai-adhd', role: 'switch', 'aria-label': 'Short, focused answers', checked: ai.adhdMode, onchange: (e) => S.ai.setAdhdMode(e.target.checked) });
  const grouping = h('select', { id: 'ai-grouping', 'aria-label': 'Group tabs automatically', onchange: (e) => { S.ai.setTabGrouping(e.target.value); topicRow.hidden = e.target.value !== 'topic'; } },
    [['off', 'Off'], ['site', 'By site'], ['topic', 'By topic']].map(([value, text]) => h('option', { value, text, selected: ai.tabGrouping === value })));
  const topicAi = h('input', { type: 'checkbox', class: 'switch', id: 'ai-topic-ai', role: 'switch', 'aria-label': 'Use AI to name and group topics', checked: ai.topicAi, onchange: (e) => S.ai.setTopicAi(e.target.checked) });
  const topicRow = row('Use AI to name and group topics', 'Sends only tab titles and site names (like example.com, never full addresses) to the cheapest model of your chat’s provider. Off: topics are found on this computer.', topicAi);
  topicRow.classList.add('sub-row');
  topicRow.hidden = ai.tabGrouping !== 'topic';
  card.append(
    row('Short, focused answers', 'Answers lead with the next step and stay brief (ADHD mode). Applies to new chats.', adhd),
    row('Group tabs automatically', 'By site: 3 or more tabs from one site. By topic: related tabs, such as recipes or one trip, once 4 or more are loose. Tabs you group or move by hand stay put.', grouping),
    topicRow,
  );

  // API keys: one line per provider; Edit opens the field in place.
  const keys = h('div', { class: 'list', id: 'ai-keys' });
  const renderKeys = () => {
    const entries = [['anthropic', { label: 'Anthropic (Claude)', stored: ai.hasStoredKey, env: ai.hasEnvKey }], ...Object.entries(ai.providerKeys)];
    keys.replaceChildren(...entries.map(([provider, info]) => {
      const line = h('div', { class: 'item key', 'data-provider': provider });
      const state = info.stored ? 'Saved' : info.env ? 'From environment' : 'Not set';
      const view = () => line.replaceChildren(...[
        h('span', { class: 'grow', text: info.label }),
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
            if (!r.ok && !r.cancelled) alert(r.message);
          },
        }) : null,
      ].filter(Boolean));
      const edit = () => {
        const input = h('input', { type: 'password', class: 'grow', autocomplete: 'off', placeholder: `${info.label} API key`, 'aria-label': `${info.label} API key` });
        const note = status();
        const put = async (value) => {
          try {
            flash(note, value ? 'Checking the key…' : '', '');
            const r = provider === 'anthropic' ? await S.ai.setKey(value) : await S.ai.setProviderKey(provider, value);
            await refreshModels();
            renderKeys();
            if (r?.unverified) alert(`Saved. ${info.label} couldn't be reached to check the key, so it will be checked on your first message.`);
          } catch (err) { flash(note, String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); }
        };
        const saveKey = () => { if (input.value.trim()) put(input.value.trim()); else input.focus(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); else if (e.key === 'Escape') view(); });
        line.replaceChildren(...[
          h('span', { class: 'key-name', text: info.label }), input,
          h('button', { text: 'Save', onclick: saveKey }),
          info.stored ? h('button', { class: 'danger', text: 'Remove', onclick: () => put('') }) : null,
          h('button', { class: 'plain', text: 'Cancel', onclick: view }),
          note,
        ].filter(Boolean));
        input.focus();
      };
      view();
      return line;
    }));
  };
  renderKeys();
  card.append(stackRow('API keys', 'Encrypted with your OS keychain. Anthropic’s key runs the agent (clicking and typing for you); the others add their models to the picker.', keys));

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
  const cliRow = row('Sign in with your Anthropic account', 'Uses an OAuth profile from the Anthropic CLI instead of an API key.', cliButtons);
  cliRow.querySelector('.text').append(cliNote);
  card.append(cliRow);
  S.ai.cliStatus().then(renderCli).catch(() => {});

  // AI agents over MCP, and automation tools over CDP
  const mcp = await S.ai.mcpInfo();
  const mcpToggle = h('input', { type: 'checkbox', class: 'switch', id: 'ai-mcp', role: 'switch', 'aria-label': 'Allow AI agents to connect', checked: mcp.enabled, onchange: (e) => S.ai.setMcpEnabled(e.target.checked) });
  card.append(row('Allow AI agents to connect', 'Off by default. When on, Claude Code, Codex, Gemini CLI and other MCP clients on this computer can drive Lumen. They still need your OK for each new site. The Add buttons below turn this on.', mcpToggle));
  const snippets = h('div', { class: 'list', id: 'ai-snippets' }, mcp.snippets.map((snip) => {
    const copy = h('button', { text: 'Copy', onclick: async () => { await navigator.clipboard.writeText(snip.text).catch(() => {}); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1400); } });
    const note = status();
    // snip.addButton is the agent id ('claude' | 'codex' | 'grok' | 'gemini'); 'json' (other clients) has none.
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
  card.append(stackRow('Connect an AI agent', 'Add Lumen to an agent’s MCP settings.', snippets));

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
  card.append(row('Allow automation tools (Chrome DevTools Protocol)', 'For Playwright, Playwright MCP and other CDP tools. They see only your tabs, and unlike the AI in the sidebar they don’t ask before acting on a site. While on, other programs on this computer can reach Lumen’s internal debugging port too. Takes effect after a restart.', autoToggle), portRow);

  // Import
  const importRow = h('div', { class: 'controls', id: 'ai-import' });
  card.append(row('Import bookmarks and history', 'From another browser on this computer. Passwords and cookies are not imported.', importRow));
  S.ai.importBrowsers().then((found) => {
    importRow.replaceChildren(...(found.length ? found.map((b) => h('button', {
      text: b.label,
      onclick: async (e) => { e.target.disabled = true; await S.ai.importFrom(b.id); e.target.disabled = false; },
    })) : [h('span', { class: 'note', text: 'No other browsers found.' })]));
  }).catch(() => {});
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
  card.append(
    select('theme', 'Theme', 'Lumen and the websites you visit follow this (websites see it as prefers-color-scheme). Open Google results reload to match.', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]),
    withRelaunch(toggle('forceDarkWebsites', 'Dark mode for all websites (experimental)', 'Chromium darkens sites that have no dark theme of their own. Takes effect after a relaunch.'), 'forceDarkWebsites'),
    select('defaultZoom', 'Page zoom', 'The default for every site. Sites you zoom by hand keep their own level.', st.zooms.map((z) => [z, `${Math.round(z * 100)}%`]), { number: true }),
    select('fontSize', 'Font size', 'The default text size websites start from. Applies to new tabs.', st.fontSizes.map((s) => [s, { 9: 'Very small', 12: 'Small', 16: 'Medium (recommended)', 20: 'Large', 24: 'Very large' }[s]]), { number: true }),
    toggle('showBookmarkButton', 'Show bookmark button', 'The star in the address bar. Ctrl+D bookmarks either way.'),
    toggle('compactTabs', 'Compact tabs', 'Shorter tabs in the tab strip.'),
  );
}

async function buildSearch(card) {
  const ai = await S.ai.get();
  const el = h('select', { id: 'pref-searchEngine', 'aria-label': 'Search engine', onchange: (e) => S.ai.setSearchEngine(e.target.value) },
    ai.searchEngines.map((e) => h('option', { value: e.id, text: e.label, selected: e.id === ai.searchEngine })));
  card.append(row('Search engine used in the address bar', 'Also used by the new-tab page and “Search for…” in the context menu.', el));
}

function buildStartup(card) {
  const list = h('div', { class: 'list', id: 'startup-pages' });
  const input = h('input', { type: 'url', class: 'grow', id: 'startup-add', placeholder: 'https://example.com' });
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
  card.append(stackRow('Clear browsing data', 'History follows the time range. Cookies, site data and the cache are cleared for all time: Electron can only remove them all at once.',
    h('div', { class: 'controls start' }, h('span', { class: 'note', text: 'Time range' }), range),
    box('clear-history', 'Browsing history', true), box('clear-cookies', 'Cookies and other site data', false),
    box('clear-cache', 'Cached images and files', true), box('clear-downloads', 'Download list', false),
    h('div', { class: 'controls' }, result, h('button', {
      class: 'primary', id: 'clear-go', text: 'Clear data',
      onclick: async () => {
        const done = await S.clearData({ range: range.value, history: $('clear-history').checked, cookies: $('clear-cookies').checked, cache: $('clear-cache').checked, downloads: $('clear-downloads').checked });
        const parts = [];
        if (done.history !== undefined) parts.push(`${done.history} history entr${done.history === 1 ? 'y' : 'ies'}`);
        if (done.cookies) parts.push('cookies and site data');
        if (done.cache) parts.push('cache');
        if (done.downloads !== undefined) parts.push(`${done.downloads} download${done.downloads === 1 ? '' : 's'}`);
        flash(result, parts.length ? `Cleared ${parts.join(', ')}.` : 'Nothing selected.');
      },
    }))));

  card.append(
    toggle('blockThirdPartyCookies', 'Block third-party cookies (best effort)', 'Lumen stops sending cookies with requests to other sites embedded in a page. Those sites can still set cookies, and scripts inside their frames can still read them: Electron has no full third-party cookie switch.'),
    toggle('sendDoNotTrack', 'Send a “Do Not Track” request', 'Adds DNT: 1 to every request. Most sites ignore it.'),
    toggle('sendGpc', 'Send Global Privacy Control', 'Adds Sec-GPC: 1 to every request. In some places (e.g. California) sites must honour it as an opt-out of data sale.'),
    toggle('httpsOnly', 'Always use secure connections', 'Upgrades http:// addresses to https:// and warns before loading a site that has no secure version. Local addresses are left alone.'),
  );

  // Ad blocker
  const allowList = h('div', { class: 'list', id: 'adblock-allow' });
  const allowInput = h('input', { type: 'text', class: 'grow', id: 'adblock-add', placeholder: 'example.com' });
  const renderAllow = () => allowList.replaceChildren(...(st.prefs.adblockAllow.length ? st.prefs.adblockAllow.map((host) => h('div', { class: 'item' },
    h('span', { class: 'grow', text: host }),
    h('button', { text: 'Remove', onclick: async () => { await save('adblockAllow', st.prefs.adblockAllow.filter((x) => x !== host)); renderAllow(); } })))
    : [h('span', { class: 'note', text: 'No sites. Ads are blocked everywhere.' })]));
  renderAllow();
  card.append(
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
  card.append(stackRow('Default for new sites', 'Ask shows a prompt the first time a site asks; Block refuses without asking.', defaults));
  card.append(stackRow('Site permissions', 'What you allowed or blocked. Revoke to be asked again.', granted));
  renderGranted();
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
      : [h('span', { class: 'note', text: 'No downloads this session.' })]));
  };
  card.append(stackRow('Downloads this session', null, list, h('div', { class: 'controls' },
    h('button', { id: 'downloads-clear', text: 'Clear list', onclick: async () => { await S.clearDownloads(); render(); } }))));
  render();
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
  card.append(toggle('tabSleep', 'Put unused tabs to sleep', 'Frees up memory from background tabs left untouched for a while; switching back reloads them.'));
  if (st.platform === 'darwin') {
    card.append(toggle('keepRunningInBackground', 'Keep Lumen running when its window is closed', 'Lumen stays in the Dock; click it to open a window.'));
  }

  // Proxy
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
  const a = await S.about();
  const versions = h('table', { id: 'about-versions' },
    h('tr', {}, h('th', { text: 'Component' }), h('th', { text: 'Version' })),
    [['Lumen', a.version], ['Electron', a.versions.electron], ['Chromium', a.versions.chrome], ['Node.js', a.versions.node], ['V8', a.versions.v8], ['Anthropic CLI (pinned)', a.cliPinned], ['OS', a.os]]
      .map(([k, v]) => h('tr', { 'data-component': k }, h('td', { text: k }), h('td', { class: 'mono', text: v }))));
  card.append(stackRow('Lumen', 'An AI browser.', versions));
  card.append(stackRow('Build', null, h('table', {},
    [['App', a.appPath], ['Executable', a.exePath], ['Profile', a.userData], ['Packaged', a.packaged ? 'Yes' : 'No (development)']]
      .map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: 'mono', text: v }))))));
  card.append(row('Updates', 'New versions are published on GitHub.', h('button', { text: 'Check for updates', onclick: () => S.openUrl(a.updatesUrl) })));

  // Task manager
  const table = h('table', { id: 'task-manager' });
  const render = async () => {
    const procs = await S.taskManager();
    table.replaceChildren(h('tr', {}, h('th', { text: 'Process' }), h('th', { class: 'num', text: 'Memory' }), h('th', { class: 'num', text: 'CPU' }), h('th', { class: 'num', text: 'PID' }), h('th', {})),
      ...procs.map((p) => h('tr', {},
        h('td', { text: p.name }), h('td', { class: 'num', text: bytes(p.memoryKB * 1024) }), h('td', { class: 'num', text: `${p.cpu}%` }), h('td', { class: 'num', text: p.pid }),
        h('td', {}, p.tabIds.length === 1 ? h('button', { text: 'Restart', title: 'End this tab’s process and reload it', onclick: async () => { await S.restartTab(p.tabIds[0]); setTimeout(render, 800); } }) : null))));
  };
  card.append(stackRow('Task manager', 'Every Lumen process, with memory (working set) and CPU.', table));
  await render();
  const timer = setInterval(() => { if (current === 'about' && !document.hidden && !query()) render(); }, 2000);
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
  document.documentElement.classList.toggle('reduce-motion', Boolean(st.prefs.reduceMotion));
}

// ---------- navigation and search ----------

let current = 'you-and-ai';
const query = () => $('search').value.trim().toLowerCase();

function show() {
  const q = query();
  const words = q.split(/\s+/).filter(Boolean);
  let any = false;
  for (const [id, s] of sections) {
    if (!words.length) {
      s.el.hidden = id !== current;
      for (const r of s.card.querySelectorAll('.row')) r.hidden = false;
      continue;
    }
    const titleHit = words.every((w) => s.title.toLowerCase().includes(w));
    let hits = 0;
    for (const r of s.card.querySelectorAll('.row')) {
      const hit = titleHit || words.every((w) => r.dataset.search.includes(w));
      r.hidden = !hit;
      if (hit) hits++;
    }
    s.el.hidden = hits === 0;
    any ||= hits > 0;
  }
  $('no-results').hidden = !words.length || any;
  for (const a of $('nav').querySelectorAll('a')) {
    const s = sections.get(a.dataset.section);
    a.toggleAttribute('aria-current', !words.length && a.dataset.section === current);
    if (!words.length && a.dataset.section === current) a.setAttribute('aria-current', 'page');
    a.classList.toggle('dim', Boolean(words.length) && s.el.hidden);
  }
}

function route() {
  const id = location.hash.slice(1);
  current = sections.has(id) ? id : 'you-and-ai';
  if (query()) $('search').value = '';
  show();
  document.title = `Settings · ${sections.get(current).title}`;
  window.scrollTo(0, 0);
}

async function init() {
  if (!S) {
    $('unavailable').hidden = false;
    $('search').disabled = true;
    return;
  }
  st = await S.get();
  applyPageClasses();
  for (const def of SECTIONS) {
    const card = h('div', { class: 'card' });
    const el = h('section', { id: `sec-${def.id}`, hidden: true }, h('h2', { text: def.title }), card);
    sections.set(def.id, { ...def, el, card });
    $('sections').append(el);
    $('nav').append(h('a', { href: `#${def.id}`, 'data-section': def.id, text: def.title }));
  }
  await Promise.all(SECTIONS.map(async (def) => {
    try {
      await def.build(sections.get(def.id).card);
    } catch (err) {
      sections.get(def.id).card.append(row('Couldn’t load this section', String(err?.message || err)));
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
