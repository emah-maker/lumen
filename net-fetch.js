// The fetch the AI SDKs use. Electron's net.fetch goes through Chromium's network stack: Lumen's
// proxy setting, the system's proxy detection and its certificate store (a campus or VPN network
// that inspects TLS). Node's built-in fetch does none of that, so on such a network the browser
// loads openrouter.ai fine while the SDK gets "connection error". Outside Electron (the tests), or
// before the app is ready, it is Node's fetch.
function netFetch() {
  try {
    const { net, app } = require('electron');
    if (net && typeof net.fetch === 'function' && app?.isReady?.()) return (input, init) => net.fetch(input, init);
  } catch {}
  return globalThis.fetch;
}

module.exports = { netFetch };
