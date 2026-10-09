// Certificate warning: ?url=<the https address>&code=<net error>&desc=<ERR_CERT_…>[&final=1].
// "Continue" only loads the address again; main.js (features/site-security.js) then asks the user in
// Lumen's own dialog before anything goes through. final=1: no way through (a revoked certificate).
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
let parsed = null;
try { parsed = new URL(url); } catch {}
const host = parsed?.host || url;
const desc = params.get('desc') || '';
document.getElementById('host').textContent = host;
document.getElementById('host2').textContent = host;
document.getElementById('reason').textContent = window.certReasons.reasonFor(desc, host);
document.getElementById('code').textContent = desc;
document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.replace('newtab.html');
});
const advanced = document.getElementById('advanced');
if (parsed?.protocol !== 'https:' || params.get('final')) advanced.hidden = true;
advanced.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('details').hidden = false;
  advanced.hidden = true;
});
document.getElementById('continue').addEventListener('click', (e) => {
  e.preventDefault();
  if (parsed?.protocol === 'https:') location.replace(parsed.href);
});
