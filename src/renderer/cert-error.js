// Certificate warning: ?url=<the https address>&code=<net error>&desc=<ERR_CERT_…>[&final=1].
// "Continue" only loads the address again; main.js (features/site-security.js) then asks the user in
// Lumen's own dialog before anything goes through. final=1: no way through (a revoked certificate).
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
let parsed = null;
try { parsed = new URL(url); } catch {}
const host = parsed?.host || url;
const desc = params.get('desc') || '';
const REASONS = {
  ERR_CERT_AUTHORITY_INVALID: 'Its certificate isn’t issued by an authority this computer trusts (for example, it’s self-signed).',
  ERR_CERT_COMMON_NAME_INVALID: `Its certificate is for a different site, not ${host}.`,
  ERR_CERT_DATE_INVALID: 'Its certificate has expired or isn’t valid yet. Check that your computer’s clock is right.',
  ERR_CERT_REVOKED: 'Its certificate has been revoked by the authority that issued it.',
  ERR_CERT_WEAK_SIGNATURE_ALGORITHM: 'Its certificate is signed with a weak algorithm.',
  ERR_CERT_WEAK_KEY: 'Its certificate uses a weak key.',
};
document.getElementById('host').textContent = host;
document.getElementById('host2').textContent = host;
document.getElementById('reason').textContent = REASONS[desc] || 'Its certificate couldn’t be verified.';
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
