// Takes WebAuthn (passkeys, Windows Hello, security keys) away from every page, because Electron cannot show its
// prompt and the page would wait on it forever (browser/webauthn-gate.js says why). Registered session-wide as a
// 'frame' preload; the sandboxed preload may only require('electron'), so the function is serialized into the main world.
const { contextBridge } = require('electron');

// Same function as browser/webauthn-gate.js hideWebAuthn (kept in step by test/webauthn-gate-units.js).
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

try {
  contextBridge.executeInMainWorld({ func: hideWebAuthn });
} catch (err) {
  console.error('webauthn: could not hide the API:', err.message);
}
