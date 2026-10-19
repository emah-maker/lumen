// [telegram] Phone (Telegram): the user talks to Lumen's AI from their phone through a Telegram bot of their own
// (made with @BotFather). Lumen has no server, so it asks Telegram's Bot API for new messages itself (getUpdates long
// polling over HTTPS, from the main process) while it runs and the setting (telegramChannel, off by default) is on.
//
// - The bot token is stored encrypted with the OS keychain (main.js keys.telegram), never logged and never shown again.
// - Pairing: Settings shows a 6-digit code for 10 minutes; the user sends "/pair <code>" to the bot, and that one chat
//   becomes the owner. Every other chat is ignored (one polite reply an hour at most). Five wrong codes end the pairing.
// - A message from the owner becomes a background task (features/background-runner.js create, like /background with
//   the default model). The reply is "Working on it…", then the result, split at Telegram's 4096 characters.
// - The task's approval cards (a new site, a buy / send / submit step) come to the phone with Allow / Deny buttons,
//   answered through the runner's approve(), the same call as the Tasks panel. Unanswered, the task's usual timeout
//   denies them. Nothing here allows anything by itself.
// - Polling stops when the setting is off, the token is removed, or Telegram rejects the token; errors back off.
// Pure apart from deps (fetch is injected: test/telegram-units.js runs it against a fake Bot API).
const crypto = require('crypto');

const API = 'https://api.telegram.org';
const MAX_TEXT = 4096; // Telegram's limit for one message
const POLL_TIMEOUT_S = 25; // long poll: Telegram holds the request until a message comes, or this long
const PAIR_TTL_MS = 10 * 60000;
const PAIR_TRIES = 5;
const STRANGER_REPLY_MS = 60 * 60000; // at most one reply an hour to a chat that is not the owner
const STALE_S = 10 * 60; // a message older than this (sent while Lumen was closed) is not run
const OFFLINE_WAIT_MS = 15000;
const QUICK_POLL_MS = 1000;
const BACKOFF = { base: 2000, max: 5 * 60000 };
const ACTIVE = new Set(['queued', 'running', 'waiting-approval']);
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

const validToken = (token) => TOKEN_RE.test(String(token || '').trim());

// An error message with any bot token in it blanked out (a failed request's message can carry its URL).
function scrub(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('<token>');
  return s.replace(/\d{5,15}:[A-Za-z0-9_-]{30,60}/g, '<token>');
}

