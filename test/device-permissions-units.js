// Plain Node: device access for WebHID, WebUSB and Web Serial. The grant store, a device's identity, what the check and
// device handlers decide, the FIDO filter (browser/device-permissions.js), and the chooser's flow against a fake session
// and fake dialogs: cancel and choose callbacks, live list updates, requests from pages the AI controls, private windows
// that keep nothing (features/device-chooser.js).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { EventEmitter } = require('events');
const P = require('../src/browser/device-permissions');
const { createDeviceChooser } = require('../src/features/device-chooser');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const hid = (over = {}) => ({ deviceId: 'h1', name: 'AULA F75', vendorId: 0x0C45, productId: 0x8006, serialNumber: 'SN1', collections: [{ usagePage: 1, usage: 6 }], ...over });
const usb = (over = {}) => ({ deviceId: 'u1', productName: 'Flasher', vendorId: 0x2341, productId: 0x0043, ...over });
const port = (over = {}) => ({ portId: 'p1', portName: 'COM3', displayName: 'USB Serial', vendorId: '9025', productId: '67', ...over });
const key = (over = {}) => hid({ deviceId: 'k1', name: 'Security Key', vendorId: 0x1050, productId: 0x0407, serialNumber: undefined, collections: [{ usagePage: P.FIDO_USAGE_PAGE, usage: 1 }], ...over });

// ---- identity: numbers, not ids that change on every plug-in
{
  check('identity: HID uses vendor, product, serial', JSON.stringify(P.identityOf('hid', hid())) === JSON.stringify({ type: 'hid', vendorId: 0x0C45, productId: 0x8006, serialNumber: 'SN1' }), JSON.stringify(P.identityOf('hid', hid())));
  check('identity: deviceId is not part of it', P.keyOf(P.identityOf('hid', hid())) === P.keyOf(P.identityOf('hid', hid({ deviceId: 'other' }))), '');
  check('identity: a serial port reads its string ids as numbers', P.identityOf('serial', port()).vendorId === 9025 && P.identityOf('serial', port()).productId === 67, JSON.stringify(P.identityOf('serial', port())));
  check('identity: no serial number is an empty one', P.identityOf('usb', usb()).serialNumber === '', '');
  check('identity: another serial number is another device', P.keyOf(P.identityOf('hid', hid())) !== P.keyOf(P.identityOf('hid', hid({ serialNumber: 'SN2' }))), '');
  check('identity: a port without ids has none (never remembered)', P.identityOf('serial', { portId: 'x', portName: 'BT' }) === null, '');
  check('identity: nonsense is none', P.identityOf('hid', null) === null && P.identityOf('mouse', hid()) === null && P.identityOf('hid', hid({ vendorId: -1 })) === null && P.identityOf('hid', hid({ vendorId: 70000 })) === null, '');
  check('identity: the same ids on another kind of device are different', P.keyOf(P.identityOf('hid', hid())) !== P.keyOf(P.identityOf('usb', hid())), '');
}

// ---- FIDO
{
  check('fido: a HID collection on usage page 0xF1D0 is a security key', P.isFido('hid', key()), '');
  check('fido: a keyboard is not', !P.isFido('hid', hid()), '');
  check('fido: only HID is judged', !P.isFido('usb', key()), '');
  check('fido: never in the picker', P.selectable('hid', [hid(), key()]).length === 1 && P.selectable('hid', [hid(), key()])[0].deviceId === 'h1', '');
  check('fido: a device with no identity is not offered either', P.selectable('serial', [port(), { portId: 'bt', portName: 'BT' }]).length === 1, '');
  const store = P.createGrantStore();
  store.grant('https://a.test', P.identityOf('hid', key()), 'Key');
  check('fido: never allowed by the device handler, even if a grant exists', P.deviceAllowed(store, { deviceType: 'hid', origin: 'https://a.test', device: key() }) === false, '');
}

