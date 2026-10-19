// Pure unit test for features/passkeys.js, the main-process side of passkeys (the security boundary): which frames get
// the API, which requests reach Windows, what Windows is handed (client data built from the frame's real origin),
// one ceremony at a time, gesture rules, cancellation, and that nothing sensitive is logged. Windows' WebAuthn and
// Electron are stand-ins; no window, no dialog.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createPasskeys } = require('../src/features/passkeys');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest();

// Everything printed while the suite runs, to prove no challenge or credential id is logged.
const printed = [];
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { printed.push(a.join(' ')); if (k === 'log' && /^(PASS|FAIL|\n)/.test(String(a[0]))) orig(...a); };
}

// ---- stand-ins
function fakeNative() {
  const calls = [];
  const n = {
    ok: true, api: 9, calls,
    hwndOf: (buf) => buf.readBigUInt64LE(0),
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
    next: null, // (kind, req) => { hr, result } | null to hang
    makeCredential: (hwnd, req) => op('create', hwnd, req),
    getAssertion: (hwnd, req) => op('get', hwnd, req),
  };
  function op(kind, hwnd, req) {
    const call = { kind, hwnd, req, cancelled: 0 };
    calls.push(call);
    let settle;
    const promise = new Promise((r) => { settle = r; });
    call.settle = settle;
    const out = n.next ? n.next(kind, req) : null;
    if (out) setImmediate(() => settle(out));
    return { promise, cancel() { call.cancelled++; setImmediate(() => settle({ hr: 0x800704C7, result: null })); } };
  }
  return n;
}
function frame(origin, url, parent = null, ids = [1, 1]) {
  return { origin, url, parent, processId: ids[0], routingId: ids[1], detached: false };
}
function wcOf(id = 1) {
  const wc = new EventEmitter();
  wc.id = id;
  wc.isDestroyed = () => false;
  return wc;
}
const win = { getNativeWindowHandle: () => { const b = Buffer.alloc(8); b.writeBigUInt64LE(0x1234n); return b; }, on() {}, removeListener() {} };

function setup({ enabled = true, native = fakeNative(), context = () => ({ ok: true, win, inPrivate: false }), candidate = () => true } = {}) {
  const handlers = {};
  const ipcMain = { on: (ch, fn) => { handlers[ch] = fn; }, handle: (ch, fn) => { handlers[ch] = fn; } };
  const state = { enabled };
  const pk = createPasskeys({ ipcMain, enabled: () => state.enabled, loadNative: () => native, context: (wc) => context(wc), candidate });
  pk.attach();
  const ask = (wc, f, msg) => handlers['webauthn:request']({ sender: wc, senderFrame: f }, msg);
  const cancel = (wc, f, id) => handlers['webauthn:cancel']({ sender: wc, senderFrame: f }, id);
  const mode = (wc) => { const e = { sender: wc }; handlers['webauthn:mode'](e); return e.returnValue; };
  return { pk, ask, cancel, mode, native, state, handlers };
}

const challenge = crypto.randomBytes(32);
const userId = crypto.randomBytes(16);
const credId = crypto.randomBytes(24);
const createOpts = (extra = {}) => ({ rp: { name: 'Example' }, user: { id: b64u(userId), name: 'a@example.com', displayName: 'A' }, challenge: b64u(challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], ...extra });
const getOpts = (extra = {}) => ({ challenge: b64u(challenge), ...extra });
const top = (origin = 'https://login.example.com', url = `${origin}/signin`) => frame(origin, url);
const gesture = { activation: true, policyGet: true, policyCreate: true };
const authData = (rpId) => Buffer.concat([sha(rpId), Buffer.from([0x05, 0, 0, 0, 1])]);
const okCreate = (rpId) => ({ hr: 0, result: { credentialId: credId, authenticatorData: authData(rpId), attestationObject: Buffer.from([0xa0]), usedTransport: 0x10, transports: 0x10, extensions: {} } });
const okGet = (rpId) => ({ hr: 0, result: { credentialId: credId, authenticatorData: authData(rpId), signature: Buffer.from('sig'), userHandle: userId, usedTransport: 0x10 } });

