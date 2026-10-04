// What a page sees of WebAuthn (passkeys, Windows Hello, security keys). Two modes, picked per frame by the main
// process (features/passkeys.js answers preload/webauthn-preload.js's 'webauthn:mode'):
//
// - 'native' (Windows 10 1903+, Settings → Privacy "Use passkeys and security keys" on): installPasskeys replaces
//   navigator.credentials.create/get for publicKey requests and the PublicKeyCredential family with an implementation
//   that hands the request to the main process, which checks it (origin, relying party id, the tab in front, no AI)
//   and runs the ceremony through Windows' own WebAuthn API (features/webauthn-windows.js). Electron's Chromium can't:
//   it has no WebAuthn user interface (the authenticator-request dialog is part of Chrome, not of the content layer
//   Electron embeds; electron/electron#15404 and #27355), so its create/get never show the Windows Security prompt
//   and never settle.
// - 'hide' (everywhere else: macOS, Linux, older Windows, the setting off, tabs the AI works in): hideWebAuthn takes
//   the API away, so a site falls back to what works (password, an authenticator app, a code) instead of waiting
//   forever on a dead prompt, the way FedCM's IdentityCredential is removed in preload/page-dialogs-preload.js.
//
// Both functions are serialized into the page's main world (contextBridge.executeInMainWorld), so each must be
// self-contained. Pure (no Electron): test/webauthn-gate-units.js. preload/webauthn-preload.js is generated from this
// file by scripts/bundle-webauthn-preload.js (a sandboxed preload can only require('electron')).
/* global window */ // serialized into pages and run there

function hideWebAuthn() {
  const win = window;
  try { delete win.PublicKeyCredential; } catch { /* not removable */ }
  try {
    const proto = win.CredentialsContainer && win.CredentialsContainer.prototype;
    if (!proto) return;
    for (const name of ['create', 'get']) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      const wrapped = {
        [name](options) {
          if (options && typeof options === 'object' && options.publicKey) {
            return Promise.reject(new DOMException('Passkeys and security keys are not supported in this browser.', 'NotSupportedError'));
          }
          return original.apply(this, arguments);
        },
      }[name];
      Object.defineProperty(wrapped, 'toString', { value: () => `function ${name}() { [native code] }`, configurable: true, writable: true });
      Object.defineProperty(proto, name, { value: wrapped, configurable: true, writable: true, enumerable: true });
    }
  } catch { /* leave the API as it is */ }
}

