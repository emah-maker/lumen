// The downloads panel patches each download's row in place (renderer/downloads-panel.js), plain Node:
// the script runs against a small fake DOM, so a progress update must keep the same elements (a press
// that began on a row ends on it), touch nothing when nothing changed, and drop only rows that left.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createI18n } = require('../src/features/i18n');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

// ---- a DOM just big enough for the panel
let mutations = 0; // child insertions / removals / text writes since the last reset
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this._text = ''; this.className = ''; this.hidden = false; this.scrollTop = 0; this.clientHeight = 0; this.scrollHeight = 0; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { mutations++; this.children.forEach((c) => { c.parent = null; }); this.children = []; this._text = String(v); }
  set innerHTML(v) { mutations++; this.children.forEach((c) => { c.parent = null; }); this.children = []; this._html = v; }
  get innerHTML() { return this._html || ''; }
  append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }
  replaceChildren(...nodes) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.append(...nodes); }
  insertBefore(node, ref) {
    mutations++;
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    const at = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(at, 0, node);
    node.parent = this;
    return node;
  }
  remove() { if (this.parent) { mutations++; this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, event = {}) { const e = { stopPropagation() {}, preventDefault() {}, ...event }; for (const fn of this.listeners[type] || []) fn(e); }
  get classList() { const el = this; return { add: (c) => { el.className = [...new Set([...el.className.split(' ').filter(Boolean), c])].join(' '); }, remove: (c) => { el.className = el.className.split(' ').filter((x) => x && x !== c).join(' '); } }; }
  getBoundingClientRect() { return { height: 100 }; }
  scrollIntoView() {}
  get offsetWidth() { return 1; }
}

const en = createI18n({ locale: 'en' });
function load() {
  const ids = {};
  for (const id of ['list', 'card', 'empty', 'hint', 'clear', 'folder', 'show-all']) ids[id] = new El('div');
  const acts = [];
  let listCb; let openCb;
  const api = {
    onList: (cb) => { listCb = cb; }, onOpen: (cb) => { openCb = cb; },
    act: (a, id) => acts.push([a, id]), drag: () => {}, clear: () => {}, openFolder: () => {}, showAll: () => {}, close: () => acts.push(['close']), setHeight: () => {},
  };
  const keys = [];
  const doc = { createElement: (t) => new El(t), getElementById: (id) => ids[id], addEventListener() {} };
  const window = { downloadsPanel: api, t: (k, v) => { keys.push(k); return en.t(k, v); } };
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'downloads-panel.js'), 'utf8');
  vm.runInNewContext(src, { window, document: doc, requestAnimationFrame: (f) => f(), ResizeObserver: class { observe() {} }, Math, Number, Array, String, Set, Map, Date, Object });
  return { ids, acts, keys, push: (list) => listCb(list), open: () => openCb() };
}

const dl = (id, extra = {}) => ({ id, name: `file${id}.zip`, state: 'progressing', received: 1048576, total: 10485760, speed: 524288, host: 'example.com', ...extra });

