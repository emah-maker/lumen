// Stocks and Crypto widgets, the pure part: watchlist checks, the parsers for the two data providers'
// answers, and the SIMULATED paper-trading portfolio. No network, no Electron: features/widgets.js does
// the fetching, and test/widget-units.js exercises all of this on its own.
//
// Nothing here trades anything. A portfolio is a starting cash figure and a list of trades
// { sym, qty, px, t } (qty > 0 buys, qty < 0 sells, px the last fetched quote). Cash and positions are
// never stored: replay() derives them from the trades on every read, in integer cents and integer
// 1e-8 units so nothing drifts. A stored list that is hostile or broken loses the trades that don't
// replay (oversell, not enough cash, bad numbers); it never throws.
'use strict';

const SYM_RE = /^[A-Z0-9.-]{1,12}$/;
const COIN_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const MAX_TRADES = 200;
const MAX_STOCKS = 8; // Twelve Data's free plan: 8 credits a minute, and (we assume) 1 credit per symbol
const MAX_COINS = 12;
const START_CASH = 100000;
const MIN_CASH = 1000;
const MAX_CASH = 1e9;
const MAX_QTY = 1e7;
const MAX_PX = 1e9;
const MAX_TRADE_CENTS = 1e13; // keeps every sum below 2^53
const UNITS = 1e8; // quantities are kept in integer units of 1e-8
const MAX_T = 4102444800000; // 2100-01-01

const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, dp) => { const k = 10 ** dp; return Math.round(v * k) / k; };
const dollars = (cents) => cents / 100;

