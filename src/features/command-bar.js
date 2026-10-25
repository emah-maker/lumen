// The command bar's main side (Ctrl+K; renderer/command-bar.js draws it): the pages it can search, and the commands that need the browser.
//
// data(): the bookmarks and the most recent history, as plain { url, title }. They are sent to Lumen's own window only (cmdbar:data is a
// UI_ONLY_IPC channel) and are matched there; nothing is looked up on the network. run(id): one command by name. The window sends an id;
// anything that is not on the list below (or lumen settings section list) does nothing, so a made-up id cannot reach an action.
// Loaded the first time the bar is used (main.js `lazy`), never at startup.

const MAX_HISTORY = 400;
const MAX_BOOKMARKS = 500;
const MAX_URL = 300; // a longer link stays in History but is poor to show (as in the address bar's suggestions)

// What a Settings section id may be (the sections of lumen://settings the bar lists).
const SECTION_IDS = ['general', 'appearance', 'home', 'tabs', 'privacy', 'ai', 'updates', 'advanced', 'search', 'downloads', 'languages', 'startup',
  'default-browser', 'focus', 'accessibility', 'system', 'reset', 'ai-providers', 'ai-keys-page', 'connectors', 'connect-agents',
  'external-apps', 'routines', 'skills', 'macros', 'usage', 'telegram', 'widgets', 'clock-greeting', 'site-permissions', 'site-data',
  'passwords', 'extensions', 'task-manager', 'internals'];

// d: { history() -> Map, bookmarks() -> [], isWebUrl(url), act: { name: () => void } }. act holds one function per command id below
// (the names are the ids with the dashes made camelCase), main.js fills it with the same functions the menus and keys call.
function create(d) {
  const camel = (id) => id.replace(/-(\w)/g, (_m, c) => c.toUpperCase());
  const COMMANDS = ['new-tab', 'new-window', 'new-private-window', 'close-tab', 'reopen-tab', 'toggle-sidebar', 'new-chat', 'chat-page', 'pin-tab', 'unpin-tab',
    'mute-tab', 'unmute-tab', 'bookmark-tab', 'unbookmark-tab', 'find', 'reload', 'history', 'bookmarks', 'downloads', 'clear-data', 'theme-light', 'theme-dark',
    'theme-system', 'settings', 'shortcuts', 'record-tab', 'record-screen', 'stop-recording'];

  function data() {
    const clean = (e) => ({ url: String(e.url), title: String(e.title || '').slice(0, 200) });
    const marks = (d.bookmarks() || []).filter((b) => b && typeof b.url === 'string' && d.isWebUrl(b.url) && b.url.length <= MAX_URL).slice(0, MAX_BOOKMARKS).map(clean);
    const past = [...d.history().values()]
      .filter((e) => e && typeof e.url === 'string' && e.url.length <= MAX_URL && d.isWebUrl(e.url))
      .sort((a, b) => (b.last || 0) - (a.last || 0))
      .slice(0, MAX_HISTORY).map(clean);
    return { bookmarks: marks, history: past };
  }

  // True when the id was a command that ran.
  function run(id) {
    if (typeof id !== 'string') return false;
    const section = /^settings:([a-z-]+)$/.exec(id);
    if (section) {
      if (!SECTION_IDS.includes(section[1])) return false;
      d.act.settings(section[1]);
      return true;
    }
    if (!COMMANDS.includes(id)) return false;
    try { d.act[camel(id)](); } catch (err) { console.error('[lumen] command bar:', id, err.message); return false; }
    return true;
  }

  return { data, run, COMMANDS, SECTION_IDS };
}

module.exports = { create, SECTION_IDS };
