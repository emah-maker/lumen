// GitHub through a personal access token (read-only is enough), api.github.com only. Pull requests and issues come
// from the search API ("@me" is the token's owner); one pull request is read from its own endpoints.
'use strict';
const { flat, clip, when, ConnectorError } = require('../util');

const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

async function get(ctx, path, query) {
  const res = await ctx.http(path, { query, headers: HEADERS });
  if (res.status === 401) throw new ConnectorError('GitHub refused the token. Connect GitHub again with a new one.', 'auth');
  if (res.status === 403 || res.status === 429) {
    const limited = /rate limit|secondary/i.test(res.text) || res.headers.get('x-ratelimit-remaining') === '0';
    throw new ConnectorError(limited ? 'GitHub is limiting requests right now. Try again in a minute.' : 'The token isn’t allowed to read that. Give it read access to pull requests and issues.', limited ? 'rate' : 'auth');
  }
  if (res.status === 404) throw new ConnectorError('GitHub can’t find that (or the token can’t see it).', 'missing');
  if (!res.ok) throw new ConnectorError(`GitHub answered ${res.status}.`);
  try { return JSON.parse(res.text); } catch { throw new ConnectorError('GitHub sent something unexpected.'); }
}

async function verify(ctx) {
  const res = await ctx.http('/user', { headers: HEADERS });
  if (!res.ok) return { status: res.status };
  let me = {};
  try { me = JSON.parse(res.text); } catch { /* an answer without a name */ }
  return { status: 200, account: flat(me.login, 60) };
}

const repoOf = (url) => /repos\/([^/]+\/[^/]+)$/.exec(String(url || ''))?.[1] || '';
const row = (i) => `${repoOf(i.repository_url)}#${i.number} ${flat(i.title, 160)} (${flat(i.user?.login, 40)}${i.draft ? ', draft' : ''}${i.state === 'closed' ? ', closed' : ''}) updated ${when(i.updated_at, { dateOnly: true })}`;

async function search(ctx, kind, role, state) {
  const parts = [kind === 'pr' ? 'is:pr' : 'is:issue', 'archived:false'];
  if (state !== 'all') parts.push(`is:${state}`);
  parts.push(role === 'review' ? 'review-requested:@me' : role === 'author' ? 'author:@me' : 'assignee:@me');
  const body = await get(ctx, '/search/issues', { q: parts.join(' '), sort: 'updated', order: 'desc', per_page: '20' });
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) return `No ${state === 'all' ? '' : `${state} `}${kind === 'pr' ? 'pull requests' : 'issues'} found.`;
  return `${items.slice(0, 20).map(row).join('\n')}${body.total_count > items.length ? `\n(${body.total_count} in all, newest ${items.length} shown)` : ''}`;
}

const actions = {
  prs: (ctx, { role = 'author', state = 'open' } = {}) => search(ctx, 'pr', role, state),
  issues: (ctx, { role = 'assigned', state = 'open' } = {}) => search(ctx, 'issue', role, state),

  async pr(ctx, { repo, number }) {
    const base = `/repos/${repo}/pulls/${number}`;
    const [pr, files] = await Promise.all([get(ctx, base), get(ctx, `${base}/files`, { per_page: '40' })]);
    const list = (Array.isArray(files) ? files : []).slice(0, 40).map((f) => `  ${flat(f.status, 12)} ${flat(f.filename, 200)} (+${Number(f.additions) || 0} -${Number(f.deletions) || 0})`);
    return [
      `${repo}#${number} ${flat(pr.title, 200)}`,
      `State: ${pr.merged ? 'merged' : flat(pr.state, 20)}${pr.draft ? ' (draft)' : ''} · by ${flat(pr.user?.login, 40)} · ${flat(pr.head?.ref, 80)} into ${flat(pr.base?.ref, 80)}`,
      `Changes: ${Number(pr.changed_files) || 0} files, +${Number(pr.additions) || 0} -${Number(pr.deletions) || 0}; ${Number(pr.comments) || 0} comments, ${Number(pr.review_comments) || 0} review comments`,
      `Updated ${when(pr.updated_at)}`,
      '',
      clip(pr.body || '(no description)', 3500),
      '',
      'Files:',
      ...list,
    ].join('\n');
  },
};

module.exports = { verify, actions };
