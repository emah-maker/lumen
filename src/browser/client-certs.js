// Which client certificate (TLS client authentication) a page gets, for Electron's 'select-client-certificate'.
//
// Electron's default, with no handler, is to send the FIRST certificate in the store without asking anyone. On Windows
// that can be a device key kept behind Windows Hello (an MS-Organization-Access certificate from another organization's
// work account, for example): Microsoft's sign-in page asks for a certificate, Windows pops a Windows Security face /
// PIN prompt for it, and the sign-in goes on as an account the user never picked. That happened on every Canvas read
// (Canvas -> login.microsoftonline.com), in a background AI tab the user wasn't even looking at.
//
// Like Chrome: nothing is sent unless the user picks it.
//   - a page nobody is watching (a tab the AI opened, a background task's work tab, an agent window) gets none, ever
//   - a user's own tab asks once per site for this run of Lumen; "Don't send" is the default and is remembered too
// Pure: Electron, the dialog and "is this the user's tab" come in as deps.
'use strict';

const MAX_CHOICES = 4; // certificates offered in the sheet (buttons), after "Don't send"

const hostOf = (url) => { try { return new URL(String(url)).host.toLowerCase(); } catch { return ''; } };
const day = (seconds) => { const d = new Date(Number(seconds) * 1000); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : ''; };

// "Alex Doe · MS-Organization-Access · until 2036-10-15"
function label(cert) {
  const c = cert || {};
  const who = String(c.subjectName || c.subject?.commonName || 'Certificate').slice(0, 60);
  const by = String(c.issuerName || c.issuer?.commonName || '').slice(0, 40);
  const until = day(c.validExpiry);
  return [who, by && by !== who ? by : '', until ? `until ${until}` : ''].filter(Boolean).join(' · ');
}

// deps: { isUserTab(wc), ask({ owner, host, labels }) -> Promise<index | -1> (-1: don't send) }
function createClientCerts({ isUserTab, ask }) {
  const picked = new Map(); // host -> fingerprint | null (null: don't send), for this run of Lumen
  const asking = new Map(); // host -> Promise<fingerprint | null> (one sheet per site at a time)

  async function choose(wc, url, list) {
    const certs = Array.isArray(list) ? list : [];
    if (!certs.length) return null;
    let watched = false;
    try { watched = Boolean(isUserTab(wc)); } catch { watched = false; }
    if (!watched) return null; // (AI tabs, background tasks, agent windows: never a certificate, never a prompt)
    const host = hostOf(url);
    if (!host) return null;
    const find = (fp) => (fp ? certs.find((c) => c && c.fingerprint === fp) || null : null);
    if (picked.has(host)) {
      const fp = picked.get(host);
      if (fp === null) return null;
      const again = find(fp);
      if (again) return again;
      picked.delete(host); // (that certificate is gone: ask again)
    }
    if (!asking.has(host)) {
      const offered = certs.slice(0, MAX_CHOICES);
      asking.set(host, Promise.resolve()
        .then(() => ask({ owner: wc, host, labels: offered.map(label) }))
        .then((i) => (Number.isInteger(i) && i >= 0 && i < offered.length ? offered[i].fingerprint || null : null), () => null)
        .then((fp) => { picked.set(host, fp); return fp; })
        .finally(() => asking.delete(host)));
    }
    return find(await asking.get(host));
  }

  // The 'select-client-certificate' handler (after event.preventDefault()): callback() with no certificate sends none.
  function select(wc, url, list, callback) {
    choose(wc, url, list).then((cert) => (cert ? callback(cert) : callback()), () => callback());
  }

  return { select, choose, forget: () => picked.clear() };
}

module.exports = { createClientCerts, label, hostOf, MAX_CHOICES };
