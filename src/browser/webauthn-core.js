// The checks and conversions of Lumen's WebAuthn (passkeys, Windows Hello, security keys) that need no Electron and
// no Windows: pure, and covered by test/webauthn-core-units.js.
//
//   checkOrigin / checkRpId   who may ask for which relying party (the security boundary; features/passkeys.js
//                             feeds them the frame's real origin, never one a page reports)
//   clientDataJSON            the CollectedClientData the authenticator signs over (built here, not by the page)
//   toWindowsCreate / Get     the page's options (already turned into JSON-safe base64url by the page script) ->
//                             the request features/webauthn-windows.js hands to webauthn.dll
//   createResult / getResult  Windows' answer -> what the page script turns back into a PublicKeyCredential
//   domErrorFor               an HRESULT -> the DOMException name the spec gives a page
//
// Nothing here logs: challenges, credential ids, user handles and attestation blobs pass through untouched.
'use strict';

const crypto = require('crypto');
const url = require('url');

// ---- base64url
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function fromB64u(s, { max = 1 << 20 } = {}) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > Math.ceil(max * 4 / 3) + 4) throw typeError('Invalid binary data');
  return Buffer.from(s, 'base64url');
}

class WebAuthnError extends Error {
  constructor(name, message) { super(message); this.name = name; }
}
const err = (name, message) => new WebAuthnError(name, message);
const typeError = (message) => err('TypeError', message);
const security = (message) => err('SecurityError', message);
const notSupported = (message) => err('NotSupportedError', message);

// ---- who may ask
const isIp = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[.*\]$/.test(host);
const isLocalhost = (host) => host === 'localhost' || host.endsWith('.localhost');

// `origin`: the serialized origin of the frame that asked (WebFrameMain.origin). Only https, or http on localhost
// (a secure context, as Chrome treats it), and never an IP address: a relying party is a domain.
function checkOrigin(origin) {
  if (typeof origin !== 'string' || !origin || origin === 'null') throw security('This page has no origin.');
  let u;
  try { u = new URL(origin); } catch { throw security('This page has no valid origin.'); }
  if (u.origin !== origin && `${u.origin}` !== origin.replace(/\/$/, '')) throw security('This page has no valid origin.');
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:') { /* secure */ } else if (u.protocol === 'http:' && isLocalhost(host)) { /* localhost is a secure context */ } else throw security('Passkeys need a secure (https) page.');
  if (!host || isIp(host)) throw security('Passkeys are not available on an IP address.');
  return { origin: u.origin, host, scheme: u.protocol.slice(0, -1) };
}

// The relying party id a page may use: its own host or a registrable-domain suffix of it, never a public suffix
// (com, co.uk, github.io), never an IP. `publicSuffixOf(host)` -> { domain, publicSuffix } (tldts parse with private
// domains: github.io counts as a public suffix, so one GitHub Pages site can't claim passkeys for all of them).
function checkRpId(rpIdIn, host, parse) {
  let rpId = rpIdIn == null ? host : String(rpIdIn);
  if (rpId !== rpId.trim() || !rpId || rpId.length > 253) throw security('The relying party ID is not a valid domain.');
  rpId = url.domainToASCII(rpId.toLowerCase());
  if (!rpId || /[^a-z0-9.-]/.test(rpId) || rpId.startsWith('.') || rpId.endsWith('.') || rpId.includes('..')) throw security('The relying party ID is not a valid domain.');
  if (isIp(rpId)) throw security('The relying party ID is not a valid domain.');
  if (rpId !== host && !host.endsWith(`.${rpId}`)) throw security('The relying party ID is not a registrable domain suffix of, nor equal to the current domain.');
  if (rpId === 'localhost') { if (host === 'localhost') return rpId; throw security('The relying party ID is not a registrable domain suffix of, nor equal to the current domain.'); }
  const info = parse(rpId) || {};
  if (!info.domain || info.publicSuffix === rpId) throw security('The relying party ID is a public suffix.');
  return rpId;
}

// FIDO AppID (the appid extension, for credentials registered with U2F): an https URL on the same site.
function checkAppId(appid, origin, host, parse) {
  if (typeof appid !== 'string' || !appid) return null;
  let u;
  try { u = new URL(appid); } catch { throw security('The appid is not a valid URL.'); }
  if (u.protocol !== 'https:' || isIp(u.hostname)) throw security('The appid must be an https URL.');
  const site = (h) => (parse(h) || {}).domain || null;
  const mine = site(host);
  if (!mine || site(u.hostname.toLowerCase()) !== mine) throw security('The appid is not on this site.');
  return u.href;
}