// `bridge`: { request(kind, id, options) -> Promise<{ value } | { error: { name, message } }>, cancel(id) } (the
// preload's, over IPC). `caps`: { uvpaa, hybrid, prf, largeBlob } from the main process. The page can call bridge
// itself if it gets hold of it; that gives it nothing navigator.credentials doesn't: every check is in the main process.
function installPasskeys(bridge, caps) {
  const win = window;
  const proto = win.CredentialsContainer && win.CredentialsContainer.prototype;
  if (!proto || typeof proto.create !== 'function' || typeof proto.get !== 'function') return;
  const origCreate = proto.create;
  const origGet = proto.get;
  const { Promise, Uint8Array, ArrayBuffer, DOMException, TypeError, Object: O, JSON: J, String: Str, Array: Arr, Math: M, WeakMap, btoa, atob } = win;
  const BaseCredential = win.Credential;
  const isView = win.ArrayBuffer.isView;
  const slots = new WeakMap();
  const looksNative = (fn, name) => {
    O.defineProperty(fn, 'toString', { value: () => `function ${name}() { [native code] }`, configurable: true, writable: true });
    return fn;
  };
  const slot = (self) => {
    const s = slots.get(self);
    if (!s) throw new TypeError('Illegal invocation');
    return s;
  };
  const iface = (name, parent) => {
    const C = { [name]: function () { throw new TypeError('Illegal constructor'); } }[name];
    looksNative(C, name);
    if (parent) { O.setPrototypeOf(C.prototype, parent.prototype); O.setPrototypeOf(C, parent); }
    O.defineProperty(C.prototype, Symbol.toStringTag, { value: name, configurable: true });
    return C;
  };
  const getters = (C, names) => {
    for (const name of names) {
      O.defineProperty(C.prototype, name, { get: looksNative(function () { return slot(this)[name]; }, `get ${name}`), enumerable: true, configurable: true });
    }
  };
  const methods = (target, defs) => {
    for (const [name, fn] of O.entries(defs)) O.defineProperty(target, name, { value: looksNative(fn, name), enumerable: true, configurable: true, writable: true });
  };

  // ---- bytes
  function bytesOf(src, what) {
    if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0));
    if (isView(src)) return new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
    // (an ArrayBuffer from another frame is still an ArrayBuffer)
    if (src && O.prototype.toString.call(src) === '[object ArrayBuffer]') return new Uint8Array(src.slice(0));
    throw new TypeError(`Failed to read the '${what}' property: The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.`);
  }
  function toB64u(src, what) {
    const b = bytesOf(src, what);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += Str.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64u(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new DOMException('Invalid base64url data.', 'EncodingError');
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '') + '==='.slice((s.replace(/=+$/, '').length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  const need = (v, what) => { if (v === undefined || v === null) throw new TypeError(`Failed to execute: required member ${what} is undefined.`); return v; };
  const optStr = (v) => (v === undefined || v === null ? undefined : Str(v));

  // ---- options -> JSON-safe (every BufferSource as base64url), as the page gave them; the main process checks them
  function credsJSON(list, what) {
    if (list === undefined || list === null) return undefined;
    if (!list || typeof list[Symbol.iterator] !== 'function') throw new TypeError(`Failed to read the '${what}' property: The provided value cannot be converted to a sequence.`);
    return Arr.from(list).map((c) => ({ type: Str(need(c && c.type, 'type')), id: toB64u(need(c.id, 'id'), 'id'), transports: c.transports ? Arr.from(c.transports, Str) : undefined }));
  }
  function prfJSON(v) {
    if (!v) return undefined;
    return { first: toB64u(need(v.first, 'first'), 'first'), second: v.second === undefined ? undefined : toB64u(v.second, 'second') };
  }
  function extJSON(e, kind) {
    if (!e || typeof e !== 'object') return undefined;
    const out = {};
    if (e.credProps !== undefined) out.credProps = Boolean(e.credProps);
    if (e.hmacCreateSecret !== undefined) out.hmacCreateSecret = Boolean(e.hmacCreateSecret);
    if (e.credentialProtectionPolicy !== undefined) out.credentialProtectionPolicy = Str(e.credentialProtectionPolicy);
    if (e.enforceCredentialProtectionPolicy !== undefined) out.enforceCredentialProtectionPolicy = Boolean(e.enforceCredentialProtectionPolicy);
    if (kind === 'get' && e.appid !== undefined) out.appid = Str(e.appid);
    if (e.prf && typeof e.prf === 'object') {
      out.prf = { eval: prfJSON(e.prf.eval) };
      if (e.prf.evalByCredential && typeof e.prf.evalByCredential === 'object') {
        out.prf.evalByCredential = {};
        for (const k of O.keys(e.prf.evalByCredential)) out.prf.evalByCredential[k] = prfJSON(e.prf.evalByCredential[k]);
      }
    }
    if (e.largeBlob && typeof e.largeBlob === 'object') {
      out.largeBlob = {};
      if (e.largeBlob.support !== undefined) out.largeBlob.support = Str(e.largeBlob.support);
      if (e.largeBlob.read !== undefined) out.largeBlob.read = Boolean(e.largeBlob.read);
      if (e.largeBlob.write !== undefined) out.largeBlob.write = toB64u(e.largeBlob.write, 'write');
    }
    return out;
  }
  function createJSON(pk) {
    const rp = need(pk.rp, 'rp');
    const user = need(pk.user, 'user');
    const sel = pk.authenticatorSelection || undefined;
    return {
      rp: { id: optStr(rp.id), name: Str(need(rp.name, 'name')) },
      user: { id: toB64u(need(user.id, 'id'), 'id'), name: Str(need(user.name, 'name')), displayName: Str(need(user.displayName, 'displayName')) },
      challenge: toB64u(need(pk.challenge, 'challenge'), 'challenge'),
      pubKeyCredParams: Arr.from(need(pk.pubKeyCredParams, 'pubKeyCredParams'), (p) => ({ type: Str(need(p && p.type, 'type')), alg: M.trunc(Number(need(p.alg, 'alg'))) })),
      timeout: pk.timeout === undefined ? undefined : Number(pk.timeout),
      excludeCredentials: credsJSON(pk.excludeCredentials, 'excludeCredentials'),
      authenticatorSelection: sel ? { authenticatorAttachment: optStr(sel.authenticatorAttachment), residentKey: optStr(sel.residentKey), requireResidentKey: Boolean(sel.requireResidentKey), userVerification: optStr(sel.userVerification) } : undefined,
      attestation: optStr(pk.attestation),
      hints: pk.hints ? Arr.from(pk.hints, Str) : undefined,
      extensions: extJSON(pk.extensions, 'create'),
    };
  }
  function getJSON(pk) {
    return {
      challenge: toB64u(need(pk.challenge, 'challenge'), 'challenge'),
      timeout: pk.timeout === undefined ? undefined : Number(pk.timeout),
      rpId: optStr(pk.rpId),
      allowCredentials: credsJSON(pk.allowCredentials, 'allowCredentials'),
      userVerification: optStr(pk.userVerification),
      hints: pk.hints ? Arr.from(pk.hints, Str) : undefined,
      extensions: extJSON(pk.extensions, 'get'),
    };
  }

  // ---- the interfaces
  const AuthenticatorResponse = iface('AuthenticatorResponse');
  const AuthenticatorAttestationResponse = iface('AuthenticatorAttestationResponse', AuthenticatorResponse);
  const AuthenticatorAssertionResponse = iface('AuthenticatorAssertionResponse', AuthenticatorResponse);
  const PublicKeyCredential = iface('PublicKeyCredential', typeof BaseCredential === 'function' ? BaseCredential : null);
  getters(AuthenticatorResponse, ['clientDataJSON']);
  getters(AuthenticatorAttestationResponse, ['attestationObject']);
  getters(AuthenticatorAssertionResponse, ['authenticatorData', 'signature', 'userHandle']);
  getters(PublicKeyCredential, ['id', 'type', 'rawId', 'response', 'authenticatorAttachment']);
  methods(AuthenticatorAttestationResponse.prototype, {
    getTransports() { return slot(this).transports.slice(); },
    getAuthenticatorData() { return slot(this).authenticatorData.slice(0); },
    getPublicKey() { const k = slot(this).publicKey; return k ? k.slice(0) : null; },
    getPublicKeyAlgorithm() { return slot(this).publicKeyAlgorithm; },
  });
  const extOut = (json) => {
    const out = J.parse(J.stringify(json || {}));
    if (out.prf && out.prf.results) {
      out.prf.results.first = fromB64u(out.prf.results.first);
      if (out.prf.results.second !== undefined) out.prf.results.second = fromB64u(out.prf.results.second);
    }
    if (out.largeBlob && out.largeBlob.blob !== undefined) out.largeBlob.blob = fromB64u(out.largeBlob.blob);
    return out;
  };
  methods(PublicKeyCredential.prototype, {
    getClientExtensionResults() { return extOut(slot(this).json.clientExtensionResults); },
    toJSON() {
      const j = slot(this).json;
      const response = { ...j.response };
      if (response.publicKey === null) delete response.publicKey;
      if (response.userHandle === null) delete response.userHandle;
      return { id: j.id, rawId: j.id, response, authenticatorAttachment: j.authenticatorAttachment, clientExtensionResults: J.parse(J.stringify(j.clientExtensionResults || {})), type: 'public-key' };
    },
  });
  // parse*FromJSON: the JSON forms back to options with ArrayBuffers.
  const parseCreds = (list) => (list ? Arr.from(list, (c) => ({ ...c, id: fromB64u(c.id) })) : list);
  const parseExt = (e) => {
    if (!e || typeof e !== 'object') return e;
    const out = { ...e };
    const prfIn = (v) => (v ? { first: fromB64u(v.first), ...(v.second !== undefined ? { second: fromB64u(v.second) } : {}) } : v);
    if (e.prf) {
      out.prf = { ...e.prf, eval: prfIn(e.prf.eval) };
      if (e.prf.evalByCredential) { out.prf.evalByCredential = {}; for (const k of O.keys(e.prf.evalByCredential)) out.prf.evalByCredential[k] = prfIn(e.prf.evalByCredential[k]); }
    }
    if (e.largeBlob && e.largeBlob.write !== undefined) out.largeBlob = { ...e.largeBlob, write: fromB64u(e.largeBlob.write) };
    return out;
  };
  methods(PublicKeyCredential, {
    isUserVerifyingPlatformAuthenticatorAvailable() { return Promise.resolve(Boolean(caps.uvpaa)); },
    // No passkey autofill: Windows has no conditional (autofill) ceremony to drive it.
    isConditionalMediationAvailable() { return Promise.resolve(false); },
    getClientCapabilities() {
      return Promise.resolve({
        conditionalCreate: false, conditionalGet: false, hybridTransport: Boolean(caps.hybrid),
        passkeyPlatformAuthenticator: Boolean(caps.uvpaa), userVerifyingPlatformAuthenticator: Boolean(caps.uvpaa),
        relatedOrigins: false, signalAllAcceptedCredentials: false, signalCurrentUserDetails: false, signalUnknownCredential: false,
        'extension:appid': true, 'extension:credProps': true, 'extension:credProtect': true, 'extension:hmacCreateSecret': true,
        'extension:largeBlob': Boolean(caps.largeBlob), 'extension:prf': Boolean(caps.prf),
      });
    },
    parseCreationOptionsFromJSON(json) {
      if (!json || typeof json !== 'object') throw new TypeError('Failed to execute parseCreationOptionsFromJSON: parameter 1 is not of type PublicKeyCredentialCreationOptionsJSON.');
      return { ...json, challenge: fromB64u(need(json.challenge, 'challenge')), user: { ...need(json.user, 'user'), id: fromB64u(need(json.user.id, 'id')) }, excludeCredentials: parseCreds(json.excludeCredentials), extensions: parseExt(json.extensions) };
    },
    parseRequestOptionsFromJSON(json) {
      if (!json || typeof json !== 'object') throw new TypeError('Failed to execute parseRequestOptionsFromJSON: parameter 1 is not of type PublicKeyCredentialRequestOptionsJSON.');
      return { ...json, challenge: fromB64u(need(json.challenge, 'challenge')), allowCredentials: parseCreds(json.allowCredentials), extensions: parseExt(json.extensions) };
    },
  });

  function credentialFrom(json, kind) {
    const r = json.response;
    let response;
    if (kind === 'create') {
      response = O.create(AuthenticatorAttestationResponse.prototype);
      slots.set(response, {
        clientDataJSON: fromB64u(r.clientDataJSON), attestationObject: fromB64u(r.attestationObject), authenticatorData: fromB64u(r.authenticatorData),
        transports: Arr.from(r.transports || [], Str), publicKey: r.publicKey ? fromB64u(r.publicKey) : null, publicKeyAlgorithm: Number(r.publicKeyAlgorithm),
      });
    } else {
      response = O.create(AuthenticatorAssertionResponse.prototype);
      slots.set(response, { clientDataJSON: fromB64u(r.clientDataJSON), authenticatorData: fromB64u(r.authenticatorData), signature: fromB64u(r.signature), userHandle: r.userHandle ? fromB64u(r.userHandle) : null });
    }
    const cred = O.create(PublicKeyCredential.prototype);
    slots.set(cred, { id: Str(json.id), type: 'public-key', rawId: fromB64u(json.id), response, authenticatorAttachment: json.authenticatorAttachment || null, json });
    return cred;
  }

  let seq = 0;
  const run = (kind, options, toJSON) => new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal && signal.aborted) { reject(signal.reason); return; }
    if (kind === 'get' && options.mediation === 'conditional') { reject(new TypeError('Conditional mediation is not supported for PublicKeyCredential.')); return; }
    let json;
    try { json = toJSON(options.publicKey); } catch (e) { reject(e); return; }
    const id = `${Date.now().toString(36)}-${(++seq).toString(36)}-${M.random().toString(36).slice(2, 10)}`;
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      try { bridge.cancel(id); } catch { /* the request ends with the page anyway */ }
      reject(signal.reason);
    };
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    let pending;
    try { pending = bridge.request(kind, id, json); } catch { pending = Promise.resolve({ error: { name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' } }); }
    Promise.resolve(pending).then((answer) => {
      if (done) return;
      done = true;
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      if (!answer || answer.error || !answer.value) {
        const e = (answer && answer.error) || {};
        reject(e.name === 'TypeError' ? new TypeError(Str(e.message || '')) : new DOMException(Str(e.message || 'The operation either timed out or was not allowed.'), Str(e.name || 'NotAllowedError')));
        return;
      }
      try { resolve(credentialFrom(answer.value, kind)); } catch { reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')); }
    }, () => {
      if (done) return;
      done = true;
      reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
    });
  });

  methods(proto, {
    create(options) {
      if (!(options && typeof options === 'object' && options.publicKey)) return origCreate.apply(this, arguments);
      return run('create', options, createJSON);
    },
    get(options) {
      if (!(options && typeof options === 'object' && options.publicKey)) return origGet.apply(this, arguments);
      return run('get', options, getJSON);
    },
  });
  for (const [name, C] of [['PublicKeyCredential', PublicKeyCredential], ['AuthenticatorResponse', AuthenticatorResponse], ['AuthenticatorAttestationResponse', AuthenticatorAttestationResponse], ['AuthenticatorAssertionResponse', AuthenticatorAssertionResponse]]) {
    O.defineProperty(win, name, { value: C, configurable: true, writable: true, enumerable: false });
  }
}

module.exports = { hideWebAuthn, installPasskeys };
