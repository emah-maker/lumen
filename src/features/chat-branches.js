// Per-message details and versions of a chat (regenerate and edit keep the earlier answers). Plain data, no Electron.
//
// Every field is additive and optional: a chat file saved before this existed has none of it and loads exactly as before.
//   message meta (kept beside a message, never inside its content, so no request carries it):
//     { id, at, thinking, thinkingMs, tools: [{ label, ok }], auto: { label, reason }, feedback: 'up' | 'down' }
//   forks (snapshot.forks): where the chat branched. A fork sits at the index of the user message whose exchange was asked
//     again; `tails` holds every version of the chat from that index on, `cur` is the one that is live in `messages`
//     (its slot is null). A tail is { messages, forks }: the forks inside it travel with it.
const crypto = require('crypto');

const metas = new WeakMap(); // message -> meta

const THINKING_CHARS = 20000;
const MAX_TOOLS = 60;
const LABEL_CHARS = 200;
const INPUT_CHARS = 1500; // a step's input is kept (to name it again, and to show its command) only when it is small (step-labels.js compactInput bounds it)
const THUMB_CHARS = 90000; // [activity cards] the last frame of the tab, a small JPEG as base64 (about 60 KB)

const newId = () => crypto.randomBytes(6).toString('hex');
const getMeta = (m) => (m && typeof m === 'object' ? metas.get(m) || null : null);
function setMeta(m, patch) {
  if (!m || typeof m !== 'object') return null;
  const meta = { ...(metas.get(m) || {}), ...patch };
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k]; // (a field set to undefined is removed)
  metas.set(m, meta);
  return meta;
}

// A meta read from disk or built from a run: only known fields, bounded. Anything odd is left out, never thrown.
function cleanMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (typeof raw.id === 'string' && /^[\w-]{1,24}$/.test(raw.id)) out.id = raw.id;
  if (Number.isFinite(raw.at) && raw.at > 0) out.at = Math.round(raw.at);
  if (typeof raw.thinking === 'string' && raw.thinking) out.thinking = raw.thinking.slice(0, THINKING_CHARS);
  if (Number.isFinite(raw.thinkingMs) && raw.thinkingMs >= 0) out.thinkingMs = Math.round(raw.thinkingMs);
  if (Array.isArray(raw.tools)) {
    const tools = raw.tools.filter((t) => t && (typeof t.label === 'string' || typeof t.name === 'string')).slice(0, MAX_TOOLS).map((t) => {
      const input = t.input && typeof t.input === 'object' && JSON.stringify(t.input).length <= INPUT_CHARS ? t.input : null;
      return { label: typeof t.label === 'string' ? t.label.slice(0, LABEL_CHARS) : '', ...(typeof t.name === 'string' ? { name: t.name.slice(0, 60) } : {}), ...(input ? { input } : {}), ...(Number.isInteger(t.tab) && t.tab >= 0 && t.tab < 1e9 ? { tab: t.tab } : {}), ok: t.ok !== false };
    });
    if (tools.length) out.tools = tools;
  }
  if (raw.tabs && typeof raw.tabs === 'object' && !Array.isArray(raw.tabs)) { // [tab chips] the tabs a reply names, as they were: { id: { t: title, u: address, s: the run of the app whose ids they are } }
    const tabs = {};
    for (const [id, v] of Object.entries(raw.tabs).slice(0, 40)) {
      if (!/^\d{1,9}$/.test(id) || !v || typeof v !== 'object') continue;
      tabs[id] = { t: typeof v.t === 'string' ? v.t.slice(0, 200) : '', u: typeof v.u === 'string' ? v.u.slice(0, 1000) : '', s: typeof v.s === 'string' && /^[0-9a-f]{8}$/.test(v.s) ? v.s : '' };
    }
    if (Object.keys(tabs).length) out.tabs = tabs;
  }
  if (raw.cards === true) out.cards = true;
  if (typeof raw.task === 'string' && raw.task) out.task = raw.task.slice(0, 120);
  if (raw.thumb && typeof raw.thumb === 'object' && typeof raw.thumb.data === 'string' && raw.thumb.data.length <= THUMB_CHARS && /^[A-Za-z0-9+/=]+$/.test(raw.thumb.data)) out.thumb = { data: raw.thumb.data, ...(Number.isInteger(raw.thumb.tabId) && raw.thumb.tabId >= 0 && raw.thumb.tabId < 1e9 ? { tabId: raw.thumb.tabId } : {}), ...(typeof raw.thumb.s === 'string' && /^[0-9a-f]{8}$/.test(raw.thumb.s) ? { s: raw.thumb.s } : {}), ...(typeof raw.thumb.url === 'string' ? { url: raw.thumb.url.slice(0, 500) } : {}), ...(typeof raw.thumb.title === 'string' ? { title: raw.thumb.title.slice(0, 120) } : {}) };
  if (raw.auto && typeof raw.auto === 'object' && typeof raw.auto.label === 'string') out.auto = { label: raw.auto.label.slice(0, 120), ...(typeof raw.auto.reason === 'string' ? { reason: raw.auto.reason.slice(0, 300) } : {}) };
  if (raw.feedback === 'up' || raw.feedback === 'down') out.feedback = raw.feedback;
  return Object.keys(out).length ? out : null;
}

