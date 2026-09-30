// Lumen's own Google OAuth client (type "Desktop app"), for a one-click "Sign in with Google" on the
// Gmail widget: no Google Cloud Console step for the user. Google lets installed apps ship their
// client ID and its client secret (RFC 8252 section 8.5: an installed app's secret is not
// confidential); the sign-in still uses PKCE and a one-shot 127.0.0.1 redirect (features/oauth.js).
//
// The one place it is read from, in order:
//   1. LUMEN_GOOGLE_CLIENT_ID / LUMEN_GOOGLE_CLIENT_SECRET in the environment (development, or a
//      self-built copy),
//   2. features/google-client.json, written by scripts/build.js from the same two variables at build
//      time (the release workflow passes them from repository secrets) and never committed.
// With neither, there is no built-in client and Settings shows the paste-your-own-client flow as
// before. A client the user pasted (Settings > Gmail > Advanced) always wins over the built-in one.
//
// Pure apart from reading the environment and that one file; no Electron, no network.
'use strict';

const GV = require('./gmail-view');

let FILE = {};
try { FILE = require('./google-client.json'); } catch { /* not built with one */ }

// A { clientId, clientSecret } pair, or null when either half is missing or doesn't look right.
// The two halves always come from the same source (an id from the environment is never paired with
// the file's secret).
function pairOf(id, secret) {
  const clientId = GV.cleanClientId(id);
  const clientSecret = GV.cleanClientSecret(secret);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
function builtinClient({ env = process.env, file = FILE } = {}) {
  return pairOf(env?.LUMEN_GOOGLE_CLIENT_ID, env?.LUMEN_GOOGLE_CLIENT_SECRET) || pairOf(file?.clientId, file?.clientSecret);
}

// Which client signs in. clientId / clientSecret: what the user gave (Settings' Advanced fields, or a
// widget's saved Client ID); stored: the encrypted blob's { clientId, clientSecret } (a secret typed
// earlier for the same id is reused); builtin: builtinClient().
//   -> { source: 'own' | 'builtin', clientId, clientSecret }
//   -> { error: 'badId' | 'badSecret' | 'noSecret' | 'noClient' } when it can't sign in yet
function resolveClient({ clientId, clientSecret, stored, builtin } = {}) {
  const rawId = typeof clientId === 'string' ? clientId.trim() : '';
  const id = GV.cleanClientId(rawId);
  if (rawId && !id) return { error: 'badId' };
  const typed = typeof clientSecret === 'string' ? clientSecret.trim() : '';
  if (id) {
    if (typed && !GV.cleanClientSecret(typed)) return { error: 'badSecret' };
    const secret = typed || (stored?.clientId === id ? GV.cleanClientSecret(stored.clientSecret) : '');
    return secret ? { source: 'own', clientId: id, clientSecret: secret } : { error: 'noSecret' };
  }
  if (builtin?.clientId && builtin.clientSecret) return { source: 'builtin', clientId: builtin.clientId, clientSecret: builtin.clientSecret };
  return { error: 'noClient' };
}

// What Settings and the new-tab card offer. oneClick: a sign-in can start right now without typing
// anything (the built-in client, or an own client whose secret is already stored). builtin: Lumen has
// its own client, so Settings leads with "Sign in with Google" and keeps the paste flow under Advanced.
function uiState({ clientId, stored, builtin } = {}) {
  const r = resolveClient({ clientId, stored, builtin });
  return { oneClick: !r.error, builtin: Boolean(builtin?.clientId && builtin.clientSecret), source: r.error ? 'none' : r.source };
}

const MESSAGES = {
  badId: 'Paste the Client ID of your Google Cloud OAuth client (it ends in .apps.googleusercontent.com).',
  badSecret: 'That doesn’t look like a Google client secret.',
  noSecret: 'Paste the client secret shown next to the Client ID in Google Cloud.',
  noClient: 'Paste the Client ID of your Google Cloud OAuth client (it ends in .apps.googleusercontent.com).',
};

module.exports = { builtinClient, resolveClient, uiState, MESSAGES };
