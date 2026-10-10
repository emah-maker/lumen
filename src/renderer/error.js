// The wording comes from locales/en.json through window.t (i18n.js, with the table error-preload.js fetched).
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
let host = url;
try { host = new URL(url).host || url; } catch {}
// kind=crashed: the page's process died (a crash, out of memory, or you chose to close a page
// that stopped responding). Reloading starts it fresh.
const crashed = params.get('kind') === 'crashed';
if (crashed) {
  document.title = window.t('errorPage.crashed.title');
  document.querySelector('h1').textContent = window.t('errorPage.crashed.title');
  document.getElementById('retry').textContent = window.t('errorPage.reload');
}
const desc = params.get('desc');
// A network error names what went wrong and what to try (renderer/error-kinds.js).
const kind = crashed ? null : window.errorKinds?.describe(desc, host);
if (kind) {
  document.title = kind.title;
  document.querySelector('h1').textContent = kind.title;
  const hint = document.getElementById('hint');
  hint.textContent = kind.hint;
  hint.hidden = !kind.hint;
}
document.getElementById('message').textContent = crashed
  ? window.t('errorPage.crashed.message', { site: host ? `“${host}”` : window.t('errorPage.thisPage') })
  : kind ? kind.message : host ? window.t('errorPage.kind.general.message', { site: `“${host}”` }) : window.t('errorPage.kind.general.messageNoHost');
document.getElementById('code').textContent = desc ? `${desc}${params.get('code') ? ` (${params.get('code')})` : ''}` : '';
const retry = document.getElementById('retry');
if (/^https?:\/\//i.test(url)) retry.onclick = () => location.replace(url);
else retry.hidden = true;
// A name that didn't resolve: main passes the default search engine's URL for the host, so the hint's
// "search for the site instead" is one click (only an http(s) address is followed).
const searchUrl = params.get('search') || '';
const searchButton = document.getElementById('search');
if (!crashed && host && /^https?:\/\//i.test(searchUrl)) {
  searchButton.textContent = window.t('errorPage.searchFor', { site: host });
  searchButton.hidden = false;
  searchButton.onclick = () => location.replace(searchUrl);
}
