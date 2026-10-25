// GitHub through a personal access token, api.github.com only. Pull requests and issues come from the search API ("@me" is the
// token's owner); one pull request is read from its own endpoints. Two writes, each after the user allows its card: a comment on an
// issue or pull request, and a new issue. A read-only token can't do them, and GitHub's 403 says so.
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

// A write: POST with the JSON body. A token without write access answers 403 ("Resource not accessible"), or 404 for a repository it can't see.
async function post(ctx, path, json) {
  const res = await ctx.http(path, { method: 'POST', json, headers: HEADERS });
  if (res.status === 401) throw new ConnectorError('GitHub refused the token. Connect GitHub again with a new one.', 'auth');
  let message;
  try { message = flat(JSON.parse(res.text)?.message, 200); } catch { message = flat(res.text, 200); }
  const limited = res.status === 429 || (res.status === 403 && (/rate limit|secondary/i.test(message) || res.headers.get('x-ratelimit-remaining') === '0'));
  if (limited) throw new ConnectorError('GitHub is limiting requests right now. Try again in a minute.', 'rate');
  // A "Sign in with GitHub" token (OAuth) or a classic token lists its scopes; without repo or public_repo it can't write, and GitHub answers 404 or 403.
  const scopes = res.headers.get('x-oauth-scopes');
  if ((res.status === 404 || res.status === 403) && typeof scopes === 'string' && !scopes.split(',').map((x) => x.trim()).some((x) => x === 'repo' || x === 'public_repo')) {
    throw new ConnectorError(ctx.config?.shared
      ? 'The GitHub sign-in can only read, so it can’t comment or open issues (or that repository doesn’t exist). To allow it, turn on “Include private repositories” in Settings → Home → Widgets → GitHub and sign in again (GitHub’s “repo” permission, which allows writing), or use the GitHub CLI sign-in there.'
      : 'This token can’t write (or that repository doesn’t exist): give it repo (or public_repo) scope, or use a fine-grained token with Issues and Pull requests “Read and write”. Then connect GitHub again in Settings → AI and agents → Connectors.', 'scope');
  }
  if (res.status === 404) throw new ConnectorError('GitHub can’t find that repository, issue or pull request (or the token can’t see it). Check the name and number.', 'missing');
  if (res.status === 403) {
    if (/resource not accessible/i.test(message)) throw new ConnectorError(`The GitHub token can only read here. To comment or open issues, edit the token at github.com/settings/personal-access-tokens: give it this repository and Issues and Pull requests “Read and write”. Then ${ctx.config?.shared ? 'try again (the token stays the same)' : 'connect GitHub again in Settings → AI and agents → Connectors'}.`, 'scope');
    if (/locked/i.test(message)) throw new ConnectorError('That conversation is locked on GitHub, so it can’t take new comments.', 'other');
    if (/archived/i.test(message)) throw new ConnectorError('That repository is archived on GitHub, so it is read-only.', 'other');
    throw new ConnectorError(`GitHub refused that${message ? `: ${message}` : '.'}`, 'other');
  }
  if (res.status === 410) throw new ConnectorError('Issues are turned off in that repository.', 'missing');
  if (res.status === 422) throw new ConnectorError(`GitHub didn’t accept that: ${flat(res.text, 160)}`, 'args');
  if (!res.ok) throw new ConnectorError(`GitHub answered ${res.status}.`);
  try { return JSON.parse(res.text); } catch { throw new ConnectorError('GitHub sent something unexpected.'); }
}
const webLink = (u) => (/^https:\/\/github\.com\//.test(String(u || '')) ? String(u) : '');

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

  // Issues and pull requests share the comments endpoint.
  async comment(ctx, { repo, number, body }) {
    const c = await post(ctx, `/repos/${repo}/issues/${number}/comments`, { body });
    return { text: `Commented on ${repo}#${number}.`, link: webLink(c?.html_url), done: `Commented on ${repo}#${number}` };
  },

  async create_issue(ctx, { repo, title, body }) {
    const json = { title };
    if (body) json.body = body;
    const i = await post(ctx, `/repos/${repo}/issues`, json);
    const n = Number(i?.number) || 0;
    return { text: `Opened ${repo}#${n}: ${flat(i?.title || title, 200)}`, link: webLink(i?.html_url), done: `Opened ${repo}#${n}` };
  },
};

// What the card shows: where it goes (fixed) and, in `describeWrite`, everything that will be sent.
function describeWhere(action, args) {
  if (action === 'comment') return `Comment on ${args.repo}#${args.number}`;
  if (action === 'create_issue') return `New issue in ${args.repo}`;
  return '';
}
function describeWrite(action, args) {
  if (action === 'comment') return `${describeWhere(action, args)}:\n\n${args.body}`;
  if (action === 'create_issue') return `${describeWhere(action, args)}\nTitle: ${args.title}\n\n${args.body || '(no description)'}`;
  return '';
}

module.exports = { verify, actions, describeWrite, describeWhere };
