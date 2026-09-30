// TradingView widget, the pure part: symbol and option checks, and the address of TradingView's own
// embeddable chart for them. No network, no Electron, no key: the chart is TradingView's page in a
// sandboxed frame on the new-tab page (like a Web page card), so the quotes come from TradingView under
// its terms, straight to that frame. Lumen itself fetches nothing for it.
//
// The watchlist view is TradingView's Market Overview embed: rows of symbols with logo, price and change,
// grouped in tabs the way a TradingView watchlist groups them in sections (like its phone home-screen
// widget), with an optional chart of the picked row on top. Its symbols are typed, pasted from
// TradingView's "Export list" .txt, or imported from the user's own TradingView account: main.js reads
// ACCOUNT_URL with the user's TradingView cookies (never anyone else's address), and shapeLists() checks
// the answer. A list imported with sync on is read again every SYNC_MS, so edits in TradingView show up.
//
//   cleanConfig(tv)       a stored or typed { symbol, interval, view, theme, symbols?, chart?, list?, sync? } -> checked fields, or null
//   parseSymbols(v)       a typed or pasted list ("AAPL, TSLA" / "###Tech,NASDAQ:AAPL" / an array) -> entries, "###Name" for a section
//   sections(entries)     entries -> [{ title, symbols }] (the watchlist's tabs)
//   shapeLists(json)      TradingView's account answer -> { signedIn, lists: [{ id, name, symbols }] }
//   embedUrl(tv, dark)    the frame's https address on s.tradingview.com
//   isEmbedUrl(u)         whether an address is one embedUrl() could have made (the page checks this too)
'use strict';

// EXCHANGE:TICKER or a bare ticker, as TradingView writes them: NASDAQ:AAPL, BINANCE:BTCUSDT, SPX, BRK.B, ES1!.
const SYMBOL_RE = /^(?:[A-Z0-9_]{1,20}:)?[A-Z0-9][A-Z0-9._!-]{0,29}$/;
const INTERVALS = ['1', '5', '15', '30', '60', '240', 'D', 'W', 'M'];
const INTERVAL_NAMES = { 1: '1 minute', 5: '5 minutes', 15: '15 minutes', 30: '30 minutes', 60: '1 hour', 240: '4 hours', D: '1 day', W: '1 week', M: '1 month' };
const VIEWS = ['chart', 'mini', 'watchlist']; // the full chart with tools, a small price line, or a list of symbols
const THEMES = ['auto', 'light', 'dark']; // auto follows the new-tab page
const HOST = 's.tradingview.com';
const PATHS = ['/widgetembed/', '/embed-widget/mini-symbol-overview/', '/embed-widget/market-overview/'];
const MAX_SYMBOLS = 60;
const MAX_SECTIONS = 10;
const MAX_URL = 8000; // a full 60-symbol watchlist in the hash; the new-tab page allows this much for TradingView only
const SECTION = '###'; // TradingView's own marker for a section header in a list
const ACCOUNT_URL = 'https://www.tradingview.com/api/v1/symbols_list/custom/';
const SYNC_MS = 15 * 60e3;
// Index feeds TradingView won't price inside its widgets (the row stays blank; checked 2026-09-30), and the
// CFD that tracks each one and does get a price. Only the frame's address uses the twin: the row still
// reads SPX, and the stored list keeps the user's own symbol. Futures (ES1!) have no twin and stay blank.
const WIDGET_TWINS = {
  'SPCFD:SPX': 'FOREXCOM:SPXUSD', 'SP:SPX': 'FOREXCOM:SPXUSD', SPX: 'FOREXCOM:SPXUSD',
  'TVC:NDQ': 'FOREXCOM:NSXUSD', 'NASDAQ:NDX': 'FOREXCOM:NSXUSD', NDX: 'FOREXCOM:NSXUSD', NDQ: 'FOREXCOM:NSXUSD',
  'TVC:DJI': 'FOREXCOM:DJI', 'DJ:DJI': 'FOREXCOM:DJI', DJI: 'FOREXCOM:DJI',
  'CBOE:VIX': 'CAPITALCOM:VIX', 'TVC:VIX': 'CAPITALCOM:VIX', VIX: 'CAPITALCOM:VIX',
  'TVC:DXY': 'CAPITALCOM:DXY', DXY: 'CAPITALCOM:DXY',
};
const widgetRow = (sym) => (WIDGET_TWINS[sym] ? { s: WIDGET_TWINS[sym], d: sym.replace(/^[^:]*:/, '') } : { s: sym });

const cleanSymbol = (v) => {
  const s = typeof v === 'string' ? v.trim().toUpperCase().replace(/\s+/g, '') : '';
  return SYMBOL_RE.test(s) ? s : '';
};
const pick = (v, list, fallback) => (list.includes(String(v)) ? String(v) : fallback);
// A section or list name: plain text, short, nothing that could close an attribute or a tag.
const cleanName = (v, max = 40) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const cleanId = (v) => (Number.isSafeInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null);

function parseSymbols(v) {
  let tokens = [];
  if (Array.isArray(v)) tokens = v.filter((t) => typeof t === 'string');
  else if (typeof v === 'string') {
    // Commas and lines split; spaces split tickers too, but not a section's name ("###Big tech").
    for (const part of v.slice(0, 20000).split(/[,\n\r;]+/)) {
      const t = part.trim();
      if (t.startsWith(SECTION)) tokens.push(t);
      else tokens.push(...t.split(/\s+/));
    }
  }
  const out = [];
  const seen = new Set();
  let count = 0;
  let secs = 0;
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith(SECTION)) {
      const name = cleanName(t.slice(SECTION.length));
      if (!name || secs >= MAX_SECTIONS) continue;
      if (out.length && out[out.length - 1].startsWith(SECTION)) { out.pop(); secs -= 1; } // an empty section says nothing
      out.push(SECTION + name);
      secs += 1;
      continue;
    }
    const s = cleanSymbol(t);
    if (!s || seen.has(s) || count >= MAX_SYMBOLS) continue;
    seen.add(s);
    out.push(s);
    count += 1;
  }
  if (out.length && out[out.length - 1].startsWith(SECTION)) out.pop();
  return out;
}

