// The focus block page (features/focus.js): ?url=<the blocked address>&site=<the listed site>, or ?status=1 (the toolbar's "End focus…").
// It shows the time left, "I need this for school" (that site for ten minutes; main notes it in the focus log) and End focus, which has to be
// held down: main counts the ten seconds too, so a script that skips the wait is refused. The bridge (window.lumenFocus) comes from
// preload/error-preload.js and only exists on this page; main takes the site from this page's own address.
const params = new URLSearchParams(location.search);
const blockedUrl = params.get('url') || '';
let parsed = null;
try { parsed = new URL(blockedUrl); } catch { /* no address: the status page */ }
const web = /^https?:$/.test(parsed?.protocol || '');
const host = web ? parsed.hostname.replace(/^www\./, '') : '';
const bridge = window.lumenFocus;
const $ = (id) => document.getElementById(id);
const tr = (key, fallback, vars) => {
  const s = window.t(key, vars);
  return s === key ? fallback.replace(/\{(\w+)\}/g, (w, n) => (vars && n in vars ? String(vars[n]) : w)) : s;
};

let state = null; // main's answer: { active, until, holdMs, allowMs, allows, ... }
let holding = null; // { timer, tick, began }
let ended = false;

const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const words = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? tr('focus.left.hm', '{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }) : tr('focus.left.m', '{m} min', { m });
};

function draw() {
  const on = Boolean(state?.active);
  const left = on ? Math.max(0, state.until - Date.now()) : 0;
  $('timer').textContent = on ? clock(left) : '';
  $('timer').setAttribute('aria-label', on ? tr('focus.page.left', '{time} left', { time: words(left) }) : '');
  $('allow').hidden = !(on && web);
  $('back').hidden = !on;
  $('continue').hidden = on || !web;
  $('end').hidden = !on;
  $('settings').parentElement.hidden = !bridge;
  if (on) {
    $('title').textContent = web ? tr('focus.page.blocked', '{host} is blocked while you focus', { host }) : tr('focus.page.on', 'Focus mode is on');
    $('summary').textContent = web ? tr('focus.page.summary', 'It is on your focus list. It opens again when the timer ends.') : tr('focus.page.statusSummary', 'The sites on your focus list are blocked until the timer ends.');
    $('allow-note').textContent = web ? tr('focus.page.allowNote', 'Opens {host} for {n} minutes. Lumen keeps a note of it in the focus log.', { host, n: Math.round((state.allowMs || 600000) / 60000) }) : '';
    if (!holding) {
      $('hold-label').textContent = tr('focus.page.hold', 'Hold to end focus');
      $('hold-note').textContent = tr('focus.page.holdNote', 'Press and hold for {n} seconds.', { n: Math.round((state.holdMs || 10000) / 1000) });
    }
    if (left === 0) refresh();
  } else {
    $('title').textContent = ended ? tr('focus.page.ended', 'Focus mode has ended') : tr('focus.page.over', 'Focus mode is over');
    $('summary').textContent = web ? tr('focus.page.overSummary', '{host} is open again.', { host }) : tr('focus.page.offSummary', 'Nothing is blocked now.');
    $('allow-note').textContent = '';
  }
  document.title = on ? tr('focus.page.titleOn', 'Focus mode · {time}', { time: clock(left) }) : tr('focus.page.title', 'Focus mode');
}

async function refresh() {
  if (!bridge) return;
  try { state = await bridge.state(); } catch { /* the page went away */ }
  draw();
}

// ---- I need this for school
$('allow').addEventListener('click', async () => {
  $('allow').disabled = true;
  try {
    const r = await bridge?.allow();
    if (r?.ok && web) { location.replace(blockedUrl); return; }
  } catch { /* fall through */ }
  $('allow').disabled = false;
  refresh();
});
$('continue').addEventListener('click', (e) => { e.preventDefault(); if (web) location.replace(blockedUrl); });
$('back').addEventListener('click', () => { if (history.length > 1) history.back(); else location.replace('newtab.html'); });
$('settings').addEventListener('click', (e) => { e.preventDefault(); bridge?.settings(); });

// ---- End focus: held for ten seconds
const holdButton = $('hold');
function stopHold() {
  if (!holding) return;
  clearTimeout(holding.timer);
  clearInterval(holding.tick);
  holding = null;
  holdButton.classList.remove('holding');
  bridge?.hold(false).catch(() => {});
  draw();
}
function startHold() {
  if (holding || !state?.active || !bridge) return;
  const ms = state.holdMs || 10000;
  const began = Date.now();
  holdButton.style.setProperty('--hold-ms', `${ms}ms`);
  holdButton.classList.add('holding');
  bridge.hold(true).catch(() => {});
  const seconds = () => Math.max(0, Math.ceil((ms - (Date.now() - began)) / 1000));
  const tick = setInterval(() => { $('hold-label').textContent = tr('focus.page.holding', 'Keep holding… {s}', { s: seconds() }); }, 250);
  holding = { began, tick, timer: setTimeout(finishHold, ms) };
  $('hold-label').textContent = tr('focus.page.holding', 'Keep holding… {s}', { s: seconds() });
}
async function finishHold() {
  clearInterval(holding?.tick);
  holding = null;
  holdButton.classList.remove('holding');
  let r = null;
  try { r = await bridge.end(); } catch { /* the page went away */ }
  if (r?.ok) ended = true;
  if (r?.state) state = r.state;
  draw();
}
holdButton.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  try { holdButton.setPointerCapture(e.pointerId); } catch { /* no capture: the button's own up and leave events end the hold */ }
  startHold();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) holdButton.addEventListener(type, stopHold);
holdButton.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startHold(); } });
holdButton.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stopHold(); });
holdButton.addEventListener('blur', stopHold);
holdButton.addEventListener('contextmenu', (e) => e.preventDefault());

draw();
refresh();
setInterval(draw, 1000);
setInterval(() => { if (!holding) refresh(); }, 5000);
