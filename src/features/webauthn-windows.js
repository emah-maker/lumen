// The Windows platform WebAuthn API (webauthn.dll, Windows 10 1903 and later) called through koffi, so a passkey,
// Windows Hello (face, fingerprint, PIN) or a security key (USB, NFC, Bluetooth, a phone over QR / hybrid) can
// complete in Lumen. Windows draws the whole ceremony itself (the "Windows Security" dialog), owned by the HWND
// passed in, and keeps the credentials: Lumen stores nothing.
//
// Windows only, loaded lazily (features/passkeys.js), and every failure to load means "not available": the API then
// stays hidden from pages as before (browser/webauthn-gate.js). The calls that wait on the user run on koffi's
// worker threads (fn.async), never on the main thread. Every input is copied into memory this module allocates
// and frees itself once the call has returned; every output is copied out and handed back to Windows' free functions.
// Nothing is logged here: challenges, credential ids, user handles and attestation blobs never reach a console or disk.
//
// Struct layouts follow webauthn.h (github.com/microsoft/webauthn). Each struct is declared at its newest version;
// dwVersion tells Windows how much of it to read, and is chosen from WebAuthNGetApiVersionNumber() (versionsFor).
// Output structs are read field by field, only up to the version Windows says it filled in.
'use strict';

const path = require('path');

const MIN_API_VERSION = 4; // Windows 10 1903 (WEBAUTHN_API_VERSION_4): allow/exclude lists with transports, large blobs

// dwVersion of the option structs for each API version (the "Data Structures and their sub versions" table of webauthn.h).
function versionsFor(api) {
  const make = [0, 3, 3, 4, 5, 5, 6, 7, 8, 9][Math.min(api, 9)] || 0;
  const get = [0, 4, 4, 5, 6, 6, 6, 7, 8, 9][Math.min(api, 9)] || 0;
  return { make, get };
}

