// Safe Browsing warning: ?url=<the flagged address>&threat=<SOCIAL_ENGINEERING|MALWARE|UNWANTED_SOFTWARE>.
// "Visit this site anyway" only loads the address again; main.js (features/safe-browsing.js) then
// asks the user in Lumen's own dialog before it loads. Google's terms: warnings say "suspected" or
// "may", link to Google's definitions, and credit Google.
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
let parsed = null;
try { parsed = new URL(url); } catch {}
const host = parsed?.host || url;
const THREATS = {
  SOCIAL_ENGINEERING: {
    title: 'Suspected deceptive site ahead',
    summary: `${host} may try to trick you into doing something dangerous, like entering a password, phone number or card number, or installing software.`,
    learn: 'https://developers.google.com/search/docs/monitor-debug/security/social-engineering',
  },
  MALWARE: {
    title: 'This site may harm your computer',
    summary: `${host} may try to install harmful programs that steal or delete your information.`,
    learn: 'https://developers.google.com/search/docs/monitor-debug/security/malware',
  },
  UNWANTED_SOFTWARE: {
    title: 'This site may offer harmful programs',
    summary: `${host} may try to get you to install programs that change your browser or computer without asking, or show unwanted ads.`,
    learn: 'https://developers.google.com/search/docs/monitor-debug/security/malware',
  },
};
const info = THREATS[params.get('threat')] || THREATS.MALWARE;
document.title = info.title;
document.getElementById('title').textContent = info.title;
document.getElementById('summary').textContent = info.summary;
document.getElementById('learn').href = info.learn;
document.getElementById('host').textContent = host;
document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.replace('newtab.html');
});
const advanced = document.getElementById('advanced');
if (!/^https?:$/.test(parsed?.protocol || '')) advanced.hidden = true;
advanced.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('details').hidden = false;
  advanced.hidden = true;
});
document.getElementById('continue').addEventListener('click', (e) => {
  e.preventDefault();
  if (/^https?:$/.test(parsed?.protocol || '')) location.replace(parsed.href);
});
