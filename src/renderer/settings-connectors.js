// Settings → Apps and connections: the pieces of a connector's page that settings-apps.js puts together (features/connectors/). A connector is a
// service the AI can use once it is connected; Gmail, Google Calendar, Todoist and GitHub are also cards on the new tab page, and the page for
// each has one Connect, then "Show on new tab page" and "Let the AI use it". Nothing here is a page of its own any more (it was a gallery of cards
// under AI); the registry (features/connectors/registry.js) is still the list, so a connector added there shows up by itself.
// A token or secret typed here goes to the main process and is saved encrypted; it never comes back to this page, only the state does.
// Loaded before settings.js; it uses that file's h(), row(), flash() and armedButton() helpers.

const connClean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// What the AI can read and do, and where things go: one text, read from the (i) button of a row.
function connAbout(c) {
  const parts = [];
  if (c.reads.length) parts.push(`The AI can read: ${c.reads.join('; ')}.`);
  if (c.does.length) parts.push(`The AI can do: ${c.does.join('; ')}.`);
  if (!c.does.length && c.kind !== 'mcp') parts.push('It can’t change anything: read only.');
  if (c.kind === 'mcp') {
    parts.push(`The tools come from ${c.name}’s own MCP server${c.source ? ` (${c.source.replace(/^https:\/\//, '')})` : ''}, so what exactly the AI can do is whatever that server offers. Each call still asks you first and shows what it would send, unless you tick Always allow for a tool once it is connected.`);
    parts.push(c.oauth ? 'You sign in on the service’s own page in your browser. Lumen never sees your password; the sign-in is kept encrypted on this computer, and Disconnect deletes it.' : 'Lumen sends nothing anywhere except this service. The token is kept encrypted on this computer, and Disconnect deletes it.');
  } else {
    parts.push(c.kind === 'session' ? 'It uses the sign-in you already have in Lumen and sends nothing anywhere except that site. Disconnect removes this link.' : c.kind === 'google' ? 'Lumen sends nothing anywhere except Google. The sign-in is kept encrypted on this computer. Disconnect deletes it and, once no other Google connector uses it, gives it back to Google.' : c.kind === 'microsoft' ? 'Lumen sends nothing anywhere except Microsoft. The sign-in is kept encrypted on this computer. Disconnect deletes it here; to take the permission back at Microsoft too, remove Lumen in your Microsoft account’s app permissions.' : 'Lumen sends nothing anywhere except this service. The secret is kept encrypted on this computer, and Disconnect deletes it.');
  }
  parts.push('What it returns goes into your chat, so it is also sent to the AI you are using (Anthropic, OpenAI, Google, xAI or whichever you picked), like the text of a page.');
  if (c.note) parts.push(c.note);
  return parts.join(' ');
}

// A preset's tools, each with Always allow (a tool that reads nothing private may run without asking; a write you may want to keep asking for).
// `after` runs with the new list when a change was saved.
function connToolsView(c, { M, C, say, after }) {
  const items = c.mcp.tools.map((t) => {
    const box = h('input', { type: 'checkbox', 'aria-label': `Always allow ${t.name}`, checked: t.always, onchange: async (e) => { try { await M.setAlwaysAllow(`${c.mcp.name}__${t.name}`, e.target.checked); after(await C.list()); } catch (err) { e.target.checked = !e.target.checked; say(connClean(err), 'error'); } } });
    return h('li', { title: t.description }, h('label', {}, box, ` ${t.name}`), h('span', { class: 'note', text: t.auto ? ' · read only, runs without asking' : t.always ? ' · always allowed' : '' }));
  });
  return h('details', { class: 'conn-details', id: `conn-${c.id}-tools` }, h('summary', { text: `Tools (${c.mcp.tools.length})` }), h('p', { class: 'note', text: 'Tools the service marks read only run without asking. Ticked tools run without asking, until the AI has read a page in that chat. Everything else asks first.' }), h('ul', { class: 'mcp-tools' }, items));
}

// What the AI sent (time, to, subject), newest first: loaded when the section is opened.
function connSendLogView(c, C) {
  const body = h('div', { class: 'conn-send-log' });
  const d = h('details', { class: 'conn-details', id: `conn-${c.id}-sendlog` }, h('summary', { text: 'Sent by the AI' }), body);
  d.addEventListener('toggle', async () => {
    if (!d.open) return;
    try {
      const rows = await C.sendLog();
      body.replaceChildren(...(rows.length ? rows.map((r) => h('p', { class: 'note', text: `${new Date(r.at).toLocaleString()} · to ${r.to} · “${r.subject}”${r.via === 'typed' ? ' · sent on your word in the chat' : ' · you pressed Send'}` })) : [h('p', { class: 'note', text: 'Nothing sent yet.' })]));
    } catch (err) { body.replaceChildren(h('p', { class: 'note', text: connClean(err) })); }
  });
  return d;
}

// A Canvas address is found in the browsing: one chip per candidate, put in the field when clicked.
function connDetectChips(c, input, C) {
  const chips = h('div', { class: 'conn-chips' });
  if (c.id !== 'canvas') return chips;
  C.detect(c.id).then((hosts) => {
    if (!hosts.length) return;
    if (!input.value && hosts.length === 1) input.value = hosts[0];
    chips.replaceChildren(h('span', { class: 'note', text: 'Found in your browsing: ' }), ...hosts.map((host) => h('button', { type: 'button', class: 'chip', text: host, onclick: () => { input.value = host; } })));
  }).catch(() => {});
  return chips;
}