function load({ koffi: injected = null, dllPath = null } = {}) {
  if (process.platform !== 'win32') return { ok: false, reason: 'platform' };
  let koffi = injected;
  try { koffi ||= require('koffi'); } catch (err) { return { ok: false, reason: 'koffi', detail: err.message }; }
  let lib;
  try {
    // An absolute path in System32: never a webauthn.dll that happens to sit next to Lumen or in the current directory.
    lib = koffi.load(dllPath || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'webauthn.dll'));
  } catch (err) { return { ok: false, reason: 'dll', detail: err.message }; }

  const P = 'void *';
  const fn = (ret, name, args) => lib.func('__stdcall', name, ret, args);
  let api;
  try { api = fn('uint32', 'WebAuthNGetApiVersionNumber', [])(); } catch { return { ok: false, reason: 'dll' }; }
  if (!(api >= MIN_API_VERSION)) return { ok: false, reason: 'version', api };

  const S = (name, def) => koffi.struct(`LUMEN_${name}`, def);
  const RP = S('WEBAUTHN_RP_ENTITY_INFORMATION', { dwVersion: 'uint32', pwszId: P, pwszName: P, pwszIcon: P });
  const USER = S('WEBAUTHN_USER_ENTITY_INFORMATION', { dwVersion: 'uint32', cbId: 'uint32', pbId: P, pwszName: P, pwszIcon: P, pwszDisplayName: P });
  const CLIENT_DATA = S('WEBAUTHN_CLIENT_DATA', { dwVersion: 'uint32', cbClientDataJSON: 'uint32', pbClientDataJSON: P, pwszHashAlgId: P });
  const COSE_PARAM = S('WEBAUTHN_COSE_CREDENTIAL_PARAMETER', { dwVersion: 'uint32', pwszCredentialType: P, lAlg: 'int32' });
  const COSE_PARAMS = S('WEBAUTHN_COSE_CREDENTIAL_PARAMETERS', { cCredentialParameters: 'uint32', pCredentialParameters: P });
  const CREDENTIAL = S('WEBAUTHN_CREDENTIAL', { dwVersion: 'uint32', cbId: 'uint32', pbId: P, pwszCredentialType: P });
  const CREDENTIALS = S('WEBAUTHN_CREDENTIALS', { cCredentials: 'uint32', pCredentials: P });
  const CREDENTIAL_EX = S('WEBAUTHN_CREDENTIAL_EX', { dwVersion: 'uint32', cbId: 'uint32', pbId: P, pwszCredentialType: P, dwTransports: 'uint32' });
  const CREDENTIAL_LIST = S('WEBAUTHN_CREDENTIAL_LIST', { cCredentials: 'uint32', ppCredentials: P });
  const SALT = S('WEBAUTHN_HMAC_SECRET_SALT', { cbFirst: 'uint32', pbFirst: P, cbSecond: 'uint32', pbSecond: P });
  const CRED_SALT = S('WEBAUTHN_CRED_WITH_HMAC_SECRET_SALT', { cbCredID: 'uint32', pbCredID: P, pHmacSecretSalt: P });
  const SALT_VALUES = S('WEBAUTHN_HMAC_SECRET_SALT_VALUES', { pGlobalHmacSalt: P, cCredWithHmacSecretSaltList: 'uint32', pCredWithHmacSecretSaltList: P });
  const CRED_PROTECT_IN = S('WEBAUTHN_CRED_PROTECT_EXTENSION_IN', { dwCredProtect: 'uint32', bRequireCredProtect: 'int32' });
  const EXTENSION = S('WEBAUTHN_EXTENSION', { pwszExtensionIdentifier: P, cbExtension: 'uint32', pvExtension: P });
  const EXTENSIONS = S('WEBAUTHN_EXTENSIONS', { cExtensions: 'uint32', pExtensions: P });
  const MAKE_OPTIONS = S('WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS', {
    dwVersion: 'uint32', dwTimeoutMilliseconds: 'uint32', CredentialList: CREDENTIALS, Extensions: EXTENSIONS,
    dwAuthenticatorAttachment: 'uint32', bRequireResidentKey: 'int32', dwUserVerificationRequirement: 'uint32',
    dwAttestationConveyancePreference: 'uint32', dwFlags: 'uint32',
    pCancellationId: P, // v2
    pExcludeCredentialList: P, // v3
    dwEnterpriseAttestation: 'uint32', dwLargeBlobSupport: 'uint32', bPreferResidentKey: 'int32', // v4
    bBrowserInPrivateMode: 'int32', // v5
    bEnablePrf: 'int32', // v6
    pLinkedDevice: P, cbJsonExt: 'uint32', pbJsonExt: P, // v7
    pPRFGlobalEval: P, cCredentialHints: 'uint32', ppwszCredentialHints: P, bThirdPartyPayment: 'int32', // v8
    pwszRemoteWebOrigin: P, cbPublicKeyCredentialCreationOptionsJSON: 'uint32', pbPublicKeyCredentialCreationOptionsJSON: P, cbAuthenticatorId: 'uint32', pbAuthenticatorId: P, // v9
  });
  const GET_OPTIONS = S('WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS', {
    dwVersion: 'uint32', dwTimeoutMilliseconds: 'uint32', CredentialList: CREDENTIALS, Extensions: EXTENSIONS,
    dwAuthenticatorAttachment: 'uint32', dwUserVerificationRequirement: 'uint32', dwFlags: 'uint32',
    pwszU2fAppId: P, pbU2fAppId: P, // v2
    pCancellationId: P, // v3
    pAllowCredentialList: P, // v4
    dwCredLargeBlobOperation: 'uint32', cbCredLargeBlob: 'uint32', pbCredLargeBlob: P, // v5
    pHmacSecretSaltValues: P, bBrowserInPrivateMode: 'int32', // v6
    pLinkedDevice: P, bAutoFill: 'int32', cbJsonExt: 'uint32', pbJsonExt: P, // v7
    cCredentialHints: 'uint32', ppwszCredentialHints: P, // v8
    pwszRemoteWebOrigin: P, cbPublicKeyCredentialRequestOptionsJSON: 'uint32', pbPublicKeyCredentialRequestOptionsJSON: P, cbAuthenticatorId: 'uint32', pbAuthenticatorId: P, // v9
  });
  const ATTESTATION = S('WEBAUTHN_CREDENTIAL_ATTESTATION', {
    dwVersion: 'uint32', pwszFormatType: P, cbAuthenticatorData: 'uint32', pbAuthenticatorData: P,
    cbAttestation: 'uint32', pbAttestation: P, dwAttestationDecodeType: 'uint32', pvAttestationDecode: P,
    cbAttestationObject: 'uint32', pbAttestationObject: P, cbCredentialId: 'uint32', pbCredentialId: P,
    Extensions: EXTENSIONS, // v2
    dwUsedTransport: 'uint32', // v3
    bEpAtt: 'int32', bLargeBlobSupported: 'int32', bResidentKey: 'int32', // v4
    bPrfEnabled: 'int32', // v5
    cbUnsignedExtensionOutputs: 'uint32', pbUnsignedExtensionOutputs: P, // v6
    pHmacSecret: P, bThirdPartyPayment: 'int32', // v7
    dwTransports: 'uint32', cbClientDataJSON: 'uint32', pbClientDataJSON: P, cbRegistrationResponseJSON: 'uint32', pbRegistrationResponseJSON: P, // v8
  });
  const ASSERTION = S('WEBAUTHN_ASSERTION', {
    dwVersion: 'uint32', cbAuthenticatorData: 'uint32', pbAuthenticatorData: P, cbSignature: 'uint32', pbSignature: P,
    Credential: CREDENTIAL, cbUserId: 'uint32', pbUserId: P,
    Extensions: EXTENSIONS, cbCredLargeBlob: 'uint32', pbCredLargeBlob: P, dwCredLargeBlobStatus: 'uint32', // v2
    pHmacSecret: P, // v3
    dwUsedTransport: 'uint32', // v4
    cbUnsignedExtensionOutputs: 'uint32', pbUnsignedExtensionOutputs: P, // v5
    cbClientDataJSON: 'uint32', pbClientDataJSON: P, cbAuthenticationResponseJSON: 'uint32', pbAuthenticationResponseJSON: P, // v6
  });

  let native;
  try {
    native = {
      isUvpaa: fn('int32', 'WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable', [P]),
      makeCredential: fn('int32', 'WebAuthNAuthenticatorMakeCredential', [P, P, P, P, P, P, P]),
      getAssertion: fn('int32', 'WebAuthNAuthenticatorGetAssertion', [P, P, P, P, P]),
      freeAttestation: fn('void', 'WebAuthNFreeCredentialAttestation', [P]),
      freeAssertion: fn('void', 'WebAuthNFreeAssertion', [P]),
      getCancellationId: fn('int32', 'WebAuthNGetCancellationId', [P]),
      cancel: fn('int32', 'WebAuthNCancelCurrentOperation', [P]),
    };
  } catch (err) { return { ok: false, reason: 'dll', detail: err.message }; }

  const versions = versionsFor(api);

  // ---- memory: everything a call needs, allocated here and freed together once Windows has returned
  function arena() {
    const blocks = [];
    const alloc = (type, n = 1) => { const p = koffi.alloc(type, n); blocks.push(p); return p; };
    const zeroed = (type) => { const p = alloc(type); koffi.encode(p, 'uint8', new Array(koffi.sizeof(type)).fill(0), koffi.sizeof(type)); return p; };
    const struct = (type, value) => { const p = zeroed(type); koffi.encode(p, type, { ...blankOf(type), ...value }); return p; };
    const bytes = (buf) => {
      if (!buf || !buf.length) return 0n;
      const p = alloc('uint8', buf.length);
      koffi.encode(p, 'uint8', Array.from(buf), buf.length);
      return p;
    };
    const wstr = (s) => {
      if (s == null) return 0n;
      const codes = [];
      for (let i = 0; i < s.length; i++) codes.push(s.charCodeAt(i));
      codes.push(0);
      const p = alloc('uint16', codes.length);
      koffi.encode(p, 'uint16', codes, codes.length);
      return p;
    };
    const array = (type, values) => {
      if (!values.length) return 0n;
      const size = koffi.sizeof(type);
      const p = alloc('uint8', size * values.length);
      values.forEach((v, i) => koffi.encode(p, i * size, type, { ...blankOf(type), ...v }));
      return p;
    };
    const pointers = (ptrs) => {
      if (!ptrs.length) return 0n;
      const p = alloc('uint8', 8 * ptrs.length);
      ptrs.forEach((v, i) => koffi.encode(p, i * koffi.sizeof(P), P, v));
      return p;
    };
    const free = () => { for (const p of blocks.splice(0)) { try { koffi.free(p); } catch {} } };
    return { alloc, struct, bytes, wstr, array, pointers, free };
  }
  // Every field of a struct, zero: pointers 0n, numbers 0, nested structs likewise.
  const blanks = new Map();
  function blankOf(type) {
    if (blanks.has(type)) return blanks.get(type);
    const info = koffi.type(type);
    const out = {};
    for (const [name, member] of Object.entries(info.members || {})) {
      const mt = member.type;
      const mi = koffi.type(mt);
      out[name] = mi.primitive === 'Record' ? blankOf(mt) : (mi.primitive === 'Pointer' ? 0n : 0);
    }
    blanks.set(type, out);
    return out;
  }

  // ---- reading Windows' answers
  const field = (ptr, type, name, fieldType) => koffi.decode(ptr, koffi.offsetof(type, name), fieldType);
  const ptrAt = (ptr, type, name) => toBig(field(ptr, type, name, P));
  const toBig = (v) => (v == null ? 0n : typeof v === 'bigint' ? v : BigInt(v));
  const readBytes = (p, n) => (n && toBig(p) !== 0n ? Buffer.from(koffi.decode(p, 'uint8', n)) : Buffer.alloc(0));
  const blob = (ptr, type, countName, ptrName) => readBytes(ptrAt(ptr, type, ptrName), field(ptr, type, countName, 'uint32'));
  function readSalt(p) {
    if (toBig(p) === 0n) return null;
    const first = blob(p, SALT, 'cbFirst', 'pbFirst');
    const second = blob(p, SALT, 'cbSecond', 'pbSecond');
    return { first, second: second.length ? second : null };
  }
  const wide = (p) => (toBig(p) === 0n ? '' : koffi.decode.string16(p));
  function readExtensions(ptr, type) {
    const base = koffi.offsetof(type, 'Extensions');
    const count = koffi.decode(ptr, base + koffi.offsetof(EXTENSIONS, 'cExtensions'), 'uint32');
    const list = toBig(koffi.decode(ptr, base + koffi.offsetof(EXTENSIONS, 'pExtensions'), P));
    const out = {};
    const size = koffi.sizeof(EXTENSION);
    for (let i = 0; i < Math.min(count, 32) && list !== 0n; i++) {
      const id = wideAt(list, i * size + koffi.offsetof(EXTENSION, 'pwszExtensionIdentifier'));
      const cb = koffi.decode(list, i * size + koffi.offsetof(EXTENSION, 'cbExtension'), 'uint32');
      const pv = toBig(koffi.decode(list, i * size + koffi.offsetof(EXTENSION, 'pvExtension'), P));
      if (!id || pv === 0n) continue;
      if (id === 'hmac-secret' || id === 'credBlob' && cb === 4 || id === 'minPinLength') out[id] = koffi.decode(pv, 'uint32');
      else if (id === 'credProtect') out[id] = koffi.decode(pv, 'uint32');
    }
    return out;
  }
  const wideAt = (base, offset) => wide(toBig(koffi.decode(base, offset, P)));

  function readAttestation(p) {
    const v = field(p, ATTESTATION, 'dwVersion', 'uint32');
    const out = {
      version: v,
      authenticatorData: blob(p, ATTESTATION, 'cbAuthenticatorData', 'pbAuthenticatorData'),
      attestationObject: blob(p, ATTESTATION, 'cbAttestationObject', 'pbAttestationObject'),
      credentialId: blob(p, ATTESTATION, 'cbCredentialId', 'pbCredentialId'),
      extensions: v >= 2 ? readExtensions(p, ATTESTATION) : {},
      usedTransport: v >= 3 ? field(p, ATTESTATION, 'dwUsedTransport', 'uint32') : 0,
      largeBlobSupported: v >= 4 ? Boolean(field(p, ATTESTATION, 'bLargeBlobSupported', 'int32')) : null,
      residentKey: v >= 4 ? Boolean(field(p, ATTESTATION, 'bResidentKey', 'int32')) : null,
      prfEnabled: v >= 5 ? Boolean(field(p, ATTESTATION, 'bPrfEnabled', 'int32')) : null,
      prfResults: v >= 7 ? readSalt(ptrAt(p, ATTESTATION, 'pHmacSecret')) : null,
      transports: v >= 8 ? field(p, ATTESTATION, 'dwTransports', 'uint32') : 0,
    };
    return out;
  }
  function readAssertion(p) {
    const v = field(p, ASSERTION, 'dwVersion', 'uint32');
    const credBase = koffi.offsetof(ASSERTION, 'Credential');
    const credId = readBytes(toBig(koffi.decode(p, credBase + koffi.offsetof(CREDENTIAL, 'pbId'), P)), koffi.decode(p, credBase + koffi.offsetof(CREDENTIAL, 'cbId'), 'uint32'));
    return {
      version: v,
      authenticatorData: blob(p, ASSERTION, 'cbAuthenticatorData', 'pbAuthenticatorData'),
      signature: blob(p, ASSERTION, 'cbSignature', 'pbSignature'),
      credentialId: credId,
      userHandle: blob(p, ASSERTION, 'cbUserId', 'pbUserId'),
      largeBlob: v >= 2 ? blob(p, ASSERTION, 'cbCredLargeBlob', 'pbCredLargeBlob') : null,
      largeBlobStatus: v >= 2 ? field(p, ASSERTION, 'dwCredLargeBlobStatus', 'uint32') : 0,
      prfResults: v >= 3 ? readSalt(ptrAt(p, ASSERTION, 'pHmacSecret')) : null,
      usedTransport: v >= 4 ? field(p, ASSERTION, 'dwUsedTransport', 'uint32') : 0,
    };
  }

  // ---- building the inputs
  function credentialList(mem, list) {
    const ptrs = list.map((c) => mem.struct(CREDENTIAL_EX, { dwVersion: 1, cbId: c.id.length, pbId: mem.bytes(c.id), pwszCredentialType: mem.wstr('public-key'), dwTransports: c.transports >>> 0 }));
    return list.length ? mem.struct(CREDENTIAL_LIST, { cCredentials: ptrs.length, ppCredentials: mem.pointers(ptrs) }) : 0n;
  }
  function salt(mem, s) {
    if (!s) return 0n;
    return mem.struct(SALT, { cbFirst: s.first.length, pbFirst: mem.bytes(s.first), cbSecond: s.second ? s.second.length : 0, pbSecond: s.second ? mem.bytes(s.second) : 0n });
  }
  function hints(mem, list) {
    const ptrs = (list || []).map((h) => mem.wstr(h));
    return { count: ptrs.length, ptr: mem.pointers(ptrs) };
  }
  function extensionList(mem, exts) {
    const items = [];
    if (exts.hmacSecret) {
      const p = mem.alloc('int32'); koffi.encode(p, 'int32', 1);
      items.push({ pwszExtensionIdentifier: mem.wstr('hmac-secret'), cbExtension: 4, pvExtension: p });
    }
    if (exts.credProtect) {
      const p = mem.struct(CRED_PROTECT_IN, { dwCredProtect: exts.credProtect.policy, bRequireCredProtect: exts.credProtect.enforce ? 1 : 0 });
      items.push({ pwszExtensionIdentifier: mem.wstr('credProtect'), cbExtension: koffi.sizeof(CRED_PROTECT_IN), pvExtension: p });
    }
    return { cExtensions: items.length, pExtensions: mem.array(EXTENSION, items) };
  }

  // One ceremony at a time per call object: { promise, cancel }. `run` builds the inputs and starts the async call.
  function ceremony(build, call, read, freeResult) {
    const mem = arena();
    const guid = mem.alloc('uint8', 16);
    const out = mem.alloc(P);
    koffi.encode(out, P, 0n);
    let haveGuid = false;
    try { haveGuid = native.getCancellationId(guid) === 0; } catch { haveGuid = false; }
    let args;
    let extra = null;
    try { ({ args, extra = null } = build(mem, haveGuid ? guid : 0n)); } catch (err) { mem.free(); return { promise: Promise.reject(err), cancel() {} }; }
    let finished = false;
    const promise = new Promise((resolve, reject) => {
      try {
        call.async(...args, out, (err, hr) => {
          finished = true;
          try {
            if (err) { reject(err); return; }
            const p = toBig(koffi.decode(out, P));
            if (hr === 0 && p !== 0n) {
              let result;
              try { result = read(p); if (extra) Object.assign(result, extra()); } finally { try { freeResult(p); } catch {} }
              resolve({ hr: 0, result });
            } else {
              if (p !== 0n) { try { freeResult(p); } catch {} }
              resolve({ hr: hr >>> 0, result: null });
            }
          } catch (e) { reject(e); } finally { mem.free(); }
        });
      } catch (err) { finished = true; mem.free(); reject(err); }
    });
    return {
      promise,
      // Asks Windows to close its dialog; the call then returns (cancelled) on its own and the memory is freed there.
      // (Windows 11 can leave its "where to save this passkey" picker up for a while after a cancel; the call returns
      // when it closes. A sign-in prompt closes at once.)
      cancel() { if (!finished && haveGuid) { try { native.cancel(guid); } catch {} } },
    };
  }

  // req: the checked, converted request from browser/webauthn-core.js (toWindowsCreate).
  function makeCredential(hwnd, req) {
    return ceremony((mem, guid) => {
      const rp = mem.struct(RP, { dwVersion: 1, pwszId: mem.wstr(req.rp.id), pwszName: mem.wstr(req.rp.name || req.rp.id), pwszIcon: 0n });
      const user = mem.struct(USER, { dwVersion: 1, cbId: req.user.id.length, pbId: mem.bytes(req.user.id), pwszName: mem.wstr(req.user.name), pwszIcon: 0n, pwszDisplayName: mem.wstr(req.user.displayName) });
      const type = mem.wstr('public-key');
      const params = mem.struct(COSE_PARAMS, { cCredentialParameters: req.algorithms.length, pCredentialParameters: mem.array(COSE_PARAM, req.algorithms.map((alg) => ({ dwVersion: 1, pwszCredentialType: type, lAlg: alg }))) });
      const clientData = mem.struct(CLIENT_DATA, { dwVersion: 1, cbClientDataJSON: req.clientDataJSON.length, pbClientDataJSON: mem.bytes(req.clientDataJSON), pwszHashAlgId: mem.wstr('SHA-256') });
      const h = hints(mem, versions.make >= 8 ? req.hints : []);
      const options = mem.struct(MAKE_OPTIONS, {
        dwVersion: versions.make,
        dwTimeoutMilliseconds: req.timeout,
        Extensions: extensionList(mem, req.extensions),
        dwAuthenticatorAttachment: req.attachment,
        bRequireResidentKey: req.requireResidentKey ? 1 : 0,
        dwUserVerificationRequirement: req.userVerification,
        dwAttestationConveyancePreference: req.attestation,
        pCancellationId: guid,
        pExcludeCredentialList: credentialList(mem, req.excludeCredentials),
        dwLargeBlobSupport: req.largeBlob,
        bPreferResidentKey: req.preferResidentKey ? 1 : 0,
        bBrowserInPrivateMode: req.inPrivate ? 1 : 0,
        bEnablePrf: versions.make >= 6 && req.prf ? 1 : 0,
        pPRFGlobalEval: versions.make >= 8 && req.prf && req.prfEval ? salt(mem, req.prfEval) : 0n,
        cCredentialHints: h.count,
        ppwszCredentialHints: h.ptr,
      });
      return { args: [hwnd, rp, user, params, clientData, options] };
    }, native.makeCredential, readAttestation, native.freeAttestation);
  }

  function getAssertion(hwnd, req) {
    return ceremony((mem, guid) => {
      const clientData = mem.struct(CLIENT_DATA, { dwVersion: 1, cbClientDataJSON: req.clientDataJSON.length, pbClientDataJSON: mem.bytes(req.clientDataJSON), pwszHashAlgId: mem.wstr('SHA-256') });
      const h = hints(mem, versions.get >= 8 ? req.hints : []);
      let saltValues = 0n;
      if (req.prf && versions.get >= 6) {
        const byCred = (req.prf.byCredential || []).map((c) => ({ cbCredID: c.id.length, pbCredID: mem.bytes(c.id), pHmacSecretSalt: salt(mem, c.values) }));
        saltValues = mem.struct(SALT_VALUES, { pGlobalHmacSalt: salt(mem, req.prf.global), cCredWithHmacSecretSaltList: byCred.length, pCredWithHmacSecretSaltList: mem.array(CRED_SALT, byCred) });
      }
      const appIdUsed = req.appid ? mem.alloc('int32') : 0n;
      if (appIdUsed) koffi.encode(appIdUsed, 'int32', 0);
      const options = mem.struct(GET_OPTIONS, {
        dwVersion: versions.get,
        dwTimeoutMilliseconds: req.timeout,
        dwAuthenticatorAttachment: req.attachment,
        dwUserVerificationRequirement: req.userVerification,
        pwszU2fAppId: req.appid ? mem.wstr(req.appid) : 0n,
        pbU2fAppId: appIdUsed,
        pCancellationId: guid,
        pAllowCredentialList: credentialList(mem, req.allowCredentials),
        dwCredLargeBlobOperation: req.largeBlob ? req.largeBlob.operation : 0,
        cbCredLargeBlob: req.largeBlob?.blob ? req.largeBlob.blob.length : 0,
        pbCredLargeBlob: req.largeBlob?.blob ? mem.bytes(req.largeBlob.blob) : 0n,
        pHmacSecretSaltValues: saltValues,
        bBrowserInPrivateMode: req.inPrivate ? 1 : 0,
        cCredentialHints: h.count,
        ppwszCredentialHints: h.ptr,
      });
      // (read when the call has returned, before the arena is freed)
      return { args: [hwnd, mem.wstr(req.rpId), clientData, options], extra: () => ({ appidUsed: appIdUsed ? Boolean(koffi.decode(appIdUsed, 'int32')) : null }) };
    }, native.getAssertion, readAssertion, native.freeAssertion);
  }

  function isUserVerifyingPlatformAuthenticatorAvailable() {
    return new Promise((resolve) => {
      const out = koffi.alloc('int32', 1);
      koffi.encode(out, 'int32', 0);
      try {
        native.isUvpaa.async(out, (err, hr) => {
          let ok = false;
          try { ok = !err && hr === 0 && koffi.decode(out, 'int32') !== 0; } catch {}
          try { koffi.free(out); } catch {}
          resolve(ok);
        });
      } catch { try { koffi.free(out); } catch {} resolve(false); }
    });
  }

  // The HWND inside BrowserWindow.getNativeWindowHandle()'s buffer, as the pointer value koffi passes.
  const hwndOf = (buf) => (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0)));

  return { ok: true, api, versions, makeCredential, getAssertion, isUserVerifyingPlatformAuthenticatorAvailable, hwndOf, wide };
}

module.exports = { load, versionsFor, MIN_API_VERSION };
