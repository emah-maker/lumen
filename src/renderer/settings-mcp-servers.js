// Settings → You and AI → Connectors → "Custom MCP servers": servers you add yourself, whose tools the sidebar's AI can use
// (features/mcp-client.js). The ones a Connectors card added (GitHub, Notion, Todoist) are managed on their cards, not here.
// Loaded before settings.js and called from settings-connectors.js; it uses settings.js's h(), stackRow() and flash() helpers.
// Saved secrets never come back to this page: only their names do, and a value left empty when editing keeps the saved one.

function buildMcpServers() {
  const M = window.lumenSettings.ai.mcpServers;
  const list = h('div', { class: 'list', id: 'mcp-servers' });
  const note = h('span', { class: 'note', id: 'mcp-servers-status', 'aria-live': 'polite' });
  const form = h('div', { class: 'mcp-form', id: 'mcp-server-form', hidden: true });
  const add = h('button', { id: 'mcp-server-add', text: 'Add server', onclick: () => openForm(null) });
  const clean = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  // One action on a server: the list is drawn again from its answer; a failure is said on the page instead of leaving a button stuck.
  const act = async (fn, busy) => {
    try { render(await fn()); } catch (err) { if (busy) { busy.disabled = false; } flash(note, clean(err), 'err'); await M.list().then(render).catch(() => {}); }
  };

  const stateText = (s) => (!s.enabled ? 'Off' : s.state === 'ready' ? `Connected · ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}${s.skipped ? ` (${s.skipped} left out)` : ''}`
    : s.state === 'starting' ? 'Starting…' : s.needsAuth && s.auth === 'oauth' ? 'Needs sign-in' : s.state === 'error' ? `Couldn’t start: ${s.error}` : 'Starts when the AI needs it');

  function render(servers) {
    const mine = servers.filter((s) => !s.preset);
    list.replaceChildren(...mine.map((s) => {
      const on = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `Use ${s.name}`, checked: s.enabled, onchange: (e) => act(() => M.setEnabled(s.id, e.target.checked)) });
      const refresh = h('button', { text: 'Refresh', disabled: !s.enabled, onclick: () => { refresh.disabled = true; refresh.textContent = 'Starting…'; act(() => M.refresh(s.id), refresh); } });
      const signIn = s.auth === 'oauth' ? h('button', { class: s.needsAuth ? 'primary' : '', text: s.signedIn && !s.needsAuth ? 'Sign in again' : 'Sign in', onclick: () => { signIn.disabled = true; signIn.textContent = 'Waiting for the browser…'; flash(note, 'Finish signing in, in the tab that opened in your browser.', 'ok'); act(() => M.signIn(s.id), signIn); } }) : null;
      const edit = h('button', { text: 'Edit', onclick: () => openForm(s) });
      const del = h('button', { text: 'Remove', onclick: () => { if (confirm(`Remove ${s.name}?`)) act(() => M.remove(s.id)); } });
      const where = s.type === 'http' ? s.url : [s.command, ...s.args].join(' ');
      const tools = s.tools.length ? h('ul', { class: 'mcp-tools' }, s.tools.map((t) => {
        const always = s.alwaysAllow.includes(t.name);
        const box = h('input', { type: 'checkbox', 'aria-label': `Always allow ${t.name}`, checked: always, onchange: (e) => act(() => M.setAlwaysAllow(`${s.name}__${t.name}`, e.target.checked)) });
        return h('li', { title: t.description }, h('label', {}, box, ` ${t.name}`), h('span', { class: 'note', text: always ? ' · always allowed' : '' }));
      })) : null;
      return h('div', { class: 'snippet', 'data-mcp-server': s.name },
        h('div', { class: 'item' }, h('span', { class: 'grow' }, s.name, h('span', { class: 'note', text: ` · ${stateText(s)}` })), signIn, refresh, edit, del, on),
        h('p', { class: 'note mono', text: where }),
        tools ? h('p', { class: 'note', text: 'Ticked tools run without asking, until the AI has read a page in that chat.' }) : null,
        tools,
        s.state === 'error' && s.log ? h('pre', { class: 'mono code', text: s.log }) : null);
    }));
    if (!mine.length) list.append(h('p', { class: 'note', text: 'No servers of your own yet.' }));
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
    const auth = h('select', { id: 'mcp-form-auth', 'aria-label': 'How it signs you in' },
      h('option', { value: '', text: 'A header (or nothing)' }), h('option', { value: 'oauth', text: 'Sign in with the service (OAuth, in your browser)' }));
    auth.value = s?.auth || '';
    const headerName = h('input', { type: 'text', id: 'mcp-form-header-name', placeholder: 'Header, e.g. Authorization', value: s?.header || '', 'aria-label': 'Header name' });
    const headerValue = h('input', { id: 'mcp-form-header-value', type: 'password', placeholder: s?.header ? 'Saved; type to replace' : 'Value, e.g. Bearer …', 'aria-label': 'Header value' });
    const headerPart = h('div', {}, headerName, headerValue);
    const stdioPart = h('div', {}, command, args, env, h('p', { class: 'note', text: 'It runs with only the variables you list here (plus PATH and your home folder); Lumen’s API keys aren’t passed on. A saved value stays when you leave it empty after =.' }));
    const httpPart = h('div', {}, url, auth, headerPart, h('p', { class: 'note', text: 'https only, or http for a server on this computer. With OAuth, press Sign in on the server after adding it.' }));
    const sync = () => { stdioPart.hidden = type.value !== 'stdio'; httpPart.hidden = type.value !== 'http'; headerPart.hidden = auth.value === 'oauth'; };
    type.addEventListener('change', sync);
    auth.addEventListener('change', sync);
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
          input.auth = auth.value;
          input.header = auth.value !== 'oauth' && headerName.value.trim() ? { name: headerName.value.trim(), value: headerValue.value } : null;
        }
        try {
          render(await M.save(input));
          form.hidden = true;
          add.hidden = false;
          flash(note, s ? 'Saved.' : auth.value === 'oauth' && type.value === 'http' ? 'Added. Press Sign in on it to log in.' : 'Added. It starts the first time the AI needs it, or press Refresh.', 'ok');
        } catch (err) {
          flash(formNote, clean(err), 'err');
        }
      },
    });
    const cancel = h('button', { text: 'Cancel', onclick: () => { form.hidden = true; add.hidden = false; } });
    form.replaceChildren(type, name, stdioPart, httpPart, h('div', { class: 'item' }, saveBtn, cancel, formNote));
    form.hidden = false;
    add.hidden = true;
    name.focus();
  }

  M.list().then(render).catch((err) => flash(note, clean(err), 'err'));
  const el = h('section', { class: 'conn-cat conn-mcp', id: 'ai-mcp-servers', 'aria-label': 'Custom MCP servers' },
    h('h3', { text: 'Custom MCP servers' }),
    h('p', { class: 'note', text: 'Anything with an MCP server, beyond the services above: add its program or address and the AI in the sidebar gets its tools (for API-key models; Claude Code and Grok Build use only Lumen’s own tools). It asks you before each call and shows what it would send; a server only starts when you’ve added and switched it on.' }),
    list, form, h('div', { class: 'item' }, add, note));
  el.refresh = () => M.list().then(render).catch(() => {}); // the Connectors cards changed a server: look again
  return el;
}