// ---- the grant store
{
  let saves = 0;
  const store = P.createGrantStore({ onChange: () => { saves++; } });
  const id = P.identityOf('hid', hid());
  check('store: nothing granted at first', !store.has('https://a.test', id) && store.size() === 0, '');
  check('store: grant', store.grant('https://a.test', id, 'AULA F75') && store.has('https://a.test', id) && saves === 1, saves);
  check('store: granting again with the same name saves nothing more', store.grant('https://a.test', id, 'AULA F75') && saves === 1, saves);
  check('store: per origin', !store.has('https://b.test', id) && !store.has('http://a.test', id) && !store.has('https://a.test:8443', id), '');
  check('store: survives the device getting a new deviceId', store.has('https://a.test', P.identityOf('hid', hid({ deviceId: 'after-replug' }))), '');
  check('store: another serial number is not granted', !store.has('https://a.test', P.identityOf('hid', hid({ serialNumber: 'SN2' }))), '');
  const json = JSON.parse(JSON.stringify(store));
  check('store: toJSON is plain rows', json.length === 1 && json[0].origin === 'https://a.test' && json[0].type === 'hid' && json[0].vendorId === 0x0C45 && json[0].serialNumber === 'SN1' && json[0].name === 'AULA F75' && !('key' in json[0]), JSON.stringify(json));
  const other = P.createGrantStore();
  other.load(json);
  check('store: load restores it', other.has('https://a.test', id) && other.size() === 1, '');
  other.load([{ origin: 'file:///x', type: 'hid', vendorId: 1, productId: 2 }, { origin: 'https://ok.test', type: 'hid', vendorId: 1 }, { origin: 'https://ok.test', type: 'bogus', vendorId: 1, productId: 2 }, null, 'x']);
  check('store: load ignores rows that are not http(s), not a device, or not an object', other.size() === 0, other.size());
  check('store: list names the key a Remove uses', store.list()[0].key === P.keyOf(id), '');
  check('store: remove by key', store.remove('https://a.test', store.list()[0].key) && !store.has('https://a.test', id) && saves === 2 && store.size() === 0, saves);
  check('store: removing what is not there changes nothing', store.remove('https://a.test', 'x') === false && saves === 2, saves);
  store.grant('https://a.test', id, 'x');
  check('store: revoke (device.forget())', store.revoke('https://a.test', id) === true && !store.has('https://a.test', id), '');
  const boom = P.createGrantStore({ onChange: () => { throw new Error('disk full'); } });
  check('store: a failed save does not undo the grant', boom.grant('https://a.test', id, 'x') === true && boom.has('https://a.test', id), '');
  store.grant('https://a.test', id, 'x'); store.grant('https://b.test', P.identityOf('usb', usb()), 'y');
  store.clear();
  check('store: clear', store.size() === 0, '');
  const full = P.createGrantStore();
  let accepted = 0;
  for (let n = 0; n < P.MAX_GRANTS + 5; n++) if (full.grant('https://a.test', { type: 'usb', vendorId: 1, productId: 1, serialNumber: `s${n}` }, '')) accepted++;
  check('store: capped', accepted === P.MAX_GRANTS && full.size() === P.MAX_GRANTS, accepted);
}

// ---- the check and device handlers' decisions
{
  check('check: an http(s) page in an ordinary tab may ask', P.checkAllowed({ permission: 'hid', origin: 'https://hero.aulastar.com/', ordinary: true }) && P.checkAllowed({ permission: 'usb', origin: 'http://127.0.0.1:8080', ordinary: true }) && P.checkAllowed({ permission: 'serial', origin: 'https://a.test', ordinary: true }), '');
  check('check: not an AI tab, agent window or research tab (the caller says so)', !P.checkAllowed({ permission: 'hid', origin: 'https://a.test', ordinary: false }), '');
  check('check: not Lumen\'s own pages or other schemes', !P.checkAllowed({ permission: 'hid', origin: 'lumen://settings', ordinary: true }) && !P.checkAllowed({ permission: 'hid', origin: 'file:///C:/x.html', ordinary: true }) && !P.checkAllowed({ permission: 'hid', origin: 'chrome-extension://abc', ordinary: true }) && !P.checkAllowed({ permission: 'hid', origin: '', ordinary: true }), '');
  check('check: only the three device permissions', !P.checkAllowed({ permission: 'geolocation', origin: 'https://a.test', ordinary: true }) && !P.checkAllowed({ permission: 'hid', origin: 'https://a.test' }), '');
  const store = P.createGrantStore();
  store.grant('https://a.test', P.identityOf('hid', hid()), 'AULA');
  const ask = (over) => P.deviceAllowed(store, { deviceType: 'hid', origin: 'https://a.test', device: hid(), ...over });
  check('device handler: the chosen device for the chosen origin', ask() === true, '');
  check('device handler: a replugged device (new deviceId) still', ask({ device: hid({ deviceId: 'zzz' }) }) === true, '');
  check('device handler: another origin, even a subdomain, is refused', ask({ origin: 'https://b.a.test' }) === false && ask({ origin: 'https://other.test' }) === false, '');
  check('device handler: another device is refused', ask({ device: hid({ productId: 1 }) }) === false && ask({ device: hid({ serialNumber: 'SN9' }) }) === false, '');
  check('device handler: another kind is refused', ask({ deviceType: 'usb' }) === false && ask({ deviceType: 'serial', device: hid() }) === false, '');
  check('device handler: bad input is refused, not thrown', ask({ device: null }) === false && ask({ origin: 'nope' }) === false && ask({ deviceType: 'x' }) === false, '');
}

