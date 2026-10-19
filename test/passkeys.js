// Passkeys end to end (features/passkeys.js, browser/webauthn-gate.js, features/webauthn-windows.js) in a real Lumen
// with a throwaway profile and a local page on http://localhost (a secure context, relying party "localhost").
//
// Everywhere: the page gets the API in 'native' mode (or 'hide' with the setting off), and the main process turns
// down what it must before anything reaches Windows (an IP address, a foreign rpId, a tab in the background).
// On Windows with webauthn.dll: a real ceremony reaches the OS. navigator.credentials.get() for a security key
// (allowCredentials with a random id over USB, so no account and no credential is involved) brings up Windows
// Security owned by Lumen's window; the test finds that window (EnumWindows: class "Credential Dialog Xaml Host",
// owner = Lumen's HWND), checks Lumen stays responsive, then aborts (AbortController -> AbortError at once, the
// dialog closes) and lets a second one run out its timeout (-> NotAllowedError, the dialog closes). Nothing is
// completed: no PIN, no touch, no Windows Hello enrollment.
// With LUMEN_TEST_BACKGROUND=1 (windows never take focus) the ceremony part prints SKIP.
// LUMEN_TEST_PASSKEY_CREATE=1 also opens a create() dialog and aborts it. Off by default: on Windows 11 with a
// third-party passkey provider (1Password, ...) the "where to save this passkey" picker can ignore
// WebAuthNCancelCurrentOperation and stay up until someone closes it (Chromium's own calls show the same in the
// Microsoft-Windows-WebAuthN/Operational log).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PAGE = '<!doctype html><title>passkeys</title><button id="b">Sign in</button>';

