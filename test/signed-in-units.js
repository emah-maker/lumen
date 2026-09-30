// [signed-in sites] Plain Node checks for read_urls as_user (features/signed-in-sites.js and
// Agent.planSignedIn): who gets asked, what each answer grants, sensitive hosts, redirects, outside
// agents (MCP), private windows, and the stored list's validation. No Electron window.
module.exports = async function signedInUnits(check) {
  const S = require('../src/features/signed-in-sites');

  // ---- sensitive hosts
  for (const host of ['paypal.com', 'www.paypal.com', 'chase.com', 'secure.chase.com', 'tdbank.com', 'onlinebanking.example.com', 'bankofamerica.com',
    'dashboard.stripe.com', 'my.1password.com', 'vault.bitwarden.com', 'accounts.google.com', 'myaccount.google.com', 'passwords.google.com', 'appleid.apple.com', 'login.microsoftonline.com']) {
    check(`signed-in: ${host} is sensitive`, S.isSensitiveHost(host), host);
  }
  for (const host of ['mail.google.com', 'canvas.northeastern.edu', 'northeastern.instructure.com', 'github.com', 'stripe.com', 'amazon.com', 'docs.google.com']) {
    check(`signed-in: ${host} is not sensitive`, !S.isSensitiveHost(host), host);
  }
  check('signed-in: a sensitive page on an ordinary host (github.com/settings)', S.isSensitiveUrl('https://github.com/settings/keys') && !S.isSensitiveUrl('https://github.com/me/repo') && !S.isSensitiveUrl('https://github.com/settingsx'), '');

  // ---- decide
  const always = new Set(['canvas.example.edu']);
  const d = (url, extra = {}) => S.decide({ url, always, hasLogin: true, ...extra });
  check('signed-in: off by default: without as_user a page is read signed out', d('https://grades.example.edu/').mode === 'signed-out' && d('https://grades.example.edu/').reason === null, JSON.stringify(d('https://grades.example.edu/')));
  check('signed-in: as_user on a host with a login asks', d('https://grades.example.edu/', { asUser: true }).mode === 'ask' && d('https://grades.example.edu/', { asUser: true }).offerAlways === true, '');
  check('signed-in: as_user with no login there reads signed out and says why', d('https://grades.example.edu/', { asUser: true, hasLogin: false }).mode === 'signed-out' && d('https://grades.example.edu/', { asUser: true, hasLogin: false }).reason === 'no-login', '');
  check('signed-in: an always-allowed host reads signed in without a card (www too)', d('https://www.canvas.example.edu/courses').mode === 'signed-in' && d('https://canvas.example.edu/', { asUser: true }).mode === 'signed-in', '');
  check('signed-in: always is per host, not per site', d('https://mail.example.edu/', { asUser: false }).mode === 'signed-out', '');
  check('signed-in: outside agents (MCP) never read signed in, even an always host', d('https://canvas.example.edu/', { external: true }).mode === 'signed-out' && d('https://x.example/', { asUser: true, external: true }).reason === 'outside-agent', '');
  check('signed-in: private windows never read signed in', d('https://canvas.example.edu/', { privateWindow: true }).mode === 'signed-out' && d('https://x.example/', { asUser: true, privateWindow: true }).reason === 'private', '');
  check('signed-in: an agent with no signed-in reader (background tasks) reads signed out', d('https://canvas.example.edu/', { supported: false }).mode === 'signed-out' && d('https://x.example/', { asUser: true, supported: false }).reason === 'unsupported', '');
  for (const url of ['lumen://settings', 'file:///C:/x.html', 'chrome://settings', 'about:blank', 'javascript:alert(1)', 'https://user:pw@canvas.example.edu/']) {
    check(`signed-in: ${url} is never read signed in`, d(url, { asUser: true }).mode === 'signed-out', JSON.stringify(d(url, { asUser: true })));
  }
  const bank = S.decide({ url: 'https://www.paypal.com/myaccount', asUser: true, hasLogin: true, always: new Set(['paypal.com']) });
  check('signed-in: a sensitive host asks every time and offers no "Always", even if stored', bank.mode === 'ask' && bank.sensitive && bank.offerAlways === false, JSON.stringify(bank));

  // ---- answers
  check('signed-in: No (or anything unknown) grants nothing', S.grantFrom(false) === null && S.grantFrom(undefined) === null && S.grantFrom('yes') === null, '');
  check('signed-in: Just this once / Always', S.grantFrom(true) === 'once' && S.grantFrom('once') === 'once' && S.grantFrom('always') === 'always', '');
  check('signed-in: "Always" on a sensitive host counts as once', S.grantFrom('always', { sensitive: true }) === 'once', '');

  // ---- redirects during a signed-in read
  const grant = { host: 'canvas.example.edu', sensitive: false };
  check('signed-in: the approved host itself may load (www or not)', S.hopAllowed(grant, 'https://canvas.example.edu/grades') && S.hopAllowed(grant, 'https://www.canvas.example.edu/'), '');
  check('signed-in: a redirect to another host is stopped (read signed out instead)', !S.hopAllowed(grant, 'https://sso.example.edu/login') && !S.hopAllowed(grant, 'https://evil.example/') && !S.hopAllowed(grant, 'https://x.canvas.example.edu/'), '');
  check('signed-in: a redirect to a non-web address is stopped', !S.hopAllowed(grant, 'file:///C:/x') && !S.hopAllowed(grant, 'lumen://settings') && !S.hopAllowed(null, 'https://canvas.example.edu/'), '');
  check('signed-in: an approved ordinary host can\'t move on to its sensitive pages', !S.hopAllowed({ host: 'github.com', sensitive: false }, 'https://github.com/settings/tokens') && S.hopAllowed({ host: 'github.com', sensitive: true }, 'https://github.com/settings/tokens'), '');

  // ---- login cookies
  check('signed-in: analytics and consent cookies alone are not a login', !S.hasLoginCookies([{ name: '_ga' }, { name: '_gid' }, { name: 'OptanonConsent' }, { name: '__cf_bm' }]) && !S.hasLoginCookies([]) && !S.hasLoginCookies(null), '');
  check('signed-in: any other cookie may be a login', S.hasLoginCookies([{ name: '_ga' }, { name: 'canvas_session' }]), '');

  // ---- stored list: validation and the store
  const cleaned = S.clean([{ host: 'WWW.Canvas.Example.edu', added: 5 }, 'canvas.example.edu', { host: 'paypal.com' }, { host: 'bad host' }, { host: 'localhost' }, 7, null, { host: 'a.example', added: 'x' }]);
  check('signed-in: settings validation keeps valid hosts once, drops sensitive and junk', JSON.stringify(cleaned) === JSON.stringify([{ host: 'canvas.example.edu', added: 5 }, { host: 'a.example', added: 0 }]), JSON.stringify(cleaned));
  check('signed-in: a damaged setting reads as no sites', S.clean('garbage').length === 0 && S.clean({ host: 'a.example' }).length === 0, '');
  check('signed-in: the list is capped', S.clean(Array.from({ length: S.MAX_SITES + 20 }, (_, i) => `h${i}.example`)).length === S.MAX_SITES, '');
  const SB = require('../src/settings/settings-backend');
  check('signed-in: the setting exists, empty by default, validated by settings-backend', Array.isArray(SB.DEFAULTS.aiSignedInSites) && SB.DEFAULTS.aiSignedInSites.length === 0
    && JSON.stringify(SB.validate('aiSignedInSites', ['x.example', 'chase.com'])) === JSON.stringify([{ host: 'x.example', added: 0 }]), JSON.stringify(SB.validate('aiSignedInSites', ['x.example', 'chase.com'])));
  check('signed-in: Settings can\'t add a host with the generic setter', /key === 'aiSignedInSites'\) throw/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'src/settings/settings-backend.js'), 'utf8')), '');
  let saved = {};
  let clock = 1000;
  const store = S.createSignedInSites({ readSettings: () => ({ ...saved }), writeSettings: (v) => { saved = v; }, now: () => clock });
  store.add('www.canvas.example.edu');
  clock = 2000;
  store.add('canvas.example.edu');
  check('signed-in: adding a host twice keeps one entry with the newest time', JSON.stringify(store.list()) === JSON.stringify([{ host: 'canvas.example.edu', added: 2000 }]), JSON.stringify(saved));
  check('signed-in: isAlways matches that host only', store.isAlways('https://canvas.example.edu/x') && !store.isAlways('https://mail.example.edu/') && !store.isAlways('lumen://settings'), '');
  store.add('paypal.com');
  store.add('not a host');
  check('signed-in: a sensitive or invalid host is never stored', store.list().length === 1, JSON.stringify(store.list()));
  store.add('b.example');
  store.remove('canvas.example.edu');
  check('signed-in: Remove takes one host out', store.list().map((s) => s.host).join() === 'b.example', JSON.stringify(store.list()));
  store.clear();
  check('signed-in: Remove all empties the list', store.list().length === 0 && Array.isArray(saved.aiSignedInSites), JSON.stringify(saved));
  const handlers = {};
  store.register({ handle: (ch, fn) => { handlers[ch] = fn; } });
  check('signed-in: only settings:* channels, and no "add" channel', Object.keys(handlers).every((ch) => ch.startsWith('settings:')) && !Object.keys(handlers).some((ch) => /add/.test(ch)), Object.keys(handlers).join());

  // ---- Agent.planSignedIn: the card, the answers, MCP
  const { Agent } = require('../src/ai/agent');
  const run = async ({ answers = {}, external = false, deps = {}, urls, asUser = true, noDeps = false }) => {
    const added = [];
    const cards = [];
    const browser = {
      activeTab: () => null, listTabs: () => [],
      ...(noDeps ? {} : {
        signedIn: {
          hosts: () => new Set(['always.example']),
          add: (h) => added.push(h),
          hasLogin: async (url) => !/nologin/.test(url),
          privateWindow: () => false,
          ...deps,
        },
      }),
    };
    const agent = new Agent(browser, () => null);
    const emit = (event) => {
      if (event.type !== 'approval') return;
      cards.push(event);
      setImmediate(() => agent.resolveApproval(event.approvalId, answers[event.host]));
    };
    const gate = { emit, signal: new AbortController().signal, who: 'Claude', external, hosts: new Set() };
    const plan = await agent.planSignedIn(urls, asUser, gate);
    return { plan, cards, added };
  };
  {
    const { plan, cards } = await run({ urls: ['https://grades.example/'], answers: { 'grades.example': false } });
    check('planSignedIn: the card asks about the host, and No reads signed out with a note', cards.length === 1 && cards[0].action === 'signin' && /signed-in grades\.example account/.test(cards[0].title) && cards[0].noAlways === false
      && !plan.get('https://grades.example/').grant && /did not let Claude/.test(plan.get('https://grades.example/').note), JSON.stringify({ cards, plan: [...plan] }));
  }
  {
    const { plan, added } = await run({ urls: ['https://grades.example/a', 'https://grades.example/b'], answers: { 'grades.example': true } });
    check('planSignedIn: Just this once grants this call only (nothing stored), one card per host', plan.get('https://grades.example/a').grant === 'once' && plan.get('https://grades.example/b').grant === 'once' && added.length === 0, JSON.stringify([...plan]));
  }
  {
    const { plan, cards, added } = await run({ urls: ['https://grades.example/a', 'https://grades.example/b'], answers: { 'grades.example': 'always' } });
    check('planSignedIn: Always stores the host', plan.get('https://grades.example/a').grant === 'always' && added.join() === 'grades.example' && cards.length === 1, JSON.stringify({ added, cards: cards.length }));
  }
  {
    const { plan, cards, added } = await run({ urls: ['https://www.paypal.com/activity'], answers: { 'paypal.com': 'always' } });
    check('planSignedIn: a sensitive host\'s card has no Always, and a forged "always" answer is only once', cards[0]?.noAlways === true && plan.get('https://www.paypal.com/activity').grant === 'once' && plan.get('https://www.paypal.com/activity').sensitive === true && added.length === 0, JSON.stringify({ cards, plan: [...plan], added }));
  }
  {
    const { plan, cards } = await run({ urls: ['https://always.example/x'], asUser: false });
    check('planSignedIn: an always-allowed host reads signed in with no card', cards.length === 0 && plan.get('https://always.example/x').grant === 'always', JSON.stringify([...plan]));
  }
  {
    const { plan, cards } = await run({ urls: ['https://nologin.example/'] });
    check('planSignedIn: no login there: no card, and the note says so', cards.length === 0 && /doesn't seem to be signed in/.test(plan.get('https://nologin.example/').note), JSON.stringify([...plan]));
  }
  {
    const { plan, cards } = await run({ urls: ['https://grades.example/', 'https://always.example/'], external: true, answers: { 'grades.example': true } });
    check('planSignedIn: outside agents (MCP) get no card and never a signed-in read, even for an always host', cards.length === 0 && !plan.get('https://grades.example/')?.grant && !plan.get('https://always.example/')?.grant && /outside agents/.test(plan.get('https://grades.example/').note), JSON.stringify([...plan]));
  }
  {
    const agent = new Agent({ activeTab: () => null, listTabs: () => [], signedIn: { hosts: () => new Set(['always.example']), hasLogin: async () => true } }, () => null);
    const plan = await agent.planSignedIn(['https://always.example/'], true, undefined);
    check('planSignedIn: a call with no approval gate is treated as an outside agent', !plan.get('https://always.example/')?.grant, JSON.stringify([...plan]));
  }
  {
    const { plan, cards } = await run({ urls: ['https://grades.example/'], deps: { privateWindow: () => true } });
    check('planSignedIn: never in a private window', cards.length === 0 && !plan.get('https://grades.example/').grant, JSON.stringify([...plan]));
  }
  {
    const { plan, cards } = await run({ urls: ['https://grades.example/'], deps: { privateWindow: () => { throw new Error('x'); } } });
    check('planSignedIn: if the window can\'t be checked, it counts as private', cards.length === 0 && !plan.get('https://grades.example/').grant, JSON.stringify([...plan]));
  }
  {
    const { plan, cards } = await run({ urls: ['https://grades.example/'], noDeps: true });
    check('planSignedIn: an Agent without a signed-in reader (background tasks) reads signed out', cards.length === 0 && /background tasks/.test(plan.get('https://grades.example/').note), JSON.stringify([...plan]));
  }
  {
    const { plan, cards } = await run({ urls: ['https://grades.example/'], deps: { hasLogin: async () => { throw new Error('cookie store'); } } });
    check('planSignedIn: a failing cookie check reads signed out', cards.length === 0 && !plan.get('https://grades.example/').grant, JSON.stringify([...plan]));
  }
  {
    const agent = new Agent({ activeTab: () => null, listTabs: () => [], signedIn: { open: () => null } }, () => null);
    const page = await agent.readSignedIn('https://grades.example/', { grant: 'once', host: 'grades.example', sensitive: false });
    check('readSignedIn: if no tab could open, the page is read signed out instead', page.redirected === true, JSON.stringify(page));
  }
  {
    const closed = [];
    const agent = new Agent({ activeTab: () => null, listTabs: () => [], signedIn: { close: (id) => closed.push(id) } }, () => null);
    agent.closeSignedInTabs({ signedInTabs: new Set([4, 9]) });
    agent.closeSignedInTabs(null);
    check('closeSignedInTabs: the run\'s signed-in tabs are handed back to main.js to close', closed.join() === '4,9', closed.join());
  }
  check('read_urls: as_user is in the schema and validated', require('../src/ai/agent').validateInput('read_urls', { urls: ['https://a.example'], as_user: true }) === null && require('../src/ai/agent').validateInput('read_urls', { urls: ['https://a.example'], as_user: 'yes' }) !== null, '');
};
