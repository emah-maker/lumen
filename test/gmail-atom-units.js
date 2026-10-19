// Gmail through the Google sign-in in Lumen (run from test/units.js): the Atom feed parser (escaping, entities,
// missing fields, counts, malicious content staying text), account index and address validation, the mode
// selection, the card states (signed in / signed out) against a fake feed, the account probe, and the
// client-JSON reader of the Advanced setup. No network, no window.
const GA = require('../src/features/gmail-atom');
const GV = require('../src/features/gmail-view');
const GC = require('../src/features/google-client');
const { createWidgets } = require('../src/features/widgets');

const entry = ({ title = 'Hello', summary = 'A preview', name = 'Ada Lovelace', email = 'ada@example.com', hex = '18c3a1b2c3d4e5f6', modified = '2026-10-04T12:30:00Z', id = 'tag:gmail.google.com,2004:1234567890123456789', raw = '' } = {}) =>
  `<entry><title>${title}</title><summary>${summary}</summary><link rel="alternate" href="https://mail.google.com/mail?account_id=me%40example.com&amp;message_id=${hex}&amp;view=conv&amp;extsrc=atom" type="text/html"/><modified>${modified}</modified><issued>${modified}</issued><id>${id}</id><author><name>${name}</name><email>${email}</email></author>${raw}</entry>`;
