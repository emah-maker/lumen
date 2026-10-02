const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
let host = url;
try { host = new URL(url).host || url; } catch {}
// kind=crashed: the page's process died (a crash, out of memory, or you chose to close a page
// that stopped responding). Reloading starts it fresh.
const crashed = params.get('kind') === 'crashed';
if (crashed) {
  document.title = 'This page crashed';
  document.querySelector('h1').textContent = 'This page crashed';
  document.getElementById('retry').textContent = 'Reload';
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
  ? `Something went wrong while showing ${host ? `“${host}”` : 'this page'}.`
  : kind ? kind.message : host ? `The browser can't connect to “${host}”.` : "The browser can't connect to the server.";
document.getElementById('code').textContent = desc ? `${desc}${params.get('code') ? ` (${params.get('code')})` : ''}` : '';
const retry = document.getElementById('retry');
if (/^https?:\/\//i.test(url)) retry.onclick = () => location.replace(url);
else retry.hidden = true;
