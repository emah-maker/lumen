// Pure unit test for browser/webauthn-gate.js, the page side of passkeys / Windows Hello / security keys:
//  - 'hide' mode (hideWebAuthn, #195's behavior, kept as the fallback): no API, publicKey calls fail at once
//  - 'native' mode (installPasskeys): navigator.credentials.create/get for publicKey go over a bridge (the preload's
//    IPC) and come back as real-looking PublicKeyCredential objects; everything else reaches the browser untouched
// plus the generated preload (scripts/bundle-webauthn-preload.js) and its registration in main.js.
// No Electron, no window, no Windows.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { hideWebAuthn, installPasskeys } = require('../src/browser/webauthn-gate');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

// A page: PublicKeyCredential, and a CredentialsContainer whose create/get hang like Electron's do.
function page() {
  const calls = [];
  const ctx = vm.createContext({ calls, btoa, atob, AbortController, setTimeout });
  vm.runInContext(`
    class DOMException extends Error { constructor(m, n) { super(m); this.name = n; } }
    globalThis.DOMException = DOMException;
    globalThis.Credential = function Credential() { throw new TypeError('Illegal constructor'); };
    Object.defineProperty(Credential.prototype, 'id', { get() { throw new TypeError('Illegal invocation'); }, configurable: true });
    globalThis.PublicKeyCredential = function PublicKeyCredential() {};
    globalThis.window = globalThis;
    globalThis.CredentialsContainer = function CredentialsContainer() {};
    CredentialsContainer.prototype.create = function create(o) { calls.push(['create', o]); return new Promise(() => {}); };
    CredentialsContainer.prototype.get = function get(o) { calls.push(['get', o]); return Promise.resolve('real'); };
    globalThis.navigator = { credentials: new CredentialsContainer() };
  `, ctx);
  return ctx;
}
const run = (ctx, src) => vm.runInContext(src, ctx);
const settle = (p, ms = 50) => Promise.race([p.then((v) => ['ok', v], (e) => ['err', e]), new Promise((r) => setTimeout(() => r(['pending']), ms))]);
const b64u = (b) => Buffer.from(b).toString('base64url');

