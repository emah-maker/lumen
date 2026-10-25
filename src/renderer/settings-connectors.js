// Settings → You and AI → Connectors: a gallery of services the AI can use once they are connected (features/connectors/).
// Each card says what the AI can read and do before anything is connected, shows its state (Not connected, Connected · account,
// Needs sign-in) and has one button. A token or secret typed here goes to the main process and is saved encrypted; it never comes
// back to this page, only the state does. GitHub, Notion and Todoist are cards that add the service's own MCP server (their tools are
// listed on the card, with Always allow); below the cards, Custom MCP servers (settings-mcp-servers.js) is the same list for any other
// server, so there is one place for everything the AI can reach. Loaded before settings.js and called from its buildAi(); it uses that
// file's h(), stackRow() and flash() helpers.

function buildConnectors() {
  const C = window.lumenSettings.ai.connectors;
  const root = h('div', { class: 'conn', id: 'connectors' });
  const note = h('p', { class: 'note', id: 'connectors-status', 'aria-live': 'polite' });
  const M = window.lumenSettings.ai.mcpServers;
  let custom = null; // the Custom MCP servers section (made after the cards)
  let open = null; // the card whose connect form is showing

  const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function badge(c) {
    return h('span', { class: 'conn-badge', 'aria-hidden': 'true', style: `background:${c.icon.color}`, text: c.icon.text });
  }

  function permissions(c) {
    const lines = [];
    if (c.reads.length) lines.push(h('p', { class: 'note' }, h('strong', { text: 'The AI can read: ' }), c.reads.join('; '), '.'));
    if (c.does.length) lines.push(h('p', { class: 'note' }, h('strong', { text: 'The AI can do: ' }), c.does.join('; '), '.'));
    if (!c.does.length && c.kind !== 'mcp') lines.push(h('p', { class: 'note', text: 'It can’t change anything: read only.' }));
    if (c.kind === 'mcp') {
      lines.push(h('p', { class: 'note', text: `The tools come from ${c.name}’s own MCP server${c.source ? ` (${c.source.replace(/^https:\/\//, '')})` : ''}, so what exactly the AI can do is whatever that server offers. Each call still asks you first and shows what it would send, unless you tick Always allow for a tool once it is connected.` }));
      lines.push(h('p', { class: 'note', text: c.oauth ? 'You sign in on the service’s own page in your browser. Lumen never sees your password; the sign-in is kept encrypted on this computer, and Disconnect deletes it.' : 'Lumen sends nothing anywhere except this service. The token is kept encrypted on this computer, and Disconnect deletes it.' }));
    } else lines.push(h('p', { class: 'note', text: c.kind === 'session' ? 'It uses the sign-in you already have in Lumen and sends nothing anywhere except that site. Disconnect removes this link.' : c.kind === 'google' ? 'Lumen sends nothing anywhere except Google. The sign-in is kept encrypted on this computer. Disconnect deletes it and, once no other Google connector uses it, gives it back to Google.' : 'Lumen sends nothing anywhere except this service. The secret is kept encrypted on this computer, and Disconnect deletes it.' }));
    lines.push(h('p', { class: 'note', text: 'What it returns goes into your chat, so it is also sent to the AI you are using (Anthropic, OpenAI, Google, xAI or whichever you picked), like the text of a page.' }));
    if (c.note) lines.push(h('p', { class: 'note', text: c.note }));
    return lines;
  }

  function form(c, render) {
    const msg = h('span', { class: 'note', 'aria-live': 'polite' });
    const inputs = c.fields.map((f) => h('input', {
      type: f.secret ? 'password' : 'text', id: `conn-${c.id}-${f.id}`, 'data-field': f.id, placeholder: f.placeholder, autocomplete: 'off', spellcheck: false,
      'aria-label': `${c.name}: ${f.label}`, value: f.id === 'domain' ? c.config.domain || '' : '',
    }));
    const labelled = c.fields.map((f, i) => h('label', { class: 'conn-field', for: inputs[i].id }, h('span', { text: f.label }), inputs[i], f.help ? h('span', { class: 'note', text: f.help }) : null));
    const chips = h('div', { class: 'conn-chips' });
    if (c.id === 'canvas') {
      C.detect(c.id).then((hosts) => {
        if (!hosts.length) return;
        if (!inputs[0].value && hosts.length === 1) inputs[0].value = hosts[0];
        chips.replaceChildren(h('span', { class: 'note', text: 'Found in your browsing: ' }), ...hosts.map((host) => h('button', { type: 'button', class: 'chip', text: host, onclick: () => { inputs[0].value = host; } })));
      }).catch(() => {});
    }
    const go = h('button', {
      class: 'primary', id: `conn-${c.id}-go`, text: 'Connect', 'aria-label': `Connect ${c.name}`,
      onclick: async () => {
        go.disabled = true;
        go.textContent = c.id === 'gmail' || c.kind === 'google' ? 'Waiting for Google…' : c.oauth ? 'Waiting for your browser…' : 'Connecting…';
        if (c.oauth) flash(note, `Finish signing in to ${c.name}, in the tab that opened in your browser.`, 'ok');
        flash(msg, '');
        try {
          const input = Object.fromEntries(c.fields.map((f, i) => [f.id, inputs[i].value]));
          open = null;
          render(await C.connect(c.id, input));
          if (c.oauth) flash(note, `${c.name} connected.`, 'ok');
          custom?.refresh();
        } catch (err) {
          go.disabled = false;
          go.textContent = 'Connect';
          flash(msg, clean(err), 'error');
        }
      },
    });
    const cancel = h('button', { type: 'button', text: 'Cancel', onclick: () => { open = null; refresh(); } });
    return h('div', { class: 'conn-form' }, ...permissions(c), chips, ...labelled, h('div', { class: 'item' }, go, cancel, msg));
  }

  function cardFor(c, render) {
    const connected = c.status === 'connected' || c.status === 'needs-signin' || c.status === 'bad-token' || c.status === 'error';
    const mcp = c.kind === 'mcp';
    const again = c.status === 'bad-token' || (c.status === 'needs-signin' && (c.id === 'gmail' || c.kind === 'google' || mcp)); // (a sign-in ended: connect it again)
    const status = h('span', { class: `conn-status ${c.status}`, text: c.statusText });
    const buttons = [];
    if (!connected || again) {
      buttons.push(h('button', { class: 'primary', id: `conn-${c.id}-connect`, text: again ? 'Connect again' : 'Connect', 'aria-label': `${again ? 'Connect again' : 'Connect'} ${c.name}`, onclick: () => { open = c.id; refresh(); } }));
    }
    if (mcp && c.mcp) {
      const rf = h('button', { text: 'Refresh tools', 'aria-label': `Refresh the tools of ${c.name}`, onclick: async () => { rf.disabled = true; rf.textContent = 'Starting…'; try { await M.refresh(c.mcp.id); render(await C.list()); } catch (err) { rf.disabled = false; rf.textContent = 'Refresh tools'; flash(note, clean(err), 'error'); } } });
      buttons.push(rf);
    }
    if (c.status === 'needs-signin' && c.kind !== 'google' && !mcp) {
      buttons.push(h('button', { class: 'primary', text: 'Sign in', 'aria-label': `Sign in to ${c.name}`, onclick: async () => { await C.signIn(c.id); flash(note, `Sign in to ${c.name} in the tab that opened, then ask the AI again.`, 'ok'); } }));
    }
    // Gmail: making drafts needs Google's gmail.compose permission, asked for only here (Lumen never sends).
    if (c.drafts === 'off') {
      const allow = h('button', { class: 'primary', id: `conn-${c.id}-drafts`, text: 'Allow drafts', 'aria-label': `Allow ${c.name} drafts`, onclick: async () => {
        allow.disabled = true;
        allow.textContent = 'Waiting for Google…';
        flash(note, 'Google asks in your browser for permission to make drafts. Lumen only makes drafts; it never sends email.', 'ok');
        try { render(await C.allowDrafts(c.id)); flash(note, 'Drafts allowed. The AI can now put emails in your Gmail Drafts, after you allow each one. It never sends.', 'ok'); } catch (err) { allow.disabled = false; allow.textContent = 'Allow drafts'; flash(note, clean(err), 'error'); }
      } });
      buttons.push(allow);
    }
    // Gmail: sending is its own switch under Allow drafts, off until pressed. It needs no new Google permission (gmail.compose covers it).
    if (c.sending) {
      const on = c.sending === 'on';
      const sw = h('button', { id: `conn-${c.id}-sending`, class: on ? '' : 'primary', text: on ? 'Turn off sending' : 'Allow sending', 'aria-pressed': on ? 'true' : 'false', 'aria-label': on ? `Turn off ${c.name} sending` : `Allow ${c.name} sending`, onclick: async () => {
        if (!on && !confirm('Let the AI send email from your Gmail? It still shows you each email and waits for you to press Send, unless you tell it in a chat that it may send without asking. It sends at most 10 an hour, never from background tasks or routines, and every send is listed here.')) return;
        sw.disabled = true;
        try { render(await C.setSending(c.id, !on)); flash(note, on ? 'Sending turned off.' : 'Sending allowed. The AI asks you before each send.', 'ok'); } catch (err) { sw.disabled = false; flash(note, clean(err), 'error'); }
      } });
      buttons.push(sw);
    }
    if (connected) {
      buttons.push(h('button', { id: `conn-${c.id}-disconnect`, text: 'Disconnect', 'aria-label': `Disconnect ${c.name}`, onclick: async () => {
        if (!confirm(`Disconnect ${c.name}? Lumen forgets the saved ${c.kind === 'session' ? 'address' : c.kind === 'google' ? 'Google sign-in' : mcp && c.oauth ? 'sign-in' : 'secret'}; the AI can’t use it until you connect again.`)) return;
        try { render(await C.disconnect(c.id)); flash(note, `${c.name} disconnected.`, 'ok'); custom?.refresh(); } catch (err) { flash(note, clean(err), 'error'); }
      } }));
    }
    const showing = open === c.id;
    return h('div', { class: `conn-card ${c.status}`, 'data-connector': c.id, 'data-status': c.status },
      h('div', { class: 'conn-head' }, badge(c), h('div', { class: 'conn-title' }, h('strong', { text: c.name }), status)),
      h('p', { class: 'conn-summary', text: c.summary }),
      c.drafts === 'on' ? h('p', { class: 'note conn-drafts', text: 'Drafts allowed: the AI can put emails in your Drafts after you allow each one. It never sends.' }) : null,
      c.sending === 'on' ? h('p', { class: 'note conn-sending', text: 'Sending allowed: each email shows on a card and goes only when you press Send. If you say in a chat that it may send without asking, that chat sends to the addresses you typed, after a 10 second Undo. Bypass permissions never skips the card.' }) : null,
      c.sending === 'on' ? sendLogView(c) : null,
      showing ? form(c, render) : h('details', { class: 'conn-details' }, h('summary', { text: 'What it can do' }), ...permissions(c)),
      !showing && c.mcp?.tools.length ? toolsView(c) : null,
      showing ? null : h('div', { class: 'conn-actions' }, ...buttons));
  }

  // A preset's tools, each with Always allow (a tool that reads nothing private may run without asking; a write you may want to keep asking for).
  function toolsView(c) {
    const items = c.mcp.tools.map((t) => {
      const box = h('input', { type: 'checkbox', 'aria-label': `Always allow ${t.name}`, checked: t.always, onchange: async (e) => { try { await M.setAlwaysAllow(`${c.mcp.name}__${t.name}`, e.target.checked); render(await C.list()); } catch (err) { e.target.checked = !e.target.checked; flash(note, clean(err), 'error'); } } });
      return h('li', { title: t.description }, h('label', {}, box, ` ${t.name}`), h('span', { class: 'note', text: t.auto ? ' · read only, runs without asking' : t.always ? ' · always allowed' : '' }));
    });
    return h('details', { class: 'conn-details', id: `conn-${c.id}-tools` }, h('summary', { text: `Tools (${c.mcp.tools.length})` }), h('p', { class: 'note', text: 'Tools the service marks read only run without asking. Ticked tools run without asking, until the AI has read a page in that chat. Everything else asks first.' }), h('ul', { class: 'mcp-tools' }, items));
  }

  // What the AI sent (time, to, subject), newest first: loaded when the section is opened.
  function sendLogView(c) {
    const body = h('div', { class: 'conn-send-log' });
    const d = h('details', { class: 'conn-details', id: `conn-${c.id}-sendlog` }, h('summary', { text: 'Sent by the AI' }), body);
    d.addEventListener('toggle', async () => {
      if (!d.open) return;
      try {
        const rows = await C.sendLog();
        body.replaceChildren(...(rows.length ? rows.map((r) => h('p', { class: 'note', text: `${new Date(r.at).toLocaleString()} · to ${r.to} · “${r.subject}”${r.via === 'typed' ? ' · sent on your word in the chat' : ' · you pressed Send'}` })) : [h('p', { class: 'note', text: 'Nothing sent yet.' })]));
      } catch (err) { body.replaceChildren(h('p', { class: 'note', text: clean(err) })); }
    });
    return d;
  }

  let last = null;
  function render(data) {
    last = data;
    const sections = data.categories.map((cat) => {
      const cards = data.connectors.filter((c) => c.category === cat.id);
      if (!cards.length) return null;
      return h('section', { class: 'conn-cat', 'aria-label': cat.label }, h('h3', { text: cat.label }), h('div', { class: 'conn-grid' }, cards.map((c) => cardFor(c, render))));
    });
    root.replaceChildren(...sections.filter(Boolean));
  }
  function refresh() { if (last) render(last); }

  C.list().then(render).catch((err) => flash(note, clean(err), 'error'));
  custom = buildMcpServers(); // settings-mcp-servers.js
  const el = stackRow('Connectors',
    'Connect a service and the AI in the sidebar and the full-page chat can use it: “what’s due on Canvas this week”, “summarize my unread email”. Anything that changes something, like adding a task, asks you first. Nothing is connected until you press Connect.',
    root, note, custom);
  el.id = 'ai-connectors';
  return el;
}
