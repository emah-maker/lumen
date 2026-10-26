// [reply suggestions] The chips under a finished reply, plain Node (no Electron, no network): which replies end on a yes/no question
// (Yes / No buttons, no model call), how the follow-ups' model reply is read, which model writes them (only the chat's own provider, never
// a CLI), and the wiring (setting, IPC gate, chat page allowlist, page scripts).
const fs = require('fs');
const path = require('path');
const lib = require('../../src/ai/reply-suggest');
const { plan } = require('../../src/ai/autocomplete');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = (v) => JSON.stringify(v);
const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

// ---- yes/no questions
const yes = [
  'Packet 1 is done (about 90 minutes). Want me to make the other six?',
  'I found the homework files on Canvas.\n\nShould I download all of them?',
  'Done. Would you like me to interleave the topics across packets?',
  'Shall I open it in a new tab?',
  'I can also add an answer key. **Do you want that?**',
  'That fixes the bug. Ready to merge?',
  'Here is the draft:\n\n```\nfoo\n```\n\nOK if I send it?',
  'Proceed?',
  'Is that the right file?',
];
const no = [
  'Which list do you mean?',
  'Do you want packets of 1 hour or 2 hours?',
  'Should I use the homework or the textbook problems?',
  'What topics should packet 3 cover?',
  'Here are the 7 packets. Good luck on the midterm!',
  'Should I make 7 packets? Here is the first one.\n\nLet me know what you think.',
  '',
  'How long should each one take?',
];
for (const t of yes) check(`yes/no: "${t.split('\n').pop().slice(-50)}" gets Yes / No`, lib.yesNoQuestion(t) === true, lib.lastQuestion(t));
for (const t of no) check(`yes/no: "${t.split('\n').pop().slice(-50)}" does not`, lib.yesNoQuestion(t) === false, lib.lastQuestion(t));
check('yes/no: "or not" still counts as yes/no', lib.yesNoQuestion('Should I keep the old file or not?'));
check('lastQuestion: the last sentence only', lib.lastQuestion('I made packet 1. It covers stress. Want the rest?') === 'Want the rest?', lib.lastQuestion('I made packet 1. It covers stress. Want the rest?'));

// ---- reading the model's list
check('parse: a JSON array', J(lib.parseList('["Make the other six", "Add an answer key"]')) === J(['Make the other six', 'Add an answer key']));
check('parse: JSON after a sentence or in a fence', J(lib.parseList('Sure:\n```json\n["One more", "Two more"]\n```')) === J(['One more', 'Two more']));
check('parse: lines when it is not JSON, list marks and quotes dropped', J(lib.parseList('1. "Make it harder"\n- Add solutions\n')) === J(['Make it harder', 'Add solutions']));
check('parse: lone yes / no / thanks dropped', J(lib.parseList('["Yes", "no.", "Thanks!", "Make packet 2"]')) === J(['Make packet 2']));
check('parse: at most three, no repeats, none already shown', J(lib.parseList('["A b", "a B", "C d", "E f", "G h"]', ['C d'])) === J(['A b', 'E f', 'G h']));
check('parse: a long one is cut at a word', lib.parseList(`["${'word '.repeat(40)}"]`)[0].length <= lib.ITEM_CHARS + 1);
check('parse: nothing is nothing', J(lib.parseList('[]')) === '[]' && J(lib.parseList('')) === '[]');
check('system: JSON array, written as the person', /ONLY a JSON array/.test(lib.SYSTEM) && /written as the person/.test(lib.SYSTEM));

