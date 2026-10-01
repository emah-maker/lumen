// [widgets] Adding and editing widgets on the new-tab page itself, for the kinds with no key, sign-in
// or private address (features/widgets.js INLINE: Notes, Countdown, Timer, TradingView, Custom, Web
// page). The form is a small dialog; Save sends its input as ?widget=<id|wcreate>&do=setup&cfg=<json>
// (the browser cancels that navigation), main.js checks it exactly as Settings would and answers
// through window.widgetSetupResult({ ok, message, id }). Weather, World clock, Calendar and Feed are edited
// here too: main sends only what is safe to show (features/widget-config.js view: a calendar's address
// never comes to the page) and lays the form over what is saved. The clock and greeting have their own
// small panel (openLook) that saves each choice as it is made. Every other kind opens Settings.
(function () {
'use strict';

const KINDS = ['notes', 'countdown', 'timer', 'tradingview', 'custom', 'embed', 'weather', 'worldclock', 'calendar', 'feed'];
const NAMES = { notes: 'Notes', countdown: 'Countdown', timer: 'Timer', tradingview: 'TradingView', custom: 'Custom', embed: 'Web page', weather: 'Weather', worldclock: 'World clock', calendar: 'Calendar', feed: 'Feed headlines' };
const CLOCKS = [['auto', 'Automatic'], ['12', '12-hour'], ['24', '24-hour']];
// features/feed.js PRESETS (test/widget-config-units.js keeps the two lists the same).
const FEEDS = [['bloomberg-markets', 'Bloomberg Markets'], ['bloomberg-technology', 'Bloomberg Technology'], ['bloomberg-politics', 'Bloomberg Politics'], ['hn', 'Hacker News'], ['hn-frontpage', 'Hacker News (hnrss.org)'], ['npr', 'NPR News']];
const secure = (v) => /^(https|webcals?):\/\/[^\s"'<>\\]+$/i.test(String(v || '').trim());
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

// The places a Weather or World clock card has now, each with a Remove switch (positions go back as drop).
function placeList(places) {
  const drop = new Set();
  const list = el('ul', 'ws-places');
  places.forEach((name, i) => {
    const li = el('li');
    const b = el('button', 'ws-chip', name);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `Remove ${name}`);
    b.addEventListener('click', () => {
      const off = drop.has(i);
      if (off) drop.delete(i); else drop.add(i);
      b.setAttribute('aria-pressed', String(!off));
      b.setAttribute('aria-label', `${off ? 'Remove' : 'Keep'} ${name}`);
      b.classList.toggle('off', !off);
    });
    li.append(b);
    list.append(li);
  });
  return { node: list, drop: () => [...drop] };
}
const bool = (v) => v === 'on';

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
  weather(s, editing) {
    const city = input('text', '', { maxlength: '80', placeholder: 'Boston', autocomplete: 'off' });
    const units = select([['f', '°F, miles'], ['c', '°C, kilometres']], s.units || 'f');
    const clock = select(CLOCKS, s.clock || 'auto');
    const places = editing && s.places?.length ? placeList(s.places) : null;
    const nodes = [];
    if (places) nodes.push(field('Places', places.node, 'Press a place to remove it. “My location” is changed in Settings → Widgets.'));
    nodes.push(field(places ? 'Add a place' : 'City', city, places ? 'Optional.' : undefined), field('Units', units), field('Clock', clock, 'How the hourly forecast writes the time.'));
    return { nodes, read: () => ({ city: city.value, units: units.value, clock: clock.value, drop: places ? places.drop() : [] }), first: city };
  },
  worldclock(s, editing) {
    const city = input('text', '', { maxlength: '80', placeholder: 'Tokyo', autocomplete: 'off' });
    const clock = select(CLOCKS, s.clock || 'auto');
    const seconds = select([['off', 'Hide'], ['on', 'Show']], s.seconds ? 'on' : 'off');
    const places = editing && s.places?.length ? placeList(s.places) : null;
    const nodes = [];
    if (places) nodes.push(field('Places', places.node, 'Press a place to remove it.'));
    nodes.push(field(places ? 'Add a place' : 'City', city, places ? 'Optional.' : undefined), field('Clock', clock), field('Seconds', seconds));
    return { nodes, read: () => ({ city: city.value, clock: clock.value, seconds: bool(seconds.value), drop: places ? places.drop() : [] }), first: city };
  },
  calendar(s, editing) {
    const url = input('url', '', { placeholder: editing ? `Saved: ${str(s.host, 80) || 'a calendar'}. Paste a new address to change it` : 'https:// or webcal://', spellcheck: 'false', autocomplete: 'off' });
    const count = select([3, 4, 5, 6, 7, 8].map((n) => [String(n), `${n} events`]), String(s.count || 5));
    return {
      nodes: [field('Calendar address (ICS)', url, editing ? 'Leave empty to keep the saved address; it is never shown here.' : 'From your calendar’s settings, “secret address in iCal format”.'), field('Show', count)],
      read: () => ({ url: url.value, count: Number(count.value) }),
      first: url,
      check: () => (url.value.trim() && !secure(url.value) ? 'Paste an https:// or webcal:// address.' : !editing && !url.value.trim() ? 'Paste a calendar address.' : ''),
    };
  },
  feed(s) {
    const kind = select([...FEEDS, ['', 'Another feed (address)']], s.url ? '' : s.feed || FEEDS[0][0]);
    const url = input('url', s.url, { placeholder: 'https://example.com/feed.xml', spellcheck: 'false', autocomplete: 'off' });
    const urlField = field('Feed address', url, 'An RSS or Atom feed over https.');
    const count = select([3, 4, 5, 6, 8, 10, 12].map((n) => [String(n), `${n} headlines`]), String(s.count || 8));
    const sync = () => { urlField.hidden = kind.value !== ''; };
    kind.addEventListener('change', sync);
    sync();
    return {
      nodes: [field('Feed', kind), urlField, field('Show', count)],
      read: () => ({ feed: kind.value, url: kind.value ? '' : url.value, count: Number(count.value) }),
      first: kind,
      check: () => (!kind.value && !/^https:\/\//i.test(url.value.trim()) ? 'Paste an https:// feed address.' : ''),
    };
  },
  embed(s) {
    const url = input('url', s.url, { placeholder: 'https://…' });
    const height = select([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['tall', 'Tall']], s.height || 'medium');
    return { nodes: [field('Address', url, 'Sites that refuse to be framed get an Open button instead.'), field('Height', height)], read: () => ({ url: url.value, height: height.value }), first: url };
  },
};

let panel = null;
let pending = null; // { resolve } while a save is on its way
let opener = null; // { el, id }: where focus goes back to (the card may have been drawn again meanwhile)

function close() {
  if (!panel) return;
  panel.remove();
  panel = null;
  pending = null;
  // Back to what had focus; the page redraws a card when it is saved, so fall back to that card's pencil, gear or the card itself.
  const id = opener?.id;
  const back = opener?.el?.isConnected ? opener.el : id ? document.querySelector(`[data-id="${id}"] .w-icon-btn[aria-label^="Edit"], [data-id="${id}"] .w-gear`) || document.querySelector(`[data-id="${id}"]`) : null;
  opener = null;
  back?.focus?.();
}
const openerFor = (id) => ({ el: document.activeElement, id: id || null });

// Typing here is for the form, never the page's shortcuts; Escape closes; Tab stays inside.
function trap(e, box) {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key !== 'Tab') return;
  const f = [...box.querySelectorAll('input, select, textarea, button')].filter((x) => !x.disabled && x.offsetParent);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
}

// open({ type }) for a new one, or open(card) with card = { id, type, title, setup } from the page's list.
function open(target) {
  close();
  opener = openerFor(target.id);
  const type = target.type;
  const saved = target.setup || {};
  const editing = Boolean(target.id);
  const form = FORMS[type](saved, editing);
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
    const problem = form.check?.();
    if (problem) { note.className = 'ws-status err'; note.textContent = problem; return; }
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
  box.addEventListener('keydown', (e) => trap(e, box));
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.append(box);
  document.body.append(back);
  panel = back;
  (form.first || title).focus();
}

// The clock and greeting card: each choice is saved the moment it is made (do=look, one key at a time) and the page
// follows; Done (or Escape) only closes. Same words and values as Settings → Home.
const STYLES = [['classic', 'Classic'], ['rounded', 'Rounded'], ['thin', 'Thin'], ['serif', 'Serif'], ['mono', 'Mono'], ['bold', 'Stacked']];
const CARDS = [['none', 'None'], ['soft', 'Soft'], ['glass', 'Glass']];
const GREET = [['classic', 'Classic'], ['match', 'Match clock'], ['rounded', 'Rounded'], ['serif', 'Serif'], ['thin', 'Thin'], ['mono', 'Mono'], ['hand', 'Handwritten']];
const onOff = (v) => (v ? 'on' : 'off');
function openLook() {
  close();
  opener = openerFor('wsyshead');
  if (!opener.el || opener.el === document.body) opener.el = document.getElementById('hdr-edit');
  const look = window.newtabLook?.() || {};
  const cs = look.clockStyle || {};
  const back = el('div', 'ws-back');
  const box = el('form', 'ws-panel w-ui');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Edit clock and greeting');
  const save = (k, v) => window.widgetAct('wlook', 'look', { k, v });
  const bind = (k, control) => { control.addEventListener('change', () => save(k, control.value)); return control; };
  const toggle = (k, label, value) => field(label, bind(k, select([['on', 'On'], ['off', 'Off']], onOff(value))));
  const name = bind('name', input('text', look.name, { maxlength: '40', placeholder: 'Your name', autocomplete: 'off' }));
  const done = el('button', 'w-btn primary', 'Done');
  done.type = 'submit';
  const buttons = el('div', 'ws-buttons');
  buttons.append(done);
  box.append(
    el('h2', null, 'Clock and greeting'),
    field('Name in the greeting', name, 'Leave empty for “Good morning” alone.'),
    toggle('show', 'Show the clock', look.clock !== false),
    field('Style', bind('style', select(STYLES, cs.style || 'classic'))),
    field('Hours', bind('hours', select(CLOCKS, cs.hours || 'auto'))),
    toggle('seconds', 'Seconds', cs.seconds === true),
    toggle('date', 'Date', cs.date !== false),
    field('Behind the clock', bind('card', select(CARDS, cs.card || 'none'))),
    field('Greeting font', bind('greeting', select(GREET, cs.greeting || 'classic'))),
    buttons,
  );
  box.addEventListener('submit', (e) => { e.preventDefault(); if (document.activeElement === name && name.value !== (look.name || '')) save('name', name.value); close(); });
  box.addEventListener('keydown', (e) => trap(e, box));
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.append(box);
  document.body.append(back);
  panel = back;
  name.focus();
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
document.getElementById('hdr-edit')?.addEventListener('click', openLook);
window.widgetSetup = { KINDS, can: (type) => KINDS.includes(type), open, openLook, close, isOpen: () => Boolean(panel) };
})();
