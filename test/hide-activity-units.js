// [tracking] features/tracking-params.js (the tracking parameters taken off a page's address) and the settings,
// strings of the privacy protections (all on by default). Plain Node.
const fs = require('fs');
const path = require('path');
const { strip } = require('../src/features/tracking-params');
const FO = require('../src/features/feature-offers');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const same = (label, input, want) => { const got = strip(input); check(label, got === want, got); };

same('campaign tags go, the rest stays in order', 'https://shop.example/p?id=7&utm_source=x&color=red&utm_medium=email', 'https://shop.example/p?id=7&color=red');
same('ad-click ids go', 'https://news.example/a?fbclid=AbC&gclid=1&msclkid=2&ttclid=3', 'https://news.example/a');
same('the hash is kept', 'https://site.example/a?utm_campaign=z#section-2', 'https://site.example/a#section-2');
same('names are matched without case', 'https://site.example/?UTM_Source=x&q=1', 'https://site.example/?q=1');
same('the kept part is not re-encoded', 'https://site.example/s?q=a+b%20c&x=%E2%9C%93&utm_term=t', 'https://site.example/s?q=a+b%20c&x=%E2%9C%93');
same('an address with nothing to remove comes back as it was', 'https://site.example/s?q=1&si=2', 'https://site.example/s?q=1&si=2');
same('no query: as it was', 'https://site.example/a/b', 'https://site.example/a/b');
same('YouTube share ids go only on YouTube', 'https://www.youtube.com/watch?v=abc&si=XYZ&pp=q', 'https://www.youtube.com/watch?v=abc');
same('youtu.be share id', 'https://youtu.be/abc?si=XYZ', 'https://youtu.be/abc');
same('Spotify share id', 'https://open.spotify.com/track/1?si=abc', 'https://open.spotify.com/track/1');
same('sign-in pages are never touched', 'https://accounts.google.com/o/oauth2?utm_source=x&state=1', 'https://accounts.google.com/o/oauth2?utm_source=x&state=1');
same('a parameter only named like one is kept', 'https://site.example/?utmost=1&gclid_note=2', 'https://site.example/?utmost=1&gclid_note=2');
same('empty pairs are dropped with the trackers', 'https://site.example/?a=1&&utm_id=2', 'https://site.example/?a=1');
same('not http: as it was', 'ftp://site.example/?utm_source=x', 'ftp://site.example/?utm_source=x');
check('a non-string comes back as it was', strip(null) === null && strip(undefined) === undefined);

const backend = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings', 'settings-backend.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'en.json'), 'utf8'));
check('every privacy protection ships on', ['hideTabActivity', 'hideWindowSize', 'fingerprintProtection', 'webrtcIpProtection', 'sendGpc', 'stripTrackingParams', 'blockTrackingPings'].every((k) => new RegExp(`\\n {2}${k}: true,`).test(backend)));
check('so none of them is in the after-update offers (those are for features that ship off)', !FO.OFFERS.some((o) => ['hideTabActivity', 'hideWindowSize', 'fingerprintProtection'].includes(o.key)));
check('every new Settings row has its strings', ['hideTab', 'hideSize', 'fingerprint', 'webrtc', 'stripParams', 'pings'].every((k) => en[`settings.privacy.${k}`] && en[`settings.privacy.${k}Desc`]));

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
