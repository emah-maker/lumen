// TradingView widget (run from test/units.js): symbol and option checks, the embed addresses, and the
// connector through createWidgets' pure parts (no network, no Electron, nothing opens).
const TV = require('../features/tradingview-view');
const { cleanWidget, CONNECTORS } = require('../features/widgets');
const WL = require('../features/widget-layout');
const WS = require('../renderer/widget-summary');

module.exports = async function tradingviewUnits(check) {
  for (const ok of ['NASDAQ:AAPL', 'nasdaq:aapl', 'BINANCE:BTCUSDT', 'SPX', 'BRK.B', 'CME_MINI:ES1!', ' fx:eurusd ']) check(`tradingview: ${ok.trim()} is a symbol`, Boolean(TV.cleanSymbol(ok)), ok);
  for (const bad of ['', 'AA PL"><script>', 'A:B:C', 'javascript:alert(1)x', ':AAPL', 'X'.repeat(40), 42, null]) check(`tradingview: ${String(bad).slice(0, 20)} is refused`, !TV.cleanSymbol(bad), String(bad));

  const c = TV.cleanConfig({ symbol: 'nasdaq:aapl', interval: 'H', view: 'weird', theme: 'neon' });
  check('tradingview: unknown options fall back to defaults', JSON.stringify(c) === '{"symbol":"NASDAQ:AAPL","interval":"D","view":"chart","theme":"auto"}', JSON.stringify(c));
  check('tradingview: no symbol means no config', TV.cleanConfig({ interval: 'D' }) === null && TV.cleanConfig(null) === null, '');

  const chartDark = TV.embedUrl({ symbol: 'NASDAQ:AAPL', interval: '60' }, true);
  const chartLight = TV.embedUrl({ symbol: 'NASDAQ:AAPL', interval: '60' }, false);
  const u = new URL(chartDark);
  check('tradingview: the full chart is s.tradingview.com/widgetembed with the symbol, interval and theme', u.hostname === 's.tradingview.com' && u.pathname === '/widgetembed/' && u.searchParams.get('symbol') === 'NASDAQ:AAPL' && u.searchParams.get('interval') === '60' && u.searchParams.get('theme') === 'dark' && new URL(chartLight).searchParams.get('theme') === 'light', chartDark);
  check('tradingview: a fixed theme ignores light/dark mode', new URL(TV.embedUrl({ symbol: 'SPX', theme: 'light' }, true)).searchParams.get('theme') === 'light', '');
  const mini = TV.embedUrl({ symbol: 'BINANCE:BTCUSDT', view: 'mini', interval: 'W' }, true);
  const opts = JSON.parse(decodeURIComponent(new URL(mini).hash.slice(1)));
  check('tradingview: the mini chart carries its options as JSON in the hash', new URL(mini).pathname === '/embed-widget/mini-symbol-overview/' && opts.symbol === 'BINANCE:BTCUSDT' && opts.colorTheme === 'dark' && opts.dateRange === '12M', mini);
  check('tradingview: every address it makes passes its own check, and nothing else does', TV.isEmbedUrl(chartDark) && TV.isEmbedUrl(mini) && !TV.isEmbedUrl('https://evil.example/widgetembed/') && !TV.isEmbedUrl('https://s.tradingview.com/chart/') && !TV.isEmbedUrl('http://s.tradingview.com/widgetembed/') && !TV.isEmbedUrl('https://s.tradingview.com:444/widgetembed/'), '');
  check('tradingview: every address fits the new-tab page’s safe URL rule (no quotes or brackets)', [chartDark, chartLight, mini].every((x) => x.length < 2000 && /^https:\/\/[^\s"'<>\\]+$/i.test(x)), mini);

  // ---- the connector ----
  const K = CONNECTORS.tradingview;
  check('tradingview: registered as a widget kind with a Settings name', K && K.label === 'TradingView' && WS.ORDER.includes('tradingview') && WS.kindName('tradingview') === 'TradingView', '');
  let r = await K.resolve({ tv: { symbol: 'nyse:spy', view: 'mini' } });
  check('tradingview: Settings input is checked and stored upper-case', r.config.tv.symbol === 'NYSE:SPY' && r.config.tv.view === 'mini' && /mini chart/.test(r.message), JSON.stringify(r));
  let err = null;
  try { await K.resolve({ tv: { symbol: 'no good?' } }); } catch (e) { err = e; }
  check('tradingview: a bad symbol is explained', err && /TradingView symbol/.test(err.message), String(err));
  err = null;
  try { await K.resolve({ tv: {} }); } catch (e) { err = e; }
  check('tradingview: an empty symbol asks for one', err && /Add a symbol/.test(err.message), String(err));
  const d = await K.fetch(K.clean({ tv: { symbol: 'SPX' } }));
  check('tradingview: fetch goes nowhere and gives the page both themes’ addresses', TV.isEmbedUrl(d.light) && TV.isEmbedUrl(d.dark) && d.light !== d.dark && d.symbol === 'SPX', JSON.stringify(d));
  const w = cleanWidget({ id: 'wtv00001', type: 'tradingview', title: '', tv: { symbol: 'AAPL', interval: '15' } });
  check('tradingview: a stored widget survives cleanWidget with its config', w && w.tv.symbol === 'AAPL' && w.tv.interval === '15', JSON.stringify(w));
  check('tradingview: a stored widget with a hostile symbol is dropped', cleanWidget({ id: 'wtv00002', type: 'tradingview', tv: { symbol: '"><img>' } }) === null, '');
  check('tradingview: the summary line names the symbol and interval', WS.widgetSummary({ type: 'tradingview', tv: { symbol: 'AAPL', interval: '60' } }, {}) === 'AAPL · 1 hour', WS.widgetSummary({ type: 'tradingview', tv: { symbol: 'AAPL', interval: '60' } }, {}));
  const size = WL.defaultSize('tradingview');
  check('tradingview: a new chart starts wide (not squeezed into the side area)', size.w === 6 && size.h === 6, JSON.stringify(size));
};
