// Notion through an internal integration secret, api.notion.com only. The integration sees only the pages the
// user shared with it. Reads a search and the text of one page; after the user allows the card, adds a page under a
// shared page or adds text to the end of one (the integration needs its "Insert content" capability for that).
'use strict';
const { flat, clip, when, ConnectorError } = require('../util');

const HEADERS = { 'Notion-Version': '2022-06-28' };

const NO_INSERT = 'The Notion integration isn’t allowed to add content. In Notion, open the integration at notion.so/profile/integrations, turn on “Insert content” under Capabilities and save, then try again.';

async function call(ctx, path, opts = {}) {
  const res = await ctx.http(path, { ...opts, headers: HEADERS });
  if (res.status === 401) throw new ConnectorError('Notion refused the secret. Connect Notion again with a new one.', 'auth');
  if (res.status === 403) throw new ConnectorError(opts.method && opts.method !== 'GET' ? NO_INSERT : 'The Notion integration isn’t allowed to read content. Turn on “Read content” in its capabilities.', 'scope');
  if (res.status === 400) throw new ConnectorError(`Notion didn’t accept that: ${flat(res.text, 160)}`, 'args');
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
// A page id from an id or an address: the last id in it (an address ends in the page's own), without dashes, or ''.
const pageId = (v) => { const all = String(v || '').match(new RegExp(ID.source, 'gi')); return all ? all[all.length - 1].replace(/-/g, '').toLowerCase() : ''; };

// Text as Notion blocks, a line each: # ## ### headings, - or * bullets, 1. numbered, > quotes, the rest paragraphs. Notion
// takes at most 2000 characters in one piece of text, so a long line is split into pieces.
const rich = (t) => { const out = []; for (let i = 0; i < t.length || !out.length; i += 2000) out.push({ type: 'text', text: { content: t.slice(i, i + 2000) } }); return out; };
function toBlocks(body) {
  const blocks = [];
  for (const raw of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m;
    let type = 'paragraph';
    let t = line;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { type = `heading_${m[1].length}`; t = m[2]; } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { type = 'bulleted_list_item'; t = m[1]; } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { type = 'numbered_list_item'; t = m[1]; } else if ((m = /^>\s?(.*)$/.exec(line))) { type = 'quote'; t = m[1]; }
    blocks.push({ object: 'block', type, [type]: { rich_text: rich(t) } });
  }
  return blocks;
}
// Notion adds at most 100 blocks a request: the rest follow in more requests, in order.
async function appendBlocks(ctx, pid, blocks) {
  for (let i = 0; i < blocks.length; i += 100) await call(ctx, `/blocks/${pid}/children`, { method: 'PATCH', json: { children: blocks.slice(i, i + 100) } });
}
const pageLink = (p, pid) => (/^https:\/\/(www\.)?notion\.so\//.test(String(p?.url || '')) ? String(p.url) : `https://www.notion.so/${pid}`);

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

actions.create_page = async (ctx, { parent_id: parent, title, body }) => {
  const pid = pageId(parent);
  if (!pid) throw new ConnectorError('parent_id is a page id (32 letters and digits) or the page’s address.', 'args');
  const blocks = toBlocks(body);
  const page = await call(ctx, '/pages', { method: 'POST', json: { parent: { page_id: pid }, properties: { title: { title: rich(title) } }, children: blocks.slice(0, 100) } });
  const id = pageId(page?.id);
  if (blocks.length > 100 && id) await appendBlocks(ctx, id, blocks.slice(100));
  return { text: `Added the page “${flat(title, 160)}”${id ? ` (id ${id})` : ''}.`, link: pageLink(page, id || pid), done: `Added “${flat(title, 60)}”` };
};

actions.append = async (ctx, { page_id: target, body }) => {
  const pid = pageId(target);
  if (!pid) throw new ConnectorError('page_id is a page id (32 letters and digits) or the page’s address.', 'args');
  const blocks = toBlocks(body);
  if (!blocks.length) throw new ConnectorError('There is no text to add.', 'args');
  await appendBlocks(ctx, pid, blocks);
  return { text: `Added ${blocks.length} block${blocks.length === 1 ? '' : 's'} to the end of the page ${pid}.`, link: `https://www.notion.so/${pid}`, done: 'Added to a page' };
};

// The card names the page by its title (a read), so the user sees where it goes.
async function cardNames(ctx, action, args) {
  const pid = pageId(action === 'create_page' ? args.parent_id : args.page_id);
  if (!pid) return {};
  const page = await call(ctx, `/pages/${pid}`);
  return { page: flat(titleOf(page), 120) };
}
function describeWhere(action, args, names = {}) {
  const pid = pageId(action === 'create_page' ? args.parent_id : args.page_id);
  const where = `${names.page ? `“${names.page}” ` : ''}(${pid})`;
  if (action === 'create_page') return `New page under ${where}`;
  if (action === 'append') return `Add to the end of ${where}`;
  return '';
}
function describeWrite(action, args, names) {
  if (action === 'create_page') return `${describeWhere(action, args, names)}\nTitle: ${args.title}\n\n${args.body || '(empty page)'}`;
  if (action === 'append') return `${describeWhere(action, args, names)}:\n\n${args.body}`;
  return '';
}

module.exports = { verify, actions, describeWrite, describeWhere, cardNames, toBlocks, pageId };
