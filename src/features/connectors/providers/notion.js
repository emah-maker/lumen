// Notion through an internal integration secret, api.notion.com only. The integration sees only the pages the
// user shared with it. Reads a search and the text of one page.
'use strict';
const { flat, clip, when, ConnectorError } = require('../util');

const HEADERS = { 'Notion-Version': '2022-06-28' };

async function call(ctx, path, opts) {
  const res = await ctx.http(path, { ...opts, headers: HEADERS });
  if (res.status === 401) throw new ConnectorError('Notion refused the secret. Connect Notion again with a new one.', 'auth');
  if (res.status === 404) throw new ConnectorError('Notion can’t find that page. Share it with the integration (page menu, Connections).', 'missing');
  if (res.status === 429) throw new ConnectorError('Notion is limiting requests right now. Try again in a minute.', 'rate');
  if (!res.ok) throw new ConnectorError(`Notion answered ${res.status}.`);
  try { return JSON.parse(res.text); } catch { throw new ConnectorError('Notion sent something unexpected.'); }
}

async function verify(ctx) {
  const res = await ctx.http('/users/me', { headers: HEADERS });
  if (!res.ok) return { status: res.status };
  let me = {};
  try { me = JSON.parse(res.text); } catch { /* an answer without a name */ }
  return { status: 200, account: flat(me.bot?.workspace_name || me.name, 80) };
}

const plain = (rich) => (Array.isArray(rich) ? rich.map((r) => r?.plain_text || '').join('') : '');
const titleOf = (o) => {
  if (Array.isArray(o?.title)) return plain(o.title);
  const prop = Object.values(o?.properties || {}).find((p) => p?.type === 'title');
  return plain(prop?.title);
};
const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/i;

// One block as a line of text.
function blockText(b) {
  const t = b?.type;
  const d = b?.[t];
  if (!d) return '';
  const text = plain(d.rich_text);
  switch (t) {
    case 'heading_1': return `# ${text}`;
    case 'heading_2': return `## ${text}`;
    case 'heading_3': return `### ${text}`;
    case 'bulleted_list_item': return `- ${text}`;
    case 'numbered_list_item': return `1. ${text}`;
    case 'to_do': return `[${d.checked ? 'x' : ' '}] ${text}`;
    case 'quote': return `> ${text}`;
    case 'code': return `\`\`\`\n${text}\n\`\`\``;
    case 'child_page': return `(sub-page: ${flat(d.title, 120)} ${b.id})`;
    case 'divider': return '---';
    default: return text;
  }
}

const actions = {
  async search(ctx, { query }) {
    const body = await call(ctx, '/search', { method: 'POST', json: { query, page_size: 10, sort: { direction: 'descending', timestamp: 'last_edited_time' } } });
    const list = Array.isArray(body?.results) ? body.results : [];
    if (!list.length) return 'Nothing found. Only pages shared with the integration can be searched.';
    return list.map((o) => `${flat(o.id, 40)}  ${flat(titleOf(o), 160) || '(untitled)'} · ${o.object}${o.last_edited_time ? ` · edited ${when(o.last_edited_time, { dateOnly: true })}` : ''}`).join('\n');
  },

  async page(ctx, { id }) {
    const m = ID.exec(String(id));
    if (!m) throw new ConnectorError('id is a page id (32 letters and digits) or the page’s address.', 'args');
    const pid = m[0].replace(/-/g, '');
    const [page, blocks] = await Promise.all([call(ctx, `/pages/${pid}`), call(ctx, `/blocks/${pid}/children`, { query: { page_size: '100' } })]);
    const body = (Array.isArray(blocks?.results) ? blocks.results : []).map(blockText).filter(Boolean).join('\n');
    return `${flat(titleOf(page), 200) || '(untitled)'}\n\n${clip(body || '(empty page)', 6000)}${blocks?.has_more ? '\n[the page continues]' : ''}`;
  },
};

module.exports = { verify, actions };
