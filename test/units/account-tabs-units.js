// [account tabs] Names, colors and partitions of the account tabs, which pages are sign-in pages, and which site a sign-in
// started from (features/account-tabs.js), plain Node. The real sessions are tested in test/e2e/account-tabs.js.
const fs = require('fs');
const path = require('path');
const A = require('../../src/features/account-tabs');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);

// ---- partitions
check('partitionFor / idOfPartition round-trip, saved ("persist:") sessions', A.partitionFor(2) === 'persist:lumen-account-2' && A.idOfPartition('persist:lumen-account-2') === 2 && A.idOfPartition(A.partitionFor(37)) === 37);
check('idOfPartition: the main, research, private and odd names are not accounts', [undefined, '', 'lumen-research', 'persist:lumen-account-1', 'persist:lumen-account-0', 'lumen-account-2', 'persist:lumen-account-2x', 'persist:lumen-account-1000'].every((p) => A.idOfPartition(p) === null));
{
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  const re = new RegExp(/const ACCOUNT_PARTITION = \/(.+)\/;/.exec(main)?.[1] || 'x^');
  check('main.js reads account partitions the same way (ACCOUNT_PARTITION)', re.test(A.partitionFor(2)) && re.test(A.partitionFor(999)) && !re.test('lumen-research') && main.includes('`persist:lumen-account-${'));
}

// ---- the list
check('normalize: bad entries dropped, duplicates once, sorted, names and colors filled in', J(A.normalize([{ id: 3, name: '  Work  ' }, { id: 2 }, { id: 3, name: 'dup' }, { id: 1 }, { id: 'x' }, null, { id: 5, color: 'red' }]))
  === J([{ id: 2, name: 'Account 2', color: A.COLORS[0] }, { id: 3, name: 'Work', color: A.COLORS[1] }, { id: 5, name: 'Account 5', color: A.COLORS[3] }]));
check('normalize: not a list is an empty list', J(A.normalize(undefined)) === '[]' && J(A.normalize({ id: 2 })) === '[]');
{
  let list = [];
  const first = A.create(list); list = first.list;
  const second = A.create(list); list = second.list;
  check('create: Account 2, then Account 3, each its own color', first.account.id === 2 && first.account.name === 'Account 2' && second.account.id === 3 && second.account.color !== first.account.color, J(list));
  const gap = A.create([{ id: 2 }, { id: 4 }]);
  check('create: the lowest free number', gap.account.id === 3 && gap.list.map((a) => a.id).join() === '2,3,4');
  const full = A.create(Array.from({ length: A.MAX_ACCOUNTS }, (_, i) => ({ id: i + 2 })));
  check('create: none past the limit', full.account === null && full.list.length === A.MAX_ACCOUNTS);
  check('create: a name given', A.create([], 'Personal').account.name === 'Personal');
}
check('rename: trimmed, control characters out, capped at 40; empty keeps the old name', A.rename([{ id: 2 }], 2, '  Personal\n MS  ')[0].name === 'Personal MS'
  && A.rename([{ id: 2, name: 'Old' }], 2, '   ')[0].name === 'Old' && A.rename([{ id: 2 }], 2, 'x'.repeat(80))[0].name.length === 40);
check('rename: only that account', J(A.rename([{ id: 2 }, { id: 3 }], 3, 'B').map((a) => a.name)) === J(['Account 2', 'B']));
check('recolor: a #rrggbb color only', A.recolor([{ id: 2 }], 2, '#ABCDEF')[0].color === '#abcdef' && A.recolor([{ id: 2 }], 2, 'url(x)')[0].color === A.COLORS[0]);
check('otherThan: from the main session the first account; from an account the next one; none yet is null',
  A.otherThan([{ id: 3 }, { id: 2 }], null) === 2 && A.otherThan([{ id: 2 }, { id: 3 }], 2) === 3 && A.otherThan([{ id: 2 }], 2) === null && A.otherThan([], null) === null);