function sections(entries, fallbackTitle = 'Watchlist') {
  const tabs = [];
  let cur = null;
  for (const e of entries || []) {
    if (e.startsWith(SECTION)) { cur = { title: e.slice(SECTION.length), symbols: [] }; tabs.push(cur); continue; }
    if (!cur) { cur = { title: cleanName(fallbackTitle) || 'Watchlist', symbols: [] }; tabs.push(cur); }
    cur.symbols.push(e);
  }
  return tabs.filter((t) => t.symbols.length);
}

const symbolsOf = (entries) => (entries || []).filter((e) => !e.startsWith(SECTION));

function cleanConfig(tv) {
  if (!tv || typeof tv !== 'object') return null;
  const view = pick(tv.view, VIEWS, 'chart');
  const base = { interval: pick(tv.interval, INTERVALS, 'D'), view, theme: pick(tv.theme, THEMES, 'auto') };
  if (view !== 'watchlist') {
    const symbol = cleanSymbol(tv.symbol);
    return symbol ? { symbol, ...base } : null;
  }
  const symbols = parseSymbols(tv.symbols);
  const first = symbolsOf(symbols)[0];
  if (!first) return null;
  const out = { symbol: first, ...base, symbols, chart: tv.chart === true };
  const id = cleanId(tv.list?.id);
  if (id) {
    out.list = { id, name: cleanName(tv.list.name, 60) || 'Watchlist' };
    out.sync = tv.sync !== false;
  }
  return out;
}

// TradingView's account answer: [{ id, name, symbols: ['###Section', 'NASDAQ:AAPL', …], … }]. Signed out,
// it still answers, with one sample list whose id is null, so an id is what says the lists are the user's.
function shapeLists(json) {
  const rows = Array.isArray(json) ? json.slice(0, 100) : [];
  const lists = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const id = cleanId(r.id);
    const symbols = parseSymbols(Array.isArray(r.symbols) ? r.symbols : []);
    if (!id || !symbolsOf(symbols).length) continue;
    lists.push({ id, name: cleanName(r.name, 60) || 'Watchlist', symbols, count: symbolsOf(symbols).length, active: r.active === true });
  }
  return { signedIn: rows.some((r) => r && cleanId(r.id)), lists };
}

function embedUrl(tv, dark) {
  const c = cleanConfig(tv);
  if (!c) return null;
  const theme = c.theme === 'auto' ? (dark ? 'dark' : 'light') : c.theme;
  if (c.view === 'watchlist') {
    const tabs = sections(c.symbols, c.list?.name).map((t) => ({ title: t.title, originalTitle: t.title, symbols: t.symbols.map(widgetRow) }));
    const opts = { colorTheme: theme, dateRange: miniRange(c.interval), showChart: c.chart, locale: 'en', width: '100%', height: '100%', isTransparent: true, showSymbolLogo: true, showFloatingTooltip: true, tabs };
    return `https://${HOST}/embed-widget/market-overview/?locale=en#${encodeURIComponent(JSON.stringify(opts))}`;
  }
  if (c.view === 'mini') {
    // The mini widget reads its options from the hash, as JSON.
    const opts = { symbol: WIDGET_TWINS[c.symbol] || c.symbol, width: '100%', height: '100%', dateRange: miniRange(c.interval), colorTheme: theme, isTransparent: true, autosize: true, locale: 'en' };
    return `https://${HOST}/embed-widget/mini-symbol-overview/?locale=en#${encodeURIComponent(JSON.stringify(opts))}`;
  }
  const params = new URLSearchParams({ symbol: c.symbol, interval: c.interval, theme, style: '1', locale: 'en', timezone: 'exchange', hidesidetoolbar: '1', symboledit: '1', saveimage: '0', withdateranges: '1' });
  return `https://${HOST}/widgetembed/?${params}`;
}
// The mini chart shows a date range, not bars: the nearest one to the interval picked.
const miniRange = (i) => ({ 1: '1D', 5: '1D', 15: '1D', 30: '1D', 60: '1D', 240: '1M', D: '1M', W: '12M', M: '60M' }[i] || '1M');

function isEmbedUrl(u) {
  try {
    const url = new URL(u);
    return u.length < MAX_URL && url.protocol === 'https:' && url.hostname === HOST && !url.username && !url.password && !url.port && PATHS.includes(url.pathname);
  } catch { return false; }
}

function summary(c) {
  if (c.view === 'watchlist') {
    const n = symbolsOf(c.symbols).length;
    return `${c.list ? c.list.name : 'Watchlist'} · ${n} symbol${n === 1 ? '' : 's'}${c.list && c.sync ? ' · synced' : ''}`;
  }
  return `${c.symbol} · ${c.view === 'mini' ? 'mini chart' : INTERVAL_NAMES[c.interval] || c.interval}`;
}

module.exports = {
  SYMBOL_RE, INTERVALS, INTERVAL_NAMES, VIEWS, THEMES, HOST, PATHS, WIDGET_TWINS, MAX_SYMBOLS, MAX_SECTIONS, MAX_URL, SECTION, ACCOUNT_URL, SYNC_MS,
  cleanSymbol, cleanName, parseSymbols, sections, symbolsOf, cleanConfig, shapeLists, embedUrl, isEmbedUrl, summary,
};