// ---- watchlists ----
const cleanSym = (v) => { const s = flat(String(v ?? ''), 40).toUpperCase(); return SYM_RE.test(s) ? s : null; };
// "aapl, msft\nnvda" or an array -> unique valid symbols, at most `max`.
function cleanSymbols(v, max = MAX_STOCKS) {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : [];
  const out = [];
  for (const p of parts) {
    const s = typeof p === 'string' ? cleanSym(p) : null;
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
const KNOWN_TICKERS = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP', dogecoin: 'DOGE', cardano: 'ADA', litecoin: 'LTC', binancecoin: 'BNB',
  polkadot: 'DOT', chainlink: 'LINK', 'avalanche-2': 'AVAX', tron: 'TRX', 'matic-network': 'MATIC', stellar: 'XLM', 'bitcoin-cash': 'BCH', monero: 'XMR',
};
// Coins: CoinGecko ids ("bitcoin"), each with the ticker trades use ("BTC"). Input: "bitcoin, ethereum=ETH"
// or [{ id, sym }] or ["bitcoin"].
function cleanCoins(v, max = MAX_COINS) {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : [];
  const out = [];
  for (const p of parts) {
    let id;
    let sym;
    if (p && typeof p === 'object') { id = flat(String(p.id ?? ''), 60).toLowerCase(); sym = cleanSym(p.sym); } else {
      const [a, b] = String(p ?? '').split('=');
      id = flat(a, 60).toLowerCase();
      sym = cleanSym(b);
    }
    if (!COIN_RE.test(id) || out.some((c) => c.id === id)) continue;
    sym = sym || KNOWN_TICKERS[id] || cleanSym(id.replace(/[^a-z0-9]/g, '').slice(0, 12));
    if (!sym || out.some((c) => c.sym === sym)) continue;
    out.push({ id, sym });
    if (out.length >= max) break;
  }
  return out;
}

// ---- the paper portfolio ----
const cleanCash = (v) => { const n = Number(v); return Number.isFinite(n) && n >= MIN_CASH && n <= MAX_CASH ? Math.round(n * 100) / 100 : START_CASH; };
const qtyUnits = (q) => Math.round(Math.abs(q) * UNITS);

// One trade -> a checked trade, or null. fractional: crypto may buy 0.0025; a share is whole.
function cleanTrade(t, fractional) {
  if (!t || typeof t !== 'object') return null;
  const sym = typeof t.sym === 'string' && SYM_RE.test(t.sym) ? t.sym : null;
  const qty = fin(t.qty);
  const px = fin(t.px);
  const at = fin(t.t);
  if (!sym || qty === null || px === null || at === null) return null;
  if (qty === 0 || Math.abs(qty) > MAX_QTY || !(px > 0) || px > MAX_PX || at < 0 || at > MAX_T) return null;
  if (!fractional && !Number.isInteger(qty)) return null;
  const q = round(qty, 8);
  if (q === 0) return null;
  return { sym, qty: q, px: round(px, 8), t: Math.round(at) };
}

const fresh = (cash0) => ({ cash0, cash: Math.round(cash0 * 100), pos: new Map(), realized: 0 });
// Apply a checked trade to a state. Returns an error message, or null (and the state has changed).
function step(state, trade) {
  const units = qtyUnits(trade.qty);
  const gross = Math.round((units * trade.px * 100) / UNITS);
  if (units < 1 || gross < 1) return 'That amount is too small.';
  if (gross > MAX_TRADE_CENTS) return 'That trade is too large.';
  const held = state.pos.get(trade.sym);
  if (trade.qty > 0) {
    if (gross > state.cash) return 'Not enough cash.';
    state.cash -= gross;
    if (held) { held.u += units; held.cost += gross; } else state.pos.set(trade.sym, { u: units, cost: gross });
    return null;
  }
  if (!held || units > held.u) return `You don’t hold that many ${trade.sym}.`;
  const basis = units === held.u ? held.cost : Math.round((held.cost * units) / held.u);
  state.cash += gross;
  state.realized += gross - basis;
  held.u -= units;
  held.cost -= basis;
  if (held.u === 0) state.pos.delete(trade.sym);
  return null;
}
// A stored portfolio -> { cash0, trades } with only the trades that replay (in order), at most MAX_TRADES.
function cleanPortfolio(pf, { fractional = false } = {}) {
  const src = pf && typeof pf === 'object' ? pf : {};
  const cash0 = cleanCash(src.cash0);
  const state = fresh(cash0);
  const trades = [];
  for (const raw of Array.isArray(src.trades) ? src.trades : []) {
    if (trades.length >= MAX_TRADES) break;
    const t = cleanTrade(raw, fractional);
    if (t && step(state, t) === null) trades.push(t);
  }
  return { cash0, trades };
}
// Cash and positions from the trades: the only place they exist.
function replay(pf, opts) {
  const { cash0, trades } = cleanPortfolio(pf, opts);
  const state = fresh(cash0);
  for (const t of trades) step(state, t);
  return { ...state, trades };
}

// The portfolio as the card shows it, valued at the quotes { SYM: px }. A holding without a quote is
// valued at what it cost.
function present(pf, quotes, opts) {
  const s = replay(pf, opts);
  let holdings = 0;
  const positions = [...s.pos.entries()].map(([sym, p]) => {
    const px = fin(quotes?.[sym]);
    const valueC = px && px > 0 ? Math.round((p.u * px * 100) / UNITS) : p.cost;
    holdings += valueC;
    const qty = p.u / UNITS;
    return {
      sym, qty, avg: round(dollars(p.cost) / qty, 4), px: px && px > 0 ? px : null, value: dollars(valueC), pl: dollars(valueC - p.cost),
      plPct: p.cost > 0 ? round(((valueC - p.cost) / p.cost) * 100, 2) : 0,
    };
  }).sort((a, b) => b.value - a.value || a.sym.localeCompare(b.sym));
  const equityC = s.cash + holdings;
  const startC = Math.round(s.cash0 * 100);
  return {
    start: s.cash0, cash: dollars(s.cash), equity: dollars(equityC), pl: dollars(equityC - startC), plPct: round(((equityC - startC) / startC) * 100, 2),
    realized: dollars(s.realized), positions, trades: s.trades.length, tradesMax: MAX_TRADES,
  };
}

// Whether the last quote is too old (or unreachable) to trade at: older than twice how often it refreshes.
function isStale({ fetchedAt, now, refreshMs, offline }) {
  if (offline || !Number.isFinite(fetchedAt) || !fetchedAt || !Number.isFinite(now)) return true;
  return now - fetchedAt > 2 * (Number.isFinite(refreshMs) && refreshMs > 0 ? refreshMs : 15 * 60e3);
}
// Try one trade at a quote. -> { ok: true, pf, trade } | { ok: false, error }. Never changes `pf`.
function attempt(pf, { side, sym, qty, px, now, fractional = false }) {
  if (side !== 'buy' && side !== 'sell') return { ok: false, error: 'Buy or sell.' };
  const s = cleanSym(sym);
  if (!s) return { ok: false, error: 'Pick a symbol.' };
  if (!(fin(px) > 0)) return { ok: false, error: `No price for ${s} right now.` };
  const q = fin(qty);
  if (q === null || !(q > 0) || q > MAX_QTY) return { ok: false, error: 'Enter a quantity.' };
  if (!fractional && !Number.isInteger(q)) return { ok: false, error: 'Shares are whole numbers.' };
  const clean = cleanPortfolio(pf, { fractional });
  if (clean.trades.length >= MAX_TRADES) return { ok: false, error: 'The trade list is full. Reset to start over.' };
  const trade = cleanTrade({ sym: s, qty: side === 'buy' ? q : -q, px, t: now }, fractional);
  if (!trade) return { ok: false, error: 'That trade isn’t valid.' };
  const state = fresh(clean.cash0);
  for (const t of clean.trades) step(state, t);
  const err = step(state, trade);
  if (err) return { ok: false, error: err };
  return { ok: true, pf: { cash0: clean.cash0, trades: [...clean.trades, trade] }, trade };
}

// ---- the providers' answers ----
class ProviderError extends Error {}
const pct = (v) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= 10000 ? round(n, 4) : null; };
const price = (v) => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_PX ? n : null; };
const seconds = (v, now) => { const n = Number(v); return Number.isFinite(n) && n > 1e9 && n * 1000 <= now + 86400e3 ? Math.round(n) * 1000 : null; };

