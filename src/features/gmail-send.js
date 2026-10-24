// [connectors] Gmail sending: the rules for the AI's one way to send an email, built on the drafts code (gmail-drafts.js). Pure: no
// network and no Electron. Loaded only when a send is asked for (the registry hides the action until Settings → Connectors →
// Gmail → Allow sending is on).
//
// A send goes out in exactly two ways, and nothing else:
//   1. The approval card (From, To, Cc, Bcc, Subject, the whole text, the attachments) with Send and Cancel. Nothing goes until the
//      click. No "always allow"; Auto, Auto-allow and Bypass permissions never answer it.
//   2. Words the user typed in THIS chat that say it is fine: in the message itself ("email jane@x.org that I'll be late and send
//      it") or earlier in the chat ("you can send emails without asking"). Never read from a page, an email or a tool's answer
//      (only the text the user typed is looked at, see typedGrant), never taken from a permission mode, and only for that chat.
//      Even then every recipient must be an address the user typed (or the sender of the message they asked to reply to), or the
//      card is shown instead. Each such send waits 10 seconds with an Undo (hold).
// Background tasks and routines never send (the connector is read-only there). At most 10 sends an hour, each one logged.
//
//   sendPath(path)                 the one Gmail request a send makes (POST /users/me/messages/send), or throws
//   typedGrant({...})              { direct, mode, why }: may this send skip the card, from what the user typed
//   standingGrant(text) / oneOffGrant(text)   does one message of the user say sends are fine / ask for this send
//   warnings({...})                the card's lines about recipients the user didn't type
//   hold({ ms, timers, signal })   the undo window: { promise: 'go' | 'undo' | 'stop', undo() }
//   createLog({ file, now, secrets }) the send log (sealed on disk) and the hourly limit
'use strict';
const GD = require('./gmail-drafts');
const { readStoreFile, writeJsonAtomic } = require('../settings/settings-file'); // (a file that can't be read is kept aside, never overwritten)

const SEND_PATH = '/users/me/messages/send';
const MAX_PER_HOUR = 10;
const UNDO_MS = 10000;
const LOG_KEEP = 200;

class SendError extends Error {}

// The only Gmail API path a send goes to: the exact messages.send address, nothing else (a drafts path, drafts.send, a query).
function sendPath(p) {
  if (String(p || '') !== SEND_PATH) throw new SendError('Not the Gmail send request.');
  return SEND_PATH;
}

// The Sent folder in Gmail on the web, for the signed-in account.
const sentLink = (email) => (typeof email === 'string' && GD.ADDRESS.test(email.trim()) ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(email.trim())}#sent` : 'https://mail.google.com/mail/u/0/#sent');

// ---- what the user typed
const ADDRESS_IN_TEXT = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;
const addressesIn = (text) => new Set((String(text || '').match(ADDRESS_IN_TEXT) || []).map((a) => a.toLowerCase()));
const sentences = (text) => String(text || '').replace(/[‘’]/g, "'").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

