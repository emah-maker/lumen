// Connector writes, in plain Node with an injected fetch (nothing leaves the computer): the requests Sheets (append, create) and Drive
// (create_folder) get, the card's editable text and what an edit changes, and the agent's gate: every write shows a card that Bypass
// permissions, Auto-allow and "Always" never answer, background tasks and routines are offered the reads only and refused a write, and
// an outside MCP agent gets no connector tool. (GitHub, Notion and Todoist writes are MCP tools now: they ask on the same kind of card,
// tested with the MCP client in test/e2e/mcpclient.js. Gmail's drafts and sends: gmail-drafts-units.js, gmail-send-units.js; Drive's
// upload: google-connectors-units.js.) The same writes run through a real window in test/e2e/connectors.js.
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

const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
// The shared Google sign-in, stood in for: always signed in with every scope.
const auth = { access: async () => 'AT', invalidate() {}, has: () => true, status: () => ({ connected: true, email: 'ada@example.com', scope: '' }), signIn: async () => ({}), revoke: async () => true, cancel() {} };

// One stand-in for Google's Drive and Sheets: answers by method and path, records every request.
function fakeFetch() {
  const seen = [];
  const mode = { sheets: 'ok' };
  const reply = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const rec = { url: u.href, host: u.host, path: u.pathname, method: opts.method || 'GET', headers: opts.headers || {}, query: Object.fromEntries(u.searchParams), body: opts.body ? JSON.parse(opts.body) : null };
    seen.push(rec);
    if (u.host === 'www.googleapis.com' && u.pathname === '/drive/v3/about') return reply(200, { user: { emailAddress: 'ada@example.com' } });
    if (u.host === 'www.googleapis.com' && u.pathname === '/drive/v3/files' && rec.method === 'POST') return reply(200, { id: 'folder1', name: rec.body.name, webViewLink: 'https://drive.google.com/drive/folders/folder1' });
    if (u.host === 'sheets.googleapis.com') {
      if (rec.method === 'POST' && mode.sheets === 'readonly') return reply(403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } });
      if (rec.method === 'GET' && u.pathname === `/v4/spreadsheets/${SHEET}` && rec.query.fields === 'properties.title') return reply(200, { properties: { title: 'Grades' } });
      if (rec.method === 'GET' && u.pathname === `/v4/spreadsheets/${SHEET}`) return reply(200, { properties: { title: 'Grades' }, sheets: [{ properties: { title: 'Sheet1', gridProperties: { rowCount: 100, columnCount: 26 } } }] });
      if (rec.method === 'POST' && u.pathname === `/v4/spreadsheets/${SHEET}/values/Sheet1:append`) return reply(200, { updates: { updatedRows: rec.body.values.length, updatedRange: 'Sheet1!A5:B6' } });
      if (rec.method === 'POST' && u.pathname === '/v4/spreadsheets') return reply(200, { spreadsheetId: 'NEW1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/NEW1/edit', properties: { title: rec.body.properties.title } });
      return reply(404, { error: { code: 404, message: 'not found' } });
    }
    throw new Error(`unexpected host ${u.host}`);
  };
  return { fetch, seen, mode };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-connector-writes-'));
  const fake = fakeFetch();
  const svc = service.create({ userData: dir, secrets: fakeSecrets, fetch: fake.fetch, workspace: { auth } });
  await svc.connect('drive');
  await svc.connect('sheets');
  const posts = () => fake.seen.filter((r) => r.method !== 'GET').length;

  console.log('--- the tool: writes for a chat, reads only for a background task or routine');
  const full = svc.defs()[0];
  const bg = svc.defs({ readOnly: true })[0];
  check('a chat is offered the writes, marked with !', /create_folder\(name,parent_id\?\)!/.test(full.description) && /append\(id,rows,range\?\)!/.test(full.description) && /create\(title\)!/.test(full.description), full.description);
  check('a background task or routine is offered the reads only, and told nothing can change', !/!/.test(bg.description.replace(/^[^.]*\./, '')) && !/create_folder|append\(|create\(|upload|share_link/.test(bg.description) && /files|tabs/.test(bg.description) && /Read only here/.test(bg.description), bg.description);
  registry.setConnected(['canvas', 'gmail', 'gcal', 'drive', 'sheets']);
  check('every connector connected still fits in under 2.6k characters', JSON.stringify(registry.toolDef()).length < 2600, String(JSON.stringify(registry.toolDef()).length));
  registry.setConnected(['drive', 'sheets']);
  check('no Calendar event is offered (an iCal address is read-only); Gmail’s writes are create_draft and send (send is hidden until Allow sending, test/units/gmail-send-units.js) (test/units/gmail-drafts-units.js)', !Object.values(registry.get('gcal').actions).some((a) => a.write) && Object.entries(registry.get('gmail').actions).filter(([, a]) => a.write).map(([n]) => n).join() === 'create_draft,send', '');

  console.log('--- Sheets: add rows');
  const append = { app: 'sheets', action: 'append', args: { id: `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`, rows: 'Ada | 91\nGrace | 99', range: 'Sheet1' } };
  check('append input is valid with a spreadsheet address', registry.validate(append) === null, registry.validate(append));
  check('a spreadsheet that is not an id or address is refused', /expected form/.test(registry.validate({ app: 'sheets', action: 'append', args: { id: 'https://evil.example/x', rows: 'a' } }) || ''), '');
  const acard = await svc.describeWrite(append);
  check('the card names the spreadsheet by its title (a read only) and shows the rows, with the rows editable', /Grades/.test(acard.detail) && /Ada \| 91/.test(acard.detail) && acard.fields.map((f) => f.key).join() === 'rows' && acard.fields[0].multiline === true, JSON.stringify(acard));
  check('nothing was sent to show the card', fake.seen.filter((r) => r.method === 'POST' && r.host === 'sheets.googleapis.com').length === 0, JSON.stringify(fake.seen.map((r) => r.method + r.path)));
  const ares = await svc.call(append);
  const apost = fake.seen.find((r) => r.method === 'POST' && /:append$/.test(r.path));
  check('append posts the rows as plain text (RAW, never formulas) to the tab, with the sign-in’s token', apost.query.valueInputOption === 'RAW' && JSON.stringify(apost.body.values) === JSON.stringify([['Ada', '91'], ['Grace', '99']]) && apost.headers.Authorization === 'Bearer AT' && /Added 2 rows/.test(ares), JSON.stringify(apost));
  check('…and the result links the sheet', /Link: https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(ares), ares);
  check('an empty rows value is refused with nothing sent, before any card', /rows is empty/.test(await fails(() => svc.describeWrite({ app: 'sheets', action: 'append', args: { id: SHEET, rows: ' \n ' } }))), '');
  fake.mode.sheets = 'readonly';
  const ro = await fails(() => svc.call(append));
  check('a Google refusal is a clear message, not a raw error', /permission|allow/i.test(ro) && !/PERMISSION_DENIED/.test(ro), ro);
  fake.mode.sheets = 'ok';

  console.log('--- Sheets: make a spreadsheet, Drive: make a folder');
  const create = { app: 'sheets', action: 'create', args: { title: 'Lab 5' } };
  const ccard = await svc.describeWrite(create);
  check('the card says it makes a new empty spreadsheet and shows the title, editable', /new empty spreadsheet/i.test(ccard.detail) && /Lab 5/.test(ccard.detail) && ccard.fields.map((f) => f.key).join() === 'title', JSON.stringify(ccard));
  const cres = await svc.call(create);
  check('create posts the title and links the new spreadsheet', JSON.parse(JSON.stringify(fake.seen.find((r) => r.method === 'POST' && r.path === '/v4/spreadsheets').body)).properties.title === 'Lab 5' && /docs\.google\.com\/spreadsheets\/d\/NEW1/.test(cres), cres);
  const folder = { app: 'drive', action: 'create_folder', args: { name: 'Reports' } };
  const fcard = await svc.describeWrite(folder);
  check('the folder card shows its name, editable', /Reports/.test(fcard.detail) && fcard.fields.map((f) => f.key).join() === 'name', JSON.stringify(fcard));
  const fres = await svc.call(folder);
  check('create_folder posts the name as a Drive folder and links it', fake.seen.find((r) => r.method === 'POST' && r.path === '/drive/v3/files').body.mimeType === 'application/vnd.google-apps.folder' && /drive\.google\.com\/drive\/folders\/folder1/.test(fres), fres);

  console.log('--- the card’s edits');
  const edited = registry.applyEdits(append, { rows: 'Edited by me', id: 'other', range: 'Elsewhere' });
  check('an edit changes only the editable text; where it goes stays as the card showed', edited.input.args.rows === 'Edited by me' && edited.input.args.id === append.args.id && edited.input.args.range === 'Sheet1', JSON.stringify(edited));
  check('an edit is checked again (an empty required value is refused)', /Missing argument: rows/.test(registry.applyEdits(append, { rows: '' }).error || ''), JSON.stringify(registry.applyEdits(append, { rows: '' })));
  check('a one-line field stays one line', registry.applyEdits(folder, { name: 'Two\nlines' }).input.args.name === 'Two lines', JSON.stringify(registry.applyEdits(folder, { name: 'Two\nlines' })));
  check('a read has no editable fields', registry.editable({ app: 'sheets', action: 'tabs' }).length === 0, '');

  console.log('--- the agent: every write needs a click on its card');
  const events = [];
  const bypass = { on: true };
  const browser = { connectors: { hasAny: () => true, isWrite: (i) => svc.isWrite(i), describeWrite: (i) => svc.describeWrite(i), defs: (o) => svc.defs(o), call: (i, o) => svc.call(i, o) }, bypassPermissions: () => bypass.on, autoApprove: () => true };
  registry.setConnected(['drive', 'sheets']);
  const agent = new agentLib.Agent(browser, () => null, () => ({}));
  const gate = (extra = {}) => ({ emit: (e) => events.push(e), signal: new AbortController().signal, who: 'Claude', external: false, noAsk: false, run: {}, ...extra });
  const input = { app: 'drive', action: 'create_folder', args: { name: 'From the AI' } };
  const pending = agent.allowConnector(input, gate());
  await new Promise((r) => setTimeout(r, 20));
  const card = events.find((e) => e.type === 'approval');
  check('with Bypass permissions and Auto-allow on, a write still shows a card (no auto-allowed step)', card && card.action === 'tool' && card.note === 'connector' && card.noAlways === true && !events.some((e) => e.name === 'auto_allowed'), JSON.stringify(events));
  check('the card carries what will be sent and the editable text', /From the AI/.test(card.args) && card.fields?.list[0].key === 'name' && card.fields.list[0].value === 'From the AI', JSON.stringify(card));
  const sentBefore = posts();
  agent.resolveApproval(card.approvalId, { edits: { name: 'What I wrote instead' } });
  await pending;
  const out = await agent.runConnector(input);
  const sent = fake.seen.filter((r) => r.method === 'POST').pop();
  check('allowing with an edit sends the edited text', posts() === sentBefore + 1 && sent.body.name === 'What I wrote instead' && /Made the folder/.test(out), JSON.stringify(sent));
  const doneStep = events.find((e) => e.type === 'tool' && e.name === 'connector_done');
  check('the result is a step in the chat with its link', /^Google Drive · /.test(doneStep?.label || '') && /^https:\/\/drive\.google\.com\//.test(doneStep.link || ''), JSON.stringify(doneStep));
  check('a write runs only once per allowed card', /Unknown tool/.test(await fails(() => agent.runConnector(input))), '');
  events.length = 0;
  const denied = agent.allowConnector({ app: 'drive', action: 'create_folder', args: { name: 'No' } }, gate());
  await new Promise((r) => setTimeout(r, 20));
  agent.resolveApproval(events.find((e) => e.type === 'approval').approvalId, false);
  check('denying the card refuses the write', /did not allow/.test(await fails(() => denied)), '');
  events.length = 0;
  const twice = agent.allowConnector({ app: 'sheets', action: 'create', args: { title: 'One' } }, gate());
  await new Promise((r) => setTimeout(r, 20));
  agent.resolveApproval(events.find((e) => e.type === 'approval').approvalId, 'always');
  await twice;
  events.length = 0;
  const again = agent.allowConnector({ app: 'sheets', action: 'create', args: { title: 'Two' } }, gate());
  await new Promise((r) => setTimeout(r, 20));
  check('"always" is not remembered: the next write asks again', events.some((e) => e.type === 'approval'), JSON.stringify(events));
  agent.resolveApproval(events.find((e) => e.type === 'approval').approvalId, false);
  await fails(() => again);
  const reads = { app: 'sheets', action: 'tabs', args: { id: SHEET } };
  events.length = 0;
  await agent.allowConnector(reads, gate());
  check('a read needs no card', !events.some((e) => e.type === 'approval'), JSON.stringify(events));
  check('"agents don\'t ask" (noAsk) refuses a write without a card', /nobody is here to ask/.test(await fails(() => agent.allowConnector({ app: 'drive', action: 'create_folder', args: { name: 'x' } }, gate({ noAsk: true })))), '');
  check('an outside MCP agent gets "Unknown tool" for reads and writes', /Unknown tool/.test(await fails(() => agent.allowConnector(reads, gate({ external: true })))) && /Unknown tool/.test(await fails(() => agent.allowConnector(input, gate({ external: true })))), '');
  check('the connector tool is not in the shared MCP tool list', !agentLib.EXTERNAL_TOOLS.some((t) => t.name === 'connector'), '');

  console.log('--- the agent: background tasks and routines read only');
  const bgAgent = new agentLib.Agent({ ...browser, background: true, bypassPermissions: () => true }, () => null, () => ({}));
  const bgDefs = await bgAgent.externalToolDefs(() => {});
  check('a background run is offered the connector tool without its writes', bgDefs.length === 1 && !/create_folder|append\(|create\(/.test(bgDefs[0].description), JSON.stringify(bgDefs));
  events.length = 0;
  const bgErr = await fails(() => bgAgent.allowConnector({ app: 'sheets', action: 'append', args: { id: SHEET, rows: 'x' } }, gate()));
  check('a write sent anyway is refused with no card, even with Bypass in the background on', /can only read/.test(bgErr) && !events.some((e) => e.type === 'approval'), bgErr);
  await bgAgent.allowConnector(reads, gate());
  check('…while its reads still run', /<untrusted_page_content/.test(await bgAgent.runConnector(reads)), '');
  const n1 = posts();
  check('the service itself refuses a write for a read-only caller, before anything is sent', /can only read/.test(await fails(() => svc.call({ app: 'drive', action: 'create_folder', args: { name: 'x' } }, { readOnly: true }))) && posts() === n1, '');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
