// Safe Browsing warning: ?url=<the flagged address>&threat=<SOCIAL_ENGINEERING|MALWARE|UNWANTED_SOFTWARE>.
// "Visit this site anyway" only loads the address again; main.js (features/safe-browsing.js) then
// asks the user in Lumen's own dialog before it loads. Google's terms: warnings say "suspected" or
// "may", link to Google's definitions, and credit Google.
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
let parsed = null;
try { parsed = new URL(url); } catch {}
const host = parsed?.host || url;
const THREATS = { // the wording is locales/en.json (safeBrowsing.<key>.title and .summary), through window.t (i18n.js)
  SOCIAL_ENGINEERING: {
    key: 'social',
    learn: 'https://developers.google.com/search/docs/monitor-debug/security/social-engineering',
  },
  MALWARE: {
    key: 'malware',
    learn: 'https://developers.google.com/search/docs/monitor-debug/security/malware',
  },
  UNWANTED_SOFTWARE: {
    key: 'unwanted',
    learn: 'https://developers.google.com/search/docs/monitor-debug/security/malware',
  },
};
const info = THREATS[params.get('threat')] || THREATS.MALWARE;
const title = window.t(`safeBrowsing.${info.key}.title`);
document.title = title;
document.getElementById('title').textContent = title;
document.getElementById('summary').textContent = window.t(`safeBrowsing.${info.key}.summary`, { host });
document.getElementById('learn').href = info.learn;
document.getElementById('host').textContent = host;
window.fill(document.getElementById('lead'), 'safeBrowsing.lead', { host: document.getElementById('host') });
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
