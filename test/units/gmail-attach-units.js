// Gmail: files in an email, Google's drafts permission asked for from the chat, and the send that goes after one click on its card. Plain
// Node with a fake Gmail API (nothing leaves the computer, no Electron). Covers: the multipart message (gmail-drafts.js buildMessage), the
// upload request for a big one (widgets.js gmailRequest), the agent's attach files (a chat's own PDF, device access, refused paths), the
// card that lists them, Google's consent opened only after the card was approved, and a send that needs that card when the Settings switch
// is off.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const GD = require('../../src/features/gmail-drafts');
const { gmailRequest, GMAIL_JSON_MAX } = require('../../src/features/widgets');
const registry = require('../../src/features/connectors/registry');
const service = require('../../src/features/connectors/service');
const aiFiles = require('../../src/features/ai-files');
const agentLib = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const fails = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message || String(e); } };
const fakeSecrets = { available: () => true, encrypt: (s) => `x${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(1), 'base64').toString() };
const unRaw = (raw) => Buffer.from(raw, 'base64url').toString('utf8');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// The parts of a multipart/mixed message: [{ headers, body }] (body as the decoded bytes of a base64 part).
function partsOf(msg) {
  const b = /boundary="([^"]+)"/.exec(msg)?.[1];
  if (!b) return [];
  return msg.split(`--${b}`).slice(1, -1).map((chunk) => {
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    return { headers: head, body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64') };
  });
}

function message() {
  console.log('--- the message: text first, then each file');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(5000, 7), Buffer.from('\n%%EOF')]);
  const msg = GD.buildMessage({ to: 'me@example.com', subject: 'Your notes', body: 'Here they are.', attachments: [{ name: 'Notes.pdf', type: 'application/pdf', bytes: pdf }, { name: 'Résumé.txt', type: 'text/plain', bytes: Buffer.from('hi') }] });
  const parts = partsOf(msg);
  check('with files the message is multipart/mixed: the text part, then each file', /^Content-Type: multipart\/mixed; boundary="=_lumen_[0-9a-f]{24}"$/m.test(msg) && parts.length === 3 && /text\/plain/.test(parts[0].headers) && parts[0].body.toString() === 'Here they are.', msg.slice(0, 600));
  check('the PDF goes as itself: application/pdf, an attachment named Notes.pdf, its bytes exactly', /^Content-Type: application\/pdf; name="Notes\.pdf"/m.test(parts[1].headers) && /Content-Disposition: attachment; filename="Notes\.pdf"/.test(parts[1].headers) && parts[1].body.equals(pdf), parts[1].headers);
  check('a name that isn’t ASCII gets an RFC 2231 filename* next to an ASCII one', /filename="R_sum_\.txt";\r\n filename\*=UTF-8''R%C3%A9sum%C3%A9\.txt/.test(parts[2].headers), parts[2].headers);
  check('no line of the message is longer than 998 characters', msg.split('\r\n').every((l) => l.length <= 998), '');
  const sneaky = GD.buildMessage({ to: 'a@x.org', subject: 's', body: 'b', attachments: [{ name: 'C:/Users/ada/a"\r\nBcc: e@evil.org.pdf', type: 'text/html\r\nX: y', bytes: Buffer.from('x') }] });
  check('a file’s name loses its folder, quotes and line breaks, and a bad type becomes application/octet-stream (no header injection)', !/\r\nBcc:/.test(sneaky) && /filename="aBcc: e@evil\.org\.pdf"/.test(sneaky) && /Content-Type: application\/octet-stream; name=/.test(sneaky), sneaky.slice(0, 500));
  const plain = GD.buildMessage({ to: 'a@x.org', subject: 's', body: 'b' });
  check('without files the message is the plain text one, as before', /^Content-Type: text\/plain; charset="UTF-8"$/m.test(plain) && !/multipart/.test(plain), plain);
  const many = Array.from({ length: GD.MAX_ATTACHMENTS + 1 }, (_, i) => ({ name: `${i}.txt`, bytes: Buffer.from('x') }));
  check('more than 10 files, or more than 18 MB in all, is refused', /At most 10 files/.test((() => { try { GD.buildMessage({ to: 'a@x.org', subject: 's', body: 'b', attachments: many }); return ''; } catch (e) { return e.message; } })()) && /more than 18 MB/.test((() => { try { GD.buildMessage({ to: 'a@x.org', subject: 's', body: 'b', attachments: [{ name: 'big', bytes: Buffer.alloc(GD.MAX_ATTACH_BYTES + 1) }] }); return ''; } catch (e) { return e.message; } })()), '');

  console.log('--- the request: small as JSON, big through Google’s upload address');
  const base = 'https://gmail.googleapis.com/gmail/v1';
  const small = gmailRequest(base, '/users/me/messages/send', { raw: 'abc', threadId: '18c0ffee00' });
  check('a small email is the JSON body at the API address', small.url === `${base}/users/me/messages/send` && small.type === 'application/json' && JSON.parse(small.body).raw === 'abc' && !small.upload, JSON.stringify(small));
  const bigMsg = GD.buildMessage({ to: 'a@x.org', subject: 's', body: 'b', attachments: [{ name: 'big.pdf', type: 'application/pdf', bytes: Buffer.alloc(3 * 1048576, 1) }] });
  const raw = GD.toRaw(bigMsg);
  const big = gmailRequest(base, '/users/me/drafts', { message: { raw, threadId: '18c0ffee00' } });
  const text = big.body.toString('latin1');
  const boundary = /boundary=(\S+)/.exec(big.type)?.[1];
  const json = JSON.parse(text.split(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`)[1].split('\r\n')[0]);
  const rfc = text.split('Content-Type: message/rfc822\r\n\r\n')[1].split(`\r\n--${boundary}--`)[0];
  check('a big one goes to /upload/gmail/v1/… with uploadType=multipart and a longer timeout', raw.length > GMAIL_JSON_MAX && big.upload && big.url === 'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=multipart' && /^multipart\/related; boundary=lumen_[0-9a-f]{24}$/.test(big.type), big.url);
  check('…its JSON part keeps the thread and drops raw, and its message/rfc822 part is the message itself, byte for byte', json.message.threadId === '18c0ffee00' && !('raw' in json.message) && Buffer.from(rfc, 'latin1').equals(Buffer.from(bigMsg, 'utf8')), JSON.stringify(json));
}

