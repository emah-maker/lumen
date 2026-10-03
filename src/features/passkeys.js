// Passkeys, Windows Hello and security keys (WebAuthn) for pages, through Windows' own WebAuthn API.
//
// The page side is browser/webauthn-gate.js (run in every frame by preload/webauthn-preload.js). This is the main
// process side, and the security boundary: the renderer is untrusted, so every request is checked here against facts
// the page can't choose.
//   - the origin is the sender frame's own (WebFrameMain.origin), https or http://localhost, never an IP address
//   - the relying party id is that host or a registrable-domain suffix of it, never a public suffix (tldts)
//   - a cross-origin iframe needs the publickey-credentials-get / -create permission policy (and, to create, a user
//     gesture), as Chrome requires; the client data says crossOrigin / topOrigin
//   - only a real tab may ask: the tab in front of its window, that window focused, visible and not minimized
//   - never a page the AI is working in or opened (agent windows, the AI's research tabs, a tab a run is using,
//     a signed-in-site tab the AI reads), so no AI tool can start or finish a ceremony, hands-off mode or not
//   - one ceremony at a time; a document gets one ceremony without a user gesture, the rest need one
//   - the client data (type, challenge, origin, crossOrigin) is built here; Windows signs over its hash
// Windows draws the dialog, owned by the tab's window, and keeps the credentials; Lumen stores nothing (a private
// window only tells Windows it is one). Nothing is logged but "available or not": no challenge, credential id,
// user handle or attestation ever reaches a console or a file.
'use strict';

const crypto = require('crypto');
const core = require('../browser/webauthn-core');

