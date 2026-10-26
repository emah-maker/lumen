// What the Microsoft connectors (outlook, onedrive, mscal) share: reading a Microsoft Graph answer, and saying what a failure means.
// Pure: no Electron, no network of its own (the provider's ctx.http does the request).
'use strict';
const { flat, ConnectorError } = require('../util');

// { code, message } out of a Graph error body ({ error: { code, message } }), or empty strings.
function errorOf(text) {
  try {
    const e = JSON.parse(text)?.error;
    return { code: flat(e?.code, 80), message: flat(e?.message, 200) };
  } catch { return { code: '', message: '' }; }
}

// The sentence for an answer that was not 2xx. `thing` names what was asked for ("that message").
function failure(ctx, res, { thing = 'that' } = {}) {
  const { code, message } = errorOf(res.text);
  const name = ctx.name || 'Microsoft';
  if (res.status === 429 || /TooManyRequests|ApplicationThrottled|ActivityLimitReached/i.test(code)) return new ConnectorError(`${name} is busy (rate limit). Try again in a minute.`, 'rate');
  if (res.status === 403 && /ErrorAccessDenied|Authorization_RequestDenied|AccessDenied/i.test(code)) return new ConnectorError(`Microsoft didn’t give Lumen that permission, or this account (a school’s administrator may limit it) can’t use it. Tell the user to connect ${name} again in Settings → Apps and connections and accept everything it asks.`, 'auth');
  if (res.status === 403 || res.status === 404) return new ConnectorError(`${name} can’t find ${thing}, or this account can’t use it.`, 'missing');
  if (res.status === 400) return new ConnectorError(`${name} didn’t accept that${message ? ` (${message})` : ''}.`, 'args');
  if (res.status === 401) return new ConnectorError(`Microsoft ended the ${name} sign-in. Ask the user to connect ${name} again in Settings → Apps and connections.`, 'auth');
  return new ConnectorError(`${name} answered ${res.status}${message ? ` (${message})` : ''}. Try again in a moment.`, 'other');
}

// The JSON of an answer that must be 2xx, else the failure above.
function json(ctx, res, opts) {
  if (!res.ok) throw failure(ctx, res, opts);
  try { return JSON.parse(res.text); } catch { throw new ConnectorError('Microsoft sent something Lumen couldn’t read.', 'other'); }
}

// A write that may have gone through: a request that failed in transit (no answer) or came back as a server error says so, and the AI is told
// to look before it tries again (Lumen never repeats the request).
function maybe(what, where) {
  return new ConnectorError(`The ${what} may have been made; check ${where} before trying again, and don’t make it again unless the user says it isn’t there.`, 'other');
}

// Runs a write's request; a failure in transit or a 5xx becomes `maybe`, anything else comes back for the caller to read.
async function send(what, where, request) {
  let res;
  try { res = await request(); } catch (err) {
    if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw maybe(what, where);
    throw err;
  }
  if (res.status >= 500 || res.status === 408) throw maybe(what, where);
  return res;
}

// A link Graph gave for the card's step: only an Outlook or Microsoft web address, never anything else it might say.
const WEB = /^https:\/\/(?:[a-z0-9-]+\.)*(?:office\.com|office365\.com|outlook\.com|live\.com|microsoft\.com|sharepoint\.com|1drv\.ms)\//i;
const webLink = (v) => (WEB.test(String(v || '')) ? String(v) : '');

module.exports = { errorOf, failure, json, maybe, send, webLink };
