// [telegram] Phone (Telegram), features/telegram.js, against a fake Bot API (the fetch function is injected; nothing
// reaches Telegram): pairing, the owner filter, splitting and MarkdownV2 escaping, the approval round trip through the
// runner's approve(), backoff, and that the token never shows up in an error.
const T = require('../src/features/telegram');
const en = require('../src/locales/en.json');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const t = (key, params = {}) => (en[key] || key).replace(/\{(\w+)\}/g, (w, n) => (n in params ? String(params[n]) : w));

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const OWNER = 5550001;
const STRANGER = 5550002;

// A fake Bot API: records every call; getUpdates hands out what the test queued.
function fakeApi() {
  const calls = [];
  const queue = [];
  let nextMessageId = 100;
  let failWith = null; // { status, description, retry_after } or 'network'
  let delay = 0; // ms a getUpdates takes (a long poll in flight); like Telegram's, it ignores being aborted
  const api = {
    calls, queue,
    fail: (f) => { failWith = f; },
    slow: (ms) => { delay = ms; },
    sent: () => calls.filter((c) => c.method === 'sendMessage'),
    fetch: async (url, init) => {
      const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
      const method = m[2];
      const body = JSON.parse(init.body || '{}');
      calls.push({ method, body, token: m[1] });
      const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
      if (failWith === 'network') throw new Error(`request to ${url} failed`);
      if (failWith) return json({ ok: false, error_code: failWith.status, description: failWith.description || 'error', parameters: failWith.retry_after ? { retry_after: failWith.retry_after } : undefined }, failWith.status);
      if (m[1] !== TOKEN) return json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
      if (method === 'getMe') return json({ ok: true, result: { id: 42, is_bot: true, username: 'my_lumen_bot' } });
      if (method === 'getUpdates') {
        // As Telegram does: an offset confirms (drops) everything before it; the rest comes back until confirmed.
        while (queue.length && queue[0].update_id < (body.offset || 0)) queue.shift();
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return json({ ok: true, result: queue.filter((u) => u.update_id >= (body.offset || 0)) }); // (what arrived while the poll was held comes back with it)
      }
      if (method === 'sendMessage') return json({ ok: true, result: { message_id: nextMessageId++, chat: { id: body.chat_id }, text: body.text } });
      return json({ ok: true, result: true });
    },
  };
  return api;
}

// A stand-in for the background runner: create / stop / approve / find / subscribe.
function fakeTasks() {
  const tasks = new Map();
  const listeners = new Set();
  const approvals = [];
  let n = 0;
  return {
    tasks, approvals,
    create: (spec) => {
      if (!spec.confirmed) throw new Error('confirm');
      const id = (++n).toString(16).padStart(16, '0');
      const task = { id, title: spec.prompt.slice(0, 40), status: 'running', spec };
      tasks.set(id, task);
      return task;
    },
    stop: (id) => { const x = tasks.get(id); if (x) x.status = 'stopped'; return Boolean(x); },
    approve: (id, approvalId, choice) => {
      const x = tasks.get(id);
      if (!x?.pending?.has(approvalId)) return false;
      x.pending.delete(approvalId);
      approvals.push({ id, approvalId, choice });
      return true;
    },
    find: (id) => tasks.get(id),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    approvalWaitMin: () => 60,
    listeners: () => listeners.size,
    emit: (e) => { for (const fn of listeners) fn(e); },
  };
}

function setup({ settings = {}, token = TOKEN, clock = { now: 1_800_000_000_000 } } = {}) {
  const api = fakeApi();
  const tasks = fakeTasks();
  let stored = { telegramChannel: true, ...settings };
  let tok = token;
  const sleeps = [];
  const tg = T.create({
    fetch: api.fetch, t, tasks,
    readSettings: () => stored, writeSettings: (s) => { stored = s; },
    getToken: () => tok, setToken: (x) => { tok = x || null; }, canEncrypt: () => true,
    now: () => clock.now, pollTimeout: 0,
    sleep: (ms, signal) => { sleeps.push(ms); return new Promise((r) => { const timer = setTimeout(r, 5); signal?.addEventListener('abort', () => { clearTimeout(timer); r(); }, { once: true }); }); },
  });
  return { api, tasks, tg, clock, sleeps, settings: () => stored, token: () => tok };
}

