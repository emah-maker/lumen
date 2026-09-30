// Stocks and Crypto widgets (run from test/units.js): the paper-trading maths (fills, rounding, P/L,
// oversell, not enough cash, hostile stored config), the two providers' answers, and both connectors
// against a fake fetch (no network, no Electron, nothing opens): quotes, errors, buying and selling at the
// last quote, stale/offline blocking, and that trades survive an edit and never refetch quotes.
const MV = require('../features/markets-view');
const { createWidgets, cleanWidget, CONNECTORS } = require('../features/widgets');
const WL = require('../features/widget-layout');

module.exports = async function marketsUnits(check) {
  const S = (trades, cash0 = 100000) => ({ cash0, trades });
  const t = (sym, qty, px, at = 1e12) => ({ sym, qty, px, t: at });

  // ---- fills, rounding, P/L ----
  let p = MV.present(S([t('AAPL', 10, 150.25)]), { AAPL: 160 });
  check('markets: a buy takes cash at the fill and is valued at the quote', p.cash === 98497.5 && p.positions[0].qty === 10 && p.positions[0].value === 1600 && p.equity === 100097.5 && p.pl === 97.5, JSON.stringify(p));
  check('markets: P/L percent is of the starting cash, positions carry their own', p.plPct === 0.1 && p.positions[0].pl === 97.5 && p.positions[0].plPct === 6.49 && p.positions[0].avg === 150.25, JSON.stringify(p));
  p = MV.present(S([t('AAPL', 10, 100), t('AAPL', 4, 130), t('AAPL', -7, 150)]), { AAPL: 120 });
  check('markets: a partial sell books realized P/L on the average cost and keeps the rest', p.realized === 7 * (150 - (1000 + 520) / 14) && p.positions[0].qty === 7 && p.cash === 100000 - 1520 + 1050, JSON.stringify(p));
  check('markets: selling everything closes the position', MV.present(S([t('AAPL', 3, 10), t('AAPL', -3, 12)]), {}).positions.length === 0 && MV.present(S([t('AAPL', 3, 10), t('AAPL', -3, 12)]), {}).cash === 100006, '');
  p = MV.present(S([t('BTC', 0.333, 12345.678)]), { BTC: 12345.678 }, { fractional: true });
  check('markets: fills round to whole cents (0.333 x 12345.678)', p.cash === (10000000 - Math.round(0.333 * 12345.678 * 100)) / 100, String(p.cash));
  p = MV.present(S(Array.from({ length: 200 }, () => t('SHIB', 0.1, 0.1))), { SHIB: 0.1 }, { fractional: true });
  check('markets: 200 tiny fills add up exactly (integer cents, no float drift)', p.trades === 200 && p.positions[0].qty === 20 && p.cash === 99998,JSON.stringify(p).slice(0, 200));
  check('markets: a holding with no quote is valued at cost', MV.present(S([t('AAPL', 2, 50)]), {}).equity === 100000, '');

  // ---- rejections ----
  let r = MV.attempt(S([]), { side: 'sell', sym: 'AAPL', qty: 1, px: 10, now: 1 });
  check('markets: selling what you don’t hold is refused', !r.ok && /hold/.test(r.error), JSON.stringify(r));
  r = MV.attempt(S([t('AAPL', 5, 10)]), { side: 'sell', sym: 'AAPL', qty: 6, px: 10, now: 1 });
  check('markets: overselling is refused', !r.ok && /hold/.test(r.error), JSON.stringify(r));
  r = MV.attempt(S([]), { side: 'buy', sym: 'AAPL', qty: 1000, px: 150, now: 1 });
  check('markets: not enough cash is refused', !r.ok && r.error === 'Not enough cash.', JSON.stringify(r));
  r = MV.attempt(S([]), { side: 'buy', sym: 'AAPL', qty: 1000, px: 100, now: 1 });
  check('markets: spending exactly all the cash is allowed', r.ok && MV.present(r.pf, {}).cash === 0, JSON.stringify(r));
  check('markets: bad input is refused (fraction of a share, zero, negative, NaN, no price, bad symbol)', [
    { side: 'buy', sym: 'AAPL', qty: 1.5, px: 10 }, { side: 'buy', sym: 'AAPL', qty: 0, px: 10 }, { side: 'buy', sym: 'AAPL', qty: -1, px: 10 },
    { side: 'buy', sym: 'AAPL', qty: NaN, px: 10 }, { side: 'buy', sym: 'AAPL', qty: 1, px: null }, { side: 'buy', sym: 'a b', qty: 1, px: 10 }, { side: 'hold', sym: 'AAPL', qty: 1, px: 10 },
    { side: 'buy', sym: 'AAPL', qty: 1e9, px: 10 },
  ].every((a) => !MV.attempt(S([]), { ...a, now: 1 }).ok), '');
  check('markets: crypto may buy a fraction', MV.attempt(S([]), { side: 'buy', sym: 'BTC', qty: 0.0025, px: 60000, now: 1, fractional: true }).ok, '');
  check('markets: attempt() never changes the portfolio it is given', (() => { const a = S([t('AAPL', 1, 10)]); const before = JSON.stringify(a); MV.attempt(a, { side: 'buy', sym: 'AAPL', qty: 1, px: 10, now: 1 }); return JSON.stringify(a) === before; })(), '');
  let full = S(Array.from({ length: 200 }, (_, i) => t('AAPL', 1, 1, i)));
  check('markets: the trade list is capped at 200', MV.cleanPortfolio(S(Array.from({ length: 500 }, () => t('AAPL', 1, 1)))).trades.length === 200 && !MV.attempt(full, { side: 'buy', sym: 'AAPL', qty: 1, px: 1, now: 1 }).ok, '');

  // ---- hostile stored config ----
  const hostile = MV.cleanPortfolio({
    cash0: 1e30,
    trades: [null, 7, 'x', [], t('aapl', 1, 1), t('AAPL', NaN, 1), t('AAPL', 1, Infinity), t('AAPL', 1, -5), t('AAPL', 1, 0), t('AAPL', 1e12, 1), t('A'.repeat(13), 1, 1), t('AAPL', 1, 1, -1), t('AAPL', 1, 1, 1e18),
      { sym: 'AAPL', qty: '5', px: 1, t: 1 }, { sym: '__proto__', qty: 1, px: 1, t: 1 }, t('AAPL', 1.5, 10), t('AAPL', -1, 10), t('MSFT', 1e6, 1e6), t('AAPL', 2, 10), t('AAPL', -3, 10)],
  });
  check('markets: hostile trades are dropped one by one, a hostile starting cash falls back to the default', hostile.cash0 === 100000 && hostile.trades.length === 1 && hostile.trades[0].qty === 2 && hostile.trades[0].sym === 'AAPL', JSON.stringify(hostile));
  check('markets: garbage as a whole portfolio is an empty default one', [null, undefined, 5, 'x', [], { trades: 'no' }].every((g) => { const c = MV.cleanPortfolio(g); return c.cash0 === 100000 && c.trades.length === 0; }), '');
  check('markets: cleaning twice changes nothing (idempotent)', JSON.stringify(MV.cleanPortfolio(hostile)) === JSON.stringify(hostile), '');
  check('markets: a starting cash outside 1,000 to 1,000,000,000 is ignored', MV.cleanCash(5) === 100000 && MV.cleanCash('x') === 100000 && MV.cleanCash(2e9) === 100000 && MV.cleanCash(2500.456) === 2500.46, '');
  check('markets: whole shares only in a stock portfolio (a fractional stored one is dropped)', MV.cleanPortfolio(S([t('AAPL', 0.5, 10)])).trades.length === 0 && MV.cleanPortfolio(S([t('BTC', 0.5, 10)]), { fractional: true }).trades.length === 1, '');
  check('markets: a stored trade that would overspend after an earlier one was dropped is dropped too', (() => { const c = MV.cleanPortfolio(S([t('AAPL', 1, 99999), t('AAPL', 1, 99999), t('AAPL', -1, 1)])); return c.trades.length === 2 && MV.present(c, {}).cash === 100000 - 99999 + 1; })(), '');

  // ---- watchlists ----
  check('markets: symbols are upper-cased, deduplicated, validated and capped at 8', JSON.stringify(MV.cleanSymbols('aapl, msft;AAPL  brk.b <b> x'.concat(' a1 a2 a3 a4 a5 a6'))) === JSON.stringify(['AAPL', 'MSFT', 'BRK.B', 'X', 'A1', 'A2', 'A3', 'A4']), JSON.stringify(MV.cleanSymbols('aapl, msft;AAPL  brk.b <b> x a1 a2 a3 a4 a5 a6')));
  check('markets: a symbol list can be an array, and junk is ignored', JSON.stringify(MV.cleanSymbols(['nvda', 5, null, {}, 'toolongsymbol123', 'ok'])) === JSON.stringify(['NVDA', 'OK']) && MV.cleanSymbols(undefined).length === 0, '');
  check('markets: coins take a known ticker, an explicit one, or one made from the id', JSON.stringify(MV.cleanCoins('bitcoin, ethereum=eth2, some-new-coin, BAD_ID!, bitcoin')) === JSON.stringify([{ id: 'bitcoin', sym: 'BTC' }, { id: 'ethereum', sym: 'ETH2' }, { id: 'some-new-coin', sym: 'SOMENEWCOIN' }]), JSON.stringify(MV.cleanCoins('bitcoin, ethereum=eth2, some-new-coin, BAD_ID!, bitcoin')));
  check('markets: coin tickers stay unique and coins are capped at 12', MV.cleanCoins('bitcoin, bitcoin-cash=BTC').length === 1 && MV.cleanCoins(Array.from({ length: 30 }, (_, i) => `coin${i}`)).length === 12, '');

  // ---- staleness ----
  check('markets: quotes are stale when offline, missing, or older than twice the refresh time', MV.isStale({ fetchedAt: 1000, now: 1000, refreshMs: 900e3, offline: true }) && MV.isStale({ now: 1000, refreshMs: 1 }) && !MV.isStale({ fetchedAt: 1000, now: 1000 + 1799e3, refreshMs: 900e3 }) && MV.isStale({ fetchedAt: 1000, now: 1000 + 1801e3, refreshMs: 900e3 }), '');

  // ---- the providers' answers ----
  const now = Date.UTC(2026, 8, 29, 15, 0);
  const ts = Math.floor(now / 1000) - 60;
  let q = MV.parseTwelve({ AAPL: { name: 'Apple Inc', close: '231.10', percent_change: '-0.52', is_market_open: true, timestamp: ts }, MSFT: { code: 400, status: 'error', message: 'symbol not found' }, NVDA: { close: 'abc' } }, ['AAPL', 'MSFT', 'NVDA', 'TSLA'], now);
  check('twelve: a batch answer keyed by symbol; bad or missing symbols are reported, not fatal', q.rows.length === 1 && q.rows[0].px === 231.1 && q.rows[0].chg === -0.52 && q.rows[0].open === true && q.rows[0].at === ts * 1000 && q.missing.join() === 'MSFT,NVDA,TSLA', JSON.stringify(q));
  q = MV.parseTwelve({ symbol: 'AAPL', close: '10.5', percent_change: '1', is_market_open: false }, ['AAPL'], now);
  check('twelve: a single symbol comes back flat', q.rows.length === 1 && q.rows[0].px === 10.5 && q.rows[0].open === false, JSON.stringify(q));
  const thrown = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
  check('twelve: an error answer with HTTP 200 is a readable message (401, 429, other)', /refused the API key/.test(thrown(() => MV.parseTwelve({ code: 401, status: 'error', message: 'x' }, ['AAPL'], now))) && /limit was reached/.test(thrown(() => MV.parseTwelve({ code: 429, status: 'error' }, ['AAPL'], now))) && /symbol is wrong/.test(thrown(() => MV.parseTwelve({ code: 400, status: 'error', message: 'symbol is wrong' }, ['AAPL'], now))), '');
  check('twelve: not an object is unexpected, hostile numbers are not prices', /unexpected/.test(thrown(() => MV.parseTwelve('x', ['A'], now))) && MV.parseTwelve({ A: { close: '-3' }, B: { close: '1e999' }, C: { close: '0' } }, ['A', 'B', 'C'], now).rows.length === 0, '');
  const g = MV.parseGecko({ bitcoin: { usd: 76975, usd_24h_change: -1.41, last_updated_at: ts }, ethereum: { usd: 'x' }, __proto__: { usd: 1 } }, [{ id: 'bitcoin', sym: 'BTC' }, { id: 'ethereum', sym: 'ETH' }, { id: 'toString', sym: 'TS' }], now);
  check('coingecko: prices and the 24h change; unknown or broken coins are missing (even ids like toString)', g.rows.length === 1 && g.rows[0].sym === 'BTC' && g.rows[0].chg === -1.41 && g.rows[0].at === ts * 1000 && g.missing.join() === 'ETH,TS', JSON.stringify(g));
  check('coingecko: a tiny price survives', MV.parseGecko({ shib: { usd: 0.00001234 } }, [{ id: 'shib', sym: 'SHIB' }], now).rows[0].px === 0.00001234, '');

  // ---- the connectors against a fake fetch ----
  const calls = [];
  let mode = { stocks: 'ok', crypto: 'ok' };
  let clock = now;
  const respond = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fakeFetch = async (url, opts) => {
    calls.push({ url, headers: opts?.headers || {} });
    if (mode.offline) throw new TypeError('fetch failed');
    if (url.startsWith('https://api.twelvedata.com/quote')) {
      if (mode.stocks === '401') return respond({ code: 401, status: 'error', message: 'apikey is invalid' }, 401);
      if (mode.stocks === '429') return respond({ code: 429, status: 'error', message: 'run out of API credits' });
      const symbols = new URL(url).searchParams.get('symbol').split(',');
      const open = mode.stocks !== 'closed';
      return respond(Object.fromEntries(symbols.map((s, i) => [s, { name: s, close: String(100 + i * 50), percent_change: i % 2 ? '-1.25' : '2.5', is_market_open: open, timestamp: Math.floor(clock / 1000) }])));
    }
    if (url.startsWith('https://api.coingecko.com/api/v3/simple/price')) {
      if (mode.crypto === '429') return respond({ status: { error_code: 429 } }, 429);
      if (mode.crypto === '401') return respond({ error: 'bad key' }, 401);
      const ids = new URL(url).searchParams.get('ids').split(',');
      return respond(Object.fromEntries(ids.map((id, i) => [id, { usd: 60000 / (i + 1), usd_24h_change: i ? -3.5 : 1.2, last_updated_at: Math.floor(clock / 1000) }])));
    }
    return respond({}, 404);
  };
  const store = { settings: {}, secrets: {} };
  const make = () => createWidgets({
    readSettings: () => store.settings, writeSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); }, fetch: fakeFetch,
    getSecret: (n) => store.secrets[n] || null, setSecret: (n, v) => { if (v) store.secrets[n] = v; else delete store.secrets[n]; }, onUpdate: () => {}, endpoints: () => ({}), now: () => clock, rateMax: () => 1000,
  });
  const settle = async (w, id) => { await w.cache.get(id)?.pending; };
  const page = (w, id) => w.forPage().find((x) => x.id === id);
  const KEY = 'abcdef1234567890abcdef1234567890';

  let w = make();
  let err = '';
  try { await w.save({ type: 'stocks', mk: { symbols: 'AAPL, MSFT' } }); } catch (e) { err = e.message; }
  check('stocks: a key is required to add the widget', /Twelve Data API key/.test(err), err);
  err = '';
  try { await w.save({ type: 'stocks', token: 'bad key!', mk: { symbols: 'AAPL' } }); } catch (e) { err = e.message; }
  check('stocks: a key that can’t be one is refused before anything is sent', /doesn’t look like/.test(err) && calls.length === 0, err);
  err = '';
  try { await w.save({ type: 'stocks', token: KEY, mk: { symbols: '<b> !!' } }); } catch (e) { err = e.message; }
  check('stocks: no valid symbol is refused before anything is sent', /at least one symbol/.test(err) && calls.length === 0, err);

  mode.stocks = '401';
  err = '';
  try { await w.save({ type: 'stocks', token: KEY, mk: { symbols: 'AAPL' } }); } catch (e) { err = e.message; }
  check('stocks: a refused key says so (HTTP 401)', /refused the API key/.test(err) && !store.secrets.twelvedata, err);
  mode.stocks = '429';
  err = '';
  try { await w.save({ type: 'stocks', token: KEY, mk: { symbols: 'AAPL' } }); } catch (e) { err = e.message; }
  check('stocks: the free plan’s limit says so, with the numbers', /8 requests a minute and 800 a day/.test(err), err);

  w.flush();
  w = make();
  mode.stocks = 'ok';
  calls.length = 0;
  clock += 5 * 60e3; // past the 429's back-off
  const saved = await w.save({ type: 'stocks', token: KEY, mk: { symbols: 'aapl, msft, tsla', startCash: 50000 } });
  const id = saved.widget.id;
  await settle(w, id);
  check('stocks: saved, the key is stored as a secret and never in the widget', store.secrets.twelvedata === KEY && !JSON.stringify(store.settings).includes(KEY), '');
  check('stocks: the watchlist is ONE request with the key in a header, not the URL', calls.length >= 1 && calls.every((c) => c.url.includes('symbol=AAPL%2CMSFT%2CTSLA') && !c.url.includes(KEY) && c.headers.Authorization === `apikey ${KEY}`), JSON.stringify(calls));
  check('stocks: the card starts 3 wide (its 4 wide default capped to the side area) by 3 cells', saved.widget.w === 3 && saved.widget.h === 3 && WL.DEFAULT_SIZE.stocks.w === 4 && WL.DEFAULT_SIZE.crypto.h === 3, JSON.stringify(saved.widget));
  let d = page(w, id).data;
  check('stocks: rows carry price, percent change and the source; Delayed badge and attribution', d.rows.length === 3 && d.rows[0].sym === 'AAPL' && d.rows[0].px === 100 && d.rows[0].chg === 2.5 && d.badge === 'Delayed' && d.attribution === 'Data: Twelve Data' && d.marketOpen === true && d.asOf === Math.floor(clock / 1000) * 1000,JSON.stringify(d).slice(0, 300));
  check('stocks: a fresh portfolio is the starting cash, tradable', d.pf.cash === 50000 && d.pf.equity === 50000 && d.pf.positions.length === 0 && d.tradable === true, JSON.stringify(d.pf));
  check('stocks: 15 minute refresh while the market is open', CONNECTORS.stocks.ttl({ rows: [1], anyOpen: true }) === 15 * 60e3 && d.refreshMs === 15 * 60e3, '');
  check('stocks: 60 minutes when the market is closed', CONNECTORS.stocks.ttl({ rows: [1], anyOpen: false }) === 60 * 60e3 && CONNECTORS.stocks.ttl(null) === 15 * 60e3, '');

  // buying and selling
  const parse = (q) => w.actionFrom(`file:///new-tab.html?widget=${id}&${q}`);
  check('stocks: buy/sell actions are parsed and checked (symbol, quantity)', parse('do=buy&sym=AAPL&qty=3').qty === 3 && parse('do=sell&sym=BRK.B&qty=2.5').sym === 'BRK.B' && parse('do=resetpf').do === 'resetpf'
    && ['do=buy&sym=aapl&qty=1', 'do=buy&sym=AAPL&qty=0', 'do=buy&sym=AAPL&qty=-1', 'do=buy&sym=AAPL&qty=1e5', 'do=buy&sym=AAPL', 'do=buy&qty=1', 'do=buy&sym=AAPL&qty=99999999999', 'do=buy&sym=%3Cb%3E&qty=1'].every((q2) => parse(q2).invalid), '');
  const before = calls.length;
  check('stocks: a buy fills at the last quote', await w.act(parse('do=buy&sym=MSFT&qty=10')) === true, '');
  d = page(w, id).data;
  check('stocks: cash, holding and equity follow (MSFT last was 150)', d.pf.cash === 50000 - 1500 && d.pf.positions[0].sym === 'MSFT' && d.pf.positions[0].qty === 10 && d.pf.equity === 50000 && d.notice === 'Paper bought 10 MSFT at $150.00.', JSON.stringify(d.pf) + d.notice);
  check('stocks: trading does not fetch quotes again, and the trade is in the stored widget', calls.length === before && store.settings.homeWidgets[0].pf.trades.length === 1 && store.settings.homeWidgets[0].pf.trades[0].px === 150, `${calls.length} ${before}`);
  check('stocks: a trade does not drop the cached quotes (the card keeps its data)', page(w, id).data.rows.length === 3 && !page(w, id).loading, '');
  await w.act(parse('do=buy&sym=TSLA&qty=100000'.replace('100000', '1000')));
  d = page(w, id).data;
  check('stocks: not enough cash is refused with a notice and no trade', /Not enough cash/.test(d.notice) && d.pf.trades === 1, d.notice);
  await w.act(parse('do=sell&sym=MSFT&qty=11'));
  d = page(w, id).data;
  check('stocks: overselling is refused with a notice and no trade', /hold that many/.test(d.notice) && d.pf.trades === 1, d.notice);
  await w.act(parse('do=sell&sym=AAPL&qty=1'));
  check('stocks: selling something not held is refused', /hold that many/.test(page(w, id).data.notice), page(w, id).data.notice);
  await w.act(parse('do=buy&sym=NVDA&qty=1'));
  check('stocks: a symbol that is not on the card has no price to trade at', /No price for NVDA/.test(page(w, id).data.notice) && page(w, id).data.pf.trades === 1, page(w, id).data.notice);
  await w.act(parse('do=sell&sym=MSFT&qty=4'));
  d = page(w, id).data;
  check('stocks: a sell fills, cash comes back', d.pf.cash === 50000 - 1500 + 600 && d.pf.positions[0].qty === 6 && d.pf.realized === 0 && d.pf.trades === 2, JSON.stringify(d.pf));
  check('stocks: the label Paper trading is supported by the data (badge, tradable)', d.tradable === true && d.tradeBlock === '', '');

  // an edit keeps the trades and the position
  const edited = await w.save({ type: 'stocks', mk: { symbols: 'AAPL, MSFT', startCash: 999999 } }, id);
  await settle(w, id);
  check('stocks: editing keeps the paper trades and the starting cash (while there are trades)', edited.widget.pf.trades.length === 2 && edited.widget.pf.cash0 === 50000 && edited.widget.mk.symbols.join() === 'AAPL,MSFT' && store.secrets.twelvedata === KEY, JSON.stringify(edited.widget.pf));

  // stale / offline
  clock += 31 * 60e3; // more than twice the refresh time without a refresh
  const kept = w.cache.get(id);
  kept.at = clock; // as if it had just tried
  await w.act(parse('do=buy&sym=AAPL&qty=1'));
  check('stocks: quotes older than twice the refresh time block trading', /out of date/.test(page(w, id).data.notice) && page(w, id).data.tradable === false && page(w, id).data.pf.trades === 2, page(w, id).data.notice);
  mode.offline = true;
  clock += 60e3;
  await w.refresh(w.list()[0], { force: true });
  let pg = page(w, id);
  check('stocks: offline shows the cached data flagged offline, with trading off', pg.data && pg.data.offline === true && pg.data.tradable === false && /Offline/.test(pg.data.tradeBlock) && pg.warning, JSON.stringify(pg).slice(0, 200));
  await w.act(parse('do=buy&sym=AAPL&qty=1'));
  check('stocks: a buy while offline is refused', /Offline/.test(page(w, id).data.notice) && page(w, id).data.pf.trades === 2, page(w, id).data.notice);
  mode.offline = false;

  await w.act(parse('do=resetpf'));
  d = page(w, id).data;
  check('stocks: Reset clears the trades and keeps the starting cash', d.pf.trades === 0 && d.pf.cash === 50000 && d.pf.positions.length === 0, JSON.stringify(d.pf));

  // errors while fetching
  w.flush();
  w = make();
  mode.stocks = '429';
  clock += 10 * 60e3;
  await w.refresh(w.list()[0], { force: true });
  check('stocks: a limit answer during a refresh is a readable card error', /limit was reached/.test(page(w, id).error || ''), JSON.stringify(page(w, id)).slice(0, 200));
  w.flush();
  w = make();
  mode.stocks = '401';
  clock += 10 * 60e3;
  await w.refresh(w.list()[0], { force: true });
  check('stocks: a refused key during a refresh is a readable card error', /refused the API key/.test(page(w, id).error || ''), JSON.stringify(page(w, id)).slice(0, 200));

  // market closed: the data says so and the refresh is stretched
  w.flush();
  w = make();
  mode.stocks = 'closed';
  clock += 10 * 60e3;
  await w.refresh(w.list()[0], { force: true });
  d = page(w, id).data;
  check('stocks: a closed market is flagged and stretches the refresh to an hour, still tradable at the last close', d.marketOpen === false && d.refreshMs === 3600e3 && d.tradable === true, JSON.stringify(d).slice(0, 200));
  clock += 40 * 60e3;
  const n0 = calls.length;
  await w.refresh(w.list()[0]);
  check('stocks: no new request 40 minutes after a closed-market fetch', calls.length === n0, '');
  clock += 25 * 60e3;
  await w.refresh(w.list()[0]);
  check('stocks: a new request after the hour', calls.length === n0 + 1, '');
  mode.stocks = 'ok';

  // hostile stored config
  const hostileWidget = cleanWidget({ id: 'whostile1', type: 'stocks', mk: { symbols: ['AAPL'] }, pf: { cash0: -5, trades: Array.from({ length: 999 }, () => ({ sym: 'AAPL', qty: 1, px: 0.5, t: 1 })) }, x: 0, y: 0, w: 4, h: 3 });
  check('stocks: a hostile stored portfolio is cleaned on read (capped, bounded)', hostileWidget.pf.trades.length === 200 && hostileWidget.pf.cash0 === 100000, String(hostileWidget.pf.trades.length));
  check('stocks: a widget with no usable symbol is dropped', cleanWidget({ id: 'wnone001', type: 'stocks', mk: { symbols: ['<x>'] } }) === null && cleanWidget({ id: 'wnone002', type: 'crypto', mk: { coins: [] } }) === null, '');

  // ---- crypto ----
  w.flush();
  store.settings = {};
  w = make();
  calls.length = 0;
  const c1 = await w.save({ type: 'crypto', mk: { coins: 'bitcoin, ethereum' } });
  const cid = c1.widget.id;
  await settle(w, cid);
  check('crypto: works without a key: no key header, all coins in one call, USD with 24h change', !store.secrets.coingecko && calls.length >= 1 && calls.every((c) => c.url.includes('ids=bitcoin%2Cethereum') && c.url.includes('include_24hr_change=true') && !('x-cg-demo-api-key' in c.headers)), JSON.stringify(calls));
  d = page(w, cid).data;
  check('crypto: rows, Live badge and CoinGecko attribution', d.rows.length === 2 && d.rows[0].sym === 'BTC' && d.rows[0].px === 60000 && d.rows[0].chg === 1.2 && d.rows[1].chg === -3.5 && d.badge === 'Live' && d.attribution === 'Data: CoinGecko' && d.refreshMs === 120e3, JSON.stringify(d).slice(0, 300));
  check('crypto: refreshes every 2 minutes', CONNECTORS.crypto.ttl === 120e3, '');
  await w.act(w.actionFrom(`file:///n.html?widget=${cid}&do=buy&sym=BTC&qty=0.25`));
  d = page(w, cid).data;
  check('crypto: fractional buys fill (0.25 BTC at 60,000)', d.pf.cash === 85000 && d.pf.positions[0].qty === 0.25 && d.fractional === true, JSON.stringify(d.pf));
  await w.act(w.actionFrom(`file:///n.html?widget=${cid}&do=buy&sym=ETH&qty=10000`));
  check('crypto: not enough cash is refused', /Not enough cash/.test(page(w, cid).data.notice), page(w, cid).data.notice);
  const c2 = await w.save({ type: 'crypto', token: 'CG-abcdefgh12345678', mk: { coins: 'bitcoin, ethereum' } }, cid);
  await settle(w, cid);
  check('crypto: a Demo key is optional, goes in a header, and is stored as a secret', store.secrets.coingecko === 'CG-abcdefgh12345678' && calls.at(-1).headers['x-cg-demo-api-key'] === 'CG-abcdefgh12345678' && !calls.at(-1).url.includes('CG-abcdefgh'), JSON.stringify(calls.at(-1)));
  check('crypto: the edit kept the paper trades', c2.widget.pf.trades.length === 1, '');
  mode.crypto = '429';
  clock += 10 * 60e3;
  w.flush();
  w = make();
  await w.refresh(w.list()[0], { force: true });
  check('crypto: a rate limit is a readable error', /limit was reached/.test(page(w, cid).error || ''), JSON.stringify(page(w, cid)).slice(0, 200));
  mode.crypto = '401';
  clock += 10 * 60e3;
  w.flush();
  w = make();
  await w.refresh(w.list()[0], { force: true });
  check('crypto: a refused key is a readable error', /refused the API key/.test(page(w, cid).error || ''), JSON.stringify(page(w, cid)).slice(0, 200));
  mode.crypto = 'ok';

  // the secret goes with the last widget that used it
  w.remove(cid);
  check('crypto: removing the last crypto widget removes its key; the stocks key stays', !store.secrets.coingecko && store.secrets.twelvedata === KEY, JSON.stringify(Object.keys(store.secrets)));

  // ---- both share the request limiter ----
  const limited = createWidgets({ readSettings: () => store.settings, writeSettings: () => {}, fetch: fakeFetch, getSecret: () => KEY, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), now: () => clock });
  store.settings = { homeWidgets: [{ id: 'wlimit001', type: 'stocks', mk: { symbols: ['AAPL'] } }] };
  clock += 60e3;
  const n1 = calls.length;
  for (let i = 0; i < 6; i++) await limited.refresh(limited.list()[0], { force: true });
  check('markets: repeated Refresh clicks inside MIN_REFRESH make one request', calls.length === n1 + 1, `${calls.length - n1}`);
  const spent = createWidgets({ readSettings: () => store.settings, writeSettings: () => {}, fetch: fakeFetch, getSecret: () => KEY, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), now: () => clock, rateMax: () => 1 });
  await spent.refresh(spent.list()[0], { force: true });
  clock += 20e3;
  await spent.refresh(spent.list()[0], { force: true });
  check('markets: the shared per-minute limiter applies (a second request in the minute is held back, readably)', /Too many requests/.test(spent.cache.get('wlimit001')?.error || ''), spent.cache.get('wlimit001')?.error);
};
