// Settings → Apps and connections: ONE list of the services Lumen can connect to. It used to be two: Connectors (what the AI can use) and Widgets (cards on
// the new tab page), with separate sign-ins for the same Gmail, Calendar and Todoist. A service is now a row with its icon, its name and how it stands
// (Connected · name / Not connected); its page has one Connect (or Disconnect), then two switches, "Show on new tab page" (the card) and "Let the AI use it"
// (the connector), then that service's own options. The list is made from the connector registry (features/connectors/registry.js), so a connector added
// there shows up here by itself, plus the services that only have a card (Spotify, Apple Music, Slack, Meta Muse). Cards that need no account (weather,
// notes, headlines, a clock...) are the "Cards without an account" page (buildWidgets, below in settings.js).
//
// One sign-in, where the code allows it:
//   Gmail      the card and the AI share Lumen's Google sign-in (the card's OAuth store); Connect makes it, both use it.
//   GitHub     one sign-in (the device flow) serves the card and the AI (features/github-auth.js, as before).
//   Todoist    one token: saved for the card, and the connector reads it from there (main.js shared.todoist).
//   Calendar   the card's calendar link and the connector's secret address are separate stores; Connect here saves the connector's, and the card's calendar
//              is made from the same link while it is still in this page.
//   Drive, Sheets   their own Google grant (features/connectors/google-auth.js), asked for when they are connected; the Google client you may type under
//              Advanced is the one both use.
// The AI switch keeps a sign-in when it is turned off (connectors:set-paused); the card switch only hides the card (widgets.remove keepSecret).

const APP_WIDGET_OF = { gmail: 'gmail', gcal: 'calendar', todoist: 'todoist', github: 'github' }; // connector id -> the new-tab card of the same service
const APP_CARD_ONLY = [
  { id: 'spotify', name: 'Spotify', category: 'music', icon: { text: 'S', color: '#1db954' }, type: 'spotify', summary: 'Music that plays in Lumen, with what is playing on the new tab page.' },
  { id: 'applemusic', name: 'Apple Music', category: 'music', icon: { text: 'A', color: '#fa233b' }, type: 'applemusic', summary: 'What is playing in Apple Music, on the new tab page.' },
  { id: 'slack', name: 'Slack', category: 'work', icon: { text: 'S', color: '#611f69' }, type: 'slack', summary: 'Unread messages, mentions and channels on the new tab page.' },
  { id: 'muse', name: 'Meta Muse', category: 'other', icon: { text: 'M', color: '#0866ff' }, type: 'muse', summary: 'A saved question for Meta’s Muse model, on the new tab page.' },
];
const APP_CATEGORIES_EXTRA = [{ id: 'music', label: 'Music' }, { id: 'other', label: 'Other' }];
const SERVICE_TYPES = new Set([...Object.values(APP_WIDGET_OF), ...APP_CARD_ONLY.map((s) => s.type)]); // card kinds that belong to a service (the rest are "Cards without an account")
const APP_OF_TYPE = Object.fromEntries([...Object.entries(APP_WIDGET_OF).map(([id, type]) => [type, id]), ...APP_CARD_ONLY.map((s) => [s.type, s.id])]); // card kind -> service id
const appBadge = (icon, cls = '') => { const b = h('span', { class: `app-icon ${cls}`, 'aria-hidden': 'true', text: icon.text }); b.style.background = icon.color; return b; };

