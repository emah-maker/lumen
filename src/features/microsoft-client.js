// Lumen's own Microsoft Entra app registration (a public client: "Mobile and desktop applications", no secret), for a one-click
// "Sign in with Microsoft" on the Outlook, OneDrive and Microsoft Calendar connectors. A public client's ID is not a secret (RFC 8252: an installed
// app can't keep one); the sign-in uses PKCE and a one-shot loopback redirect (features/oauth.js).
//
// The one place it is read from, in order:
//   1. LUMEN_MS_CLIENT_ID in the environment (development, or a self-built copy),
//   2. features/microsoft-client.json, written by scripts/build/build.js from the same variable at build time (the release
//      workflow passes it from a repository secret) and never committed.
// With neither, there is no built-in client and the cards offer only "your own app (client) ID". A client ID typed on a card always wins.
//
// Pure apart from reading the environment and that one file; no Electron, no network.
'use strict';

let FILE = {};
try { FILE = require('./microsoft-client.json'); } catch { /* not built with one */ }

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Application (client) ID" of an Entra app: a GUID. '' when it isn't one.
const cleanClientId = (v) => { const s = typeof v === 'string' ? v.trim() : ''; return GUID.test(s) ? s.toLowerCase() : ''; };

// { clientId } or null.
function builtinClient({ env = process.env, file = FILE } = {}) {
  const id = cleanClientId(env?.LUMEN_MS_CLIENT_ID) || cleanClientId(file?.clientId);
  return id ? { clientId: id } : null;
}

module.exports = { builtinClient, cleanClientId, GUID };
