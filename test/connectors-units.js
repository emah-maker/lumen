// Connectors, in plain Node with no real network: the registry and the one `connector` tool's size and input checks, then the
// service against stand-in services on 127.0.0.1 (test/fixtures/fake-connectors.js): connect, calls, writes, disconnect, and what
// is stored on disk. The same flow runs through the AI in test/connectors.js.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../src/features/connectors/registry');
const service = require('../src/features/connectors/service');
const { startFakes, TOKENS, COOKIE } = require('./fixtures/fake-connectors');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const fails = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message || String(e); } };
const fakeSecrets = { available: () => true, encrypt: (s) => `x${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(1), 'base64').toString() };

async function main() {
  console.log('--- registry');
  const ids = registry.CONNECTORS.map((c) => c.id);
  check('ids are unique and every connector has a name, icon, summary, category and kind', new Set(ids).size === ids.length && registry.CONNECTORS.every((c) => c.name && c.icon?.text && c.icon?.color && c.summary && registry.CATEGORIES.some((k) => k.id === c.category) && ['session', 'token', 'oauth', 'mcp', 'soon'].includes(c.kind)), ids.join());
  check('the asked-for categories exist', ['Mail and calendar', 'School', 'Files and docs', 'Work', 'Tasks', 'Music'].every((l) => registry.CATEGORIES.some((k) => k.label === l)), JSON.stringify(registry.CATEGORIES));
  check('the starting set is there: Canvas, Gmail, Calendar, GitHub, Todoist, Notion, Slack (an MCP preset)', ['canvas', 'gmail', 'gcal', 'github', 'todoist', 'notion', 'slack'].every((id) => registry.get(id)) && registry.get('slack').kind === 'mcp' && registry.get('canvas').kind === 'session' && registry.get('github').kind === 'token', ids.join());
  check('a connector not ready yet is shown as soon and offers no action', registry.CONNECTORS.filter((c) => c.kind === 'soon').every((c) => !Object.keys(c.actions).length) && registry.get('drive').kind === 'soon', '');
  check('every connector says what it reads, and a connector that writes says what', registry.CONNECTORS.filter((c) => c.kind !== 'soon').every((c) => c.reads.length) && registry.get('todoist').does.length === 1 && Object.values(registry.get('todoist').actions).filter((a) => a.write).length === 1, '');
  check('write actions are marked, and only add_task is one', registry.CONNECTORS.flatMap((c) => Object.entries(c.actions).filter(([, a]) => a.write).map(([n]) => `${c.id}.${n}`)).join() === 'todoist.add_task', '');

  console.log('--- the one tool');
  registry.setConnected([]);
  check('nothing connected: no tool at all', registry.toolDef() === null, JSON.stringify(registry.toolDef()));
  registry.setConnected(['canvas']);
  const one = registry.toolDef();
  check('one connector connected: the tool names only it', one.name === 'connector' && /canvas:/.test(one.description) && !/github:|gmail:|todoist:/.test(one.description) && JSON.stringify(one.input_schema.properties.app.enum) === '["canvas"]', one.description);
  registry.setConnected(['canvas', 'gmail', 'gcal', 'github', 'notion', 'todoist']);
  const all = registry.toolDef();
  check('every connector connected: one tool, still compact (under 2.4k characters)', JSON.stringify(all).length < 2400, String(JSON.stringify(all).length));
  check('one connector costs under 0.7k characters', (registry.setConnected(['canvas']), JSON.stringify(registry.toolDef()).length) < 700, String(JSON.stringify(registry.toolDef()).length));
  registry.setConnected(['canvas', 'gmail', 'gcal', 'github', 'notion', 'todoist']);
  check('the description lists each action with its arguments and marks the writes with !', /add_task\(content,due\?,project_id\?\)!/.test(all.description) && /announcement\(course_id,id\)/.test(all.description) && /upcoming\(days\?,course_id\?\)/.test(all.description), all.description);
  check('the schema is three short properties', Object.keys(all.input_schema.properties).join() === 'app,action,args' && all.input_schema.required.join() === 'app,action', JSON.stringify(all.input_schema));
  const ok = (input) => registry.validate(input);
  check('valid calls pass', ok({ app: 'canvas', action: 'upcoming', args: { days: 7 } }) === null && ok({ app: 'canvas', action: 'courses' }) === null && ok({ app: 'github', action: 'help' }) === null, '');
  check('an app that is not connected, or does not exist, is refused with what is connected', /Unknown app/.test(ok({ app: 'slack', action: 'x' })) && /Connected: canvas/.test(ok({ app: 'nope', action: 'x' })), ok({ app: 'nope', action: 'x' }));
  check('an unknown action lists the real ones', /Actions: courses, upcoming/.test(ok({ app: 'canvas', action: 'delete' })), ok({ app: 'canvas', action: 'delete' }));
  check('a missing required argument is named', ok({ app: 'github', action: 'pr', args: { repo: 'ada/x' } }) === 'Missing argument: number' && ok({ app: 'todoist', action: 'add_task', args: {} }) === 'Missing argument: content', '');
  const sloppy = { app: 'canvas', action: 'upcoming', args: { days: '5' } };
  check('a number sent as text is accepted and fixed; out of range or fractional is not', ok(sloppy) === null && sloppy.args.days === 5 && /between 1 and 90/.test(ok({ app: 'canvas', action: 'upcoming', args: { days: 500 } })) && /whole number/.test(ok({ app: 'canvas', action: 'upcoming', args: { days: 1.5 } })), '');
  check('an enum and a pattern are enforced', /one of: author, review, assigned/.test(ok({ app: 'github', action: 'prs', args: { role: 'admin' } })) && /expected form/.test(ok({ app: 'github', action: 'pr', args: { repo: '../../etc', number: 1 } })), '');
  check('args that are not an object, and input that is not an object, are refused', /must be an object/.test(ok({ app: 'canvas', action: 'courses', args: [] })) && /must be an object/.test(ok('x')) && /must be an object/.test(ok(null)), '');
  check('the step line reads "Using Canvas · Upcoming assignments"', registry.stepLabel({ app: 'canvas', action: 'upcoming' }) === 'Using Canvas · Upcoming assignments' && registry.stepLabel({ app: 'todoist', action: 'add_task' }) === 'Using Todoist · Add a task' && registry.stepLabel({ app: 'github', action: 'pr' }) === 'Using GitHub · Read a pull request', registry.stepLabel({ app: 'canvas', action: 'upcoming' }));
  check('field checks: tokens by shape, calendar addresses by https', registry.checkField(registry.get('github').fields[0], 'nope').error && !registry.checkField(registry.get('github').fields[0], TOKENS.github).error && registry.checkField(registry.get('gcal').fields[0], 'http://example.com/x.ics').error && registry.checkField(registry.get('gcal').fields[0], 'webcal://example.com/x.ics').value === 'https://example.com/x.ics', '');
  check('Canvas addresses: with or without https, a page address works, junk does not', registry.cleanDomain('https://northeastern.instructure.com/courses/1') === 'northeastern.instructure.com' && registry.cleanDomain('School.Instructure.com') === 'school.instructure.com' && registry.cleanDomain('not a domain') === '' && registry.cleanDomain('javascript:alert(1)') === '', '');

  console.log('--- the service, against stand-in services');
  const fakes = await startFakes();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-connectors-'));
  let signedIn = false;
  const changes = [];
  const requestedHosts = new Set();
  const realFetch = globalThis.fetch;
  const seenUrls = [];
  const trackedFetch = (url, opts) => { seenUrls.push(String(url)); requestedHosts.add(new URL(url).host); return realFetch(url, opts); };
  const googleFake = { oauth: false, session: true, calls: [] };
  const google = {
    status: async () => ({ oauth: googleFake.oauth, oneClick: false, session: googleFake.session, email: 'ada@example.com' }),
    api: async (p) => {
      googleFake.calls.push(p);
      if (p.startsWith('/users/me/messages?')) return { messages: [{ id: '18c0ffee01' }] };
      if (p.startsWith('/users/me/messages/18c0ffee01') && p.includes('format=full')) return { id: '18c0ffee01', snippet: 'hi', payload: { headers: [{ name: 'From', value: 'Prof <prof@school.edu>' }, { name: 'To', value: 'ada@example.com' }, { name: 'Subject', value: 'Grades' }, { name: 'Date', value: 'Mon, 5 Oct 2026' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Your grade is final.').toString('base64url') } }] } };
      return { id: '18c0ffee01', snippet: 'Your grade', internalDate: String(Date.now()), labelIds: ['UNREAD'], payload: { headers: [{ name: 'From', value: 'Prof <prof@school.edu>' }, { name: 'Subject', value: 'Grades' }] } };
    },
    feed: async () => ({ status: 200, body: '<?xml version="1.0"?><feed xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for ada@example.com</title><fullcount>1</fullcount><entry><title>Welcome week</title><summary>See you there</summary><link rel="alternate" href="https://mail.google.com/mail?account_id=a&amp;message_id=18c0ffee02&amp;view=conv"/><modified>2026-10-05T10:00:00Z</modified><id>tag:gmail.google.com,2004:1</id><author><name>Dean</name><email>dean@school.edu</email></author></entry></feed>' }),
    connect: async () => { throw new Error('no client'); },
    disconnect: async () => { googleFake.disconnected = true; },
  };
  const mcpFake = { servers: [], list() { return this.servers; }, save(input) { this.saved = input; this.servers = [{ id: 'srv1', name: input.name }]; return this.servers; }, remove(id) { this.removed = id; this.servers = []; return []; } };
  const make = () => service.create({
    userData, secrets: fakeSecrets, fetch: trackedFetch,
    sessionFetch: (url, opts) => trackedFetch(url, { ...opts, headers: { ...opts.headers, ...(signedIn ? { Cookie: COOKIE } : {}) } }),
    endpoints: () => ({ canvas: fakes.urls.canvas, github: fakes.urls.github, todoist: fakes.urls.todoist, notion: fakes.urls.notion }),
    detectHosts: async () => ['www.example.com', 'northeastern.instructure.com', 'canvas.other.edu'], google, mcp: mcpFake, onChange: () => changes.push(1), testLoopback: true,
  });
  let svc = make();
  check('a fresh profile: nothing connected, the AI gets no tool, the page gets every card', !svc.hasAny() && svc.defs().length === 0 && svc.list().connectors.length === registry.CONNECTORS.length && svc.list().connectors.every((c) => (c.status === 'soon' ? c.statusText === 'Coming soon' : c.status === 'off' && c.statusText === 'Not connected')), JSON.stringify(svc.list().connectors.map((c) => c.status)));
  check('Canvas: the address is found from browsing, and only Canvas-looking hosts are offered', JSON.stringify(await svc.detect('canvas')) === '["northeastern.instructure.com","canvas.other.edu"]', JSON.stringify(await svc.detect('canvas')));

  // Canvas: a session connector
  check('Canvas: asking to connect without an address (and two guesses) says what to enter', /Canvas address/.test(await fails(() => svc.connect('canvas', { domain: '' }))), '');
  check('Canvas: an address that is not one is refused', /Canvas address/.test(await fails(() => svc.connect('canvas', { domain: 'x y' }))), '');
  await svc.connect('canvas', { domain: 'school.instructure.com' });
  let card = svc.list().connectors.find((c) => c.id === 'canvas');
  check('Canvas, signed out: connected but "Needs sign-in" (the address is kept; nothing else is)', card.status === 'needs-signin' && card.statusText === 'Needs sign-in' && card.config.domain === 'school.instructure.com' && svc.hasAny(), JSON.stringify(card));
  const signedOutText = await fails(() => svc.call({ app: 'canvas', action: 'courses' }));
  check('Canvas, signed out: a call says to sign in, and the redirect to the login page is not followed', /isn’t signed in/.test(signedOutText) && fakes.seen.filter((r) => r.service === 'canvas' && r.url.includes('login')).length === 0, signedOutText);
  signedIn = true;
  const signedInAt = fakes.seen.length;
  await svc.connect('canvas', { domain: 'school.instructure.com' });
  card = svc.list().connectors.find((c) => c.id === 'canvas');
  check('Canvas, signed in: "Connected · Ada Student"', card.status === 'connected' && card.statusText === 'Connected · Ada Student', JSON.stringify(card));
  check('the AI now has one tool, naming only Canvas', svc.defs().length === 1 && svc.defs()[0].name === 'connector' && /canvas:/.test(svc.defs()[0].description) && !/github:/.test(svc.defs()[0].description), svc.defs()[0]?.description);
  const courses = await svc.call({ app: 'canvas', action: 'courses' });
  check('courses: both pages of the list (Link: next is followed), marked as untrusted data', /source="connector:canvas\/courses"/.test(courses) && /101\s+Fundamentals of Computer Science \(CS 2500\)/.test(courses) && /202\s+Linear Algebra/.test(courses) && /while\(1\)/.test(courses) === false, courses);
  const upcoming = await svc.call({ app: 'canvas', action: 'upcoming', args: { days: 14 } });
  check('upcoming: assignments with course, points and due time, soonest first', upcoming.indexOf('Lab 5 report') > 0 && upcoming.indexOf('Lab 5 report') < upcoming.indexOf('Problem Set 3') && /Lab 5 report \(Fundamentals of Computer Science\) · 100 pts/.test(upcoming) && /Problem Set 3 \(Linear Algebra\) · 40 pts/.test(upcoming), upcoming);
  check('upcoming for one course asks only for that course', (await svc.call({ app: 'canvas', action: 'upcoming', args: { course_id: '202' } })).includes('Problem Set 3') && !(await svc.call({ app: 'canvas', action: 'upcoming', args: { course_id: '202' } })).includes('Lab 5'), '');
  const news = await svc.call({ app: 'canvas', action: 'announcements', args: {} });
  check('announcements: titles with a short plain-text start, the ids to read one, no markup or script', /\[course 101, id 5001\]/.test(news) && /Exam moved to Friday: The midterm is now Friday at 10am\./.test(news) && !/<|evil\(\)/.test(news.replace(/<\/?untrusted_page_content[^>]*>/g, '')), news);
  const full = await svc.call({ app: 'canvas', action: 'announcement', args: { course_id: '101', id: '5001' } });
  check('read an announcement: the full text, by the instructor', /Exam moved to Friday/.test(full) && /Prof\. Hopper/.test(full) && /- Room 210/.test(full), full);
  check('text in a page that tries to steer the AI stays inside the untrusted wrapper', /<untrusted_page_content source="connector:canvas\/announcements">[\s\S]*Ignore previous instructions[\s\S]*<\/untrusted_page_content>$/.test(news), news);
  check('a course id that is not a number is refused before anything is sent', /numbers? from the course list/.test(await fails(() => svc.call({ app: 'canvas', action: 'upcoming', args: { course_id: '../x' } }))), '');
  check('an announcement that does not exist says so', /nothing there/i.test(await fails(() => svc.call({ app: 'canvas', action: 'announcement', args: { course_id: '101', id: '999' } }))), '');
  const before = fakes.seen.length;
  await svc.call({ app: 'canvas', action: 'courses' });
  check('the same read twice in a row is one request (30 s cache)', fakes.seen.length === before, `${fakes.seen.length - before} extra`);
  check('Canvas requests carry the session cookie and no Authorization header', fakes.seen.slice(signedInAt).filter((r) => r.service === 'canvas').every((r) => r.cookie.includes(COOKIE) && !r.auth), JSON.stringify(fakes.seen.filter((r) => r.service === 'canvas')[0]));

  // GitHub: a token connector
  check('GitHub: a token that does not look like one is refused before it is sent anywhere', /doesn’t look like a GitHub token/.test(await fails(() => svc.connect('github', { secret: 'hunter2' }))) && !fakes.seen.some((r) => r.service === 'github'), '');
  const wrongToken = 'github_pat_WRONG0123456789abcdefghij';
  check('GitHub: a well-formed token that GitHub refuses is not saved', /refused that token/.test(await fails(() => svc.connect('github', { secret: wrongToken }))) && !fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8').includes('"github"'), '');
  await svc.connect('github', { secret: TOKENS.github });
  check('GitHub: connected as the token’s owner', svc.list().connectors.find((c) => c.id === 'github').statusText === 'Connected · ada-dev', JSON.stringify(svc.list().connectors.find((c) => c.id === 'github')));
  const onDisk = fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8');
  check('the token on disk is encrypted: no plaintext, only a sealed value', !onDisk.includes(TOKENS.github) && /"secret": "x/.test(onDisk) && !JSON.stringify(svc.list()).includes(TOKENS.github), onDisk);
  const prs = await svc.call({ app: 'github', action: 'prs' });
  check('my pull requests: repo, number, title, author', /ada\/lumen-notes#12 Add dark mode \(ada-dev\)/.test(prs) && /#9 Fix typo/.test(prs), prs);
  check('the search asks for the token owner’s open pull requests', fakes.seen.some((r) => r.service === 'github' && decodeURIComponent(r.url).includes('is:pr') && decodeURIComponent(r.url).includes('author:@me') && decodeURIComponent(r.url).includes('is:open')), JSON.stringify(fakes.seen.filter((r) => r.service === 'github').map((r) => r.url)));
  check('my issues, assigned to me by default', /#3 Crash on start/.test(await svc.call({ app: 'github', action: 'issues' })) && fakes.seen.some((r) => decodeURIComponent(r.url).includes('assignee:@me')), '');
  const pr = await svc.call({ app: 'github', action: 'pr', args: { repo: 'ada/lumen-notes', number: 12 } });
  check('read a pull request: state, branches, size, description and changed files', /Add dark mode/.test(pr) && /open · by ada-dev · dark into main/.test(pr) && /2 files, \+30 -4/.test(pr) && /added src\/theme\.js \(\+28 -0\)/.test(pr), pr);
  check('GitHub requests carry the token in a header, never the cookie', fakes.seen.filter((r) => r.service === 'github').every((r) => r.auth.startsWith('Bearer github_pat_') && !r.cookie), '');
  check('a pull request that does not exist is a plain message', /can’t find that/.test(await fails(() => svc.call({ app: 'github', action: 'pr', args: { repo: 'ada/none', number: 1 } }))), '');

  // Todoist: read, and one write
  await svc.connect('todoist', { secret: TOKENS.todoist });
  check('Todoist: connected as the account’s e-mail', svc.list().connectors.find((c) => c.id === 'todoist').statusText === 'Connected · ada@example.com', '');
  const tasks = await svc.call({ app: 'todoist', action: 'tasks' });
  check('tasks: id, text, due date and priority', /9001\s+Read chapter 4 · due \d{4}-\d{2}-\d{2} · p2/.test(tasks) && /9002\s+Email the TA/.test(tasks), tasks);
  check('add_task is a write, and the confirm card says exactly what will be added', svc.isWrite({ app: 'todoist', action: 'add_task' }) && !svc.isWrite({ app: 'todoist', action: 'tasks' }) && /Add this task to Todoist:\nBuy a stapler\nDue: tomorrow 9am/.test(svc.describeWrite({ app: 'todoist', action: 'add_task', args: { content: 'Buy a stapler', due: 'tomorrow 9am' } }).detail), JSON.stringify(svc.describeWrite({ app: 'todoist', action: 'add_task', args: { content: 'Buy a stapler', due: 'tomorrow 9am' } })));
  check('nothing was posted before the write ran', !fakes.seen.some((r) => r.service === 'todoist' && r.method === 'POST'), '');
  const added = await svc.call({ app: 'todoist', action: 'add_task', args: { content: 'Buy a stapler', due: 'tomorrow 9am' } });
  check('add_task posts the task and says what it made', /Added: \d+\s+Buy a stapler/.test(added) && JSON.parse(fakes.seen.find((r) => r.service === 'todoist' && r.method === 'POST').body).due_string === 'tomorrow 9am', added);
  check('after a write the next read is fresh, not the cached list', /Buy a stapler/.test(await svc.call({ app: 'todoist', action: 'tasks' })), '');

  // Notion and Calendar
  await svc.connect('notion', { secret: TOKENS.notion });
  const search = await svc.call({ app: 'notion', action: 'search', args: { query: 'plan' } });
  check('Notion: search lists pages with their ids', /a1b2c3d4e5f60718293a4b5c6d7e8f90\s+Project plan · page/.test(search), search);
  const page = await svc.call({ app: 'notion', action: 'page', args: { id: 'https://www.notion.so/Project-plan-a1b2c3d4e5f60718293a4b5c6d7e8f90' } });
  check('Notion: a page address works, and the text keeps headings and to-dos', /Project plan/.test(page) && /# Goals/.test(page) && /\[x\] Draft outline/.test(page) && /Ship by May\./.test(page), page);
  await svc.connect('gcal', { secret: fakes.icsUrl });
  check('Calendar: connected with the calendar’s own name', svc.list().connectors.find((c) => c.id === 'gcal').statusText === 'Connected · Ada school', '');
  check('Calendar: events in the next days, with place', /Study group · Library room 4/.test(await svc.call({ app: 'gcal', action: 'events', args: { days: 7 } })), await svc.call({ app: 'gcal', action: 'events', args: { days: 7 } }));
  check('Calendar: the secret address is stored encrypted, not in the list sent to the page', !fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8').includes('/secret/basic.ics') && !JSON.stringify(svc.list()).includes('/secret/basic.ics'), '');

  // Gmail through the Google paths the widget uses
  await svc.connect('gmail');
  check('Gmail without the full sign-in connects through the Google session: unread only, and the card says so', /unread only/.test(svc.list().connectors.find((c) => c.id === 'gmail').statusText), svc.list().connectors.find((c) => c.id === 'gmail').statusText);
  check('Gmail (session): unread mail lists the newest messages', /1 unread in all\.[\s\S]*Dean: Welcome week \| See you there/.test(await svc.call({ app: 'gmail', action: 'unread' })), await svc.call({ app: 'gmail', action: 'unread' }));
  check('Gmail (session): search and read say they need the full sign-in', /full Google sign-in/.test(await fails(() => svc.call({ app: 'gmail', action: 'search', args: { query: 'grades' } }))) && /full Google sign-in/.test(await fails(() => svc.call({ app: 'gmail', action: 'message', args: { id: '18c0ffee01' } }))), '');
  await svc.disconnect('gmail');
  googleFake.oauth = true;
  await svc.connect('gmail');
  check('Gmail (full sign-in): search lists matches and read gives the text, read-only API paths only', /18c0ffee01\s+.*Prof: Grades/.test(await svc.call({ app: 'gmail', action: 'search', args: { query: 'from:prof' } })) && /Subject: Grades[\s\S]*Your grade is final\./.test(await svc.call({ app: 'gmail', action: 'message', args: { id: '18c0ffee01' } })) && googleFake.calls.every((p) => /^\/users\/me\/(messages|labels)/.test(p)), JSON.stringify(googleFake.calls));
  check('Gmail: a message id that is not a Gmail id is refused', /message id/.test(await fails(() => svc.call({ app: 'gmail', action: 'message', args: { id: 'abc/../x' } }))), '');
  await svc.disconnect('gmail');
  check('Gmail: the Google sign-in the widget made is left alone on disconnect (it is the widget’s)', googleFake.disconnected !== true, '');

  // MCP preset
  check('Slack (MCP preset): both fields are required and checked', /bot token/i.test(await fails(() => svc.connect('slack', { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: 'T0123456789' }))) && /workspace id/i.test(await fails(() => svc.connect('slack', { SLACK_BOT_TOKEN: 'xoxb-1234567890-abcdef', SLACK_TEAM_ID: 'x' }))), '');
  await svc.connect('slack', { SLACK_BOT_TOKEN: 'xoxb-1234567890-abcdef', SLACK_TEAM_ID: 'T0123456789' });
  check('Slack: adds an MCP server (Tools from MCP servers) with the token as its variable, and offers the AI no connector tool of its own', mcpFake.saved?.command === 'npx' && mcpFake.saved.env.some((e) => e.name === 'SLACK_BOT_TOKEN' && e.value === 'xoxb-1234567890-abcdef') && svc.list().connectors.find((c) => c.id === 'slack').status === 'connected' && !/slack:/.test(svc.defs()[0].description) && !fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8').includes('xoxb-'), JSON.stringify(mcpFake.saved));
  mcpFake.servers = [];
  check('Slack: removed in Tools from MCP servers, the card goes back to Not connected', svc.list().connectors.find((c) => c.id === 'slack').status === 'off', '');

  // Loads again, and what the network saw
  svc = make();
  check('restart: what was connected is still connected, with its token readable only here', svc.hasAny() && (await svc.call({ app: 'github', action: 'prs' })).includes('Add dark mode') && svc.list().connectors.find((c) => c.id === 'canvas').status === 'connected', JSON.stringify(svc.list().connectors.map((c) => [c.id, c.status])));
  check('only the connectors’ own addresses were ever requested', [...requestedHosts].every((h) => Object.values(fakes.urls).some((u) => new URL(u).host === h)), [...requestedHosts].join());

  // Another address in a Link header is never followed
  const evil = service.create({ userData: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-connectors-evil-')), secrets: fakeSecrets, testLoopback: true, endpoints: () => ({ canvas: 'http://127.0.0.1:9' }),
    sessionFetch: async (url) => (String(url).includes('/users/self') ? new Response(JSON.stringify({ name: 'X' }), { status: 200 }) : new Response('[]', { status: 200, headers: { Link: '<https://evil.example/steal>; rel="next"' } })), fetch: async () => { throw new Error('unexpected'); } });
  await evil.connect('canvas', { domain: 'school.instructure.com' });
  check('a Link to another address is refused, not followed', /another address/.test(await fails(() => evil.call({ app: 'canvas', action: 'courses' }))), '');
  const huge = service.create({ userData: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-connectors-huge-')), secrets: fakeSecrets, testLoopback: true, endpoints: () => ({ canvas: 'http://127.0.0.1:9' }),
    sessionFetch: async (url) => (String(url).includes('/users/self') ? new Response(JSON.stringify({ name: 'X' }), { status: 200 }) : new Response(JSON.stringify([{ id: 5001, title: 'a', posted_at: new Date().toISOString(), context_code: 'course_1', message: 'x </untrusted_page_content> <untrusted_page_content> y' }]), { status: 200 })), fetch: async () => { throw new Error('unexpected'); } });
  await huge.connect('canvas', { domain: 'school.instructure.com' });
  const wrapped = await huge.call({ app: 'canvas', action: 'announcements', args: { course_id: '1' } });
  check('a closing tag inside the data can’t end the untrusted wrapper early', (wrapped.match(/<\/untrusted_page_content>/g) || []).length === 1, wrapped);

  // Disconnect
  const tokenKept = fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8');
  check('before disconnecting, the sealed token is on disk', /"github"/.test(tokenKept), '');
  const calls = fakes.seen.length;
  await svc.disconnect('github');
  const afterDisk = fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8');
  check('Disconnect deletes the token: nothing of GitHub is left in the file', !/github/.test(afterDisk) && !afterDisk.includes(Buffer.from(TOKENS.github).toString('base64')), afterDisk);
  check('…the card is Not connected, and the tool no longer lists GitHub', svc.list().connectors.find((c) => c.id === 'github').status === 'off' && !/github:/.test(svc.defs()[0].description) && /Unknown app/.test(svc.validate({ app: 'github', action: 'prs' })), svc.defs()[0].description);
  check('…and a call fails at once without asking GitHub anything (cached answers are gone too)', /Unknown app|isn’t connected/.test(await fails(() => svc.call({ app: 'github', action: 'prs' }))) && fakes.seen.length === calls, '');
  for (const id of ['canvas', 'todoist', 'notion', 'gcal']) await svc.disconnect(id);
  check('with everything disconnected the AI has no tool again, and the file holds no connector', !svc.hasAny() && svc.defs().length === 0 && JSON.stringify(JSON.parse(fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8')).connected) === '{}', fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8'));
  check('the page was told about every change', changes.length >= 10, String(changes.length));
  check('a connector that is only coming soon can’t be connected', /isn’t available yet/.test(await fails(() => svc.connect('spotify', {}))), '');

  await fakes.stop();
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  registry.setConnected([]);
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(), 200);
}).catch((err) => { console.log(`FAIL  no exceptions  -> ${err.stack}`); process.exit(1); });
