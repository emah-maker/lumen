// Pure unit test for browser/webauthn-gate.js (Electron cannot show the passkey / Windows Hello / security-key prompt, so
// WebAuthn is hidden from pages: otherwise Microsoft's sign-in waits forever on a dead prompt) and its registration in
// main.js. No Electron, no window.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { hideWebAuthn } = require('../src/browser/webauthn-gate');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

// A page: PublicKeyCredential, and a CredentialsContainer whose create/get hang like Electron's do.
function page() {
  const calls = [];
  const ctx = vm.createContext({ calls });
  vm.runInContext(`
    class DOMException extends Error { constructor(m, n) { super(m); this.name = n; } }
    globalThis.DOMException = DOMException;
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
const settle = (p) => Promise.race([p.then((v) => ['ok', v], (e) => ['err', e]), new Promise((r) => setTimeout(() => r(['pending']), 50))]);

(async () => {
  const ctx = page();
  run(ctx, `(${hideWebAuthn.toString()})()`);
  check('PublicKeyCredential is gone (sites then offer password / code instead of a passkey)', run(ctx, `typeof PublicKeyCredential`) === 'undefined', '');
  check("'PublicKeyCredential' in window is false", run(ctx, `'PublicKeyCredential' in window`) === false, '');

  const c = await settle(run(ctx, `navigator.credentials.create({ publicKey: { challenge: new Uint8Array(1) } })`));
  check('create({publicKey}) rejects at once with NotSupportedError, not a hang', c[0] === 'err' && c[1].name === 'NotSupportedError', JSON.stringify(c[0]));
  const g = await settle(run(ctx, `navigator.credentials.get({ publicKey: { challenge: new Uint8Array(1) } })`));
  check('get({publicKey}) rejects at once with NotSupportedError', g[0] === 'err' && g[1].name === 'NotSupportedError', JSON.stringify(g[0]));
  check('the native create/get were never reached for publicKey calls', ctx.calls.length === 0, JSON.stringify(ctx.calls));

  const pw = await settle(run(ctx, `navigator.credentials.get({ password: true })`));
  check('other credential requests (password) still reach the browser', pw[0] === 'ok' && pw[1] === 'real' && ctx.calls.length === 1, JSON.stringify(pw));
  check('create/get still look native', /native code/.test(run(ctx, `CredentialsContainer.prototype.get.toString()`)), '');
  check('a missing CredentialsContainer does not throw', (() => { const x = vm.createContext({}); vm.runInContext(`globalThis.window = globalThis; (${hideWebAuthn.toString()})()`, x); return true; })(), '');

  // The preload carries its own copy of the function (a sandboxed preload can only require 'electron'): same body.
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'webauthn-preload.js'), 'utf8');
  const m = pre.match(/function hideWebAuthn\(\) \{[\s\S]*?\r?\n\}\r?\n/);
  check('preload/webauthn-preload.js has the same hideWebAuthn as browser/webauthn-gate.js', m && norm(m[0]) === norm(hideWebAuthn.toString()), 'copies differ');

  // main.js registers it for tabs, private windows and the AI reader session.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  check('main.js registers the gate on 3 sessions (default, private, reader)', (main.match(/id: 'lumen-webauthn-gate'/g) || []).length === 3, String((main.match(/lumen-webauthn-gate/g) || []).length));
  // And nothing switches the feature back on or blocks the permissions policy for it.
  check("no 'publickey-credentials' permissions-policy header injected", !/publickey-credentials/.test(main), '');

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
