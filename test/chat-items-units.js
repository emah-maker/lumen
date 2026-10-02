// The chat list's row (renderer/chat-items.js) run against a tiny fake DOM, plain Node: no Electron, no window.
// What a click on export / stop does with each answer main can give (the real shapes of chats:export and chats:stop),
// which buttons a narrow list drops, and the inline sizes the stylesheet's padding rules read.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this._text = ''; this.className = ''; this.hidden = false; this.disabled = false; this.vars = {}; this.title = ''; this.innerHTML = ''; }
  get classList() { const self = this; const set = () => new Set(String(self.className).split(/\s+/).filter(Boolean)); return { add: (...c) => { const s = set(); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); }, remove: (...c) => { const s = set(); c.forEach((x) => s.delete(x)); self.className = [...s].join(' '); }, contains: (c) => set().has(c) }; }
  get style() { return { setProperty: (k, v) => { this.vars[k] = v; } }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...n) { this.children.push(...n); }
  prepend(...n) { this.children.unshift(...n); }
  insertBefore(n) { this.children.unshift(n); }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  find(cls) { const out = []; const walk = (e) => { if (e.classList?.contains?.(cls)) out.push(e); (e.children || []).forEach(walk); }; walk(this); return out; }
}
const text = (s) => Object.assign(new El('#text'), { _text: s });
const sandbox = { document: { createElement: (t) => new El(t), createTextNode: text }, window: {}, setTimeout, clearTimeout, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat-items.js'), 'utf8'), sandbox, { filename: 'chat-items.js' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const make = (api, chat) => { const item = sandbox.window.createChatItems({ api, onOpen() {}, rerender: async () => {}, cleared() {} }); return item(chat, false); };
  const base = { id: 'c1', title: 'Chat one', updated: Date.now(), usage: '' };
  const meta = (li) => li.find('chat-open')[0].find('chat-meta-text')[0];

  // export: the shapes main.js answers with
  let answer = { ok: true };
  let api = { exportChat: async () => answer, showTab: async () => {}, stopChat: async () => true, remove: async () => ({}) };
  let li = make(api, base);
  const exportBtn = li.find('chat-actions')[0].children.find((b) => /export/i.test(b.title));
  const original = meta(li).textContent;
  answer = { ok: false, reason: 'canceled' };
  await exportBtn.onclick();
  check('export: a dismissed Save dialog (reason "canceled") leaves the row as it was', meta(li).textContent === original, meta(li).textContent);
  answer = { ok: false, reason: 'empty' };
  await exportBtn.onclick();
  check('export: an empty chat says so', /Nothing to export/.test(meta(li).textContent), meta(li).textContent);
  answer = { ok: false, reason: 'disk full' };
  await exportBtn.onclick();
  check('export: any other failure says it could not export', /Could not export/.test(meta(li).textContent), meta(li).textContent);
  answer = { ok: true };
  await exportBtn.onclick();
  check('export: success says Exported', /Exported/.test(meta(li).textContent), meta(li).textContent);

  // stop waiting: a false answer, a throw, silence, and success
  const queued = { ...base, badge: 'queued', tab: { id: 2, title: 'Other', here: false } };
  let stopAnswer = false;
  api = { exportChat: async () => ({ ok: true }), showTab: async () => {}, stopChat: async () => stopAnswer, remove: async () => ({}) };
  li = make(api, queued);
  let stop = li.find('chat-stop-wait')[0];
  await stop.onclick({ stopPropagation() {} });
  check('stop: a false answer (the chat had moved on) restores the button and says it could not stop', stop.disabled === false && /Stop waiting/.test(stop.textContent) && /Could not stop/.test(meta(li).textContent), `${stop.disabled} ${stop.textContent} ${meta(li).textContent}`);
  api.stopChat = async () => { throw new Error('gone'); };
  await stop.onclick({ stopPropagation() {} });
  check('stop: a thrown error restores the button', stop.disabled === false && /Stop waiting/.test(stop.textContent));
  api.stopChat = async () => true;
  await stop.onclick({ stopPropagation() {} });
  check('stop: a true answer leaves "Stopping…" (the list redraws when the run leaves)', stop.disabled === true && /Stopping/.test(stop.textContent), stop.textContent);

  // which button a narrow list drops, and the inline sizes
  const idle = { ...base, tab: { id: 2, title: 'Other', here: false } };
  const working = { ...base, badge: 'running', tab: { id: 2, title: 'Other', here: false } };
  const here = { ...base, tab: { id: 1, title: 'Mine', here: true } };
  const drop = (li2) => li2.find('chat-actions')[0].children.filter((b) => b.classList.contains('chat-act-drop')).map((b) => (b.classList.contains('chat-act-move') ? 'move' : 'tab'));
  const idleLi = make(api, idle), workLi = make(api, working), hereLi = make(api, here);
  check('narrow list: an idle chat in another tab drops "move here", a working one drops "open in its tab", a chat here drops nothing', drop(idleLi).join() === 'move' && drop(workLi).join() === 'tab' && drop(hereLi).length === 0 && !hereLi.classList.contains('drops-one'), `${drop(idleLi)} ${drop(workLi)} ${drop(hereLi)}`);
  const w = (l, k) => parseInt(l.vars[k], 10);
  check('sizes: --actions-w and --actions-w-narrow are separate inline props, the narrow one a button (24px) smaller for chats elsewhere', w(idleLi, '--actions-w') === 5 * 24 + 8 && w(idleLi, '--actions-w-narrow') === 4 * 24 + 8 && w(workLi, '--actions-w-narrow') === 4 * 24 + 8 && w(hereLi, '--actions-w') === 3 * 24 + 8 && w(hereLi, '--actions-w-narrow') === w(hereLi, '--actions-w'), JSON.stringify([idleLi.vars, hereLi.vars]));
  check('the state word is in the row for a working chat and the badge is hidden from screen readers', workLi.find('chat-state')[0]?.textContent === 'Working' && workLi.find('chat-badge')[0]?.attrs['aria-hidden'] === 'true');

  // a failing delete re-enables the button and says so
  let removeFails = true;
  api = { exportChat: async () => ({ ok: true }), showTab: async () => {}, stopChat: async () => true, remove: async () => { if (removeFails) throw new Error('x'); return {}; } };
  li = make(api, base);
  const del = li.find('chat-actions')[0].children.find((b) => /delete/i.test(b.title));
  await del.onclick(); // asks
  await del.onclick(); // deletes (fails)
  check('delete: a failure re-enables the button, drops the armed state and says it could not delete', del.disabled === false && !del.classList.contains('armed') && /Could not delete/.test(meta(li).textContent), `${del.disabled} ${del.className} ${meta(li).textContent}`);
  await sleep(0);

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
