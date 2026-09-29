// Filtering and ordering for the composer's "/" menu (renderer/slash.js). A plain script in the UI;
// test/units.js loads it with require().
(function (root) {
  // commands: [{ name, label, description }]. A name that is the query, then one that starts with it
  // (shorter first), then a name containing every word, then a match in the label or description.
  function rank(commands, query) {
    const q = String(query || '').toLowerCase().replace(/^\//, '').trim();
    if (!q) return commands.slice();
    const words = q.split(/\s+/);
    return commands
      .map((c, i) => {
        const name = String(c.name).toLowerCase();
        const rest = `${c.label || ''} ${c.description || ''}`.toLowerCase();
        let score = -1;
        if (name === q) score = 100;
        else if (name.startsWith(q)) score = 80 - Math.min(20, name.length - q.length);
        else if (words.every((w) => name.includes(w))) score = 50;
        else if (words.every((w) => `${name} ${rest}`.includes(w))) score = 20;
        return { c, i, score };
      })
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((r) => r.c);
  }

  // What the composer holds -> what the menu should do. `/name` (no space yet): filter by that.
  // `/name rest` where name is a command: make it a chip, `rest` is the argument. Anything else: nothing.
  function parse(value, has) {
    const text = String(value || '');
    let m = /^\/([a-z0-9-]*)$/.exec(text);
    if (m) return { kind: 'menu', query: m[1] };
    m = /^\/([a-z0-9-]+)\s([\s\S]*)$/.exec(text);
    if (m && has(m[1])) return { kind: 'chip', name: m[1], rest: m[2] };
    return { kind: 'none' };
  }

  const api = { rank, parse };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.slashMatch = api;
})(this);