// ---- sign-in pages
const signIns = [
  'https://login.microsoftonline.com/1a2b3c4d-0000-0000-0000-000000000000/oauth2/v2.0/authorize?client_id=x',
  'https://login.live.com/oauth20_authorize.srf?client_id=1',
  'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2F',
  'https://appleid.apple.com/auth/authorize',
  'https://github.com/login?return_to=%2Fsettings',
  'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2F',
];
check('isSignInUrl: Microsoft (school tenant and personal), Google, Apple, GitHub, Amazon', signIns.every(A.isSignInUrl), signIns.filter((u) => !A.isSignInUrl(u)).join(' '));
const notSignIns = ['https://portal.azure.com/', 'https://github.com/emah-maker/lumen', 'https://www.google.com/search?q=login', 'http://login.microsoftonline.com/', 'https://login.microsoftonline.com.evil.test/', 'not a url', 'https://mail.google.com/'];
check('isSignInUrl: ordinary pages, plain http and look-alike hosts are not', notSignIns.every((u) => !A.isSignInUrl(u)), notSignIns.filter(A.isSignInUrl).join(' '));
{
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  const hint = new RegExp(/const SIGN_IN_HINT = \/(.+)\/i;/.exec(main)?.[1] || 'x^', 'i');
  check("main.js's quick look (SIGN_IN_HINT) lets every sign-in page through", signIns.every((u) => hint.test(u)), signIns.filter((u) => !hint.test(u)).join(' '));
}

// ---- where the sign-in started
const azure = 'https://login.microsoftonline.com/1a2b3c4d-0000-0000-0000-000000000000/oauth2/v2.0/authorize?client_id=c44b4083&redirect_uri=https%3A%2F%2Fportal.azure.com%2Fsignin%2Findex%2F&response_mode=form_post';
check('startSiteFor: the address the tab was going to (portal.azure.com, typed)', A.startSiteFor(azure, 'https://portal.azure.com/#home') === 'https://portal.azure.com/#home');
check('startSiteFor: no such address: the home of the site the sign-in returns to (redirect_uri)', A.startSiteFor(azure, '') === 'https://portal.azure.com/');
check('startSiteFor: an old page before it loses to the return address; with none, it is used', A.startSiteFor(azure, 'https://www.bing.com/search?q=azure', { recent: false }) === 'https://portal.azure.com/'
  && A.startSiteFor('https://login.live.com/login.srf', 'https://outlook.live.com/mail/', { recent: false }) === 'https://outlook.live.com/mail/');
check('startSiteFor: a page that was itself a sign-in page is not a start', A.startSiteFor(azure, 'https://login.live.com/x') === 'https://portal.azure.com/');
check("startSiteFor: Google's continue, GitHub's relative return_to falls back to the page", A.startSiteFor(signIns[2]) === 'https://mail.google.com/' && A.startSiteFor(signIns[4]) === signIns[4]);
check('startSiteFor: a return address that is a sign-in page or not http(s) is skipped', A.startSiteFor('https://accounts.google.com/x?continue=https%3A%2F%2Faccounts.google.com%2Fy&next=javascript%3Aalert(1)') === 'https://accounts.google.com/x?continue=https%3A%2F%2Faccounts.google.com%2Fy&next=javascript%3Aalert(1)');
check('startSiteFor: not a sign-in page and nothing known is null', A.startSiteFor('https://example.test/') === null && A.startSiteFor('junk') === null);

// ---- the runtime (fake sessions): sessions made once, accounts saved through the given store
{
  let saved = [];
  const made = [];
  const rt = A.createAccountTabs({
    session: { fromPartition: (p) => ({ partition: p }) },
    readAccounts: () => saved, writeAccounts: (list) => { saved = list; },
    prepareSession: (ses, id) => made.push([ses.partition, id]),
    extensionsSource: () => null,
  });
  const a = rt.add();
  rt.rename(a.id, 'Personal');
  const s1 = rt.session(a.id);
  const s2 = rt.session(a.id);
  check('runtime: add + rename saved; the session is made and prepared once', saved.length === 1 && saved[0].name === 'Personal' && s1 === s2 && J(made) === J([['persist:lumen-account-2', 2]]) && rt.owns(s1) && !rt.owns({}), J({ saved, made }));
  check('runtime: badge is { id, name, color }; unknown ids are null', J(rt.badge(2)) === J({ id: 2, name: 'Personal', color: A.COLORS[0] }) && rt.badge(9) === null && rt.extensionsFor(s1) === null);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