// Top-level windows of the Windows credential UI owned by `owner` (an HWND as a decimal string).
function credentialDialogs(owner) {
  const ps = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class LumenCred {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public static List<string> Find(long owner) {
    var r = new List<string>();
    EnumWindows((h, l) => { var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == "Credential Dialog Xaml Host" && IsWindowVisible(h) && GetWindow(h, 4).ToInt64() == owner) { var t = new StringBuilder(256); GetWindowText(h, t, 256); r.Add(h + "|" + t); }
      return true; }, IntPtr.Zero);
    return r;
  }
}
"@
[LumenCred]::Find(${owner}) | ForEach-Object { $_ }`;
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20000, windowsHide: true }).split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const local = `http://localhost:${port}/`;
  const ip = `http://127.0.0.1:${port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-passkeys-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const waitFor = async (fn, ms = 6000, step = 150) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; };

  // The front tab: load a URL, run page script with a user gesture, read results the page parks on window.
  const front = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.id);
  const load = (url, id = null) => app.evaluate(async ({ webContents }, [u, i]) => {
    const wc = i ? webContents.fromId(i) : global.__agent.browser.activeTab().webContents;
    for (let n = 0; n < 3; n++) {
      try { await wc.loadURL(u); break; } catch { await new Promise((r) => setTimeout(r, 500)); } // (ERR_ABORTED: the new-tab page was still loading)
    }
    return wc.id;
  }, [url, id]);
  const page = (code, id = null) => app.evaluate(({ webContents }, [c, i]) => {
    const wc = i ? webContents.fromId(i) : global.__agent.browser.activeTab().webContents;
    return wc.executeJavaScript(c, true);
  }, [code, id]);
  // Start a ceremony in the page; its outcome lands in window.__out as { name, ms }.
  const start = (call, id = null) => page(`window.__out = null; window.__t0 = performance.now(); (${call}).then(
      (c) => { window.__out = { name: 'resolved', type: c && c.type, ms: performance.now() - window.__t0 }; },
      (e) => { window.__out = { name: e.name, message: e.message, ms: performance.now() - window.__t0 }; }); 1`, id);
  const outcome = (id = null) => page('window.__out', id);
  const focusWindow = () => app.evaluate(({ BrowserWindow }) => {
    const w = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0];
    w.show(); w.focus();
    return w.isFocused();
  });
  const hwnd = () => app.evaluate(({ BrowserWindow }) => {
    const w = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0];
    return w.getNativeWindowHandle().readBigUInt64LE(0).toString();
  });

  const info = await app.evaluate(() => global.__passkeys.info());
  console.log(`(passkeys on this machine: ${JSON.stringify(info)})`);
  const native = process.platform === 'win32' && info.available;

  // ---- the API a page sees
  await load(local);
  const api = await page(`({ pkc: typeof PublicKeyCredential, native: /native code/.test(navigator.credentials.create.toString()), aar: typeof AuthenticatorAttestationResponse })`);
  if (native) check('native mode: PublicKeyCredential and the response interfaces exist, create looks native', api.pkc === 'function' && api.native && api.aar === 'function', JSON.stringify(api));
  else check('hide mode (no Windows WebAuthn here): PublicKeyCredential is gone', api.pkc === 'undefined', JSON.stringify(api));
  if (native) {
    const statics = await page(`Promise.all([PublicKeyCredential.isConditionalMediationAvailable(), PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), PublicKeyCredential.getClientCapabilities()]).then(([c, u, caps]) => ({ c, u, caps }))`);
    check('isConditionalMediationAvailable() is false, isUVPAA is a boolean', statics.c === false && typeof statics.u === 'boolean', JSON.stringify(statics));
    check('getClientCapabilities() answers', statics.caps && statics.caps.conditionalGet === false && 'hybridTransport' in statics.caps, JSON.stringify(statics.caps));
    const iframe = await page(`new Promise((r) => { const f = document.createElement('iframe'); f.src = location.href; f.onload = () => r(typeof f.contentWindow.PublicKeyCredential); document.body.append(f); })`);
    check('a same-origin iframe gets the API too (frame preload)', iframe === 'function', iframe);
  }

  // ---- turned down before Windows is asked
  if (native) {
    await focusWindow();
    await start(`navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: 'example.com' } })`);
    const o1 = await waitFor(() => outcome(), 5000);
    check('a relying party id of another site -> SecurityError, no dialog', o1 && o1.name === 'SecurityError', JSON.stringify(o1));
    await load(ip);
    await start(`navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } })`);
    const o2 = await waitFor(() => outcome(), 5000);
    check('a page on an IP address -> SecurityError, no dialog', o2 && o2.name === 'SecurityError', JSON.stringify(o2));
    await load(local);

    // A tab in the background may not ask.
    const bgId = await app.evaluate((_e, u) => global.__passkeys.openBackground(u), local);
    await waitFor(() => page('document.readyState === "complete"', bgId).catch(() => false), 8000);
    await start(`navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } })`, bgId);
    const o3 = await waitFor(() => outcome(bgId), 5000);
    check('a tab in the background -> NotAllowedError, no dialog', o3 && o3.name === 'NotAllowedError', JSON.stringify(o3));
    const ctxBg = await app.evaluate((_e, id) => global.__passkeys.context(id), bgId);
    check('passkeyContext says the background tab is not in front', ctxBg && ctxBg.ok === false && ctxBg.reason === 'not-front', JSON.stringify(ctxBg));
    const ctxFront = await app.evaluate((_e, id) => global.__passkeys.context(id), await front());
    check('the front tab of the focused window may ask (passkeyContext)', ctxFront && ctxFront.ok === true, JSON.stringify(ctxFront));
  }

  // ---- the setting: off -> the API is hidden again (#195's behavior)
  await app.evaluate((_e) => global.__patchSettings({ passkeys: false }));
  await load(local);
  const off = await page(`({ pkc: typeof PublicKeyCredential })`);
  const offCall = await page(`navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } }).then(() => 'resolved', (e) => e.name)`);
  check('setting off: no PublicKeyCredential, publicKey calls fail at once with NotSupportedError', off.pkc === 'undefined' && offCall === 'NotSupportedError', `${JSON.stringify(off)} ${offCall}`);
  await app.evaluate((_e) => global.__patchSettings({ passkeys: true }));
  await load(local);

  // ---- a real ceremony reaches Windows (and is cancelled, never completed)
  if (native && process.env.LUMEN_TEST_BACKGROUND) {
    console.log('SKIP  the Windows Security ceremony checks (LUMEN_TEST_BACKGROUND: the window may not take focus)');
  } else if (native) {
    const focused = await focusWindow();
    const owner = await hwnd();
    console.log(`(Lumen window focused: ${focused}, HWND ${owner})`);
    const getCall = (extra) => `navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: 'localhost', userVerification: 'discouraged', allowCredentials: [{ type: 'public-key', id: crypto.getRandomValues(new Uint8Array(32)), transports: ['usb'] }]${extra} }${extra.includes('timeout') ? '' : ', signal: (window.__ctl = new AbortController()).signal'} })`;

    // 1. abort
    await start(getCall(''));
    const dialogs = await waitFor(() => credentialDialogs(owner).length ? credentialDialogs(owner) : null, 20000, 500);
    check('Windows Security comes up, owned by Lumen\'s window', Array.isArray(dialogs) && dialogs.length === 1, JSON.stringify(dialogs));
    const t0 = Date.now();
    const pong = await app.evaluate(() => 'pong');
    const uiPong = await ui.evaluate(() => document.querySelectorAll('.tab').length);
    check('Lumen stays responsive while the dialog is up (main process and UI answer)', pong === 'pong' && uiPong >= 1 && Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    check('the ceremony is pending (busy), the page has no answer yet', (await app.evaluate(() => global.__passkeys.busy())) === true && (await outcome()) === null, '');
    await page('window.__ctl.abort(); 1');
    const aborted = await waitFor(() => outcome(), 3000, 50);
    check('AbortController: the page gets AbortError at once', aborted && aborted.name === 'AbortError', JSON.stringify(aborted));
    const gone = await waitFor(async () => credentialDialogs(owner).length === 0 && !(await app.evaluate(() => global.__passkeys.busy())), 8000, 300);
    check('and Windows closes its dialog; Lumen is ready for the next request', gone === true, JSON.stringify(credentialDialogs(owner)));

    // 2. timeout -> NotAllowedError
    // (Windows gives the foreground back to whoever had it before the dialog: a person clicks Lumen again; the test focuses it.)
    await focusWindow();
    await start(getCall(', timeout: 15000'));
    const d2 = await waitFor(() => credentialDialogs(owner).length ? credentialDialogs(owner) : null, 20000, 500);
    check('a second request brings the dialog up again', Array.isArray(d2) && d2.length === 1, JSON.stringify(d2));
    const timedOut = await waitFor(() => outcome(), 30000, 250);
    check('when its timeout passes, the page gets NotAllowedError (about 17 s)', timedOut && timedOut.name === 'NotAllowedError' && timedOut.ms > 14000 && timedOut.ms < 25000, JSON.stringify(timedOut));
    const gone2 = await waitFor(async () => credentialDialogs(owner).length === 0, 8000, 300);
    check('and the dialog is gone', gone2 === true, JSON.stringify(credentialDialogs(owner)));
    check('Lumen still answers', (await app.evaluate(() => 'pong')) === 'pong', '');

    // 3. create (opt-in)
    if (process.env.LUMEN_TEST_PASSKEY_CREATE === '1') {
      await start(`navigator.credentials.create({ publicKey: { rp: { name: 'Lumen test' }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'test@example.test', displayName: 'Test' }, challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }] }, signal: (window.__ctl = new AbortController()).signal })`);
      const d3 = await waitFor(() => credentialDialogs(owner).length ? credentialDialogs(owner) : null, 20000, 500);
      check('create(): Windows Security comes up, owned by Lumen\'s window', Array.isArray(d3) && d3.length === 1, JSON.stringify(d3));
      await page('window.__ctl.abort(); 1');
      const a3 = await waitFor(() => outcome(), 3000, 50);
      check('create(): abort -> AbortError at once', a3 && a3.name === 'AbortError', JSON.stringify(a3));
      const gone3 = await waitFor(async () => credentialDialogs(owner).length === 0, 10000, 500);
      console.log(gone3 ? 'INFO  create(): Windows closed its dialog after the cancel' : 'WARN  create(): Windows left its passkey picker up after the cancel (close it by hand); see the note at the top');
    }
  } else {
    console.log('(no Windows WebAuthn here: the ceremony checks are skipped)');
  }

  await app.close().catch(() => {});
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
