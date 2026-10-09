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
  querySelector(sel) { return this.find(sel.replace(/^\./, ''))[0] || null; }
  find(cls) { const out = []; const walk = (e) => { if (e.classList?.contains?.(cls)) out.push(e); (e.children || []).forEach(walk); }; walk(this); return out; }
}
const text = (s) => Object.assign(new El('#text'), { _text: s });
const sandbox = { document: { createElement: (t) => new El(t), createTextNode: text }, window: {}, setTimeout, clearTimeout, console };
sandbox.window = sandbox;
sandbox.chatItemsStopMs = 40; // the stop button's patience, shortened for the test
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat-items.js'), 'utf8'), sandbox, { filename: 'chat-items.js' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let opener = async () => true;
  let rerenderSpy = async () => {};
  const make = (api, chat) => { const item = sandbox.window.createChatItems({ api, open: opener, rerender: () => rerenderSpy(), cleared() {} }); return item(chat, false); };
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

  // a successful stop must not turn into a false "Could not stop it" when the list cannot redraw (a rename field open elsewhere)
  let listed = { chats: [] }; // the chat has left the line
  api = { exportChat: async () => ({ ok: true }), showTab: async () => {}, stopChat: async () => true, remove: async () => ({}), list: async () => listed };
  li = make(api, queued);
  stop = li.find('chat-stop-wait')[0];
  await stop.onclick({ stopPropagation() {} });
  await sleep(150);
  check('stop: after a true answer and no redraw, the row stays on "Stopping…" with no false failure note (the chat is gone from the line)', stop.disabled === true && /Stopping/.test(stop.textContent) && !/Could not stop/.test(meta(li).textContent), `${stop.textContent} / ${meta(li).textContent}`);
  listed = { chats: [{ id: 'c1', badge: 'queued' }] }; // ...but still waiting a while later: then it says so
  li = make(api, queued);
  stop = li.find('chat-stop-wait')[0];
  await stop.onclick({ stopPropagation() {} });
  await sleep(150);
  check('stop: a chat still in the line after a true answer gets its button back and a note', stop.disabled === false && /Could not stop/.test(meta(li).textContent), `${stop.disabled} ${meta(li).textContent}`);
  // a working chat: "Stop"; a false answer (it just finished) redraws instead of a false failure; a slow abort is not a failure

  const running = { ...base, badge: 'running', tab: { id: 2, title: 'Other', here: false } };
  api = { exportChat: async () => ({ ok: true }), showTab: async () => {}, stopChat: async () => false, remove: async () => ({}), list: async () => ({ chats: [{ id: 'c1', badge: null }] }) };
  let redrew = 0; rerenderSpy = () => { redrew++; }; li = make(api, running);
  stop = li.find('chat-stop-wait')[0];
  check('running: the row has a "Stop" control', !!stop && stop.textContent === 'Stop', stop && stop.textContent);
  await stop.onclick({ stopPropagation() {} });
  check('running: a false answer (it had just finished) redraws the list and shows no failure', redrew === 1 && !/Could not stop/.test(meta(li).textContent), `${redrew}`);
  api.stopChat = async () => new Promise(() => {}); // an abort that never answers in time, while the run has ended meanwhile
  li = make(api, running);
  stop = li.find('chat-stop-wait')[0];
  stop.onclick({ stopPropagation() {} });
  await sleep(150);
  check('running: a slow abort that has ended by the time it is checked shows no failure', !/Could not stop/.test(meta(li).textContent), meta(li).textContent);
  api = { exportChat: async () => ({ ok: true }), showTab: async () => { throw new Error('no tab'); }, stopChat: async () => true, remove: async () => ({}) };
  li = make(api, { ...base, badge: 'running', tab: { id: 2, title: 'Other', here: false } });
  await li.find('chat-open')[0].onclick();
  check('row click: opening the working chat\'s tab failing says so (no unhandled rejection)', /Could not open the tab/.test(meta(li).textContent), meta(li).textContent);

  // showTab answers false when the chat's tab is gone (it does not throw): a note, and the list stays open
  let closed = 0;
  sandbox.window.chatList = { close: () => { closed++; } };
  api = { exportChat: async () => ({ ok: true }), showTab: async () => false, stopChat: async () => true, remove: async () => ({}) };
  li = make(api, { ...base, badge: 'running', tab: { id: 2, title: 'Other', here: false } });
  await li.find('chat-open')[0].onclick();
  check('row click: showTab answering false says the tab is gone and the list is not closed', /Could not open the tab/.test(meta(li).textContent) && closed === 0, `${meta(li).textContent} ${closed}`);
  await li.find('chat-actions')[0].children.find((b) => b.classList.contains('chat-act-tab')).onclick();
  check('the open-in-tab button does the same', /Could not open the tab/.test(meta(li).textContent) && closed === 0);
  api.showTab = async () => true;
  await li.find('chat-open')[0].onclick();
  check('showTab true closes the list', closed === 1, closed);
  // an idle chat's row click moves it here: a false answer (gone) gets a note that is seen, and the list is drawn again after it
  let redraws = 0;
  opener = async () => false; // as in production: the page answers false and does not redraw first
  rerenderSpy = () => { redraws++; };
  li = make(api, base);
  await li.find('chat-open')[0].onclick();
  check('row click: an idle chat that cannot be opened shows its note on the row (still attached) and has not redrawn yet', /Could not open this chat/.test(meta(li).textContent) && redraws === 0, `${meta(li).textContent} ${redraws}`);
  await sleep(2700);
  check('...and the list is redrawn after the note has been read', redraws === 1, redraws);
  // the redraw never lands on an open rename field, and a second failed open does not stack a second timer
  redraws = 0;
  li = make(api, base);
  await li.find('chat-open')[0].onclick();
  await li.find('chat-open')[0].onclick();
  li.append(Object.assign(new El('input'), { className: 'chat-rename-input' }));
  await sleep(2700);
  check('row click: no redraw over an open rename field (and two failed opens leave one timer)', redraws === 0, redraws);
  li = make(api, base);
  await li.find('chat-open')[0].onclick();
  await li.find('chat-open')[0].onclick();
  await sleep(2700);
  check('row click: two failed opens in a row redraw once', redraws === 1, redraws);
  li = make(api, base);
  await li.find('chat-open')[0].onclick();
  li.find('chat-actions')[0].children.find((b) => /delete/i.test(b.title)).classList.add('armed');
  await sleep(2700);
  check('row click: no redraw over an armed delete', redraws === 1, redraws);
  rerenderSpy = async () => {};
  opener = async () => true;
  // a slow stop that then succeeds takes its failure note back
  api = { exportChat: async () => ({ ok: true }), showTab: async () => true, stopChat: async () => { await sleep(90); return true; }, remove: async () => ({}), list: async () => ({ chats: [] }) };
  li = make(api, queued);
  stop = li.find('chat-stop-wait')[0];
  const slow = stop.onclick({ stopPropagation() {} });
  await sleep(60);
  check('stop: a slow answer first restores the button with a note', stop.disabled === false && /Could not stop/.test(meta(li).textContent));
  await slow;
  check('stop: ...and a late success takes the note back and shows "Stopping…"', stop.disabled === true && /Stopping/.test(stop.textContent) && !/Could not stop/.test(meta(li).textContent), `${stop.textContent} / ${meta(li).textContent}`);
  // a second click after the first one timed out: a false answer about it must not fail the first stop that worked
  let calls = 0;
  api = { exportChat: async () => ({ ok: true }), showTab: async () => true, remove: async () => ({}), list: async () => ({ chats: [] }), stopChat: async () => { calls++; if (calls === 1) { await sleep(90); return true; } return false; } };
  li = make(api, queued);
  stop = li.find('chat-stop-wait')[0];
  const first = stop.onclick({ stopPropagation() {} });
  await sleep(60); // the first one timed out: the button is back
  const second = stop.onclick({ stopPropagation() {} });
  await Promise.all([first, second]);
  check('stop: a false answer to a second click is ignored while the first stop worked', stop.disabled === true && /Stopping/.test(stop.textContent) && !/Could not stop/.test(meta(li).textContent), `${stop.textContent} / ${meta(li).textContent}`);
  // a stop that works, then a slower earlier timeout: the timeout does not fail it
  calls = 0;
  api = { exportChat: async () => ({ ok: true }), showTab: async () => true, remove: async () => ({}), list: async () => ({ chats: [] }), stopChat: async () => { calls++; if (calls === 1) { await sleep(90); return true; } return true; } };
  li = make(api, queued);
  stop = li.find('chat-stop-wait')[0];
  const slowFirst = stop.onclick({ stopPropagation() {} });
  await sleep(10);
  stop.disabled = false;
  await stop.onclick({ stopPropagation() {} }); // the second answers true at once: stopped
  await sleep(60); // the first one's patience (40 ms) runs out after that
  check('stop: a stop that already worked is not failed by an older one running out of patience', !/Could not stop/.test(meta(li).textContent), meta(li).textContent);
  await slowFirst;
  // a row that has been redrawn away is never written to
  api = { exportChat: async () => ({ ok: true }), showTab: async () => true, stopChat: async () => true, remove: async () => ({}), list: async () => ({ chats: [{ id: 'c1', badge: 'queued' }] }) };
  li = make(api, queued);
  stop = li.find('chat-stop-wait')[0];
  await stop.onclick({ stopPropagation() {} });
  li.isConnected = false; // the list was redrawn
  await sleep(150);
  check('stop: the follow-up leaves a detached row alone', stop.disabled === true && !/Could not stop/.test(meta(li).textContent));

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

  // "Also show in this tab" and a chat shown in several tabs
  {
    const calls = [];
    let shownTab = 0;
    const sapi = { exportChat: async () => ({ ok: true }), showTab: async () => { shownTab++; return true; }, stopChat: async () => true, remove: async () => ({}) };
    const withShare = (chat, shareFn) => sandbox.window.createChatItems({ api: sapi, open: async (id) => { calls.push(['open', id]); return true; }, share: shareFn, rerender() {}, cleared() {} })(chat, false);
    const shareFn = async (id) => { calls.push(['share', id]); return true; };
    const other = { ...base, tab: { id: 2, title: 'Docs', here: false }, tabs: [{ id: 2, title: 'Docs', home: true, here: false }] };
    const btns = (li) => li.find('chat-actions')[0].children;
    let li = withShare(other, shareFn);
    const share = btns(li).find((b) => b.classList.contains('chat-act-share'));
    check('also show: a chat in another tab offers "Also show in this tab" next to Move and Open in its tab', Boolean(share) && share.title === 'Also show in this tab' && btns(li).some((b) => b.classList.contains('chat-act-move')) && btns(li).some((b) => b.classList.contains('chat-act-tab')), btns(li).map((b) => b.className).join('|'));
    await share.onclick();
    check('also show: the button calls share (not open), so the chat is not moved', JSON.stringify(calls) === '[["share","c1"]]', JSON.stringify(calls));
    calls.length = 0;
    li = withShare(other, null);
    check('also show: no share handler, no button', !btns(li).some((b) => b.classList.contains('chat-act-share')));
    li = withShare({ ...base, tab: { id: 1, title: 'Here', here: true }, tabs: [{ id: 1, title: 'Here', home: true, here: true }] }, shareFn);
    check('also show: not offered for a chat that already shows in this tab, or in no tab', !btns(li).some((b) => b.classList.contains('chat-act-share')) && !btns(withShare(base, shareFn)).some((b) => b.classList.contains('chat-act-share')));
    let failed = 0;
    li = withShare(other, async () => { failed++; return false; });
    await btns(li).find((b) => b.classList.contains('chat-act-share')).onclick();
    check('also show: a chat that is gone gets the same note as Move', failed === 1 && /Could not open this chat/.test(meta(li).textContent), meta(li).textContent);

    // the list line: "In 2 tabs: A (home), B", and a click goes to a tab instead of moving the chat
    const two = { ...base, tab: { id: 2, title: 'Docs', here: false }, tabs: [{ id: 2, title: 'Docs', home: true, here: false }, { id: 3, title: 'Mail', home: false, here: false }] };
    li = withShare(two, shareFn);
    const placeOf = (l) => l.find('chat-place')[0]?.textContent || '';
    check('shared: the row says "In 2 tabs" with the titles and marks the home', /^In 2 tabs: Docs \(home\), Mail/.test(placeOf(li)), placeOf(li));
    await li.find('chat-open')[0].onclick();
    check('shared: a click on the row attaches it to this sidebar (share, not move, and no tab switch)', shownTab === 0 && JSON.stringify(calls) === '[["share","c1"]]', `${shownTab} ${JSON.stringify(calls)}`);
    check('shared: the row says a click opens it here too', /click opens it here too/.test(placeOf(li)), placeOf(li));
    calls.length = 0;
    li = withShare(two, null);
    await li.find('chat-open')[0].onclick();
    check('shared: with no share handler a click still goes to a tab', shownTab === 1 && calls.length === 0, `${shownTab}`);
    li = withShare({ ...other, badge: 'running' }, shareFn);
    await li.find('chat-open')[0].onclick();
    check('working in another tab: a click attaches it here (share), it does not switch tabs or move it', shownTab === 1 && JSON.stringify(calls) === '[["share","c1"]]', `${shownTab} ${JSON.stringify(calls)}`);
    calls.length = 0;
    li = withShare(other, shareFn);
    await li.find('chat-open')[0].onclick();
    check('idle in another tab: a click moves it here (open)', JSON.stringify(calls) === '[["open","c1"]]', JSON.stringify(calls));
    calls.length = 0;
    const mine = { ...base, tab: { id: 3, title: 'Mail', here: true }, tabs: [{ id: 2, title: 'Docs', home: true, here: false }, { id: 3, title: 'Mail', home: false, here: true }] };
    li = withShare(mine, shareFn);
    check('shared: this tab is called "This tab" in the line, and the home is still marked', /^In 2 tabs: Docs \(home\), This tab/.test(placeOf(li)), placeOf(li));
    check('shared: a chat shown here as well has no Also show button', !btns(li).some((b) => b.classList.contains('chat-act-share')));
    await li.find('chat-open')[0].onclick();
    check('shared: a chat this tab already shows just opens on a click (no tab switch)', shownTab === 1 && JSON.stringify(calls) === '[["open","c1"]]', `${shownTab} ${JSON.stringify(calls)}`);
    li = withShare(base, shareFn);
    check('unshared chats keep the old line and click', !/In \d tabs/.test(placeOf(li)));
  }

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