const NOT_ALLOWED = { name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' };

function createPasskeys(deps) {
  const {
    ipcMain,
    enabled = () => true, // Settings → Privacy "Use passkeys and security keys"
    loadNative = () => require('./webauthn-windows').load(), // lazily, Windows only
    parseDomain = (host) => require('tldts-experimental').parse(host, { allowPrivateDomains: true }),
    context, // (webContents) -> { ok, reason, win, inPrivate } (main.js passkeyContext)
    candidate = () => true, // (webContents) -> may this page get the API at all (a tab; not an AI page)
  } = deps;

  let native; // undefined: not tried yet; null: not available
  let status = { available: false, reason: 'not-loaded' };
  let uvpaa = null; // Windows Hello set up (isUserVerifyingPlatformAuthenticatorAvailable), asked once
  let pending = null; // the one ceremony running: { key, wcId, frameKey, id, op, finish }
  const documents = new Map(); // frameKey -> { url, ungestured } (a document's ceremony without a gesture)

  function nativeApi() {
    if (native !== undefined) return native;
    let r;
    try { r = loadNative(); } catch (err) { r = { ok: false, reason: 'error', detail: err.message }; }
    native = r && r.ok ? r : null;
    status = native ? { available: true, api: native.api } : { available: false, reason: (r && r.reason) || 'error' };
    if (!native && r && r.reason !== 'platform') console.warn(`[lumen] passkeys: Windows WebAuthn unavailable (${status.reason}); pages get no passkey API`);
    if (native) {
      native.isUserVerifyingPlatformAuthenticatorAvailable().then((v) => { uvpaa = Boolean(v); }, () => { uvpaa = false; });
    }
    return native;
  }
  // The capabilities a page is told about (PublicKeyCredential statics, getClientCapabilities).
  function caps() {
    const n = nativeApi();
    return { uvpaa: Boolean(uvpaa), hybrid: Boolean(n && n.api >= 6), prf: Boolean(n && n.api >= 6), largeBlob: Boolean(n && n.api >= 5) };
  }
  const usable = () => enabled() && Boolean(nativeApi());

  // ---- per frame: which mode (sync, once per document)
  function modeFor(wc) {
    try {
      if (!wc || wc.isDestroyed() || !usable() || !candidate(wc)) return { mode: 'hide' };
      return { mode: 'native', caps: caps() };
    } catch { return { mode: 'hide' }; }
  }

  const frameKey = (wc, frame) => `${wc.id}:${frame.processId}:${frame.routingId}`;
  function originsUp(frame) {
    const out = [];
    for (let f = frame, n = 0; f && n < 32; f = f.parent, n++) out.push(f.origin);
    return out;
  }

  // ---- one request. Returns { value } or { error: { name, message } }; never throws to the renderer.
  async function request(event, msg) {
    try {
      return await handle(event, msg);
    } catch (err) {
      if (err instanceof core.WebAuthnError) return { error: { name: err.name, message: err.message } };
      return { error: NOT_ALLOWED };
    }
  }

  async function handle(event, msg) {
    const wc = event.sender;
    const frame = event.senderFrame;
    if (!msg || typeof msg !== 'object' || (msg.kind !== 'create' && msg.kind !== 'get') || typeof msg.id !== 'string' || msg.id.length > 64) return { error: NOT_ALLOWED };
    if (!frame || !wc || wc.isDestroyed()) return { error: NOT_ALLOWED };
    if (!enabled()) return { error: { name: 'NotAllowedError', message: 'Passkeys are turned off in Lumen\'s settings.' } };
    const api = nativeApi();
    if (!api) return { error: { name: 'NotSupportedError', message: 'Passkeys are not available on this computer.' } };
    if (!candidate(wc)) return { error: NOT_ALLOWED };

    // Who asks: the frame's real origin, and its place in the page.
    const { origin, host } = core.checkOrigin(frame.origin);
    const chain = originsUp(frame);
    const { crossOrigin, topOrigin } = core.frameContext(chain);
    if (crossOrigin) core.checkOrigin(topOrigin); // an https page embedding an https frame, nothing less
    const facts = msg.frame && typeof msg.frame === 'object' ? msg.frame : {};
    const policy = msg.kind === 'create' ? facts.policyCreate : facts.policyGet;
    if (policy === false) return { error: { name: 'NotAllowedError', message: 'The publickey-credentials permission policy does not allow this frame.' } };
    if (crossOrigin && policy !== true) return { error: { name: 'NotAllowedError', message: 'A cross-origin frame needs the publickey-credentials permission policy.' } };
    const gesture = facts.activation === true;
    if (crossOrigin && msg.kind === 'create' && !gesture) return { error: { name: 'NotAllowedError', message: 'Creating a passkey in a cross-origin frame needs a user gesture.' } };

    // Where: the tab in front of a focused window, and nothing the AI is using.
    const ctx = context(wc);
    if (!ctx || !ctx.ok) return { error: NOT_ALLOWED };

    // How often: one ceremony at a time; a document's first may come without a gesture, the rest need one.
    if (pending) return { error: { name: 'NotAllowedError', message: 'A passkey request is already open.' } };
    const key = frameKey(wc, frame);
    const doc = documents.get(key);
    const url = frame.url;
    const state = doc && doc.url === url ? doc : { url, ungestured: 0 };
    documents.set(key, state);
    if (documents.size > 500) documents.delete(documents.keys().next().value);
    if (!gesture) {
      if (state.ungestured >= 1) return { error: { name: 'NotAllowedError', message: 'This request needs a click or a key press on the page first.' } };
      state.ungestured++;
    }

    // What: the relying party, the options, the client data.
    const o = msg.options;
    if (!o || typeof o !== 'object') throw new core.WebAuthnError('TypeError', 'publicKey options are required');
    let req;
    let clientData;
    let rpIdForHash;
    if (msg.kind === 'create') {
      const rpId = core.checkRpId(o.rp && typeof o.rp === 'object' && o.rp.id != null ? o.rp.id : null, host, parseDomain);
      req = core.toWindowsCreate(o, { rpId, inPrivate: ctx.inPrivate });
      clientData = core.clientDataJSON({ type: 'webauthn.create', challenge: req.challenge, origin, crossOrigin, topOrigin });
      rpIdForHash = rpId;
    } else {
      const rpId = core.checkRpId(o.rpId != null ? o.rpId : null, host, parseDomain);
      const ext = o.extensions && typeof o.extensions === 'object' ? o.extensions : {};
      const appid = ext.appid != null ? core.checkAppId(ext.appid, origin, host, parseDomain) : null;
      req = core.toWindowsGet(o, { rpId, inPrivate: ctx.inPrivate, appid });
      clientData = core.clientDataJSON({ type: 'webauthn.get', challenge: req.challenge, origin, crossOrigin, topOrigin });
      rpIdForHash = rpId;
    }
    req.clientDataJSON = clientData;

    const win = ctx.win;
    const hwnd = api.hwndOf(win.getNativeWindowHandle());
    return run(api, { kind: msg.kind, id: msg.id, wc, frame, key, win, hwnd, req, clientData, rpIdForHash, origin });
  }

  function run(api, r) {
    return new Promise((resolve) => {
      const op = r.kind === 'create' ? api.makeCredential(r.hwnd, r.req) : api.getAssertion(r.hwnd, r.req);
      let answered = false;
      const answer = (out) => { if (!answered) { answered = true; resolve(out); } };
      const listeners = [];
      const on = (emitter, name, fn) => { try { emitter.on(name, fn); listeners.push(() => { try { emitter.removeListener(name, fn); } catch {} }); } catch {} };
      // The page went away or asked to stop: Windows is asked to close its dialog; the page has its answer already.
      const stop = () => { op.cancel(); answer({ error: NOT_ALLOWED }); };
      const p = { wcId: r.wc.id, key: r.key, id: r.id, stop };
      pending = p;
      on(r.wc, 'destroyed', stop);
      on(r.wc, 'render-process-gone', stop);
      on(r.wc, 'did-start-navigation', (details) => { if (details && (details.isMainFrame || (details.frame && details.frame === r.frame))) { if (!details.isSameDocument) stop(); } });
      on(r.win, 'closed', stop);
      // The spec's timeout, whatever Windows makes of its own copy of it (it treats it as guidance).
      const timer = setTimeout(stop, r.req.timeout + 2000);
      op.promise.then((out) => {
        try {
          if (out.hr !== 0 || !out.result) { answer({ error: core.domErrorFor(out.hr) }); return; }
          // The frame must still be the document that asked, and the authenticator must have answered for this relying party.
          if (r.frame.detached || core.checkOrigin(r.frame.origin).origin !== r.origin) { answer({ error: NOT_ALLOWED }); return; }
          const hashFor = (id) => crypto.createHash('sha256').update(id).digest();
          const authData = out.result.authenticatorData;
          const expected = r.kind === 'get' && out.result.appidUsed ? hashFor(r.req.appid) : hashFor(r.rpIdForHash);
          if (!authData || authData.length < 37 || !authData.subarray(0, 32).equals(expected)) { answer({ error: NOT_ALLOWED }); return; }
          answer({ value: r.kind === 'create' ? core.createResult(out.result, r.req, r.clientData) : core.getResult(out.result, r.req, r.clientData) });
        } catch { answer({ error: NOT_ALLOWED }); }
      }, () => answer({ error: NOT_ALLOWED })).finally(() => {
        clearTimeout(timer);
        for (const off of listeners.splice(0)) off();
        if (pending === p) pending = null;
      });
    });
  }

  // The page's AbortSignal: only the frame that started a request can stop it.
  function cancel(event, id) {
    if (!pending || typeof id !== 'string' || !event.sender || !event.senderFrame) return;
    if (pending.wcId === event.sender.id && pending.key === frameKey(event.sender, event.senderFrame) && pending.id === id) pending.stop();
  }

  function attach() {
    ipcMain.on('webauthn:mode', (event) => { event.returnValue = modeFor(event.sender); });
    ipcMain.handle('webauthn:request', (event, msg) => request(event, msg));
    ipcMain.on('webauthn:cancel', (event, id) => cancel(event, id));
  }

  return {
    attach,
    // Load the native side early (Windows, setting on) so the first page already knows whether Windows Hello is set up.
    warm: () => { if (enabled()) nativeApi(); },
    // Settings → Privacy shows whether passkeys can work here.
    info: () => { if (process.platform === 'win32') nativeApi(); return { ...status, uvpaa: Boolean(uvpaa), platform: process.platform }; },
    busy: () => Boolean(pending),
    // tests
    _modeFor: modeFor, _request: request, _cancel: cancel,
  };
}

module.exports = { createPasskeys };