async function flow() {
  console.log('--- the agent: attach a file the AI made, Google asked once after the card, Send on the card');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-gmail-attach-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-test-gmail-attach-work-'));
  const pdfPath = path.join(work, 'Study guide.pdf');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 3), Buffer.from('\n%%EOF')]);
  fs.writeFileSync(pdfPath, pdf);
  const otherPath = path.join(work, 'other.pdf');
  fs.writeFileSync(otherPath, pdf);

  const g = { compose: false, allowCalls: 0, sent: [], made: [], allowFails: false };
  const google = {
    status: async () => ({ oauth: true, oneClick: false, session: false, email: 'ada@example.com' }),
    api: async () => { throw new Error('not found'); },
    feed: async () => ({ status: 200, body: '' }), connect: async () => {}, disconnect: async () => {},
    drafts: () => g.compose,
    allowDrafts: async () => { g.allowCalls++; if (g.allowFails) throw new Error('Gmail was not connected.'); g.compose = true; },
    compose: async (body) => { g.made.push(body); return { id: 'r1', message: { id: '18c0ffee0b' } }; },
    send: async (body) => { g.sent.push(body); return { id: '18c0ffee0b' }; },
  };
  const svc = service.create({ userData: dir, secrets: fakeSecrets, google });
  await svc.connect('gmail');
  registry.setConnected(['gmail']);
  check('Gmail with the full sign-in offers send (with attach) even before Google’s drafts permission or the Settings switch', /send\(to,cc\?,bcc\?,subject,body,reply_to_message_id\?,attach\?\)!/.test(svc.defs()[0].description) && !svc.sendingOn(), svc.defs()[0].description);
  check('the help tells the model to attach the file itself (never a Drive link) and that nothing needs setting up first', /never a Drive link/.test(registry.help('gmail')) && /never say you can’t send or attach/.test(registry.help('gmail')) && /nothing to set up first/.test(registry.help('gmail')), registry.help('gmail'));

  const events = [];
  const device = { on: false };
  const browser = { connectors: { hasAny: () => true, isWrite: (i) => svc.isWrite(i), isSend: (i) => svc.isSend(i), sendingOn: () => svc.sendingOn(), describeWrite: (i, o) => svc.describeWrite(i, o), defs: (o) => svc.defs(o), call: (i, o) => svc.call(i, o) }, bypassPermissions: () => false, autoApprove: () => true, deviceAccess: () => device.on, homeDir: () => work, profileDir: () => path.join(dir, 'profile') };
  const agent = new agentLib.Agent(browser, () => null, () => ({}));
  const chat = [];
  aiFiles.noteWritten(chat, pdfPath); // (the AI wrote this PDF in this chat: Claude Code's Write tool)
  const gate = (extra = {}) => ({ emit: (e) => events.push(e), signal: new AbortController().signal, who: 'Claude', external: false, noAsk: false, run: { chat }, ...extra });
  const approvals = () => events.filter((e) => e.type === 'approval');
  const mail = (args = {}) => ({ app: 'gmail', action: 'send', args: { to: 'me@example.com', subject: 'Study guide', body: 'Here is the PDF.', attach: pdfPath, ...args } });

  // 1. The send card: the file, Google's step, Send / Cancel. Nothing asked of Google and nothing sent before the click.
  let input = mail();
  let pending = agent.allowConnector(input, gate());
  await tick();
  let card = approvals().pop();
  check('the send card names the file and its size, says Google asks once after it, and has Send and Cancel', card && card.allowLabel === 'Send' && card.denyLabel === 'Cancel' && /Attachments: Study guide\.pdf \(2 KB\)/.test(card.fields?.fixed || '') && /Google then asks you once/.test(card.fields.fixed) && card.noAlways === true, JSON.stringify(card));
  check('…and before the click nothing was asked of Google and nothing sent', g.allowCalls === 0 && g.sent.length === 0, '');
  agent.resolveApproval(card.approvalId, false);
  check('Cancel: not sent, Google never asked', /NOT sent/.test(await fails(() => pending)) && g.allowCalls === 0 && g.sent.length === 0, '');

  // 2. Send: Google's consent opens once (the run waits), then the email goes with the PDF in it.
  events.length = 0;
  input = mail();
  pending = agent.allowConnector(input, gate());
  await tick();
  card = approvals().pop();
  agent.resolveApproval(card.approvalId, true);
  await pending;
  const out = await agent.runConnector(input);
  const sentMsg = g.sent[0] ? unRaw(g.sent[0].raw) : '';
  const att = partsOf(sentMsg).find((p) => /application\/pdf/.test(p.headers));
  check('after Send, Google’s consent ran once and then the email went, once', g.allowCalls === 1 && g.compose && g.sent.length === 1 && /Sent\. Email to me@example\.com: “Study guide” with “Study guide\.pdf” attached/.test(out), out);
  check('the sent email carries the PDF itself, byte for byte (not a link)', att && /filename="Study guide\.pdf"/.test(att.headers) && att.body.equals(pdf) && !/drive\.google\.com/.test(sentMsg), sentMsg.slice(0, 400));
  const log = svc.sendLog();
  check('the send is logged as allowed by its card', log.length === 1 && log[0].via === 'card' && log[0].to === 'me@example.com', JSON.stringify(log));

  // 3. With the permission there, the next one doesn't ask Google again.
  events.length = 0;
  input = mail({ subject: 'Again' });
  pending = agent.allowConnector(input, gate());
  await tick();
  card = approvals().pop();
  check('with the permission there, the card no longer mentions Google’s step', card && !/Google then asks/.test(card.fields.fixed), card?.fields?.fixed);
  agent.resolveApproval(card.approvalId, true);
  await pending;
  await agent.runConnector(input);
  check('…and Google isn’t asked again', g.allowCalls === 1 && g.sent.length === 2, String(g.allowCalls));

  // 4. A file changed after the card is not sent.
  events.length = 0;
  input = mail({ subject: 'Changed' });
  pending = agent.allowConnector(input, gate());
  await tick();
  agent.resolveApproval(approvals().pop().approvalId, true);
  await pending;
  fs.appendFileSync(pdfPath, 'more');
  const changed = await fails(() => agent.runConnector(input));
  check('a file that changed after the card was approved is not sent', /changed after the user allowed it/.test(changed) && /not sent/.test(changed) && g.sent.length === 2, changed);
  fs.writeFileSync(pdfPath, pdf);

  // 5. Paths that aren't the AI's own file (and device access off) are refused before any card.
  events.length = 0;
  const notMine = await fails(() => agent.allowConnector(mail({ attach: otherPath }), gate()));
  check('a path the AI didn’t write in this chat, with files on this computer off, is refused with no card and the AI told to ask for it', /isn’t a file you made in this chat/.test(notMine) && /attach it to the chat/.test(notMine) && !approvals().length, notMine);
  const otherChat = await fails(() => agent.allowConnector(mail(), gate({ run: { chat: [] } })));
  check('…and the same PDF from another chat is refused too', /isn’t a file you made in this chat/.test(otherChat), otherChat);
  device.on = true;
  events.length = 0;
  pending = agent.allowConnector(mail({ attach: `${pdfPath}\n${otherPath}` }), gate());
  await tick();
  card = approvals().pop();
  check('with files on this computer on, a path the user named can go too; the card lists every file', card && /Attachments: Study guide\.pdf \(2 KB\), other\.pdf \(2 KB\)/.test(card.fields.fixed), card?.fields?.fixed);
  agent.resolveApproval(card.approvalId, false);
  await fails(() => pending);
  const secret = path.join(work, '.ssh');
  fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(secret, 'id_rsa'), 'KEY');
  const blocked = await fails(() => agent.allowConnector(mail({ attach: path.join(secret, 'id_rsa') }), gate()));
  check('…but never a file in a credentials folder', blocked && !/^$/.test(blocked) && g.sent.length === 2, blocked);
  device.on = false;

  // 6. A draft with a file always shows its card (never "Always allowed"), and carries the file.
  svc.addAlways?.('gmail:create_draft');
  events.length = 0;
  const draft = { app: 'gmail', action: 'create_draft', args: { to: 'me@example.com', subject: 'Draft', body: 'x', attach: pdfPath } };
  pending = agent.allowConnector(draft, gate());
  await tick();
  card = approvals().pop();
  check('a draft with a file shows its card even when drafts are always allowed, with no Always on it', card && card.noAlways === true && /Attachments: Study guide\.pdf/.test(card.fields.fixed) && !events.some((e) => e.name === 'auto_allowed'), JSON.stringify(card));
  agent.resolveApproval(card.approvalId, true);
  await pending;
  const dOut = await agent.runConnector(draft);
  const dAtt = g.made[0] ? partsOf(unRaw(g.made[0].message.raw)).find((p) => /application\/pdf/.test(p.headers)) : null;
  check('the draft carries the PDF too, and its answer says how to send instead', dAtt && dAtt.body.equals(pdf) && /call send/.test(dOut), dOut);

  // 7. Google declined: nothing goes, and the AI is told to offer another try (no Settings).
  g.compose = false;
  g.allowFails = true;
  events.length = 0;
  input = mail({ subject: 'Declined' });
  pending = agent.allowConnector(input, gate());
  await tick();
  agent.resolveApproval(approvals().pop().approvalId, true);
  await pending;
  const declined = await fails(() => agent.runConnector(input));
  check('declined at Google: nothing sent, and the AI hears to offer another try, not to open Settings', /wasn’t given/.test(declined) && /Nothing was sent/.test(declined) && !/Settings/.test(declined) && g.sent.length === 2, declined);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
}

function sourceChecks() {
  console.log('--- the app wires it');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  const facade = /const connectorsFacade = \{[\s\S]*?\n\};/.exec(main)?.[0] || '';
  check('the agent’s connectors (main.js) say which call is a send and whether the switch is on: without them a card-approved send has no sendVia and is refused', /\bisSend: \(input\) => connectorsSvc\(\)\.isSend\(input\)/.test(facade) && /\bsendingOn: \(\) =>/.test(facade), facade.slice(0, 300));
  const prov = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'features', 'connectors', 'providers', 'gmail.js'), 'utf8');
  check('nothing Gmail tells the model sends the user to Settings for Google’s drafts permission', !/press Allow drafts/.test(prov) && !/turn on Allow sending/.test(prov), '');
}

(async () => {
  sourceChecks();
  message();
  await flow();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
