// The command bar (Ctrl+K, Cmd+K on a Mac): one box over the page that searches the open tabs, bookmarks, history, Settings sections
// and commands (new tab, pin tab, switch theme...), and offers "Ask AI: <what you typed>" as its last row, which sends the text to the sidebar.
// Up / Down pick, Enter runs, Ctrl+Enter opens a page in a new tab, Esc closes. With nothing typed it lists the commands you ran lately,
// then the open tabs.
//
// The key: main.js (handleShortcut, page-first: a site that uses Ctrl+K itself keeps it) sends 'cmdbar:open'. Like the file picker this
// file is loaded on first use (app.js loadCommandBar), not part of the bundle every window parses. Ranking: command-bar-match.js.
// Main side: features/command-bar.js (history, bookmarks and the commands that need the browser). Strings are set with textContent only.

const commandBar = (() => {
  const tr = (key, english, vars) => {
    const v = window.t?.(key, vars);
    return v && v !== key ? v : english.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));
  };
  const RECENT_KEY = 'lumen.cmdbar.recent';
  // Settings pages the bar lists: the categories of Settings, the places people look for most, and every sub-page (test/units/settings-links-units.js keeps it in step with renderer/settings.js).
  const SECTIONS = [
    ['general', 'General', 'browser startup basics'],
    ['appearance', 'Appearance', 'theme dark light colour accent zoom'],
    ['accessibility', 'Accessibility', 'motion contrast text size screen reader'],
    ['ai', 'AI', 'assistant model keys approvals'],
    ['apps', 'Apps and connections', 'connect sign in gmail calendar todoist github widgets services'],
    ['home', 'New tab page', 'new tab page background clock'],
    ['tabs', 'Tabs and browsing', 'tabs sleep group pinned unload'],
    ['privacy', 'Privacy and security', 'clear data cookies history cache passwords'],
    ['downloads', 'Downloads and files', 'save folder files printing pdf'],
    ['updates', 'Updates and about', 'version about update'],
    ['advanced', 'Advanced', 'developer automation diagnostics proxy'],
    ['search', 'Search engine', 'address bar default'],
    ['startup', 'On startup', 'restore pages'],
    ['default-browser', 'Default browser', 'make default'],
    ['reset', 'Reset settings', 'defaults'],
    ['languages', 'Language and spelling', 'language languages spelling spell check translate translation'],
    ['sync', 'Sync', 'sync folder cloud passphrase backup devices'],
    ['focus', 'Focus mode', 'focus block sites schedule distraction study'],
    ['ai-answers', 'Models and answers', 'answers fractions auto model image generation fallback'],
    ['ai-keys-page', 'API keys and sign-ins', 'api key anthropic claude openai grok xai'],
    ['ai-providers', 'AI providers', 'provider effort reasoning thinking claude code grok'],
    ['ai-memory', 'Instructions and memory', 'custom instructions memory remember projects folder about'],
    ['ai-approvals', 'Asking before it acts', 'approvals permission ask bypass auto-allow hands off'],
    ['ai-tabs', 'Tabs the AI opens', 'ai tabs group hide close finish front'],
    ['ai-helpers', 'Helpers and research', 'helpers subagents parallel research tabs acting'],
    ['ai-chat', 'Chat box and voice', 'chat box voice input dictation microphone plan'],
    ['ai-computer', 'Computer access', 'files computer apps terminals word full access'],
    ['ai-privacy', 'What the AI can see', 'sites ai off signed-in files apps couldn t'],
    ['ai-agents', 'Let agents use Lumen', 'agents mcp connect claude code codex grok'],
    ['routines', 'Routines', 'routine routines schedule scheduled repeat quiet hours'],
    ['skills', 'Skills', 'prompts commands'],
    ['macros', 'Macros', 'automation record replay steps shortcut script'],
    ['usage', 'Usage', 'plan limits tokens claude grok codex antigravity'],
    ['mcp-servers', 'Custom MCP servers', 'mcp tools servers custom model context protocol'],
    ['home-background', 'Background', 'background wallpaper picture gradient shuffle daily'],
    ['home-effect', 'Animated effect', 'animated effect particles stars snow bubbles music'],
    ['widgets', 'Widgets', 'widgets cards add weather clock world feed'],
    ['tabs-groups', 'Group tabs automatically', 'group tabs organize site topic idle'],
    ['tabs-sleep', 'Sleeping tabs', 'sleep unload memory freeze performance discard'],
    ['privacy-clear', 'Clear browsing data', 'clear history cookies cache downloads delete'],
    ['privacy-tracking', 'Tracking protection', 'tracking cookies do not track gpc fingerprint'],
    ['privacy-adblock', 'Ad blocker', 'ads adblock trackers allow sites'],
    ['privacy-passwords', 'Passwords and passkeys', 'passwords passkeys windows hello security keys logins'],
    ['privacy-safe', 'Safe Browsing', 'safe browsing phishing malware google api key'],
    ['site-permissions', 'Site permissions', 'camera microphone location notifications popups clipboard devices'],
    ['site-data', 'Site data', 'cookies storage website data remove manage'],
    ['extensions-page', 'Extensions', 'extensions chrome web store add-ons remove options'],
    ['downloads-recent', 'Recent downloads', 'recent downloads list clear show in folder'],
    ['about-lumen', 'About Lumen', 'version build report problem copy details'],
    ['system', 'Performance and graphics', 'performance graphics acceleration visual effects memory energy'],
    ['adv-network', 'Network and proxy', 'proxy vpn network pac'],
    ['automation', 'Remote control for developers', 'automation cdp devtools playwright puppeteer remote debugging'],
    ['adv-diagnostics', 'Diagnostics', 'diagnostics timing record switch export tab'],
    ['task-manager', 'Task manager', 'processes memory cpu restart tab developer energy'],
    ['internals', 'Internals', 'gpu graphics session cache cookies user agent'],
    ['connect-agents', 'Connect an AI agent', 'mcp claude code codex'],
    ['external-apps', 'Let other apps use Lumen', 'mcp cursor claude desktop token'],
    ['telegram', 'Phone (Telegram)', 'bot remote'],
    ['clock-greeting', 'Clock and greeting', 'time date'],
    ['passwords', 'Saved passwords', 'logins import'],
  ];
  // [id, key in locales/en.json, English, search words, when: shown only if it returns true for the front tab state]
  const hasTab = (s) => Boolean(s.active);
  const ACTIONS = [
    ['new-tab', 'commandBar.act.newTab', 'New tab', 'open blank create'],
    ['new-window', 'commandBar.act.newWindow', 'New window', 'open'],
    ['new-private-window', 'commandBar.act.newPrivateWindow', 'New private window', 'incognito'],
    ['close-tab', 'commandBar.act.closeTab', 'Close tab', 'shut remove', hasTab],
    ['reopen-tab', 'commandBar.act.reopenTab', 'Reopen closed tab', 'undo restore'],
    ['toggle-sidebar', 'commandBar.act.toggleSidebar', 'Show or hide the sidebar', 'assistant chat ai panel'],
    ['new-chat', 'commandBar.act.newChat', 'New chat in the sidebar', 'ai assistant conversation'],
    ['chat-page', 'commandBar.act.chatPage', 'Open the chat as a page', 'ai full'],
    ['pin-tab', 'commandBar.act.pinTab', 'Pin tab', 'keep', (s) => hasTab(s) && !s.active.pinned],
    ['unpin-tab', 'commandBar.act.unpinTab', 'Unpin tab', 'loose', (s) => hasTab(s) && s.active.pinned],
    ['mute-tab', 'commandBar.act.muteTab', 'Mute tab', 'sound audio silence', (s) => hasTab(s) && !s.active.muted],
    ['unmute-tab', 'commandBar.act.unmuteTab', 'Unmute tab', 'sound audio', (s) => hasTab(s) && s.active.muted],
    ['bookmark-tab', 'commandBar.act.bookmarkTab', 'Bookmark this page', 'save favourite star', (s) => hasTab(s) && !s.active.bookmarked],
    ['unbookmark-tab', 'commandBar.act.unbookmarkTab', 'Remove bookmark', 'unstar', (s) => hasTab(s) && s.active.bookmarked],
    ['find', 'commandBar.act.find', 'Find in page', 'search text'],
    ['reload', 'commandBar.act.reload', 'Reload page', 'refresh', hasTab],
    ['history', 'commandBar.act.history', 'Open History', 'visited past'],
    ['bookmarks', 'commandBar.act.bookmarks', 'Open Bookmarks', 'favourites saved'],
    ['downloads', 'commandBar.act.downloads', 'Open Downloads', 'files'],
    ['clear-data', 'commandBar.act.clearData', 'Clear browsing data', 'delete history cookies cache privacy'],
    ['theme-light', 'commandBar.act.themeLight', 'Switch to the light theme', 'appearance colour'],
    ['theme-dark', 'commandBar.act.themeDark', 'Switch to the dark theme', 'appearance colour night'],
    ['theme-system', 'commandBar.act.themeSystem', 'Match the system theme', 'appearance colour auto'],
    ['settings', 'commandBar.act.settings', 'Open Settings', 'preferences options'],
    ['shortcuts', 'commandBar.act.shortcuts', 'Keyboard shortcuts', 'keys help'],
    ['record-tab', 'commandBar.act.recordTab', 'Record tab', 'screen recording video capture demo', hasTab],
    ['record-screen', 'commandBar.act.recordScreen', 'Record screen', 'screen recording video capture window demo'],
    ['stop-recording', 'commandBar.act.stopRecording', 'Stop recording', 'screen recording video end finish'],
  ];

  let panel = null;
  let input = null;
  let list = null;
  let rows = [];
  let selected = 0;
  let seen = { tabs: [], activeId: null };
  let pages = { history: [], bookmarks: [] };
  let wired = false;
  let openedOn = null; // the tab in front when the bar opened

  const isOpen = () => Boolean(panel && !panel.hidden);
  const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
  const recent = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : []; } catch { return []; } };
  const remember = (id) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 8))); } catch { /* no storage: nothing is remembered */ } };

  function items() {
    const tabState = (typeof lastTabState !== 'undefined' && lastTabState) || seen; // app.js keeps the newest tab list
    const active = tabState.tabs.find((t) => t.id === tabState.activeId) || null;
    const state = { active };
    const out = tabState.tabs.map((t) => ({ id: `tab:${t.id}`, group: 'tab', tabId: t.id, title: t.title || t.url || tr('tabSearch.newTab', 'New Tab'), url: t.url, favicon: t.favicon, sub: hostOf(t.url), current: t.id === tabState.activeId }));
    for (const [id, key, english, keywords, when] of ACTIONS) if (!when || when(state)) out.push({ id, group: 'action', title: tr(key, english), keywords });
    for (const [id, english, keywords] of SECTIONS) {
      const name = tr(`settings.section.${id}`, english);
      out.push({ id: `settings:${id}`, group: 'setting', title: name, keywords: `settings ${keywords}`, sub: tr('commandBar.group.setting', 'Settings') });
    }
    for (const b of pages.bookmarks) out.push({ id: `url:${b.url}`, group: 'bookmark', title: b.title || b.url, url: b.url, sub: hostOf(b.url) });
    for (const h of pages.history) out.push({ id: `url:${h.url}`, group: 'history', title: h.title || h.url, url: h.url, sub: hostOf(h.url) });
    return out;
  }

  const GROUP_TITLE = { recent: ['commandBar.group.recent', 'Recent commands'], tab: ['commandBar.group.tab', 'Open tabs'], action: ['commandBar.group.action', 'Commands'], setting: ['commandBar.group.setting', 'Settings'], bookmark: ['commandBar.group.bookmark', 'Bookmarks'], history: ['commandBar.group.history', 'History'], ask: ['commandBar.group.ask', 'Ask AI'] };

  function row(item, i) {
    const li = document.createElement('li');
    li.className = `cmdbar-item${i === selected ? ' selected' : ''}${item.current ? ' current' : ''}`;
    li.id = `cmdbar-item-${i}`;
    li.dataset.group = item.group;
    li.dataset.id = item.id;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === selected));
    let icon;
    if (item.favicon && (item.group === 'tab')) {
      icon = Object.assign(document.createElement('img'), { className: 'cmdbar-icon', src: item.favicon, alt: '' });
      icon.onerror = () => icon.replaceWith(Object.assign(document.createElement('span'), { className: 'cmdbar-icon blank' }));
    } else icon = Object.assign(document.createElement('span'), { className: `cmdbar-icon ${item.group === 'tab' || item.group === 'bookmark' || item.group === 'history' ? 'blank' : 'glyph'}`, textContent: item.group === 'ask' ? '✦' : item.group === 'setting' ? '⚙' : item.group === 'action' || item.group === 'recent' ? '›' : '' });
    const text = Object.assign(document.createElement('span'), { className: 'cmdbar-text' });
    const title = item.group === 'ask' ? tr('commandBar.ask', 'Ask AI: {text}', { text: item.text }) : item.title;
    text.append(Object.assign(document.createElement('span'), { className: 'cmdbar-title', textContent: title }));
    if (item.sub) text.append(Object.assign(document.createElement('span'), { className: 'cmdbar-sub', textContent: item.sub }));
    li.append(icon, text);
    li.onmousemove = () => { if (selected !== i) { selected = i; render(false); } };
    li.onclick = (e) => run(item, { newTab: e.ctrlKey || e.metaKey });
    return li;
  }

  function render(rebuild = true) {
    if (!isOpen()) return;
    if (rebuild) rows = window.commandBarMatch.search(input.value, items(), { recent: recent() });
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    list.replaceChildren();
    let group = null;
    rows.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group;
        const [key, english] = GROUP_TITLE[group] || ['', group];
        const header = Object.assign(document.createElement('li'), { className: 'cmdbar-section', textContent: key ? tr(key, english) : english });
        header.setAttribute('role', 'presentation');
        list.append(header);
      }
      list.append(row(item, i));
    });
    if (!rows.length) list.append(Object.assign(document.createElement('li'), { className: 'cmdbar-empty', textContent: tr('commandBar.empty', 'Nothing matches') }));
    const current = document.getElementById(`cmdbar-item-${selected}`);
    if (current) { input.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  }

  function run(item, { newTab = false } = {}) {
    close();
    if (!item) return;
    if (item.group === 'ask') { document.dispatchEvent(new CustomEvent('cmdbar:ask', { detail: item.text })); return; }
    if (item.group === 'tab') { window.browser.switchTab(item.tabId); return; }
    if (item.group === 'bookmark' || item.group === 'history') { if (newTab) window.browser.newTab(item.url); else window.browser.go(item.url); return; }
    remember(item.id);
    window.browser.commandRun(item.id);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      render(false);
    } else if (e.key === 'Enter' && !isImeEnter(e)) {
      e.preventDefault();
      run(rows[selected], { newTab: e.ctrlKey || e.metaKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function build() {
    panel = Object.assign(document.createElement('div'), { id: 'cmdbar', className: 'cmdbar', hidden: true });
    const scrim = Object.assign(document.createElement('div'), { className: 'cmdbar-scrim' });
    scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
    const box = Object.assign(document.createElement('div'), { className: 'cmdbar-box' });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', tr('commandBar.label', 'Command bar'));
    input = Object.assign(document.createElement('input'), { id: 'cmdbar-input', type: 'text', placeholder: tr('commandBar.placeholder', 'Search tabs, history and settings, or type a command'), autocomplete: 'off', spellcheck: false });
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'cmdbar-results');
    input.setAttribute('aria-label', tr('commandBar.label', 'Command bar'));
    list = Object.assign(document.createElement('ul'), { id: 'cmdbar-results', className: 'cmdbar-results' });
    list.setAttribute('role', 'listbox');
    box.append(input, list);
    panel.append(scrim, box);
    document.body.append(panel);
    input.addEventListener('input', () => { selected = 0; render(); });
    input.addEventListener('keydown', onKey);
    list.addEventListener('pointerdown', (e) => e.preventDefault()); // the focus stays in the box
    window.addEventListener('blur', () => { if (isOpen()) close(); });
  }

  async function open() {
    if (!panel) build();
    if (!wired) { wired = true; window.browser.onTabs((next) => { seen = next; if (!isOpen()) return; if (next.activeId !== openedOn) close(); else render(); }); }
    if (isOpen()) { input.select(); return; }
    openedOn = (typeof lastTabState !== 'undefined' && lastTabState ? lastTabState : seen).activeId;
    freezePage(); // app.js: the page shows as a still image so the bar can sit over it (read before the bar is shown, as the file picker does)
    input.value = '';
    selected = 0;
    pages = { history: [], bookmarks: [] };
    panel.hidden = false;
    render();
    input.focus();
    try { // the pages come from main a moment later: the tabs and commands are there at once
      const data = await window.browser.commandData();
      if (data && isOpen()) { pages = { history: Array.isArray(data.history) ? data.history : [], bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [] }; render(); }
    } catch { /* tabs and commands still work */ }
  }

  function close() {
    if (!isOpen()) return;
    panel.hidden = true;
    thawPage();
  }

  const toggle = () => (isOpen() ? close() : open());
  return { open, close, toggle, isOpen };
})();
window.commandBar = commandBar;
