// Pure unit test for browser/webauthn-core.js: who may ask for which relying party, the client data Lumen builds,
// the page's options -> Windows' request, Windows' answers -> the page, and HRESULT -> DOMException names.
// No Electron, no Windows, no network.
const crypto = require('crypto');
const { parse } = require('tldts-experimental');
const core = require('../src/browser/webauthn-core');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const parseDomain = (h) => parse(h, { allowPrivateDomains: true });
const throwsName = (fn) => { try { fn(); return null; } catch (e) { return e.name; } };
const b64u = (b) => Buffer.from(b).toString('base64url');

// ---- origins
check('https origin is accepted', core.checkOrigin('https://login.example.com').host === 'login.example.com', '');
check('https origin with a port is accepted (the host is what counts)', core.checkOrigin('https://example.com:8443').host === 'example.com', '');
check('http://localhost is a secure context', core.checkOrigin('http://localhost:3000').host === 'localhost', '');
check('http://app.localhost is a secure context', core.checkOrigin('http://app.localhost').host === 'app.localhost', '');
check('plain http on a real host -> SecurityError', throwsName(() => core.checkOrigin('http://example.com')) === 'SecurityError', '');
check('opaque origin "null" -> SecurityError', throwsName(() => core.checkOrigin('null')) === 'SecurityError', '');
check('file: origin -> SecurityError', throwsName(() => core.checkOrigin('file://')) === 'SecurityError', '');
check('IPv4 address -> SecurityError', throwsName(() => core.checkOrigin('https://192.168.1.10')) === 'SecurityError', '');
check('http://127.0.0.1 -> SecurityError (an IP is never a relying party)', throwsName(() => core.checkOrigin('http://127.0.0.1:8080')) === 'SecurityError', '');
check('IPv6 address -> SecurityError', throwsName(() => core.checkOrigin('https://[::1]')) === 'SecurityError', '');
check('chrome-extension: origin -> SecurityError', throwsName(() => core.checkOrigin('chrome-extension://abcdef')) === 'SecurityError', '');
check('missing origin -> SecurityError', throwsName(() => core.checkOrigin(undefined)) === 'SecurityError', '');

// ---- relying party ids
const rp = (id, host) => core.checkRpId(id, host, parseDomain);
check('rpId defaults to the host', rp(null, 'login.example.com') === 'login.example.com', '');
check('rpId may be a registrable-domain suffix', rp('example.com', 'login.example.com') === 'example.com', '');
check('rpId may be a middle suffix', rp('b.example.com', 'a.b.example.com') === 'b.example.com', '');
check('rpId is case-insensitive', rp('Example.COM', 'login.example.com') === 'example.com', '');
check('rpId of another site -> SecurityError', throwsName(() => rp('evil.com', 'login.example.com')) === 'SecurityError', '');
check('rpId that only ends with the same letters -> SecurityError', throwsName(() => rp('ample.com', 'example.com')) === 'SecurityError', '');
check('rpId of a subdomain of the host -> SecurityError', throwsName(() => rp('sub.example.com', 'example.com')) === 'SecurityError', '');
check('rpId "com" (public suffix) -> SecurityError', throwsName(() => rp('com', 'example.com')) === 'SecurityError', '');
check('rpId "co.uk" (public suffix) -> SecurityError', throwsName(() => rp('co.uk', 'shop.example.co.uk')) === 'SecurityError', '');
check('rpId "github.io" (private public suffix) -> SecurityError', throwsName(() => rp('github.io', 'me.github.io')) === 'SecurityError', '');
check('rpId "me.github.io" for that site is fine', rp(null, 'me.github.io') === 'me.github.io', '');
check('rpId as an IP -> SecurityError', throwsName(() => rp('10.0.0.1', '10.0.0.1')) === 'SecurityError', '');
check('rpId with a port -> SecurityError', throwsName(() => rp('example.com:443', 'example.com')) === 'SecurityError', '');
check('rpId with a scheme -> SecurityError', throwsName(() => rp('https://example.com', 'example.com')) === 'SecurityError', '');
check('rpId with a trailing dot -> SecurityError', throwsName(() => rp('example.com.', 'example.com')) === 'SecurityError', '');
check('empty rpId -> SecurityError', throwsName(() => rp('', 'example.com')) === 'SecurityError', '');
check('rpId with spaces -> SecurityError', throwsName(() => rp(' example.com', 'example.com')) === 'SecurityError', '');
check('rpId "localhost" on localhost', rp(null, 'localhost') === 'localhost', '');
check('rpId "localhost" from app.localhost -> SecurityError', throwsName(() => rp('localhost', 'app.localhost')) === 'SecurityError', '');
check('rpId "app.localhost" on app.localhost', rp(null, 'app.localhost') === 'app.localhost', '');
check('IDN rpId is compared in punycode', rp('bücher.example', 'shop.xn--bcher-kva.example') === 'xn--bcher-kva.example', '');