(async () => {
  // ---- which model, and the call
  {
    const seen = [];
    const call = async (model, o) => { seen.push({ model, max: o.maxTokens, user: o.messages[0].content }); return { content: [{ type: 'text', text: '["Make the other six", "Yes"]' }], usage: { input_tokens: 9, output_tokens: 4 } }; };
    const used = [];
    const r = await lib.run({ chatModel: 'claude-opus-5', options: [], transcript: 'User: hi\n\nAssistant: Want me to?', plan, call, onUsage: (m, model) => used.push(model) });
    check('run: an Anthropic chat asks Haiku once', r.ok && seen.length === 1 && seen[0].model === 'claude-haiku-5-5' && seen[0].max === lib.MAX_TOKENS, J(seen));
    check('run: the conversation goes in', seen[0].user.includes('Assistant: Want me to?'), seen[0].user);
    check('run: items come back parsed', J(r.items) === J(['Make the other six']), J(r));
    check('run: usage reported', J(used) === J(['claude-haiku-5-5']));
    const engine = await lib.run({ chatModel: 'claudecode:sonnet', options: [], transcript: 'User: hi', plan, call });
    check('run: a Claude Code chat with no Anthropic key makes no call', !engine.ok && engine.error === 'no-provider' && seen.length === 1, J(engine));
    const other = await lib.run({ chatModel: 'claudecode:sonnet', options: [{ id: 'openai:gpt-6' }], transcript: 'User: hi', plan, call });
    check('run: ...nor with only another company\'s key', !other.ok && seen.length === 1, J(other));
    const empty = await lib.run({ chatModel: 'claude-opus-5', transcript: '', plan, call });
    check('run: an empty chat makes no call', empty.error === 'empty' && seen.length === 1);
    const slow = await lib.run({ chatModel: 'claude-opus-5', transcript: 'User: hi', plan, timeMs: 30, call: (m, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    check('run: a slow call times out quietly', !slow.ok && slow.error === 'timeout' && J(slow.items) === '[]', J(slow));
    const broken = await lib.run({ chatModel: 'claude-opus-5', transcript: 'User: hi', plan, call: async () => { throw new Error('boom'); } });
    check('run: an error never throws', !broken.ok && /boom/.test(broken.error));
  }

  // ---- the wiring
  {
    const main = src('src/main.js');
    const defaults = require('../../src/settings/settings-backend').DEFAULTS || {};
    check('setting: on by default', defaults.replySuggestions === true || /replySuggestions: true,/.test(src('src/settings/settings-backend.js')));
    check('setting: main passes it to the agent (off only when false) and the IPC checks it', /replySuggestions: \(\) => readSettings\(\)\.replySuggestions !== false/.test(main) && /'agent:reply-suggest'[\s\S]{0,120}readSettings\(\)\.replySuggestions === false/.test(main));
    check('ipc: gated to the UI and allowed on the chat page', /UI_ONLY_IPC = new Set\(\[[\s\S]*'agent:reply-suggest'/.test(main) && src('src/features/chat-page.js').includes("'agent:reply-suggest'"));
    check('ipc: a view on another chat by now gets nothing', /error: 'moved'/.test(main));
    check('preload: both pages can ask', src('src/preload/preload.js').includes("invoke('agent:reply-suggest'") && src('src/features/chat-preload.js').includes("invoke('agent:reply-suggest'"));
    for (const page of ['src/renderer/index.src.html', 'src/renderer/chat-page.html']) {
      const html = src(page);
      const a = html.indexOf('<script src="chat-core.js">'); const b = html.indexOf('<script src="../ai/reply-suggest.js">'); const c = html.indexOf('<script src="reply-suggest.js">');
      check(`page: ${path.basename(page)} loads the detector, then the chips, after chat-core`, a > 0 && b > a && c > b, J({ a, b, c }));
    }
    const core = src('src/renderer/chat-core.js');
    check('chat-core: a finished reply says whether it ended on its own', /'lumen:reply-done'/.test(core) && /clean = !turn\.failed && !turn\.stopped && !turn\.stopRequested && !turn\.interrupted && !line\.mine\(forOtherChat\)\.length/.test(core));
    const page = src('src/renderer/reply-suggest.js');
    check('chips: a click sends the text through the composer', /prompt\.value = text;[\s\S]*form\.requestSubmit\(\)/.test(page));
    check('chips: they go when typing, sending, or a new message arrives', /prompt\.addEventListener\('input'/.test(page) && /addEventListener\('submit', clear/.test(page) && /\.msg\.user, \.msg\.assistant\.streaming/.test(page));
    const en = JSON.parse(src('src/locales/en.json'));
    check('strings: the switch and the chips', en['settings.ai.replySuggestions'] === 'Suggest replies' && en['chat.suggest.yes'] === 'Yes' && en['chat.suggest.no'] === 'No' && /only to it/.test(en['settings.ai.replySuggestionsDesc']));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
