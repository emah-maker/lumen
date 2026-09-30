// Notes, Countdown and Timer: widgets that need no account and never go online. Their whole state is
// their config in the `homeWidgets` setting; features/widgets.js stores changes made on the card
// (typing a note, starting the timer) through page actions, and present() hands the page the current
// state on every read. The page counts seconds itself between reads (renderer/newtab-widgets.js).
//
//   cleanNote(n)           { text } (at most MAX_NOTE characters)
//   cleanCountdown(cd)     { date: 'YYYY-MM-DD', time: 'HH:MM' | '', label } or null
//   countdownTarget(cd)    the moment it counts to, in ms (local time)
//   cleanTimer(tm)         { work, rest, pomodoro, phase, endsAt, left, rounds }
//   timerStep(tm, arg, now) the timer after start | pause | reset | skip
//   timerView(tm, now)     { state: 'idle' | 'running' | 'paused' | 'done', phase, endsAt, left, total, rounds }
'use strict';

const MAX_NOTE = 4000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : '');
const int = (v, lo, hi, fallback) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : fallback);

// ---- Notes ----
const cleanNote = (n) => ({ text: str(n?.text, MAX_NOTE).replace(/\r\n?/g, '\n') });

// ---- Countdown ----
function cleanCountdown(cd) {
  if (!cd || typeof cd !== 'object') return null;
  const m = DATE_RE.exec(typeof cd.date === 'string' ? cd.date.trim() : '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1 || Number(m[1]) < 1970 || Number(m[1]) > 2200) return null; // 2026-02-31 isn't a day
  const time = typeof cd.time === 'string' && TIME_RE.test(cd.time.trim()) ? cd.time.trim() : '';
  return { date: m[0], time, label: str(cd.label, 60).replace(/\s+/g, ' ').trim() };
}
function countdownTarget(cd) {
  const [y, mo, d] = cd.date.split('-').map(Number);
  const [h, mi] = cd.time ? cd.time.split(':').map(Number) : [0, 0];
  return new Date(y, mo - 1, d, h, mi).getTime();
}

// ---- Timer (a plain countdown timer, or Pomodoro: focus and break in turn) ----
function cleanTimer(tm) {
  const t = tm && typeof tm === 'object' ? tm : {};
  const pomodoro = t.pomodoro !== false;
  const out = {
    work: int(t.work, 1, 180, 25), rest: int(t.rest, 1, 60, 5), pomodoro,
    phase: pomodoro && t.phase === 'rest' ? 'rest' : 'work',
    endsAt: Number.isFinite(t.endsAt) && t.endsAt > 0 ? t.endsAt : null,
    left: Number.isFinite(t.left) && t.left > 0 ? Math.min(t.left, 180 * 60e3) : null,
    rounds: int(t.rounds, 0, 9999, 0),
  };
  if (out.endsAt && out.left) out.left = null; // running wins
  return out;
}
const phaseMs = (t, phase = t.phase) => (phase === 'rest' ? t.rest : t.work) * 60e3;

function timerView(tm, now) {
  const t = cleanTimer(tm);
  const total = phaseMs(t);
  if (t.endsAt) return t.endsAt > now ? { state: 'running', phase: t.phase, endsAt: t.endsAt, left: t.endsAt - now, total, rounds: t.rounds, pomodoro: t.pomodoro } : { state: 'done', phase: t.phase, endsAt: t.endsAt, left: 0, total, rounds: t.rounds, pomodoro: t.pomodoro };
  if (t.left) return { state: 'paused', phase: t.phase, endsAt: null, left: t.left, total, rounds: t.rounds, pomodoro: t.pomodoro };
  return { state: 'idle', phase: t.phase, endsAt: null, left: total, total, rounds: t.rounds, pomodoro: t.pomodoro };
}

// start: from idle or paused runs; when a phase is done, a Pomodoro goes on to the other phase (a
// finished focus counts a round). pause keeps what is left. reset: back to idle focus. skip: the
// other phase, idle.
function timerStep(tm, arg, now) {
  const t = cleanTimer(tm);
  const v = timerView(t, now);
  const other = t.phase === 'work' ? 'rest' : 'work';
  if (arg === 'start') {
    if (v.state === 'running') return t;
    if (v.state === 'paused') return { ...t, endsAt: now + t.left, left: null };
    if (v.state === 'done') {
      const next = t.pomodoro ? other : t.phase;
      return { ...t, phase: next, rounds: t.rounds + (t.pomodoro && t.phase === 'work' ? 1 : 0), endsAt: now + phaseMs(t, next), left: null };
    }
    return { ...t, endsAt: now + phaseMs(t), left: null };
  }
  if (arg === 'pause') return v.state === 'running' ? { ...t, endsAt: null, left: v.left } : t;
  if (arg === 'reset') return { ...t, phase: 'work', endsAt: null, left: null };
  if (arg === 'skip') return t.pomodoro ? { ...t, phase: other, endsAt: null, left: null, rounds: t.rounds + (t.phase === 'work' && v.state === 'done' ? 1 : 0) } : t;
  return t;
}

module.exports = { MAX_NOTE, cleanNote, cleanCountdown, countdownTarget, cleanTimer, timerView, timerStep };
