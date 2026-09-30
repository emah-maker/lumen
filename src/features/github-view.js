// What a GitHub widget shows: its per-widget settings (validated), the searches it asks api.github.com,
// how GitHub's answers (and refusals: a bad token, rate limits) are read, and the display data the card
// gets. Pure functions, no network and no Electron: features/widgets.js does the fetching, and
// test/github-units.js exercises all of this on its own. The token never comes near this file.
'use strict';

const MAXES = [5, 10, 20]; // items per list; one search page each, so this is also the paging cap
const MAX_NOTIFICATIONS = 999; // the unread count is shown as "999+" beyond this
const MAX_WAIT = 3600e3; // never wait longer than an hour on a rate limit
const MIN_WAIT = 5e3;
const TOKEN_PATTERN = /^(?:github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255})$/;

const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

// The stored (or form) config -> a complete, checked one. Anything missing or wrong falls back to
// the default: all three lists on, ten items each, draft pull requests shown.
function cleanConfig(c) {
  const i = c && typeof c === 'object' ? c : {};
  const out = {
    reviews: bool(i.reviews, true),
    assigned: bool(i.assigned, true),
    notifications: bool(i.notifications, true),
    max: MAXES.includes(i.max) ? i.max : 10,
    hideDrafts: i.hideDrafts === true,
  };
  if (!out.reviews && !out.assigned && !out.notifications) Object.assign(out, { reviews: true, assigned: true, notifications: true }); // a card of nothing is the default card
  return out;
}
const nameFor = () => 'GitHub';
function summaryFor(cfg) {
  const parts = [cfg.reviews && 'review requests', cfg.assigned && 'assigned', cfg.notifications && 'unread'].filter(Boolean);
  return `${parts.join(', ')} · ${cfg.max} each`;
}

// A pasted token: a fine-grained personal access token (github_pat_…), or the classic/OAuth kinds.
const looksLikeToken = (t) => typeof t === 'string' && TOKEN_PATTERN.test(t);

// The searches (GitHub's search syntax; @me is the token's own user).
function searchFor(kind, cfg) {
  const base = 'is:open archived:false';
  if (kind === 'reviews') return `${base} is:pr review-requested:@me${cfg.hideDrafts ? ' draft:false' : ''}`;
  return `${base} assignee:@me`;
}
// Where "Open GitHub" goes.
const openUrlFor = (kind) => (kind === 'reviews' ? 'https://github.com/pulls/review-requested' : kind === 'assigned' ? 'https://github.com/issues/assigned' : kind === 'notifications' ? 'https://github.com/notifications' : 'https://github.com/');

// An issue or pull request from /search/issues -> what the card shows, or null. Only github.com
// issue and pull request addresses are kept; every text is flattened (the page sets it with textContent).
const ITEM_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(issues|pull)\/(\d{1,9})$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const m = ITEM_URL.exec(typeof raw.html_url === 'string' ? raw.html_url : '');
  const title = flat(raw.title, 300);
  if (!m || !title) return null;
  const at = typeof raw.updated_at === 'string' ? Date.parse(raw.updated_at) : NaN;
  const login = typeof raw.user?.login === 'string' && LOGIN.test(raw.user.login) ? raw.user.login : '';
  return {
    id: `${m[1]}/${m[2]}#${m[4]}`,
    kind: m[3] === 'pull' ? 'pr' : 'issue',
    title, url: raw.html_url, repo: `${m[1]}/${m[2]}`, number: Number(m[4]), author: login,
    updated: Number.isFinite(at) ? at : null,
    draft: raw.draft === true,
    comments: Number.isInteger(raw.comments) && raw.comments >= 0 ? Math.min(raw.comments, 9999) : 0,
  };
}
// A /search/issues answer -> { items (at most `max`), total, partial }, or null when it isn't one.
function readSearch(body, cfg) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return null;
  const seen = new Set();
  let items = body.items.map(normalizeItem).filter((it) => it && !seen.has(it.id) && seen.add(it.id));
  if (cfg.hideDrafts) items = items.filter((it) => !it.draft);
  const total = Number.isInteger(body.total_count) && body.total_count >= items.length ? body.total_count : items.length;
  return { items: items.slice(0, cfg.max), total, partial: body.incomplete_results === true };
}

// The unread count from GET /notifications?per_page=1: the page number of the "last" link is the count
// (one request instead of walking pages); with no link the list is at most one long.
function lastPage(link) {
  if (typeof link !== 'string') return null;
  for (const part of link.split(',')) {
    if (!/rel="last"/.test(part)) continue;
    const n = /[?&]page=(\d{1,9})(?:&|>)/.exec(part);
    if (n) return Number(n[1]);
  }
  return null;
}
function readNotificationCount(body, link) {
  if (!Array.isArray(body)) return null;
  const n = lastPage(link) ?? body.length;
  return { count: Math.min(n, MAX_NOTIFICATIONS), capped: n > MAX_NOTIFICATIONS };
}
const countLabel = (n) => (n.capped ? `${MAX_NOTIFICATIONS}+` : String(n.count));

