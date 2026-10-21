// The give-up detector (ai/handoff.js), the capability-gap log (ai/capability-gaps.js) and the guidance wording. Pure Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const handoff = require('../../src/ai/handoff');
const gaps = require('../../src/ai/capability-gaps');
const { systemFor, transcriptFor } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const verdict = (reply, request = 'do it for me') => handoff.classify(reply, request);

// Real phrasings of the AI giving the work back.
const HANDOFFS = [
  'I couldn\'t open the document. Please paste the full text of your report here and I\'ll summarize it.',
  'I can\'t reach Google Docs from here. You can do it in about 5 minutes: select all, copy, and send it to me.',
  'To read it I\'d need you to give me Docs clipboard access.',
  'That file is a PDF I can\'t view. Open it in a browser and tell me what the table says.',
  'I\'m unable to do that. You\'ll need to open the page yourself and copy the numbers.',
  'I don\'t have access to that document, so please share the text of it here.',
  'Sorry, I can\'t click that for you. It should take about 2 minutes on your end.',
  'Could you copy and paste the article text into the chat?',
  'I can\'t do this.',
];
for (const reply of HANDOFFS) check(`handoff: ${reply.slice(0, 60)}`, verdict(reply).handoff === true, JSON.stringify(verdict(reply)));

// Stops that need the user: never a handoff.
const LEGIT = [
  ['The page asks for a CAPTCHA, which only you can solve. Tell me when it is done and I will carry on.', 'captcha'],
  ['You need to sign in to Gmail first. I can\'t enter your password for you.', 'sign-in'],
  ['I can\'t log in for you; please sign in and I will continue.', 'sign-in'],
  ['The checkout is ready: 1 x laptop stand, $51.25. Do you want me to place the order? Please confirm the purchase.', 'payment'],
  ['This will permanently delete the 14 selected emails. Are you sure you want me to go ahead and delete them?', 'destructive'],
  ['I drafted the reply. Do you want me to send it as it is? Please confirm before I send the message.', 'send'],
  ['There are two matches for "Jordan Lee". Which one did you mean?', 'choice'],
  ['Do you want me to make it a table or a bullet list?', 'choice'],
];
for (const [reply, why] of LEGIT) { const v = verdict(reply); check(`legit stop (${why}): ${reply.slice(0, 55)}`, v.handoff === false && v.legit === why, JSON.stringify(v)); }

// Ordinary answers are left alone.
const FINE = [
  'Revenue grew 12% year on year, according to the report on page 3 (https://example.com/report).',
  'Done. I filled in the form and it now shows your new address.',
  '```\nPlease paste the text here\n```\nThat is the template I wrote for your email.',
  '> I can\'t wait to see you\n\nThat is the quote from the page; the author is excited about the launch.',
];
for (const reply of FINE) check(`not a handoff: ${reply.slice(0, 55).replace(/\n/g, ' ')}`, verdict(reply).handoff === false, JSON.stringify(verdict(reply)));
check('how-to question: telling the user the steps is the answer', verdict('You can open Settings, then Privacy, then Clear browsing data. You\'ll need to pick a time range.', 'How do I clear my cookies?').handoff === false);
check('...but the same words after an action request are a handoff', verdict('You can open Settings, then Privacy, then Clear browsing data. You\'ll need to pick a time range.', 'Clear my cookies').handoff === true);
check('a long answer with one caveat is not a handoff', verdict(`${'The market grew steadily across all regions. '.repeat(40)}I couldn't verify the 2019 figure.`).handoff === false);
check('empty and tiny replies are not handoffs', verdict('').handoff === false && verdict('OK').handoff === false);
check('kinds: paste, access, user-step', verdict('Please paste the text here.').kind === 'paste' && verdict('Please give me clipboard access.').kind === 'access' && verdict('You\'ll need to click Save yourself.').kind === 'user-step');