// The message for an error answer of Twelve Data ({ code, message, status: "error" }) or its HTTP status.
function twelveError(status, body) {
  const code = Number(body?.code) || status;
  if (code === 401 || code === 403) return 'Twelve Data refused the API key. Check it in Settings.';
  if (code === 429) return 'Twelve Data’s limit was reached (the free plan allows 8 requests a minute and 800 a day). Lumen will try again later.';
  const msg = flat(body?.message, 140);
  return msg ? `Twelve Data: ${msg}` : `Twelve Data answered ${status}.`;
}
// /quote for several symbols: an object keyed by symbol (a single symbol comes back as one flat object).
// -> { rows: [{ sym, name, px, chg, open, at }], missing: [sym] }; throws ProviderError for a whole-request error.
function parseTwelve(body, symbols, now = Date.now(), status = 200) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('Twelve Data sent something unexpected.');
  if (body.status === 'error' && !symbols.some((s) => body[s] && typeof body[s] === 'object')) throw new ProviderError(twelveError(status, body));
  const flatOne = symbols.length === 1 && ('close' in body || 'symbol' in body);
  const rows = [];
  const missing = [];
  for (const sym of symbols) {
    const q = flatOne ? body : body[sym];
    const px = q && typeof q === 'object' && q.status !== 'error' ? price(q.close) : null;
    if (px === null) { missing.push(sym); continue; }
    rows.push({ sym, name: flat(q.name, 60), px, chg: pct(q.percent_change), open: q.is_market_open === true, at: seconds(q.timestamp, now) });
  }
  return { rows, missing };
}
function geckoError(status, body) {
  if (status === 401 || status === 403 || status === 10002 || status === 10010 || status === 10011) return 'CoinGecko refused the API key. Check it in Settings, or remove it to go without.';
  if (status === 429) return 'CoinGecko’s limit was reached (keyless access is limited; a free Demo key allows more). Lumen will try again later.';
  const msg = flat(body?.error?.status?.error_message || body?.status?.error_message || (typeof body?.error === 'string' ? body.error : ''), 140);
  return msg ? `CoinGecko: ${msg}` : `CoinGecko answered ${status}.`;
}
// /simple/price?ids=…&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true
function parseGecko(body, coins, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('CoinGecko sent something unexpected.');
  const rows = [];
  const missing = [];
  for (const { id, sym } of coins) {
    const q = Object.prototype.hasOwnProperty.call(body, id) ? body[id] : null;
    const px = q && typeof q === 'object' ? price(q.usd) : null;
    if (px === null) { missing.push(sym); continue; }
    rows.push({ sym, name: id, px, chg: pct(q.usd_24h_change), open: true, at: seconds(q.last_updated_at, now) });
  }
  return { rows, missing };
}

module.exports = {
  SYM_RE, COIN_RE, MAX_TRADES, MAX_STOCKS, MAX_COINS, START_CASH, MIN_CASH, MAX_CASH, MAX_QTY,
  cleanSym, cleanSymbols, cleanCoins, cleanCash, cleanTrade, cleanPortfolio, replay, present, isStale, attempt,
  parseTwelve, parseGecko, twelveError, geckoError, ProviderError,
};