// ---- refusals ----
const header = (h, name) => {
  const v = typeof h?.get === 'function' ? h.get(name) : h?.[name];
  return v === null || v === undefined ? '' : String(v).trim();
};
const wait = (ms) => Math.min(MAX_WAIT, Math.max(MIN_WAIT, ms));
// How long to wait after a rate limit, in ms, or 0 when the answer is not one. GitHub says so three ways:
// 429, or 403, with Retry-After (seconds; the secondary limits), or x-ratelimit-remaining: 0 with
// x-ratelimit-reset (epoch seconds; the primary limit). A 403 whose message mentions the rate limit
// with neither header is treated as one too. `now` is in ms.
function rateLimitWait(status, headers, body, now) {
  const limited403 = status === 403 && (header(headers, 'x-ratelimit-remaining') === '0' || header(headers, 'retry-after') !== '' || /rate limit|abuse/i.test(apiMessage(body)));
  if (status !== 429 && !limited403) return 0;
  const after = Number(header(headers, 'retry-after'));
  if (header(headers, 'retry-after') !== '' && Number.isFinite(after) && after >= 0) return wait(after * 1000);
  const reset = Number(header(headers, 'x-ratelimit-reset'));
  if (header(headers, 'x-ratelimit-reset') !== '' && Number.isFinite(reset) && reset > 0) return wait(reset * 1000 - now);
  return wait(60e3);
}
function apiMessage(body) {
  if (typeof body !== 'string' || !body) return '';
  try { return flat(JSON.parse(body)?.message, 160); } catch { return ''; }
}
const inText = (ms) => (ms < 90e3 ? 'a minute' : ms < 3600e3 - 30e3 ? `${Math.round(ms / 60e3)} minutes` : 'an hour');
// A failed answer -> { kind: 'auth' | 'rate' | 'scope' | 'missing' | 'other', message, waitMs }.
function classify(status, headers, body, now) {
  if (status === 401) return { kind: 'auth', waitMs: 0, message: 'GitHub rejected the token (401): it may be expired, revoked or mistyped. Paste a new one in Settings.' };
  const waitMs = rateLimitWait(status, headers, body, now);
  if (waitMs) return { kind: 'rate', waitMs, message: `GitHub’s rate limit is used up. Lumen will try again in ${inText(waitMs)}.` };
  if (status === 403) {
    const said = apiMessage(body);
    return { kind: 'scope', waitMs: 0, message: `GitHub refused this (403)${said ? `: ${said}` : ''}. Check the token’s permissions and the repositories it can reach.` };
  }
  if (status === 404) return { kind: 'missing', waitMs: 0, message: 'GitHub says that isn’t available to this token (404).' };
  if (status === 422) return { kind: 'scope', waitMs: 0, message: 'GitHub couldn’t run the search (422). The token may not reach any repository.' };
  if (status >= 500) return { kind: 'other', waitMs: 0, message: `GitHub is having trouble (${status}). Lumen will try again shortly.` };
  return { kind: 'other', waitMs: 0, message: `GitHub answered ${status}.` };
}

// The lists -> what the card gets. Each is { items, total, partial } | { error } | absent (switched off).
function shape({ reviews, assigned, notifications }, cfg) {
  const list = (r) => (r ? (r.error ? { error: flat(r.error, 200) } : { items: r.items, total: r.total, partial: r.partial }) : null);
  return {
    name: nameFor(cfg),
    reviews: list(reviews),
    assigned: list(assigned),
    notifications: notifications ? (notifications.error ? { error: flat(notifications.error, 200) } : { count: notifications.count, capped: notifications.capped, label: countLabel(notifications) }) : null,
    open: openUrlFor(cfg.reviews ? 'reviews' : cfg.assigned ? 'assigned' : 'notifications'),
    openNotifications: openUrlFor('notifications'),
    openReviews: openUrlFor('reviews'),
    openAssigned: openUrlFor('assigned'),
  };
}

module.exports = {
  MAXES, MAX_NOTIFICATIONS, TOKEN_PATTERN,
  cleanConfig, nameFor, summaryFor, looksLikeToken, searchFor, openUrlFor, normalizeItem, readSearch,
  lastPage, readNotificationCount, countLabel, rateLimitWait, classify, apiMessage, shape,
};
