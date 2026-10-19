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
// verified: Google has approved the client's Gmail access (LUMEN_GOOGLE_VERIFIED at build time). Until then only
// accounts Google allows can use it, so Settings says so before the user tries.
function builtinClient({ env = process.env, file = FILE } = {}) {
  const fromEnv = pairOf(env?.LUMEN_GOOGLE_CLIENT_ID, env?.LUMEN_GOOGLE_CLIENT_SECRET);
  if (fromEnv) return { ...fromEnv, verified: env?.LUMEN_GOOGLE_VERIFIED === '1' };
  const fromFile = pairOf(file?.clientId, file?.clientSecret);
  return fromFile && { ...fromFile, verified: file?.verified === true };
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
  return { oneClick: !r.error, builtin: Boolean(builtin?.clientId && builtin.clientSecret), verified: Boolean(builtin?.verified), source: r.error ? 'none' : r.source };
}

const MESSAGES = {
  badId: 'Paste the Client ID of your Google Cloud OAuth client (it ends in .apps.googleusercontent.com).',
  badSecret: 'That doesn’t look like a Google client secret.',
  noSecret: 'Paste the client secret shown next to the Client ID in Google Cloud.',
  noClient: 'Paste the Client ID of your Google Cloud OAuth client (it ends in .apps.googleusercontent.com).',
};

// The file Google Cloud lets you download for an OAuth client ("Download JSON"), or its text pasted in, or
// the same two values as plain text -> { clientId, clientSecret }, or { error } saying what is wrong.
//   Desktop app clients are {"installed": {"client_id", "client_secret", ...}}; a Web application client
//   ({"web": ...}) can't sign in through Lumen's loopback address, so it is refused with that advice.
// Also accepts the bare client object, and "client_id: ... client_secret: ..." / "id<newline>secret" text.
const MAX_CLIENT_FILE = 20000;
function parseClientJson(input) {
  const text = typeof input === 'string' ? (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).trim() : '';
  if (!text) return { error: 'Drop the client JSON file from Google Cloud here, or paste its text.' };
  if (text.length > MAX_CLIENT_FILE) return { error: 'That is too big to be a Google client file.' };
  let obj = null;
  if (/^[[{]/.test(text)) {
    try { obj = JSON.parse(text); } catch { return { error: 'That looks like JSON but isn’t valid. Use the file Google Cloud downloads (client_secret_….json).' }; }
  }
  let client = null;
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj.web && typeof obj.web === 'object') return { error: 'That is a Web application client. Create one of type “Desktop app” instead; Lumen signs in on your own computer.' };
    client = obj.installed && typeof obj.installed === 'object' ? obj.installed : obj;
  } else if (!obj) {
    const id = /[0-9]+-[a-z0-9_]+\.apps\.googleusercontent\.com/i.exec(text)?.[0];
    const secret = /\b(GOCSPX-[A-Za-z0-9_-]{8,})/.exec(text)?.[1] || /secret\W{1,4}([A-Za-z0-9_-]{8,200})/i.exec(text)?.[1];
    client = { client_id: id, client_secret: secret };
  }
  const clientId = GV.cleanClientId(client?.client_id);
  const clientSecret = GV.cleanClientSecret(client?.client_secret);
  if (!clientId) return { error: 'No Google client ID found (it ends in .apps.googleusercontent.com).' };
  if (!clientSecret) return { error: 'No client secret found. Use the downloaded JSON file, which has both.' };
  return { clientId, clientSecret };
}

module.exports = { parseClientJson, builtinClient, resolveClient, uiState, MESSAGES };
