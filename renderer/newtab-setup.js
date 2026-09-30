// [widgets] Adding and editing widgets on the new-tab page itself, for the kinds with no key, sign-in
// or private address (features/widgets.js INLINE: Notes, Countdown, Timer, TradingView, Custom, Web
// page). The form is a small dialog; Save sends its input as ?widget=<id|wcreate>&do=setup&cfg=<json>
// (the browser cancels that navigation), main.js checks it exactly as Settings would and answers
// through window.widgetSetupResult({ ok, message, id }). Every other kind opens Settings.
(function () {
'use strict';

const KINDS = ['notes', 'countdown', 'timer', 'tradingview', 'custom', 'embed'];
const NAMES = { notes: 'Notes', countdown: 'Countdown', timer: 'Timer', tradingview: 'TradingView', custom: 'Custom', embed: 'Web page' };
const INTERVALS = [['1', '1 minute'], ['5', '5 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['D', '1 day'], ['W', '1 week'], ['M', '1 month']];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
};
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
function field(label, control, hint) {
  const wrap = el('label', 'ws-field');
  wrap.append(el('span', 'ws-label', label), control);
  if (hint) wrap.append(el('span', 'ws-hint', hint));
  return wrap;
}
function input(type, value, attrs = {}) {
  const i = el('input');
  i.type = type;
  i.value = value ?? '';
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  return i;
}
function select(options, value) {
  const s = el('select');
  for (const [v, t] of options) { const o = el('option', null, t); o.value = v; s.append(o); }
  s.value = String(value ?? options[0][0]);
  return s;
}

// Each kind: its fields (from what is saved, if anything) and read() -> the input main.js checks.
const FORMS = {
  notes: () => ({ nodes: [el('p', 'ws-note', 'Type straight on the card. It saves as you go and stays on this computer.')], read: () => ({}) }),
  countdown(s) {
    const cd = s.cd || {};
    const label = input('text', cd.label, { maxlength: '60', placeholder: 'Vacation' });
    const date = input('date', cd.date);
    const time = input('time', cd.time);
    return { nodes: [field('Name', label), field('Date', date), field('Time', time, 'Optional.')], read: () => ({ cd: { label: label.value, date: date.value, time: time.value } }), first: label };
  },
  timer(s) {
    const tm = s.tm || {};
    const kind = select([['pomodoro', 'Pomodoro (focus, then a break)'], ['timer', 'Plain timer']], tm.pomodoro === false ? 'timer' : 'pomodoro');
    const work = input('number', String(tm.work || 25), { min: '1', max: '180' });
    const rest = input('number', String(tm.rest || 5), { min: '1', max: '60' });
    const restField = field('Break minutes', rest);
    const sync = () => { restField.hidden = kind.value !== 'pomodoro'; };
    kind.addEventListener('change', sync);
    sync();
    return { nodes: [field('Kind', kind), field('Minutes', work), restField], read: () => ({ tm: { pomodoro: kind.value === 'pomodoro', work: Number(work.value), rest: Number(rest.value) } }), first: kind };
  },
  tradingview(s) {
    const tv = s.tv || {};
    const symbol = input('text', tv.view === 'watchlist' ? '' : tv.symbol, { maxlength: '52', placeholder: 'NASDAQ:AAPL', spellcheck: 'false', autocomplete: 'off' });
    const view = select([['chart', 'Full chart'], ['mini', 'Mini chart'], ['watchlist', 'Watchlist']], tv.view || 'chart');
    const interval = select(INTERVALS, tv.interval || 'D');
    const theme = select([['auto', 'Follow light and dark mode'], ['light', 'Light'], ['dark', 'Dark']], tv.theme || 'auto');
    const saved = Array.isArray(tv.symbols) ? tv.symbols.join('\n') : '';
    const symbols = el('textarea', 'ws-code');
    symbols.rows = 6;
    symbols.spellcheck = false;
    symbols.placeholder = '###Stocks\nNASDAQ:AAPL\nNASDAQ:TSLA';
    symbols.value = saved;
    const chart = select([['no', 'Just the list'], ['yes', 'Chart on top']], tv.chart ? 'yes' : 'no');
    const symbolField = field('Symbol', symbol, 'Like NASDAQ:AAPL, BINANCE:BTCUSDT or SPX.');
    const listFields = [
      field('Symbols', symbols, tv.list ? `Synced with “${str(tv.list.name, 60)}” in your TradingView account; editing here unlinks it.` : 'One per line; ###Name starts a section. To import a list from your TradingView account, use Settings → Widgets.'),
      field('Layout', chart),
    ];
    const sync = () => { const w = view.value === 'watchlist'; symbolField.hidden = w; for (const f of listFields) f.hidden = !w; };
    view.addEventListener('change', sync);
    sync();
    const read = () => {
      const out = { symbol: symbol.value, view: view.value, interval: interval.value, theme: theme.value };
      if (out.view === 'watchlist') {
        Object.assign(out, { symbols: symbols.value, chart: chart.value === 'yes' });
        if (tv.list && symbols.value === saved) Object.assign(out, { list: tv.list, sync: tv.sync }); // untouched: stays linked
      }
      return { tv: out };
    };
    return { nodes: [symbolField, field('Style', view), ...listFields, field('Interval', interval), field('Theme', theme)], read, first: view.value === 'watchlist' ? symbols : symbol };
  },
  custom(s) {
    const area = el('textarea', 'ws-code');
    area.rows = 10;
    area.spellcheck = false;
    area.placeholder = '{ "name": "…", "url": "https://…", "view": "stats", "stats": [ { "label": "…", "path": "…" } ] }';
    area.value = s.recipe ? JSON.stringify(s.recipe, null, 2) : '';
    return { nodes: [field('Recipe (JSON)', area, 'One https address that answers JSON and what to show from it. Examples and the format: Settings → Widgets → Custom.')], read: () => ({ recipe: area.value }), first: area };
  },
  embed(s) {
    const url = input('url', s.url, { placeholder: 'https://…' });
    const height = select([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['tall', 'Tall']], s.height || 'medium');
    return { nodes: [field('Address', url, 'Sites that refuse to be framed get an Open button instead.'), field('Height', height)], read: () => ({ url: url.value, height: height.value }), first: url };
  },
};

let panel = null;
let pending = null; // { resolve } while a save is on its way
let opener = null;

function close() {
  if (!panel) return;
  panel.remove();
  panel = null;
  pending = null;
  if (opener?.isConnected) opener.focus();
  opener = null;
}

// open({ type }) for a new one, or open(card) with card = { id, type, title, setup } from the page's list.
function open(target) {
  close();
  opener = document.activeElement;
  const type = target.type;
  const saved = target.setup || {};
  const editing = Boolean(target.id);
  const form = FORMS[type](saved);
  const back = el('div', 'ws-back');
  const box = el('form', 'ws-panel w-ui');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', editing ? `Edit ${target.title || NAMES[type]}` : `New ${NAMES[type]} widget`);
  const title = input('text', saved.title, { maxlength: '60', placeholder: NAMES[type] });
  const note = el('p', 'ws-status');
  note.setAttribute('role', 'status');
  const cancel = el('button', 'w-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', close);
  const ok = el('button', 'w-btn primary', editing ? 'Save' : 'Add to page');
  ok.type = 'submit';
  const buttons = el('div', 'ws-buttons');
  buttons.append(note, cancel, ok);
  box.append(el('h2', null, editing ? `Edit ${target.title || NAMES[type]}` : `New ${NAMES[type]}`), ...form.nodes, field('Card title', title, 'Leave empty to use the widget’s name.'), buttons);
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    if (pending) return;
    const cfg = { type, title: title.value, ...form.read() };
    ok.disabled = true;
    note.className = 'ws-status';
    note.textContent = 'Saving…';
    pending = {
      resolve(r) {
        pending = null;
        ok.disabled = false;
        if (r && r.ok) { close(); window.widgetToast?.(str(r.message, 200) || 'Saved.'); return; }
        note.className = 'ws-status err';
        note.textContent = str(r?.message, 300) || 'That didn’t save. Check the fields and try again.';
      },
    };
    // No answer (the page reloaded, or main never got it): let the person try again.
    setTimeout(() => { if (pending) pending.resolve({ ok: false, message: 'No answer from Lumen. Try again.' }); }, 20000);
    window.widgetAct(editing ? target.id : 'wcreate', 'setup', { cfg: JSON.stringify(cfg) });
  });
  // Typing here is for the form, never the page's shortcuts; Escape closes; Tab stays inside.
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll('input, select, textarea, button')].filter((x) => !x.disabled && x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.append(box);
  document.body.append(back);
  panel = back;
  (form.first || title).focus();
}

// "Saved." for a few seconds (the same look as edit mode's Undo toast).
let toastTimer = null;
function toast(message) {
  document.querySelector('.ws-toast')?.remove();
  clearTimeout(toastTimer);
  const t = el('div', 'w-toast w-ui ws-toast', message);
  t.setAttribute('role', 'status');
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), 3500);
}
window.widgetToast = toast;
window.widgetSetupResult = (r) => { if (pending) pending.resolve(r); };
window.widgetSetup = { KINDS, can: (type) => KINDS.includes(type), open, close, isOpen: () => Boolean(panel) };
})();