// Delivering code, a script, a command or a formula is a complete answer, even when it ends "run it" or "paste it".
const F = '```';
const DELIVERED = [
  ['MATLAB script to run', `Here's a MATLAB script that solves problem 3. You can run it in MATLAB to see the plot.\n\n${F}matlab\nx = linspace(0,1,100);\ny = x.^2;\nplot(x,y)\n${F}\n\nSave this as hw3.m and run it yourself, or paste it into the command window.`, 'Solve problem 3 of my MATLAB homework'],
  ['bash command', `Run this in your terminal:\n\n${F}bash\nnpm install\n${F}\n\nPaste this into your terminal and press Enter.`, 'Install the dependencies'],
  ['save as file and run', `Save this as solve.m and run it in MATLAB:\n\n${F}matlab\ndisp(1)\n${F}`, 'Do my homework'],
  ['inline command', 'Use `git status` to see what changed. Copy it into your terminal and run it.', 'Show me what changed'],
  ['code block only', `${F}matlab\nx = 1;\ndisp(x)\n${F}`, 'Write the script'],
  ['formula', 'Here\'s the formula: `A = pi * r^2`. Type it into a cell and fill it down.', 'Get the area of the circle'],
];
for (const [label, reply, request] of DELIVERED) check(`delivered answer, not a handoff: ${label}`, verdict(reply, request).handoff === false, JSON.stringify(verdict(reply, request)));
// ...but a refusal that happens to carry a small snippet is still a handoff.
const REFUSALS = [
  `I can't do that from here. You'll need to open the site and click Export yourself:\n\n${F}\nExport > CSV\n${F}`,
  'I can\'t open the page. Run `curl` on the URL yourself and paste the output here.',
  `I wasn't able to read the file. Please paste its contents here:\n\n${F}\n(paste here)\n${F}`,
];
for (const reply of REFUSALS) check(`still a handoff: ${reply.slice(0, 50).replace(/\n/g, ' ')}`, verdict(reply, 'Export my data').handoff === true, JSON.stringify(verdict(reply, 'Export my data')));
check('a browser step without a refusal still counts after a code block', verdict(`${F}\nok\n${F}\nYou can open the site and click Export yourself.`, 'Export my data').handoff === true);
check('follow-up: does not push the model to find and run local interpreters', !/a script, or a different/.test(handoff.FOLLOWUP) && /MATLAB, Octave/.test(handoff.FOLLOWUP) && /don't go hunting/.test(handoff.FOLLOWUP));

// finalReply: only a run that ended on an assistant text.
check('finalReply: the last assistant text', handoff.finalReply([{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] }]) === 'hello there');
check('finalReply: nothing after a tool call or a user turn', handoff.finalReply([{ role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'x', input: {} }] }]) === '' && handoff.finalReply([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }]) === '');
check('follow-up: lists what was tried, another way, and the legitimate reasons', /list what you tried/.test(handoff.FOLLOWUP) && /different approach/.test(handoff.FOLLOWUP) && /CAPTCHA/.test(handoff.FOLLOWUP) && handoff.FOLLOWUP.length < 800);

// The follow-up and the handoff reply it answers stay out of the chat view.
const msgs = [
  { role: 'user', content: [{ type: 'text', text: 'summarize my report' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Please paste the text here.' }] },
  { role: 'user', content: [{ type: 'text', text: handoff.FOLLOWUP }] },
  { role: 'assistant', content: [{ type: 'text', text: 'The report says revenue grew.' }] },
];
const items = transcriptFor(msgs, null);
check('chat view: one question, one answer; neither the follow-up nor the handoff shows', items.length === 2 && items[0].role === 'user' && items[1].text === 'The report says revenue grew.', JSON.stringify(items.map((i) => [i.role, i.text])));
check('chat view: with no answer after the follow-up the handoff text still shows', transcriptFor(msgs.slice(0, 3), null).some((i) => i.text === 'Please paste the text here.'));

// The guidance: finish it yourself; ask only for the listed reasons; no wording that invites handing back.
for (const model of ['claude-opus-5', 'grokbuild:default', 'antigravity:default', 'codex:default', 'openai:gpt-5']) {
  const text = systemFor({ model });
  check(`system prompt (${model}): says to finish the task and not hand a step back`, /Finish the task yourself/.test(text) && /hand a step back/i.test(text), text.slice(0, 200));
  check(`system prompt (${model}): the only stops are the safety ones`, /Stop and ask only for/.test(text) && /CAPTCHA/.test(text) && !/ask the user only after/.test(text) && !/say what blocks you/.test(text));
}

// The capability-gap log: private, local, capped, opt-out, no words from the reply.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-gaps-'));
try {
  let on = true;
  const log = gaps.createGapLog({ dir: () => dir, enabled: () => on });
  const e = log.record({ kind: 'paste', site: 'docs.google.com', tool: { tool: 'read_page', error: 'Could not read https://docs.google.com/document/d/abc/edit: "secret title" C:\\Users\\me\\x.txt' }, model: 'claudecode:default' });
  check('gap log: an entry has the date, site, what was missing and the tool error', /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.site === 'docs.google.com' && /paste/.test(e.missing) && e.tool === 'read_page' && e.error.length > 0, JSON.stringify(e));
  check('gap log: addresses, quoted text and paths are scrubbed from the error', !/docs\.google\.com\/document|secret title|Users/.test(e.error) && /\[address\]/.test(e.error), e.error);
  check('gap log: written under <profile>/diagnostics/ai-gaps.jsonl', fs.existsSync(path.join(dir, 'diagnostics', 'ai-gaps.jsonl')));
  check('gap log: a site that is not a host name is dropped', gaps.entryFor({ kind: 'cannot', site: 'Some Page Title With Words' }).site === '');
  check('gap log: list newest first, and a report as text', log.list().length === 1 && /docs\.google\.com/.test(log.report()) && /read_page/.test(log.report()));
  on = false;
  check('gap log: opted out, nothing is recorded', log.record({ kind: 'cannot' }) === null && log.list().length === 1);
  on = true;
  for (let i = 0; i < gaps.MAX_ENTRIES + 20; i++) log.record({ kind: 'cannot', site: 'example.com' });
  check('gap log: capped', log.list().length === gaps.MAX_ENTRIES, log.list().length);
  check('gap log: clear empties it', log.clear().length === 0 && log.list().length === 0);
  fs.writeFileSync(log.file(), 'not json\n{"date":"2026-01-01","missing":"x"}\n');
  check('gap log: a damaged line is skipped', log.list().length === 1);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// Settings: the switch ships on and has its docs row.
const backend = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'settings', 'settings-backend.js'), 'utf8');
check('setting: aiGapLog defaults on', /aiGapLog: true/.test(backend));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