// ---- appid (U2F credentials)
check('appid on the same site is accepted', core.checkAppId('https://www.example.com/appid.json', 'https://login.example.com', 'login.example.com', parseDomain) === 'https://www.example.com/appid.json', '');
check('appid on another site -> SecurityError', throwsName(() => core.checkAppId('https://evil.com/a', 'https://example.com', 'example.com', parseDomain)) === 'SecurityError', '');
check('appid over http -> SecurityError', throwsName(() => core.checkAppId('http://example.com/a', 'https://example.com', 'example.com', parseDomain)) === 'SecurityError', '');

// ---- frames
check('a top-level frame is not cross-origin', core.frameContext(['https://a.com']).crossOrigin === false, '');
check('a same-origin iframe is not cross-origin', core.frameContext(['https://a.com', 'https://a.com']).crossOrigin === false, '');
const xo = core.frameContext(['https://idp.com', 'https://shop.com']);
check('a cross-origin iframe is crossOrigin with the top origin', xo.crossOrigin === true && xo.topOrigin === 'https://shop.com', JSON.stringify(xo));
check('an iframe whose middle ancestor differs is cross-origin', core.frameContext(['https://a.com', 'https://b.com', 'https://a.com']).crossOrigin === true, '');

// ---- client data
const challenge = crypto.randomBytes(32);
const cd = core.clientDataJSON({ type: 'webauthn.create', challenge, origin: 'https://example.com', crossOrigin: false });
check('clientDataJSON has the spec member order', cd.toString() === `{"type":"webauthn.create","challenge":"${b64u(challenge)}","origin":"https://example.com","crossOrigin":false}`, cd.toString());
const cd2 = JSON.parse(core.clientDataJSON({ type: 'webauthn.get', challenge, origin: 'https://idp.com', crossOrigin: true, topOrigin: 'https://shop.com' }).toString());
check('cross-origin client data names the top origin', cd2.type === 'webauthn.get' && cd2.crossOrigin === true && cd2.topOrigin === 'https://shop.com', JSON.stringify(cd2));
check('clientDataJSON has no tokenBinding', !('tokenBinding' in cd2), '');
check('clientDataJSON challenge is base64url without padding', !/[=+/]/.test(JSON.parse(cd.toString()).challenge), '');
check('clientDataJSON refuses an unknown type', throwsName(() => core.clientDataJSON({ type: 'payment.get', challenge, origin: 'https://a.com' })) !== null, '');

