// Zotero through the user's API key, api.zotero.org only (Web API v3). Read only: search the library, list collections, read one item
// (title, authors, year, abstract, link). Notes and attachments' contents are not read.
'use strict';
const { flat, clip, ConnectorError } = require('../util');

const H = { 'Zotero-API-Version': '3' };

async function call(ctx, path, query) {
  const res = await ctx.http(path, { query, headers: H });
  if (res.status === 401 || res.status === 403) throw new ConnectorError('Zotero refused the key. Connect Zotero again with a new one (it needs read access to your library).', 'auth');
  if (res.status === 404) throw new ConnectorError('Zotero can’t find that.', 'missing');
  if (res.status === 429) throw new ConnectorError('Zotero is limiting requests right now. Try again in a minute.', 'rate');
  if (!res.ok) throw new ConnectorError(`Zotero answered ${res.status}.`);
  try { return JSON.parse(res.text); } catch { throw new ConnectorError('Zotero sent something unexpected.'); }
}

// The key says whose library it is: { userID, username }.
async function me(ctx) {
  const b = await call(ctx, '/keys/current');
  if (!Number.isInteger(b?.userID)) throw new ConnectorError('Zotero sent something unexpected.');
  if (b.access?.user?.library === false) throw new ConnectorError('That Zotero key can’t read your personal library. Make a new key with “Allow library access”.', 'auth');
  return { id: b.userID, name: flat(b.username, 60) };
}

async function verify(ctx) {
  const res = await ctx.http('/keys/current', { headers: H });
  if (!res.ok) return { status: res.status === 403 ? 401 : res.status };
  let b;
  try { b = JSON.parse(res.text); } catch { return { status: 502 }; }
  return Number.isInteger(b?.userID) ? { status: 200, account: flat(b.username, 80) || `user ${b.userID}` } : { status: 502 };
}

const creators = (d) => (Array.isArray(d.creators) ? d.creators.slice(0, 6).map((c) => flat(c.name || [c.firstName, c.lastName].filter(Boolean).join(' '), 80)).filter(Boolean).join(', ') : '');
const year = (d) => /\b(1[5-9]|20)\d{2}\b/.exec(String(d.date || ''))?.[0] || '';
function line(item) {
  const d = item.data || {};
  return `${flat(item.key, 20)}  ${flat(d.title, 200) || '(no title)'}${creators(d) ? ` · ${creators(d)}` : ''}${year(d) ? ` (${year(d)})` : ''} · ${flat(d.itemType, 30)}`;
}
const real = (item) => item?.data && item.data.itemType !== 'attachment' && item.data.itemType !== 'note';

const actions = {
  async search(ctx, { query, max = 15 }) {
    const { id } = await me(ctx);
    const items = await call(ctx, `/users/${id}/items/top`, { q: query, qmode: 'everything', limit: String(max), sort: 'dateModified', direction: 'desc', format: 'json' });
    const list = (Array.isArray(items) ? items : []).filter(real);
    return list.length ? list.map(line).join('\n') : `Nothing in your library matches “${flat(query, 80)}”.`;
  },

  async recent(ctx, { max = 15 } = {}) {
    const { id } = await me(ctx);
    const items = await call(ctx, `/users/${id}/items/top`, { limit: String(max), sort: 'dateAdded', direction: 'desc', format: 'json' });
    const list = (Array.isArray(items) ? items : []).filter(real);
    return list.length ? list.map(line).join('\n') : 'Your library is empty.';
  },

  async collections(ctx) {
    const { id } = await me(ctx);
    const cols = await call(ctx, `/users/${id}/collections`, { limit: '100', format: 'json' });
    const list = Array.isArray(cols) ? cols : [];
    return list.length ? list.map((c) => `${flat(c.key, 20)}  ${flat(c.data?.name, 100)} (${Number(c.meta?.numItems) || 0} items)`).join('\n') : 'No collections.';
  },

  async collection(ctx, { key, max = 25 }) {
    const { id } = await me(ctx);
    const items = await call(ctx, `/users/${id}/collections/${encodeURIComponent(key)}/items/top`, { limit: String(max), format: 'json' });
    const list = (Array.isArray(items) ? items : []).filter(real);
    return list.length ? list.map(line).join('\n') : 'That collection has no items.';
  },

  async item(ctx, { key }) {
    const { id } = await me(ctx);
    const item = await call(ctx, `/users/${id}/items/${encodeURIComponent(key)}`, { format: 'json' });
    const d = item?.data || {};
    const url = /^https?:\/\//.test(String(d.url || '')) ? flat(d.url, 300) : '';
    return [
      line(item),
      d.publicationTitle ? `In: ${flat(d.publicationTitle, 200)}` : '',
      d.DOI ? `DOI: ${flat(d.DOI, 100)}` : '',
      url ? `Link: ${url}` : '',
      d.abstractNote ? `\n${clip(d.abstractNote, 4000)}` : '',
    ].filter(Boolean).join('\n');
  },
};

module.exports = { verify, actions };