async function buildApps(card) {
  const C = S.ai.connectors;
  const W = S.widgets;
  let data = await C.list();
  let ws = await W.state();
  // A card that is signed in (GitHub, Todoist) makes the connector match, once.
  for (const id of ['todoist', 'github']) {
    const c = data.connectors.find((x) => x.id === id);
    if (c && c.status === 'off' && ws.secrets?.[id]) data = await C.sync(id).catch(() => data);
  }
  const cats = [...data.categories, ...APP_CATEGORIES_EXTRA];
  const services = [
    ...data.connectors.map((c) => ({ id: c.id, name: c.name, category: c.category, icon: c.icon, summary: c.summary, type: APP_WIDGET_OF[c.id] || null, connector: true })),
    ...APP_CARD_ONLY.map((s) => ({ ...s, connector: false })),
  ];
  const connOf = (svc) => data.connectors.find((x) => x.id === svc.id) || null;
  const cardsOf = (svc) => (svc.type ? ws.widgets.filter((w) => w.type === svc.type) : []);
  const pages = new Map(); // service id -> { sync }
  const syncAll = () => { for (const p of pages.values()) p.sync(); refreshValues(); };
  const refresh = async () => { [data, ws] = await Promise.all([C.list(), W.state()]); syncAll(); };

  // How the service stands: the text, whether it is signed in, and whether the sign-in needs doing again.
  function standing(svc) {
    const c = connOf(svc);
    if (c) {
      const on = c.status !== 'off';
      return { text: c.paused ? `${c.statusText} · AI off` : c.statusText, on, again: c.status === 'needs-signin' || c.status === 'bad-token' || c.status === 'error', cls: c.status === 'connected' ? 'ok' : on ? 'err' : '' };
    }
    if (svc.id === 'spotify') {
      const on = Boolean(ws.secrets?.spotify);
      return { text: on ? (ws.spotify?.name ? `Logged in as ${ws.spotify.name}` : 'Logged in') : 'Not logged in', on, again: false, cls: on ? 'ok' : '' };
    }
    if (svc.id === 'slack') {
      const s = ws.slack || {};
      return { text: s.connected && s.reconnect ? 'Needs to be connected again' : s.connected ? `Connected${s.team ? ` to ${s.team}` : ''}` : 'Not connected', on: Boolean(s.connected), again: Boolean(s.connected && s.reconnect), cls: s.connected && !s.reconnect ? 'ok' : s.connected ? 'err' : '' };
    }
    if (svc.id === 'muse') {
      const on = Boolean(ws.secrets?.muse);
      return { text: on ? 'Key saved' : 'No key yet', on, again: false, cls: on ? 'ok' : '' };
    }
    return { text: 'No account needed', on: true, again: false, cls: '', noAccount: true };
  }

  for (const cat of cats) {
    const list = services.filter((s) => s.category === cat.id);
    if (!list.length) continue;
    card.group(cat.label);
    for (const svc of list) buildServicePage(svc);
  }
  card.foot(tr('settings.apps.foot', 'Nothing is connected until you press Connect. Disconnect forgets it.'));

  function buildServicePage(svc) {
    const page = card.subpage(`app-${svc.id}`, svc.name, null, `${svc.summary} ${svc.id} ${svc.name} connect sign in account card widget new tab ai connector`, { icon: appBadge(svc.icon), value: () => standing(svc).text });
    page.pane.querySelector('.pane-title').after(h('p', { class: 'pane-desc app-desc', text: svc.summary })); // (what it is, one line, under the name)
    const id = (part) => `app-${svc.id}-${part}`;
    const c0 = () => connOf(svc);
    const st0 = () => standing(svc);
    const say = (text, cls = 'ok') => flash(msg, text, cls);
    const clean = connClean;

    // ---- Account: status, then Connect or Disconnect
    const statusNote = h('span', { class: 'note', id: id('status'), role: 'status', 'aria-live': 'polite' });
    const msg = h('span', { class: 'note', id: id('message'), role: 'status', 'aria-live': 'polite' });
    const connectBtn = h('button', { class: 'primary', type: 'button', id: `conn-${svc.id}-connect` });
    const disconnectBtn = armedButton('Disconnect', 'Disconnect? Click again', () => doDisconnect(), 'danger', `conn-${svc.id}-disconnect`);
    const accountRow = row(tr('settings.apps.account', 'Account'), null, connectBtn, disconnectBtn);
    accountRow.querySelector('.text').append(statusNote, msg);

    // ---- what Connect needs from you (a token, an address): fields that show while it is not connected
    const fields = svc.id === 'muse' ? [{ id: 'key', label: 'Meta API key', placeholder: 'Paste your Meta API key', secret: true, help: 'Create a key in Meta’s developer console (dev.meta.ai).' }]
      : svc.id === 'github' ? []
        : (c0()?.fields || []);
    const inputs = fields.map((f) => h('input', { type: f.secret ? 'password' : 'text', id: `conn-${svc.id}-${f.id}`, 'data-field': f.id, placeholder: f.placeholder, autocomplete: 'off', spellcheck: false, 'aria-label': `${svc.name}: ${f.label}`, value: f.id === 'domain' ? c0()?.config?.domain || '' : '' }));
    if (svc.id === 'gcal') { const first = cardsOf(svc)[0]?.cals?.find((x) => x.url)?.url; if (first && inputs[0]) inputs[0].value = first; } // the card's calendar link, offered for the AI too
    const fieldRows = fields.map((f, i) => {
      const r = row(f.label, f.help || null, inputs[i]);
      r.classList.add('sub-row');
      if (svc.id === 'canvas') r.querySelector('.text').append(connDetectChips(c0(), inputs[i], C));
      inputs[i].addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); connectBtn.click(); } });
      return r;
    });
    let lastLink = ''; // the calendar link typed in this page: the card is made from it

    // GitHub: one sign-in (the device flow) for the card and the AI.
    let ghRows = [];
    let ghSync = () => {};
    if (svc.id === 'github') {
      const priv = h('input', { type: 'checkbox', class: 'switch', id: id('private'), role: 'switch', 'aria-label': tr('settings.widgets.github.private', 'Include private repositories'), checked: Boolean(ws.github?.wantPrivate) });
      const privRow = row(tr('settings.widgets.github.private', 'Include private repositories'), tr('settings.widgets.github.privateHelp', 'Without this, Lumen asks GitHub only to read who you are and your notifications, so the card shows public repositories. Turning it on also asks for GitHub’s “repo” permission, which GitHub offers only as read and write. The card only reads; with it the AI’s GitHub connector can also comment and open issues, each only after you allow it.'), priv);
      privRow.classList.add('sub-row');
      const code = h('div', { class: 'row stack', id: 'github-code-row', hidden: '' });
      const codeText = h('strong', { id: 'github-code', class: 'gh-user-code' });
      const openDevice = h('button', { type: 'button', id: 'github-open', text: tr('settings.widgets.github.openDevice', 'Open github.com/login/device'), onclick: () => { const u = ws.github?.pending?.url; if (u) S.openUrl(u); } });
      const cancel = h('button', { type: 'button', id: 'github-cancel', text: tr('settings.widgets.github.cancel', 'Cancel'), onclick: async () => { const r = await W.githubCancel(); ws = r?.github ? r : await W.state(); await refresh(); } });
      code.append(codeText, h('span', { class: 'note', text: tr('settings.widgets.github.codeNote', 'Enter this code on github.com/login/device, in the tab Lumen opened, then approve. This fills in when you do.') }), h('div', { class: 'sp-actions' }, openDevice, cancel));
      const cli = h('button', { type: 'button', id: 'github-cli', text: tr('settings.widgets.github.cli', 'Use GitHub CLI sign-in'), onclick: async () => { try { ws = await W.githubCli(); await refresh(); } catch (err) { say(clean(err), 'err'); } } });
      const cliRow = row(tr('settings.widgets.github.cliLabel', 'GitHub CLI'), null, cli);
      cliRow.classList.add('sub-row');
      ghRows = [privRow, code, cliRow];
      ghSync = (on) => {
        const pending = ws.github?.pending;
        code.hidden = !pending;
        codeText.textContent = pending?.code || '';
        privRow.hidden = on || !ws.github?.device || Boolean(pending);
        cliRow.hidden = on || !ws.github?.cli || Boolean(pending);
        priv.checked = priv.checked || Boolean(ws.github?.wantPrivate);
        githubPriv = () => priv.checked;
      };
    }
    let githubPriv = () => false;
    if (svc.id === 'github') fields.push({ id: 'secret', label: 'Access token', secret: true }); // (a token typed under Advanced)

    // ---- what Connect does for each service
    async function doConnect() {
      const vals = Object.fromEntries(fields.map((f, i) => [f.id, inputs[i]?.value || '']));
      switch (svc.id) {
        case 'todoist': {
          const token = vals.secret.trim();
          if (!token) throw new Error('Paste your Todoist API token first.');
          await W.projects(token); // (checks it)
          await W.setSecret('todoist', token); // the card's token; the connector reads it from there
          data = await C.sync('todoist');
          if (data.connectors.find((x) => x.id === 'todoist')?.status === 'off') data = await C.connect('todoist', { secret: token });
          break;
        }
        case 'github': {
          const typed = (vals.secret || '').trim();
          if (typed) { data = await C.connect('github', { secret: typed }); break; }
          const r = await W.githubStart({ privateRepos: githubPriv() });
          if (r?.state) ws = r.state;
          say(tr('settings.widgets.github.waiting', 'Waiting for you to approve it on GitHub…'), '');
          break;
        }
        case 'gcal': {
          lastLink = vals.secret.trim();
          data = await C.connect('gcal', vals);
          break;
        }
        case 'spotify': {
          const r = await W.spotifySignIn(vals.clientId || '');
          say(r.message || (r.ok ? 'Spotify is connected.' : 'Spotify sign-in did not finish.'), r.ok ? 'ok' : 'warn');
          break;
        }
        case 'muse': {
          if (!vals.key.trim()) throw new Error('Paste your Meta API key first.');
          await W.setSecret('muse', vals.key.trim());
          break;
        }
        case 'slack': { openCardEditor(); return; } // (the guided setup is in the card's editor)
        default:
          if (c0()) data = await C.connect(svc.id, vals);
      }
      for (const el of inputs) el.value = '';
      if (c0()?.kind === 'mcp') mcpEl?.refresh?.();
    }
    connectBtn.addEventListener('click', async () => {
      connectBtn.disabled = true;
      say(svc.id === 'gmail' || c0()?.kind === 'google' ? 'Finish signing in with Google, in your browser…' : svc.id === 'github' ? '' : 'Connecting…', 'ok');
      try { await doConnect(); say(st0().on && !st0().again ? `${svc.name} connected.` : '', 'ok'); } catch (err) { say(clean(err), 'err'); }
      connectBtn.disabled = false;
      await refresh();
      if (st0().on && !st0().again) say(`${svc.name} connected.`, 'ok');
    });
    async function doDisconnect() {
      disconnectBtn.button.disabled = true;
      try {
        if (c0()) data = await C.disconnect(svc.id);
        if (svc.id === 'todoist' && ws.secrets?.todoist) await W.setSecret('todoist', '');
        if (svc.id === 'github' && ws.secrets?.github) await W.githubSignOut();
        if (svc.id === 'gmail' && ws.connections?.gmail) await W.gmailDisconnect();
        if (svc.id === 'spotify') await W.spotifyDisconnect();
        if (svc.id === 'slack') await W.slackDisconnect();
        if (svc.id === 'muse') await W.setSecret('muse', '');
        say(`${svc.name} disconnected.`, 'ok');
        if (c0()?.kind === 'mcp') mcpEl?.refresh?.();
      } catch (err) { say(clean(err), 'err'); }
      disconnectBtn.button.disabled = false;
      await refresh();
    }

    // ---- the two switches
    const sw = (key, label, desc, onChange) => {
      const input = h('input', { type: 'checkbox', class: 'switch', id: id(key), role: 'switch', 'aria-label': label });
      const r = row(label, desc, input);
      r.querySelector('.label').addEventListener('click', () => { if (!input.disabled) input.click(); });
      input.addEventListener('change', async () => {
        input.disabled = true;
        try { await onChange(input.checked); } catch (err) { input.checked = !input.checked; say(clean(err), 'err'); }
        input.disabled = false; // (the redraw below disables it again where it should be)
        await refresh();
      });
      return { row: r, input };
    };
    const showSw = svc.type ? sw('show', tr('settings.apps.show', 'Show on new tab page'), tr('settings.apps.showDesc', 'Adds a card to the new tab page.'), async (on) => {
      if (on) {
        const extra = { gmail: { mode: ws.connections?.gmail ? 'oauth' : 'google' }, spotify: { mode: 'status' }, applemusic: { mode: 'status' }, calendar: { cals: [{ name: '', url: lastLink, color: '', enabled: true }] } }[svc.type] || {};
        if (svc.type === 'calendar' && !lastLink) { openCardEditor(null); return; } // (the connector's address can't be read back: the card asks for the link itself)
        const r = await W.save({ type: svc.type, title: '', colors: 'calendar', ...extra });
        ws = r.state;
        say(r.message && !/^Saved/i.test(r.message) ? r.message : 'Added to the new tab page.', 'ok');
      } else {
        const mine = cardsOf(svc);
        if (mine.length > 1 && !confirm(`Take all ${mine.length} ${svc.name} cards off the new tab page? You stay signed in.`)) throw new Error('Kept.');
        for (const w of mine) ws = await W.remove(w.id, { keepSecret: true });
        say('Taken off the new tab page. You stay signed in.', 'ok');
      }
    }) : null;
    const aiSw = svc.connector ? sw('ai', tr('settings.apps.ai', 'Let the AI use it'), tr('settings.apps.aiDesc', 'Lets the AI work with it when you ask.'), async (on) => {
      data = await C.setPaused(svc.id, !on);
      say(on ? `The AI can use ${svc.name}.` : `The AI can’t use ${svc.name} now. You stay signed in.`, 'ok');
    }) : null;
    const needNote = h('span', { class: 'note', text: tr('settings.apps.connectFirst', 'Connect it first.') });
    for (const s of [showSw, aiSw]) if (s) s.row.querySelector('.text').append(needNote.cloneNode(true));

    // ---- the service's own options
    const options = [];
    const cardLink = svc.type ? linkRow(tr('settings.apps.cardOptions', 'New tab card'), { onOpen: () => openCardEditor(cardsOf(svc)[0]), more: 'card options title width colors places units' }) : null;
    if (cardLink) { cardLink.id = id('card'); options.push(cardLink); }
    if (svc.connector && c0()) options.push(row(tr('settings.apps.about', 'What the AI can do'), connAbout(c0())));
    let gmailRows = [];
    if (svc.id === 'gmail') {
      const draftsSw = sw('drafts', tr('settings.apps.drafts', 'Let the AI write drafts'), 'Asks Google for permission to save drafts in your Gmail. The AI never sends them.', async () => {
        data = await C.allowDrafts('gmail');
        say('Drafts allowed. The AI can put emails in your Gmail Drafts, after you allow each one. It never sends.', 'ok');
      });
      draftsSw.input.id = 'conn-gmail-drafts';
      const sendSw = sw('sending', tr('settings.apps.sending', 'Let the AI send email'), 'Each email shows on a card first and goes only when you press Send. At most 10 an hour, never from background tasks, and every send is listed below.', async (on) => {
        if (on && !confirm('Let the AI send email from your Gmail? It still shows you each email and waits for you to press Send, unless you tell it in a chat that it may send without asking. It sends at most 10 an hour, never from background tasks or routines, and every send is listed here.')) throw new Error('Kept off.');
        data = await C.setSending('gmail', on);
        say(on ? 'Sending allowed. The AI asks you before each send.' : 'Sending turned off.', 'ok');
      });
      sendSw.input.id = 'conn-gmail-sending';
      const log = connSendLogView({ id: 'gmail' }, C);
      const logRow = h('div', { class: 'row stack' }, log);
      logRow.id = id('sendlog');
      gmailRows = [draftsSw, sendSw, logRow];
      options.push(draftsSw.row, sendSw.row, logRow);
    }
    let toolsHost = null;
    if (svc.connector && c0()?.kind === 'mcp') { toolsHost = h('div', { class: 'row stack' }); options.push(toolsHost); }

    // ---- Advanced: Google's client (the one Gmail's card and the AI, and Drive and Sheets, sign in through)
    const advanced = [];
    if (svc.id === 'github') {
      const tok = h('input', { type: 'password', id: 'conn-github-secret', autocomplete: 'off', spellcheck: false, placeholder: 'Paste a GitHub token', 'aria-label': 'GitHub access token' });
      inputs.push(tok); // (read by Connect: the last field)
      advanced.push(row(tr('settings.apps.githubToken', 'Use an access token instead'), 'Only if you can’t sign in above: paste a read-only token and press Connect. It is for the AI’s GitHub connector; the new tab card keeps its own sign-in (Card options → Advanced).', tok));
    }
    let ownRows = [];
    if (svc.id === 'gmail' || c0()?.kind === 'google') ownRows = googleClientRows();
    if (ownRows.length) advanced.push(...ownRows);

    // ---- put it together
    page.append(accountRow, ...fieldRows, ...ghRows);
    if (showSw) page.append(showSw.row);
    if (aiSw) page.append(aiSw.row);
    if (options.length) page.group(tr('settings.apps.options', 'Options')).append(...options);
    if (advanced.length) page.append(collapsible(tr('settings.apps.advanced', 'Advanced'), advanced));

    // ---- Google's client: your own Google Cloud client instead of Lumen's (moved here from the Gmail card)
    function googleClientRows() {
      const idIn = h('input', { type: 'text', id: 'app-google-clientid', autocomplete: 'off', spellcheck: false, maxlength: 300, placeholder: '1234567890-abc.apps.googleusercontent.com', 'aria-label': tr('settings.gmail.clientId', 'Google OAuth Client ID') });
      const secretIn = h('input', { type: 'password', id: 'app-google-clientsecret', autocomplete: 'off', spellcheck: false, maxlength: 300, placeholder: ws.secrets?.gmail ? tr('settings.gmail.secretSaved', 'Saved. Paste a new secret to replace it.') : tr('settings.gmail.secretHint', 'Client secret'), 'aria-label': tr('settings.gmail.clientSecret', 'Google OAuth client secret') });
      const drop = h('textarea', { id: 'app-google-json', rows: 3, spellcheck: false, autocomplete: 'off', placeholder: tr('settings.gmail.dropHere', 'Drop the downloaded client JSON file here, or paste its text'), 'aria-label': tr('settings.gmail.dropHere', 'Drop the downloaded client JSON file here, or paste its text') });
      const found = h('span', { class: 'note', role: 'status', id: 'app-google-found' });
      const readClient = async (text) => {
        const r = await W.gmailParseClient(text);
        if (r?.error) { flash(found, r.error, 'warn'); return; }
        idIn.value = r.clientId; secretIn.value = r.clientSecret; drop.value = '';
        flash(found, tr('settings.gmail.clientFound', 'Got the client {id}. Now press Connect with this client.', { id: `${r.clientId.slice(0, 12)}…` }), 'ok');
      };
      drop.addEventListener('paste', (e) => { const t = e.clipboardData?.getData('text'); if (t) { e.preventDefault(); readClient(t); } });
      drop.addEventListener('change', () => { if (drop.value.trim()) readClient(drop.value); });
      drop.addEventListener('dragover', (e) => e.preventDefault());
      drop.addEventListener('drop', async (e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) { if (f.size > 20000) flash(found, tr('settings.gmail.notClientFile', 'That is too big to be a Google client file.'), 'warn'); else readClient(await f.text()); return; }
        const t = e.dataTransfer?.getData('text');
        if (t) readClient(t);
      });
      const go = h('button', { type: 'button', class: 'primary', id: 'app-google-connect', text: tr('settings.apps.ownConnect', 'Connect with this client'), onclick: async () => {
        if (!idIn.value.trim() || !(secretIn.value.trim() || ws.secrets?.gmail)) { flash(found, tr('settings.gmail.needClient', 'First drop the client JSON file above, or type your Client ID and secret.'), 'warn'); drop.focus(); return; }
        go.disabled = true;
        flash(found, tr('settings.gmail.waiting', 'Finish signing in, in your browser. Lumen is waiting…'), 'ok');
        try {
          const r = await W.gmailConnect({ clientId: idIn.value, clientSecret: secretIn.value });
          ws = r.state;
          secretIn.value = '';
          if (svc.id === 'gmail' || !data.connectors.find((x) => x.id === 'gmail')?.status || data.connectors.find((x) => x.id === 'gmail').status === 'off') { try { data = await C.connect('gmail'); } catch { /* the card has it; the AI's Gmail is one press of Connect away */ } }
          flash(found, r.message, 'ok');
        } catch (err) { flash(found, clean(err), /cancel/i.test(clean(err)) ? '' : 'err'); }
        go.disabled = false;
        await refresh();
      } });
      const back = h('button', { type: 'button', id: 'app-google-reset', text: tr('settings.apps.ownReset', 'Use Lumen’s sign-in again'), onclick: async () => { try { ws = await W.gmailDisconnect(); flash(found, tr('settings.gmail.disconnected', 'Disconnected. Google confirmed Lumen no longer has access.'), 'ok'); } catch (err) { flash(found, clean(err), 'err'); } await refresh(); } });
      return [
        row(tr('settings.apps.ownClient', 'Use my own Google client'), tr('settings.apps.ownClientDesc', 'Lumen signs in to Google with its own client. If Google blocks it (“Access blocked”), or you want the 7-day-free setup of your own Google Cloud project, make a client there (Desktop app, with the Gmail, Drive and Sheets APIs on) and give it here. The same client is used for Gmail, Drive and Sheets. Google’s limits for unverified apps then apply: while your project is in Testing, only test users you add can connect, and the connection ends every 7 days.')),
        h('div', { class: 'row stack' }, drop, found),
        row(tr('settings.gmail.clientId', 'Google OAuth Client ID'), tr('settings.gmail.filledByJson', 'Filled in for you when you drop the JSON file; or type it.'), idIn),
        row(tr('settings.gmail.clientSecret', 'Google OAuth client secret'), tr('settings.gmail.secretHelp', 'From the same client. Stored encrypted by your system.'), secretIn),
        row('', null, go, back),
      ];
    }

    // ---- the card's editor: Back comes back here
    function openCardEditor(w = null) {
      if (w) window.__cards?.edit(w, `#app-${svc.id}`);
      else window.__cards?.create(svc.type, `#app-${svc.id}`);
    }

    // ---- redraw from the state
    const sync = () => {
      const st = st0();
      const cc = c0();
      const accountless = Boolean(st.noAccount);
      accountRow.hidden = accountless;
      statusNote.textContent = st.text;
      statusNote.className = `note ${st.cls}`;
      const needsFields = fieldRows.length > 0 && (!st.on || st.again);
      const label = svc.id === 'github' ? tr('settings.widgets.github.signIn', 'Sign in with GitHub') : svc.id === 'spotify' ? tr('settings.apps.spotifyLogin', 'Log in with Spotify') : svc.id === 'slack' ? tr('settings.apps.slackSetup', 'Set up Slack') : cc?.kind === 'google' || svc.id === 'gmail' ? tr('settings.apps.googleSignIn', 'Sign in with Google') : tr('settings.apps.connect', 'Connect');
      connectBtn.textContent = st.again ? tr('settings.apps.connectAgain', 'Connect again') : label;
      connectBtn.setAttribute('aria-label', `${connectBtn.textContent}: ${svc.name}`);
      connectBtn.hidden = st.on && !st.again;
      disconnectBtn.button.hidden = !st.on || accountless;
      for (const r of fieldRows) r.hidden = !needsFields;
      ghSync(st.on && !st.again);
      const pending = svc.id === 'github' && ws.github?.pending;
      connectBtn.hidden = connectBtn.hidden || Boolean(pending);
      if (showSw) {
        const ready = st.on || svc.id === 'spotify' || svc.id === 'applemusic' || (svc.id === 'gmail' && ws.gmailGoogle?.signedIn);
        showSw.input.checked = cardsOf(svc).length > 0;
        showSw.input.disabled = !ready && !showSw.input.checked;
        const open = ready || showSw.input.checked;
        showSw.row.querySelector('.text > .note').hidden = open;
        showSw.row.querySelector('.text > .desc').hidden = !open;
      }
      if (aiSw) {
        aiSw.input.checked = Boolean(cc) && cc.status !== 'off' && !cc.paused;
        aiSw.input.disabled = !cc || cc.status === 'off';
        const open = Boolean(cc) && cc.status !== 'off';
        aiSw.row.querySelector('.text > .note').hidden = open;
        aiSw.row.querySelector('.text > .desc').hidden = !open;
      }
      if (cardLink) {
        const mine = cardsOf(svc);
        cardLink.hidden = !mine.length;
        cardLink.setValue(mine.length ? window.WidgetSummary?.widgetSummary(mine[0], ws) || '' : '');
      }
      if (gmailRows.length) {
        const [draftsSw, sendSw, logRow] = gmailRows;
        const on = cc?.status === 'connected' || cc?.status === 'needs-signin';
        draftsSw.row.hidden = !(on && cc.drafts);
        draftsSw.input.checked = cc?.drafts === 'on';
        draftsSw.input.disabled = cc?.drafts === 'on';
        sendSw.row.hidden = !(on && cc.sending);
        sendSw.input.checked = cc?.sending === 'on';
        logRow.hidden = cc?.sending !== 'on';
      }
      if (toolsHost) toolsHost.replaceChildren(...(cc?.mcp?.tools?.length ? [connToolsView(cc, { M: S.ai.mcpServers, C, say, after: (d) => { data = d; sync(); } })] : []));
      const link = page.link;
      if (link) { link.dataset.state = st.cls || ''; link.dataset.on = st.on ? '1' : ''; }
    };
    pages.set(svc.id, { sync });
    sync();
  }

  // A service's sign-in finished (or ended) somewhere else: a tab, the new tab page's card.
  W.onChanged?.(() => { if (card.el.isConnected) refresh().catch(() => {}); });
  window.addEventListener('focus', () => { if (!document.hidden && document.querySelector('#cat-apps:not([hidden]), [id^="sub-app-"]:not([hidden])')) refresh().catch(() => {}); });

  // ---- Custom MCP servers (a page of its own; anything with an MCP server, beyond the services above)
  const mcpEl = buildMcpServers(); // settings-mcp-servers.js
  slots.get('mcp-servers').append(mcpEl);

  // ---- Cards without an account (weather, a clock, headlines, notes...)
  try { await buildWidgets(slots.get('widgets')); } catch (err) { slots.get('widgets').append(row('Cards', String(err?.message || err))); }
  syncAll();
}
