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
  const idleOrganize = h('input', { type: 'checkbox', class: 'switch', id: 'ai-organize-idle', role: 'switch', 'aria-label': 'Organize tabs automatically when idle', checked: ai.organizeWhenIdle, onchange: (e) => S.ai.setOrganizeIdle(e.target.checked) });
  const idleRow = row('Organize tabs automatically when idle', 'After about 10 idle minutes, with 8 or more ungrouped tabs, Lumen groups them on this computer (never with AI) and offers Undo. Off by default.', idleOrganize);
  const forgetBtn = h('button', { id: 'ai-forget-organize', text: 'Forget organize learning', onclick: async () => { await S.ai.forgetOrganizeLearning(); forgetBtn.textContent = 'Forgotten'; setTimeout(() => { forgetBtn.textContent = 'Forget organize learning'; }, 2000); } });
  const forgetRow = row('What Organize learned', 'When you drag a tab into or out of a group, or rename a group, Lumen remembers which sites and words go with which group name, on this computer only, so the next Organize prefers them.', forgetBtn);
  card.append(
    row('Short, focused answers', 'Answers lead with the next step and stay brief (ADHD mode). Applies to new chats.', adhd),
    row('Group tabs automatically', 'By site: 3 or more tabs from one site. By topic: related tabs, such as recipes or one trip, once 4 or more are loose. Tabs you group or move by hand stay put.', grouping),
    topicRow,
    idleRow,
    forgetRow,
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
  const effectOptions = buildEffectOptions();
  card.append(select('newTabEffect', 'Animated effect', 'Moving particles over the background. Light on purpose: few particles, at most 30 frames a second, paused while the tab is hidden, and still with Reduce motion. It never covers the search box or the cards.',
    [['none', 'None'], ['particles', 'Particles'], ['stars', 'Stars'], ['bubbles', 'Bubbles'], ['snow', 'Snow']], { after: (v) => { effectOptions.hidden = v === 'none'; } }), effectOptions);
  effectOptions.hidden = st.prefs.newTabEffect === 'none';
  const name = h('input', { type: 'text', id: 'pref-newTabName', class: 'grow', placeholder: 'Your name', maxlength: '40', 'aria-label': 'Name for the greeting' });
  name.value = st.prefs.newTabName || '';
  name.addEventListener('change', () => save('newTabName', name.value));
  card.append(
    toggle('newTabClock', 'Show a clock on the new-tab page', null),
    toggle('newTabHeader', 'Show the date and greeting', 'Turn off to hide the date and “Good evening” line. In Edit layout on the new-tab page, the ✕ on a section does the same.'),
    row('Greeting', '“Good evening, …” on the new-tab page. Leave it empty for no name.', name),
    toggle('newTabFavorites', 'Show favorites', 'Your bookmarks on the new-tab page.'),
    toggle('newTabFrequent', 'Show frequently visited sites', null),
    toggle('newTabPrivacy', 'Show ads and trackers blocked', null),
    toggle('newTabWidgetsPacked', 'Keep widgets packed', 'Cards slide up into gaps, so the new-tab page stays tidy as you move and resize them. Off: leave gaps wherever you put a card.'),
  );
  renderSwatches();
  renderTiles();
  buildWidgets(card).catch((err) => card.append(row('Widgets', String(err?.message || err))));
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
  embed: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="11" rx="2.2"/><path d="M1.8 5.8h12.4M4 4.2h.01M5.6 4.2h.01"/></svg>',
};
const WIDGET_HEIGHTS = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['tall', 'Tall']];
const WIDGET_SPANS = [['2', 'A third'], ['3', 'Half'], ['4', 'Two thirds'], ['6', 'Full width']];
const WIDGET_COLORS = [['calendar', 'Default'], ['match', 'Match screen'], ['accent', 'Accent only'], ['mono', 'Monochrome']];
const TODO_SOURCES = [['todayOverdue', 'Today and overdue'], ['today', 'Today'], ['upcoming', 'Upcoming (next days)'], ['inbox', 'Inbox'], ['project', 'A project'], ['label', 'A label'], ['all', 'All tasks'], ['custom', 'A Todoist filter']];
const TODO_FIELDS = [['due', 'Due date and time'], ['project', 'Project name and colour'], ['labels', 'Labels'], ['priority', 'Priority colour'], ['description', 'Description'], ['subtasks', 'Subtask count'], ['recurring', 'Repeat icon']];
function widgetIcon(type) {
  const span = h('span', { class: `widget-icon wi-${type}` });
  span.innerHTML = WIDGET_ICONS[type] || ''; // constant markup
  return span;
}
async function buildWidgets(card) {
  let ws = await S.widgets.state();
  const list = h('div', { class: 'list widget-list', id: 'widget-list' });
  const formHost = h('div', { class: 'widget-form-host' });
  const add = h('button', { class: 'primary', id: 'widget-add', text: 'Add widget…', onclick: () => openForm() });
  const renderList = () => {
    add.hidden = ws.widgets.length >= ws.max || Boolean(formHost.firstChild);
    if (!ws.widgets.length) { list.replaceChildren(h('p', { class: 'note widget-empty', text: 'No widgets yet. Add the weather, your calendar, your Todoist tasks, what is playing on Spotify, your Gmail inbox, Slack, your GitHub reviews, or any web page.' })); return; }
    list.replaceChildren(...ws.widgets.map((w, i) => h('div', { class: 'item widget-item', 'data-id': w.id, 'data-type': w.type },
      widgetIcon(w.type),
      h('div', { class: 'grow widget-text' }, h('span', { class: 'widget-title', text: w.title }), h('span', { class: 'note', text: `${w.label} · ${w.summary}` })),
      h('div', { class: 'widget-actions' },
        h('button', { class: 'plain icon', text: '↑', 'aria-label': `Move ${w.title} up`, title: 'Move up', disabled: i === 0, onclick: async () => { ws = await S.widgets.move(w.id, -1); renderList(); } }),
        h('button', { class: 'plain icon', text: '↓', 'aria-label': `Move ${w.title} down`, title: 'Move down', disabled: i === ws.widgets.length - 1, onclick: async () => { ws = await S.widgets.move(w.id, 1); renderList(); } }),
        h('button', { text: 'Edit', 'aria-label': `Edit ${w.title}`, onclick: () => openForm(w) }),
        h('button', { class: 'danger', text: 'Remove', 'aria-label': `Remove ${w.title}`, onclick: async () => { ws = await S.widgets.remove(w.id); closeForm(); } }),
      ))));
  };
  const closeForm = () => { formHost.replaceChildren(); renderList(); };
  const sel = (id, label, options, value) => {
    const s = h('select', { id, 'aria-label': label }, options.map(([v, t]) => h('option', { value: String(v), text: t })));
    s.value = String(value);
    return s;
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
    const field = (label, control, hint) => h('label', { class: 'widget-field' }, h('span', { class: 'label', text: label }), control, hint ? h('span', { class: 'note', text: hint }) : null);
    const plain = (label, control, hint) => h('div', { class: 'widget-field' }, h('span', { class: 'label', text: label }), control, hint ? h('span', { class: 'note', text: hint }) : null);
    let places = (existing?.type === 'weather' && existing.wx?.places ? existing.wx.places : []).map((p) => ({ ...p }));
    let projects = [];
    let clockPlaces = (existing?.type === 'worldclock' && existing.wc?.places ? existing.wc.places : []).map((p) => ({ ...p }));
    const colors = sel('widget-colors', 'Colors', WIDGET_COLORS, existing?.colors || 'calendar');

    // ---- weather: places, units, sections ----
    function weatherFields(same) {
      const wx = same?.wx || {};
      const placesBox = h('div', { class: 'wx-edit-places', id: 'widget-places' });
      const results = h('div', { class: 'wx-edit-results', id: 'widget-results' });
      const drawPlaces = () => {
        placesBox.replaceChildren(...places.map((p, i) => h('div', { class: 'item wx-edit-place' },
          h('span', { class: 'grow', text: p.here ? `My location${p.name && p.name !== 'My location' ? ` (${p.name})` : ''}` : p.name }),
          h('input', { type: 'text', class: 'wx-nick', maxlength: '30', placeholder: 'Nickname', 'aria-label': `Nickname for ${p.name}`, value: p.nick || '', onchange: (e) => { places[i] = { ...places[i], nick: e.target.value.trim() || undefined }; } }),
          h('button', { class: 'plain icon', text: '↑', 'aria-label': `Move ${p.name} up`, disabled: i === 0, onclick: () => { [places[i - 1], places[i]] = [places[i], places[i - 1]]; drawPlaces(); } }),
          h('button', { class: 'plain icon', text: '↓', 'aria-label': `Move ${p.name} down`, disabled: i === places.length - 1, onclick: () => { [places[i + 1], places[i]] = [places[i], places[i + 1]]; drawPlaces(); } }),
          h('button', { class: 'danger', text: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: () => { places.splice(i, 1); drawPlaces(); } }))));
        if (!places.length) placesBox.append(h('p', { class: 'note', text: 'No places yet: search below, or add My location.' }));
        const saved = (ws.savedPlaces || []).filter((s) => !places.some((p) => !p.here && Math.abs(p.lat - s.lat) < 0.01 && Math.abs(p.lon - s.lon) < 0.01));
        results.replaceChildren(...saved.map((s) => h('button', { class: 'plain', text: `+ ${s.nick || s.name}`, title: 'A place you saved', onclick: () => { if (places.length < 6) { places.push({ ...s }); drawPlaces(); } } })));
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
      const here = h('button', { id: 'widget-here', text: 'Add My location', onclick: () => { if (places.length < 6 && !places.some((p) => p.here)) places.push({ here: true, name: 'My location' }); drawPlaces(); } });
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
      inputs.units = sel('widget-units', 'Temperature units', [['f', '°F (Fahrenheit)'], ['c', '°C (Celsius)']], same?.units || wx.units || (/^en-US$/i.test(navigator.language) ? 'f' : 'c'));
      inputs.wind = sel('widget-wind', 'Wind speed units', [['auto', 'Automatic'], ['mph', 'mph'], ['kmh', 'km/h'], ['ms', 'm/s']], wx.wind || 'auto');
      inputs.clock = sel('widget-clock', 'Clock', [['auto', 'System'], ['12', '12-hour'], ['24', '24-hour']], wx.clock || 'auto');
      inputs.days = sel('widget-days', 'Days in the forecast', [[7, '7 days'], [10, '10 days']], wx.days || 7);
      inputs.hours = sel('widget-hours', 'Hours in the strip', [[12, '12 hours'], [24, '24 hours']], wx.hours || 12);
      inputs.view = sel('widget-view', 'Several places', [['auto', 'Automatic'], ['cycle', 'One at a time'], ['list', 'A list']], wx.view || 'auto');
      const show = wx.show || {};
      inputs.show = { now: chk('widget-show-now', 'Now', show.now !== false), hourly: chk('widget-show-hourly', 'Hourly strip', show.hourly !== false), daily: chk('widget-show-daily', 'By day', show.daily !== false), details: chk('widget-show-details', 'Details (wind, humidity, UV, sun)', show.details !== false) };
      drawPlaces();
      fields.replaceChildren(
        plain('Places', h('div', null, placesBox, h('div', { class: 'widget-inline' }, inputs.city, h('button', { id: 'widget-search', text: 'Search', onclick: search }), here), found, results), 'Forecasts from Open-Meteo (free, no account). Only the place goes to it. Add several: a card can step through them or list them.'),
        plain('My location', h('div', { class: 'widget-inline' }, consentNote, consent)),
        field('Units', inputs.units), field('Wind', inputs.wind), field('Clock', inputs.clock), field('Forecast', inputs.days), field('Hours', inputs.hours), field('Several places', inputs.view),
        plain('Show', h('div', { class: 'widget-checks' }, Object.values(inputs.show)), 'The card also shows more or less depending on its size.'),
        field('Colors', colors, '“Match screen” tints the card from your accent color and background.'));
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
      inputs.clock = sel('widget-clock', 'Clock', [['auto', 'System'], ['12', '12-hour'], ['24', '24-hour']], wc.clock || 'auto');
      const show = wc.show || {};
      inputs.seconds = chk('widget-show-seconds', tr('widgets.worldclock.seconds', 'Seconds'), wc.seconds === true);
      inputs.show = { date: chk('widget-show-date', tr('widgets.worldclock.date', 'Date'), show.date !== false), offset: chk('widget-show-offset', tr('widgets.worldclock.offset', 'Hours ahead or behind you'), show.offset !== false), sun: chk('widget-show-sun', tr('widgets.worldclock.sun', 'Sunrise and sunset'), show.sun !== false) };
      drawPlaces();
      fields.replaceChildren(
        plain(tr('widgets.worldclock.places', 'Places'), h('div', null, placesBox, h('div', { class: 'widget-inline' }, inputs.city, h('button', { id: 'widget-search', text: 'Search', onclick: search })), found), tr('widgets.worldclock.hint', 'Sunrise and sunset come from Open-Meteo (free, no account); only the place goes to it. The time itself is worked out on the page and needs no network.')),
        field('Clock', inputs.clock),
        plain(tr('widgets.worldclock.show', 'Show'), h('div', { class: 'widget-checks' }, [inputs.seconds, ...Object.values(inputs.show)])),
        field('Colors', colors, '“Match screen” tints the card from your accent color and background.'));
    }
    // ---- todoist: what to show ----
    function todoFields(same) {
      const t = same?.todo || {};
      const f = t.fields || {};
      inputs.token = h('input', { type: 'password', id: 'widget-token', autocomplete: 'off', spellcheck: 'false', placeholder: ws.secrets.todoist ? 'Saved. Paste a new token to replace it.' : 'Paste your API token', 'aria-label': 'Todoist API token' });
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
          flash(note, `${projects.length} projects.`, 'ok');
        } catch (err) { flash(note, String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); }
      } });
      const which = h('div', { class: 'widget-inline' }, inputs.source, inputs.days, inputs.project, load, inputs.label, inputs.query);
      const syncSource = () => {
        const v = inputs.source.value;
        inputs.days.hidden = v !== 'upcoming';
        inputs.project.hidden = load.hidden = v !== 'project';
        inputs.label.hidden = v !== 'label';
        inputs.query.hidden = v !== 'custom';
      };
      inputs.source.addEventListener('change', syncSource);
      syncSource();
      inputs.group = sel('widget-group', 'Group by', [['none', 'No grouping'], ['project', 'Project'], ['due', 'Due date'], ['priority', 'Priority'], ['label', 'Label']], t.group || 'none');
      inputs.sort = sel('widget-sort', 'Sort by', [['due', 'Due date'], ['priority', 'Priority'], ['project', 'Project'], ['manual', 'Todoist’s own order'], ['created', 'Date added']], t.sort || 'due');
      inputs.density = sel('widget-density', 'Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], t.density || 'comfortable');
      inputs.max = sel('widget-max', 'Tasks shown', [[5, '5'], [10, '10'], [20, '20'], [50, '50'], [0, 'All (scrolls)']], t.max ?? 10);
      inputs.fields = Object.fromEntries(TODO_FIELDS.map(([k, label]) => [k, chk(`widget-field-${k}`, label, f[k] ?? ({ due: true, priority: true, recurring: true }[k] || false))]));
      inputs.showDone = chk('widget-showdone', 'Show tasks completed today', t.showDone);
      inputs.overdueRed = chk('widget-overdue', 'Show overdue in red', t.overdueRed !== false);
      inputs.showCount = chk('widget-showcount', 'Show the task count in the title', t.showCount);
      inputs.quick = sel('widget-quick', 'Add-task field', [['off', 'Off'], ['top', 'At the top'], ['bottom', 'At the bottom']], t.quick || 'off');
      inputs.quickProject = sel('widget-quickproject', 'New tasks go to', [['', 'Inbox (Todoist’s default)'], ...(t.quickProjectId ? [[t.quickProjectId, 'The chosen project']] : [])], t.quickProjectId || '');
      fields.replaceChildren(
        field('API token', inputs.token, 'In Todoist: Settings → Integrations → Developer. Stored encrypted by your system; it never reaches the new-tab page.'),
        plain('Which tasks', which, 'A Todoist filter is Todoist’s own query language, like “today & p1”.'),
        field('Group', inputs.group), field('Sort', inputs.sort), field('Density', inputs.density), field('Tasks shown', inputs.max),
        plain('Show on each task', h('div', { class: 'widget-checks' }, Object.values(inputs.fields))),
        plain('Also', h('div', { class: 'widget-checks' }, inputs.showDone, inputs.overdueRed, inputs.showCount)),
        field('Add-task field', inputs.quick, 'Typed like in Todoist’s quick add: “Pay rent tomorrow 9am”.'), field('New tasks go to', inputs.quickProject, 'Load projects above to pick one.'),
        field('Colors', colors, 'Only the card’s surface and title follow it; priority colors stay.'));
    }
    // ---- spotify: the user's own Client ID, then Connect (OAuth PKCE in a tab; the token stays in the browser) ----
    function spotifyFields(same) {
      inputs.clientId = h('input', { type: 'text', id: 'widget-clientid', autocomplete: 'off', spellcheck: 'false', maxlength: '64', placeholder: '32-character Client ID', value: same?.clientId || '', 'aria-label': 'Spotify Client ID' });
      inputs.art = chk('widget-spotify-art', 'Show the album art', same ? same.art !== false : true);
      const status = h('span', { class: 'note', role: 'status', id: 'widget-spotify-status' });
      const connect = h('button', { id: 'widget-spotify-connect', text: ws.secrets.spotify ? 'Reconnect' : 'Connect Spotify' });
      const disconnect = h('button', { id: 'widget-spotify-disconnect', class: 'danger', text: 'Disconnect', hidden: !ws.secrets.spotify });
      const drawStatus = () => {
        status.textContent = ws.secrets.spotify ? 'Connected. Lumen holds an encrypted sign-in; it never reaches the new-tab page.' : 'Not connected yet.';
        connect.textContent = ws.secrets.spotify ? 'Reconnect' : 'Connect Spotify';
        disconnect.hidden = !ws.secrets.spotify;
      };
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        flash(note, 'Waiting for Spotify in the tab that just opened…', 'ok');
        try {
          const r = await S.widgets.spotifySignIn(inputs.clientId.value);
          ws = await S.widgets.state();
          drawStatus();
          flash(note, r.message || (r.ok ? 'Spotify is connected.' : 'Spotify sign-in did not finish.'), r.ok ? 'ok' : 'warn');
        } catch (err) { flash(note, String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); }
        connect.disabled = false;
      });
      disconnect.addEventListener('click', async () => { await S.widgets.spotifyDisconnect(); ws = await S.widgets.state(); drawStatus(); flash(note, 'Spotify is disconnected.', 'ok'); });
      drawStatus();
      fields.replaceChildren(
        plain('Set up', h('ol', { class: 'note' },
          h('li', { text: 'In the Spotify Developer Dashboard, create an app (Web API).' }),
          h('li', { text: `Add this Redirect URI to it: ${ws.spotify?.redirect || ''}` }),
          h('li', { text: 'Paste its Client ID below, then press Connect. No client secret is needed.' })), 'Playback controls (play, pause, next, previous) need Spotify Premium.'),
        field('Client ID', inputs.clientId),
        plain('Account', h('div', { class: 'widget-inline' }, connect, disconnect, status)),
        plain('Show', h('div', { class: 'widget-checks' }, inputs.art)),
        field('Colors', colors, 'Only the card’s surface and title follow it.'));
    }
    // ---- gmail: your own Google Cloud OAuth client, then Connect (opens your browser) ----
    function gmailFields(same) {
      const g = same || {};
      const connected = () => Boolean(ws.connections?.gmail);
      inputs.clientId = h('input', { type: 'text', id: 'widget-clientid', autocomplete: 'off', spellcheck: 'false', maxlength: '300', placeholder: '1234567890-abc.apps.googleusercontent.com', 'aria-label': tr('settings.gmail.clientId', 'Google OAuth Client ID'), value: g.clientId || '' });
      inputs.clientSecret = h('input', { type: 'password', id: 'widget-clientsecret', autocomplete: 'off', spellcheck: 'false', maxlength: '300', placeholder: ws.secrets?.gmail ? tr('settings.gmail.secretSaved', 'Saved. Paste a new secret to replace it.') : tr('settings.gmail.secretHint', 'Client secret'), 'aria-label': tr('settings.gmail.clientSecret', 'Google OAuth client secret') });
      inputs.count = sel('widget-gmail-count', tr('settings.gmail.count', 'Messages shown'), [3, 4, 5, 6, 8, 10].map((n) => [n, String(n)]), g.count || 5);
      inputs.snippets = chk('widget-gmail-snippets', tr('settings.gmail.snippets', 'Show a short preview under each subject'), g.snippets !== false);
      const status = h('span', { class: 'note', role: 'status', id: 'widget-gmail-status' });
      const connect = h('button', { id: 'widget-gmail-connect', text: tr('settings.gmail.connect', 'Connect Gmail') });
      const cancel = h('button', { id: 'widget-gmail-cancel', text: tr('settings.gmail.cancel', 'Cancel'), hidden: true });
      const disconnect = h('button', { class: 'danger', id: 'widget-gmail-disconnect', text: tr('settings.gmail.disconnect', 'Disconnect') });
      const draw = () => {
        disconnect.hidden = !connected();
        connect.textContent = connected() ? tr('settings.gmail.reconnect', 'Connect again') : tr('settings.gmail.connect', 'Connect Gmail');
        if (!status.textContent) status.textContent = connected() ? tr('settings.gmail.connected', 'A Google account is connected.') : tr('settings.gmail.notConnected', 'Not connected yet.');
      };
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        cancel.hidden = false;
        flash(status, tr('settings.gmail.waiting', 'Finish signing in, in your browser. Lumen is waiting…'), 'ok');
        try {
          const r = await S.widgets.gmailConnect({ clientId: inputs.clientId.value, clientSecret: inputs.clientSecret.value });
          ws = r.state;
          inputs.clientSecret.value = '';
          inputs.clientSecret.placeholder = tr('settings.gmail.secretSaved', 'Saved. Paste a new secret to replace it.');
          flash(status, r.message, 'ok');
        } catch (err) {
          flash(status, String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
        }
        connect.disabled = false;
        cancel.hidden = true;
        draw();
      });
      cancel.addEventListener('click', () => S.widgets.gmailCancel());
      disconnect.addEventListener('click', async () => {
        ws = await S.widgets.gmailDisconnect();
        status.textContent = '';
        flash(status, tr('settings.gmail.disconnected', 'Disconnected. Lumen also asked Google to revoke access.'), 'ok');
        draw();
      });
      draw();
      fields.replaceChildren(
        plain(tr('settings.gmail.setup', 'Your Google Cloud client'), h('div', { class: 'widget-fields' },
          field(tr('settings.gmail.clientId', 'Google OAuth Client ID'), inputs.clientId),
          field(tr('settings.gmail.clientSecret', 'Google OAuth client secret'), inputs.clientSecret)),
        tr('settings.gmail.setupHelp', 'In Google Cloud Console, enable the Gmail API, create an OAuth client of type Desktop app, and paste its Client ID and secret here. Lumen asks only for read-only access to your mail (gmail.readonly), opens Google’s sign-in page in your normal browser, and keeps the tokens encrypted on this computer. The new-tab page only ever receives sender, subject and preview text.')),
        plain(tr('settings.gmail.account', 'Account'), h('div', { class: 'widget-inline' }, connect, cancel, disconnect, status),
          tr('settings.gmail.limits', 'Because you use your own Google Cloud project, Google’s limits for unverified apps apply: while the project is in Testing, only test users you add can connect, Google shows a “hasn’t verified this app” warning, and the connection ends every 7 days, so you connect again then. Publishing the project removes the 7-day limit.')),
        field(tr('settings.gmail.count', 'Messages shown'), inputs.count), plain(tr('settings.gmail.show', 'Show'), h('div', { class: 'widget-checks' }, inputs.snippets)),
        field('Colors', colors));
    }
    // ---- slack: sign in (OAuth v2 with your own Slack app), then what to show ----
    function slackFields(same) {
      const sc = same?.slack || {};
      let st = ws.slack || {};
      const picked = new Map((sc.channels || []).map((c) => [c.id, c.name]));
      inputs.token = h('input', { type: 'password', id: 'widget-token', autocomplete: 'off', spellcheck: 'false', placeholder: 'Optional: a user token (xoxp-…) instead of signing in', 'aria-label': 'Slack user token' });
      const clientId = h('input', { type: 'text', id: 'slack-client-id', autocomplete: 'off', spellcheck: 'false', placeholder: '1234567890.1234567890', value: st.clientId || '', 'aria-label': 'Slack app Client ID' });
      const clientSecret = h('input', { type: 'password', id: 'slack-client-secret', autocomplete: 'off', spellcheck: 'false', placeholder: st.hasSecret ? 'Saved. Paste a new secret to replace it.' : 'Client Secret', 'aria-label': 'Slack app Client Secret' });
      const redirect = h('input', { type: 'url', id: 'slack-redirect', spellcheck: 'false', value: st.redirect || '', 'aria-label': 'Slack redirect URL' });
      const pasted = h('input', { type: 'text', id: 'slack-pasted', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the address you landed on', 'aria-label': 'Address after approving' });
      const status = h('span', { class: 'note', role: 'status', id: 'slack-status' });
      const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      const drawStatus = () => {
        st = ws.slack || st;
        if (st.connected && st.reconnect) flash(status, `Slack no longer accepts the sign-in${st.team ? ` for ${st.team}` : ''}. Open Slack again to reconnect.`, 'warn');
        else if (st.connected) flash(status, `Connected${st.team ? ` to ${st.team}` : ''}${st.canRefresh ? ' (renewing itself)' : ''}. Read-only.`, 'ok');
        else if (st.waiting) flash(status, 'Approve in the browser tab that opened, then paste the address it ends on.', 'note');
        else { status.textContent = 'Not connected.'; status.className = 'note'; }
        disconnect.hidden = !st.connected;
      };
      const open = h('button', { type: 'button', id: 'slack-open', text: st.connected ? 'Reconnect' : 'Open Slack', onclick: async () => {
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
      const chBox = h('div', { class: 'widget-checks', id: 'slack-channels' });
      const drawChannels = (list) => {
        chBox.replaceChildren(...list.map((c) => {
          const l = chk(`slack-ch-${c.id}`, `${c.private ? '🔒 ' : '#'}${c.name}`, picked.has(c.id));
          l.querySelector('input').dataset.id = c.id;
          l.querySelector('input').dataset.name = c.name;
          l.querySelector('input').addEventListener('change', (e) => { if (e.target.checked) picked.set(c.id, c.name); else picked.delete(c.id); });
          return l;
        }));
      };
      drawChannels([...picked].map(([id, name]) => ({ id, name, private: false })));
      const load = h('button', { type: 'button', id: 'slack-load', text: 'Load channels', onclick: async () => {
        try { drawChannels(await S.widgets.slackChannels()); } catch (err) { flash(status, clean(err), 'err'); }
      } });
      inputs.slackPicked = picked;
      inputs.dms = chk('widget-slack-dms', 'Unread direct messages', sc.dms !== false);
      inputs.mentions = chk('widget-slack-mentions', 'Mentions of you in the chosen channels', sc.mentions !== false);
      inputs.count = sel('widget-slack-count', 'Recent messages', [[3, '3'], [5, '5'], [8, '8'], [10, '10']], sc.count || 5);
      drawStatus();
      fields.replaceChildren(
        plain('Slack app', h('div', null,
          h('div', { class: 'widget-inline' }, clientId, clientSecret),
          h('div', { class: 'widget-inline' }, redirect, open),
          h('div', { class: 'widget-inline' }, pasted, finish, disconnect),
          status),
        'Slack needs your own app (api.slack.com/apps → Create New App). Under OAuth & Permissions add the redirect URL above (Slack requires https, so approving ends on a page that may not load: that is fine) and these User Token Scopes: ' + ((st.scopes || []).join(', ') || 'channels:read, channels:history, im:read, im:history, users:read') + '. Read-only: nothing can be posted. Keep the app private (not distributed) so Slack’s normal rate limits apply. Everything is stored encrypted by your system and never reaches the new-tab page.'),
        field('Or a user token', inputs.token, 'Skip signing in: paste the User OAuth Token from your app’s OAuth & Permissions page. It doesn’t renew itself.'),
        plain('Channels', h('div', null, h('div', { class: 'widget-inline' }, load), chBox), 'Up to 4 channels you are in; their recent messages show on the card.'),
        plain('Show', h('div', { class: 'widget-checks' }, inputs.dms, inputs.mentions)),
        field('Recent messages', inputs.count),
        field('Colors', colors, 'Only the card’s surface and title follow it.'));
    }
    // ---- github: token and which lists ----
    function githubFields(same) {
      const g = same?.gh || {};
      inputs.token = h('input', { type: 'password', id: 'widget-token', autocomplete: 'off', spellcheck: 'false', placeholder: ws.secrets.github ? tr('settings.widgets.github.tokenSaved', 'Saved. Paste a new token to replace it.') : tr('settings.widgets.github.tokenPlaceholder', 'Paste your GitHub token'), 'aria-label': tr('settings.widgets.github.tokenLabel', 'GitHub access token') });
      inputs.reviews = chk('widget-gh-reviews', tr('settings.widgets.github.reviews', 'Review requests'), g.reviews !== false);
      inputs.assigned = chk('widget-gh-assigned', tr('settings.widgets.github.assigned', 'Assigned issues and pull requests'), g.assigned !== false);
      inputs.notifications = chk('widget-gh-notifications', tr('settings.widgets.github.notifications', 'Unread notification count'), g.notifications !== false);
      inputs.hideDrafts = chk('widget-gh-drafts', tr('settings.widgets.github.hideDrafts', 'Hide draft pull requests in review requests'), g.hideDrafts);
      inputs.max = sel('widget-gh-max', tr('settings.widgets.github.max', 'Items per list'), [[5, '5'], [10, '10'], [20, '20']], g.max ?? 10);
      const privacy = h('div', { class: 'widget-field' }, h('span', { class: 'label', text: tr('settings.widgets.github.privacyLabel', 'Private repositories') }),
        h('span', { class: 'note', text: tr('settings.widgets.github.privacy', 'Titles of issues and pull requests from private repositories are fetched too, and Lumen keeps them in memory (they are not written to settings.json) and passes them to your new-tab pages to show them, so they can appear in a new tab’s history on this device. To keep a repository off the card, don’t give the token access to it.') }));
      fields.replaceChildren(
        field(tr('settings.widgets.github.token', 'Access token'), inputs.token, tr('settings.widgets.github.tokenHelp', 'Create a fine-grained personal access token at github.com/settings/personal-access-tokens: pick the repositories to include (or All repositories) and grant read-only Issues and Pull requests (Metadata: read is added automatically). No write permissions are needed. Unread notifications work only with a classic token that has the notifications scope, because GitHub doesn’t offer notifications to fine-grained tokens; without one, the card shows the two lists and says so. Stored encrypted by your system; it never reaches the new-tab page and is sent only to api.github.com.')),
        plain(tr('settings.widgets.github.show', 'Show'), h('div', { class: 'widget-checks' }, inputs.reviews, inputs.assigned, inputs.notifications, inputs.hideDrafts), tr('settings.widgets.github.showHelp', 'Lists are refreshed every few minutes. If GitHub’s rate limit is reached, Lumen waits until it resets.')),
        field(tr('settings.widgets.github.max', 'Items per list'), inputs.max),
        privacy,
        field('Colors', colors, 'Only the card’s surface and title follow it.'));
    }
    // ---- muse: Meta's model: key, saved prompt, model, web search ----
    function museFields(same) {
      const m = same?.muse || {};
      inputs.token = h('input', { type: 'password', id: 'widget-token', autocomplete: 'off', spellcheck: 'false', placeholder: ws.secrets.muse ? tr('widgets.muse.keySaved', 'Saved. Paste a new key to replace it.') : tr('widgets.muse.keyPaste', 'Paste your Meta API key'), 'aria-label': tr('widgets.muse.key', 'Meta API key') });
      inputs.prompt = h('textarea', { id: 'widget-muse-prompt', rows: '3', maxlength: '1000', 'aria-label': tr('widgets.muse.prompt', 'Saved prompt') });
      inputs.prompt.value = m.prompt || 'Give me a short daily brief: three or four bullet points on what matters today in technology and world news, one line each.';
      inputs.model = h('input', { type: 'text', id: 'widget-muse-model', maxlength: '64', spellcheck: 'false', placeholder: 'muse-spark-1.3', 'aria-label': tr('widgets.muse.model', 'Model') });
      inputs.model.value = m.model || 'muse-spark-1.3';
      inputs.search = chk('widget-muse-search', tr('widgets.muse.search', 'Ground answers with web search (shows sources)'), m.search);
      fields.replaceChildren(
        field(tr('widgets.muse.key', 'Meta API key'), inputs.token, tr('widgets.muse.keyHelp', 'Create a key at dev.meta.ai (Meta Model API, public preview). It is stored encrypted by your system and never reaches the new-tab page or your settings file.')),
        plain(tr('widgets.muse.privacy', 'What is sent, and the cost'), h('span', { class: 'note', text: tr('widgets.muse.privacyHelp', 'Your prompt and every question you type go to Meta, and so do the answers it returns. Each answer uses your key’s credit (about $1.25 per million tokens in and $4.25 per million out, at the time of writing). The card asks about every six hours at most, or when you press Refresh or Ask; check Meta’s current terms and limits.') })),
        field(tr('widgets.muse.prompt', 'Saved prompt'), inputs.prompt, tr('widgets.muse.promptHelp', 'Answered on the card. Keep it short: answers are capped at a few hundred words.')),
        field(tr('widgets.muse.model', 'Model'), inputs.model, tr('widgets.muse.modelHelp', 'Default muse-spark-1.3. Other names from dev.meta.ai work too (muse-spark-1.2, muse-spark-1.1).')),
        plain(tr('widgets.muse.also', 'Also'), h('div', { class: 'widget-checks' }, inputs.search), tr('widgets.muse.searchHelp', 'Web search uses a different Meta endpoint and can cost more.')),
        field(tr('widgets.colors', 'Colors'), colors, tr('widgets.muse.colorsHelp', 'Only the card’s surface and title follow it.')));
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
        fields.replaceChildren(field('Calendar address', inputs.url, 'The subscribe or “secret address in iCal format” link from Muse, Google Calendar, Outlook, iCloud or Fantastical. Today’s and upcoming events show.'),
          field('Colors', colors, '“Calendar colors” uses the color the feed gives each event; “Match screen” follows your accent color and background.'));
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
        const syncUrl = () => { inputs.url.hidden = inputs.preset.value !== ''; };
        inputs.preset.addEventListener('change', syncUrl);
        syncUrl();
        fields.replaceChildren(
          field(tr('settings.widgets.feed.pick', 'Feed'), inputs.preset, tr('settings.widgets.feed.pickHint', 'Lumen fetches the feed itself; the new-tab page never goes online. Headlines open in a new tab.')),
          field(tr('settings.widgets.feed.url', 'Feed address (RSS or Atom)'), inputs.url, tr('settings.widgets.feed.urlHint', 'Only used with Custom address. Must be https://.')),
          field(tr('settings.widgets.feed.count', 'Headlines shown'), inputs.count),
          field('Colors', colors));
      } else if (type === 'muse') {
        museFields(same);
      } else {
        inputs.url = h('input', { type: 'url', id: 'widget-url', placeholder: 'https://…', 'aria-label': 'Web page address' });
        inputs.url.value = same?.url || '';
        inputs.height = h('select', { id: 'widget-height', 'aria-label': 'Card height' }, WIDGET_HEIGHTS.map(([v, t]) => h('option', { value: v, text: t })));
        inputs.height.value = same?.height || 'medium';
        fields.replaceChildren(field('Address', inputs.url, 'Any https page, like your Muse board or a dashboard. Sites that refuse to be framed get an Open button instead.'), field('Height', inputs.height));
      }
    };
    const width = h('select', { id: 'widget-span', 'aria-label': 'Card width' }, WIDGET_SPANS.map(([v, t]) => h('option', { value: v, text: t })));
    const syncWidth = () => { width.value = String(existing?.type === type ? existing.span : type === 'embed' ? 6 : 3); };
    const val = (c) => c?.querySelector?.('input')?.checked;
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
      if (type === 'spotify') return { ...base, clientId: inputs.clientId.value, art: val(inputs.art) };
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
      return { ...base, url: inputs.url?.value, height: inputs.height?.value };
    };
    const busy = (on) => { for (const b of form.querySelectorAll('button')) b.disabled = on; };
    const check = h('button', { id: 'widget-check', text: 'Check', onclick: async () => {
      busy(true);
      note.textContent = 'Checking…';
      note.className = 'note';
      const r = await S.widgets.test(input()).catch((err) => ({ ok: false, error: true, message: err.message }));
      busy(false);
      flash(note, r.message, r.ok ? 'ok' : r.error ? 'err' : 'warn');
    } });
    const save = h('button', { class: 'primary', id: 'widget-save', text: existing ? 'Save' : 'Add', onclick: async () => {
      busy(true);
      note.textContent = 'Checking…';
      note.className = 'note';
      try {
        const r = await S.widgets.save(input(), existing?.id || null);
        ws = r.state;
        closeForm();
        flash(listNote, r.message, 'ok');
      } catch (err) {
        busy(false);
        flash(note, String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
      }
    } });
    const types = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Kind of widget' },
      ws.types.map((t) => h('button', { type: 'button', role: 'radio', 'data-type': t.type, disabled: Boolean(existing) && t.type !== existing.type, onclick: () => { type = t.type; renderFields(); syncWidth(); } }, widgetIcon(t.type), t.label)));
    const form = h('div', { class: 'widget-form', id: 'widget-form' },
      h('div', { class: 'sub-label', text: existing ? `Edit ${existing.title}` : 'New widget' }),
      types, fields, field('Title', title), field('Width', width, 'Or use Edit layout on the new-tab page: drag a card anywhere, resize it from any edge, snap it to a side.'),
      h('div', { class: 'widget-buttons' }, note, h('span', { class: 'grow' }), h('button', { text: 'Cancel', onclick: closeForm }), check, save));
    formHost.replaceChildren(form);
    renderFields();
    syncWidth();
    renderList();
    (inputs.city || inputs.url || inputs.token || inputs.clientId)?.focus();
    form.scrollIntoView?.({ block: 'nearest' });
  }

  const listNote = h('span', { class: 'note', role: 'status', id: 'widget-list-note' });
  const reset = h('button', { id: 'widget-reset', text: 'Reset layout', title: 'Every widget its default size, packed in order, and every section back in the centre', onclick: async () => { ws = await S.widgets.resetLayout(); renderList(); flash(listNote, 'Layout reset.', 'ok'); } });
  card.append(stackRow('Widgets', 'Cards on the new-tab page: weather (several places, My location), a calendar (ICS), Todoist, Spotify (now playing, with play, pause, next and previous), Gmail (read-only), Slack (read-only), GitHub (review requests, assigned items, notifications; read-only), or any web page. Lumen fetches them; the page itself never goes online. On the new-tab page, Edit layout (or press and hold a card) lets you drag any card, Favorites and the search box too, anywhere, resize it from any edge, snap it to a side, add widgets and undo.', list, formHost, h('div', { class: 'controls start' }, add, reset, listNote)));
  renderList();
  const target = ws.edit && ws.widgets.find((w) => w.id === ws.edit);
  if (target) openForm(target); // a card's gear on the new-tab page
  else if (ws.create && ws.types.some((t) => t.type === ws.create)) openForm(null, ws.create); // its Add widget picker
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
  card.append(
    toggle('translateOffer', tr('settings.translate.offer', 'Offer to translate pages'), tr('settings.translate.offerDesc', 'When a page is in another language than yours, show a translate button and a bar. Nothing is sent anywhere until you click Translate, and the first time Lumen asks before sending a page’s text to your AI provider.')),
    select('translateTarget', tr('settings.translate.target', 'Translate pages into'), null,
      [['', tr('settings.translate.targetDefault', 'Lumen’s language')], ...TARGETS.map(([code, name]) => [code, `${langName(code)}` === code ? name : langName(code)])]),
    listRow('translateNever', tr('settings.translate.never', 'Sites never offered translation'), tr('settings.translate.neverNone', 'No sites.')),
    listRow('translateConsent', tr('settings.translate.consent', 'Allowed to receive page text'), tr('settings.translate.consentNone', 'None yet: Lumen asks the first time you translate.'), (v) => (v === 'google' ? 'Google Translate' : v)),
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
  document.documentElement.classList.toggle('reduce-motion', Boolean(st.prefs.reduceMotion || st.performance?.active));
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