const feed = (entries, { full = entries.length, who = 'me@example.com', extra = '' } = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for ${who}</title><tagline>New messages in your Gmail Inbox</tagline><fullcount>${full}</fullcount><link rel="alternate" href="https://mail.google.com/mail" type="text/html"/><modified>2026-10-05T00:00:00Z</modified>${extra}${entries.join('')}</feed>`;

module.exports = async function gmailAtomUnits(check) {
  // ---- parsing ----
  const ok = GA.parseFeed(feed([entry(), entry({ title: 'Second', hex: 'ffff0000aaaa5555' })], { full: 7 }));
  check('gmail atom: a feed gives the account, the unread total (fullcount, even above the entries listed) and each message', ok.ok && ok.email === 'me@example.com' && ok.unread === 7 && ok.messages.length === 2 && ok.messages[0].subject === 'Hello' && ok.messages[0].from === 'Ada Lovelace' && ok.messages[0].address === 'ada@example.com' && ok.messages[0].snippet === 'A preview' && ok.messages[0].id === '18c3a1b2c3d4e5f6' && ok.messages[0].unread === true, JSON.stringify(ok).slice(0, 300));
  check('gmail atom: the time comes from <modified>', ok.messages[0].at === Date.parse('2026-10-04T12:30:00Z'), String(ok.messages[0].at));
  const empty = GA.parseFeed(feed([], { full: 0 }));
  check('gmail atom: an empty inbox is a good answer with zero unread', empty.ok && empty.unread === 0 && empty.messages.length === 0, JSON.stringify(empty));
  check('gmail atom: without <fullcount> the count is the entries listed', GA.parseFeed(feed([entry()]).replace(/<fullcount>.*?<\/fullcount>/, '')).unread === 1, '');
  const capped = GA.parseFeed(feed(Array.from({ length: 30 }, (_, i) => entry({ title: `m${i}`, hex: `${(i + 16).toString(16)}abcdef0` })), { full: 52 }));
  check('gmail atom: at most 20 messages are read, and the total still shows 52', capped.messages.length === 20 && capped.unread === 52, `${capped.messages.length} ${capped.unread}`);

  // entities, CDATA, escaping
  const ent = GA.parseFeed(feed([entry({ title: 'Q&amp;A &lt;b&gt;bold&lt;/b&gt; &#8217;s &#x1F600; &quot;hi&quot; &apos;x&apos;', summary: '5 &gt; 3 &amp;&amp; &nbsp;done &unknown;' })]));
  check('gmail atom: XML entities and numeric references are decoded; an unknown entity stays as written', ent.messages[0].subject === 'Q&A <b>bold</b> ’s 😀 "hi" \'x\'' && ent.messages[0].snippet === '5 > 3 && &nbsp;done &unknown;', JSON.stringify(ent.messages[0]));
  check('gmail atom: CDATA is taken as text', GA.parseFeed(feed([entry({ title: '<![CDATA[Re: a <b>b</b> & c]]>' })])).messages[0].subject === 'Re: a <b>b</b> & c', '');
  const evil = GA.parseFeed(feed([entry({ title: '&lt;img src=x onerror=alert(1)&gt;', summary: '&lt;script&gt;alert(1)&lt;/script&gt;', name: '&lt;svg onload=1&gt;' })]));
  check('gmail atom: escaped markup in a message stays text (the card sets it with textContent)', evil.messages[0].subject === '<img src=x onerror=alert(1)>' && evil.messages[0].snippet === '<script>alert(1)</script>' && evil.messages[0].from === '<svg onload=1>', JSON.stringify(evil.messages[0]));
  const live = GA.parseFeed(feed([entry({ title: 'Real <b>markup</b> inside' }), entry({ title: 'Fine', hex: 'aaaa1111bbbb2222' })]));
  check('gmail atom: an entry with real markup inside a text field is dropped, the others stay', live.ok && live.messages.length === 1 && live.messages[0].subject === 'Fine', JSON.stringify(live.messages));
  check('gmail atom: control characters and runs of blanks are flattened, long text cut', GA.parseFeed(feed([entry({ title: `a\u0000b\n\n  c${'x'.repeat(400)}`, summary: 's'.repeat(900) })])).messages[0].subject.length <= 200 && !/[\u0000\n]/.test(GA.parseFeed(feed([entry({ title: 'a\u0000b\n\n  c' })])).messages[0].subject) && GA.parseFeed(feed([entry({ summary: 's'.repeat(900) })]), { snippets: true }).messages[0].snippet.length === 160, '');
  check('gmail atom: snippets can be left out', GA.parseFeed(feed([entry()]), { snippets: false }).messages[0].snippet === '', '');

  // missing fields
  const bare = GA.parseFeed(feed([entry({ title: '', summary: '', name: '', email: '' })]));
  check('gmail atom: missing subject, sender and summary get plain fallbacks', bare.messages[0].subject === '(no subject)' && bare.messages[0].from === 'Unknown sender' && bare.messages[0].snippet === '' && bare.messages[0].address === '', JSON.stringify(bare.messages[0]));
  check('gmail atom: a sender with only an address shows the address', GA.parseFeed(feed([entry({ name: '', email: 'bob@example.com' })])).messages[0].from === 'bob@example.com', '');
  const viaTag = GA.parseFeed(feed([entry({ hex: 'zzzz' })]));
  check('gmail atom: a link without a usable message id falls back to the entry id (decimal to hex)', viaTag.messages[0].id === BigInt('1234567890123456789').toString(16), JSON.stringify(viaTag.messages));
  check('gmail atom: an entry with no id at all is dropped', GA.parseFeed(feed([entry({ hex: 'zzzz', id: 'nope' })])).messages.length === 0, '');
  check('gmail atom: a link to another host is not trusted for the id', GA.parseFeed(feed([entry().replace('https://mail.google.com/mail?', 'https://evil.example/mail?')])).messages[0].id === BigInt('1234567890123456789').toString(16), '');
  check('gmail atom: a missing or broken date is 0', GA.parseFeed(feed([entry({ modified: 'yesterday' })])).messages[0].at === 0, '');

  // not the feed
  check('gmail atom: a web page (the sign-in page) is "html", not a feed', GA.parseFeed('<!DOCTYPE html><html><body>Sign in</body></html>').reason === 'html' && GA.parseFeed('<HTML><HEAD><TITLE>Unauthorized</TITLE></HEAD></HTML>').reason === 'html', '');
  check('gmail atom: garbage, JSON, truncated XML and oversized bodies are refused', ['', 'nope', '{"a":1}', '<feed><title>x</title>', 'x'.repeat(2e6)].every((b) => GA.parseFeed(b).ok === false) && GA.parseFeed(null).ok === false, '');
  check('gmail atom: a DOCTYPE or an ENTITY declaration is refused (no entity tricks)', GA.parseFeed(`<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY x "boom">]>${feed([entry({ title: '&x;' })])}`).ok === false && GA.parseFeed(feed([entry()]).replace('<feed ', '<!ENTITY a "b"><feed ')).ok === false, '');
  check('gmail atom: the address in the title is the account; a title without one gives none', ok.email === 'me@example.com' && GA.parseFeed(feed([], { who: '' }).replace('Inbox for ', 'Inbox')).email === '', '');

  // ---- account index and addresses ----
  check('gmail atom: the account index is a whole number 0 to 9, else 0', [0, 1, 9, '3', ' 4 '].every((v, i) => GA.cleanAccount(v) === [0, 1, 9, 3, 4][i]) && [-1, 10, 1.5, 'x', '1e1', '../1', null, undefined, NaN, {}, [], '99'].every((v) => GA.cleanAccount(v) === 0), '');
  check('gmail atom: the feed address is only /mail/u/N/feed/atom on mail.google.com', GA.feedUrl(2) === 'https://mail.google.com/mail/u/2/feed/atom' && GA.feedUrl('../x') === 'https://mail.google.com/mail/u/0/feed/atom' && GA.isFeedUrl(GA.feedUrl(7)), GA.feedUrl(2));
  check('gmail atom: no other address passes the same-origin check', ['http://mail.google.com/mail/u/0/feed/atom', 'https://mail.google.com.evil.com/mail/u/0/feed/atom', 'https://evil.com/mail/u/0/feed/atom', 'https://mail.google.com@evil.com/mail/u/0/feed/atom', 'https://mail.google.com:8443/mail/u/0/feed/atom', 'https://mail.google.com/mail/u/10/feed/atom', 'https://mail.google.com/mail/u/0/feed/atom?x=1', 'https://mail.google.com/mail/u/0/feed/atom/work', 'https://mail.google.com/mail/u/0/', 'file:///mail/u/0/feed/atom', '', null].every((u) => GA.isFeedUrl(u) === false), '');
  check('gmail atom: the sign-in page is on accounts.google.com', new URL(GA.SIGN_IN_URL).host === 'accounts.google.com' && new URL(GA.SIGN_IN_URL).protocol === 'https:', GA.SIGN_IN_URL);
  check('gmail atom: the account list drops duplicates and stops at a gap', JSON.stringify(GA.accountList(['A@x.com', 'b@x.com', 'a@x.com'])) === JSON.stringify([{ index: 0, email: 'A@x.com' }, { index: 1, email: 'b@x.com' }]) && GA.accountList(['a@x.com', '', 'c@x.com']).length === 1 && GA.accountList(null).length === 0, '');

  // ---- mode selection ----
  check('gmail mode: no Client ID is the Google sign-in; a Client ID is the own client (what older Lumens saved)', GV.cleanConfig({}).mode === 'google' && GV.cleanConfig({ clientId: '1-a.apps.googleusercontent.com' }).mode === 'oauth' && GV.cleanConfig(null).mode === 'google', '');
  check('gmail mode: an explicit mode wins; the Google sign-in keeps no Client ID; an unknown mode falls back', GV.cleanConfig({ mode: 'google', clientId: '1-a.apps.googleusercontent.com' }).clientId === '' && GV.cleanConfig({ mode: 'oauth' }).mode === 'oauth' && GV.cleanConfig({ mode: 'oauth', clientId: 'nope' }) === null && GV.cleanConfig({ mode: 'weird' }).mode === 'google' && GV.cleanConfig({ mode: 'google', clientId: 'nope' }).mode === 'google', '');
  check('gmail mode: the account is 0 to 9, else the first', GV.cleanConfig({ account: 2 }).account === 2 && GV.cleanConfig({ account: '3' }).account === 3 && GV.cleanConfig({ account: 12 }).account === 0 && GV.cleanConfig({ account: -1 }).account === 0 && GV.cleanConfig({ account: 'x' }).account === 0 && GV.cleanConfig({ account: '' }).account === 0 && GV.cleanConfig({}).account === 0, '');

  // ---- the connector against a fake feed ----
  let settings = { homeWidgets: [{ id: 'wgmail1', type: 'gmail', count: 4 }] };
  const secrets = {};
  const reply = { status: 200, body: feed([entry({ title: 'One' }), entry({ title: 'Two', hex: '0123456789abcdef' }), entry({ title: 'Three', hex: '1111222233334444' }), entry({ title: 'Four', hex: '5555666677778888' }), entry({ title: 'Five', hex: '9999aaaabbbbcccc' })], { full: 9 }) };
  const asked = [];
  const opened = [];
  let clock = 1e12;
  const w = createWidgets({
    readSettings: () => settings, writeSettings: (s) => { settings = s; },
    fetch: async () => { throw new Error('the Google-sign-in mode must not use the API'); },
    getSecret: (n) => secrets[n] || null, setSecret: (n, v) => { if (v) secrets[n] = v; else delete secrets[n]; },
    onUpdate: () => {}, now: () => clock, rateMax: () => 1000, googleClient: () => null,
    googleMail: {
      fetch: async (url) => { asked.push(url); if (reply.throws) throw new Error('offline'); const u = new URL(url); const n = Number(u.pathname.split('/')[3]); return n < (reply.accounts ?? 3) ? (reply.perAccount ? reply.perAccount(n) : reply) : { status: 401, body: '<HTML>Unauthorized</HTML>' }; },
      openSignIn: (u) => opened.push(u),
    },
  });
  const show = async () => { w.flush(); await w.refresh(w.list()[0], { force: true }); return w.forPage()[0]; };
  let card = await show();
  check('gmail card: the default reads the feed and shows the unread count, the newest few and the account', card.data.state === 'ok' && card.data.source === 'google' && card.data.unread === 9 && card.data.messages.length === 4 && card.data.messages[0].subject === 'One' && card.data.email === 'me@example.com' && card.data.unreadOnly === true && card.data.account === 0, JSON.stringify(card.data).slice(0, 300));
  check('gmail card: only the one feed address was requested', asked.length === 1 && asked[0] === 'https://mail.google.com/mail/u/0/feed/atom', asked.join(','));
  check('gmail card: the widget keeps its mode and no Client ID or secret', w.list()[0].mode === 'google' && w.list()[0].clientId === '' && !JSON.stringify(w.list()[0]).includes('clientSecret'), JSON.stringify(w.list()[0]));
  check('gmail card: nothing but text and ids reaches the page (no links, no HTML field)', !/https?:\/\//.test(JSON.stringify(card.data.messages)) && card.data.open === 'https://mail.google.com/mail/u/0/', JSON.stringify(card.data.messages[0]));
  check('gmail card: a read feed is not asked for again before 10 minutes', (() => { const n = asked.length; return n === 1; })(), '');

  reply.status = 401; reply.body = '<HTML>Unauthorized</HTML>';
  card = await show();
  check('gmail card: a 401 is the "Sign in to Gmail" state, not an error', card.data.state === 'reconnect' && card.data.google === true && card.data.oneClick === true && /Sign in to Google/.test(card.data.message) && !card.error, JSON.stringify(card.data));
  check('gmail settings state: signed out is reported (never a cookie)', w.state().gmailGoogle.signedIn === false && w.state().gmailGoogle.available === true, JSON.stringify(w.state().gmailGoogle));
  reply.status = 302; reply.body = '';
  check('gmail card: a redirect to a sign-in page is signed out too', (await show()).data.state === 'reconnect', '');
  reply.status = 200; reply.body = '<!doctype html><html><title>Gmail</title></html>';
  check('gmail card: a 200 that is a web page is signed out', (await show()).data.state === 'reconnect', '');
  reply.status = 200; reply.body = 'plain nonsense';
  card = await show();
  check('gmail card: a 200 that is neither is an error line, not a fake empty inbox', card.error === 'Gmail sent something unexpected.' && !card.data, JSON.stringify(card).slice(0, 200));
  reply.status = 503; reply.body = '';
  check('gmail card: a 5xx says Gmail is having trouble', /having trouble/.test((await show()).error || ''), '');
  reply.status = 429;
  check('gmail card: a 429 says to slow down', /slow down/.test((await show()).error || ''), '');
  clock += 10 * 60e3;
  reply.status = 200; reply.body = feed([entry()], { full: 1 });
  card = await show();
  check('gmail card: signed in again, it fills in', card.data.state === 'ok' && card.data.unread === 1 && w.state().gmailGoogle.signedIn === true, JSON.stringify(card.data).slice(0, 120));

  // the signed-out button, and the account the user picked
  reply.status = 401; reply.body = '';
  await show();
  check('gmail card: "Sign in to Gmail" opens Google\'s sign-in in a tab (accounts.google.com), and the card then says to finish there', (await w.act(w.actionFrom('file:///lumen/newtab.html?widget=wgmail1&do=signin'))) !== null && opened.length === 1 && new URL(opened[0]).host === 'accounts.google.com' && /Finish signing in/.test(w.forPage()[0].data.message), opened.join(','));
  settings = { homeWidgets: [{ id: 'wgmail1', type: 'gmail', count: 3, account: 1, mode: 'google' }] };
  asked.length = 0; reply.status = 200; reply.body = feed([entry()], { full: 1 });
  card = await show();
  check('gmail card: a picked account reads that account\'s feed and links to it', asked[0] === 'https://mail.google.com/mail/u/1/feed/atom' && card.data.account === 1 && card.data.open === 'https://mail.google.com/mail/u/1/', asked.join(','));
  settings = { homeWidgets: [{ id: 'wgmail1', type: 'gmail', count: 3, account: 99 }] };
  asked.length = 0;
  await show();
  check('gmail card: a stored account index out of range reads the first account', asked[0] === 'https://mail.google.com/mail/u/0/feed/atom', asked.join(','));
  check('gmail card: with the API mode chosen the feed is not used', await (async () => { settings = { homeWidgets: [{ id: 'wgmail1', type: 'gmail', mode: 'oauth', clientId: '1-a.apps.googleusercontent.com' }] }; asked.length = 0; const c = await show(); return asked.length === 0 && c.data.state === 'reconnect' && !c.data.google; })(), '');

  // ---- Settings: Save and Check in the default mode need no sign-in ----
  settings = { homeWidgets: [] };
  reply.status = 401; reply.body = '';
  const saved = await w.save({ type: 'gmail', mode: 'google', account: 1, count: 6, snippets: false });
  check('gmail settings: Save works while signed out (the card then asks to sign in) and keeps the account, count and preview choice', saved.widget.mode === 'google' && saved.widget.account === 1 && saved.widget.count === 6 && saved.widget.snippets === false && /Sign in to Google/.test(saved.message) && !('gmail' in secrets), JSON.stringify(saved).slice(0, 250));
  reply.status = 200; reply.body = feed([entry(), entry({ hex: 'abcabcabcabc1234' })], { full: 2 });
  const checked = await w.test({ type: 'gmail', mode: 'google' });
  check('gmail settings: Check says who is signed in and how many are unread', checked.ok && /me@example\.com/.test(checked.message) && /2 unread/.test(checked.message), JSON.stringify(checked));
  check('gmail settings: a Client ID typed while the Google sign-in is chosen is not saved', (await w.save({ type: 'gmail', mode: 'google', clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-abcdefgh' })).widget.clientId === '' && !('gmail' in secrets), '');

  // ---- the account probe ----
  reply.perAccount = (n) => ({ status: 200, body: feed([], { who: ['a@x.com', 'b@x.com', 'a@x.com'][n] }) });
  reply.accounts = 3;
  const found = await w.gmailAccounts();
  check('gmail accounts: each signed-in account is listed by address, in order, and the probe stops at a repeat or a 401', JSON.stringify(found) === JSON.stringify({ accounts: [{ index: 0, email: 'a@x.com' }, { index: 1, email: 'b@x.com' }], signedIn: true }), JSON.stringify(found));
  reply.perAccount = null; reply.accounts = 0;
  check('gmail accounts: signed out gives an empty list, and a network failure does not throw', (await w.gmailAccounts()).signedIn === false && await (async () => { reply.throws = true; const r = await w.gmailAccounts(); reply.throws = false; return r.accounts.length === 0; })(), '');
  check('gmail sign-in tab: it opens only a sign-in page on accounts.google.com', w.gmailOpenSignIn() === true && new URL(opened.at(-1)).host === 'accounts.google.com', opened.at(-1));
  settings = { homeWidgets: [{ id: 'wgmail1', type: 'gmail', count: 3 }] };
  reply.accounts = 3; reply.status = 200;
  await show();
  w.googleSessionChanged();
  await new Promise((r) => setTimeout(r, 1700));
  check('gmail card: when Google\'s sign-in cookies change, the cards look again at once (the old answer is dropped)', w.forPage()[0].loading === true || w.forPage()[0].data?.state === 'ok', '');
  settings = { homeWidgets: [{ id: 'wgmail1', type: 'gmail', mode: 'oauth', clientId: '1-a.apps.googleusercontent.com' }] };
  check('gmail card: the cookie nudge ignores cards that use the API', w.googleSessionChanged() === false, '');

  // ---- the client JSON of the Advanced setup ----
  const CID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
  const file = (o) => JSON.stringify(o, null, 2);
  const inst = GC.parseClientJson(file({ installed: { client_id: CID, project_id: 'p', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', client_secret: 'GOCSPX-abcdefgh_ij-12', redirect_uris: ['http://localhost'] } }));
  check('client json: the downloaded Desktop client file gives the Client ID and secret', inst.clientId === CID && inst.clientSecret === 'GOCSPX-abcdefgh_ij-12' && Object.keys(inst).length === 2, JSON.stringify(inst));
  check('client json: a bare client object and a BOM-prefixed file work', GC.parseClientJson(file({ client_id: CID, client_secret: 'GOCSPX-abcdefgh12' })).clientId === CID && GC.parseClientJson(`${String.fromCharCode(0xfeff)}${file({ installed: { client_id: CID, client_secret: 'GOCSPX-abcdefgh12' } })}`).clientId === CID, '');
  check('client json: pasted plain text with both values works', GC.parseClientJson(`Client ID: ${CID}\nClient secret: GOCSPX-abcdefgh12`).clientSecret === 'GOCSPX-abcdefgh12' && GC.parseClientJson(`${CID}\nsecret=abcdefgh1234`).clientSecret === 'abcdefgh1234', '');
  check('client json: a Web application client is refused with the reason', /Web application/.test(GC.parseClientJson(file({ web: { client_id: CID, client_secret: 'GOCSPX-abcdefgh12' } })).error) && /Desktop app/.test(GC.parseClientJson(file({ web: {} })).error), '');
  check('client json: missing, wrong or oversized input says what is wrong and returns no values', ['', '   ', '{', '[]', '{"installed":{}}', file({ installed: { client_id: 'nope', client_secret: 'GOCSPX-abcdefgh12' } }), file({ installed: { client_id: CID } }), file({ installed: { client_id: CID, client_secret: 'a b' } }), 'x'.repeat(30000), null, 42, {}].every((v) => { const r = GC.parseClientJson(v); return typeof r.error === 'string' && !r.clientId && !r.clientSecret; }), '');
  check('client json: an error never echoes the secret back', !/GOCSPX/.test(GC.parseClientJson(file({ installed: { client_id: 'nope', client_secret: 'GOCSPX-abcdefgh12' } })).error), '');
};