// ---- saving and loading (`ser` / `hyd` are the agent's own message copiers, which carry the model author)
function serializeMessages(messages, ser) {
  return messages.map((m) => {
    const out = ser(m);
    const meta = getMeta(m);
    if (meta) out.meta = meta;
    return out;
  });
}
function hydrateMessages(raw, hyd) {
  return (Array.isArray(raw) ? raw : []).filter((m) => m && typeof m === 'object').map((r) => {
    const m = hyd(r);
    const meta = cleanMeta(r.meta);
    if (meta) metas.set(m, meta);
    return m;
  });
}
function serializeForks(forks, ser) {
  if (!Array.isArray(forks) || !forks.length) return undefined;
  return forks.map((f) => ({
    at: f.at,
    cur: f.cur,
    tails: f.tails.map((t) => (t ? { messages: serializeMessages(t.messages, ser), forks: serializeForks(t.forks, ser) || [] } : null)),
  }));
}
// Forks from a saved chat; ones that don't make sense are dropped (never an exception: the chat itself must still open).
function hydrateForks(raw, hyd, depth = 0) {
  if (!Array.isArray(raw) || depth > 8) return [];
  const out = [];
  for (const f of raw) {
    if (!f || !Number.isInteger(f.at) || f.at < 0 || !Array.isArray(f.tails) || f.tails.length < 2 || !Number.isInteger(f.cur) || f.cur < 0 || f.cur >= f.tails.length || f.tails[f.cur] !== null) continue;
    if (f.tails.some((t, i) => i !== f.cur && !(t && Array.isArray(t.messages)))) continue;
    out.push({
      at: f.at,
      cur: f.cur,
      tails: f.tails.map((t) => (t ? { messages: hydrateMessages(t.messages, hyd), forks: hydrateForks(t.forks, hyd, depth + 1) } : null)),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---- versions
// The chat is about to be cut at `at` (messages.splice(at) gave `tail`): keep that tail as a version. The new live tail is
// empty so far (its slot is null) and is filled by whatever is asked next. An empty tail keeps nothing.
function keepVersion(messages, at, tail) {
  if (!tail.length) return null;
  const forks = (messages.forks ||= []);
  const inner = forks.filter((f) => f.at > at);
  for (const f of inner) forks.splice(forks.indexOf(f), 1);
  const old = { messages: tail, forks: inner };
  let fork = forks.find((f) => f.at === at);
  if (fork) {
    fork.tails[fork.cur] = old;
    fork.tails.push(null);
    fork.cur = fork.tails.length - 1;
  } else {
    fork = { at, cur: 1, tails: [old, null] };
    forks.push(fork);
    forks.sort((a, b) => a.at - b.at);
  }
  return fork;
}

// Make version `target` the live one. Returns false when there is no such fork or version.
function switchVersion(messages, at, target) {
  const forks = messages.forks;
  const fork = forks?.find((f) => f.at === at);
  if (!fork || !Number.isInteger(target) || target < 0 || target >= fork.tails.length || target === fork.cur || !fork.tails[target]) return false;
  if (at > messages.length) return false;
  const inner = forks.filter((f) => f.at > at);
  for (const f of inner) forks.splice(forks.indexOf(f), 1);
  fork.tails[fork.cur] = { messages: messages.splice(at), forks: inner };
  const next = fork.tails[target];
  fork.tails[target] = null;
  fork.cur = target;
  messages.push(...next.messages);
  forks.push(...next.forks);
  forks.sort((a, b) => a.at - b.at);
  return true;
}

// The chat's start was cut off (/compact replaced the first `cut` messages with a summary): forks inside that part go,
// the rest move up with the messages.
function shiftForks(messages, cut) {
  if (!messages.forks?.length || !(cut > 0)) return;
  messages.forks = messages.forks.filter((f) => f.at >= cut).map((f) => ({ ...f, at: f.at - cut }));
}

const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(m?.content ?? ''));
// What a fork shows the chat: how many versions, which is live, and whether they all answer the same message (a Regenerate:
// the switcher goes on the reply) or not (an Edit: it goes on the message). null when there is nothing to switch.
function forkView(messages, at) {
  const fork = messages.forks?.find((f) => f.at === at);
  if (!fork || at >= messages.length) return null;
  const firsts = fork.tails.map((t, i) => (i === fork.cur ? messages[at] : t?.messages[0]));
  const same = firsts.every((m) => textOf(m).trim() === textOf(firsts[0]).trim());
  return { at, n: fork.tails.length, cur: fork.cur + 1, same };
}

module.exports = { getMeta, setMeta, cleanMeta, newId, serializeMessages, hydrateMessages, serializeForks, hydrateForks, keepVersion, switchVersion, shiftForks, forkView };
