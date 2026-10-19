// The right-click menu of the browser's own text fields (the address bar, Find, the sidebar's message box): Cut,
// Copy, Paste, Select All, and in the address bar "Paste and Go" / "Paste and Search", as in Chrome. Pure: main.js
// pops it. Page text fields get their own menu (showContextMenu in main.js).

// Clipboard text as the address bar takes it: one line (line breaks become a space), trimmed.
const oneLine = (text) => String(text || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();

// flags: { cut, copy, paste } (which of them apply to the field now)
// address: null, or { text (the clipboard's), isSearch (it would be searched, not opened), t, go(text) }
function editMenuTemplate(flags, address = null) {
  const items = [
    { role: 'cut', enabled: Boolean(flags.cut) },
    { role: 'copy', enabled: Boolean(flags.copy) },
    { role: 'paste', enabled: Boolean(flags.paste) },
  ];
  const text = address ? oneLine(address.text) : '';
  if (address && text) items.push({ label: address.t(address.isSearch ? 'menu.pasteAndSearch' : 'menu.pasteAndGo'), click: () => address.go(text) });
  items.push({ type: 'separator' }, { role: 'selectAll' });
  return items;
}

module.exports = { editMenuTemplate, oneLine };