let uid = 1;
const msg = (chatId, text, { date, from } = {}) => ({ update_id: uid++, message: { message_id: uid, chat: { id: chatId, type: 'private' }, from: from || { id: chatId, first_name: 'Sam', username: 'sam' }, date: date ?? 1_800_000_000, text } });
const press = (chatId, data) => ({ update_id: uid++, callback_query: { id: `cb${uid}`, from: { id: chatId }, message: { message_id: 100, chat: { id: chatId } }, data } });
const lastText = (api) => api.sent().at(-1)?.body.text || '';

(async () => {
  // ---- pure helpers
  check('a BotFather token is recognised, other text is not', T.validToken(TOKEN) && !T.validToken('hello') && !T.validToken('123:short'));
  check('scrub removes the token from an error message', !T.scrub(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`).includes(TOKEN));
  check('MarkdownV2 escapes every reserved character', T.escapeMarkdownV2('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s\\t') === 'a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s\\\\t');
  check('plain words are left alone by the escaper', T.escapeMarkdownV2('Allow it') === 'Allow it');
  const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ') + '\n\n' + 'x'.repeat(5000);
  const parts = T.splitMessage(long);
  check('a long result is split into pieces of at most 4096 characters', parts.length >= 3 && parts.every((p) => p.length <= 4096), parts.map((p) => p.length));
  check('…and nothing is lost but the whitespace at the cuts', parts.join('').replace(/\s/g, '') === long.replace(/\s/g, ''));
  check('…cut at a space, not inside a word', /^word\d+\b/.test(parts[1]) && /word\d+$/.test(parts[0]), parts[1].slice(0, 20));
  const emoji = 'a'.repeat(4095) + '\u{1F600}' + 'b';
  check('a cut never splits a surrogate pair', T.splitMessage(emoji).every((p) => !/[\uD800-\uDBFF]$/.test(p) && !/^[\uDC00-\uDFFF]/.test(p)));
  check('short text is one piece; empty text none', T.splitMessage('hi').length === 1 && T.splitMessage('  ').length === 0);
  check('commands: /pair 123456, /status@bot, other bots ignored', T.parseCommand('/pair 123456').arg === '123456' && T.parseCommand('/status@my_lumen_bot', 'my_lumen_bot').cmd === 'status' && T.parseCommand('/status@other_bot', 'my_lumen_bot') === null && T.parseCommand('find me a flight') === null);
  check('backoff doubles from 2 s and stops at 5 minutes', T.backoffDelay(1) === 2000 && T.backoffDelay(2) === 4000 && T.backoffDelay(4) === 16000 && T.backoffDelay(30) === 300000);
  check('backoff follows Telegram\'s retry_after', T.backoffDelay(1, 7) === 7000);
  check('button data fits Telegram\'s 64 bytes and reads back', T.callbackData('abcdef0123456789', 123456789, true).length <= 64 && T.parseCallback(T.callbackData('abcdef0123456789', 7, false)).allow === false && T.parseCallback('a:zz:1:y') === null);
  check('pair codes are 6 digits', /^\d{6}$/.test(T.newPairCode()));

  // ---- token
  {
    const { tg, api, token, settings } = setup({ token: null });
    let err = '';
    try { await tg.setToken('nonsense'); } catch (e) { err = e.message; }
    check('a malformed token is refused before anything is sent', /bot token/i.test(err) && api.calls.length === 0, err);
    try { await tg.setToken('123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); } catch (e) { err = e.message; }
    check('a token Telegram rejects is not stored, and the error has no token in it', /didn't accept/.test(err) && token() === null && !err.includes('AAAAAAAAAAAAAAAA'), err);
    const s = await tg.setToken(TOKEN);
    check('a good token is checked with getMe and stored; the bot name is kept, the token is not returned', token() === TOKEN && s.bot.username === 'my_lumen_bot' && !JSON.stringify(s).includes(TOKEN) && !JSON.stringify(settings()).includes(TOKEN));
    tg.shutdown();
  }

  // ---- pairing and the owner filter
  const env = setup({ settings: { telegram: { bot: { id: 42, username: 'my_lumen_bot' } } } });
  const { tg, api, tasks } = env;
  await tg.handleUpdate(msg(STRANGER, 'hello'));
  await tg.settled();
  check('before pairing, a stranger gets one polite reply', api.sent().length === 1 && /only answers its owner/.test(lastText(api)));
  await tg.handleUpdate(msg(STRANGER, 'hello again'));
  await tg.settled();
  check('…and no second one within the hour', api.sent().length === 1);
  check('nothing a stranger sends becomes a task', tasks.tasks.size === 0);
  let err = '';
  try { tg.startPairing(); } catch (e) { err = e.message; }
  check('pairing is possible once the setting is on and a token is saved', !err && /^\d{6}$/.test(tg.pairCode()), err);
  const code = tg.pairCode();
  const wrong = code === '000000' ? '111111' : '000000';
  await tg.handleUpdate(msg(STRANGER, `/pair ${wrong}`));
  await tg.settled();
  check('a wrong code is refused', /doesn't match/.test(lastText(api)) && env.settings().telegram.owner == null);
  await tg.handleUpdate(msg(OWNER, `/pair ${code}`));
  await tg.settled();
  check('the right code pairs that chat', env.settings().telegram.owner?.id === OWNER && /Paired/.test(lastText(api)) && tg.pairCode() === null);
  check('the status shows who is paired, by name', tg.status().owner?.name === '@sam');
  const before = api.sent().length;
  await tg.handleUpdate(msg(STRANGER, 'open my bank and send money'));
  await tg.settled();
  check('after pairing, another chat is ignored (its one reply already used) and starts nothing', api.sent().length === before && tasks.tasks.size === 0);
  await tg.handleUpdate({ update_id: uid++, message: { message_id: 1, chat: { id: OWNER, type: 'group' }, from: { id: OWNER }, date: 1_800_000_000, text: 'group msg' } });
  check('a group chat is never answered, even with the owner in it', tasks.tasks.size === 0 && api.sent().length === before);

  // ---- a request becomes a background task
  await tg.handleUpdate(msg(OWNER, 'Find the cheapest flight to Lisbon on example.com'));
  await tg.settled();
  const task = [...tasks.tasks.values()][0];
  check('the owner\'s message becomes a confirmed background task now, signed out by default', task && task.spec.prompt.startsWith('Find the cheapest') && task.spec.confirmed === true && task.spec.schedule.type === 'now' && task.spec.signedIn === false && !task.spec.model, JSON.stringify(task?.spec));
  check('…and the reply says it is working', lastText(api) === 'Working on it…');
  check('…with no allowed sites, even though the message names example.com: every site asks on the phone', Array.isArray(task.spec.sites) && task.spec.sites.length === 0, JSON.stringify(task.spec.sites));
  for (const fwd of [{ forward_origin: { type: 'user', sender_user: { id: 9 } } }, { forward_from: { id: 9 } }, { forward_from_chat: { id: -100 } }, { forward_sender_name: 'Someone' }]) {
    const m = msg(OWNER, 'buy the thing on shop.example.com');
    Object.assign(m.message, fwd);
    await tg.handleUpdate(m);
  }
  await tg.settled();
  check('a forwarded message (any kind of forward) is refused and starts nothing', tasks.tasks.size === 1 && /Forwarded messages aren't run/.test(lastText(api)));
  await tg.handleUpdate(msg(OWNER, '/status'));
  await tg.settled();
  check('/status lists it', lastText(api).includes(task.title) && lastText(api).includes('working'));
  await tg.handleUpdate(msg(OWNER, 'old one', { date: 1_800_000_000 - 3600 }));
  await tg.settled();
  check('a message sent an hour ago (Lumen was closed) is not run', tasks.tasks.size === 1 && /arrived while Lumen was closed/.test(lastText(api)));

  // ---- approval round trip
  task.pending = new Set([7]);
  tasks.emit({ type: 'approval', taskId: task.id, approvalId: 7, card: { approvalId: 7, host: 'shop.example.com', action: 'tool', title: 'The AI wants to click “Buy now” on shop.example.com', args: 'A button (that) looks like it buys.' } });
  await tg.settled();
  const card = api.sent().at(-1).body;
  const kb = card.reply_markup?.inline_keyboard?.[0] || [];
  check('an approval card arrives with Allow and Deny buttons', kb.length === 2 && kb[0].text === 'Allow' && kb[1].text === 'Deny');
  check('…in MarkdownV2 with the page\'s words escaped', card.parse_mode === 'MarkdownV2' && card.text.includes('\\(that\\)') && card.text.includes('shop\\.example\\.com'));
  await tg.handleUpdate(press(STRANGER, kb[0].callback_data));
  check('a button pressed from another chat does nothing', tasks.approvals.length === 0 && api.calls.at(-1).method === 'answerCallbackQuery', JSON.stringify(api.calls.slice(-2)));
  await tg.handleUpdate(press(OWNER, kb[0].callback_data));
  await tg.settled();
  check('Allow from the owner goes through the runner\'s approve(), as "once"', tasks.approvals.length === 1 && tasks.approvals[0].choice === 'once' && tasks.approvals[0].approvalId === 7);
  check('…and the card is updated to say so, without buttons', api.calls.at(-1).method === 'editMessageText' && /Allowed/.test(api.calls.at(-1).body.text) && !api.calls.at(-1).body.reply_markup, JSON.stringify(api.calls.slice(-2)));
  tasks.emit({ type: 'approval_done', taskId: task.id, approvalId: 7, ok: true });
  await tg.handleUpdate(press(OWNER, kb[0].callback_data));
  check('pressing again does not answer twice', tasks.approvals.length === 1);
  task.pending = new Set([8]);
  tasks.emit({ type: 'approval', taskId: task.id, approvalId: 8, card: { host: 'mail.example.com' } });
  await tg.settled();
  const kb2 = api.sent().at(-1).body.reply_markup.inline_keyboard[0];
  await tg.handleUpdate(press(OWNER, kb2[1].callback_data));
  check('Deny goes through approve() as "deny"', tasks.approvals[1]?.choice === 'deny');
  task.pending = new Set([9]);
  tasks.emit({ type: 'approval', taskId: task.id, approvalId: 9, card: { host: 'x.example.com' } });
  await tg.settled();
  const kb3 = api.sent().at(-1).body.reply_markup.inline_keyboard[0];
  task.pending.delete(9); // the Tasks panel answered, or the wait ran out (the runner's timeout)
  tasks.emit({ type: 'approval_done', taskId: task.id, approvalId: 9, ok: false });
  await tg.settled();
  check('a card answered in Lumen (or timed out) is closed on the phone', api.calls.at(-1).method === 'editMessageText' && /Denied/.test(api.calls.at(-1).body.text));
  const n = tasks.approvals.length;
  await tg.handleUpdate(press(OWNER, kb3[0].callback_data));
  check('…and its old Allow button does nothing', tasks.approvals.length === n);
  check('a forged button for a task Telegram did not start does nothing', (await tg.handleUpdate(press(OWNER, T.callbackData('ffffffffffffffff', 1, true))), tasks.approvals.length === n));

  // ---- a card with long, punctuation-heavy fields is cut before escaping, so it stays valid MarkdownV2 under 4096
  task.pending = new Set([10]);
  tasks.emit({ type: 'approval', taskId: task.id, approvalId: 10, card: { host: 'a.'.repeat(400) + 'com', title: 'Click “Pay.” (now)! '.repeat(60), query: '[q].'.repeat(200), args: '.'.repeat(5000) } });
  await tg.settled();
  const big = api.sent().at(-1).body;
  const unescaped = big.text.replace(/\\./g, '').match(/[_*[\]()~`>#+\-=|{}.!]/g) || [];
  check('a long card is still sent, under 4096 characters', big.reply_markup && big.text.length <= 4096, big.text.length);
  check('…with every reserved character still escaped (only the bold and italic marks are bare)', unescaped.every((c) => c === '*' || c === '_'), unescaped.join(''));
  check('…and the fields are marked as cut', big.text.includes('…'));

  // ---- result
  const result = 'Cheapest: €49 on 3 May.\n\n' + 'detail '.repeat(1200);
  tasks.emit({ type: 'finished', taskId: task.id, status: 'done', title: task.title, result, error: '' });
  await tg.settled();
  const tail = api.sent().slice(-3);
  check('the result is sent back, split at 4096 characters, as plain text', tail.length >= 2 && tail.every((c) => c.body.text.length <= 4096 && !c.body.parse_mode) && tail.some((c) => c.body.text.startsWith('Done:')), tail.map((c) => c.body.text.length));
  // /stop
  await tg.handleUpdate(msg(OWNER, 'second request'));
  await tg.handleUpdate(msg(OWNER, '/stop'));
  await tg.settled();
  check('/stop stops the latest task Telegram started', [...tasks.tasks.values()].at(-1).status === 'stopped' && /Stopping/.test(lastText(api)));
  env.settings().telegramSignedIn = true;
  await tg.handleUpdate(msg(OWNER, 'third request'));
  check('with "Use my sign-ins" on, the task uses them', [...tasks.tasks.values()].at(-1).spec.signedIn === true);

  // ---- unpair
  tg.unpair();
  await tg.handleUpdate(msg(OWNER, 'after unpair'));
  check('after Unpair the old owner starts nothing', tasks.tasks.size === 3);
  tg.shutdown();

  // ---- the loop: polling, offset, backoff, bad token, setting off
  {
    const e = setup({ settings: { telegram: { bot: { id: 42, username: 'my_lumen_bot' }, owner: { id: OWNER, name: 'Sam' } } } });
    e.api.queue.push(msg(OWNER, 'from the loop'));
    e.tg.refresh();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(60);
    check('the loop polls and runs the owner\'s message', e.tasks.tasks.size === 1 && e.tg.running());
    check('…and remembers the offset so it is not run twice', e.settings().telegram.offset > 0);
    e.api.fail('network');
    await wait(60);
    const backs = e.sleeps.filter((ms) => ms !== 1000); // (1000: the pause after an empty poll that came back at once)
    check('network errors back off (doubling waits)', backs.length >= 2 && backs[0] === 2000 && backs[1] === 4000 && e.tg.status().state === 'retrying', e.sleeps);
    check('…and the error shown has no token in it', !e.tg.status().error.includes(TOKEN));
    e.api.fail({ status: 429, description: 'Too Many Requests', retry_after: 9 });
    await wait(30);
    check('429 waits as long as Telegram asks', e.sleeps.includes(9000), e.sleeps);
    e.api.fail({ status: 409, description: 'Conflict: terminated by other getUpdates request' });
    await wait(30);
    check('409 (another reader) is shown as a conflict and retried', e.tg.status().state === 'conflict' && e.tg.running());
    e.api.fail({ status: 401, description: 'Unauthorized' });
    await wait(40);
    check('401 stops polling: the token is bad', !e.tg.running() && e.tg.status().state === 'bad-token');
    e.api.fail(null);
    e.tg.refresh();
    check('…and it stays stopped until the token changes', !e.tg.running());
    await e.tg.setToken(TOKEN);
    check('a new token starts it again, same bot keeps its pairing', e.tg.running() && e.settings().telegram.owner?.id === OWNER);
    e.settings().telegramChannel = false;
    e.tg.refresh();
    check('turning the setting off stops polling', !e.tg.running() && e.tg.status().state === 'off');
    e.settings().telegramChannel = true;
    e.tg.refresh();
    check('turning it on starts it again', e.tg.running());
    e.tg.removeBot();
    check('Remove bot forgets the token and the pairing and stops', !e.tg.running() && e.token() === null && !e.settings().telegram.owner && e.tg.status().state === 'no-token');
    e.tg.shutdown();
  }
  {
    const e = setup({ settings: { telegramChannel: false } });
    let err = '';
    try { e.tg.startPairing(); } catch (x) { err = x.message; }
    check('pairing needs the setting on', /Turn on/.test(err));
    e.tg.refresh();
    check('with the setting off nothing is polled', !e.tg.running() && e.api.calls.length === 0);
  }
  {
    // Five wrong codes end the pairing.
    const e = setup({ settings: { telegram: { bot: { id: 42, username: 'b' } } } });
    e.tg.startPairing();
    const right = e.tg.pairCode();
    const bad = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < T.PAIR_TRIES; i++) await e.tg.handleUpdate(msg(STRANGER, `/pair ${bad}`));
    await e.tg.handleUpdate(msg(STRANGER, `/pair ${right}`));
    await e.tg.settled();
    check('after five wrong codes from one chat, even the right code from it no longer pairs', !e.settings().telegram.owner);
    check('…but the pairing goes on for other chats (one chat can\'t lock the owner out)', e.tg.pairCode() === right);
    await e.tg.handleUpdate(msg(OWNER, `/pair ${right}`));
    check('…and the owner\'s chat can still pair with it', e.settings().telegram.owner?.id === OWNER);
    let unpairFirst = '';
    try { e.tg.startPairing(); } catch (x) { unpairFirst = x.message; }
    check('with a chat paired, Pair is refused until Unpair', /Unpair first/.test(unpairFirst) && e.tg.pairCode() === null);
    e.tg.unpair();
    e.tg.startPairing();
    const right2 = e.tg.pairCode();
    const bad2 = right2 === '000000' ? '111111' : '000000';
    for (let c = 0; c < 4; c++) for (let i = 0; i < T.PAIR_TRIES; i++) await e.tg.handleUpdate(msg(7770000 + c, `/pair ${bad2}`));
    check('twenty wrong codes from many chats end the pairing for everyone', e.tg.pairCode() === null && !e.settings().telegram.owner);
    e.tg.startPairing();
    e.clock.now += 11 * 60000;
    await e.tg.handleUpdate(msg(OWNER, `/pair ${e.tg.pairCode() || '123456'}`));
    check('a code older than 10 minutes no longer pairs', !e.settings().telegram.owner);
    e.tg.shutdown();
  }

  // ---- loops never overlap, offsets are saved per update, and a stopped loop writes nothing
  {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const e = setup({ settings: { telegram: { bot: { id: 42, username: 'my_lumen_bot' }, owner: { id: OWNER, name: 'Sam' } } } });
    e.api.slow(40);
    e.tg.refresh(); // a long poll goes out
    await wait(10);
    e.api.queue.push(msg(OWNER, 'run me once'));
    e.settings().telegramChannel = false; e.tg.refresh(); // off and on again while the first poll is in flight
    e.settings().telegramChannel = true; e.tg.refresh();
    await wait(250);
    const runs = [...e.tasks.tasks.values()].filter((x) => x.spec.prompt === 'run me once').length;
    check('turning it off and on during a poll never runs a message twice', runs === 1, runs);
    e.tg.shutdown();
  }
  {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const e = setup({ settings: { telegram: { bot: { id: 42, username: 'my_lumen_bot' }, owner: { id: OWNER, name: 'Sam' } } } });
    const seen = [];
    const create = e.tasks.create;
    e.tasks.create = (spec) => { seen.push(e.settings().telegram.offset); return create(spec); };
    const a = msg(OWNER, 'first'); const b = msg(OWNER, 'second');
    e.api.queue.push(a, b);
    e.tg.refresh();
    await wait(60);
    check('each update\'s offset is saved before it is handled (a crash mid-batch never replays the ones done)', seen[0] === a.update_id + 1 && seen[1] === b.update_id + 1, JSON.stringify(seen));
    e.tg.shutdown();
  }
  {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const e = setup({ settings: { telegram: { bot: { id: 42, username: 'my_lumen_bot' }, owner: { id: OWNER, name: 'Sam' } } } });
    e.api.slow(40);
    e.tg.refresh();
    await wait(10);
    e.api.queue.push(msg(OWNER, 'arrives as the bot is removed'));
    e.tg.removeBot();
    await wait(120);
    check('a loop stopped by Remove bot handles nothing more and writes no stale offset', e.tasks.tasks.size === 0 && e.settings().telegram.offset === 0, JSON.stringify(e.settings().telegram));
  }
  {
    const e = setup({ settings: { telegram: { bot: { id: 42, username: 'my_lumen_bot' }, owner: { id: OWNER, name: 'Sam' } } } });
    e.tg.refresh();
    check('while on, it listens to task events', e.tasks.listeners() === 1);
    e.settings().telegramChannel = false;
    e.tg.refresh();
    check('turning it off stops listening to task events', e.tasks.listeners() === 0);
    e.settings().telegramChannel = true;
    e.tg.refresh();
    check('turning it on listens again (once)', e.tasks.listeners() === 1);
    e.tg.shutdown();
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
