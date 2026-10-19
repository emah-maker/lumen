// What a reload request does to a tab's page. The toolbar's reload button turns into Stop while the page loads, so a
// click then stops it; F5 / Ctrl+R and the menus (`always`) always reload, as in Chrome (a stalled load is retried, not just
// cancelled). Shift (`ignoreCache`) forces a reload past the cache. An error page reloads the address it failed on.
// -> 'stop' | 'reload-failed' | 'reload-hard' | 'reload'
function reloadAction({ loading = false, ignoreCache = false, errorPage = false, always = false } = {}) {
  if (loading && !ignoreCache && !always) return 'stop';
  if (errorPage) return 'reload-failed';
  return ignoreCache ? 'reload-hard' : 'reload';
}

module.exports = { reloadAction };
