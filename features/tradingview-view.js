// TradingView widget, the pure part: symbol and option checks, and the address of TradingView's own
// embeddable chart for them. No network, no Electron, no key: the chart is TradingView's page in a
// sandboxed frame on the new-tab page (like a Web page card), so the quotes come from TradingView under
// its terms, straight to that frame. Lumen itself fetches nothing for it.
//
//   cleanConfig(tv)       a stored or typed { symbol, interval, view, theme } -> checked fields, or null
//   embedUrl(tv, dark)    the frame's https address on s.tradingview.com
//   isEmbedUrl(u)         whether an address is one embedUrl() could have made (the page checks this too)
'use strict';

// EXCHANGE:TICKER or a bare ticker, as TradingView writes them: NASDAQ:AAPL, BINANCE:BTCUSDT, SPX, BRK.B, ES1!.
const SYMBOL_RE = /^(?:[A-Z0-9_]{1,20}:)?[A-Z0-9][A-Z0-9._!-]{0,29}$/;
const INTERVALS = ['1', '5', '15', '30', '60', '240', 'D', 'W', 'M'];
const INTERVAL_NAMES = { 1: '1 minute', 5: '5 minutes', 15: '15 minutes', 30: '30 minutes', 60: '1 hour', 240: '4 hours', D: '1 day', W: '1 week', M: '1 month' };
const VIEWS = ['chart', 'mini']; // the full chart with tools, or a small price line
const THEMES = ['auto', 'light', 'dark']; // auto follows the new-tab page
const HOST = 's.tradingview.com';

const cleanSymbol = (v) => {
  const s = typeof v === 'string' ? v.trim().toUpperCase().replace(/\s+/g, '') : '';
  return SYMBOL_RE.test(s) ? s : '';
};
const pick = (v, list, fallback) => (list.includes(String(v)) ? String(v) : fallback);

function cleanConfig(tv) {
  if (!tv || typeof tv !== 'object') return null;
  const symbol = cleanSymbol(tv.symbol);
  if (!symbol) return null;
  return { symbol, interval: pick(tv.interval, INTERVALS, 'D'), view: pick(tv.view, VIEWS, 'chart'), theme: pick(tv.theme, THEMES, 'auto') };
}

function embedUrl(tv, dark) {
  const c = cleanConfig(tv);
  if (!c) return null;
  const theme = c.theme === 'auto' ? (dark ? 'dark' : 'light') : c.theme;
  if (c.view === 'mini') {
    // The mini widget reads its options from the hash, as JSON.
    const opts = { symbol: c.symbol, width: '100%', height: '100%', dateRange: miniRange(c.interval), colorTheme: theme, isTransparent: true, autosize: true, locale: 'en' };
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
    return url.protocol === 'https:' && url.hostname === HOST && !url.username && !url.password && !url.port && ['/widgetembed/', '/embed-widget/mini-symbol-overview/'].includes(url.pathname);
  } catch { return false; }
}

const summary = (c) => `${c.symbol} · ${c.view === 'mini' ? 'mini chart' : INTERVAL_NAMES[c.interval] || c.interval}`;

module.exports = { SYMBOL_RE, INTERVALS, INTERVAL_NAMES, VIEWS, THEMES, HOST, cleanSymbol, cleanConfig, embedUrl, isEmbedUrl, summary };
