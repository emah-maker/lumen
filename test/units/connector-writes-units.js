// Connector writes, in plain Node with an injected fetch per provider (nothing leaves the computer): the requests GitHub
// (comment, create_issue), Notion (create_page, append) and Todoist (add_task) get, the card's editable text and what an edit
// changes, the messages a read-only token or integration gets, and the agent's gate: every write shows a card that Bypass
// permissions, Auto-allow and "Always" never answer, background tasks and routines are offered the reads only and refused a
// write, and an outside MCP agent gets no connector tool. The same writes run through a real window in test/e2e/connectors.js.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../../src/features/connectors/registry');
const service = require('../../src/features/connectors/service');
const agentLib = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const fails = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message || String(e); } };
const fakeSecrets = { available: () => true, encrypt: (s) => `x${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(1), 'base64').toString() };

const TOKENS = { github: `github_pat_${'A'.repeat(40)}`, notion: `ntn_${'b'.repeat(40)}`, todoist: 'c'.repeat(40) };
const PAGE = '1234567890abcdef1234567890abcdef';

// One stand-in for the three services: answers by method and path, records every request. `mode` switches a service to answering
// as a read-only token would.
function fakeFetch() {
  const seen = [];
  const mode = { github: 'ok', notion: 'ok', notionPatchFailAt: 0 };
  let patches = 0;
  const reply = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const rec = { url: u.href, host: u.host, path: u.pathname, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
    seen.push(rec);
    if (u.host === 'api.github.com') {
      if (u.pathname === '/user') return reply(200, { login: 'ada' });
      if (u.pathname === '/search/issues') return reply(200, { total_count: 0, items: [] });
      if (rec.method === 'POST' && mode.github === 'readonly') return reply(403, { message: 'Resource not accessible by personal access token' });
      if (rec.method === 'POST' && mode.github === 'locked') return reply(403, { message: 'Unable to create comment because issue is locked.' });
      if (rec.method === 'POST' && mode.github === 'archived') return reply(403, { message: 'Repository was archived so is read-only.' });
      if (rec.method === 'POST' && mode.github === 'notfound') return reply(404, { message: 'Not Found' });
      if (rec.method === 'POST' && mode.github === 'oauthread') return reply(404, { message: 'Not Found' }, { 'x-oauth-scopes': 'notifications, read:user' }); // a Sign in with GitHub token without repo
      if (rec.method === 'POST' && mode.github === 'oauthrepo') return reply(404, { message: 'Not Found' }, { 'x-oauth-scopes': 'notifications, read:user, repo' });
      if (rec.method === 'POST' && mode.github === 'rate429') return reply(429, { message: 'Too many requests' });
      if (rec.method === 'POST' && /^\/repos\/ada\/notes\/issues\/7\/comments$/.test(u.pathname)) return reply(201, { id: 1, html_url: 'https://github.com/ada/notes/issues/7#issuecomment-1' });
      if (rec.method === 'POST' && u.pathname === '/repos/ada/notes/issues') return reply(201, { number: 8, title: rec.body.title, html_url: 'https://github.com/ada/notes/issues/8' });
      return reply(404, { message: 'Not Found' });
    }
    if (u.host === 'api.notion.com') {
      if (u.pathname === '/v1/users/me') return reply(200, { bot: { workspace_name: 'Ada’s space' } });
      if (rec.method !== 'GET' && mode.notion === 'readonly') return reply(403, { object: 'error', code: 'restricted_resource' });
      if (rec.method === 'GET' && u.pathname === `/v1/pages/${PAGE}`) return reply(200, { id: PAGE, properties: { title: { type: 'title', title: [{ plain_text: 'Lab notebook' }] } } });
      if (rec.method === 'POST' && u.pathname === '/v1/pages') return reply(200, { id: 'abcdefabcdefabcdefabcdefabcdef12', url: 'https://www.notion.so/Week-7-abcdefabcdefabcdefabcdefabcdef12' });
      if (rec.method === 'PATCH' && /^\/v1\/blocks\/[0-9a-f]{32}\/children$/.test(u.pathname)) {
        patches++;
        if (mode.notionPatchFailAt && patches === mode.notionPatchFailAt) return reply(502, { object: 'error' });
        return reply(200, { results: [] });
      }
      return reply(404, { object: 'error' });
    }
    if (u.host === 'api.todoist.com') {
      if (u.pathname === '/api/v1/user') return reply(200, { email: 'ada@example.com' });
      if (rec.method === 'POST' && u.pathname === '/api/v1/tasks') return reply(200, { id: '6X7rM8997g3RQmvh', content: rec.body.content, priority: 1 });
      return reply(404, '');
    }
    throw new Error(`unexpected host ${u.host}`);
  };
  return { fetch, seen, mode, resetPatches: () => { patches = 0; } };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-connector-writes-'));
  const fake = fakeFetch();
  const svc = service.create({ userData: dir, secrets: fakeSecrets, fetch: fake.fetch });
  for (const id of ['github', 'notion', 'todoist']) await svc.connect(id, { secret: TOKENS[id] });
  const posts = () => fake.seen.filter((r) => r.method !== 'GET').length;

  console.log('--- the tool: writes for a chat, reads only for a background task or routine');
  const full = svc.defs()[0];
  const bg = svc.defs({ readOnly: true })[0];
  check('a chat is offered the writes, marked with !', /comment\(repo,number,body\)!/.test(full.description) && /create_issue\(repo,title,body\?\)!/.test(full.description) && /create_page\(parent_id,title,body\?\)!/.test(full.description) && /append\(page_id,body\)!/.test(full.description) && /add_task\(.*\)!/.test(full.description), full.description);
  check('a background task or routine is offered the reads only, and told nothing can change', !/!/.test(bg.description.replace(/^[^.]*\./, '')) && !/comment|create_issue|create_page|append\(|add_task/.test(bg.description) && /prs|search|tasks/.test(bg.description) && /Read only here/.test(bg.description), bg.description);
  check('every connector connected still fits in under 2.6k characters', JSON.stringify(full).length < 2600, String(JSON.stringify(full).length));
  check('no Calendar event is offered (an iCal address is read-only); Gmail’s writes are create_draft and send (send is hidden until Allow sending, test/units/gmail-send-units.js) (test/units/gmail-drafts-units.js)', !Object.values(registry.get('gcal').actions).some((a) => a.write) && Object.entries(registry.get('gmail').actions).filter(([, a]) => a.write).map(([n]) => n).join() === 'create_draft,send', '');

  console.log('--- GitHub');
  const comment = { app: 'github', action: 'comment', args: { repo: 'ada/notes', number: 7, body: 'Looks good.\n\n- one\n- two' } };
  check('comment input is valid', registry.validate(comment) === null, registry.validate(comment));
  const ccard = await svc.describeWrite(comment);
  check('the comment card shows the repo and number and the whole Markdown body, with the body editable', /Comment on ada\/notes#7/.test(ccard.detail) && ccard.detail.includes('- one\n- two') && ccard.fixed === 'Comment on ada/notes#7' && ccard.fields.length === 1 && ccard.fields[0].key === 'body' && ccard.fields[0].multiline && ccard.fields[0].value === comment.args.body, JSON.stringify(ccard));
  check('nothing was sent to show the card', posts() === 0, JSON.stringify(fake.seen));
  let step = null;
  const cres = await svc.call(comment, { onWritten: (s) => { step = s; } });
  const cpost = fake.seen.find((r) => r.method === 'POST');
  check('comment posts {body} to /repos/ada/notes/issues/7/comments with the token', cpost.path === '/repos/ada/notes/issues/7/comments' && JSON.stringify(cpost.body) === JSON.stringify({ body: comment.args.body }) && cpost.headers.Authorization === `Bearer ${TOKENS.github}` && cpost.headers['Content-Type'] === 'application/json', JSON.stringify(cpost));
  check('the result has the link, and the chat gets a step with it', /Commented on ada\/notes#7/.test(cres) && /Link: https:\/\/github\.com\/ada\/notes\/issues\/7#issuecomment-1/.test(cres) && step?.label === 'GitHub · Commented on ada/notes#7' && step.link === 'https://github.com/ada/notes/issues/7#issuecomment-1', JSON.stringify({ cres, step }));
  const issue = { app: 'github', action: 'create_issue', args: { repo: 'ada/notes', title: 'Dark mode', body: '**Steps**' } };
  const icard = await svc.describeWrite(issue);
  check('the issue card shows the repo, title and body; title and body are editable', /New issue in ada\/notes\nTitle: Dark mode\n\n\*\*Steps\*\*/.test(icard.detail) && icard.fields.map((f) => f.key).join() === 'title,body' && !icard.fields[0].multiline, JSON.stringify(icard));
  const ires = await svc.call(issue);
  const ipost = fake.seen.filter((r) => r.method === 'POST').pop();
  check('create_issue posts {title, body} to /repos/ada/notes/issues and links the issue', ipost.path === '/repos/ada/notes/issues' && ipost.body.title === 'Dark mode' && ipost.body.body === '**Steps**' && /Opened ada\/notes#8/.test(ires) && /github\.com\/ada\/notes\/issues\/8/.test(ires), JSON.stringify({ ipost, ires }));
  check('a repo that climbs out of the path is refused before anything is sent', /expected form/.test(registry.validate({ app: 'github', action: 'comment', args: { repo: '../x', number: 1, body: 'x' } }) || ''), '');
  fake.mode.github = 'readonly';
  const ro = await fails(() => svc.call(comment));
  check('a read-only token gets a clear "give it Read and write" message', /can only read here/.test(ro) && /Read and write/.test(ro) && /connect GitHub again/.test(ro), ro);
  const why = {};
  for (const m of ['locked', 'archived', 'notfound', 'rate429']) { fake.mode.github = m; why[m] = await fails(() => svc.call(comment)); }
  check('a locked conversation, an archived repo, Not Found and a 429 each say what they are, not "can only read"', /locked/.test(why.locked) && /archived/.test(why.archived) && /can’t find/.test(why.notfound) && /limiting requests/.test(why.rate429) && !Object.values(why).some((m) => /can only read/.test(m)), JSON.stringify(why));
  fake.mode.github = 'oauthread';
  const classic = await fails(() => svc.call(comment));
  check('a pasted classic token without repo is told which scope to give it (not sign-in advice)', /This token can’t write/.test(classic) && /public_repo/.test(classic) && /Read and write/.test(classic) && !/Include private repositories/.test(classic), classic);
  const ghProvider = require('../../src/features/connectors/providers/github');
  const sharedCtx = { config: { shared: true }, http: async () => ({ status: 404, ok: false, text: '{"message":"Not Found"}', headers: new Headers({ 'x-oauth-scopes': 'notifications, read:user' }) }) };
  const signin = await fails(() => ghProvider.actions.comment(sharedCtx, comment.args));
  check('a read-only "Sign in with GitHub" token says how to allow writing (Include private repositories, or the GitHub CLI)', /sign-in can only read/.test(signin) && /Include private repositories/.test(signin) && /GitHub CLI/.test(signin), signin);
  fake.mode.github = 'oauthrepo';
  const withRepo = await fails(() => svc.call(comment));
  check('a sign-in token that has repo gets the plain Not Found, not "can only read"', /can’t find/.test(withRepo) && !/can only read/.test(withRepo), withRepo);
  fake.mode.github = 'ok';

  console.log('--- Notion');
  const page = { app: 'notion', action: 'create_page', args: { parent_id: `https://www.notion.so/ada/Lab-notebook-${PAGE}`, title: 'Week 7', body: '# Results\nIt worked.\n- a\n- b\n1. first\n> note' } };
  check('create_page input is valid with a page address as the parent', registry.validate(page) === null, registry.validate(page));
  check('a parent that is not a Notion page id or address is refused', /expected form/.test(registry.validate({ app: 'notion', action: 'create_page', args: { parent_id: 'https://evil.example/x', title: 't' } }) || ''), '');
  const before = posts();
  const pcard = await svc.describeWrite(page);
  check('the card names the parent page by its title (a read only) and shows the title and text', /New page under “Lab notebook” \(1234567890abcdef1234567890abcdef\)/.test(pcard.detail) && /Title: Week 7/.test(pcard.detail) && pcard.fields.map((f) => f.key).join() === 'title,body' && posts() === before, JSON.stringify(pcard));
  const pres = await svc.call(page, { onWritten: (s) => { step = s; } });
  const ppost = fake.seen.find((r) => r.method === 'POST' && r.path === '/v1/pages');
  const types = ppost.body.children.map((b) => b.type).join();
  check('create_page posts the parent, the title and the text as blocks', ppost.body.parent.page_id === PAGE && ppost.body.properties.title.title[0].text.content === 'Week 7' && types === 'heading_1,paragraph,bulleted_list_item,bulleted_list_item,numbered_list_item,quote' && ppost.body.children[0].heading_1.rich_text[0].text.content === 'Results' && ppost.headers['Notion-Version'] === '2022-06-28', JSON.stringify(ppost.body));
  check('…and links the new page', /Added the page “Week 7”/.test(pres) && /notion\.so\/Week-7-/.test(pres) && step?.link?.startsWith('https://www.notion.so/'), JSON.stringify({ pres, step }));
  const long = Array.from({ length: 230 }, (_, i) => `line ${i}`).join('\n');
  const n0 = fake.seen.length;
  await svc.call({ app: 'notion', action: 'append', args: { page_id: PAGE, body: long } });
  const patches = fake.seen.slice(n0).filter((r) => r.method === 'PATCH');
  check('append adds the text to the end of the page, 100 blocks a request, in order', patches.length === 3 && patches.every((r) => r.path === `/v1/blocks/${PAGE}/children`) && patches.map((r) => r.body.children.length).join() === '100,100,30' && patches[2].body.children[29].paragraph.rich_text[0].text.content === 'line 229', patches.map((r) => r.body.children.length).join());
  const big = require('../../src/features/connectors/providers/notion').toBlocks('x'.repeat(4500));
  check('a line longer than Notion takes in one piece is split into pieces of 2000', big.length === 1 && big[0].paragraph.rich_text.map((r) => r.text.content.length).join() === '2000,2000,500', JSON.stringify(big[0].paragraph.rich_text.map((r) => r.text.content.length)));
  const notion = require('../../src/features/connectors/providers/notion');
  check('an address with a ?v= view id or a #block resolves to the page in its path, not the view', notion.pageId(`https://www.notion.so/ada/Lab-${PAGE}?v=ffffffffffffffffffffffffffffffff`) === PAGE && notion.pageId(`https://www.notion.so/${PAGE}#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`) === PAGE && registry.validate({ app: 'notion', action: 'append', args: { page_id: `https://www.notion.so/ada/Lab-${PAGE}?v=ffffffffffffffffffffffffffffffff`, body: 'x' } }) === null, notion.pageId(`https://www.notion.so/ada/Lab-${PAGE}?v=ffffffffffffffffffffffffffffffff`));
  check('an address whose only id is in the query is refused', /expected form/.test(registry.validate({ app: 'notion', action: 'append', args: { page_id: 'https://www.notion.so/ada/Board?v=ffffffffffffffffffffffffffffffff', body: 'x' } }) || ''), '');
  const emoji = notion.toBlocks(`${'a'.repeat(1999)}😀b`)[0].paragraph.rich_text.map((r) => r.text.content);
  check('a split never cuts an emoji in half', emoji.length === 2 && emoji[0].length === 1999 && emoji[1] === '😀b' && emoji.join('') === `${'a'.repeat(1999)}😀b`, JSON.stringify(emoji.map((x) => x.length)));
  fake.mode.notionPatchFailAt = 2;
  fake.resetPatches();
  const partialPage = await fails(() => svc.call({ app: 'notion', action: 'create_page', args: { parent_id: PAGE, title: 'Long', body: Array.from({ length: 250 }, (_, i) => `l${i}`).join('\n') } }));
  check('create_page failing partway says the page was made (with its link) and how many blocks got in, and not to repeat it', /The page was created \(https:\/\/www\.notion\.so\/Week-7-[0-9a-f]{32}\) and 200 of 250 blocks were added/.test(partialPage) && /Don’t repeat this/.test(partialPage), partialPage);
  fake.resetPatches();
  const partialAppend = await fails(() => svc.call({ app: 'notion', action: 'append', args: { page_id: PAGE, body: Array.from({ length: 150 }, (_, i) => `l${i}`).join('\n') } }));
  check('append failing partway says how much was added and not to repeat it', /100 of 150 blocks were added/.test(partialAppend) && /Don’t repeat this/.test(partialAppend) && /notion\.so\/1234567890abcdef/.test(partialAppend), partialAppend);
  fake.mode.notionPatchFailAt = 1;
  fake.resetPatches();
  const firstFails = await fails(() => svc.call({ app: 'notion', action: 'append', args: { page_id: PAGE, body: 'x' } }));
  check('when nothing got in, the error is the plain one', /Notion answered 502/.test(firstFails) && !/repeat/.test(firstFails), firstFails);
  fake.mode.notionPatchFailAt = 0;
  const stop = new AbortController();
  stop.abort();
  const n2 = fake.seen.length;
  const stopped = await svc.describeWrite(page, { signal: stop.signal });
  check('a stopped run’s card makes no title lookup (the run’s signal reaches it), and the card still shows the page id', fake.seen.length === n2 && /New page under \(1234567890abcdef1234567890abcdef\)/.test(stopped.detail), JSON.stringify({ sent: fake.seen.slice(n2), stopped }));
  fake.mode.notion = 'readonly';
  const nro = await fails(() => svc.call({ app: 'notion', action: 'append', args: { page_id: PAGE, body: 'x' } }));
  check('an integration without “Insert content” gets a message that says how to turn it on', /isn’t allowed to add content/.test(nro) && /Insert content/.test(nro), nro);
  fake.mode.notion = 'ok';

  console.log('--- the card’s edits');
  const edited = registry.applyEdits(comment, { body: 'Edited by me', repo: 'evil/repo', number: 99 });
  check('an edit changes only the editable text; where it goes stays as the card showed', edited.input.args.body === 'Edited by me' && edited.input.args.repo === 'ada/notes' && edited.input.args.number === 7, JSON.stringify(edited));
  check('an edit is checked again (an empty required body is refused)', /Missing argument: body/.test(registry.applyEdits(comment, { body: '' }).error || ''), JSON.stringify(registry.applyEdits(comment, { body: '' })));
  check('a one-line field stays one line', registry.applyEdits(issue, { title: 'Two\nlines' }).input.args.title === 'Two lines', JSON.stringify(registry.applyEdits(issue, { title: 'Two\nlines' })));
  check('a read has no editable fields', registry.editable({ app: 'github', action: 'prs' }).length === 0, '');

  console.log('--- the agent: every write needs a click on its card');
  const events = [];
  const bypass = { on: true };
  const browser = { connectors: { hasAny: () => true, isWrite: (i) => svc.isWrite(i), describeWrite: (i) => svc.describeWrite(i), defs: (o) => svc.defs(o), call: (i, o) => svc.call(i, o) }, bypassPermissions: () => bypass.on, autoApprove: () => true };
  registry.setConnected(['github', 'notion', 'todoist']);
  const agent = new agentLib.Agent(browser, () => null, () => ({}));
  const gate = (extra = {}) => ({ emit: (e) => events.push(e), signal: new AbortController().signal, who: 'Claude', external: false, noAsk: false, run: {}, ...extra });
  const input = { app: 'github', action: 'comment', args: { repo: 'ada/notes', number: 7, body: 'From the AI' } };
  const pending = agent.allowConnector(input, gate());
  await new Promise((r) => setTimeout(r, 20));
  const card = events.find((e) => e.type === 'approval');
  check('with Bypass permissions and Auto-allow on, a write still shows a card (no auto-allowed step)', card && card.action === 'tool' && card.note === 'connector' && card.noAlways === true && !events.some((e) => e.name === 'auto_allowed'), JSON.stringify(events));
  check('the card carries what will be sent and the editable text', /From the AI/.test(card.args) && card.fields?.fixed === 'Comment on ada/notes#7' && card.fields.list[0].key === 'body' && card.fields.list[0].value === 'From the AI', JSON.stringify(card));
  const sentBefore = posts();
  agent.resolveApproval(card.approvalId, { edits: { body: 'What I wrote instead', repo: 'other/repo' } });
  await pending;
  const out = await agent.runConnector(input);
  const sent = fake.seen.filter((r) => r.method === 'POST').pop();
  check('allowing with an edit sends the edited text, to the place the card showed', posts() === sentBefore + 1 && sent.body.body === 'What I wrote instead' && sent.path === '/repos/ada/notes/issues/7/comments' && /Commented/.test(out), JSON.stringify(sent));
  const doneStep = events.find((e) => e.type === 'tool' && e.name === 'connector_done');
  check('the result is a step in the chat with its link', doneStep?.label === 'GitHub · Commented on ada/notes#7' && doneStep.link === 'https://github.com/ada/notes/issues/7#issuecomment-1', JSON.stringify(doneStep));
  check('a write runs only once per allowed card', /Unknown tool/.test(await fails(() => agent.runConnector(input))), '');
  events.length = 0;
  const denied = agent.allowConnector({ app: 'github', action: 'comment', args: { repo: 'ada/notes', number: 7, body: 'No' } }, gate());
  await new Promise((r) => setTimeout(r, 20));
  agent.resolveApproval(events.find((e) => e.type === 'approval').approvalId, false);
  check('denying the card refuses the write', /did not allow/.test(await fails(() => denied)), '');
  events.length = 0;
  const twice = agent.allowConnector({ app: 'todoist', action: 'add_task', args: { content: 'One' } }, gate());
  await new Promise((r) => setTimeout(r, 20));
  agent.resolveApproval(events.find((e) => e.type === 'approval').approvalId, 'always');
  await twice;
  events.length = 0;
  const again = agent.allowConnector({ app: 'todoist', action: 'add_task', args: { content: 'Two' } }, gate());
  await new Promise((r) => setTimeout(r, 20));
  check('"always" is not remembered: the next write asks again', events.some((e) => e.type === 'approval'), JSON.stringify(events));
  agent.resolveApproval(events.find((e) => e.type === 'approval').approvalId, false);
  await fails(() => again);
  const reads = { app: 'github', action: 'prs' };
  events.length = 0;
  await agent.allowConnector(reads, gate());
  check('a read needs no card', !events.some((e) => e.type === 'approval'), JSON.stringify(events));
  check('"agents don\'t ask" (noAsk) refuses a write without a card', /nobody is here to ask/.test(await fails(() => agent.allowConnector({ app: 'github', action: 'comment', args: { repo: 'ada/notes', number: 7, body: 'x' } }, gate({ noAsk: true })))), '');
  check('an outside MCP agent gets "Unknown tool" for reads and writes', /Unknown tool/.test(await fails(() => agent.allowConnector(reads, gate({ external: true })))) && /Unknown tool/.test(await fails(() => agent.allowConnector(input, gate({ external: true })))), '');
  check('the connector tool is not in the shared MCP tool list', !agentLib.EXTERNAL_TOOLS.some((t) => t.name === 'connector'), '');

  console.log('--- the agent: background tasks and routines read only');
  const bgAgent = new agentLib.Agent({ ...browser, background: true, bypassPermissions: () => true }, () => null, () => ({}));
  const bgDefs = await bgAgent.externalToolDefs(() => {});
  check('a background run is offered the connector tool without its writes', bgDefs.length === 1 && !/comment|create_issue|create_page|add_task/.test(bgDefs[0].description), JSON.stringify(bgDefs));
  events.length = 0;
  const bgErr = await fails(() => bgAgent.allowConnector({ app: 'notion', action: 'append', args: { page_id: PAGE, body: 'x' } }, gate()));
  check('a write sent anyway is refused with no card, even with Bypass in the background on', /can only read/.test(bgErr) && !events.some((e) => e.type === 'approval'), bgErr);
  await bgAgent.allowConnector(reads, gate());
  check('…while its reads still run', /<untrusted_page_content/.test(await bgAgent.runConnector(reads)), '');
  const n1 = posts();
  check('the service itself refuses a write for a read-only caller, before anything is sent', /can only read/.test(await fails(() => svc.call({ app: 'todoist', action: 'add_task', args: { content: 'x' } }, { readOnly: true }))) && posts() === n1, '');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
