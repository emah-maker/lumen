// Google Contacts through the shared Google sign-in (connectors/google-auth.js), with the People API v1 at people.googleapis.com.
// Read only (contacts.readonly): find a person by name, email, phone or company. It can't add, change or delete a contact.
'use strict';
const { flat } = require('../util');
const G = require('./_google');

const MASK = 'names,emailAddresses,phoneNumbers,organizations';

async function verify(ctx) {
  const res = await ctx.http('/people:searchContacts', { query: { query: '', readMask: 'names', pageSize: '1' }, allowAuth: true });
  return res.ok ? { status: 200, account: ctx.email } : { status: res.status, message: res.status === 403 ? G.failure(ctx, res).message : '' };
}

const list = (a, key, n = 3) => (Array.isArray(a) ? a.slice(0, n).map((x) => flat(x?.[key], 120)).filter(Boolean) : []);
function line(p) {
  const org = Array.isArray(p.organizations) ? p.organizations.find((o) => o?.name || o?.title) : null;
  return [
    flat(p.names?.[0]?.displayName, 120) || '(no name)',
    ...list(p.emailAddresses, 'value'),
    ...list(p.phoneNumbers, 'value', 2),
    org ? [org.title, org.name].map((x) => flat(x, 80)).filter(Boolean).join(', ') : '',
  ].filter(Boolean).join(' · ');
}

const actions = {
  async search(ctx, { query, max = 10 }) {
    // The People API wants an empty search first, to warm its cache for this user; without it a new user's first search can come back empty.
    await ctx.http('/people:searchContacts', { query: { query: '', readMask: 'names', pageSize: '1' } }).catch(() => null);
    const b = G.json(ctx, await ctx.http('/people:searchContacts', { query: { query, readMask: MASK, pageSize: String(max) } }), { thing: 'your contacts' });
    const people = (Array.isArray(b.results) ? b.results : []).map((r) => r.person).filter(Boolean);
    return people.length ? people.slice(0, max).map(line).join('\n') : `No contact matches “${flat(query, 80)}”.`;
  },
};

module.exports = { verify, actions };
