// Files: the pinned and recently opened files and folders, for the new-tab page's Files widget, the quick picker (Ctrl+Shift+F),
// Settings > Privacy and the AI's find_file tool. This module wires the pure parts (files-store.js, files-fuzzy.js, files-index.js)
// to Electron. The calls come from three pages, each with its own channel prefix and its own sender check (main.js):
//   the browser UI        files:<op>           (window.lumenFiles, preload.js)   [files:open is taken by dropped files: files:open-entry]
//   the new-tab page      newtab-files:<op>    (window.lumenFiles, files-newtab-preload.js)
//   Settings              settings:files-<op>  (lumenSettings.files, settings-preload.js)
// Ops: list pin unpin remove clear open show find relocate search attach. The change event goes to all three:
// files:changed (UI), newtab-files:changed (every new-tab page), settings:files-changed (Settings).
// Every disk call here is async (fs.promises) or in the indexer's worker thread: nothing waits on the disk on the main thread.

const OPS = ['list', 'pin', 'unpin', 'remove', 'clear', 'open', 'show', 'find', 'relocate', 'search', 'attach'];
const channelFor = {
  ui: (op) => (op === 'open' ? 'files:open-entry' : `files:${op}`),
  newtab: (op) => `newtab-files:${op}`,
  settings: (op) => `settings:files-${op}`,
};

// Step 1 stub: the contract shapes with nothing in them. Replaced by the real api below.
function stubApi() {
  return {
    list: async () => ({ pinned: [], recent: [], remember: true }),
    pin: async () => null,
    unpin: async () => true,
    remove: async () => true,
    clear: async () => true,
    open: async () => false,
    show: async () => false,
    find: async () => ({ candidates: [] }),
    relocate: async () => null,
    search: async () => [],
    attach: async () => false,
  };
}

module.exports = { OPS, channelFor, stubApi };