// The frame chain: is it cross-origin from any ancestor (CollectedClientData.crossOrigin), and the top's origin.
function frameContext(frames) {
  // frames: [own, parent, ..., top] origins
  const own = frames[0];
  const top = frames[frames.length - 1];
  const crossOrigin = frames.some((o) => o !== own);
  return { crossOrigin, topOrigin: top };
}

// ---- CollectedClientData (https://w3c.github.io/webauthn/#dictdef-collectedclientdata), in the member order the
// spec's serialization uses, so relying parties that use the limited verification algorithm accept it.
function clientDataJSON({ type, challenge, origin, crossOrigin, topOrigin }) {
  if (type !== 'webauthn.create' && type !== 'webauthn.get') throw new Error('bad clientData type');
  let out = `{"type":${JSON.stringify(type)},"challenge":${JSON.stringify(b64u(challenge))},"origin":${JSON.stringify(origin)},"crossOrigin":${crossOrigin ? 'true' : 'false'}`;
  if (crossOrigin && topOrigin) out += `,"topOrigin":${JSON.stringify(topOrigin)}`;
  return Buffer.from(`${out}}`, 'utf8');
}

// ---- options -> Windows
const TRANSPORTS = { usb: 0x1, nfc: 0x2, ble: 0x4, internal: 0x10, hybrid: 0x20, 'smart-card': 0x40 };
const transportMask = (list) => (Array.isArray(list) ? list.reduce((m, t) => m | (TRANSPORTS[t] || 0), 0) : 0);
const transportNames = (mask) => Object.keys(TRANSPORTS).filter((k) => mask & TRANSPORTS[k]).sort();
const ATTACHMENT = { platform: 1, 'cross-platform': 2 };
const UV = { required: 1, preferred: 2, discouraged: 3 };
const ATTESTATION = { none: 1, indirect: 2, direct: 3, enterprise: 3 }; // enterprise: no enterprise attestation (no policy lists any site)
const HINTS = new Set(['security-key', 'client-device', 'hybrid']);
const CRED_PROTECT = { userVerificationOptional: 1, userVerificationOptionalWithCredentialIDList: 2, userVerificationRequired: 3 };
const DEFAULT_TIMEOUT = 300000;
function timeoutOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT;
  return Math.round(Math.min(600000, Math.max(15000, n)));
}
const str = (v, max = 512) => (typeof v === 'string' ? v.slice(0, max) : '');
const bytes = (v, max) => fromB64u(v, { max });
function credList(list, limit = 64) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw typeError('Invalid credential list');
  return list.filter((c) => c && c.type === 'public-key').slice(0, limit).map((c) => {
    const id = bytes(c.id, 1023);
    if (!id.length) throw typeError('A credential id is empty');
    return { id, transports: transportMask(c.transports) };
  });
}
function prfValues(v) {
  if (!v || typeof v !== 'object' || typeof v.first !== 'string') throw typeError('Invalid prf values');
  return { first: bytes(v.first, 1024), second: typeof v.second === 'string' ? bytes(v.second, 1024) : null };
}

