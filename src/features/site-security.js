// ---------- site security: certificate errors and the address bar's "not fully secure" state ----------
//
// Certificate errors. A page whose certificate fails (expired, self-signed, wrong name…) used to fall
// into the generic "Can't open this page". Now it gets renderer/cert-error.html, as in Chrome: "Back
// to safety", and under "Advanced" a way through. Going through is allowed for that host and that
// exact certificate only, until Lumen quits.
//
// The way through must be the user's choice, never the AI's or the page's. The warning page itself
// has no powers: its "Continue" link just loads the address again. What happens then is decided
// here, in 'certificate-error': when the warning page itself just asked for that address (a page-
// initiated navigation, seen in 'will-navigate'; loadURL, which the agent's navigate uses, never is),
// Lumen asks in its own dialog (features/dialogs.js), which is drawn in Lumen's UI, outside the tab, where neither
// page scripts, the sidebar agent's tools nor CDP automation can reach. Anything else that meets a
// bad certificate (a first visit, a redirect, the agent's navigate, a hidden reader tab) is refused.
//
// Mixed content. The lock used to trust the scheme alone. Each tab already has a debugger session
// (applyChromeIdentity in main.js); its Audits domain reports the mixed content Chromium finds. Most
// is upgraded to https or blocked outright, and the page stays secure; content that loaded over http
// anyway ("MixedContentWarning") makes the page "not fully secure". A page reached past a
// certificate error, or with a sub-resource let past one, is "not secure".
//
// deps: { dialogs, win: () => BrowserWindow|null, isTab(webContents) -> bool, certUrl }
const { URL } = require('url');

// Net errors that are certificate problems (net_error_list.h, -200 to -299). Some aren't worth a way
// through: a revoked certificate, or one the system flags as a known interception tool.
const isCertError = (code) => code <= -200 && code > -300;
const NO_PROCEED = new Set([-206 /* ERR_CERT_REVOKED */, -217 /* ERR_CERT_KNOWN_INTERCEPTION_BLOCKED */]);

function createSiteSecurity(deps) {
  const allowed = new Set(); // `${host}|${fingerprint}`: the user chose to go through, this run only
  const state = new Map(); // webContents id -> 'broken' | 'mixed' (absent: nothing to report)
  const proceeding = new Map(); // webContents id -> the address its warning page's Continue asked for
  const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

  // The warning page's address for a failed load, or null when it isn't a certificate error.
  function warningUrl(failedUrl, code, desc) {
    if (!isCertError(code) || !/^https:/i.test(failedUrl)) return null;
    const params = new URLSearchParams({ url: failedUrl, code: String(code), desc: desc || '' });
    if (NO_PROCEED.has(code)) params.set('final', '1');
    return `${deps.certUrl}?${params}`;
  }

  // Is this tab showing the warning page for exactly this address?
  function onWarningFor(wc, url) {
    const current = wc.getURL();
    if (!current.startsWith(deps.certUrl)) return false;
    try {
      const params = new URL(current).searchParams;
      return params.get('url') === url && !params.get('final');
    } catch { return false; }
  }

  function mark(wc, value) {
    if (value === 'mixed' && state.get(wc.id) === 'broken') return; // "not secure" outranks "not fully"
    if (state.get(wc.id) === value) return;
    state.set(wc.id, value);
    deps.onChange?.(wc);
  }

  // app.on('certificate-error'). Electron refuses unless preventDefault() is called and the callback
  // gets true; the callback may be answered later, and the load waits for it.
  function onCertificateError(event, wc, url, error, certificate, callback, isMainFrame) {
    const key = `${hostOf(url)}|${certificate?.fingerprint || ''}`;
    if (!deps.isTab(wc)) return; // hidden reader tabs, the UI, popups: refused (Electron's default)
    if (allowed.has(key)) {
      event.preventDefault();
      mark(wc, 'broken');
      callback(true);
      return;
    }
    // Anything but the warning page's own Continue is refused, and the tab shows the warning page.
    // (Asking for any load while the warning is up looped: the next load cancels the open question,
    // whose refusal loads the warning page, which cancels the next question…)
    const asked = proceeding.get(wc.id) === url;
    proceeding.delete(wc.id);
    if (!isMainFrame || !asked || !onWarningFor(wc, url)) return;
    event.preventDefault();
    const host = hostOf(url);
    deps.dialogs.showMessageBox(deps.win(), {
      type: 'warning',
      buttons: ['Cancel', 'Continue (unsafe)'],
      defaultId: 0,
      cancelId: 0,
      message: `Continue to ${host}?`,
      detail: `Lumen can't confirm this is the real ${host} (${error}). Someone may be trying to read or change what you send, such as passwords or card numbers. Lumen will allow this certificate for ${host} until you quit.`,
      owner: wc,
    }).then(({ response, cancelled }) => {
      const ok = response === 1 && !cancelled && !wc.isDestroyed();
      if (ok) { allowed.add(key); mark(wc, 'broken'); }
      callback(ok);
    }, () => callback(false));
  }

  // Every ordinary tab (after applyChromeIdentity attached the debugger).
  function attachTab(wc) {
    const id = wc.id;
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && state.delete(id)) deps.onChange?.(wc);
    });
    wc.on('will-navigate', (event) => {
      if (onWarningFor(wc, event.url)) proceeding.set(id, event.url);
      else proceeding.delete(id);
    });
    wc.once('destroyed', () => { state.delete(id); proceeding.delete(id); });
    if (!wc.debugger.isAttached()) return; // another debugger won; no mixed-content reports then
    const audit = (sessionId) => wc.debugger.sendCommand('Audits.enable', {}, sessionId).catch(() => {});
    wc.debugger.on('message', (_e, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') audit(params.sessionId);
      if (method !== 'Audits.issueAdded' || params.issue?.code !== 'MixedContentIssue') return;
      const details = params.issue.details?.mixedContentIssueDetails;
      if (details?.resolutionStatus !== 'MixedContentWarning') return; // upgraded or blocked: still secure
      // Only the page on screen now: an issue from before the last navigation doesn't count.
      const main = details.mainResourceURL || '';
      if (sessionId || main.split('#')[0] === wc.getURL().split('#')[0]) mark(wc, 'mixed');
    });
    audit();
  }

  return {
    warningUrl,
    onCertificateError,
    attachTab,
    stateOf: (wc) => state.get(wc.id) || null,
  };
}

module.exports = { createSiteSecurity, isCertError };