{
  const p = load();
  p.push([dl(1), dl(2, { state: 'completed', received: 5000, total: 5000, endedAt: 0 })]);
  const list = p.ids.list;
  check('two downloads are two rows', list.children.length === 2 && list.children[0].children.length === 3);
  const [row1, row2] = list.children;
  const status = (row) => row.children[1].children[1].textContent;
  const fillOf = (row) => row.children[1].children[2]?.children[0];
  check('status reads from the wording table: size of total · speed · time left', status(row1) === '1.0 of 10.0 MB · 512 KB/s · 18 s left', status(row1));
  check('a progressing row has a bar at 10%', fillOf(row1)?.style.width === '10.0%', fillOf(row1)?.style.width);
  check('its buttons are Pause and Cancel', row1.children[2].children.map((b) => b.dataset.action).join() === 'pause,cancel' && row1.children[2].children[0].getAttribute('aria-label') === 'Pause: file1.zip');
  check('a finished row has no bar and Show / Remove buttons', !fillOf(row2) && row2.children[2].children.map((b) => b.dataset.action).join() === 'show,remove');

  // ---- a progress tick patches in place
  const pauseBtn = row1.children[2].children[0];
  const cancelBtn = row1.children[2].children[1];
  const bar = row1.children[1].children[2];
  mutations = 0;
  p.push([dl(1, { received: 5242880 }), dl(2, { state: 'completed', received: 5000, total: 5000, endedAt: 0 })]);
  check('a progress tick keeps the same rows, bar and buttons', list.children[0] === row1 && list.children[1] === row2 && row1.children[1].children[2] === bar && row1.children[2].children[0] === pauseBtn && row1.children[2].children[1] === cancelBtn);
  check('and updates the numbers', status(row1).startsWith('5.0 of 10.0 MB') && fillOf(row1).style.width === '50.0%', status(row1));
  mutations = 0;
  p.push([dl(1, { received: 5242880 }), dl(2, { state: 'completed', received: 5000, total: 5000, endedAt: 0 })]);
  check('an update that changes nothing touches nothing', mutations === 0, String(mutations));

  // ---- Pause turns into Resume on the same button
  p.push([dl(1, { received: 5242880, paused: true, speed: 0 }), dl(2, { state: 'completed', received: 5000, total: 5000, endedAt: 0 })]);
  check('Pause becomes Resume on the same button element', row1.children[2].children[0] === pauseBtn && pauseBtn.dataset.action === 'resume' && pauseBtn.getAttribute('title') === 'Resume' && /paused/.test(row1.className) && status(row1) === 'Paused · 5.0 of 10.0 MB', `${pauseBtn.dataset.action} ${status(row1)}`);
  pauseBtn.fire('click');
  cancelBtn.fire('click');
  check('a button acts by the download id and its current action', JSON.stringify(p.acts) === '[["resume",1],["cancel",1]]', JSON.stringify(p.acts));

  // ---- the row's click handlers see the latest data
  p.acts.length = 0;
  row1.fire('click');
  check('clicking a row still downloading does nothing', p.acts.length === 0);
  p.push([dl(1, { state: 'completed', received: 10485760, total: 10485760, endedAt: 0 }), dl(2, { state: 'completed', received: 5000, total: 5000, endedAt: 0 })]);
  check('when it finishes the row stays, its bar goes, and Cancel becomes Remove', list.children[0] === row1 && !fillOf(row1) && row1.children[2].children.map((b) => b.dataset.action).join() === 'show,remove' && row1.children[2].children[1] === cancelBtn);
  row1.fire('click');
  check('the finished row now opens its file on click', JSON.stringify(p.acts) === '[["open",1],["close"]]', JSON.stringify(p.acts));

  // ---- rows come and go without disturbing the others
  p.push([dl(3), dl(1, { state: 'completed', received: 10485760, total: 10485760, endedAt: 0 }), dl(2, { state: 'completed', received: 5000, total: 5000, endedAt: 0 })]);
  check('a new download is added at the top, the others are the same elements', list.children.length === 3 && list.children[1] === row1 && list.children[2] === row2 && list.children[0].children[1].children[0].textContent === 'file3.zip');
  p.push([dl(3), dl(2, { state: 'completed', received: 5000, total: 5000, endedAt: 0 })]);
  check('a removed download takes only its own row', list.children.length === 2 && list.children[1] === row2 && row1.parent === null);
  p.push([]);
  check('an empty list clears the rows and shows the empty note', list.children.length === 0 && p.ids.empty.hidden === false);
}

{
  // ---- the wording comes through window.t: every key it asked for exists in en.json
  const p = load();
  p.push([dl(1), dl(2, { paused: true }), dl(3, { state: 'completed', received: 5, total: 5 }), dl(4, { state: 'completed', missing: true }), dl(5, { state: 'cancelled' }), dl(6, { state: 'interrupted', canResume: true }), dl(7, { awaitingOk: true }), dl(8, { total: 0, speed: 0 })]);
  check('every key the panel looked up is in locales/en.json', p.keys.every((k) => typeof en.strings[k] === 'string'), p.keys.filter((k) => typeof en.strings[k] !== 'string').join());
  const texts = p.ids.list.children.map((li) => li.children[1].children[1].textContent);
  check('the other states read as before', texts[3] === 'Deleted' && texts[4] === 'Canceled · example.com' && texts[5] === 'Failed · example.com' && texts[6] === 'Waiting for your OK' && texts[7] === '1.0 MB', texts.join(' | '));
  check('an unknown-size download has the indeterminate bar', p.ids.list.children[7].children[1].children[2].className === 'bar unknown' && p.ids.list.children[7].children[1].children[2].children[0].style.width === '');
}

process.exit(failures ? 1 : 0);