// `o`: PublicKeyCredentialCreationOptions with every BufferSource as base64url (the page script's toJSON-like form).
// `ctx`: { rpId (checked), inPrivate, api (versions from webauthn-windows), origin }
function toWindowsCreate(o, ctx) {
  if (!o || typeof o !== 'object') throw typeError('publicKey options are required');
  if (!o.rp || typeof o.rp !== 'object') throw typeError("Required member 'rp' is missing");
  if (!o.user || typeof o.user !== 'object') throw typeError("Required member 'user' is missing");
  if (typeof o.challenge !== 'string') throw typeError("Required member 'challenge' is missing");
  if (!Array.isArray(o.pubKeyCredParams)) throw typeError("Required member 'pubKeyCredParams' is missing");
  const challenge = bytes(o.challenge, 4096);
  const userId = bytes(o.user.id, 64);
  if (userId.length < 1 || userId.length > 64) throw typeError('user.id must be between 1 and 64 bytes');
  if (typeof o.user.name !== 'string' || typeof o.user.displayName !== 'string') throw typeError("Required member 'user.name' or 'user.displayName' is missing");
  let algorithms = o.pubKeyCredParams.filter((p) => p && p.type === 'public-key' && Number.isInteger(p.alg) && p.alg >= -2147483648 && p.alg <= 2147483647).map((p) => p.alg);
  if (!o.pubKeyCredParams.length) algorithms = [-7, -257];
  else if (!algorithms.length) throw notSupported('None of the requested algorithms is supported.');
  algorithms = [...new Set(algorithms)].slice(0, 16);
  const sel = o.authenticatorSelection && typeof o.authenticatorSelection === 'object' ? o.authenticatorSelection : {};
  const rk = sel.residentKey in { required: 1, preferred: 1, discouraged: 1 } ? sel.residentKey : (sel.requireResidentKey === true ? 'required' : 'discouraged');
  const ext = o.extensions && typeof o.extensions === 'object' ? o.extensions : {};
  const extensions = {};
  if (ext.hmacCreateSecret === true) extensions.hmacSecret = true;
  if (typeof ext.credentialProtectionPolicy === 'string' && CRED_PROTECT[ext.credentialProtectionPolicy]) extensions.credProtect = { policy: CRED_PROTECT[ext.credentialProtectionPolicy], enforce: ext.enforceCredentialProtectionPolicy === true };
  let prf = false;
  let prfEval = null;
  if (ext.prf && typeof ext.prf === 'object') {
    if (ext.prf.evalByCredential && Object.keys(ext.prf.evalByCredential).length) throw notSupported('prf evalByCredential is not allowed when creating a credential.');
    prf = true;
    if (ext.prf.eval) prfEval = prfValues(ext.prf.eval);
  }
  let largeBlob = 0;
  const lb = ext.largeBlob && typeof ext.largeBlob === 'object' ? ext.largeBlob : null;
  if (lb) {
    if (lb.read !== undefined || lb.write !== undefined) throw notSupported('largeBlob read and write are not allowed when creating a credential.');
    // Windows refuses a large blob without a required discoverable credential (NTE_INVALID_PARAMETER): ask only then.
    if (rk === 'required') largeBlob = lb.support === 'required' ? 1 : 2;
  }
  return {
    rp: { id: ctx.rpId, name: str(o.rp.name, 256) || ctx.rpId },
    user: { id: userId, name: str(o.user.name, 256), displayName: str(o.user.displayName, 256) },
    algorithms,
    challenge,
    timeout: timeoutOf(o.timeout),
    excludeCredentials: credList(o.excludeCredentials),
    attachment: ATTACHMENT[sel.authenticatorAttachment] || 0,
    requireResidentKey: rk === 'required',
    preferResidentKey: rk === 'preferred',
    userVerification: UV[sel.userVerification] || UV.preferred,
    attestation: ATTESTATION[o.attestation] || ATTESTATION.none,
    hints: Array.isArray(o.hints) ? o.hints.filter((h) => HINTS.has(h)).slice(0, 3) : [],
    extensions,
    prf,
    prfEval,
    largeBlob,
    inPrivate: Boolean(ctx.inPrivate),
    wants: { credProps: ext.credProps === true, hmacCreateSecret: ext.hmacCreateSecret === true, prf, largeBlob: Boolean(lb), credProtect: Boolean(extensions.credProtect) },
  };
}

function toWindowsGet(o, ctx) {
  if (!o || typeof o !== 'object') throw typeError('publicKey options are required');
  if (typeof o.challenge !== 'string') throw typeError("Required member 'challenge' is missing");
  const challenge = bytes(o.challenge, 4096);
  const allowCredentials = credList(o.allowCredentials);
  const ext = o.extensions && typeof o.extensions === 'object' ? o.extensions : {};
  let prf = null;
  if (ext.prf && typeof ext.prf === 'object') {
    const byCredential = [];
    const evalBy = ext.prf.evalByCredential && typeof ext.prf.evalByCredential === 'object' ? ext.prf.evalByCredential : {};
    const keys = Object.keys(evalBy);
    if (keys.length && !allowCredentials.length) throw notSupported('prf evalByCredential needs allowCredentials.');
    for (const key of keys.slice(0, 64)) {
      let id;
      try { id = fromB64u(key, { max: 1023 }); } catch { throw err('SyntaxError', 'A prf evalByCredential key is not base64url.'); }
      if (!id.length || !allowCredentials.some((c) => c.id.equals(id))) throw err('SyntaxError', 'A prf evalByCredential key is not in allowCredentials.');
      byCredential.push({ id, values: prfValues(evalBy[key]) });
    }
    prf = { global: ext.prf.eval ? prfValues(ext.prf.eval) : null, byCredential };
  }
  let largeBlob = null;
  const lb = ext.largeBlob && typeof ext.largeBlob === 'object' ? ext.largeBlob : null;
  if (lb) {
    if (lb.support !== undefined) throw notSupported('largeBlob support is only for creating a credential.');
    if (lb.read === true && lb.write !== undefined) throw notSupported('largeBlob read and write together are not allowed.');
    if (lb.read === true) largeBlob = { operation: 1, blob: null };
    else if (typeof lb.write === 'string') {
      if (allowCredentials.length !== 1) throw notSupported('largeBlob write needs exactly one allowed credential.');
      largeBlob = { operation: 2, blob: bytes(lb.write, 1 << 16) };
    }
  }
  const appid = ctx.appid || null;
  return {
    rpId: ctx.rpId,
    challenge,
    timeout: timeoutOf(o.timeout),
    allowCredentials,
    attachment: 0,
    userVerification: UV[o.userVerification] || UV.preferred,
    hints: Array.isArray(o.hints) ? o.hints.filter((h) => HINTS.has(h)).slice(0, 3) : [],
    appid,
    prf,
    largeBlob,
    inPrivate: Boolean(ctx.inPrivate),
    wants: { appid: Boolean(appid), prf: Boolean(prf), largeBlob: largeBlob ? largeBlob.operation : 0 },
  };
}

