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
document.getElementById('message').textContent = crashed
  ? `Something went wrong while showing ${host ? `“${host}”` : 'this page'}.`
  : host ? `The browser can't connect to “${host}”.` : "The browser can't connect to the server.";
const desc = params.get('desc');
document.getElementById('code').textContent = desc ? `${desc}${params.get('code') ? ` (${params.get('code')})` : ''}` : '';
const retry = document.getElementById('retry');
if (/^https?:\/\//i.test(url)) retry.onclick = () => location.replace(url);
else retry.hidden = true;
