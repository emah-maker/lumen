// Plain Node: Settings → Advanced → Network and proxy → "Use secure DNS" (secureDns, secureDnsCustom; browser/secure-dns.js).
// muse.ai timed out in Lumen (and Chrome) on the user's campus network: its DNS sent the name to a Meta edge that never
// answered. With a DNS-over-HTTPS provider chosen it loads. Checks the resolver options each choice gives, the stored values
// kept or refused, and that the backend applies a change to app.configureHostResolver at once and undoes it on Automatic.
const SD = require('../../src/browser/secure-dns');
const { DEFAULTS, validate, create } = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = JSON.stringify;

(async () => {
  // ---- the resolver options ----
  check('Automatic leaves Chromium alone (nothing to apply)', SD.resolverConfig('auto', '') === null);
  check('Off: never DNS over HTTPS', J(SD.resolverConfig('off', '')) === J({ secureDnsMode: 'off', secureDnsServers: [] }), J(SD.resolverConfig('off')));
  check('Cloudflare: only Cloudflare answers (secure mode, as Chrome\'s "With Cloudflare")', J(SD.resolverConfig('cloudflare')) === J({ secureDnsMode: 'secure', secureDnsServers: ['https://chrome.cloudflare-dns.com/dns-query'] }), J(SD.resolverConfig('cloudflare')));
  check('every named provider is an https server in secure mode', Object.keys(SD.PROVIDERS).every((p) => { const c = SD.resolverConfig(p); return c.secureDnsMode === 'secure' && /^https:\/\//.test(c.secureDnsServers[0]); }));
  check('Custom uses the typed server', J(SD.resolverConfig('custom', ' https://dns.example.org/dns-query ')) === J({ secureDnsMode: 'secure', secureDnsServers: ['https://dns.example.org/dns-query'] }));
  check('Custom keeps a {?dns} template variable', SD.resolverConfig('custom', 'https://dns.example.org/q{?dns}')?.secureDnsServers[0] === 'https://dns.example.org/q{?dns}');
  check('Custom with no usable address is Automatic (no site is cut off by a typo)', SD.resolverConfig('custom', '') === null && SD.resolverConfig('custom', 'http://dns.example.org/q') === null);
  check('the way back to Automatic is Chromium\'s start: automatic, no servers of its own', J(SD.DEFAULT_CONFIG) === J({ secureDnsMode: 'automatic', secureDnsServers: [] }));

  // ---- typed addresses ----
  for (const bad of ['http://dns.example.org/q', 'https://user:pw@dns.example.org/q', 'https://dns example.org/q', 'https://localhost/q', 'javascript:alert(1)', `https://dns.example.org/${'a'.repeat(300)}`, 42, null]) {
    check(`a server address is refused: ${String(bad).slice(0, 40)}`, SD.cleanTemplate(bad) === '', SD.cleanTemplate(bad));
  }

  // ---- the stored setting ----
  check('setting: Automatic by default, so nothing changes for anyone who doesn\'t choose', DEFAULTS.secureDns === 'auto' && DEFAULTS.secureDnsCustom === '', J([DEFAULTS.secureDns, DEFAULTS.secureDnsCustom]));
  check('setting: only a known choice is kept', SD.CHOICES.every((c) => validate('secureDns', c) === c) && validate('secureDns', 'opendns') === null && validate('secureDns', true) === null);
  check('setting: a custom server is kept, cleared, or refused', validate('secureDnsCustom', 'https://dns.example.org/q') === 'https://dns.example.org/q' && validate('secureDnsCustom', '') === '' && validate('secureDnsCustom', 'http://x.example/q') === null);

  // ---- applied to the running browser ----
  let file = { ...DEFAULTS };
  const calls = [];
  const app = { configureHostResolver: (c) => calls.push(c), commandLine: { appendSwitch() {}, hasSwitch: () => false, getSwitchValue: () => '' }, getPath: () => require('os').tmpdir(), getLocale: () => 'en-US', isReady: () => true };
  let backend;
  try {
    backend = create({ app, session: { defaultSession: { getSpellCheckerLanguages: () => [], availableSpellCheckerLanguages: [] } }, nativeTheme: { on() {} }, dialog: {}, shell: {}, readSettings: () => file, writeSettings: (s) => { file = s; }, tabContents: () => [] });
  } catch (err) { check('the backend starts with a stand-in app', false, err.stack); }
  if (backend) {
    await backend.set('secureDns', 'auto').catch(() => {});
    check('Automatic at start: Chromium\'s resolver is never touched', calls.length === 0, J(calls));
    await backend.set('secureDns', 'cloudflare');
    check('choosing Cloudflare applies it at once', J(calls.at(-1)) === J(SD.resolverConfig('cloudflare')), J(calls));
    await backend.set('secureDns', 'auto');
    check('back to Automatic undoes it', J(calls.at(-1)) === J(SD.DEFAULT_CONFIG), J(calls));
    const n = calls.length;
    await backend.set('secureDnsCustom', 'https://dns.example.org/q');
    check('typing a custom server while Automatic is chosen changes nothing', calls.length === n, J(calls.slice(n)));
    await backend.set('secureDns', 'custom');
    check('choosing Custom uses the typed server', J(calls.at(-1)) === J(SD.resolverConfig('custom', 'https://dns.example.org/q')), J(calls.at(-1)));
  }

  process.exit(failures ? 1 : 0);
})();
