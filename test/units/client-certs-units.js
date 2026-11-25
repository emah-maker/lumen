// Client certificates (browser/client-certs.js), plain Node: a page nobody watches never gets one (Electron's default sent
// the first in the store, so Microsoft's sign-in in the AI's Canvas tab popped a Windows Hello prompt for the wrong account);
// a user's tab asks once per site, "Don't send" is the default and is remembered; the strings are in locales/en.json.
const { createClientCerts, label, hostOf } = require('../../src/browser/client-certs');
const en = require('../../src/locales/en.json');

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };

const device = { subjectName: '9b1c68ad-0027', issuerName: 'MS-Organization-Access', validExpiry: Date.UTC(2036, 9, 15) / 1000, fingerprint: 'sha256/device' };
const smart = { subjectName: 'Ada Lovelace', issuerName: 'School CA', validExpiry: Date.UTC(2027, 1, 1) / 1000, fingerprint: 'sha256/ada' };
const URL_MS = 'https://device.login.microsoftonline.com/common/oauth2/authorize';

function setup({ user = true, answer = -1 } = {}) {
  const asks = [];
  const certs = createClientCerts({ isUserTab: () => user, ask: async (o) => { asks.push(o); return typeof answer === 'function' ? answer(o) : answer; } });
  const run = (list = [device, smart], url = URL_MS) => new Promise((resolve) => certs.select({ id: 1 }, url, list, (...args) => resolve(args)));
  return { certs, asks, run };
}

(async () => {
  {
    const { asks, run } = setup({ user: false, answer: 0 });
    const args = await run();
    check('AI / background tab: no certificate, no prompt', args.length === 0 && asks.length === 0, JSON.stringify({ args, asks: asks.length }));
  }
  {
    const certs = createClientCerts({ isUserTab: () => { throw new Error('gone'); }, ask: async () => 0 });
    const args = await new Promise((resolve) => certs.select({}, URL_MS, [device], (...a) => resolve(a)));
    check('a tab that cannot be looked up counts as unwatched', args.length === 0);
  }
  {
    const { asks, run } = setup({ answer: -1 });
    const a = await run();
    const b = await run();
    check('user tab, Don\'t send: none sent', a.length === 0 && b.length === 0);
    check('Don\'t send is remembered for the site (asked once)', asks.length === 1, String(asks.length));
    check('the sheet names the site and each certificate', asks[0].host === 'device.login.microsoftonline.com' && asks[0].labels.length === 2 && asks[0].labels[0].includes('MS-Organization-Access'), JSON.stringify(asks[0]?.labels));
  }
  {
    const { asks, run } = setup({ answer: 1 });
    const a = await run();
    const b = await run([smart, device]); // (another order: matched by fingerprint, not position)
    check('user tab, picked: that certificate is sent', a[0] === smart && b[0] === smart && asks.length === 1, JSON.stringify([a[0]?.fingerprint, b[0]?.fingerprint, asks.length]));
    const c = await run([device]);
    check('picked certificate gone: asks again', asks.length === 2 && c.length === 0);
  }
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { asks, run } = setup({ answer: () => gate.then(() => 0) });
    const both = Promise.all([run(), run()]);
    release();
    const [a, b] = await both;
    check('two requests at once: one sheet, both answered', asks.length === 1 && a[0] === device && b[0] === device);
  }
  {
    const { asks, run } = setup({ answer: 0 });
    const args = await run([]);
    check('empty list: nothing asked', args.length === 0 && asks.length === 0);
  }
  {
    const { run } = setup({ answer: async () => { throw new Error('dialog closed'); } });
    const args = await run();
    check('a failed sheet sends nothing', args.length === 0);
  }
  check('label: who · issuer · expiry', label(device) === '9b1c68ad-0027 · MS-Organization-Access · until 2036-10-15', label(device));
  check('hostOf: bad address is empty', hostOf('not a url') === '' && hostOf('https://A.example.com/x') === 'a.example.com');
  const keys = ['dialog.clientCert', 'dialog.clientCert.detail', 'dialog.clientCert.none'];
  const strings = en.strings || en;
  check('strings are in locales/en.json', keys.every((k) => typeof strings[k] === 'string'), keys.filter((k) => typeof strings[k] !== 'string').join());

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