// ---- describe: what the picker shows
{
  const d = P.describe('hid', hid());
  check('describe: product name, ids in hex', d.id === 'h1' && d.name === 'AULA F75' && d.detail === '0C45:8006', JSON.stringify(d));
  check('describe: an unnamed device is Unknown device', P.describe('hid', hid({ name: '  ' })).name === 'Unknown device' && P.describe('usb', usb({ productName: undefined }), 'Onbekend').name === 'Onbekend', '');
  check('describe: USB product name, serial port display name or port name', P.describe('usb', usb()).name === 'Flasher' && P.describe('serial', port()).name === 'USB Serial' && P.describe('serial', port({ displayName: '' })).name === 'COM3' && P.describe('serial', port()).id === 'p1', '');
  check('describe: serial ids are shown as hex of the number', P.describe('serial', port()).detail === '2341:0043', P.describe('serial', port()).detail);
}

// ---- the chooser's flow
const strings = { 'device.ask.hid': '{host} wants to connect to a HID device', 'device.ask.usb': '{host} wants to connect to a USB device', 'device.ask.serial': '{host} wants to connect to a serial port', 'device.none': 'No compatible devices found', 'device.unknown': 'Unknown device', 'device.connect': 'Connect', 'dialog.cancel': 'Cancel' };
const t = (k, v) => String(strings[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => v?.[n] ?? '');

function rig({ ordinary = () => true } = {}) {
  const r = { shown: [], updates: [], ses: new EventEmitter(), handlers: {} };
  r.ses.setDevicePermissionHandler = (fn) => { r.handlers.device = fn; };
  r.ses.setUSBProtectedClassesHandler = (fn) => { r.handlers.usbClasses = fn; };
  r.dialogs = {
    chooseDevice: (opts) => {
      const shown = { opts, items: opts.items, cancelled: false };
      shown.done = new Promise((resolve) => { shown.resolve = resolve; });
      shown.choose = (id) => shown.resolve({ choice: id });
      shown.cancel = () => shown.resolve({ choice: '' });
      r.shown.push(shown);
      return { done: shown.done, update: (items) => { shown.items = items; r.updates.push(items); }, cancel: shown.cancel };
    },
  };
  r.chooser = createDeviceChooser({ dialogs: r.dialogs, t, ordinary, webContentsFromFrame: (frame) => frame.wc });
  r.store = P.createGrantStore();
  r.api = r.chooser.install(r.ses, { store: r.store });
  r.wc = { isDestroyed: () => false, getURL: () => 'https://hero.aulastar.com/' };
  r.frame = { wc: r.wc, origin: 'https://hero.aulastar.com', url: 'https://hero.aulastar.com/' };
  return r;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const prevented = () => { const e = { prevented: false, preventDefault() { e.prevented = true; } }; return e; };

(async () => {
  // choosing
  {
    const r = rig();
    const e = prevented();
    const calls = [];
    r.ses.emit('select-hid-device', e, { deviceList: [hid(), key({ deviceId: 'k1' }), hid({ deviceId: 'h2', name: '', serialNumber: 'SN2' })], frame: r.frame }, (...a) => calls.push(a));
    check('choose: the event is taken over', e.prevented, '');
    check('choose: one chooser, naming the site and the kind', r.shown.length === 1 && r.shown[0].opts.message === 'hero.aulastar.com wants to connect to a HID device' && r.shown[0].opts.buttons.join('|') === 'Cancel|Connect', JSON.stringify(r.shown[0]?.opts));
    check('choose: it is tied to the asking tab', r.shown[0].opts.owner === r.wc, '');
    check('choose: security keys are not in it; an unnamed device is Unknown device', r.shown[0].items.length === 2 && r.shown[0].items[1].name === 'Unknown device' && r.shown[0].items[0].detail === '0C45:8006', JSON.stringify(r.shown[0].items));
    check('choose: the empty text is the localized one', r.shown[0].opts.emptyText === 'No compatible devices found', '');
    check('choose: nothing is answered while it is open', calls.length === 0 && r.api.pending() === 1, calls.length);
    r.shown[0].choose('h2');
    await tick();
    check('choose: the callback gets that deviceId', calls.length === 1 && calls[0].length === 1 && calls[0][0] === 'h2', JSON.stringify(calls));
    check('choose: the device is remembered for the origin, by identity', P.deviceAllowed(r.store, { deviceType: 'hid', origin: 'https://hero.aulastar.com', device: hid({ deviceId: 'new', name: '', serialNumber: 'SN2' }) }) && !P.deviceAllowed(r.store, { deviceType: 'hid', origin: 'https://hero.aulastar.com', device: hid() }), JSON.stringify(r.store.list()));
    check('choose: nothing left pending', r.api.pending() === 0, '');
  }
  // cancelling
  {
    const r = rig();
    const calls = [];
    r.ses.emit('select-hid-device', prevented(), { deviceList: [hid()], frame: r.frame }, (...a) => calls.push(a));
    r.shown[0].cancel();
    await tick();
    check('cancel: the callback is called with no arguments', calls.length === 1 && calls[0].length === 0, JSON.stringify(calls));
    check('cancel: nothing is granted', r.store.size() === 0, '');
  }
  // a choice that is not on offer
  {
    const r = rig();
    const calls = [];
    r.ses.emit('select-hid-device', prevented(), { deviceList: [hid(), key()], frame: r.frame }, (...a) => calls.push(a));
    r.shown[0].choose('k1'); // the security key was never offered
    await tick();
    check('fido: choosing a security key anyway cancels and grants nothing', calls.length === 1 && calls[0].length === 0 && r.store.size() === 0, JSON.stringify(calls));
  }
  {
    const r = rig();
    const calls = [];
    r.ses.emit('select-hid-device', prevented(), { deviceList: [hid()], frame: r.frame }, (...a) => calls.push(a));
    r.shown[0].choose('nope');
    await tick();
    check('choose: an id that is not in the list cancels', calls.length === 1 && calls[0].length === 0 && r.store.size() === 0, '');
  }
  // live updates
  {
    const r = rig();
    const calls = [];
    r.ses.emit('select-hid-device', prevented(), { deviceList: [], frame: r.frame }, (...a) => calls.push(a));
    check('live: an empty list is still shown (the empty state)', r.shown.length === 1 && r.shown[0].items.length === 0, '');
    r.ses.emit('hid-device-added', prevented(), { device: hid(), frame: r.frame });
    check('live: a device plugged in appears', r.shown[0].items.length === 1 && r.shown[0].items[0].name === 'AULA F75', JSON.stringify(r.shown[0].items));
    r.ses.emit('hid-device-added', prevented(), { device: key(), frame: r.frame });
    check('live: a security key plugged in does not', r.shown[0].items.length === 1, '');
    r.ses.emit('hid-device-removed', prevented(), { device: hid(), frame: r.frame });
    check('live: a device unplugged goes', r.shown[0].items.length === 0, '');
    r.ses.emit('hid-device-added', prevented(), { device: hid({ deviceId: 'h9' }), frame: r.frame });
    r.shown[0].choose('h9');
    await tick();
    check('live: a device that arrived while it was open can be chosen', calls.length === 1 && calls[0][0] === 'h9', JSON.stringify(calls));
    const before = r.updates.length;
    r.ses.emit('hid-device-added', prevented(), { device: hid(), frame: r.frame });
    check('live: after it closed, events change nothing', r.updates.length === before, r.updates.length);
  }
  // USB and serial
  {
    const r = rig();
    const calls = [];
    r.ses.emit('select-usb-device', prevented(), { deviceList: [usb()], frame: r.frame }, (...a) => calls.push(a));
    check('usb: the wording', r.shown[0].opts.message === 'hero.aulastar.com wants to connect to a USB device' && r.shown[0].items[0].name === 'Flasher', r.shown[0]?.opts.message);
    r.ses.emit('usb-device-added', prevented(), usb({ deviceId: 'u2', productName: 'Second' }), r.wc);
    r.ses.emit('usb-device-removed', prevented(), usb(), r.wc);
    check('usb: added and removed update the list', r.shown[0].items.length === 1 && r.shown[0].items[0].id === 'u2', JSON.stringify(r.shown[0].items));
    r.shown[0].choose('u2');
    await tick();
    check('usb: the choice goes back', calls[0]?.[0] === 'u2' && P.deviceAllowed(r.store, { deviceType: 'usb', origin: 'https://hero.aulastar.com', device: usb({ deviceId: 'x', productName: 'Second' }) }), JSON.stringify(calls));
    r.ses.emit('select-serial-port', prevented(), [port(), port({ portId: 'p2', displayName: 'Other' })], r.wc, (...a) => calls.push(a));
    check('serial: the wording, from the tab\'s own frame', r.shown[1].opts.message === 'hero.aulastar.com wants to connect to a serial port' && r.shown[1].items.length === 2, r.shown[1]?.opts.message);
    r.ses.emit('serial-port-added', prevented(), port({ portId: 'p3', portName: 'COM9', displayName: '' }), r.wc);
    r.ses.emit('serial-port-removed', prevented(), port({ portId: 'p2' }), r.wc);
    check('serial: added and removed update the list', r.shown[1].items.map((i) => i.id).join() === 'p1,p3', JSON.stringify(r.shown[1].items));
    r.shown[1].choose('p3');
    await tick();
    check('serial: the choice goes back as the portId', calls[1]?.[0] === 'p3', JSON.stringify(calls));
  }
  // requests the user must never be asked about
  {
    const calls = [];
    const r = rig({ ordinary: () => false }); // an AI tab, an agent window, a music card
    const e = prevented();
    r.ses.emit('select-hid-device', e, { deviceList: [hid()], frame: r.frame }, (...a) => calls.push(a));
    check('ai: a request from a page the AI controls is cancelled without a chooser', e.prevented && r.shown.length === 0 && calls.length === 1 && calls[0].length === 0, JSON.stringify(calls));
    r.ses.emit('select-usb-device', prevented(), { deviceList: [usb()], frame: r.frame }, (...a) => calls.push(a));
    r.ses.emit('select-serial-port', prevented(), [port()], r.wc, (...a) => calls.push(a));
    check('ai: the same for USB and serial', r.shown.length === 0 && calls.length === 3 && calls.every((a) => a.length === 0), '');
    check('ai: and the permission check says no', r.chooser.check(r.wc, 'hid', 'https://hero.aulastar.com/', {}) === false, '');
  }
  {
    const r = rig();
    const calls = [];
    r.ses.emit('select-hid-device', prevented(), { deviceList: [hid()], frame: null }, (...a) => calls.push(a));
    r.ses.emit('select-hid-device', prevented(), { deviceList: [hid()], frame: { wc: { isDestroyed: () => true, getURL: () => 'https://a.test/' }, origin: 'https://a.test' } }, (...a) => calls.push(a));
    r.ses.emit('select-hid-device', prevented(), { deviceList: [hid()], frame: { wc: r.wc, origin: 'lumen://settings', url: '' } }, (...a) => calls.push(a));
    check('no tab, a closed tab, or a page that is not http(s): cancelled, no chooser', r.shown.length === 0 && calls.length === 3 && calls.every((a) => a.length === 0), JSON.stringify(calls));
    const throwing = { wc: r.wc, get origin() { throw new Error('frame gone'); }, get url() { throw new Error('frame gone'); } };
    r.ses.emit('select-hid-device', prevented(), { deviceList: [hid()], frame: throwing }, (...a) => calls.push(a));
    check('a frame that navigated away does not throw (falls back to the tab\'s address)', r.shown.length === 1, r.shown.length);
  }
  // the check handler
  {
    const r = rig();
    check('check: ordinary tab, https origin with the trailing slash Electron gives', r.chooser.check(r.wc, 'hid', 'https://hero.aulastar.com/', {}) === true && r.chooser.check(r.wc, 'usb', 'https://a.test/', {}) && r.chooser.check(r.wc, 'serial', 'https://a.test/', {}), '');
    check('check: Electron gives no contents for these checks: the origin decides (the chooser refuses AI tabs)', r.chooser.check(null, 'hid', 'https://a.test/', {}) === true && r.chooser.check(null, 'hid', 'lumen://settings/', {}) === false && r.chooser.check(null, 'hid', '', {}) === false, '');
    check('check: Lumen\'s pages are no', r.chooser.check(r.wc, 'hid', 'lumen://settings/', {}) === false, '');
    check('check: falls back to details.requestingUrl', r.chooser.check(r.wc, 'hid', '', { requestingUrl: 'https://a.test/page' }) === true, '');
  }
  // revoked: device.forget()
  {
    const r = rig();
    r.store.grant('https://hero.aulastar.com', P.identityOf('hid', hid()), 'AULA');
    r.store.grant('https://other.test', P.identityOf('hid', hid()), 'AULA');
    r.ses.emit('hid-device-revoked', prevented(), { device: hid({ deviceId: 'whatever' }), origin: 'https://hero.aulastar.com' });
    check('revoked: forget() removes that origin\'s grant only', !r.store.has('https://hero.aulastar.com', P.identityOf('hid', hid())) && r.store.has('https://other.test', P.identityOf('hid', hid())), '');
    r.store.grant('https://hero.aulastar.com', P.identityOf('usb', usb()), 'x');
    r.ses.emit('usb-device-revoked', prevented(), { device: usb(), origin: 'https://hero.aulastar.com' });
    r.store.grant('https://hero.aulastar.com', P.identityOf('serial', port()), 'x');
    r.ses.emit('serial-port-revoked', prevented(), { port: port(), origin: 'https://hero.aulastar.com' });
    check('revoked: USB and serial too', r.store.size() === 1, r.store.size());
    r.ses.emit('hid-device-revoked', prevented(), { device: hid(), origin: undefined });
    check('revoked: an event without an origin is ignored', r.store.size() === 1, '');
  }
  // the handlers on the session
  {
    const r = rig();
    r.store.grant('https://a.test', P.identityOf('hid', hid()), 'x');
    check('session: the device handler answers from the store', r.handlers.device({ deviceType: 'hid', origin: 'https://a.test', device: hid() }) === true && r.handlers.device({ deviceType: 'hid', origin: 'https://b.test', device: hid() }) === false, '');
    check('session: the USB protected classes are Chromium\'s own list', JSON.stringify(r.handlers.usbClasses({ protectedClasses: ['audio', 'hid', 'mass-storage'] })) === JSON.stringify(['audio', 'hid', 'mass-storage']), '');
  }
  // private windows keep nothing: their own store, never the profile's
  {
    let saved = 0;
    const profile = P.createGrantStore({ onChange: () => { saved++; } });
    const priv = P.createGrantStore(); // what private-window.js passes: no onChange
    const ses = new EventEmitter();
    const handlers = {};
    ses.setDevicePermissionHandler = (fn) => { handlers.device = fn; };
    ses.setUSBProtectedClassesHandler = () => {};
    const shown = [];
    const dialogs = { chooseDevice: (opts) => { let resolve; const done = new Promise((r) => { resolve = r; }); shown.push({ opts, choose: (id) => resolve({ choice: id }) }); return { done, update() {}, cancel() {} }; } };
    const chooser = createDeviceChooser({ dialogs, t, ordinary: () => true, webContentsFromFrame: (f) => f.wc });
    const win = { id: 'private window' };
    chooser.install(ses, { store: priv, windowOf: () => win });
    const wc = { isDestroyed: () => false, getURL: () => 'https://a.test/' };
    ses.emit('select-hid-device', prevented(), { deviceList: [hid()], frame: { wc, origin: 'https://a.test' } }, () => {});
    check('private: the chooser is drawn in the private window', shown[0].opts.window === win, '');
    shown[0].choose('h1');
    await tick();
    check('private: the grant is in memory, and the profile\'s store and settings are untouched', priv.size() === 1 && profile.size() === 0 && saved === 0 && handlers.device({ deviceType: 'hid', origin: 'https://a.test', device: hid() }) === true, '');
    const nextWindow = P.createGrantStore();
    check('private: the next private window starts empty', nextWindow.size() === 0 && !nextWindow.has('https://a.test', P.identityOf('hid', hid())), '');
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall device permission checks passed');
  process.exit(failures ? 1 : 0);
})();
