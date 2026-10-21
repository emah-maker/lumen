// What the certificate warning page (cert-error.html) says went wrong, per Chromium's certificate error
// (net_error_list.h, -200 to -299, without "net::"). Anything not listed gets the general line. The wording is
// locales/en.json (certError.reason.*): reasonFor takes the translate function (window.t on the page; test/units/core-browsing-units.js
// passes one built from en.json). Loaded by cert-error.html and required by that test.
(function (root) {
  const KEYS = {
    ERR_CERT_AUTHORITY_INVALID: 'authorityInvalid',
    ERR_CERT_COMMON_NAME_INVALID: 'commonNameInvalid',
    ERR_CERT_DATE_INVALID: 'dateInvalid',
    ERR_CERT_REVOKED: 'revoked',
    ERR_CERT_WEAK_SIGNATURE_ALGORITHM: 'weakSignature',
    ERR_CERT_WEAK_KEY: 'weakKey',
    ERR_CERT_NAME_CONSTRAINT_VIOLATION: 'nameConstraint',
    ERR_CERT_VALIDITY_TOO_LONG: 'validityTooLong',
    ERR_CERT_NON_UNIQUE_NAME: 'nonUniqueName',
    ERR_CERT_NO_REVOCATION_MECHANISM: 'noRevocation',
    ERR_CERT_UNABLE_TO_CHECK_REVOCATION: 'unableToCheckRevocation',
    ERR_CERT_CONTAINS_ERRORS: 'containsErrors',
    ERR_CERT_INVALID: 'invalid',
    ERR_CERTIFICATE_TRANSPARENCY_REQUIRED: 'transparency',
    ERR_CERT_SYMANTEC_LEGACY: 'symantec',
    ERR_CERT_KNOWN_INTERCEPTION_BLOCKED: 'interception',
  };

  // `desc`: Chromium's error name, with or without "net::"; `t`: (key, vars) => text
  function reasonFor(desc, host, t = root.t) {
    const key = KEYS[String(desc || '').replace(/^net::/, '').toUpperCase()] || 'general';
    return t(`certError.reason.${key}`, { host: host || 'this site' });
  }

  const api = { reasonFor, KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.certReasons = api;
})(typeof window !== 'undefined' ? window : globalThis);
