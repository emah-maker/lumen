// Device access for WebHID, WebUSB and Web Serial: what a site may be handed, and which devices the user chose for it.
// Everything here is a plain function of its inputs (test/device-permissions-units.js runs it in plain Node);
// features/device-chooser.js wires it to the session and draws the picker.
//
// Identity: Electron's deviceId / portId change every time a device is plugged in, so a grant is remembered by what
// the device is: type + vendorId + productId + serialNumber (when it has one), per origin. A serial port reports its
// ids as strings; they are read as numbers here. A device without a serial number is matched by vendor and product.
//
// Blocklist: WebHID refuses security keys (FIDO, usage page 0xF1D0) in Chrome too, and Lumen never offers or grants
// one: a page could otherwise talk to the key directly. (USB's protected classes stay as Chromium has them:
// features/device-chooser.js leaves setUSBProtectedClassesHandler alone.)

const TYPES = ['hid', 'usb', 'serial'];
const FIDO_USAGE_PAGE = 0xF1D0;
const MAX_GRANTS = 500;

const isType = (type) => TYPES.includes(type);

// The id as a number (WebHID and WebUSB give numbers, Web Serial gives a decimal string), or null.
function numericId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 0xFFFF ? value : null;
  if (typeof value === 'string' && /^\d{1,5}$/.test(value.trim())) { const n = Number(value); return n <= 0xFFFF ? n : null; }
  return null;
}

// { type, vendorId, productId, serialNumber } for a device or serial port, or null when it can't be told apart
// (no vendor and product id: a Bluetooth serial port, say).
function identityOf(type, device) {
  if (!isType(type) || !device || typeof device !== 'object') return null;
  const vendorId = numericId(device.vendorId);
  const productId = numericId(device.productId);
  if (vendorId === null || productId === null) return null;
  const serial = typeof device.serialNumber === 'string' ? device.serialNumber.trim().slice(0, 128) : '';
  return { type, vendorId, productId, serialNumber: serial };
}

const keyOf = (identity) => `${identity.type}:${identity.vendorId}:${identity.productId}:${identity.serialNumber}`;

// A security key: any HID collection on the FIDO usage page. Never offered, never granted.
function isFido(type, device) {
  if (type !== 'hid' || !device) return false;
  return Array.isArray(device.collections) && device.collections.some((c) => c && Number(c.usagePage) === FIDO_USAGE_PAGE);
}

// The http(s) origin of the first candidate that has one (browser/site-permissions.js canonicalOrigin, repeated here
// so this file stands alone in tests).
function originOf(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch { /* the next one */ }
  }
  return '';
}

// ---- what a page may ask for ----

// The permission check ('hid' | 'usb' | 'serial'): true only for an http(s) page in an ordinary tab. `ordinary` is
// the caller's answer for the asking contents: false for an AI-opened tab, an agent window, a research tab, a music
// card, Lumen's own pages. (Chromium itself requires a user gesture for requestDevice.)
function checkAllowed({ permission, origin, ordinary }) {
  if (!isType(permission)) return false;
  return Boolean(originOf(origin)) && ordinary === true;
}

// The device permission check: true only for a device the user chose for this origin, and never a security key.
function deviceAllowed(store, { deviceType, origin, device }) {
  if (!isType(deviceType) || isFido(deviceType, device)) return false;
  const identity = identityOf(deviceType, device);
  const site = originOf(origin);
  return Boolean(identity && site && store.has(site, identity));
}

// The devices the picker lists: security keys (and anything with no identity to remember) left out.
function selectable(type, list) {
  return (Array.isArray(list) ? list : []).filter((d) => d && !isFido(type, d) && identityOf(type, d));
}

const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');

// One picker row: { id, name, detail } ('0C45:8006' small and muted; the name is localized by the caller's `unknown`).
function describe(type, device, unknown = 'Unknown device') {
  const identity = identityOf(type, device);
  const raw = type === 'usb' ? device.productName : type === 'serial' ? (device.displayName || device.portName) : device.name;
  const name = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 120) : unknown;
  const id = type === 'serial' ? device.portId : device.deviceId;
  return { id: String(id ?? ''), name, detail: identity ? `${hex(identity.vendorId)}:${hex(identity.productId)}` : '' };
}

// ---- grants ----

// origin -> identity key -> { type, vendorId, productId, serialNumber, name }. `onChange(store)` runs after every
// change (the normal profile writes settings.json; a private window passes nothing, so nothing is written).
function createGrantStore({ onChange } = {}) {
  const sites = new Map();
  const changed = () => { try { onChange?.(store); } catch { /* a failed save is not a failed grant */ } };
  const store = {
    has(origin, identity) { return Boolean(identity) && Boolean(sites.get(origin)?.has(keyOf(identity))); },
    grant(origin, identity, name = '') {
      if (!origin || !identity) return false;
      if (!sites.has(origin)) sites.set(origin, new Map());
      const grants = sites.get(origin);
      const key = keyOf(identity);
      if (!grants.has(key) && store.size() >= MAX_GRANTS) return false;
      const label = typeof name === 'string' ? name.slice(0, 120) : '';
      const old = grants.get(key);
      if (old && old.name === label) return true;
      grants.set(key, { type: identity.type, vendorId: identity.vendorId, productId: identity.productId, serialNumber: identity.serialNumber, name: label });
      changed();
      return true;
    },
    // The page called device.forget(), or the user pressed Remove.
    revoke(origin, identity) { return identity ? store.remove(origin, keyOf(identity)) : false; },
    remove(origin, key) {
      const grants = sites.get(origin);
      if (!grants || !grants.delete(String(key))) return false;
      if (!grants.size) sites.delete(origin);
      changed();
      return true;
    },
    size() { let n = 0; for (const grants of sites.values()) n += grants.size; return n; },
    clear() { if (!sites.size) return; sites.clear(); changed(); },
    // [{ origin, key, type, vendorId, productId, serialNumber, name }], origins and devices in a stable order.
    list() {
      const out = [];
      for (const [origin, grants] of [...sites].sort((a, b) => a[0].localeCompare(b[0]))) {
        for (const [key, g] of grants) out.push({ origin, key, ...g });
      }
      return out;
    },
    // The settings.json form: a plain array.
    toJSON() { return store.list().map(({ origin, type, vendorId, productId, serialNumber, name }) => ({ origin, type, vendorId, productId, serialNumber, name })); },
    load(rows) {
      sites.clear();
      for (const row of Array.isArray(rows) ? rows : []) {
        const site = originOf(row?.origin);
        const identity = identityOf(row?.type, row);
        if (site && identity && store.size() < MAX_GRANTS) {
          if (!sites.has(site)) sites.set(site, new Map());
          sites.get(site).set(keyOf(identity), { type: identity.type, vendorId: identity.vendorId, productId: identity.productId, serialNumber: identity.serialNumber, name: typeof row.name === 'string' ? row.name.slice(0, 120) : '' });
        }
      }
    },
  };
  return store;
}

module.exports = { TYPES, FIDO_USAGE_PAGE, MAX_GRANTS, numericId, identityOf, keyOf, isFido, originOf, checkAllowed, deviceAllowed, selectable, describe, createGrantStore };
