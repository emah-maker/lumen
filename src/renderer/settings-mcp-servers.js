// Settings → You and AI → "Tools from MCP servers": servers whose tools the sidebar's AI can use
// (features/mcp-client.js). Loaded before settings.js and called from its buildAi(); it uses that
// file's h(), row(), stackRow() and flash() helpers. Saved secrets never come back to this page:
// only their names do, and a value left empty when editing keeps the saved one.

function buildMcpServers() {
  const M = window.lumenSettings.ai.mcpServers;
  const list = h('div', { class: 'list', id: 'mcp-servers' });
  const note = h('span', { class: 'note', id: 'mcp-servers-status' });
  const form = h('div', { class: 'mcp-form', id: 'mcp-server-form', hidden: true });
  const add = h('button', { id: 'mcp-server-add', text: 'Add server', onclick: () => openForm(null) });

  const stateText = (s) => (!s.enabled ? 'Off' : s.state === 'ready' ? `Connected · ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}${s.skipped ? ` (${s.skipped} left out)` : ''}`
    : s.state === 'starting' ? 'Starting…' : s.state === 'error' ? `Couldn’t start: ${s.error}` : 'Starts when the AI needs it');

  function render(servers) {
    list.replaceChildren(...servers.map((s) => {
      const on = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `Use ${s.name}`, checked: s.enabled, onchange: async (e) => render(await M.setEnabled(s.id, e.target.checked)) });
      const refresh = h('button', { text: 'Refresh', disabled: !s.enabled, onclick: async () => { refresh.disabled = true; refresh.textContent = 'Starting…'; render(await M.refresh(s.id)); } });
      const edit = h('button', { text: 'Edit', onclick: () => openForm(s) });
      const del = h('button', { text: 'Remove', onclick: async () => { if (confirm(`Remove ${s.name}?`)) render(await M.remove(s.id)); } });
      const where = s.type === 'http' ? s.url : [s.command, ...s.args].join(' ');
      const tools = s.tools.length ? h('ul', { class: 'mcp-tools' }, s.tools.map((t) => {
        const always = s.alwaysAllow.includes(t.name);
        const box = h('input', { type: 'checkbox', 'aria-label': `Always allow ${t.name}`, checked: always, onchange: async (e) => render(await M.setAlwaysAllow(`${s.name}__${t.name}`, e.target.checked)) });
        return h('li', { title: t.description }, h('label', {}, box, ` ${t.name}`), h('span', { class: 'note', text: always ? ' · always allowed' : '' }));
      })) : null;
      return h('div', { class: 'snippet', 'data-mcp-server': s.name },
        h('div', { class: 'item' }, h('span', { class: 'grow' }, s.name, h('span', { class: 'note', text: ` · ${stateText(s)}` })), refresh, edit, del, on),
        h('p', { class: 'note mono', text: where }),
        tools ? h('p', { class: 'note', text: 'Ticked tools run without asking, until the AI has read a page in that chat.' }) : null,
        tools,
        s.state === 'error' && s.log ? h('pre', { class: 'mono code', text: s.log }) : null);
    }));
    if (!servers.length) list.append(h('p', { class: 'note', text: 'No servers yet.' }));
  }

  function openForm(s) {
    const type = h('select', { id: 'mcp-form-type', 'aria-label': 'Kind' },
      h('option', { value: 'stdio', text: 'A program on this computer (stdio)' }), h('option', { value: 'http', text: 'An address (streamable HTTP)' }));
    type.value = s?.type || 'stdio';
    const name = h('input', { type: 'text', id: 'mcp-form-name', placeholder: 'Name, e.g. github', value: s?.name || '', 'aria-label': 'Name' });
    const command = h('input', { type: 'text', id: 'mcp-form-command', placeholder: 'Command, e.g. npx', value: s?.command || '', 'aria-label': 'Command' });
    const args = h('textarea', { id: 'mcp-form-args', rows: 3, placeholder: 'Arguments, one per line', 'aria-label': 'Arguments' });
    args.value = (s?.args || []).join('\n');
    const env = h('textarea', { id: 'mcp-form-env', rows: 3, placeholder: 'Variables it needs, one per line: NAME=value', 'aria-label': 'Environment variables' });
    env.value = (s?.env || []).map((n) => `${n}=`).join('\n');
    const url = h('input', { type: 'url', id: 'mcp-form-url', placeholder: 'https://…', value: s?.url || '', 'aria-label': 'Address' });
    const headerName = h('input', { type: 'text', id: 'mcp-form-header-name', placeholder: 'Header, e.g. Authorization', value: s?.header || '', 'aria-label': 'Header name' });
    const headerValue = h('input', { id: 'mcp-form-header-value', type: 'password', placeholder: s?.header ? 'Saved; type to replace' : 'Value, e.g. Bearer …', 'aria-label': 'Header value' });
    const stdioPart = h('div', {}, command, args, env, h('p', { class: 'note', text: 'It runs with only the variables you list here (plus PATH and your home folder); Lumen’s API keys aren’t passed on. A saved value stays when you leave it empty after =.' }));
    const httpPart = h('div', {}, url, headerName, headerValue, h('p', { class: 'note', text: 'https only, or http for a server on this computer.' }));
    const sync = () => { stdioPart.hidden = type.value !== 'stdio'; httpPart.hidden = type.value !== 'http'; };
    type.addEventListener('change', sync);
    sync();
    const formNote = h('span', { class: 'note' });
    const saveBtn = h('button', {
      id: 'mcp-form-save',
      class: 'primary',
      text: s ? 'Save' : 'Add',
      onclick: async () => {
        const input = { id: s?.id, name: name.value, type: type.value };
        if (type.value === 'stdio') {
          input.command = command.value;
          input.args = args.value.split(/\r?\n/).map((a) => a.trim()).filter(Boolean);
          input.env = env.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
            const i = l.indexOf('=');
            return i < 0 ? { name: l, value: '' } : { name: l.slice(0, i).trim(), value: l.slice(i + 1) };
          });
        } else {
          input.url = url.value;
          input.header = headerName.value.trim() ? { name: headerName.value.trim(), value: headerValue.value } : null;
        }
        try {
          render(await M.save(input));
          form.hidden = true;
          add.hidden = false;
          flash(note, s ? 'Saved.' : 'Added. It starts the first time the AI needs it, or press Refresh.', 'ok');
        } catch (err) {
          flash(formNote, String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
        }
      },
    });
    const cancel = h('button', { text: 'Cancel', onclick: () => { form.hidden = true; add.hidden = false; } });
    form.replaceChildren(type, name, stdioPart, httpPart, h('div', { class: 'item' }, saveBtn, cancel, formNote));
    form.hidden = false;
    add.hidden = true;
    name.focus();
  }

  M.list().then(render).catch((err) => flash(note, err.message, 'err'));
  const el = stackRow('Tools from MCP servers',
    'Give the AI in the sidebar tools from MCP servers you trust (for API-key models; Claude Code and Grok Build use only Lumen’s own tools). It asks you before each call and shows what it would send; a server only starts when you’ve added and switched it on.',
    list, form, h('div', { class: 'item' }, add, note));
  el.id = 'ai-mcp-servers';
  return el;
}
