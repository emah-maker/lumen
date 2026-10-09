// Whether a key press (Electron's before-input-event `input`) holds the app's shortcut modifier.
// Windows / Linux: Ctrl (or the Windows key's meta). macOS: Cmd only. There Control is the text-editing key
// (Ctrl+A / E line start and end, Ctrl+P / N previous and next line, Ctrl+F / B, Ctrl+K…, as in Chrome, Safari and
// Firefox), so it must reach the page; Ctrl+Tab and Ctrl+Page Up / Down still switch tabs, as in Chrome.
const MAC_CTRL_KEYS = new Set(['tab', 'pageup', 'pagedown']);

function shortcutMod(input, platform = process.platform) {
  if (platform !== 'darwin') return Boolean(input.control || input.meta);
  return Boolean(input.meta || (input.control && MAC_CTRL_KEYS.has(String(input.key || '').toLowerCase())));
}

// The browser keys Chrome has that handleShortcut (main.js) had no entry for, as an action name or null:
// F6 and Alt+D (Windows / Linux) focus the address bar; F3 / Ctrl+G (Cmd+G) find the next match and Shift
// adds the previous one; Ctrl+F4 closes the tab (Windows / Linux; Cmd+W does on macOS).
function extraShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown') return null;
  const key = String(input.key || '').toLowerCase();
  const mac = platform === 'darwin';
  const mod = shortcutMod(input, platform);
  if (key === 'f6' && !mod && !input.alt && !input.shift) return 'focus-address';
  if (!mac && key === 'd' && input.alt && !mod && !input.shift) return 'focus-address';
  if (key === 'f3' && !mod && !input.alt) return input.shift ? 'find-prev' : 'find-next';
  if (key === 'g' && mod && !input.alt) return input.shift ? 'find-prev' : 'find-next';
  if (!mac && key === 'f4' && input.control && !input.alt && !input.shift) return 'close-tab';
  return null;
}

// BrowserWindow 'app-command' names (Windows: the mouse's back / forward buttons, keyboards' browser keys) -> what to do.
const APP_COMMANDS = { 'browser-backward': 'back', 'browser-forward': 'forward', 'browser-refresh': 'reload', 'browser-stop': 'stop' };
const appCommandAction = (command) => APP_COMMANDS[command] || null;

module.exports = { shortcutMod, extraShortcut, appCommandAction };
