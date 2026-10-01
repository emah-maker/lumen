// The new-tab backdrop drifts for a few seconds after the page shows, then holds still (body.drift-paused,
// newtab.html): a moving layer behind frosted cards makes the GPU re-blur every card on every frame, for as
// long as the page stays open. It also holds still while the page is hidden, and drifts again for a few
// seconds when the tab comes back.
(() => {
  const DRIFT_MS = 10000;
  let timer = 0;
  const hold = () => { clearTimeout(timer); timer = 0; document.body.classList.add('drift-paused'); };
  const drift = () => {
    clearTimeout(timer);
    document.body.classList.remove('drift-paused');
    timer = setTimeout(hold, DRIFT_MS);
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) hold(); else drift(); });
  if (document.hidden) hold(); else drift();
})();
