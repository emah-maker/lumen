// TradingView widget (run from test/units.js): symbol and option checks, the embed addresses, and the
// connector through createWidgets' pure parts (no network, no Electron, nothing opens).
const fs = require('fs');
const path = require('path');
const TV = require('../src/features/tradingview-view');
const { cleanWidget, CONNECTORS } = require('../src/features/widgets');
const WL = require('../src/features/widget-layout');
const WS = require('../src/renderer/widget-summary');

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

  // ---- the watchlist ----
  const pasted = TV.parseSymbols('###Indices,SPCFD:SPX, tvc:ndq\n###Big tech\nAAPL TSLA aapl\n###Empty\n"><img>');
  check('tradingview: a pasted list keeps sections, upper-cases, drops repeats, bad symbols and empty sections', JSON.stringify(pasted) === '["###Indices","SPCFD:SPX","TVC:NDQ","###Big tech","AAPL","TSLA"]', JSON.stringify(pasted));
  const many = TV.parseSymbols(Array.from({ length: 80 }, (_, i) => `S${i}`));
  check('tradingview: a list stops at 60 symbols', TV.symbolsOf(many).length === TV.MAX_SYMBOLS, String(many.length));
  const secs = TV.parseSymbols(Array.from({ length: 14 }, (_, i) => [`###S${i}`, `A${i}`]).flat());
  check('tradingview: a list stops at 10 sections', secs.filter((e) => e.startsWith('###')).length === TV.MAX_SECTIONS, JSON.stringify(secs));
  check('tradingview: section names can’t carry markup', TV.parseSymbols(['###<b>"x"</b>', 'AAPL'])[0] === '###bx/b', JSON.stringify(TV.parseSymbols(['###<b>"x"</b>', 'AAPL'])));
  check('tradingview: symbols before any section get one tab named after the list', JSON.stringify(TV.sections(['AAPL', '###Crypto', 'BINANCE:BTCUSDT'], 'Mine')) === '[{"title":"Mine","symbols":["AAPL"]},{"title":"Crypto","symbols":["BINANCE:BTCUSDT"]}]', JSON.stringify(TV.sections(['AAPL', '###Crypto', 'BINANCE:BTCUSDT'], 'Mine')));
  const wl = TV.cleanConfig({ view: 'watchlist', symbols: 'aapl, tsla', chart: true, list: { id: '4242', name: 'Tech' } });
  check('tradingview: a watchlist config keeps its symbols, chart switch and linked list (sync on by default)', wl && wl.symbol === 'AAPL' && wl.symbols.length === 2 && wl.chart === true && wl.list.id === 4242 && wl.sync === true, JSON.stringify(wl));
  check('tradingview: a watchlist with no good symbol is no config', TV.cleanConfig({ view: 'watchlist', symbols: '"><x>' }) === null, '');
  check('tradingview: a hostile list id is dropped, not kept', !TV.cleanConfig({ view: 'watchlist', symbols: 'AAPL', list: { id: '1;drop', name: 'x' } }).list, '');
  const wlUrl = TV.embedUrl({ view: 'watchlist', symbols: '###Indices\nSPX\n###Stocks\nAAPL' }, true);
  const wlOpts = JSON.parse(decodeURIComponent(new URL(wlUrl).hash.slice(1)));
  check('tradingview: a watchlist is TradingView’s market overview with one tab per section, see-through, logos on', new URL(wlUrl).pathname === '/embed-widget/market-overview/' && wlOpts.tabs.length === 2 && wlOpts.tabs[1].symbols[0].s === 'AAPL' && wlOpts.showChart === false && wlOpts.isTransparent === true && wlOpts.showSymbolLogo === true && wlOpts.colorTheme === 'dark', wlUrl);
  const full = TV.embedUrl({ view: 'watchlist', symbols: Array.from({ length: 10 }, (_, i) => [`###Section ${i}`, ...Array.from({ length: 6 }, (__, j) => `CME_MINI:ES${i}${j}!`)]).flat() }, false);
  check('tradingview: a full 60-symbol watchlist fits the page’s TradingView address limit and passes the check', full.length < TV.MAX_URL && TV.isEmbedUrl(full) && /^https:\/\/[^\s"'<>\\]+$/i.test(full), String(full.length));
  check('tradingview: an address over the limit is refused', !TV.isEmbedUrl(`https://s.tradingview.com/embed-widget/market-overview/#${'x'.repeat(TV.MAX_URL)}`), '');

  const twin = JSON.parse(decodeURIComponent(new URL(TV.embedUrl({ view: 'watchlist', symbols: 'SPCFD:SPX, CBOE:VIX, AAPL' }, true)).hash.slice(1))).tabs[0].symbols;
  check('tradingview: indices TradingView leaves blank in widgets use their priced twin but keep their own name', JSON.stringify(twin) === '[{"s":"FOREXCOM:SPXUSD","d":"SPX"},{"s":"CAPITALCOM:VIX","d":"VIX"},{"s":"AAPL"}]', JSON.stringify(twin));
  check('tradingview: the stored list keeps the user’s own symbol, not the twin', TV.cleanConfig({ view: 'watchlist', symbols: 'SPCFD:SPX' }).symbols[0] === 'SPCFD:SPX', '');

  // ---- the account answer ----
  const out = TV.shapeLists([{ id: null, name: 'Watchlist', symbols: ['###Indices', 'SPX'] }]);
  check('tradingview: signed out, TradingView’s sample list (id null) is not taken as the user’s', out.signedIn === false && out.lists.length === 0, JSON.stringify(out));
  const mine = TV.shapeLists([{ id: 11, name: 'Tech', symbols: ['###Big', 'NASDAQ:AAPL', 'NASDAQ:MSFT'], active: true }, { id: 12, name: 'Empty', symbols: [] }, 'junk', { id: 13, name: 'Crypto', symbols: ['BINANCE:BTCUSDT'] }]);
  check('tradingview: signed in, the lists with symbols come back checked, with counts', mine.signedIn && mine.lists.map((l) => `${l.id}:${l.count}`).join() === '11:2,13:1' && mine.lists[0].active === true, JSON.stringify(mine));
  check('tradingview: an answer that isn’t a list means signed out with nothing', JSON.stringify(TV.shapeLists({ detail: 'Login required.' })) === '{"signedIn":false,"lists":[]}', '');

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
  r = await K.resolve({ tv: { view: 'watchlist', symbols: 'AAPL\nTSLA', list: { id: 11, name: 'Tech' } } });
  check('tradingview: a watchlist resolves with a message that says it syncs', r.config.tv.view === 'watchlist' && /2 symbols/.test(r.message) && /in sync with “Tech”/.test(r.message) && K.title(r.config) === 'Tech', JSON.stringify(r));
  err = null;
  try { await K.resolve({ tv: { view: 'watchlist', symbols: '' } }); } catch (e) { err = e; }
  check('tradingview: an empty watchlist asks for symbols or an import', err && /import a watchlist/.test(err.message), String(err));
  const linkedCfg = K.clean(r.config);
  const fake = (answer) => ({ tvLists: async () => { if (answer instanceof Error) throw answer; return TV.shapeLists(answer); } });
  let fd = await K.fetch(linkedCfg, fake([{ id: 11, name: 'Tech (renamed)', symbols: ['NVDA', 'AMD', 'AAPL'] }]));
  let hashOpts = JSON.parse(decodeURIComponent(new URL(fd.dark).hash.slice(1)));
  check('tradingview: a synced watchlist shows the account’s current symbols and name', fd.synced && hashOpts.tabs[0].symbols.map((x) => x.s).join() === 'NVDA,AMD,AAPL' && fd.name === 'Tech (renamed)' && !fd.note, JSON.stringify(fd));
  check('tradingview: a synced list refreshes every 15 minutes, a plain one daily', K.ttl(fd) === TV.SYNC_MS && K.ttl({ fit: 1, synced: false }) === 24 * 3600e3, '');
  fd = await K.fetch(linkedCfg, fake([{ id: null, name: 'Watchlist', symbols: ['SPX'] }]));
  hashOpts = JSON.parse(decodeURIComponent(new URL(fd.dark).hash.slice(1)));
  check('tradingview: signed out, a synced list keeps its last symbols and says to sign in', /Sign in to TradingView/.test(fd.note) && hashOpts.tabs[0].symbols.map((x) => x.s).join() === 'AAPL,TSLA', JSON.stringify(fd));
  fd = await K.fetch(linkedCfg, fake([{ id: 99, name: 'Other', symbols: ['SPX'] }]));
  check('tradingview: a list deleted in TradingView keeps its last symbols and says so', /no longer in your TradingView account/.test(fd.note) && TV.isEmbedUrl(fd.light), fd.note);
  fd = await K.fetch(linkedCfg, fake(new Error('offline')));
  check('tradingview: an unreachable account keeps the last symbols', /Couldn’t reach/.test(fd.note) && TV.isEmbedUrl(fd.dark), fd.note);
  let called = false;
  fd = await K.fetch(K.clean({ tv: { view: 'watchlist', symbols: 'AAPL' } }), { tvLists: async () => { called = true; return { signedIn: false, lists: [] }; } });
  check('tradingview: a typed watchlist never reads the account', !called && !fd.synced, '');
  fd = await K.fetch(K.clean({ tv: { view: 'watchlist', symbols: 'AAPL', list: { id: 11, name: 'Tech' }, sync: false } }), { tvLists: async () => { called = true; return { signedIn: false, lists: [] }; } });
  check('tradingview: sync off means the account isn’t read either', !called && !fd.synced, '');
  check('tradingview: a watchlist survives cleanWidget', cleanWidget({ id: 'wtv00003', type: 'tradingview', tv: { view: 'watchlist', symbols: ['###A', 'AAPL'], list: { id: 5, name: 'A' } } })?.tv?.list?.id === 5, '');
  check('tradingview: the watchlist summary line names the list and count', WS.widgetSummary({ type: 'tradingview', tv: { view: 'watchlist', symbols: ['###A', 'AAPL', 'TSLA'], list: { id: 5, name: 'Tech' }, sync: true } }, {}) === 'Tech · 2 symbols · synced', WS.widgetSummary({ type: 'tradingview', tv: { view: 'watchlist', symbols: ['###A', 'AAPL', 'TSLA'], list: { id: 5, name: 'Tech' }, sync: true } }, {}));
  // ---- small cards: the compact addresses and how the page fits them (features/tradingview-fit.js) ----
  const FIT = require('../src/features/tradingview-fit');
  const hashOf = (u) => JSON.parse(decodeURIComponent(new URL(u).hash.slice(1)));
  const chartCfg = { symbol: 'NASDAQ:AAPL', interval: 'D', view: 'chart', theme: 'light' };
  const cChart = TV.embedUrl(chartCfg, false, true);
  check('tradingview compact: a chart becomes the mini price view (the full chart is all toolbar on a small card)', new URL(cChart).pathname === '/embed-widget/mini-symbol-overview/' && hashOf(cChart).symbol === 'NASDAQ:AAPL' && TV.isEmbedUrl(cChart), cChart);
  check('tradingview compact: leaving compact off changes nothing (the default is the full address)', TV.embedUrl(chartCfg, false) === TV.embedUrl(chartCfg, false, false) && new URL(TV.embedUrl(chartCfg, false)).pathname === '/widgetembed/', '');
  const miniCfg = { symbol: 'BINANCE:BTCUSDT', view: 'mini', interval: 'W', theme: 'dark' };
  check('tradingview compact: the mini view is already compact and stays as it is', TV.embedUrl(miniCfg, true, true) === TV.embedUrl(miniCfg, true), '');
  const multi = { view: 'watchlist', theme: 'light', chart: true, symbols: ['###Tech', 'AAPL', 'TSLA', '###Crypto', 'BINANCE:BTCUSDT', '###Index', 'SPX'] };
  const fullTabs = hashOf(TV.embedUrl(multi, false));
  const compTabs = hashOf(TV.embedUrl(multi, false, true));
  check('tradingview compact: a watchlist with several tabs becomes one flat list with no tab row and no chart on top', fullTabs.tabs.length === 3 && fullTabs.showChart === true && compTabs.tabs.length === 1 && compTabs.showChart === false && compTabs.tabs[0].symbols.length === 4 && compTabs.tabs[0].symbols.map((x) => x.s).join() === 'AAPL,TSLA,BINANCE:BTCUSDT,FOREXCOM:SPXUSD', JSON.stringify(compTabs.tabs));
  const oneTab = hashOf(TV.embedUrl({ view: 'watchlist', symbols: 'AAPL, TSLA', chart: false }, false, true));
  check('tradingview compact: a one-tab watchlist keeps its tab and symbols', oneTab.tabs.length === 1 && oneTab.tabs[0].symbols.length === 2, JSON.stringify(oneTab.tabs));
  check('tradingview compact: every address still fits the new-tab page’s safe URL rule', [cChart, TV.embedUrl(multi, true, true)].every((x) => TV.isEmbedUrl(x) && x.length < 8000 && /^https:\/\/[^\s"'<>\\]+$/i.test(x)), '');

  const P = (view, w, h, extra = {}, was = null, can = true) => FIT.plan({ view, sections: 0, chart: false, ...extra }, w, h, was, can);
  check('tradingview fit: no size yet means no plan', P('chart', 0, 100) === null && P('chart', 200, 0) === null && FIT.plan(null, 200, 100) === null, '');
  check('tradingview fit: a roomy chart stays the full chart at full size', JSON.stringify(P('chart', 420, 300)) === '{"compact":false,"scale":1}', JSON.stringify(P('chart', 420, 300)));
  check('tradingview fit: a chart under 300 x 230 goes compact (the 2 x 2 card is about 160 x 68)', P('chart', 240, 68).compact && P('chart', 299, 400).compact && P('chart', 400, 229).compact && !P('chart', 300, 230).compact, '');
  check('tradingview fit: a compact chart shrinks the mini view to fit instead of clipping its price', JSON.stringify(P('chart', 160, 68)) === '{"compact":true,"scale":0.65}' && P('chart', 240, 120).scale === 1, JSON.stringify(P('chart', 160, 68)));
  check('tradingview fit: text never shrinks below 0.6', P('chart', 60, 30).scale === 0.6 && P('mini', 40, 20).scale === 0.6, '');
  check('tradingview fit: a card at the edge doesn’t flip back at once (20 px margin to leave compact)', P('chart', 310, 240, {}, { compact: true, scale: 1 }).compact && !P('chart', 320, 250, {}, { compact: true, scale: 1 }).compact && !P('chart', 310, 240, {}, null).compact, '');
  check('tradingview fit: the mini view never goes compact, it only scales', !P('mini', 160, 68).compact && P('mini', 160, 68).scale === 0.65 && P('mini', 300, 200).scale === 1, '');
  check('tradingview fit: a watchlist with several tabs goes compact when short, one tab never does', P('watchlist', 240, 150, { sections: 3 }).compact && !P('watchlist', 240, 220, { sections: 3 }).compact && !P('watchlist', 240, 68, { sections: 1 }).compact, '');
  check('tradingview fit: a watchlist with a chart on top goes compact under 320 px', P('watchlist', 300, 300, { sections: 1, chart: true }).compact && !P('watchlist', 300, 330, { sections: 1, chart: true }).compact, '');
  check('tradingview fit: a narrow watchlist shrinks so its price and change show', P('watchlist', 160, 120, { sections: 1 }).scale === 0.7 && P('watchlist', 400, 120, { sections: 1 }).scale === 1, JSON.stringify(P('watchlist', 160, 120, { sections: 1 })));
  check('tradingview fit: without a compact address (old data) nothing goes compact, the card still scales', !P('chart', 240, 68, {}, null, false).compact && P('mini', 160, 68, {}, null, false).scale === 0.65, '');

  const cardData = await K.fetch(K.clean({ tv: { view: 'watchlist', symbols: ['###A', 'AAPL', '###B', 'TSLA'], chart: true } }), { tvLists: async () => ({ signedIn: false, lists: [] }) });
  check('tradingview: the card data carries the compact addresses, the tab count and the chart switch', cardData.fit === 1 && cardData.sections === 2 && cardData.chart === true && TV.isEmbedUrl(cardData.compactLight) && TV.isEmbedUrl(cardData.compactDark) && hashOf(cardData.compactDark).tabs.length === 1, JSON.stringify([cardData.fit, cardData.sections, cardData.chart]));
  check('tradingview: data without the compact addresses is stale at once, current data keeps its normal life', K.ttl({ view: 'chart' }) === 0 && K.ttl(null) === 0 && K.ttl(cardData) === 24 * 3600e3, String(K.ttl(cardData)));
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab.html'), 'utf8');
  const wsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab-widgets.js'), 'utf8');
  check('tradingview: the new-tab page loads the fit module before the widgets and sizes the frame through it', html.indexOf('<script src="../features/tradingview-fit.js">') > 0 && html.indexOf('<script src="../features/tradingview-fit.js">') < html.indexOf('<script src="newtab-widgets.js">') && /TradingViewFit/.test(wsrc) && /ResizeObserver\(place\)/.test(wsrc) && /\.tv-fit \.w-frame/.test(html), '');
  const size = WL.defaultSize('tradingview');
  check('tradingview: a new chart starts wide (not squeezed into the side area)', size.w === 6 && size.h === 6, JSON.stringify(size));
};
