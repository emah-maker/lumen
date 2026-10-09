// What the certificate warning page (cert-error.html) says went wrong, per Chromium's certificate error
// (net_error_list.h, -200 to -299, without "net::"). Anything not listed gets the general line. Loaded by
// cert-error.html and required by test/core-browsing-units.js.
(function (root) {
  const REASONS = {
    ERR_CERT_AUTHORITY_INVALID: () => 'Its certificate isn’t issued by an authority this computer trusts (for example, it’s self-signed).',
    ERR_CERT_COMMON_NAME_INVALID: (host) => `Its certificate is for a different site, not ${host}.`,
    ERR_CERT_DATE_INVALID: () => 'Its certificate has expired or isn’t valid yet. Check that your computer’s clock is right.',
    ERR_CERT_REVOKED: () => 'Its certificate has been revoked by the authority that issued it.',
    ERR_CERT_WEAK_SIGNATURE_ALGORITHM: () => 'Its certificate is signed with a weak algorithm.',
    ERR_CERT_WEAK_KEY: () => 'Its certificate uses a weak key.',
    ERR_CERT_NAME_CONSTRAINT_VIOLATION: () => 'Its certificate was issued for names that its authority isn’t allowed to vouch for.',
    ERR_CERT_VALIDITY_TOO_LONG: () => 'Its certificate is valid for longer than browsers accept.',
    ERR_CERT_NON_UNIQUE_NAME: (host) => `Its certificate is for a private name, not a public address like ${host}.`,
    ERR_CERT_NO_REVOCATION_MECHANISM: () => 'Its certificate has no way to check whether it was revoked.',
    ERR_CERT_UNABLE_TO_CHECK_REVOCATION: () => 'Lumen couldn’t check whether its certificate was revoked.',
    ERR_CERT_CONTAINS_ERRORS: () => 'Its certificate is malformed.',
    ERR_CERT_INVALID: () => 'Its certificate is invalid.',
    ERR_CERTIFICATE_TRANSPARENCY_REQUIRED: () => 'Its certificate isn’t in the public logs that browsers require.',
    ERR_CERT_SYMANTEC_LEGACY: () => 'Its certificate comes from an authority that browsers no longer trust.',
    ERR_CERT_KNOWN_INTERCEPTION_BLOCKED: () => 'Its certificate belongs to software that intercepts secure connections.',
  };
  const GENERAL = 'Its certificate couldn’t be verified.';

  // `desc`: Chromium's error name, with or without "net::"
  function reasonFor(desc, host) {
    const make = REASONS[String(desc || '').replace(/^net::/, '').toUpperCase()];
    return make ? make(host || 'this site') : GENERAL;
  }

  const api = { reasonFor, REASONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.certReasons = api;
})(typeof window !== 'undefined' ? window : globalThis);
