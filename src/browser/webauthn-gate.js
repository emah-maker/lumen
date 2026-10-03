// Passkeys / Windows Hello / security keys (WebAuthn) cannot complete in Electron, so pages must not be offered them.
//
// Electron's Chromium has no WebAuthn user interface (the authenticator-request dialog is part of Chrome, not of the
// content layer Electron embeds; see electron/electron#15404 and #27355). On Windows PublicKeyCredential exists and
// isUserVerifyingPlatformAuthenticatorAvailable() even answers true, but navigator.credentials.create/get({ publicKey })
// then never shows the Windows Security prompt and never settles, ignoring its own timeout. Microsoft's sign-in
// (login.microsoftonline.com, login.live.com, the Azure portal) sees the API, offers "Face, fingerprint, PIN or security
// key" and sits on that dead prompt. With the API absent a site falls back to what Lumen can do: password, the
// Authenticator app, a code. This takes the API away (the way FedCM's IdentityCredential is removed in
// preload/page-dialogs-preload.js) and makes a stray publicKey call fail at once instead of hanging.
// Pure (no Electron): test/webauthn-gate-units.js. preload/webauthn-preload.js runs it in every page's main world.
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

module.exports = { hideWebAuthn };
