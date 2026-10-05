// [widgets] Adding and editing widgets on the new-tab page itself, for the kinds with no key, sign-in
// or private address (features/widgets.js INLINE: Notes, Countdown, Timer, Apple Music, TradingView, Custom, Web
// page). The form is a small dialog; Save sends its input as ?widget=<id|wcreate>&do=setup&cfg=<json>
// (the browser cancels that navigation), main.js checks it exactly as Settings would and answers
// through window.widgetSetupResult({ ok, message, id }). Weather, World clock, Calendar and Feed are edited
// here too: main sends only what is safe to show (features/widget-config.js view: a calendar's address
// never comes to the page) and lays the form over what is saved. The clock and greeting have their own
// small panel (openLook) that saves each choice as it is made. Crypto's coins are edited here too (its key and
// first set-up stay in Settings). Every other kind opens Settings.
(function () {
'use strict';

const KINDS = ['notes', 'countdown', 'timer', 'aistatus', 'applemusic', 'tradingview', 'custom', 'embed', 'weather', 'worldclock', 'calendar', 'feed', 'crypto'];
const EDIT_ONLY = ['crypto']; // edited here, added in Settings (the optional key lives there)
const NAMES = { notes: 'Notes', countdown: 'Countdown', timer: 'Timer', aistatus: 'AI status', applemusic: 'Apple Music', tradingview: 'TradingView', custom: 'Custom', embed: 'Web page', weather: 'Weather', worldclock: 'World clock', calendar: 'Calendar', feed: 'Feed headlines', crypto: 'Crypto' };
const CLOCKS = [['auto', 'Automatic'], ['12', '12-hour'], ['24', '24-hour']];
// features/feed.js PRESETS (test/widget-config-units.js keeps the two lists the same).
const FEEDS = [['bloomberg-markets', 'Bloomberg Markets'], ['bloomberg-technology', 'Bloomberg Technology'], ['bloomberg-politics', 'Bloomberg Politics'], ['hn', 'Hacker News'], ['hn-frontpage', 'Hacker News (hnrss.org)'], ['npr', 'NPR News']];
const secure = (v) => /^(https|webcals?):\/\/[^\s"'<>\\]+$/i.test(String(v || '').trim());
const COIN_RE = /^[a-z0-9][a-z0-9-]{0,49}$/; // features/markets-view.js; main checks it again
const MAX_COINS = 12;
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

// The places (or coins) a card has now, each with a Remove switch (positions go back as drop). kept() is how many stay.
function placeList(places, { noun = 'place', tips = [] } = {}) {
  const drop = new Set();
  const list = el('ul', 'ws-places');
  places.forEach((name, i) => {
    const li = el('li');
    const b = el('button', 'ws-chip', name);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `Remove ${tips[i] || name}`);
    if (tips[i]) b.title = tips[i];
    b.addEventListener('click', () => {
      const off = drop.has(i);
      if (off) drop.delete(i); else drop.add(i);
      b.setAttribute('aria-pressed', String(!off));
      b.setAttribute('aria-label', `${off ? 'Remove' : 'Keep'} ${tips[i] || name}`);
      b.classList.toggle('off', !off);
    });
    li.append(b);
    list.append(li);
  });
  return { node: list, drop: () => [...drop], kept: () => places.length - drop.size, noun };
}
// Why Save has to wait: every place is marked for removal and none is being added (main refuses that too).
const keepOne = (places, city) => (places && places.kept() === 0 && !city.value.trim() ? 'Keep at least one place' : '');
// "bitcoin, solana=SOL" -> pieces; the ids main will accept.
const coinPieces = (v) => String(v || '').split(/[\s,;]+/).filter(Boolean);
const bool = (v) => v === 'on';

// Each kind: its fields (from what is saved, if anything) and read() -> the input main.js checks.
const FORMS = {
  notes: () => ({ nodes: [el('p', 'ws-note', 'Type straight on the card. It saves as you go and stays on this computer.')], read: () => ({}) }),
  aistatus: () => ({ nodes: [el('p', 'ws-note', 'Shows which of your AIs are ready, working or at a limit. It updates by itself and uses only what Lumen already knows on this computer.')], read: () => ({}) }),
  applemusic(s) {
    const mode = select([['status', 'Status card: what the Apple Music app is playing'], ['web', 'Web player: music.apple.com in the card']], s.mode === 'web' ? 'web' : 'status');
    const art = select([['on', 'Show album art'], ['off', 'No album art']], s.art === false ? 'off' : 'on');
    const app = select([['on', 'Yes'], ['off', 'No']], s.app === false ? 'off' : 'on');
    const note = el('p', 'ws-note');
    const sync = () => {
      art.parentElement.hidden = app.parentElement.hidden = mode.value !== 'status';
      note.textContent = mode.value === 'web' ? 'Shows Apple Music’s web player (music.apple.com). Sign in there once; Lumen never sees your Apple ID or password.' : 'Plays Apple Music inside Lumen and shows what is playing, with play, pause, next, previous and seek, your recent plays and playlists, and a search. Sign in on Apple’s site once; Lumen never sees your Apple ID.';
    };
    mode.addEventListener('change', sync);
    const nodes = [field('Show', mode), field('Album art', art), field('Also show the Apple Music app', app, 'When nothing plays inside Lumen but the app does.'), note];
    sync();
    return { nodes, read: () => ({ mode: mode.value, art: art.value === 'on', app: app.value === 'on' }), first: mode };
  },
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
    return { nodes, read: () => ({ city: city.value, units: units.value, clock: clock.value, drop: places ? places.drop() : [] }), first: city, guard: () => keepOne(places, city) };
  },
  worldclock(s, editing) {
    const city = input('text', '', { maxlength: '80', placeholder: 'Tokyo', autocomplete: 'off' });
    const clock = select(CLOCKS, s.clock || 'auto');
    const seconds = select([['off', 'Hide'], ['on', 'Show']], s.seconds ? 'on' : 'off');
    const places = editing && s.places?.length ? placeList(s.places) : null;
    const nodes = [];
    if (places) nodes.push(field('Places', places.node, 'Press a place to remove it.'));
    nodes.push(field(places ? 'Add a place' : 'City', city, places ? 'Optional.' : undefined), field('Clock', clock), field('Seconds', seconds));
    return { nodes, read: () => ({ city: city.value, clock: clock.value, seconds: bool(seconds.value), drop: places ? places.drop() : [] }), first: city, guard: () => keepOne(places, city) };
  },
  // One or several calendars, shown together on the card. A saved calendar's address never comes here: its row
  // says which site it is from, and a new address typed over it replaces it. keep is its place in the saved list (-1: new).
  calendar(s, editing) {
    const MAX_CALS = 8;
    const COLORS = ['#4f8ef7', '#e5604d', '#35a974', '#e0a030', '#9b6bd6', '#25a9b8', '#d6609a', '#7d8896']; // features/calendar-sources.js PALETTE
    const saved = Array.isArray(s.cals) ? s.cals : [];
    const rows = saved.map((c, i) => ({ keep: i, name: str(c.name, 60), color: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '', host: str(c.host, 80), enabled: c.enabled !== false, url: '' }));
    if (!rows.length) rows.push({ keep: -1, name: '', color: '', host: '', enabled: true, url: '' });
    const count = select([3, 4, 5, 6, 7, 8].map((n) => [String(n), `${n} events`]), String(s.count || 5));
    const list = el('ul', 'ws-cals');
    const addBtn = el('button', 'w-btn', 'Add another calendar');
    addBtn.type = 'button';
    const colorOf = (r, i) => r.color || COLORS[i % COLORS.length];
    let focus = null; // after a redraw: which control gets focus back
    function draw() {
      list.replaceChildren();
      rows.forEach((r, i) => {
        const label = r.name.trim() || r.host || `Calendar ${i + 1}`;
        const li = el('li', 'ws-cal');
        li.setAttribute('role', 'group');
        li.setAttribute('aria-label', `Calendar ${i + 1}: ${label}`);
        const color = input('color', colorOf(r, i));
        color.setAttribute('aria-label', `Color for ${label}`);
        color.addEventListener('input', () => { r.color = color.value; });
        const name = input('text', r.name, { maxlength: '60', placeholder: i === 0 ? 'School' : 'Other', autocomplete: 'off', 'aria-label': `Name of calendar ${i + 1}` });
        name.addEventListener('input', () => { r.name = name.value; });
        const on = input('checkbox', '');
        on.checked = r.enabled;
        on.setAttribute('aria-label', `Show ${label} on the card`);
        on.title = 'Show on the card';
        on.addEventListener('change', () => { r.enabled = on.checked; });
        const url = input('url', r.url, { placeholder: r.keep >= 0 ? `Saved: ${r.host || 'a calendar'}. Paste a new address to change it` : 'https:// or webcal://', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Address of calendar ${i + 1}` });
        url.addEventListener('input', () => { r.url = url.value; });
        const btn = (text, name2, fn, off) => {
          const b2 = el('button', 'ws-chip', text);
          b2.type = 'button';
          b2.setAttribute('aria-label', `${name2} ${label}`);
          b2.disabled = Boolean(off);
          b2.addEventListener('click', fn);
          return b2;
        };
        const up = btn('↑', 'Move up', () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; focus = `up${i - 1}`; draw(); }, i === 0);
        const down = btn('↓', 'Move down', () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; focus = `down${i + 1}`; draw(); }, i === rows.length - 1);
        const gone = btn('Remove', 'Remove', () => { rows.splice(i, 1); focus = 'add'; draw(); }, rows.length === 1 && editing);
        up.dataset.k = `up${i}`;
        down.dataset.k = `down${i}`;
        const top = el('div', 'ws-cal-top');
        top.append(color, name, on);
        const bottom = el('div', 'ws-cal-btns');
        bottom.append(up, down, gone);
        li.append(top, url, bottom);
        list.append(li);
      });
      addBtn.disabled = rows.length >= MAX_CALS;
      if (focus) { (focus === 'add' ? addBtn : list.querySelector(`[data-k="${focus}"]`) || addBtn).focus(); focus = null; }
    }
    addBtn.addEventListener('click', () => { rows.push({ keep: -1, name: '', color: '', host: '', enabled: true, url: '' }); draw(); list.lastElementChild?.querySelector('input[type="text"]')?.focus(); });
    draw();
    const guard = () => {
      for (const [i, r] of rows.entries()) {
        const t = r.url.trim();
        const label = r.name.trim() || r.host || `Calendar ${i + 1}`;
        if (t && !secure(t)) return `${label} needs an https:// or webcal:// address`;
        if (!t && r.keep < 0) return rows.length === 1 ? 'Paste a calendar address' : `Paste an address for ${label}`;
      }
      return rows.some((r) => r.enabled) ? '' : 'Turn on at least one calendar';
    };
    const group = el('div', 'ws-field');
    group.append(el('span', 'ws-label', 'Calendars'), list, el('span', 'ws-hint', 'Events from every calendar you turn on appear together, soonest first. Give each a name and a color to tell them apart.'));
    return {
      nodes: [
        group,
        addBtn,
        field('Show', count),
      ],
      read: () => ({ cals: rows.map((r) => ({ keep: r.keep, name: r.name, color: r.color, enabled: r.enabled, url: r.url })), count: Number(count.value) }),
      first: list.querySelector('input[type="text"]') || list.querySelector('input'),
      guard,
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
  crypto(s) {
    const coins = Array.isArray(s.coins) ? s.coins : [];
    const places = coins.length ? placeList(coins.map((c) => c.sym), { noun: 'coin', tips: coins.map((c) => `${c.sym} (${c.id})`) }) : null;
    const add = input('text', '', { maxlength: '200', placeholder: 'solana, dogecoin', spellcheck: 'false', autocomplete: 'off' });
    const nodes = [];
    if (places) nodes.push(field('Coins', places.node, 'Press a coin to remove it. The key for more requests is in Settings → Widgets.'));
    nodes.push(field('Add coins', add, `CoinGecko ids, separated by commas: the end of a coin page’s address on coingecko.com. Up to ${MAX_COINS}.`));
    const guard = () => {
      const pieces = coinPieces(add.value);
      const bad = pieces.find((p) => !COIN_RE.test(p.split('=')[0].toLowerCase()));
      if (bad) return `“${bad.split('=')[0].slice(0, 30)}” isn’t a CoinGecko id`;
      const gone = new Set(places ? places.drop() : []);
      const ids = new Set(coins.filter((_, i) => !gone.has(i)).map((c) => c.id));
      for (const p of pieces) ids.add(p.split('=')[0].toLowerCase());
      return ids.size === 0 ? 'Keep at least one coin' : ids.size > MAX_COINS ? `Up to ${MAX_COINS} coins` : '';
    };
    return { nodes, read: () => ({ add: add.value, drop: places ? places.drop() : [] }), first: add, guard };
  },
  embed(s) {
    const url = input('url', s.url, { placeholder: 'https://…' });
    const height = select([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['tall', 'Tall']], s.height || 'medium');
    return { nodes: [field('Address', url, 'Sites that refuse to be framed get an Open button instead.'), field('Height', height)], read: () => ({ url: url.value, height: height.value }), first: url };
  },
};

let panel = null;
let pending = null; // { resolve, owner } while a save is on its way; it outlives the panel (Escape must not lose the answer)
let opener = null; // { el, id }: where focus goes back to (the card may have been drawn again meanwhile)
let flushName = null; // the clock panel's name, typed but not yet sent
let released = []; // what was made inert behind the panel

// While a panel is open nothing behind it can be reached: Tab, clicks and screen readers stay in the panel.
function lockPage(back) {
  released = [...document.body.children].filter((n) => n !== back && n.id !== 'w-live' && !/^(SCRIPT|STYLE)$/.test(n.tagName) && !n.hasAttribute('inert'));
  for (const n of released) { n.setAttribute('inert', ''); n.dataset.wsInert = '1'; }
}
function unlockPage() {
  for (const n of released) { n.removeAttribute('inert'); delete n.dataset.wsInert; }
  released = [];
}
// Safety net: if a panel went away without close() (a redraw, a reload that kept the DOM, a thrown error), nothing stays unreachable.
function releaseStaleLock() {
  if (panel && panel.isConnected) return;
  panel = null;
  unlockPage();
  for (const n of document.querySelectorAll('[data-ws-inert]')) { n.removeAttribute('inert'); delete n.dataset.wsInert; }
}
window.addEventListener('pagehide', () => { panel?.remove(); panel = null; unlockPage(); releaseStaleLock(); });
new MutationObserver(() => { if (released.length && !(panel && panel.isConnected)) releaseStaleLock(); }).observe(document.body, { childList: true });

function close() {
  if (!panel) { releaseStaleLock(); return; }
  if (flushName) { const f = flushName; flushName = null; f(); } // a name typed a moment ago is kept, not dropped
  panel.remove();
  panel = null;
  unlockPage();
  // Back to what had focus; the page redraws a card when it is saved, so fall back to that card's pencil, gear or the card itself.
  const id = opener?.id;
  const back = opener?.el?.isConnected ? opener.el : id ? document.querySelector(`[data-id="${id}"] .w-icon-btn[aria-label^="Edit"], [data-id="${id}"] .w-gear`) || document.querySelector(`[data-id="${id}"]`) : null;
  opener = null;
  back?.focus?.();
}
const openerFor = (id) => ({ el: document.activeElement, id: id || null });

// Typing here is for the form, never the page's shortcuts; Tab stays inside.
function trap(e, box) {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key !== 'Tab') return;
  const f = [...box.querySelectorAll('input, select, textarea, button')].filter((x) => !x.disabled && x.offsetParent && x.tabIndex >= 0);
  if (!f.length) return;
  if (e.shiftKey && (document.activeElement === f[0] || document.activeElement === box)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
}
// Escape closes the panel wherever focus is, and never reaches Edit layout's own Escape (which would leave edit mode).
// Registered before newtab-widgets-grid.js, so it hears the key first.
document.addEventListener('keydown', (e) => {
  if (!panel || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
}, true);

function dialog(label) {
  const back = el('div', 'ws-back');
  const box = el('form', 'ws-panel w-ui');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', label);
  box.tabIndex = -1;
  return { back, box };
}
function show(back, box, focusFirst) {
  box.addEventListener('keydown', (e) => trap(e, box));
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.append(box);
  document.body.append(back);
  panel = back;
  lockPage(back);
  (focusFirst || box).focus();
}

// open({ type }) for a new one, or open(card) with card = { id, type, title, setup } from the page's list.
function open(target) {
  close();
  opener = openerFor(target.id);
  const type = target.type;
  const saved = target.setup || {};
  const editing = Boolean(target.id);
  const form = FORMS[type](saved, editing);
  const label = editing ? `Edit ${target.title || NAMES[type]}` : `New ${NAMES[type]} widget`;
  const { back, box } = dialog(label);
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
  // Save waits while the form can't be saved as it stands (every place marked for removal, a coin id that isn't one).
  let guarding = false;
  const sync = () => {
    const g = form.guard?.() || '';
    if (g) { note.className = 'ws-status err'; note.textContent = g; guarding = true; } else if (guarding) { note.className = 'ws-status'; note.textContent = ''; guarding = false; }
    ok.disabled = Boolean(g) || pending?.owner === back;
  };
  for (const ev of ['input', 'click', 'change']) box.addEventListener(ev, sync);
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    if (pending) { if (pending.owner !== back) { note.className = 'ws-status'; note.textContent = 'Still saving the last change…'; } return; }
    const problem = form.guard?.() || form.check?.();
    if (problem) { note.className = 'ws-status err'; note.textContent = problem; return; }
    const cfg = { type, title: title.value, ...form.read() };
    const name = cfg.title.trim() || target.title || NAMES[type];
    ok.disabled = true;
    note.className = 'ws-status';
    note.textContent = 'Saving…';
    const timer = setTimeout(() => { if (pending?.owner === back) pending.resolve({ ok: false, retry: true, message: 'No answer from Lumen. Try again.' }); }, 20000); // the page reloaded, or main never got it
    pending = {
      owner: back,
      resolve(r) {
        clearTimeout(timer);
        pending = null;
        if (r && r.retry) { // no answer in time: Save is live again, with a Retry beside the message
          const here = panel === back;
          if (!here) { toast(`${name} didn’t save: no answer from Lumen.`, { error: true }); return; }
          ok.disabled = false;
          note.className = 'ws-status err';
          note.textContent = 'No answer · ';
          const retry = el('button', 'w-btn', 'Retry');
          retry.type = 'button';
          retry.addEventListener('click', () => box.requestSubmit());
          note.append(retry);
          sync();
          return;
        }
        const here = panel === back; // false when Escape or a click outside closed it while the save was on its way
        if (r && r.ok) {
          if (here) close();
          const message = str(r.message, 200) || 'Saved.';
          if (r.undo && window.widgetEditUI?.configChanged) window.widgetEditUI.configChanged({ id: r.id || target.id, title: name, message });
          else toast(message);
          return;
        }
        const why = str(r?.message, 300) || 'That didn’t save. Check the fields and try again.';
        if (here) { ok.disabled = false; note.className = 'ws-status err'; note.textContent = why; sync(); } else toast(`${name} didn’t save: ${why}`, { error: true });
      },
    };
    window.widgetAct(editing ? target.id : 'wcreate', 'setup', { cfg: JSON.stringify(cfg) });
  });
  show(back, box, form.first || title);
  sync();
}

// The clock and greeting card: each choice is saved the moment it is made (do=look, one key at a time) and the page
// follows; Done (or Escape) only closes. Same words and values as Settings → Home.
const STYLES = [['classic', 'Classic'], ['rounded', 'Rounded'], ['thin', 'Thin'], ['serif', 'Serif'], ['mono', 'Mono'], ['bold', 'Stacked']];
const HOURS = [['auto', 'Auto', 'Automatic'], ['12', '12-hour'], ['24', '24-hour']];
const CARDS = [['none', 'None'], ['soft', 'Soft'], ['glass', 'Glass']];
const GREET = [['classic', 'Classic'], ['match', 'Match', 'Match the clock'], ['rounded', 'Rounded'], ['serif', 'Serif'], ['thin', 'Thin'], ['mono', 'Mono'], ['hand', 'Hand', 'Handwritten']];
// What "Reset to defaults" puts back (features/widget-config.js LOOK_DEFAULTS; the name and sizes are left alone).
const LOOK_DEFAULT = { show: true, style: 'classic', hours: 'auto', seconds: false, date: true, card: 'none', greeting: 'classic' };

// A segmented control: one button per choice, aria-pressed on the chosen one, arrow keys move and choose (one tab stop).
function segmented(label, options, value, onPick) {
  const wrap = el('div', 'ws-field');
  const row = el('div', 'ws-seg');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', label);
  const buttons = options.map(([v, text, long]) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.dataset.value = v;
    if (long) { b.setAttribute('aria-label', long); b.title = long; }
    return b;
  });
  const set = (v) => { for (const b of buttons) { const on = b.dataset.value === v; b.setAttribute('aria-pressed', String(on)); b.tabIndex = on ? 0 : -1; } };
  const pick = (b) => { set(b.dataset.value); b.focus(); onPick(b.dataset.value); };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => pick(b));
    b.addEventListener('keydown', (e) => {
      const go = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
      if (go === undefined) return;
      e.preventDefault();
      pick(buttons[(go + buttons.length) % buttons.length]);
    });
  });
  set(value);
  row.append(...buttons);
  wrap.append(el('span', 'ws-label', label), row);
  return { node: wrap, set };
}
// A switch that looks like the place chips: pressed means on.
function switchChip(label, on, onChange) {
  const b = el('button', 'ws-chip ws-sw', label);
  b.type = 'button';
  const set = (v) => { b.setAttribute('aria-pressed', String(v)); };
  b.addEventListener('click', () => { const v = b.getAttribute('aria-pressed') !== 'true'; set(v); onChange(v); });
  set(on);
  return { node: b, set };
}

function openLook() {
  close();
  opener = openerFor('wsyshead');
  if (!opener.el || opener.el === document.body) opener.el = document.getElementById('hdr-edit');
  const look = window.newtabLook?.() || {};
  const cs = look.clockStyle || {};
  const { back, box } = dialog('Edit clock and greeting');
  const save = (k, v) => window.widgetAct('wlook', 'look', { k, v });
  const onOff = (v) => (v ? 'on' : 'off');
  // What each control shows now, so Reset can be undone.
  const state = { show: look.clock !== false, seconds: cs.seconds === true, date: cs.date !== false, style: cs.style || 'classic', hours: cs.hours || 'auto', card: cs.card || 'none', greeting: cs.greeting || 'classic' };
  const BOOLS = ['show', 'seconds', 'date'];
  // The name is saved as it is typed (after a short pause), and whatever is left when the panel closes.
  const name = input('text', look.name, { maxlength: '40', placeholder: 'Your name', autocomplete: 'off' });
  let sent = look.name || '';
  let timer = 0;
  const sendName = () => { clearTimeout(timer); timer = 0; flushName = null; if (name.value !== sent) { sent = name.value; save('name', sent); } };
  name.addEventListener('input', () => { clearTimeout(timer); flushName = sendName; timer = setTimeout(sendName, 400); });
  name.addEventListener('change', sendName);
  const controls = {
    show: switchChip('Clock', look.clock !== false, (v) => { state.show = v; save('show', onOff(v)); }),
    seconds: switchChip('Seconds', cs.seconds === true, (v) => { state.seconds = v; save('seconds', onOff(v)); }),
    date: switchChip('Date', cs.date !== false, (v) => { state.date = v; save('date', onOff(v)); }),
    style: segmented('Clock style', STYLES, cs.style || 'classic', (v) => { state.style = v; save('style', v); }),
    hours: segmented('Hours', HOURS, cs.hours || 'auto', (v) => { state.hours = v; save('hours', v); }),
    card: segmented('Behind the clock', CARDS, cs.card || 'none', (v) => { state.card = v; save('card', v); }),
    greeting: segmented('Greeting font', GREET, cs.greeting || 'classic', (v) => { state.greeting = v; save('greeting', v); }),
  };
  const switches = el('ul', 'ws-places');
  for (const k of ['show', 'seconds', 'date']) { const li = el('li'); li.append(controls[k].node); switches.append(li); }
  const showField = el('div', 'ws-field');
  showField.append(el('span', 'ws-label', 'Show'), switches);
  const reset = el('button', 'w-btn', 'Reset clock look');
  reset.type = 'button';
  reset.title = 'Resets Show clock, seconds, date, clock style, hours, the card behind the clock and the greeting font. Your name stays.';
  const status = el('p', 'ws-status');
  status.setAttribute('role', 'status');
  reset.addEventListener('click', () => {
    const before = { ...state };
    window.widgetAct('wlook', 'look', { k: 'defaults', v: 'all' });
    for (const [k, v] of Object.entries(LOOK_DEFAULT)) { controls[k].set(v); state[k] = v; }
    status.textContent = 'Clock look reset. ';
    const undo = el('button', 'w-btn', 'Undo');
    undo.type = 'button';
    undo.addEventListener('click', () => {
      for (const [k, v] of Object.entries(before)) {
        if (state[k] === v) continue;
        state[k] = v;
        controls[k].set(v);
        save(k, BOOLS.includes(k) ? onOff(v) : v);
      }
      status.textContent = 'Put your clock look back.';
      reset.focus();
    });
    status.append(undo);
  });
  const done = el('button', 'w-btn primary', 'Done');
  done.type = 'submit';
  const buttons = el('div', 'ws-buttons');
  buttons.append(reset, status, done);
  box.classList.add('ws-look');
  box.append(
    el('h2', null, 'Clock and greeting'),
    field('Name in the greeting', name, 'Leave empty for “Good morning” alone.'),
    showField,
    controls.style.node, controls.hours.node, controls.card.node, controls.greeting.node,
    buttons,
  );
  box.addEventListener('submit', (e) => { e.preventDefault(); close(); });
  show(back, box, name);
}

// A few seconds at the bottom (the same look as edit mode's Undo toast). An error stays longer and is announced at once.
let toastTimer = null;
function toast(message, { error = false } = {}) {
  document.querySelector('.ws-toast')?.remove();
  clearTimeout(toastTimer);
  const t = el('div', `w-toast w-ui ws-toast${error ? ' err' : ''}`, message);
  t.setAttribute('role', error ? 'alert' : 'status');
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), error ? 7000 : 3500);
}
window.widgetToast = toast;
window.widgetSetupResult = (r) => { if (pending) pending.resolve(r); };
document.getElementById('hdr-edit')?.addEventListener('click', openLook);
window.widgetSetup = { KINDS, can: (type) => KINDS.includes(type), canAdd: (type) => KINDS.includes(type) && !EDIT_ONLY.includes(type), open, openLook, close, isOpen: () => Boolean(panel) };
})();
