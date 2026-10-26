// What the Google connectors (drive, sheets, docs, calendar, tasks, contacts) share: reading a Google API answer, and saying what a failure means.
// Pure: no Electron, no network of its own (the provider's ctx.http does the request).
'use strict';
const { flat, ConnectorError } = require('../util');

// { reason, message } out of a Google error body ({ error: { code, message, status, errors: [{ reason }] } }), or empty strings.
function errorOf(text) {
  try {
    const e = JSON.parse(text)?.error;
    return { reason: flat(e?.errors?.[0]?.reason || e?.details?.[0]?.reason || e?.status, 60), message: flat(e?.message, 200) };
  } catch { return { reason: '', message: '' }; }
}

// The sentence for an answer that was not 2xx. `thing` names what was asked for ("that file"); `hint` is added to a 403/404 that
// is likely the app's own permission (an older Drive sign-in's drive.file only reaches files Lumen made).
function failure(ctx, res, { thing = 'that', hint = '' } = {}) {
  const { reason, message } = errorOf(res.text);
  const name = ctx.name || (ctx.id === 'sheets' ? 'Google Sheets' : 'Google Drive');
  if (res.status === 429 || /rateLimit|quota/i.test(reason)) return new ConnectorError(`${name} is busy (rate limit). Try again in a minute.`, 'rate');
  if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason)) return new ConnectorError(`The ${name} API isn’t turned on in the Google Cloud project Lumen signs in with. Tell the user: with their own Google Cloud client, enable the ${name} API there.`, 'other');
  if (res.status === 403 && /^insufficientPermissions$|SCOPE_INSUFFICIENT/i.test(reason)) return new ConnectorError(`Google didn’t give Lumen that permission. Tell the user to connect ${name} again in Settings → Apps and connections and allow everything it asks.`, 'auth');
  if (res.status === 403 || res.status === 404) return new ConnectorError(`${name} can’t find ${thing}, or this account can’t use it.${hint ? ` ${hint}` : ''}`, 'missing');
  if (res.status === 400) return new ConnectorError(`${name} didn’t accept that${message ? ` (${message})` : ''}.`, 'args');
  return new ConnectorError(`${name} answered ${res.status}${message ? ` (${message})` : ''}. Try again in a moment.`, 'other');
}

// The JSON of an answer that must be 2xx, else the failure above.
function json(ctx, res, opts) {
  if (!res.ok) throw failure(ctx, res, opts);
  try { return JSON.parse(res.text); } catch { throw new ConnectorError('Google sent something Lumen couldn’t read.', 'other'); }
}

// A write that may have gone through: a request that failed in transit (no answer) or came back as a server error says so, and the AI
// is told to look before it tries again (the request is never repeated by Lumen).
function maybe(what, where) {
  return new ConnectorError(`The ${what} may have been made; check ${where} before trying again, and don’t make it again unless the user says it isn’t there.`, 'other');
}

module.exports = { errorOf, failure, json, maybe };
