// The AI's clipboard and edit shortcuts (Ctrl/Cmd + X C V Z Y A), run as the browser's own editing commands.
// Pure helpers plus the clipboard snapshot; ai/agent.js wires them to press_key (test/units/edit-keys-units.js covers them).
//   editCommand(key, modifiers)   the webContents command a shortcut stands for, or null for any other key
//   snapshotClipboard(cb)         what the user had copied (every type: text, html, image...), so a run can put it back (async)
//   restoreClipboard(cb, snap)    puts it back (async)
// Why not a synthetic key: a page like Google Docs keeps its caret in a frame, and the DevTools key events Lumen sends there carry
// no editing command, so Ctrl+V did nothing; Edit > Paste in the page's own menu needs the async Clipboard permission and Docs
// answers it with an "install the extension" prompt. webContents.paste() and friends run the native command in the focused frame.

const PLAIN = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };
const WITH_SHIFT = { z: 'redo', v: 'pasteAndMatchStyle' };
const CLIPBOARD_COMMANDS = new Set(['cut', 'copy', 'paste', 'pasteAndMatchStyle']);

// Models write Windows shortcuts (Ctrl+A) and Mac ones (Cmd+A); both mean the same here.
function editCommand(key, modifiers = []) {
  if (typeof key !== 'string' || [...key].length !== 1) return null;
  if (!modifiers.includes('control') && !modifiers.includes('meta')) return null;
  const rest = modifiers.filter((m) => m !== 'control' && m !== 'meta');
  const letter = key.toLowerCase();
  if (rest.length === 0) return PLAIN[letter] || null;
  if (rest.length === 1 && rest[0] === 'shift') return WITH_SHIFT[letter] || null;
  return null;
}

const touchesClipboard = (command) => CLIPBOARD_COMMANDS.has(command);

// This Electron's clipboard is the async web one: read() gives ClipboardItems (each with its MIME types, getType(type) a Blob), write()
// takes ClipboardItems, readText() is a Promise. So the snapshot keeps every type of every item as it is (text, html, rtf, image...).
// Resolves null when the clipboard cannot be read: then nothing is restored (better a lost copy than a wrong one).
async function snapshotClipboard(cb) {
  try {
    const items = [];
    for (const item of (await cb.read()) || []) {
      const parts = {};
      for (const type of item.types || []) { try { parts[type] = await item.getType(type); } catch { /* a type that cannot be read is skipped */ } }
      if (Object.keys(parts).length) items.push(parts);
    }
    return { items };
  } catch { return null; }
}

// (The ClipboardItem class is Electron's; a test's fake clipboard carries its own.)
async function restoreClipboard(cb, snap) {
  if (!snap) return;
  try {
    const Item = cb.ClipboardItem || require('electron').ClipboardItem;
    if (!snap.items.length) cb.clear();
    else await cb.write(snap.items.map((parts) => new Item(parts)));
  } catch { /* the user's clipboard stays as the AI left it */ }
}

// A hash of everything on the clipboard (every type of every item), to tell whether it is still what the AI last left there.
// Resolves null when it cannot be read.
async function fingerprintClipboard(cb) {
  try {
    const hash = require('crypto').createHash('sha1');
    for (const item of (await cb.read()) || []) {
      for (const type of [...(item.types || [])].sort()) {
        hash.update(type + ':');
        const part = await item.getType(type);
        hash.update(part && typeof part.arrayBuffer === 'function' ? Buffer.from(await part.arrayBuffer()) : JSON.stringify(part) || '');
      }
    }
    return hash.digest('hex');
  } catch { return null; }
}

module.exports = { fingerprintClipboard, editCommand, touchesClipboard, snapshotClipboard, restoreClipboard };
