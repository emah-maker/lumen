// ---------- Keyboard Shortcuts: one sheet listing every shortcut Lumen handles ----------
//
// ⋯ → Keyboard Shortcuts (Help → Keyboard Shortcuts on macOS, or Ctrl+Shift+/ i.e. Ctrl+?) shows the
// list in Lumen's own dialog overlay (dialogs.showNotes, the card What's New uses), one section per
// area. The list is data here, written for the platform it runs on (⌘ and ⌥ on macOS, Ctrl and Alt
// elsewhere), so the sheet and the tests read the same table. Keep it in step with handleShortcut()
// in main.js: test/shortcuts-units.js checks that each entry's keys are ones handleShortcut knows.

// One entry: [label key in locales/en.json, keys]. Keys are a list of chords; a chord is
// 'mod+shift+t'-style text. `mac` / `other` limit an entry or a chord to one platform.
const SECTIONS = [
  {
    id: 'tabs',
    entries: [
      ['shortcuts.newTab', ['mod+t']],
      ['shortcuts.newWindow', ['mod+n']],
      ['shortcuts.newPrivateWindow', ['mod+shift+n']],
      ['shortcuts.closeTab', ['mod+w']],
      ['shortcuts.closeWindow', ['mod+shift+w']],
      ['shortcuts.reopenTab', ['mod+shift+t']],
      ['shortcuts.nextTab', ['mod+tab', 'mod+pagedown', { mac: 'mod+alt+right' }]],
      ['shortcuts.previousTab', ['mod+shift+tab', 'mod+pageup', { mac: 'mod+alt+left' }]],
      ['shortcuts.tabByNumber', ['mod+1–8']],
      ['shortcuts.lastTab', ['mod+9']],
      ['shortcuts.moveTab', ['mod+shift+pageup', 'mod+shift+pagedown']],
      ['shortcuts.searchTabs', ['mod+shift+a']],
      ['shortcuts.mergeWindows', ['mod+shift+m']],
    ],
  },
  {
    id: 'navigation',
    entries: [
      ['shortcuts.focusAddress', ['mod+l']],
      ['shortcuts.back', [{ mac: 'mod+[' }, 'alt+left']],
      ['shortcuts.forward', [{ mac: 'mod+]' }, 'alt+right']],
      ['shortcuts.reload', ['mod+r', 'f5']],
      ['shortcuts.forceReload', ['mod+shift+r', 'shift+f5']],
      ['shortcuts.stop', ['escape']],
      ['shortcuts.history', [{ mac: 'mod+y' }, { other: 'mod+h' }]],
      ['shortcuts.downloads', [{ mac: 'mod+alt+l' }, { other: 'mod+shift+j' }]],
      ['shortcuts.bookmarkPage', ['mod+d']],
      ['shortcuts.bookmarkAllTabs', ['mod+shift+d']],
      ['shortcuts.bookmarks', ['mod+shift+o']],
      ['shortcuts.openFile', ['mod+o']],
      ['shortcuts.clearData', [{ mac: 'mod+shift+backspace' }, { other: 'mod+shift+delete' }]],
    ],
  },
  {
    id: 'page',
    entries: [
      ['shortcuts.find', ['mod+f']],
      ['shortcuts.zoomIn', ['mod+=']],
      ['shortcuts.zoomOut', ['mod+-']],
      ['shortcuts.actualSize', ['mod+0']],
      ['shortcuts.print', ['mod+p']],
      ['shortcuts.savePage', ['mod+s']],
      ['shortcuts.screenshot', ['mod+shift+s']],
      ['shortcuts.viewSource', ['mod+u']],
      ['shortcuts.fullScreen', [{ mac: 'mod+ctrl+f' }, { other: 'f11' }]],
      ['shortcuts.devTools', ['f12', { mac: 'mod+alt+i' }]],
    ],
  },
  {
    id: 'ai',
    entries: [
      ['shortcuts.toggleSidebar', ['mod+j']],
      ['shortcuts.newChat', ['mod+shift+k']],
      ['shortcuts.chatPage', ['mod+shift+l']],
      ['shortcuts.askFromAddress', ['alt+enter']],
    ],
  },
  {
    id: 'lumen',
    entries: [
      ['shortcuts.settings', ['mod+,']],
      ['shortcuts.showShortcuts', ['mod+shift+/']],
      ['shortcuts.hide', [{ mac: 'mod+h' }]],
    ],
  },
];

const MAC_NAMES = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', left: '←', right: '→', tab: '⇥', enter: '↩', escape: 'Esc', backspace: '⌫', pageup: 'Page Up', pagedown: 'Page Down' };
const OTHER_NAMES = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl', left: '←', right: '→', tab: 'Tab', enter: 'Enter', escape: 'Esc', delete: 'Delete', backspace: 'Backspace', pageup: 'Page Up', pagedown: 'Page Down' };

// 'mod+shift+t' -> '⇧⌘T' on macOS (Apple's order: ⌃ ⌥ ⇧ ⌘), 'Ctrl+Shift+T' elsewhere.
function formatChord(chord, platform = process.platform) {
  const mac = platform === 'darwin';
  const names = mac ? MAC_NAMES : OTHER_NAMES;
  const parts = String(chord).split('+');
  const mods = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  const keyName = names[key] || key.toUpperCase();
  if (mac) {
    const order = ['ctrl', 'alt', 'shift', 'mod'];
    return mods.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((m) => names[m] || m).join('') + keyName;
  }
  return [...mods.map((m) => names[m] || m), keyName].join('+');
}

// The chords of one entry that apply on `platform`.
function chordsFor(keys, platform = process.platform) {
  const mac = platform === 'darwin';
  return keys.map((k) => (typeof k === 'string' ? k : mac ? k.mac : k.other)).filter(Boolean);
}

// -> [{ id, entries: [{ label (key), keys: ['⌘T', …] }] }], entries with no chord on this platform left out.
function sheet(platform = process.platform) {
  return SECTIONS.map((s) => ({
    id: s.id,
    entries: s.entries
      .map(([label, keys]) => ({ label, keys: chordsFor(keys, platform).map((c) => formatChord(c, platform)) }))
      .filter((e) => e.keys.length),
  })).filter((s) => s.entries.length);
}

// Every label key the sheet can use, on any platform (for the locale check).
function labelKeys() {
  return [...SECTIONS.map((s) => `shortcuts.section.${s.id}`), ...SECTIONS.flatMap((s) => s.entries.map(([label]) => label))];
}

// deps: { t, showNotes(opts) -> Promise, platform? }
function createShortcutsHelp(deps) {
  let showing = false;
  async function open() {
    if (showing) return false;
    showing = true;
    try {
      const platform = deps.platform || process.platform;
      await deps.showNotes({
        message: deps.t('shortcuts.title'),
        notes: sheet(platform).map((s) => ({
          version: deps.t(`shortcuts.section.${s.id}`),
          date: '',
          blocks: s.entries.map((e) => ({ type: 'li', text: `${deps.t(e.label)}: ${e.keys.map((k) => `\`${k}\``).join(deps.t('shortcuts.or'))}` })), // `keys` are drawn as <code>
        })),
        buttons: [deps.t('shortcuts.close')],
      });
      return true;
    } finally {
      showing = false;
    }
  }
  return { open, isOpen: () => showing };
}

module.exports = { createShortcutsHelp, sheet, formatChord, chordsFor, labelKeys, SECTIONS };