// ---- authenticator data -> the public key (AuthenticatorAttestationResponse.getPublicKey(), as SPKI DER)
// A minimal CBOR reader: just enough for the COSE_Key map inside attested credential data.
function cborRead(buf, pos = 0, depth = 0) {
  if (depth > 8) throw new Error('cbor too deep');
  const ib = buf[pos++];
  const major = ib >> 5;
  const info = ib & 31;
  let val;
  if (info < 24) val = info;
  else if (info === 24) { val = buf[pos]; pos += 1; } else if (info === 25) { val = buf.readUInt16BE(pos); pos += 2; } else if (info === 26) { val = buf.readUInt32BE(pos); pos += 4; } else if (info === 27) { val = Number(buf.readBigUInt64BE(pos)); pos += 8; } else throw new Error('cbor: indefinite length not supported');
  switch (major) {
    case 0: return [val, pos];
    case 1: return [-1 - val, pos];
    case 2: { if (pos + val > buf.length) throw new Error('cbor: short'); return [buf.subarray(pos, pos + val), pos + val]; }
    case 3: { if (pos + val > buf.length) throw new Error('cbor: short'); return [buf.toString('utf8', pos, pos + val), pos + val]; }
    case 4: { const a = []; for (let i = 0; i < val; i++) { let v; [v, pos] = cborRead(buf, pos, depth + 1); a.push(v); } return [a, pos]; }
    case 5: { const m = new Map(); for (let i = 0; i < val; i++) { let k; let v; [k, pos] = cborRead(buf, pos, depth + 1); [v, pos] = cborRead(buf, pos, depth + 1); m.set(k, v); } return [m, pos]; }
    case 7: return [info === 20 ? false : info === 21 ? true : null, pos];
    default: throw new Error('cbor: unsupported type');
  }
}
// authenticatorData: rpIdHash(32) flags(1) signCount(4) [aaguid(16) credIdLen(2) credId COSE_Key] [extensions]
function parseAuthData(authData) {
  const buf = Buffer.from(authData);
  if (buf.length < 37) throw new Error('authenticator data too short');
  const flags = buf[32];
  const out = { rpIdHash: buf.subarray(0, 32), flags, signCount: buf.readUInt32BE(33) };
  if (flags & 0x40) {
    const len = buf.readUInt16BE(53);
    out.credentialId = buf.subarray(55, 55 + len);
    const [cose] = cborRead(buf, 55 + len);
    out.cose = cose;
  }
  return out;
}
function coseToSpki(cose) {
  if (!(cose instanceof Map)) return null;
  const kty = cose.get(1);
  const alg = cose.get(3);
  try {
    let jwk = null;
    if (kty === 2 && cose.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
    else if (kty === 2 && cose.get(-1) === 2) jwk = { kty: 'EC', crv: 'P-384', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
    else if (kty === 2 && cose.get(-1) === 3) jwk = { kty: 'EC', crv: 'P-521', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) };
    else if (kty === 1 && cose.get(-1) === 6) jwk = { kty: 'OKP', crv: 'Ed25519', x: b64u(cose.get(-2)) };
    else if (kty === 3) jwk = { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) };
    if (!jwk) return { alg, spki: null };
    return { alg, spki: crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' }) };
  } catch { return { alg, spki: null }; }
}

// ---- Windows' answers -> the page
const attachmentOf = (usedTransport) => (usedTransport & TRANSPORTS.internal ? 'platform' : usedTransport ? 'cross-platform' : null);

function createResult(win, req, clientData) {
  let spki = null;
  let alg = null;
  try {
    const parsed = parseAuthData(win.authenticatorData);
    const key = coseToSpki(parsed.cose);
    if (key) { spki = key.spki; alg = key.alg; }
  } catch { /* no public key to offer: getPublicKey() returns null, the attestation object still carries it */ }
  const transports = transportNames(win.transports || win.usedTransport || 0);
  const ext = {};
  if (req.wants.credProps) ext.credProps = win.residentKey == null ? {} : { rk: win.residentKey };
  if (req.wants.hmacCreateSecret) ext.hmacCreateSecret = Boolean(win.extensions && win.extensions['hmac-secret']);
  if (req.wants.prf) {
    ext.prf = { enabled: Boolean(win.prfEnabled) };
    if (win.prfResults) ext.prf.results = { first: b64u(win.prfResults.first), ...(win.prfResults.second ? { second: b64u(win.prfResults.second) } : {}) };
  }
  if (req.wants.largeBlob) ext.largeBlob = { supported: Boolean(win.largeBlobSupported) };
  if (req.wants.credProtect && win.extensions && win.extensions.credProtect) ext.credProtect = Object.keys(CRED_PROTECT).find((k) => CRED_PROTECT[k] === win.extensions.credProtect);
  return {
    type: 'public-key',
    id: b64u(win.credentialId),
    authenticatorAttachment: attachmentOf(win.usedTransport),
    response: {
      clientDataJSON: b64u(clientData),
      attestationObject: b64u(win.attestationObject),
      authenticatorData: b64u(win.authenticatorData),
      transports,
      publicKey: spki ? b64u(spki) : null,
      publicKeyAlgorithm: Number.isInteger(alg) ? alg : (req.algorithms[0] ?? -7),
    },
    clientExtensionResults: ext,
  };
}

function getResult(win, req, clientData) {
  const ext = {};
  if (req.wants.appid) ext.appid = Boolean(win.appidUsed);
  if (req.wants.prf && win.prfResults) ext.prf = { results: { first: b64u(win.prfResults.first), ...(win.prfResults.second ? { second: b64u(win.prfResults.second) } : {}) } };
  else if (req.wants.prf) ext.prf = {};
  if (req.wants.largeBlob === 1) ext.largeBlob = win.largeBlobStatus === 1 && win.largeBlob ? { blob: b64u(win.largeBlob) } : {};
  if (req.wants.largeBlob === 2) ext.largeBlob = { written: win.largeBlobStatus === 1 };
  return {
    type: 'public-key',
    id: b64u(win.credentialId),
    authenticatorAttachment: attachmentOf(win.usedTransport),
    response: {
      clientDataJSON: b64u(clientData),
      authenticatorData: b64u(win.authenticatorData),
      signature: b64u(win.signature),
      userHandle: win.userHandle && win.userHandle.length ? b64u(win.userHandle) : null,
    },
    clientExtensionResults: ext,
  };
}

// ---- HRESULT -> DOMException name (webauthn.h WebAuthNGetErrorName, with the spec's privacy rule: anything else,
// including "no credential for this site", is the same NotAllowedError a cancel gives, so a page can't probe).
const HR = {
  NTE_EXISTS: 0x8009000F,
  NTE_NOT_SUPPORTED: 0x80090029,
  NTE_TOKEN_KEYSET_STORAGE_FULL: 0x80090023,
  ERROR_NOT_SUPPORTED: 0x80070032,
  NTE_INVALID_PARAMETER: 0x80090027,
  NTE_DEVICE_NOT_FOUND: 0x80090035,
  NTE_NOT_FOUND: 0x80090011,
  ERROR_CANCELLED: 0x800704C7,
  NTE_USER_CANCELLED: 0x80090036,
  ERROR_TIMEOUT: 0x800705B4,
};
function domErrorFor(hr) {
  switch (hr >>> 0) {
    case HR.NTE_EXISTS: return { name: 'InvalidStateError', message: 'The authenticator already holds a credential for this account (excludeCredentials).' };
    case HR.NTE_NOT_SUPPORTED: case HR.ERROR_NOT_SUPPORTED: case HR.NTE_TOKEN_KEYSET_STORAGE_FULL: case HR.NTE_INVALID_PARAMETER:
      return { name: 'NotSupportedError', message: 'The authenticator does not support this request.' };
    default: return { name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' };
  }
}

module.exports = {
  WebAuthnError, b64u, fromB64u, checkOrigin, checkRpId, checkAppId, frameContext, clientDataJSON,
  toWindowsCreate, toWindowsGet, createResult, getResult, parseAuthData, coseToSpki, cborRead, domErrorFor,
  transportMask, transportNames, timeoutOf, HR, isIp,
};
