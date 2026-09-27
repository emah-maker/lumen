// HTTPS-only warning: ?url=<the http address>. "Continue" loads it; main.js lets that one through.
const url = new URLSearchParams(location.search).get('url') || '';
let parsed = null;
try { parsed = new URL(url); } catch {}
if (parsed?.protocol === 'http:') {
  document.getElementById('host').textContent = parsed.host;
  document.getElementById('secure').textContent = `https://${parsed.host}`;
  document.getElementById('continue').href = parsed.href;
} else {
  document.getElementById('continue').hidden = true;
}
document.getElementById('back').addEventListener('click', () => history.back());
