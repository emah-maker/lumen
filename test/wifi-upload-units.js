// [phone wifi] Receiving files over Wi-Fi (features/wifi-upload.js), plain Node with a real HTTP server on 127.0.0.1
// (allowLoopback) and a real phone inbox in a temporary folder: picking the LAN address, the key, Host and Origin checks, the
// upload header, the first device claiming the session, wrong keys ending it, size limits, a cut-off upload leaving nothing,
// the page's CSP, and stop() closing everything.
require('./_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const W = require('../src/features/wifi-upload');
const { createPhoneInbox } = require('../src/features/phone-inbox');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const words = { title: 'Send to Lumen', intro: 'Pick photos', pick: 'Choose', note: 'Note', waiting: 'Waiting', sent: 'Sent', failed: 'Failed', tooBig: 'Too big', ended: 'Ended', taken: 'Taken', sessionFull: 'Full', diskFull: 'Disk full', noNetwork: 'No Wi-Fi' };

// One request: { status, headers, body }. `localAddress` picks the "device" (127.0.0.x).
function request(url, { method = 'GET', headers = {}, body = null, localAddress, host } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const all = Object.fromEntries(Object.entries({ ...(host ? { host } : {}), ...headers }).filter(([, v]) => v !== undefined));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: all, localAddress, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}
const upload = (url, data, { name = 'photo.jpg', caption, headers = {}, ...opts } = {}) => request(`${url}/upload`, {
  method: 'POST', body: data, ...opts,
  headers: { 'x-lumen-upload': '1', 'x-file-name': encodeURIComponent(name), 'content-type': 'image/jpeg', 'content-length': String(data.length), ...(caption ? { 'x-caption': encodeURIComponent(caption) } : {}), ...headers },
});

(async () => {
  // ---- choosing the address
  check('private IPv4 ranges are recognised', W.isPrivateV4('192.168.1.20') && W.isPrivateV4('10.0.0.5') && W.isPrivateV4('172.20.1.1'));
  check('public, link-local, CGNAT and loopback are not', !W.isPrivateV4('8.8.8.8') && !W.isPrivateV4('169.254.3.4') && !W.isPrivateV4('100.64.0.1') && !W.isPrivateV4('127.0.0.1') && !W.isPrivateV4('172.32.0.1') && !W.isPrivateV4('999.1.1.1'));
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    utun3: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
    bridge100: [{ address: '192.168.64.1', family: 'IPv4', internal: false }],
    en5: [{ address: '10.0.1.9', family: 'IPv4', internal: false }],
    en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.20', family: 'IPv4', internal: false }],
  };
  check('Wi-Fi (en0) wins; VPN tunnels and VM bridges are skipped', W.lanAddress(ifaces)?.ip === '192.168.1.20', JSON.stringify(W.lanAddress(ifaces)));
  check('…Ethernet when there is no Wi-Fi', W.lanAddress({ utun3: ifaces.utun3, en5: ifaces.en5 })?.ip === '10.0.1.9');
  check('no private address: null (only a VPN, only public)', W.lanAddress({ utun3: ifaces.utun3, en0: [{ address: '8.8.8.8', family: 'IPv4' }] }) === null);
  const noNet = W.createWifiUpload({ http, words, interfaces: () => ({ lo0: ifaces.lo0 }), inbox: { dir: os.tmpdir() } });
  check('start() without a Wi-Fi address refuses, and says so', await noNet.start().then(() => null, (e) => e.code) === 'no-network');

  // ---- a session
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-wifi-'));
  const inbox = createPhoneInbox({ dir: path.join(root, 'From phone'), platform: 'linux' });
  const events = [];
  const shown = [];
  let free = Infinity;
  const wifi = W.createWifiUpload({ http, words, allowLoopback: true, inbox, onEvent: (e) => events.push(e), onFile: (f, c) => shown.push({ f, c }), freeBytes: () => free, deviceOf: (req) => req.headers['x-test-device'] || req.socket.remoteAddress });
  const s = await wifi.start();
  const key = s.url.split('/').pop();
  check('the address is http://<ip>:<port>/<43-character key>', /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/.test(s.url), s.url);

  const page = await request(s.url);
  check('the page opens with the key', page.status === 200 && /Send to Lumen/.test(page.body));
  const csp = page.headers['content-security-policy'] || '';
  check('…with a strict CSP (nothing from outside, scripts only by nonce)', /default-src 'none'/.test(csp) && /script-src 'nonce-/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/unsafe/.test(csp), csp);
  check('…no-referrer, no-store, nosniff', page.headers['referrer-policy'] === 'no-referrer' && page.headers['cache-control'] === 'no-store' && page.headers['x-content-type-options'] === 'nosniff');
  check('every inline script and style carries the nonce', !/<script(?![^>]*nonce=)/.test(page.body) && !/<style(?![^>]*nonce=)/.test(page.body));
  check('the first device claims the session', events.some((e) => e.type === 'claimed' && /127\.0\.0\.1/.test(e.device)));

  const base = `http://127.0.0.1:${s.port}`;
  check('a wrong key is not found', (await request(`${base}/${'A'.repeat(43)}`)).status === 404);
  for (let i = 0; i < W.MAX_BAD_KEYS + 2; i++) await request(`${base}/${i % 2 ? 'favicon.ico' : 'apple-touch-icon-precomposed.png'}`);
  check('the browser\'s own icon requests never count as wrong keys', wifi.status().running);
  check('a Host that is not <ip>:<port> is refused (DNS rebinding)', (await request(s.url, { host: `evil.example:${s.port}` })).status === 421);
  check('an Origin from another site is refused', (await upload(s.url, Buffer.from('x'), { headers: { origin: 'http://evil.example' } })).status === 403);
  check('an upload without X-Lumen-Upload is refused (no CORS-simple POST)', (await request(`${s.url}/upload`, { method: 'POST', body: 'x', headers: { 'content-length': '1' } })).status === 403);
  check('…as is a GET to the upload address', (await request(`${s.url}/upload`)).status === 405);

  const sent = await upload(s.url, Buffer.from('JPEGDATA'), { name: '../IMG 0001.jpg', caption: 'the receipt' });
  const saved = inbox.listRecent()[0];
  check('an upload is saved in the inbox under its cleaned name', sent.status === 200 && saved?.name === 'IMG 0001.jpg' && fs.readFileSync(saved.path, 'utf8') === 'JPEGDATA', `${sent.status} ${sent.body} ${saved?.name}`);
  check('…shown in Lumen with its caption', shown.length === 1 && shown[0].c === 'the receipt' && shown[0].f.name === 'IMG 0001.jpg');
  check('…and no .part file is left', fs.readdirSync(inbox.dir).every((n) => !n.endsWith('.part')));
  await upload(s.url, Buffer.from('two'), { name: 'IMG 0001.jpg' });
  check('the same name again never overwrites', fs.existsSync(path.join(inbox.dir, 'IMG 0001 (2).jpg')) && fs.readFileSync(path.join(inbox.dir, 'IMG 0001.jpg'), 'utf8') === 'JPEGDATA');

  const second = await request(s.url, { headers: { 'x-test-device': '192.168.1.66' } });
  check('another device is refused once the session is claimed', second.status === 403 && /Taken/.test(second.body), second.status);
  check('…its upload too', (await upload(s.url, Buffer.from('x'), { headers: { 'x-test-device': '192.168.1.66' } })).status === 403);

  check('a missing Content-Length is refused', (await upload(s.url, Buffer.from('abc'), { headers: { 'content-length': undefined, 'transfer-encoding': 'chunked' } })).status === 411);
  check('a file over 2 GB is refused before any byte is read', (await request(`${s.url}/upload`, { method: 'POST', headers: { 'x-lumen-upload': '1', 'content-length': String(W.MAX_FILE_BYTES + 1) } }).catch(() => ({ status: 0 }))).status === 413);
  free = 100;
  check('an upload that would fill the disk is refused', (await upload(s.url, Buffer.from('x'))).status === 507);
  free = Infinity;

  // A cut-off upload: says 1000 bytes, sends 10, hangs up.
  await new Promise((resolve) => {
    const sock = net.connect(s.port, '127.0.0.1', () => {
      sock.write(`POST /${key}/upload HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nX-Lumen-Upload: 1\r\nX-File-Name: cut.bin\r\nContent-Length: 1000\r\n\r\n0123456789`);
      setTimeout(() => { sock.destroy(); setTimeout(resolve, 200); }, 150);
    });
  });
  check('a cut-off upload leaves no file and no .part', !fs.existsSync(path.join(inbox.dir, 'cut.bin')) && fs.readdirSync(inbox.dir).every((n) => !n.endsWith('.part')), fs.readdirSync(inbox.dir));
  check('status() counts what came', wifi.status().running && wifi.status().files === 2 && wifi.status().claimed);

  check('stop() ends the session', wifi.stop('closed') && events.at(-1).type === 'stopped' && events.at(-1).reason === 'closed' && !wifi.status().running);
  check('…and nothing answers any more', await request(s.url).then(() => false, () => true));

  // ---- wrong keys end it
  const s2 = await wifi.start();
  for (let i = 0; i < W.MAX_BAD_KEYS; i++) await request(`http://127.0.0.1:${s2.port}/${String(i).padStart(43, 'x')}`).catch(() => {});
  check(`${W.MAX_BAD_KEYS} wrong keys end the session`, !wifi.status().running && events.at(-1).reason === 'bad-keys');

  // ---- a new start replaces the old (one session at a time), and the old key no longer works
  const a = await wifi.start();
  const b = await wifi.start();
  check('a second start ends the first', events.at(-1).reason === 'replaced' && a.url !== b.url && (await request(b.url)).status === 200);
  check('…whose address no longer answers', await request(a.url).then(() => false, () => true));
  wifi.stop();

  check('the page escapes the words it is given', !W.pageHtml({ nonce: 'n', words: { ...words, title: '<img src=x onerror=alert(1)>' }, maxFile: 1 }).includes('<img src=x'));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