(async () => {
  // ================= hide mode =================
  {
    const ctx = page();
    run(ctx, `(${hideWebAuthn.toString()})()`);
    check('hide: PublicKeyCredential is gone (sites then offer password / code instead of a passkey)', run(ctx, `typeof PublicKeyCredential`) === 'undefined', '');
    check("hide: 'PublicKeyCredential' in window is false", run(ctx, `'PublicKeyCredential' in window`) === false, '');
    const c = await settle(run(ctx, `navigator.credentials.create({ publicKey: { challenge: new Uint8Array(1) } })`));
    check('hide: create({publicKey}) rejects at once with NotSupportedError, not a hang', c[0] === 'err' && c[1].name === 'NotSupportedError', JSON.stringify(c[0]));
    const g = await settle(run(ctx, `navigator.credentials.get({ publicKey: { challenge: new Uint8Array(1) } })`));
    check('hide: get({publicKey}) rejects at once with NotSupportedError', g[0] === 'err' && g[1].name === 'NotSupportedError', JSON.stringify(g[0]));
    check('hide: the native create/get were never reached for publicKey calls', ctx.calls.length === 0, JSON.stringify(ctx.calls));
    const pw = await settle(run(ctx, `navigator.credentials.get({ password: true })`));
    check('hide: other credential requests (password) still reach the browser', pw[0] === 'ok' && pw[1] === 'real' && ctx.calls.length === 1, JSON.stringify(pw));
    check('hide: create/get still look native', /native code/.test(run(ctx, `CredentialsContainer.prototype.get.toString()`)), '');
    check('hide: a missing CredentialsContainer does not throw', (() => { const x = vm.createContext({}); vm.runInContext(`globalThis.window = globalThis; (${hideWebAuthn.toString()})()`, x); return true; })(), '');
  }

  // ================= native mode =================
  // The bridge stands in for the preload's IPC: it records requests and answers what the test says.
  const requests = [];
  const cancels = [];
  let answer = null;
  const bridge = {
    request: (kind, id, options) => { requests.push({ kind, id, options }); return answer ? Promise.resolve(answer(kind, options)) : new Promise(() => {}); },
    cancel: (id) => { cancels.push(id); },
  };
  const ctx = page();
  ctx.__bridge = bridge;
  run(ctx, `(${installPasskeys.toString()})(__bridge, { uvpaa: true, hybrid: true, prf: true, largeBlob: false }); delete globalThis.__bridge;`);

  check('native: PublicKeyCredential exists and is a function', run(ctx, 'typeof PublicKeyCredential') === 'function', '');
  check('native: new PublicKeyCredential() throws Illegal constructor', /Illegal constructor/.test(run(ctx, `try { new PublicKeyCredential(); 'no' } catch (e) { e.message }`)), '');
  check('native: PublicKeyCredential.prototype inherits Credential.prototype', run(ctx, 'Object.getPrototypeOf(PublicKeyCredential.prototype) === Credential.prototype'), '');
  check('native: the interfaces are not enumerable on window (like WebIDL)', run(ctx, `Object.keys(window).includes('PublicKeyCredential')`) === false, '');
  check('native: AuthenticatorAttestationResponse extends AuthenticatorResponse', run(ctx, 'Object.getPrototypeOf(AuthenticatorAttestationResponse.prototype) === AuthenticatorResponse.prototype'), '');
  check('native: create/get still look native', /native code/.test(run(ctx, 'navigator.credentials.create.toString()')) && /native code/.test(run(ctx, 'PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable.toString()')), '');
  check('native: isUserVerifyingPlatformAuthenticatorAvailable() is what Windows said', (await run(ctx, 'PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()')) === true, '');
  check('native: isConditionalMediationAvailable() is false (no passkey autofill)', (await run(ctx, 'PublicKeyCredential.isConditionalMediationAvailable()')) === false, '');
  const capsOut = await run(ctx, 'PublicKeyCredential.getClientCapabilities()');
  check('native: getClientCapabilities is honest', capsOut.conditionalGet === false && capsOut.hybridTransport === true && capsOut.passkeyPlatformAuthenticator === true && capsOut['extension:prf'] === true && capsOut['extension:largeBlob'] === false, JSON.stringify(capsOut));

  // create: the options go over the bridge as base64url, nothing else.
  const userId = Buffer.from('user-1234');
  const challenge = Buffer.alloc(32, 7);
  const credId = Buffer.from('credential-id-xyz');
  answer = (kind) => (kind === 'create' ? {
    value: {
      type: 'public-key', id: b64u(credId), authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u('{"type":"webauthn.create"}'), attestationObject: b64u([0xa0]), authenticatorData: b64u(Buffer.alloc(37, 1)), transports: ['internal'], publicKey: b64u([1, 2, 3]), publicKeyAlgorithm: -7 },
      clientExtensionResults: { credProps: { rk: true }, prf: { enabled: true, results: { first: b64u(Buffer.alloc(32, 5)) } } },
    },
  } : {
    value: {
      type: 'public-key', id: b64u(credId), authenticatorAttachment: 'cross-platform',
      response: { clientDataJSON: b64u('{"type":"webauthn.get"}'), authenticatorData: b64u(Buffer.alloc(37, 2)), signature: b64u('sig'), userHandle: null },
      clientExtensionResults: { appid: false },
    },
  });
  ctx.chal = new Uint8Array(challenge);
  ctx.uid = new Uint8Array(userId).buffer;
  const cred = await run(ctx, `navigator.credentials.create({ publicKey: {
    rp: { name: 'Example', id: 'example.com' }, user: { id: uid, name: 'a@example.com', displayName: 'A' }, challenge: chal,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000, attestation: 'none',
    excludeCredentials: [{ type: 'public-key', id: new Uint8Array([9, 9]), transports: ['usb'] }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { credProps: true, prf: { eval: { first: new Uint8Array(32) } } } } })`);
  const sent = requests[0];
  check('native create: one request over the bridge, kind create', requests.length === 1 && sent.kind === 'create' && typeof sent.id === 'string', JSON.stringify(requests.map((r) => r.kind)));
  check('native create: BufferSources travel as base64url', sent.options.challenge === b64u(challenge) && sent.options.user.id === b64u(userId) && sent.options.excludeCredentials[0].id === b64u([9, 9]) && sent.options.extensions.prf.eval.first === b64u(Buffer.alloc(32)), JSON.stringify(sent.options));
  check('native create: the rest of the options are carried as given', sent.options.rp.id === 'example.com' && sent.options.authenticatorSelection.residentKey === 'required' && sent.options.timeout === 60000 && sent.options.pubKeyCredParams[0].alg === -7, JSON.stringify(sent.options));
  check('native create: the browser\'s own create was not called', ctx.calls.length === 0, JSON.stringify(ctx.calls));
  ctx.cred = cred;
  check('native create: result instanceof PublicKeyCredential and Credential', run(ctx, 'cred instanceof PublicKeyCredential && cred instanceof Credential'), '');
  check('native create: id, type, rawId, attachment', run(ctx, `cred.id`) === b64u(credId) && run(ctx, 'cred.type') === 'public-key' && run(ctx, 'cred.rawId instanceof ArrayBuffer && cred.rawId.byteLength') === credId.length && run(ctx, 'cred.authenticatorAttachment') === 'platform', '');
  check('native create: rawId is the same object each time ([SameObject])', run(ctx, 'cred.rawId === cred.rawId'), '');
  check('native create: response is an AuthenticatorAttestationResponse', run(ctx, 'cred.response instanceof AuthenticatorAttestationResponse && cred.response instanceof AuthenticatorResponse'), '');
  check('native create: getTransports / getPublicKeyAlgorithm / getPublicKey / getAuthenticatorData', JSON.stringify(run(ctx, 'cred.response.getTransports()')) === '["internal"]' && run(ctx, 'cred.response.getPublicKeyAlgorithm()') === -7 && run(ctx, 'cred.response.getPublicKey().byteLength') === 3 && run(ctx, 'cred.response.getAuthenticatorData().byteLength') === 37, '');
  check('native create: attestationObject and clientDataJSON are ArrayBuffers with the bytes sent', run(ctx, 'cred.response.attestationObject instanceof ArrayBuffer && cred.response.clientDataJSON instanceof ArrayBuffer && String.fromCharCode(...new Uint8Array(cred.response.clientDataJSON))') === '{"type":"webauthn.create"}', '');
  check('native create: getClientExtensionResults gives credProps and prf results as ArrayBuffers', run(ctx, 'const x = cred.getClientExtensionResults(); x.credProps.rk === true && x.prf.enabled === true && x.prf.results.first instanceof ArrayBuffer && x.prf.results.first.byteLength === 32'), '');
  const json = run(ctx, 'JSON.parse(JSON.stringify(cred))');
  check('native create: toJSON is a RegistrationResponseJSON', json.id === b64u(credId) && json.rawId === b64u(credId) && json.type === 'public-key' && json.response.attestationObject === b64u([0xa0]) && json.response.publicKeyAlgorithm === -7 && json.clientExtensionResults.prf.results.first === b64u(Buffer.alloc(32, 5)), JSON.stringify(json));
  check('native create: a getter on a foreign object throws Illegal invocation', /Illegal invocation/.test(run(ctx, `try { Object.getOwnPropertyDescriptor(PublicKeyCredential.prototype, 'id').get.call({}); 'no' } catch (e) { e.message }`)), '');
  check('native create: cred.id does not reach Credential.prototype\'s native getter', run(ctx, 'typeof cred.id') === 'string', '');

  // get
  const assertion = await run(ctx, `navigator.credentials.get({ publicKey: { challenge: chal, rpId: 'example.com', allowCredentials: [{ type: 'public-key', id: new Uint8Array([1]) }], userVerification: 'preferred', extensions: { appid: 'https://example.com/a' } } })`);
  ctx.a = assertion;
  const gs = requests[1];
  check('native get: request carries rpId, allow list, appid', gs.kind === 'get' && gs.options.rpId === 'example.com' && gs.options.allowCredentials[0].id === b64u([1]) && gs.options.extensions.appid === 'https://example.com/a', JSON.stringify(gs.options));
  check('native get: result is an AuthenticatorAssertionResponse with signature and a null userHandle', run(ctx, 'a.response instanceof AuthenticatorAssertionResponse && a.response.signature.byteLength === 3 && a.response.userHandle === null && a.authenticatorAttachment === "cross-platform"'), '');
  check('native get: toJSON leaves out a null userHandle', !('userHandle' in run(ctx, 'a.toJSON()').response), '');

  // errors
  answer = () => ({ error: { name: 'InvalidStateError', message: 'excluded' } });
  const e1 = await settle(run(ctx, `navigator.credentials.create({ publicKey: { rp: { name: 'x' }, user: { id: uid, name: 'n', displayName: 'd' }, challenge: chal, pubKeyCredParams: [] } })`));
  check('native: an error from the main process becomes that DOMException', e1[0] === 'err' && e1[1].name === 'InvalidStateError' && e1[1] instanceof run(ctx, 'DOMException'), JSON.stringify(e1));
  answer = () => ({ error: { name: 'TypeError', message: 'bad' } });
  const e2 = await settle(run(ctx, `navigator.credentials.get({ publicKey: { challenge: chal } })`));
  check('native: a TypeError stays a TypeError', e2[0] === 'err' && e2[1] instanceof run(ctx, 'TypeError'), JSON.stringify(e2));
  const n = requests.length;
  const e3 = await settle(run(ctx, `navigator.credentials.create({ publicKey: { rp: { name: 'x' }, user: { id: uid, name: 'n', displayName: 'd' }, pubKeyCredParams: [] } })`));
  check('native: a missing challenge is a TypeError before anything is sent', e3[0] === 'err' && e3[1].name === 'TypeError' && requests.length === n, JSON.stringify(e3));
  const e4 = await settle(run(ctx, `navigator.credentials.create({ publicKey: { rp: { name: 'x' }, user: { id: 'not bytes', name: 'n', displayName: 'd' }, challenge: chal, pubKeyCredParams: [] } })`));
  check('native: a string where bytes belong is a TypeError', e4[0] === 'err' && e4[1].name === 'TypeError' && requests.length === n, JSON.stringify(e4));
  const e5 = await settle(run(ctx, `navigator.credentials.get({ mediation: 'conditional', publicKey: { challenge: chal } })`));
  check('native: conditional mediation is refused (TypeError), never a silent hang', e5[0] === 'err' && e5[1].name === 'TypeError' && requests.length === n, JSON.stringify(e5));
  answer = () => { throw new Error('ipc broke'); };
  const e6 = await settle(run(ctx, `navigator.credentials.get({ publicKey: { challenge: chal } })`));
  check('native: a broken bridge is NotAllowedError, not a hang', e6[0] === 'err' && e6[1].name === 'NotAllowedError', JSON.stringify(e6));

  // abort
  answer = null; // hangs like a dialog the user hasn't answered
  const before = requests.length;
  const aborted = run(ctx, `(() => { const c = new AbortController(); const p = navigator.credentials.get({ publicKey: { challenge: chal }, signal: c.signal }); globalThis.ctl = c; return p; })()`);
  run(ctx, 'ctl.abort()');
  const ab = await settle(aborted);
  check('native: AbortSignal rejects with the signal\'s reason (AbortError) at once', ab[0] === 'err' && ab[1].name === 'AbortError', JSON.stringify(ab));
  check('native: and asks the main process to cancel that request', cancels.length === 1 && cancels[0] === requests[before].id, JSON.stringify(cancels));
  const pre = await settle(run(ctx, `(() => { const c = new AbortController(); c.abort(); return navigator.credentials.get({ publicKey: { challenge: chal }, signal: c.signal }); })()`));
  check('native: an already-aborted signal rejects without a request', pre[0] === 'err' && pre[1].name === 'AbortError' && requests.length === before + 1, JSON.stringify(pre));

  // everything else is the browser's
  const pw = await settle(run(ctx, `navigator.credentials.get({ password: true })`));
  check('native: a password request still reaches the browser', pw[0] === 'ok' && pw[1] === 'real', JSON.stringify(pw));

  // parse*FromJSON
  const parsed = run(ctx, `PublicKeyCredential.parseCreationOptionsFromJSON({ rp: { name: 'x' }, user: { id: '${b64u(userId)}', name: 'n', displayName: 'd' }, challenge: '${b64u(challenge)}', pubKeyCredParams: [], excludeCredentials: [{ type: 'public-key', id: 'AQID' }] })`);
  ctx.po = parsed;
  check('parseCreationOptionsFromJSON turns base64url into ArrayBuffers', run(ctx, 'po.challenge instanceof ArrayBuffer && po.challenge.byteLength === 32 && po.user.id.byteLength === 9 && po.excludeCredentials[0].id.byteLength === 3'), '');
  check('parseRequestOptionsFromJSON with bad base64url throws EncodingError', /EncodingError/.test(run(ctx, `try { PublicKeyCredential.parseRequestOptionsFromJSON({ challenge: '***' }); 'no' } catch (e) { e.name }`)), '');

  // ================= the generated preload, and its registration =================
  const { bundle } = require('../scripts/bundle-webauthn-preload');
  const pre2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'webauthn-preload.js'), 'utf8').replace(/\r\n/g, '\n');
  check('preload/webauthn-preload.js is up to date (node scripts/bundle-webauthn-preload.js)', pre2 === bundle(), 'run the bundle script');
  check('preload: hide is the fallback when the main process says nothing or anything fails', /mode && mode\.mode === 'native'/.test(pre2) && /catch \(err\)[\s\S]*func: hideWebAuthn/.test(pre2), '');
  check('preload: only electron is required (sandboxed)', (pre2.match(/require\(/g) || []).length === 1, '');

  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check('main.js registers the preload on 3 sessions (default, private, research)', (main.match(/id: 'lumen-webauthn-gate'/g) || []).length === 3, String((main.match(/lumen-webauthn-gate/g) || []).length));
  check("no 'publickey-credentials' permissions-policy header injected", !/publickey-credentials/.test(main), '');

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
