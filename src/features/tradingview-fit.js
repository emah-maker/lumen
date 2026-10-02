// How a TradingView widget fits a small card. The page (renderer/newtab-widgets.js) measures the frame's
// box and asks plan() what to show in it; no DOM and no Electron here, so the tests exercise it on its own.
//
// TradingView's pages are laid out for room, and the new-tab grid lets a card be as small as 2 x 2 cells
// (about 68 px of frame). Measured on the real pages: the full chart is all toolbar below roughly 300 x 230
// (nothing is left for the chart), the mini view clips its price below 190 x 104, and a watchlist's tab row
// eats the first 45 px. So:
//   compact   use features/tradingview-view.js's compact address: the mini price view for a chart, one flat
//             list with no tab row and no chart for a watchlist
//   scale     the page lays the frame out at the size the view needs and shrinks it to fit (never below 0.6,
//             so text stays readable), instead of clipping
// Going compact has a margin on the way back (HYSTERESIS), so a card at the edge doesn't flip and reload.
(() => {
'use strict';

const CHART_MIN = { w: 300, h: 230 }; // the full chart is usable from here up
const WATCH_TABS_H = 200; // a watchlist with several tabs keeps its tab row from here up
const WATCH_CHART_H = 320; // a watchlist's chart on top keeps it from here up
const MINI_MIN = { w: 190, h: 104 }; // the mini price view shows its whole price from here up
const LIST_MIN_W = 230; // a watchlist row shows its price and change from here up
const MIN_SCALE = 0.6;
const HYSTERESIS = 20; // px of extra room needed to leave compact again

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// d: { view, sections, chart } as the card's data carries them. w, h: the frame's box in px.
// was: the last plan (or null). canCompact: the card has a compact address to switch to.
// Returns { compact, scale }, or null while the box has no size yet.
function plan(d, w, h, was = null, canCompact = true) {
  if (!d || !(w > 0) || !(h > 0)) return null;
  const slack = was && was.compact ? HYSTERESIS : 0;
  let compact = false;
  if (canCompact) {
    if (d.view === 'chart') compact = w < CHART_MIN.w + slack || h < CHART_MIN.h + slack;
    else if (d.view === 'watchlist') compact = (d.chart === true && h < WATCH_CHART_H + slack) || (d.sections > 1 && h < WATCH_TABS_H + slack);
  }
  let minW = 0;
  let minH = 0;
  if (d.view === 'mini' || (d.view === 'chart' && compact)) { minW = MINI_MIN.w; minH = MINI_MIN.h; }
  else if (d.view === 'watchlist') minW = LIST_MIN_W;
  const fitW = minW ? w / minW : 1;
  const fitH = minH ? h / minH : 1;
  const scale = Math.round(clamp(Math.min(fitW, fitH), MIN_SCALE, 1) * 100) / 100;
  return { compact, scale };
}

const api = { CHART_MIN, WATCH_TABS_H, WATCH_CHART_H, MINI_MIN, LIST_MIN_W, MIN_SCALE, HYSTERESIS, plan };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.TradingViewFit = api;
})();
