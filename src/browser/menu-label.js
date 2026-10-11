// A page title, bookmark name or file name as a native menu label. Windows and Linux menus read "&" as a mnemonic marker
// (the "&" itself disappears and the next letter is underlined), so "Q&A" came out "QA": a literal one is written "&&".
// A long name is cut with an ellipsis instead of mid-word with nothing to show it was cut.
const menuLabel = (text, max = 60) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s).replace(/&/g, '&&');
};

module.exports = { menuLabel };