// MarkdownV2 needs every one of these escaped outside entities (core.telegram.org/bots/api#markdownv2-style).
const escapeMarkdownV2 = (text) => String(text ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

// Text in pieces Telegram accepts: at most `limit` characters each, cut at a paragraph, a line or a space when one is
// in the second half of the piece, never inside a surrogate pair.
function splitMessage(text, limit = MAX_TEXT) {
  let rest = String(text ?? '').trim();
  const out = [];
  while (rest.length > limit) {
    const part = rest.slice(0, limit);
    let cut = part.lastIndexOf('\n\n');
    if (cut < limit / 2) cut = part.lastIndexOf('\n');
    if (cut < limit / 2) cut = part.lastIndexOf(' ');
    if (cut < limit / 2) cut = limit;
    if (cut === limit && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

// "/pair 123456", "/status@my_bot": { cmd, arg }, or null for plain text (or a command meant for another bot).
function parseCommand(text, botName = '') {
  const m = /^\/([a-z]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  if (m[2] && botName && m[2].toLowerCase() !== String(botName).toLowerCase()) return null;
  return { cmd: m[1].toLowerCase(), arg: (m[3] || '').trim() };
}

// How long to wait after `failures` failed polls in a row: doubling from 2 s up to 5 minutes, or what Telegram asked
// for (429's retry_after).
function backoffDelay(failures, retryAfter) {
  if (Number(retryAfter) > 0) return Math.min(Number(retryAfter) * 1000, BACKOFF.max);
  return Math.min(BACKOFF.max, BACKOFF.base * 2 ** Math.max(0, failures - 1));
}

const newPairCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const sameCode = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Inline-button data (Telegram allows 64 bytes): "a:<task id>:<approval id>:y|n".
const callbackData = (taskId, approvalId, allow) => `a:${taskId}:${approvalId}:${allow ? 'y' : 'n'}`;
function parseCallback(data) {
  const m = /^a:([a-f0-9]{16}):(\d{1,9}):([yn])$/.exec(String(data || ''));
  return m ? { taskId: m[1], approvalId: Number(m[2]), allow: m[3] === 'y' } : null;
}

// deps: { fetch(url, init) -> Response, readSettings, writeSettings, getToken() -> string|null, setToken(token|null),
//         canEncrypt(), isOnline?(), t(key, params), now?(), sleep?(ms, signal), pollTimeout? (seconds),
//         tasks: { create(spec), stop(id), approve(id, approvalId, choice), find(id), subscribe(fn), approvalWaitMin() } }
// Settings: telegramChannel (on/off), telegramSignedIn (tasks use the user's sign-ins); settings.telegram holds
// { bot: { id, username }, owner: { id, name }, offset }, which only this file writes.
function create(deps) {
  const now = deps.now || (() => Date.now());
  const t = deps.t;
  const sleep = deps.sleep || ((ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }));
  const pollTimeout = deps.pollTimeout ?? POLL_TIMEOUT_S;
  let loop = null; // { controller, stopped }
  let state = 'off'; // off | no-token | polling | offline | retrying | conflict | bad-token
  let lastError = '';
  let halted = false; // Telegram refused the token: no polling until it changes
  let failures = 0;
  let pair = null; // { code, expires, tries }
  const strangers = new Map(); // chat id -> when it was last answered
  const ours = new Map(); // task id -> { chatId, title, cards: Map(approvalId -> { messageId, text, done }) }
  let unsubscribe = null;
  let sendChain = Promise.resolve(); // messages go out one at a time, in order

  const tg = () => { const v = deps.readSettings().telegram; return v && typeof v === 'object' ? v : {}; };
  const saveTg = (patch) => deps.writeSettings({ ...deps.readSettings(), telegram: { ...tg(), ...patch } });
  const enabled = () => deps.readSettings().telegramChannel === true;
  const ownerId = () => (Number.isSafeInteger(tg().owner?.id) ? tg().owner.id : null);
  const log = (what, err) => console.error(`[lumen] telegram: ${what}:`, scrub(err?.message || err, deps.getToken()));

  // ---- the Bot API
  async function call(method, params = {}, { signal, timeoutMs = 20000, token } = {}) {
    const key = token || deps.getToken();
    if (!key) throw Object.assign(new Error('No bot token.'), { status: 401 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res;
      try {
        res = await deps.fetch(`${API}/bot${key}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: controller.signal });
      } catch (err) {
        throw new Error(scrub(err?.message || err, key)); // offline, DNS, timeout: no status
      }
      let data = null;
      try { data = await res.json(); } catch { /* not JSON: a proxy's page */ }
      if (!data || data.ok !== true) {
        const err = new Error(scrub(data?.description || `HTTP ${res.status}`, key));
        err.status = Number(data?.error_code || res.status) || 0;
        err.retryAfter = data?.parameters?.retry_after;
        throw err;
      }
      return data.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // Send text (split as needed). Resolves to the last message Telegram made, or null when sending failed.
  function send(chatId, text, extra = {}) {
    const run = async () => {
      const parts = extra.parse_mode ? [String(text).slice(0, MAX_TEXT)] : splitMessage(text);
      let last = null;
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        try {
          last = await call('sendMessage', { chat_id: chatId, text: parts[i], disable_web_page_preview: true, ...(isLast ? extra : { ...extra, reply_markup: undefined }) });
        } catch (err) { log('could not send a message', err); return null; }
      }
      return last;
    };
    const p = sendChain.then(run);
    sendChain = p.catch(() => {});
    return p;
  }

  function edit(chatId, messageId, text, extra = {}) {
    const run = () => call('editMessageText', { chat_id: chatId, message_id: messageId, text: String(text).slice(0, MAX_TEXT), ...extra }).catch((err) => log('could not update a message', err));
    const p = sendChain.then(run);
    sendChain = p.catch(() => {});
    return p;
  }

  // ---- incoming
  function strangerReply(chatId) {
    const last = strangers.get(chatId) || 0;
    if (now() - last < STRANGER_REPLY_MS) return null;
    if (strangers.size > 500) strangers.clear(); // (a flood of chats: start over rather than grow)
    strangers.set(chatId, now());
    return send(chatId, t('telegram.reply.stranger'));
  }

  function pairingActive() {
    if (pair && now() > pair.expires) pair = null;
    return Boolean(pair);
  }

  async function tryPair(msg, code) {
    const chatId = msg.chat.id;
    if (!pairingActive()) return strangerReply(chatId);
    pair.tries++;
    if (sameCode(code, pair.code)) {
      pair = null;
      const name = String(msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'Telegram').slice(0, 64);
      saveTg({ owner: { id: chatId, name } });
      strangers.delete(chatId);
      return send(chatId, t('telegram.reply.paired'));
    }
    if (pair.tries >= PAIR_TRIES) { pair = null; return send(chatId, t('telegram.reply.pairLocked')); }
    return send(chatId, t('telegram.reply.pairWrong'));
  }

  const activeOurs = () => [...ours.entries()].map(([id, entry]) => ({ id, entry, task: deps.tasks.find(id) })).filter((x) => x.task && ACTIVE.has(x.task.status));

  async function onOwnerMessage(msg) {
    const chatId = msg.chat.id;
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text) return send(chatId, t('telegram.reply.textOnly'));
    const command = parseCommand(text, tg().bot?.username);
    if (command) {
      if (command.cmd === 'help' || command.cmd === 'start') return send(chatId, t('telegram.reply.help'));
      if (command.cmd === 'pair') return pairingActive() ? tryPair(msg, command.arg) : send(chatId, t('telegram.reply.alreadyPaired'));
      if (command.cmd === 'status') {
        const list = activeOurs();
        if (!list.length) return send(chatId, t('telegram.reply.nothingRunning'));
        return send(chatId, [t('telegram.reply.statusHead'), ...list.map(({ task }) => `- ${task.title} (${t(`telegram.status.${task.status}`)})`)].join('\n'));
      }
      if (command.cmd === 'stop') {
        const latest = activeOurs().pop();
        if (!latest) return send(chatId, t('telegram.reply.nothingToStop'));
        deps.tasks.stop(latest.id);
        return send(chatId, t('telegram.reply.stopping', { title: latest.task.title }));
      }
      if (command.cmd !== 'background') return send(chatId, t('telegram.reply.unknownCommand'));
    }
    const prompt = command?.cmd === 'background' ? command.arg : text;
    if (!prompt) return send(chatId, t('telegram.reply.help'));
    let task;
    try {
      task = deps.tasks.create({ prompt, schedule: { type: 'now' }, signedIn: deps.readSettings().telegramSignedIn === true, confirmed: true });
    } catch (err) {
      return send(chatId, t('telegram.reply.couldNot', { error: String(err?.message || err).slice(0, 300) }));
    }
    ours.set(task.id, { chatId, title: task.title, cards: new Map() });
    while (ours.size > 50) ours.delete(ours.keys().next().value);
    return send(chatId, t('telegram.reply.working'));
  }

  async function onCallback(q) {
    const answer = (text) => call('answerCallbackQuery', { callback_query_id: q.id, text }).catch((err) => log('could not answer a button', err));
    const owner = ownerId();
    if (owner === null || q.from?.id !== owner || q.message?.chat?.id !== owner) return answer(t('telegram.reply.notYours'));
    const parsed = parseCallback(q.data);
    const entry = parsed && ours.get(parsed.taskId);
    const card = entry?.cards.get(parsed.approvalId);
    if (!parsed || !card || card.done) return answer(t('telegram.reply.alreadyAnswered'));
    // The same call as the Tasks panel's buttons: Allow is "once" (this step), never "always".
    const ok = deps.tasks.approve(parsed.taskId, parsed.approvalId, parsed.allow ? 'once' : 'deny');
    if (!ok) return answer(t('telegram.reply.alreadyAnswered'));
    card.done = true;
    const said = parsed.allow ? t('telegram.reply.allowed') : t('telegram.reply.denied');
    await answer(said);
    return edit(entry.chatId, card.messageId, `${card.text}\n\n${escapeMarkdownV2(said)}`, { parse_mode: 'MarkdownV2' });
  }

  async function handleUpdate(u) {
    if (u.callback_query) return onCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.chat || msg.chat.type !== 'private') return null; // groups and channels: never
    const chatId = msg.chat.id;
    const owner = ownerId();
    const command = parseCommand(msg.text, tg().bot?.username);
    if (owner === null || chatId !== owner) {
      if (command?.cmd === 'pair') return tryPair(msg, command.arg);
      return strangerReply(chatId);
    }
    if (Number(msg.date) && now() / 1000 - Number(msg.date) > STALE_S) return send(chatId, t('telegram.reply.stale'));
    return onOwnerMessage(msg);
  }

  async function pollOnce(signal) {
    const offset = Number(tg().offset) || 0;
    const updates = await call('getUpdates', { offset, timeout: pollTimeout, allowed_updates: ['message', 'callback_query'] }, { signal, timeoutMs: (pollTimeout + 15) * 1000 });
    let next = offset;
    for (const u of Array.isArray(updates) ? updates : []) {
      if (Number.isSafeInteger(u?.update_id)) next = Math.max(next, u.update_id + 1);
      try { await handleUpdate(u); } catch (err) { log('could not handle a message', err); }
    }
    if (next !== offset) saveTg({ offset: next }); // (Telegram forgets what was confirmed: the next getUpdates with this offset)
    return updates;
  }

  // ---- the loop
  function setState(s, error = '') { state = s; lastError = error; }

  async function runLoop(l) {
    while (!l.stopped) {
      if (deps.isOnline && deps.isOnline() === false) { setState('offline'); await sleep(OFFLINE_WAIT_MS, l.controller.signal); continue; }
      try {
        const started = now();
        const updates = await pollOnce(l.controller.signal);
        failures = 0;
        if (!l.stopped) setState('polling');
        // A long poll that came back at once with nothing (a proxy that doesn't hold the request): don't spin.
        if (!updates?.length && now() - started < QUICK_POLL_MS) await sleep(QUICK_POLL_MS, l.controller.signal);
      } catch (err) {
        if (l.stopped) break;
        if (err.status === 401 || err.status === 404) { halted = true; setState('bad-token', t('telegram.state.badToken')); break; }
        failures++;
        setState(err.status === 409 ? 'conflict' : 'retrying', scrub(err.message, deps.getToken()));
        await sleep(backoffDelay(failures, err.retryAfter), l.controller.signal);
      }
    }
    if (loop === l) loop = null;
  }

  function stopLoop() {
    if (!loop) return;
    loop.stopped = true;
    loop.controller.abort();
    loop = null;
  }

  // Start or stop polling to match the setting and the token. Called at startup and after every change.
  function refresh() {
    const token = deps.getToken();
    const want = enabled() && Boolean(token) && !halted;
    if (want && !unsubscribe && deps.tasks.subscribe) unsubscribe = deps.tasks.subscribe(onTaskEvent);
    if (want && !loop) {
      const l = { controller: new AbortController(), stopped: false };
      loop = l;
      failures = 0;
      setState('polling');
      runLoop(l).catch((err) => log('polling stopped', err));
    } else if (!want) {
      stopLoop();
      if (!halted) setState(!enabled() ? 'off' : 'no-token');
    }
  }

  // ---- task events (features/background-runner.js subscribe)
  function onTaskEvent(e) {
    const entry = ours.get(e?.taskId);
    if (!entry) return;
    if (e.type === 'approval') {
      const c = e.card || {};
      const title = c.title || t('telegram.card.interact', { host: c.host || '?' });
      const lines = [`*${escapeMarkdownV2(t('telegram.card.head', { title: entry.title }))}*`, escapeMarkdownV2(title)];
      if (c.host && c.title) lines.push(escapeMarkdownV2(t('telegram.card.site', { host: c.host })));
      if (c.query) lines.push(escapeMarkdownV2(String(c.query).slice(0, 300)));
      if (c.args) lines.push(escapeMarkdownV2(String(c.args).slice(0, 1200)));
      lines.push(`_${escapeMarkdownV2(t('telegram.card.wait', { minutes: deps.tasks.approvalWaitMin?.() || 60 }))}_`);
      const text = lines.join('\n\n');
      const card = { messageId: null, text, done: false };
      entry.cards.set(e.approvalId, card);
      send(entry.chatId, text, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{ text: t('telegram.button.allow'), callback_data: callbackData(e.taskId, e.approvalId, true) }, { text: t('telegram.button.deny'), callback_data: callbackData(e.taskId, e.approvalId, false) }]] },
      }).then((m) => {
        card.messageId = m?.message_id ?? null;
        if (card.closedAs && card.messageId) closeCard(entry, card, card.closedAs); // answered in Lumen before Telegram answered us
      });
    } else if (e.type === 'approval_done') {
      const card = entry.cards.get(e.approvalId);
      if (!card || card.done) return;
      card.done = true;
      const as = e.ok ? 'telegram.reply.allowedElsewhere' : 'telegram.reply.deniedElsewhere';
      if (card.messageId) closeCard(entry, card, as); else card.closedAs = as;
    } else if (e.type === 'finished') {
      ours.delete(e.taskId);
      const result = String(e.result || '').trim();
      const text = e.status === 'done' ? `${t('telegram.reply.done', { title: e.title || entry.title })}\n\n${result || t('telegram.reply.noResult')}`
        : e.status === 'stopped' ? t('telegram.reply.stopped', { title: e.title || entry.title })
          : `${t('telegram.reply.failed', { title: e.title || entry.title, error: e.error || '' })}${result ? `\n\n${result}` : ''}`;
      send(entry.chatId, text);
    }
  }
  function closeCard(entry, card, key) {
    return edit(entry.chatId, card.messageId, `${card.text}\n\n${escapeMarkdownV2(t(key))}`, { parse_mode: 'MarkdownV2' });
  }

  // ---- Settings → AI and agents → Phone (Telegram)
  function status() {
    const s = tg();
    return {
      enabled: enabled(),
      signedIn: deps.readSettings().telegramSignedIn === true,
      hasToken: Boolean(deps.getToken()),
      canEncrypt: deps.canEncrypt(),
      bot: s.bot?.username ? { username: s.bot.username } : null,
      owner: ownerId() !== null ? { name: s.owner.name || '' } : null,
      state, error: lastError,
      pairing: pairingActive() ? { code: pair.code, expires: pair.expires } : null,
    };
  }

  async function setToken(raw) {
    const token = String(raw || '').trim();
    if (!validToken(token)) throw new Error(t('telegram.error.tokenFormat'));
    if (!deps.canEncrypt()) throw new Error(t('telegram.error.noKeychain'));
    let me;
    try { me = await call('getMe', {}, { token, timeoutMs: 15000 }); } catch (err) {
      throw new Error(err.status === 401 || err.status === 404 ? t('telegram.error.tokenRejected') : t('telegram.error.unreachable'));
    }
    stopLoop();
    deps.setToken(token);
    const sameBot = tg().bot?.id === me?.id;
    saveTg({ bot: { id: me?.id, username: String(me?.username || '').slice(0, 64) }, ...(sameBot ? {} : { owner: null, offset: 0 }) }); // a different bot: pair again
    halted = false;
    pair = null;
    refresh();
    return status();
  }

  function startPairing() {
    if (!deps.getToken()) throw new Error(t('telegram.error.noToken'));
    if (!enabled()) throw new Error(t('telegram.error.off'));
    pair = { code: newPairCode(), expires: now() + PAIR_TTL_MS, tries: 0 };
    refresh();
    return status();
  }

  function cancelPairing() { pair = null; return status(); }

  function unpair() {
    pair = null;
    saveTg({ owner: null });
    ours.clear();
    return status();
  }

  function removeBot() {
    stopLoop();
    pair = null;
    deps.setToken(null);
    saveTg({ bot: null, owner: null, offset: 0 });
    ours.clear();
    halted = false;
    refresh();
    return status();
  }

  // IPC for the settings page (main.js gates settings:* to it: PRIVILEGED_IPC). The token goes in, never comes back.
  function register(ipcMain) {
    ipcMain.handle('settings:telegram', () => status());
    ipcMain.handle('settings:telegram-token', (_e, token) => setToken(token));
    ipcMain.handle('settings:telegram-pair', () => startPairing());
    ipcMain.handle('settings:telegram-pair-cancel', () => cancelPairing());
    ipcMain.handle('settings:telegram-unpair', () => unpair());
    ipcMain.handle('settings:telegram-remove', () => removeBot());
  }

  function shutdown() {
    stopLoop();
    unsubscribe?.();
    unsubscribe = null;
  }

  return {
    refresh, shutdown, register, status, setToken, startPairing, cancelPairing, unpair, removeBot,
    // Test hooks (test/telegram-units.js)
    pollOnce, handleUpdate, onTaskEvent, settled: () => sendChain, running: () => Boolean(loop), pairCode: () => pair?.code || null,
  };
}

module.exports = { create, validToken, scrub, escapeMarkdownV2, splitMessage, parseCommand, backoffDelay, callbackData, parseCallback, newPairCode, MAX_TEXT, PAIR_TRIES, STALE_S };