(async () => {
  // ---- modes
  {
    const s = setup();
    const m = s.mode(wcOf());
    check('mode: native with caps when Windows WebAuthn loads and the setting is on', m.mode === 'native' && m.caps && typeof m.caps.uvpaa === 'boolean' && m.caps.hybrid === true, JSON.stringify(m));
    s.state.enabled = false;
    check('mode: hide when the setting is off', s.mode(wcOf()).mode === 'hide', '');
    check('mode: hide when the native side is unavailable (macOS, Linux, old Windows, koffi missing)', setup({ native: { ok: false, reason: 'platform' } }).mode(wcOf()).mode === 'hide', '');
    check('mode: hide when the loader gives nothing', setup({ native: null }).mode(wcOf()).mode === 'hide', '');
    check('mode: hide for a page that is not a candidate (an AI page)', setup({ candidate: () => false }).mode(wcOf()).mode === 'hide', '');
    const dead = wcOf(); dead.isDestroyed = () => true;
    check('mode: hide for a destroyed page', setup().mode(dead).mode === 'hide', '');
    const throwing = { load() { throw new Error('boom'); } };
    check('mode: hide when the loader throws', createPasskeys({ ipcMain: { on() {}, handle() {} }, loadNative: () => throwing.load(), context: () => ({ ok: true }) })._modeFor(wcOf()).mode === 'hide', '');
  }

  // ---- a good create: what Windows is handed
  {
    const s = setup();
    s.native.next = (kind) => okCreate('example.com');
    const wc = wcOf();
    const f = top();
    const r = await s.ask(wc, f, { kind: 'create', id: 'r1', options: createOpts({ rp: { name: 'Example', id: 'example.com' }, origin: 'https://evil.com' }), frame: gesture });
    const call = s.native.calls[0];
    check('create: a request from the front tab reaches Windows', Boolean(call) && call.kind === 'create', JSON.stringify(r));
    check('create: the dialog belongs to the tab\'s window (HWND from getNativeWindowHandle)', call.hwnd === 0x1234n, String(call.hwnd));
    const cd = JSON.parse(call.req.clientDataJSON.toString());
    check('create: client data is built from the frame\'s real origin, not anything the page sent', cd.type === 'webauthn.create' && cd.origin === 'https://login.example.com' && cd.crossOrigin === false && cd.challenge === b64u(challenge), JSON.stringify(cd));
    check('create: rp id is the checked suffix', call.req.rp.id === 'example.com', call.req.rp.id);
    check('create: the page gets a credential back', r.value && r.value.id === b64u(credId) && r.value.response.clientDataJSON === b64u(call.req.clientDataJSON), JSON.stringify(r).slice(0, 200));
    check('create: busy is cleared afterwards', s.pk.busy() === false, '');
  }

  // ---- refusals that never reach Windows
  const refused = async (label, opts, expect, msgOver = {}, frameIn = null) => {
    const s = setup(opts);
    s.native.next = (kind) => (kind === 'create' ? okCreate('example.com') : okGet('example.com'));
    const r = await s.ask(wcOf(), frameIn || top(), { kind: 'get', id: 'x', options: getOpts(), frame: gesture, ...msgOver });
    check(label, r.error && r.error.name === expect && (s.native.calls || []).length === 0, JSON.stringify(r));
  };
  await refused('refused: the setting is off -> NotAllowedError', { enabled: false }, 'NotAllowedError');
  await refused('refused: native unavailable -> NotSupportedError', { native: { ok: false, reason: 'version' } }, 'NotSupportedError');
  await refused('refused: not the front tab of a focused window -> NotAllowedError', { context: () => ({ ok: false, reason: 'not-front' }) }, 'NotAllowedError');
  await refused('refused: a tab the AI is using / opened -> NotAllowedError', { context: () => ({ ok: false, reason: 'ai' }) }, 'NotAllowedError');
  await refused('refused: an AI page (not a candidate) -> NotAllowedError', { candidate: () => false }, 'NotAllowedError');
  await refused('refused: an IP-address page -> SecurityError', {}, 'SecurityError', {}, frame('https://10.0.0.5', 'https://10.0.0.5/'));
  await refused('refused: plain http page -> SecurityError', {}, 'SecurityError', {}, frame('http://example.com', 'http://example.com/'));
  await refused('refused: an opaque-origin (sandboxed) frame -> SecurityError', {}, 'SecurityError', {}, frame('null', 'about:srcdoc', top()));
  await refused('refused: rpId of another site -> SecurityError', {}, 'SecurityError', { options: getOpts({ rpId: 'evil.com' }) });
  await refused('refused: rpId that is a public suffix -> SecurityError', {}, 'SecurityError', { options: getOpts({ rpId: 'com' }) });
  await refused('refused: appid on another site -> SecurityError', {}, 'SecurityError', { options: getOpts({ extensions: { appid: 'https://evil.com/a' } }) });
  await refused('refused: an unknown kind', {}, 'NotAllowedError', { kind: 'store' });
  await refused('refused: an over-long request id', {}, 'NotAllowedError', { id: 'x'.repeat(65) });
  await refused('refused: the permission policy says no (top frame) -> NotAllowedError', {}, 'NotAllowedError', { frame: { activation: true, policyGet: false } });
  await refused('refused: malformed options -> TypeError', {}, 'TypeError', { options: { challenge: 42 } });

  // ---- frames
  {
    const parent = top('https://shop.com', 'https://shop.com/checkout');
    const idp = frame('https://pay.idp.com', 'https://pay.idp.com/frame', parent, [1, 2]);
    await refused('frames: a cross-origin iframe without the permission policy -> NotAllowedError', {}, 'NotAllowedError', { frame: { activation: true, policyGet: null } }, idp);
    await refused('frames: create in a cross-origin iframe without a gesture -> NotAllowedError', {}, 'NotAllowedError', { kind: 'create', options: createOpts(), frame: { activation: false, policyCreate: true } }, idp);
    await refused('frames: a cross-origin iframe inside an http page -> SecurityError', {}, 'SecurityError', { frame: gesture }, frame('https://pay.idp.com', 'https://pay.idp.com/f', frame('http://shop.example', 'http://shop.example/'), [1, 3]));
    const s = setup();
    s.native.next = () => okGet('pay.idp.com');
    const r = await s.ask(wcOf(), idp, { kind: 'get', id: 'f1', options: getOpts(), frame: { activation: true, policyGet: true } });
    const cd = JSON.parse(s.native.calls[0].req.clientDataJSON.toString());
    check('frames: an allowed cross-origin iframe gets crossOrigin true and the top origin in its client data', r.value && cd.crossOrigin === true && cd.topOrigin === 'https://shop.com' && cd.origin === 'https://pay.idp.com', JSON.stringify(cd));
    const same = frame('https://shop.com', 'https://shop.com/inner', parent, [1, 4]);
    const s2 = setup();
    s2.native.next = () => okGet('shop.com');
    const r2 = await s2.ask(wcOf(), same, { kind: 'get', id: 'f2', options: getOpts(), frame: { activation: true, policyGet: null } });
    check('frames: a same-origin iframe needs no explicit policy', Boolean(r2.value) && JSON.parse(s2.native.calls[0].req.clientDataJSON.toString()).crossOrigin === false, JSON.stringify(r2));
  }

  // ---- one at a time, gestures
  {
    const s = setup();
    s.native.next = null; // the dialog stays up
    const wc = wcOf();
    const f = top();
    const first = s.ask(wc, f, { kind: 'get', id: 'a', options: getOpts(), frame: gesture });
    await new Promise((r) => setImmediate(r));
    const second = await s.ask(wcOf(2), top('https://other.com'), { kind: 'get', id: 'b', options: getOpts(), frame: gesture });
    check('one at a time: a second request while a dialog is open -> NotAllowedError', second.error && second.error.name === 'NotAllowedError' && s.native.calls.length === 1, JSON.stringify(second));
    s.cancel(wcOf(3), f, 'a');
    await new Promise((r) => setImmediate(r));
    check('cancel: another page cannot cancel someone else\'s request', s.native.calls[0].cancelled === 0, '');
    s.cancel(wc, frame('https://login.example.com', 'x', null, [9, 9]), 'a');
    check('cancel: another frame of the same tab cannot either', s.native.calls[0].cancelled === 0, '');
    s.cancel(wc, f, 'wrong-id');
    check('cancel: a wrong id does nothing', s.native.calls[0].cancelled === 0, '');
    s.cancel(wc, f, 'a');
    const out = await first;
    check('cancel: the page\'s own AbortSignal asks Windows to cancel; the answer is NotAllowedError', s.native.calls[0].cancelled === 1 && out.error.name === 'NotAllowedError', JSON.stringify(out));
    await new Promise((r) => setImmediate(r));
    check('cancel: once Windows returns, the next request may start', s.pk.busy() === false, '');
  }
  {
    const s = setup();
    s.native.next = () => ({ hr: 0x800704C7, result: null });
    const wc = wcOf();
    const f = top();
    const r1 = await s.ask(wc, f, { kind: 'get', id: 'g1', options: getOpts(), frame: { activation: false } });
    check('gesture: a document\'s first ceremony may come without a click (cancelled by the user -> NotAllowedError)', s.native.calls.length === 1 && r1.error.name === 'NotAllowedError', JSON.stringify(r1));
    const r2 = await s.ask(wc, f, { kind: 'get', id: 'g2', options: getOpts(), frame: { activation: false } });
    check('gesture: the next one without a click is refused before Windows (no prompt spam)', s.native.calls.length === 1 && r2.error.name === 'NotAllowedError', JSON.stringify(r2));
    await s.ask(wc, f, { kind: 'get', id: 'g3', options: getOpts(), frame: { activation: true } });
    check('gesture: with a click it goes through', s.native.calls.length === 2, '');
    const f2 = frame('https://login.example.com', 'https://login.example.com/other', null, [1, 1]);
    await s.ask(wc, f2, { kind: 'get', id: 'g4', options: getOpts(), frame: { activation: false } });
    check('gesture: a new document in the frame gets its one again', s.native.calls.length === 3, '');
  }

  // ---- Windows' answers
  {
    const s = setup();
    s.native.next = () => ({ hr: 0x8009000F | 0, result: null });
    const r = await s.ask(wcOf(), top(), { kind: 'create', id: 'e1', options: createOpts(), frame: gesture });
    check('answer: NTE_EXISTS (excluded credential) -> InvalidStateError', r.error && r.error.name === 'InvalidStateError', JSON.stringify(r));
    s.native.next = () => okGet('evil.com');
    const r2 = await s.ask(wcOf(), top(), { kind: 'get', id: 'e2', options: getOpts(), frame: gesture });
    check('answer: authenticator data for another relying party is refused (NotAllowedError)', r2.error && r2.error.name === 'NotAllowedError', JSON.stringify(r2));
    s.native.next = () => ({ hr: 0, result: { ...okGet('www.example.com').result, appidUsed: true, authenticatorData: authData('https://www.example.com/appid') } });
    const r3 = await s.ask(wcOf(), top('https://www.example.com'), { kind: 'get', id: 'e3', options: getOpts({ extensions: { appid: 'https://www.example.com/appid' } }), frame: gesture });
    check('answer: a U2F credential answered for the appid is accepted, appid: true', r3.value && r3.value.clientExtensionResults.appid === true, JSON.stringify(r3).slice(0, 200));
    s.native.next = () => okGet('login.example.com');
    const f = top();
    const p = s.ask(wcOf(), f, { kind: 'get', id: 'e4', options: getOpts(), frame: gesture });
    f.origin = 'https://elsewhere.com'; // navigated while Windows was busy
    const r4 = await p;
    check('answer: a frame that navigated meanwhile gets nothing', r4.error && r4.error.name === 'NotAllowedError', JSON.stringify(r4));
  }

  // ---- page gone, private windows, timeout
  {
    const s = setup({ context: () => ({ ok: true, win, inPrivate: true }) });
    s.native.next = null;
    const wc = wcOf();
    const p = s.ask(wc, top(), { kind: 'create', id: 'p1', options: createOpts(), frame: gesture });
    await new Promise((r) => setImmediate(r));
    check('private: Windows is told it is a private window', s.native.calls[0].req.inPrivate === true, '');
    wc.emit('destroyed');
    const r = await p;
    check('page closed: the ceremony is cancelled', s.native.calls[0].cancelled === 1 && r.error.name === 'NotAllowedError', JSON.stringify(r));
  }
  {
    const s = setup();
    s.native.next = null;
    const wc = wcOf();
    const p = s.ask(wc, top(), { kind: 'get', id: 'n1', options: getOpts(), frame: gesture });
    await new Promise((r) => setImmediate(r));
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, frame: {} });
    check('navigation: another frame navigating does not cancel', s.native.calls[0].cancelled === 0, '');
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    check('navigation: a same-document (hash) navigation does not cancel', s.native.calls[0].cancelled === 0, '');
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    const r = await p;
    check('navigation: the page navigating away cancels', s.native.calls[0].cancelled === 1 && r.error.name === 'NotAllowedError', JSON.stringify(r));
  }
  {
    const realSetTimeout = global.setTimeout;
    const timers = [];
    global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
    const s = setup();
    s.native.next = null;
    const p = s.ask(wcOf(), top(), { kind: 'get', id: 't1', options: getOpts({ timeout: 20000 }), frame: gesture });
    global.setTimeout = realSetTimeout;
    await new Promise((r) => setImmediate(r));
    const t = timers.find((x) => x.ms >= 20000);
    check('timeout: Lumen keeps the page\'s timeout itself (Windows treats it as guidance)', Boolean(t) && t.ms === 22000, JSON.stringify(timers.map((x) => x.ms)));
    t.fn();
    const r = await p;
    check('timeout: when it passes, Windows is asked to cancel and the page gets NotAllowedError', s.native.calls[0].cancelled === 1 && r.error.name === 'NotAllowedError', JSON.stringify(r));
  }

  // ---- nothing sensitive was logged
  const all = printed.join('\n');
  const secrets = [b64u(challenge), challenge.toString('hex'), b64u(credId), credId.toString('hex'), b64u(userId)];
  check('logging: no challenge, credential id or user handle was printed', !secrets.some((x) => all.includes(x)), 'a secret was printed');

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
