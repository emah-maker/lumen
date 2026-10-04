// Whether a key press (Electron's before-input-event `input`) holds the app's shortcut modifier.
// Windows / Linux: Ctrl (or the Windows key's meta). macOS: Cmd only. There Control is the text-editing key
// (Ctrl+A / E line start and end, Ctrl+P / N previous and next line, Ctrl+F / B, Ctrl+K…, as in Chrome, Safari and
// Firefox), so it must reach the page; Ctrl+Tab and Ctrl+Page Up / Down still switch tabs, as in Chrome.
const MAC_CTRL_KEYS = new Set(['tab', 'pageup', 'pagedown']);

function shortcutMod(input, platform = process.platform) {
  if (platform !== 'darwin') return Boolean(input.control || input.meta);
  return Boolean(input.meta || (input.control && MAC_CTRL_KEYS.has(String(input.key || '').toLowerCase())));
}

module.exports = { shortcutMod };
