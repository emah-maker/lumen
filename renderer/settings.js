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
// A string from the page's table (renderer/i18n.js), or the English given here when it has none.
const tr = (key, english, vars) => {
  const text = window.t ? window.t(key, vars) : key;
  return text === key ? (vars ? english.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : english) : text;
};
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
  { id: 'skills', title: 'Skills', build: buildSkills }, // settings-skills.js
  { id: 'usage', title: 'Usage', build: buildUsage }, // [usage]
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
  const topicRow = row('Use AI to name and group topics', 'Sends only tab titles and site names (like example.com, never full addresses) to the cheapest model of your chat’s provider, or through your own Claude Code or Grok Build when you chat with one (no API key needed). Off: topics are found on this computer.', topicAi);
  topicRow.classList.add('sub-row');
  topicRow.hidden = ai.tabGrouping !== 'topic';
  card.append(
    row('Short, focused answers', 'Answers lead with the next step and stay brief (ADHD mode). Applies to new chats.', adhd),
    row('Group tabs automatically', 'By site: 3 or more tabs from one site. By topic: related tabs, such as recipes or one trip, once 4 or more are loose. Tabs you group or move by hand stay put.', grouping),
    topicRow,
    select('maxSteps', tr('settings.ai.maxSteps', 'Max steps per task'), tr('settings.ai.maxStepsDesc', 'How many steps the assistant may take on one request before it wraps up with an answer. Unlimited still stops if it gets stuck in a loop, and you can always press Stop.'),
      [[0, tr('settings.ai.maxSteps.unlimited', 'Unlimited')], ...[30, 60, 120, 250].map((n) => [n, String(n)])], { number: true }),
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
  card.append(stackRow('Sites where AI is off', 'The AI can’t read, click or type on these sites, their tabs aren’t sent with your messages or to Organize Tabs, and outside agents are refused too. Also in the sidebar and a tab’s right-click menu.', offList,
    h('div', { class: 'controls' }, offInput, h('button', {
      text: 'Turn off AI',
      onclick: async () => { const site = offInput.value.trim(); if (!site) return; offInput.value = ''; renderOff(await S.ai.setAiSite(site, true)); },
    }))));
  renderOff();

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
  card.append(buildMcpServers()); // settings-mcp-servers.js: tools from MCP servers, for the sidebar's AI

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
  card.append(row('Allow automation tools (Chrome DevTools Protocol)', `For Playwright, Playwright MCP and other CDP tools. They see only your tabs, and unlike the AI in the sidebar they don’t ask before acting on a site.${auto.internalPort ? ' While on, other programs on this computer can reach Lumen’s internal debugging port too.' : ''} Takes effect after a restart.`, autoToggle), portRow);

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
  buildLook(card);
}

// ---------- [look] accent color and the new-tab page ----------
const ACCENT_SWATCHES = [['blue', 'Blue'], ['indigo', 'Indigo'], ['purple', 'Purple'], ['pink', 'Pink'], ['red', 'Red'], ['orange', 'Orange'], ['green', 'Green'], ['teal', 'Teal'], ['graphite', 'Graphite']];
const BACKGROUND_CHOICES = [['plain', 'Plain'], ['aurora', 'Aurora'], ['dusk', 'Dusk'], ['ocean', 'Ocean'], ['forest', 'Forest'], ['sunset', 'Sunset'], ['graphite', 'Graphite']];
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
  card.append(stackRow('New tab background', 'Behind the new-tab page. A picture is resized and kept in your Lumen profile; it never leaves this computer.', tiles, picture));
  const name = h('input', { type: 'text', id: 'pref-newTabName', class: 'grow', placeholder: 'Your name', maxlength: '40', 'aria-label': 'Name for the greeting' });
  name.value = st.prefs.newTabName || '';
  name.addEventListener('change', () => save('newTabName', name.value));
  card.append(
    toggle('newTabClock', 'Show a clock on the new-tab page', null),
    row('Greeting', '“Good evening, …” on the new-tab page. Leave it empty for no name.', name),
    toggle('newTabFavorites', 'Show favorites', 'Your bookmarks on the new-tab page.'),
    toggle('newTabFrequent', 'Show frequently visited sites', null),
    toggle('newTabPrivacy', 'Show ads and trackers blocked', null),
  );
  renderSwatches();
  renderTiles();
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

  card.append(
    toggle('blockThirdPartyCookies', 'Block third-party cookies (best effort)', 'Lumen stops sending cookies with requests to other sites embedded in a page. Those sites can still set cookies, and scripts inside their frames can still read them: Electron has no full third-party cookie switch.'),
    toggle('sendDoNotTrack', 'Send a “Do Not Track” request', 'Adds DNT: 1 to every request. Most sites ignore it.'),
    toggle('sendGpc', 'Send Global Privacy Control', 'Adds Sec-GPC: 1 to every request. In some places (e.g. California) sites must honour it as an opt-out of data sale.'),
    toggle('httpsOnly', 'Always use secure connections', 'Upgrades http:// addresses to https:// and warns before loading a site that has no secure version. Local addresses are left alone.'),
  );

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
  card.append(
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
    if (mcp) parts.push(row('Claude Code driving Lumen (MCP)', `Share of this Mac’s Claude Code usage from Lumen’s browser tools: ${mcp}.`));

    const engines = Object.entries(u.lumen.byEngine);
    const list = h('div', { class: 'list', id: 'usage-engines' }, engines.length
      ? engines.map(([id, e]) => h('div', { class: 'item' },
        h('span', { class: 'grow', text: ENGINE_NAMES[id] || id }),
        h('span', { class: 'note', text: `${e.turns} turn${e.turns === 1 ? '' : 's'} · ${tokens(e.tokens)} tokens${e.costUSD ? ` · ${dollars(e.costUSD)} at API prices` : ''}` })))
      : [h('span', { class: 'note', text: 'Nothing yet.' })]);
    parts.push(stackRow('Lumen, last 7 days', 'Plans don’t bill per token; the API-price figure is only a yardstick for how heavy the use was.', list));
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
  await buildUpdates(card); // renderer/settings-updates.js

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
  applyPageAccent(); // [look]
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (st) applyPageAccent(); });

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
  document.title = tr('settings.docTitle', 'Settings · {section}', { section: sections.get(current).title });
  window.scrollTo(0, 0);
}

async function init() {
  if (!S) {
    $('unavailable').hidden = false;
    $('search').disabled = true;
    return;
  }
  st = await S.get();
  window.setI18n?.(await S.strings?.().catch(() => null)); // renderer/i18n.js
  // Section titles in the system's language; English (above) when a locale lacks one.
  for (const def of SECTIONS) def.title = tr(`settings.section.${def.id}`, def.title);
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
      sections.get(def.id).card.append(row(tr('settings.loadFailed', 'Couldn’t load this section'), String(err?.message || err)));
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
