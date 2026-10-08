// A new-tab page that is not in front (a background tab, the spare page, a minimised window) parks its TradingView charts: each chart is a whole extra
// renderer process (about 130 MB) that keeps fetching prices. Hidden for PARK_MS, each such frame is sent to a blank page (its process goes with it);
// shown again, it gets its address back at once and the chart redraws as it did when the page first loaded. Does nothing else: the clocks, polling and
// the effect canvas stop on their own at visibilitychange.
(() => {
  const PARK_MS = 45e3;
  const parked = new Map(); // iframe -> the address it had
  let timer = 0;
  function park() {
    timer = 0;
    if (!document.hidden) return;
    for (const frame of document.querySelectorAll('.tradingview iframe')) {
      const src = frame.getAttribute('src') || '';
      if (!src || src === 'about:blank' || parked.has(frame)) continue;
      parked.set(frame, src);
      frame.src = 'about:blank';
    }
  }
  function unpark() {
    clearTimeout(timer);
    timer = 0;
    for (const [frame, src] of parked) {
      if (frame.isConnected && frame.getAttribute('src') === 'about:blank') frame.src = src; // (changed meanwhile, e.g. a new theme: that wins)
    }
    parked.clear();
  }
  const sync = () => { if (document.hidden) { if (!timer) timer = setTimeout(park, PARK_MS); } else unpark(); };
  document.addEventListener('visibilitychange', sync);
  sync(); // (a page loaded hidden, such as the spare page or a tab opened in the background, gets no event: it starts out hidden)
})();
