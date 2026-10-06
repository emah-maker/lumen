// Pure unit test for browser/google-auth-identity.js: the list of Google's sign-in hosts. (Google's sign-in used to get a
// Firefox identity; Google now refuses that and accepts the one Chrome identity, so the hosts get no special
// identity, see the header of that file and test/chrome-identity-units.js for the identity itself.) No Electron.
const assert = require('assert');
const ga = require('../src/browser/google-auth-identity');
const chromeId = require('../src/browser/chrome-identity');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

// ---- hosts
for (const url of ['https://accounts.google.com/v3/signin/identifier', 'https://accounts.google.co.uk/', 'https://accounts.google.com.au/x', 'https://accounts.google.de/', 'https://accounts.youtube.com/accounts/CheckConnection', 'https://gds.google.com/']) {
  check(`host: ${url} is a sign-in host`, ga.isAuthUrl(url), url);
}
for (const url of ['https://www.google.com/', 'https://mail.google.com/', 'https://accounts.google.com.evil.com/', 'https://evilaccounts.google.com/', 'https://accounts.google.com@evil.com/', 'http://accounts.google.com/', 'https://notaccounts.youtube.com/', 'https://www.youtube.com/', 'about:blank', '', 'not a url']) {
  check(`host: ${JSON.stringify(url)} is not`, !ga.isAuthUrl(url), url);
}
check('auth hosts: the dots are literal (a look-alike host is not an auth host)', ga.isAuthHost('accounts.google.com') && ga.isAuthHost('accounts.google.co.uk') && !ga.isAuthHost('accountsxgoogle.com') && !ga.isAuthHost('accounts-google.com') && !ga.isAuthHost('gdsxgoogle.com') && !new RegExp(ga.HOST_SOURCE, 'i').test('accountsXyoutube.com'), ga.HOST_SOURCE);

// ---- no Firefox identity any more: nothing of it is exported, and the Chrome script no longer skips these hosts
check('no Firefox identity is exported', !('firefoxProfile' in ga) && !('firefoxScript' in ga) && !('firefoxRequestHeaders' in ga), Object.keys(ga).join());
check('the Chrome identity script is not host-scoped', !chromeId.IDENTITY_SCRIPT.includes(ga.HOST_SOURCE) && /\)\(\);$/.test(chromeId.IDENTITY_SCRIPT), chromeId.IDENTITY_SCRIPT.slice(-60));

// ---- wiring: the one identity reaches every page, and the ad blocker leaves sign-in pages alone
{
  const fs = require('fs');
  const path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const adblock = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'adblock.js'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings', 'settings-backend.js'), 'utf8');
  check('wiring: Page is enabled before the document-start script is added (without it the script is skipped when the debugging port is open)', /send\('Page\.enable', \{\}, sessionId\)[^\n]*\.then\(\(\) =>\s*send\('Page\.addScriptToEvaluateOnNewDocument'/.test(main), 'order');
  check('wiring: no Firefox identity is applied anywhere', !main.includes('FIREFOX_PROFILE') && !main.includes('firefoxScript') && !settings.includes('firefoxRequestHeaders') && !fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'private-window.js'), 'utf8').includes('firefox'), 'firefox');
  check('wiring: the ad blocker lets a Google sign-in page load everything it asks for', /isAuthUrl\(page\)\) return callback\(\{\}\)/.test(adblock), 'adblock');
}

assert.strictEqual(failures, 0, `${failures} google-auth-identity check(s) failed`);
console.log('google-auth-identity units: all passed');
