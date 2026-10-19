// analyze_posts: which posts beat their own account's normal? Pure local math (no network, no tab, no Electron), so the AI
// does not have to do arithmetic over dozens of rows (and get it wrong).
//
//   baseline  the MEDIAN of the primary metric per account, and per account + format when that format has >= MIN_FORMAT rows
//             (a reel is compared with that account's reels, not with its photos). A median, so one hit does not hide itself.
//   metric    'views' (video-like rows), 'engagement' (likes + replies + reposts + comments + shares, for text rows), or 'auto':
//             views when most rows carry them, else engagement.
//   lift      value / baseline. huge >= 5x, strong >= 2x, mild >= 1.5x; anything below that is not listed.
//   caution   an account with fewer than MIN_CONFIDENT rows gets "low confidence"; rows with no usable number, or a zero
//             baseline, are named under "Not enough data" instead of being guessed at.
const MAX_ROWS = 200;
const MIN_FORMAT = 5;
const MIN_CONFIDENT = 10;
const LABELS = [[5, 'huge'], [2, 'strong'], [1.5, 'mild']];
const ENGAGEMENT = ['likes', 'replies', 'reposts', 'comments', 'shares'];
const METRICS = ['views', 'engagement', 'auto'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmt(n) {
  if (!Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  const short = (x, unit) => `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10}${unit}`;
  if (a >= 1e9) return short(n / 1e9, 'B');
  if (a >= 1e6) return short(n / 1e6, 'M');
  if (a >= 1e4) return short(n / 1e3, 'K');
  return String(Math.round(n * 10) / 10);
}
const labelOf = (lift) => (LABELS.find(([min]) => lift >= min) || [])[1] || null;

// -> { error } for input that cannot be analysed, else { metric, rows, accounts, outliers, notes, capped }.
function analyze(input) {
  const posts = input && input.posts;
  if (!Array.isArray(posts) || !posts.length) return { error: 'posts must be a non-empty array of { url, account?, format?, views?, likes?, replies?, reposts?, comments?, shares? }.' };
  if (input.metric !== undefined && !METRICS.includes(input.metric)) return { error: `metric must be one of ${METRICS.join(', ')}.` };
  const capped = posts.length > MAX_ROWS ? posts.length : 0;
  const rows = [];
  for (const [i, p] of posts.slice(0, MAX_ROWS).entries()) {
    if (!p || typeof p !== 'object') continue;
    const raw = {};
    for (const k of ['views', ...ENGAGEMENT]) { const v = num(p[k]); if (v !== undefined) raw[k] = v; }
    const present = ENGAGEMENT.filter((k) => raw[k] !== undefined);
    rows.push({
      url: text(p.url, 300) || `row ${i + 1}`,
      account: text(p.account, 80).replace(/^@/, '') || '(unknown)',
      format: text(p.format, 30).toLowerCase(),
      date: text(p.date, 40),
      raw,
      views: raw.views,
      engagement: present.length ? present.reduce((s, k) => s + raw[k], 0) : undefined,
    });
  }
  if (!rows.length) return { error: 'posts has no usable rows.' };
  const metric = input.metric === 'views' || input.metric === 'engagement' ? input.metric
    : rows.filter((r) => r.views !== undefined).length * 2 > rows.length ? 'views' : 'engagement';

  const notes = [];
  if (capped) notes.push(`${capped} rows given; only the first ${MAX_ROWS} were used.`);
  const usable = [];
  const missing = [];
  for (const r of rows) {
    r.value = r[metric];
    (r.value === undefined ? missing : usable).push(r);
  }
  if (missing.length) notes.push(`${missing.length} row${missing.length === 1 ? ' has' : 's have'} no ${metric} number and ${missing.length === 1 ? 'was' : 'were'} skipped.`);

  const byAccount = new Map();
  for (const r of usable) {
    if (!byAccount.has(r.account)) byAccount.set(r.account, []);
    byAccount.get(r.account).push(r);
  }
  const accounts = [];
  const outliers = [];
  for (const [name, list] of byAccount) {
    const baseline = median(list.map((r) => r.value));
    const formats = new Map();
    for (const r of list) if (r.format) formats.set(r.format, [...(formats.get(r.format) || []), r]);
    const perFormat = [];
    const formatBase = new Map();
    for (const [f, fr] of formats) if (fr.length >= MIN_FORMAT) { const b = median(fr.map((r) => r.value)); formatBase.set(f, b); perFormat.push({ format: f, baseline: b, n: fr.length }); }
    const low = list.length < MIN_CONFIDENT;
    accounts.push({ account: name, baseline, n: list.length, low, formats: perFormat });
    if (low) notes.push(`@${name}: only ${list.length} row${list.length === 1 ? '' : 's'}, so its baseline is low confidence (${MIN_CONFIDENT}+ is better).`);
    for (const r of list) {
      const base = formatBase.has(r.format) ? formatBase.get(r.format) : baseline;
      if (!(base > 0)) { if (r.value > 0) notes.push(`@${name}: baseline is 0 for ${r.format || 'its posts'}, so ${r.url} has no lift.`); continue; }
      const lift = r.value / base;
      const label = labelOf(lift);
      if (label) outliers.push({ url: r.url, account: name, format: r.format, value: r.value, lift, label, baseline: base, scope: formatBase.has(r.format) ? r.format : 'all', low, raw: r.raw, date: r.date });
    }
  }
  outliers.sort((a, b) => b.lift - a.lift);
  return { metric, rows: rows.length, accounts, outliers, notes, capped };
}

// The text the AI reads: kept short, since it goes into the conversation.
function render(result) {
  if (result.error) return `Error: ${result.error}`;
  const unit = result.metric;
  const out = [`${unit} baselines (median), ${result.rows} posts:`];
  for (const a of result.accounts) {
    const fm = a.formats.map((f) => `${f.format} ${fmt(f.baseline)} (n=${f.n})`).join(', ');
    out.push(`@${a.account}: ${fmt(a.baseline)} (n=${a.n}${a.low ? ', low confidence' : ''})${fm ? `; ${fm}` : ''}`);
  }
  out.push('');
  if (result.outliers.length) {
    out.push('Outliers by lift:');
    result.outliers.forEach((o, i) => {
      const detail = Object.entries(o.raw).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
      out.push(`${i + 1}. ${o.url} | @${o.account}${o.format ? ` ${o.format}` : ''} | ${unit} ${fmt(o.value)} | ×${Math.round(o.lift * 10) / 10} ${o.label}${o.low ? ' (low confidence)' : ''}${o.date ? ` | ${o.date}` : ''}${unit === 'engagement' ? ` | ${detail}` : ''}`);
    });
  } else out.push('No outliers: nothing reached 1.5x its baseline.');
  if (result.notes.length) out.push('', 'Not enough data:', ...result.notes.map((n) => `- ${n}`));
  return out.join('\n');
}

const run = (input) => render(analyze(input));

module.exports = { analyze, render, run, median, fmt, labelOf, MAX_ROWS, MIN_FORMAT, MIN_CONFIDENT };