const SEND = /\bsend(?:ing)?\b/i;
const MAIL = /\b(?:e-?mails?|mails?|messages?|repl(?:y|ies)|drafts?)\b/i;
// "don't send", "never email", "do not send": a refusal, never a grant (but "don't ask me", "no need to ask" are grants of a kind: see NO_ASK).
const REFUSAL = /\b(?:don'?t|do not|never|not)\b(?!\s+(?:need|have|ask|check|confirm|hesitate|wait|worry|bother))[^.!?\n]{0,30}\b(?:send|sending|email|mail)\b/i;
const NO_ASK = /\bwithout (?:asking|checking|confirming|approval|permission|my (?:approval|permission|confirmation|ok|okay)|(?:me )?(?:approving|reviewing|checking|confirming))\b|\b(?:don'?t|do not|never|no need to|need not|stop)\s+(?:need to |have to )?(?:ask(?:ing)?|check(?:ing)?|confirm(?:ing)?)(?:\s+(?:me|with me))?\s*(?:first|before|each time|every time|again|for (?:my )?(?:approval|permission|confirmation)|,|$)|\byou (?:don'?t|do not) need (?:my |to get my )?(?:approval|permission|confirmation|ok)\b/i;
const GRANT = /\b(?:you (?:can|may|are allowed to|'re allowed to|have (?:my )?permission to)|i (?:allow|permit|authori[sz]e) you to|feel free to|go ahead and|permission to|it'?s (?:ok|okay|fine) (?:for you )?to)\b/i;
// A sentence that reports or conditions what something says ("if the email says you can send…") is not the user's own grant.
const REPORTED = /^\s*(?:if|when|whenever|unless|suppose)\b|\b(?:ignore|says?|said|wrote|writes|claims?|asks? you)\b/i;
const MANY = /\b(?:e-?mails|mails|messages|replies|any (?:e-?mail|message|mail)|all|whatever|anything)\b/i;

// One sentence of a message that says the AI may send emails in this chat without asking each time ("you can send the emails without
// asking", "go ahead and send emails for me"). Not a question, not a refusal, and about sending email in general, not one email.
function standingGrant(text) {
  return sentences(text).some((s) => !/\?\s*$/.test(s) && SEND.test(s) && MAIL.test(s) && !REFUSAL.test(s) && !REPORTED.test(s) && (NO_ASK.test(s) || (GRANT.test(s) && MANY.test(s))));
}

const ONE_EMAIL = /\bsend\s+(?:it|that|this|them|the\s+(?:e-?mail|mail|message|reply|draft)|an?\s+(?:e-?mail|mail|message|reply)|(?:e-?mail|mail|message|reply)\b)/i;
const THEN_SEND = /\b(?:e-?mail|mail|message|reply to|reply|write to|tell|let|ask)\b[^.!?\n]*\b(?:and|then)\s+(?:just\s+)?send\b/i;
const JUST_SEND = /\bhit send\b|\bjust send\b/i;
const SELF = /\b(?:i|i'll|i will|i'm going to|i can|i'd|let me)\s+(?:just\s+|then\s+)?(?:send|hit send)\b|\b(?:send|sending)\b[^.!?\n]{0,25}\bmyself\b|\bmyself\b[^.!?\n]{0,25}\bsend/i;
// One sentence that asks for this email to be sent now ("email jane@x.org that I'll be late and send it"): not a question, not "don't
// send", not "before sending", not "I'll send it myself".
function oneOffGrant(text) {
  return sentences(text).some((s) => !/\?\s*$/.test(s) && (ONE_EMAIL.test(s) || THEN_SEND.test(s) || JUST_SEND.test(s)) && !REFUSAL.test(s) && !REPORTED.test(s) && !SELF.test(s) && !/\bbefore (?:you )?send/i.test(s));
}

const recipientsOf = (args) => {
  const out = [];
  for (const key of ['to', 'cc', 'bcc']) for (const a of GD.parseAddresses(args?.[key] || '', key)) out.push(a.address.toLowerCase());
  return out;
};

// May this send skip the card? `typed` is the user's own typed messages in this chat, oldest first (never page, email or tool text:
// the agent records what the user typed and nothing else). `standing`: an earlier message said sends are fine and the user hasn't
// pressed Stop. `replyAddress`: the sender of the message being replied to ("" for a new email).
function typedGrant({ typed = [], standing = false, args = {}, replyAddress = '' }) {
  let recipients;
  try { recipients = recipientsOf(args); } catch { return { direct: false, why: 'The recipients can’t be read.' }; }
  if (!recipients.length) return { direct: false, why: 'No recipient.' };
  const last = typed[typed.length - 1] || '';
  const mode = oneOffGrant(last) ? 'message' : standing ? 'chat' : '';
  if (!mode) return { direct: false, why: 'The user did not say to send it.' };
  const said = mode === 'message' ? last : typed.join('\n');
  const allowed = addressesIn(said);
  if (replyAddress && /\b(?:repl(?:y|ies|ying)|respond|answer|write back)\b/i.test(said)) allowed.add(String(replyAddress).toLowerCase());
  const stray = recipients.filter((r) => !allowed.has(r));
  if (stray.length) return { direct: false, why: `${stray[0]} is not an address the user typed.` };
  return { direct: true, mode };
}

// The card's warning: recipients the user didn't type in this chat. From a page, an email or another tool answer when the chat has
// read any (the AI may have copied them from there), else just not typed by the user.
function warnings({ typed = [], args = {}, replyAddress = '', tainted = false }) {
  let recipients;
  try { recipients = recipientsOf(args); } catch { return ''; }
  const known = addressesIn(typed.join('\n'));
  if (replyAddress) known.add(String(replyAddress).toLowerCase());
  const stray = [...new Set(recipients.filter((r) => !known.has(r)))];
  if (!stray.length) return '';
  const list = stray.slice(0, 5).join(', ') + (stray.length > 5 ? `, and ${stray.length - 5} more` : '');
  return tainted
    ? `Check the recipients: ${list} ${stray.length === 1 ? 'was' : 'were'} not typed by you. ${stray.length === 1 ? 'It' : 'They'} may have come from a web page, an email or other content the AI read.`
    : `Check the recipients: ${list} ${stray.length === 1 ? 'is' : 'are'} not ${stray.length === 1 ? 'an address' : 'addresses'} you typed in this chat.`;
}

// ---- the undo window
function hold({ ms = UNDO_MS, timers = { setTimeout: (f, n) => setTimeout(f, n), clearTimeout: (t) => clearTimeout(t) }, signal = null } = {}) {
  let finish;
  let timer = null;
  const promise = new Promise((resolve) => {
    finish = resolve;
    if (signal?.aborted) { resolve('stop'); return; }
    timer = timers.setTimeout(() => resolve('go'), ms);
    signal?.addEventListener?.('abort', () => { timers.clearTimeout(timer); resolve('stop'); }, { once: true });
  });
  return { promise, undo: () => { if (timer) timers.clearTimeout(timer); finish('undo'); } };
}

// ---- the send log and the hourly limit (userData/gmail-send-log.json: time, to, subject, how it was allowed)
// The file is sealed with the OS's own encryption (`secrets`, as connectors.json's tokens are): { version: 2, sealed } holds the
// list. An older plain file ({ version: 1, sends }) is read as it is and sealed on the next write. It is written tmp + rename.
// A file that can't be read or opened is kept, with a copy set aside, and the limit fails closed: room() refuses every send
// (a log that can't be read can't say how many went, and starting again from zero would lift the 10-an-hour cap).
function createLog({ file, now = Date.now, maxPerHour = MAX_PER_HOUR, secrets = null }) {
  let entries = [];
  let unreadable = false;
  const sealable = () => { try { return Boolean(secrets?.available()); } catch { return false; } };
  const clean = (list) => (Array.isArray(list) ? list.filter((e) => e && Number.isFinite(e.at)) : []);
  const r = readStoreFile(file, (text) => {
    const d = JSON.parse(text);
    if (typeof d?.sealed === 'string') {
      if (!sealable()) throw new Error('the send log is sealed and this computer’s secure storage is not available');
      return { sends: clean(JSON.parse(secrets.decrypt(d.sealed))?.sends), sealed: true };
    }
    if (!Array.isArray(d?.sends)) throw new Error('the send log has no list of sends');
    return { sends: clean(d.sends), sealed: false };
  }); // no file yet: no sends so far
  if (r.failed) unreadable = true;
  else if (r.data) entries = r.data.sends;
  const save = () => {
    if (unreadable) return; // (the original is kept as it is)
    if (!sealable()) return; // (no keychain: it is never written as plain text; the limit still holds in memory this run)
    try { writeJsonAtomic(file, { version: 2, sealed: secrets.encrypt(JSON.stringify({ sends: entries })) }, 0, 0o600); } catch { /* the limit still holds in memory */ }
  };
  if (r.data && !r.data.sealed && entries.length) save(); // (an older plain log is sealed now)
  const recent = () => entries.filter((e) => now() - e.at < 3600e3).length;
  return {
    recent,
    unreadable: () => unreadable,
    // Throws when the hour's sends are used up (checked before a card, so nobody is asked for a send that can't go).
    room() {
      if (unreadable) throw new SendError(`Lumen can’t read its list of sent emails, so it can’t check the limit of ${maxPerHour} an hour. Nothing was sent. Tell the user it can’t send right now.`);
      if (recent() >= maxPerHour) {
        const oldest = Math.min(...entries.filter((e) => now() - e.at < 3600e3).map((e) => e.at));
        const mins = Math.max(1, Math.ceil((oldest + 3600e3 - now()) / 60e3));
        throw new SendError(`Lumen sends at most ${maxPerHour} emails an hour, and that many have gone. Nothing was sent. Tell the user it can send again in about ${mins} minute${mins === 1 ? '' : 's'}.`);
      }
    },
    // Written just before the request goes out: a send that gets no answer still counts.
    record({ to, subject, via }) {
      if (unreadable) throw new SendError('Lumen can’t read its list of sent emails, so it can’t check the limit. Nothing was sent.');
      entries.push({ at: now(), to: String(to || '').slice(0, 300), subject: String(subject || '').slice(0, 200), via: via === 'chat' || via === 'message' ? 'typed' : 'card' });
      entries = entries.slice(-LOG_KEEP);
      save();
    },
    list: () => entries.slice().reverse().map((e) => ({ ...e })),
  };
}

module.exports = { sentLink, SEND_PATH, MAX_PER_HOUR, UNDO_MS, SendError, sendPath, addressesIn, standingGrant, oneOffGrant, typedGrant, warnings, hold, createLog };
