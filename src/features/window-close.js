// [window close] Why a window closes, in two parts: the rule (closing a tab ends its window only when the USER closed the window's last tab,
// as in Chrome) and a breadcrumb for diagnostics/window-events.jsonl so a window that vanished names its own reason next time.
const fs = require('fs');
const path = require('path');

// A window's last tab went. true: the window goes with it. false: a fresh tab takes its place (a page that closed itself, code, the AI).
// `user`: closeTab was called for a user's own close; `closing`: the tab was closed through requestCloseTab (Ctrl+W, the strip, a menu);
// `aiClosing`: that close was the AI's (close_tab, "Close tabs this chat opened", the end of a run); `agent`: an agent's own window.
function lastTabClosesWindow({ user = false, closing = false, aiClosing = false, agent = false } = {}) {
  if (aiClosing && !user && !agent) return false; // the AI's closes never close a window, even one that held only AI tabs
  return Boolean(user || closing);
}

const MAX_LINES = 200;
// Appends one line per event, async, never throws. dir: () => diagnostics folder.
function createLog({ dir, version = '', now = Date.now } = {}) {
  let writes = 0;
  return function record(entry) {
    try {
      const f = path.join(dir(), 'window-events.jsonl');
      fs.mkdir(path.dirname(f), { recursive: true }, () => {
        fs.appendFile(f, JSON.stringify({ t: new Date(now()).toISOString(), v: version, ...entry }) + '\n', (err) => {
          if (err || ++writes % 25) return;
          fs.readFile(f, 'utf8', (e, text) => {
            if (e) return;
            const lines = text.split('\n').filter(Boolean);
            if (lines.length > MAX_LINES) fs.writeFile(f, lines.slice(-MAX_LINES).join('\n') + '\n', () => {});
          });
        });
      });
    } catch { /* diagnostics must never take Lumen down */ }
  };
}

module.exports = { lastTabClosesWindow, createLog };