// ---- create options -> Windows
const userId = crypto.randomBytes(16);
const baseCreate = () => ({
  rp: { name: 'Example' }, user: { id: b64u(userId), name: 'alice@example.com', displayName: 'Alice' },
  challenge: b64u(challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
});
const wc = core.toWindowsCreate({ ...baseCreate(), timeout: 60000, attestation: 'direct', excludeCredentials: [{ type: 'public-key', id: b64u(Buffer.from([1, 2, 3])), transports: ['usb', 'nfc', 'internal', 'bogus'] }], authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' }, hints: ['security-key', 'nope'] }, { rpId: 'example.com', inPrivate: true });
check('create: rp id is the checked one, name kept', wc.rp.id === 'example.com' && wc.rp.name === 'Example', JSON.stringify(wc.rp));
check('create: user id bytes survive the round trip', wc.user.id.equals(userId) && wc.user.name === 'alice@example.com' && wc.user.displayName === 'Alice', '');
check('create: challenge bytes survive', wc.challenge.equals(challenge), '');
check('create: algorithms in order', JSON.stringify(wc.algorithms) === '[-7,-257]', JSON.stringify(wc.algorithms));
check('create: exclude list with transports mask (usb|nfc|internal)', wc.excludeCredentials.length === 1 && wc.excludeCredentials[0].id.equals(Buffer.from([1, 2, 3])) && wc.excludeCredentials[0].transports === 0x13, JSON.stringify(wc.excludeCredentials));
check('create: platform attachment, rk required, uv required, direct attestation', wc.attachment === 1 && wc.requireResidentKey && !wc.preferResidentKey && wc.userVerification === 1 && wc.attestation === 3, JSON.stringify(wc));
check('create: unknown hints dropped', JSON.stringify(wc.hints) === '["security-key"]', JSON.stringify(wc.hints));
check('create: private window is passed on', wc.inPrivate === true, '');
check('create: timeout kept', wc.timeout === 60000, wc.timeout);
const d = core.toWindowsCreate(baseCreate(), { rpId: 'example.com' });
check('create defaults: any attachment, no rk, uv preferred, no attestation, 5 min', d.attachment === 0 && !d.requireResidentKey && !d.preferResidentKey && d.userVerification === 2 && d.attestation === 1 && d.timeout === 300000, JSON.stringify(d));
check('create: residentKey preferred -> preferResidentKey', core.toWindowsCreate({ ...baseCreate(), authenticatorSelection: { residentKey: 'preferred' } }, { rpId: 'x.com' }).preferResidentKey === true, '');
check('create: legacy requireResidentKey true -> required', core.toWindowsCreate({ ...baseCreate(), authenticatorSelection: { requireResidentKey: true } }, { rpId: 'x.com' }).requireResidentKey === true, '');
check('create: residentKey wins over requireResidentKey', core.toWindowsCreate({ ...baseCreate(), authenticatorSelection: { residentKey: 'discouraged', requireResidentKey: true } }, { rpId: 'x.com' }).requireResidentKey === false, '');
check('create: empty pubKeyCredParams -> ES256 and RS256', JSON.stringify(core.toWindowsCreate({ ...baseCreate(), pubKeyCredParams: [] }, { rpId: 'x.com' }).algorithms) === '[-7,-257]', '');
check('create: no usable algorithm -> NotSupportedError', throwsName(() => core.toWindowsCreate({ ...baseCreate(), pubKeyCredParams: [{ type: 'other', alg: -7 }] }, { rpId: 'x.com' })) === 'NotSupportedError', '');
check('create: enterprise attestation is asked as direct', core.toWindowsCreate({ ...baseCreate(), attestation: 'enterprise' }, { rpId: 'x.com' }).attestation === 3, '');
check('create: tiny timeout is clamped up to 15 s', core.toWindowsCreate({ ...baseCreate(), timeout: 5 }, { rpId: 'x.com' }).timeout === 15000, '');
check('create: huge timeout is clamped to 10 min', core.toWindowsCreate({ ...baseCreate(), timeout: 1e9 }, { rpId: 'x.com' }).timeout === 600000, '');
check('create: missing challenge -> TypeError', throwsName(() => core.toWindowsCreate({ ...baseCreate(), challenge: undefined }, { rpId: 'x.com' })) === 'TypeError', '');
check('create: missing user -> TypeError', throwsName(() => core.toWindowsCreate({ ...baseCreate(), user: undefined }, { rpId: 'x.com' })) === 'TypeError', '');
check('create: user.id over 64 bytes -> TypeError', throwsName(() => core.toWindowsCreate({ ...baseCreate(), user: { ...baseCreate().user, id: b64u(Buffer.alloc(65)) } }, { rpId: 'x.com' })) === 'TypeError', '');
check('create: empty user.id -> TypeError', throwsName(() => core.toWindowsCreate({ ...baseCreate(), user: { ...baseCreate().user, id: '' } }, { rpId: 'x.com' })) === 'TypeError', '');
check('create: non-base64url data -> TypeError', throwsName(() => core.toWindowsCreate({ ...baseCreate(), challenge: 'not base64!' }, { rpId: 'x.com' })) === 'TypeError', '');
const ext = core.toWindowsCreate({ ...baseCreate(), authenticatorSelection: { residentKey: 'required' }, extensions: { credProps: true, hmacCreateSecret: true, prf: { eval: { first: b64u(Buffer.alloc(32, 1)) } }, credentialProtectionPolicy: 'userVerificationRequired', enforceCredentialProtectionPolicy: true, largeBlob: { support: 'preferred' }, unknownExt: 1 } }, { rpId: 'x.com' });
check('create extensions: hmac-secret, credProtect, prf with eval, largeBlob preferred', ext.extensions.hmacSecret && ext.extensions.credProtect.policy === 3 && ext.extensions.credProtect.enforce && ext.prf && ext.prfEval.first.length === 32 && ext.largeBlob === 2, JSON.stringify(ext.extensions));
check('create extensions: what to report back is remembered', ext.wants.credProps && ext.wants.hmacCreateSecret && ext.wants.prf && ext.wants.largeBlob && ext.wants.credProtect, JSON.stringify(ext.wants));
check('create: largeBlob without a required resident key is not asked of Windows (it would refuse)', core.toWindowsCreate({ ...baseCreate(), extensions: { largeBlob: { support: 'required' } } }, { rpId: 'x.com' }).largeBlob === 0, '');
check('create: largeBlob read at create -> NotSupportedError', throwsName(() => core.toWindowsCreate({ ...baseCreate(), extensions: { largeBlob: { read: true } } }, { rpId: 'x.com' })) === 'NotSupportedError', '');
check('create: prf evalByCredential at create -> NotSupportedError', throwsName(() => core.toWindowsCreate({ ...baseCreate(), extensions: { prf: { evalByCredential: { AAAA: { first: 'AAAA' } } } } }, { rpId: 'x.com' })) === 'NotSupportedError', '');

// ---- get options -> Windows
const cid = crypto.randomBytes(20);
const g = core.toWindowsGet({ challenge: b64u(challenge), allowCredentials: [{ type: 'public-key', id: b64u(cid), transports: ['hybrid', 'internal'] }], userVerification: 'discouraged', timeout: 120000, hints: ['hybrid'], extensions: { prf: { eval: { first: b64u(Buffer.alloc(32, 2)) }, evalByCredential: { [b64u(cid)]: { first: b64u(Buffer.alloc(32, 3)), second: b64u(Buffer.alloc(32, 4)) } } }, largeBlob: { read: true } } }, { rpId: 'example.com', inPrivate: false, appid: 'https://example.com/appid' });
check('get: rpId, challenge, allow list with transports (hybrid|internal)', g.rpId === 'example.com' && g.challenge.equals(challenge) && g.allowCredentials[0].id.equals(cid) && g.allowCredentials[0].transports === 0x30, JSON.stringify(g.allowCredentials));
check('get: uv discouraged, timeout, hints', g.userVerification === 3 && g.timeout === 120000 && g.hints[0] === 'hybrid', '');
check('get: prf global and per-credential values', g.prf.global.first.length === 32 && g.prf.byCredential.length === 1 && g.prf.byCredential[0].id.equals(cid) && g.prf.byCredential[0].values.second.length === 32, '');
check('get: largeBlob read', g.largeBlob.operation === 1, '');
check('get: appid is passed on and reported', g.appid === 'https://example.com/appid' && g.wants.appid, '');
check('get: prf evalByCredential without allowCredentials -> NotSupportedError', throwsName(() => core.toWindowsGet({ challenge: b64u(challenge), extensions: { prf: { evalByCredential: { [b64u(cid)]: { first: 'AAAA' } } } } }, { rpId: 'x.com' })) === 'NotSupportedError', '');
check('get: prf evalByCredential for a credential not allowed -> SyntaxError', throwsName(() => core.toWindowsGet({ challenge: b64u(challenge), allowCredentials: [{ type: 'public-key', id: b64u(cid) }], extensions: { prf: { evalByCredential: { [b64u(Buffer.from('other'))]: { first: 'AAAA' } } } } }, { rpId: 'x.com' })) === 'SyntaxError', '');
check('get: largeBlob write needs exactly one allowed credential', throwsName(() => core.toWindowsGet({ challenge: b64u(challenge), extensions: { largeBlob: { write: 'AAAA' } } }, { rpId: 'x.com' })) === 'NotSupportedError', '');
const w = core.toWindowsGet({ challenge: b64u(challenge), allowCredentials: [{ type: 'public-key', id: b64u(cid) }], extensions: { largeBlob: { write: b64u(Buffer.from('blob')) } } }, { rpId: 'x.com' });
check('get: largeBlob write carries the blob', w.largeBlob.operation === 2 && w.largeBlob.blob.toString() === 'blob', '');
check('get: largeBlob support at get -> NotSupportedError', throwsName(() => core.toWindowsGet({ challenge: b64u(challenge), extensions: { largeBlob: { support: 'required' } } }, { rpId: 'x.com' })) === 'NotSupportedError', '');
check('get: missing challenge -> TypeError', throwsName(() => core.toWindowsGet({}, { rpId: 'x.com' })) === 'TypeError', '');
check('get: an empty credential id -> TypeError', throwsName(() => core.toWindowsGet({ challenge: b64u(challenge), allowCredentials: [{ type: 'public-key', id: '' }] }, { rpId: 'x.com' })) === 'TypeError', '');

// ---- Windows' answers -> the page (with a real P-256 key in the authenticator data)
const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const cbor = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const bstr = (b) => cbor([0x58, b.length], b);
const coseKey = cbor([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21], bstr(Buffer.from(jwk.x, 'base64url')), [0x22], bstr(Buffer.from(jwk.y, 'base64url')));
const rpIdHash = crypto.createHash('sha256').update('example.com').digest();
const credId = crypto.randomBytes(16);
const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), Buffer.from([0, 0, 0, 1]), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, coseKey]);
const parsed = core.parseAuthData(authData);
check('authenticator data: attested credential id parsed', parsed.credentialId.equals(credId) && parsed.signCount === 1, '');
const key = core.coseToSpki(parsed.cose);
check('COSE EC2 P-256 key -> SPKI DER that Node reads back as the same key', key.alg === -7 && crypto.createPublicKey({ key: key.spki, format: 'der', type: 'spki' }).export({ format: 'jwk' }).x === jwk.x, '');
const cr = core.createResult({ credentialId: credId, authenticatorData: authData, attestationObject: Buffer.from([0xa0]), usedTransport: 0x10, transports: 0x30, residentKey: true, prfEnabled: true, prfResults: null, largeBlobSupported: true, extensions: { 'hmac-secret': 1 } }, ext, cd);
check('create result: id, attachment platform, transports sorted names', cr.id === b64u(credId) && cr.authenticatorAttachment === 'platform' && JSON.stringify(cr.response.transports) === '["hybrid","internal"]', JSON.stringify(cr));
check('create result: client data, attestation object, public key and algorithm', cr.response.clientDataJSON === b64u(cd) && cr.response.attestationObject === b64u(Buffer.from([0xa0])) && cr.response.publicKey && cr.response.publicKeyAlgorithm === -7, '');
check('create result: credProps rk, hmacCreateSecret, prf enabled, largeBlob supported', cr.clientExtensionResults.credProps.rk === true && cr.clientExtensionResults.hmacCreateSecret === true && cr.clientExtensionResults.prf.enabled === true && cr.clientExtensionResults.largeBlob.supported === true, JSON.stringify(cr.clientExtensionResults));
check('create result: no extension results that were not asked for', !('appid' in cr.clientExtensionResults), '');
const cr2 = core.createResult({ credentialId: credId, authenticatorData: authData.subarray(0, 37), attestationObject: Buffer.from([0xa0]), usedTransport: 0x1, transports: 0 }, d, cd);
check('create result over USB: cross-platform, usb transport, no key -> publicKey null', cr2.authenticatorAttachment === 'cross-platform' && JSON.stringify(cr2.response.transports) === '["usb"]' && cr2.response.publicKey === null, JSON.stringify(cr2.response));
const gr = core.getResult({ credentialId: cid, authenticatorData: authData.subarray(0, 37), signature: Buffer.from('sig'), userHandle: userId, usedTransport: 0x20, prfResults: { first: Buffer.alloc(32, 9), second: null }, largeBlob: Buffer.from('lb'), largeBlobStatus: 1, appidUsed: false }, g, cd);
check('get result: id, signature, user handle, hybrid = cross-platform', gr.id === b64u(cid) && gr.response.signature === b64u(Buffer.from('sig')) && gr.response.userHandle === b64u(userId) && gr.authenticatorAttachment === 'cross-platform', JSON.stringify(gr));
check('get result: appid false, prf first result, large blob', gr.clientExtensionResults.appid === false && gr.clientExtensionResults.prf.results.first === b64u(Buffer.alloc(32, 9)) && gr.clientExtensionResults.largeBlob.blob === b64u(Buffer.from('lb')), JSON.stringify(gr.clientExtensionResults));
check('get result: an empty user handle is null', core.getResult({ credentialId: cid, authenticatorData: authData.subarray(0, 37), signature: Buffer.from('s'), userHandle: Buffer.alloc(0), usedTransport: 0 }, core.toWindowsGet({ challenge: b64u(challenge) }, { rpId: 'x.com' }), cd).response.userHandle === null, '');

// ---- HRESULTs
const name = (hr) => core.domErrorFor(hr).name;
check('NTE_EXISTS (excluded credential) -> InvalidStateError', name(0x8009000F) === 'InvalidStateError', '');
check('ERROR_CANCELLED -> NotAllowedError', name(0x800704C7) === 'NotAllowedError', '');
check('NTE_USER_CANCELLED -> NotAllowedError', name(0x80090036) === 'NotAllowedError', '');
check('ERROR_TIMEOUT -> NotAllowedError', name(0x800705B4) === 'NotAllowedError', '');
check('NTE_NOT_FOUND (no credential here) -> NotAllowedError, so a page cannot probe', name(0x80090011) === 'NotAllowedError', '');
check('NTE_INVALID_PARAMETER -> NotSupportedError', name(0x80090027) === 'NotSupportedError', '');
check('NTE_NOT_SUPPORTED -> NotSupportedError', name(0x80090029) === 'NotSupportedError', '');
check('a negative int32 HRESULT is read as unsigned', name(0x8009000F | 0) === 'InvalidStateError', '');
check('anything else -> NotAllowedError', name(0x80004005) === 'NotAllowedError', '');

// ---- base64url and CBOR edges
check('fromB64u refuses non-base64url', throwsName(() => core.fromB64u('a+b/')) === 'TypeError', '');
check('cbor reader refuses indefinite lengths', throwsName(() => core.cborRead(Buffer.from([0x9f]))) !== null, '');
check('cbor reader refuses a byte string past the end', throwsName(() => core.cborRead(Buffer.from([0x58, 10, 1, 2]))) !== null, '');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
