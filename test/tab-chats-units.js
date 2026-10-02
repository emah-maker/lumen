// A sidebar chat per tab (features/tab-chats.js, and what agent.js does with it), plain Node: no Electron.
// Covers the tab-chat bindings (create, bind, move, unbind, saved with the session), the cap on chats working
// at once and the waiting line (and Claude Code / Grok Build taking turns), which tab a chat's tools act on
// (its own, never the one in front), moving a running chat to another tab, and two chats running side by side
// in two tabs on one Agent without sharing a tab, a page text or an approval.
const TC = require('../src/features/tab-chats');
const { Agent } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);

// ---- bindings
{
  const b = TC.createBindings();
  check('bindings: a new tab has no chat', b.chatOf(1) === null && b.tabOf('c1') === null && !b.claimed('c1'));
  b.bind(1, 'c1');
  b.bind(2, 'c2');
  check('bindings: each tab shows its own chat', b.chatOf(1) === 'c1' && b.chatOf(2) === 'c2' && b.tabOf('c1') === 1 && b.claimed('c2'));
  b.bind(1, 'c3');
  check('bindings: a tab holds one chat; the earlier one loses the tab', b.chatOf(1) === 'c3' && !b.claimed('c1'), J(b.entries()));
  b.bind(2, 'c3');
  check('bindings: two tabs may show one chat, its home is the one bound last', b.tabsOf('c3').length === 2 && b.tabOf('c3') === 2, J(b.entries()));
  const left = b.move('c3', 1);
  check('move chat to this tab: it leaves every other tab', J(left) === '[2]' && b.chatOf(2) === null && b.chatOf(1) === 'c3' && b.tabOf('c3') === 1, J(b.entries()));
  b.unbindTab(1);
  check('closing a tab unbinds it', b.chatOf(1) === null && !b.claimed('c3'));
  b.bind(5, 'x'); b.bind(6, 'x'); b.unbindChat('x');
  check('deleting a chat unbinds it from every tab', b.size() === 0 || !b.claimed('x'), J(b.entries()));
  b.bind(null, 'x'); b.bind(7, '');
  check('bindings ignore a missing tab or chat', !b.claimed('x') && b.chatOf(7) === null);

  // persistence: saved with the session by tab order, restored onto new tab ids, never onto a chat that is gone
  const a = TC.createBindings();
  a.bind(10, 'c-a'); a.bind(11, 'c-b'); a.bind(12, 'c-gone');
  const saved = a.snapshot([10, 11, 99, 12]);
  check('persistence: the session saves each tab\'s chat in tab order (null: none)', J(saved) === J(['c-a', 'c-b', null, 'c-gone']), J(saved));
  const r = TC.createBindings();
  r.restore([1, 2, 3, 4], JSON.parse(J(saved)), (id) => id !== 'c-gone');
  check('persistence: after a restart each new tab shows its chat; a deleted chat and an empty slot stay unbound', r.chatOf(1) === 'c-a' && r.chatOf(2) === 'c-b' && r.chatOf(3) === null && r.chatOf(4) === null, J(r.entries()));
  const dup = TC.createBindings();
  dup.restore([1, 2], ['same', 'same']);
  check('persistence: a chat saved in two tabs comes back in the first only', dup.chatOf(1) === 'same' && dup.chatOf(2) === null, J(dup.entries()));
  const oldSession = TC.createBindings();
  oldSession.restore([1, 2], undefined);
  check('persistence: a session from before this feature restores no bindings', oldSession.size() === 0);
}

// ---- run slots: the cap and the waiting line
{
  const started = [];
  const mk = (max, cliMax) => TC.createRunSlots({ max, cliMax });
  const go = (slots, id, kind = 'api') => slots.request(id, { kind, start: () => started.push(id) });
  let s = mk(3);
  check('slots: the default cap is three', TC.DEFAULT_MAX_RUNS === 3 && s.limit === 3);
  check('slots: three chats start at once', go(s, 'a') === 'started' && go(s, 'b') === 'started' && go(s, 'c') === 'started' && J(started) === '["a","b","c"]', J(started));
  check('slots: the fourth waits, with a visible state', go(s, 'd') === 'queued' && s.state('d') === 'queued' && s.state('a') === 'running' && s.reason('d') === 'limit', `${s.state('d')} ${s.reason('d')}`);
  check('slots: a fifth waits behind it', go(s, 'e') === 'queued' && J(s.waitingIds()) === '["d","e"]');
  s.release('b');
  check('slots: a finished chat hands its place to the first in line, in order', s.state('d') === 'running' && s.state('e') === 'queued' && started.at(-1) === 'd', J({ started, w: s.waitingIds() }));
  check('slots: a new message in a chat that is running keeps its place', go(s, 'a') === 'started' && s.size() === 3 && started.at(-1) === 'a');
  check('slots: stopping a waiting chat takes it out of the line', s.cancel('e') === true && s.state('e') === null && s.cancel('e') === false);
  s.setMax(4);
  check('slots: a higher cap lets the next one in at once', go(s, 'f') === 'started' && s.size() === 4);
  s.setMax(2);
  check('slots: a lower cap lets nobody start until enough have finished', go(s, 'g') === 'queued');
  s.release('a'); s.release('c');
  check('slots: ... and then only up to the cap', s.state('g') === 'queued' && s.size() === 2, J(s.runningIds()));
  s.release('d');
  check('slots: ... the waiting one starts once there is room', s.state('g') === 'running');
  check('slots: the cap is clamped to 1..8', TC.clampRuns(0) === 1 && TC.clampRuns(99) === 8 && TC.clampRuns('x') === 3 && TC.clampRuns(2.4) === 2);

  // CLI engines take turns
  started.length = 0;
  s = mk(3);
  check('slots: slotKind tells a CLI engine from an API model', TC.slotKind('claudecode:opus') === 'cli' && TC.slotKind('grokbuild:default') === 'cli' && TC.slotKind('claude-opus-5') === 'api' && TC.slotKind('openai:gpt-5.6') === 'api' && TC.slotKind(undefined) === 'api');
  go(s, 'cc1', 'cli');
  check('slots: a second Claude Code / Grok Build chat waits even with room, and says why', go(s, 'cc2', 'cli') === 'queued' && s.reason('cc2') === 'cli', s.reason('cc2'));
  check('slots: an API chat still starts beside a CLI chat', go(s, 'api1') === 'started' && s.size() === 2);
  s.release('cc1');
  check('slots: the CLI chat in line starts when the CLI chat ends', s.state('cc2') === 'running', J(started));
  // a CLI chat waiting does not block API chats that fit
  s = mk(3); started.length = 0;
  go(s, 'cc1', 'cli'); go(s, 'cc2', 'cli');
  check('slots: a CLI chat in line does not hold up the API chats behind it', go(s, 'x') === 'started' && s.state('cc2') === 'queued', J(started));
  // a start that throws gives its place back
  s = mk(1);
  s.request('boom', { start: () => { throw new Error('x'); } });
  check('slots: a start that fails gives its place back', s.size() === 0 && s.state('boom') === null);

  // a failing start tells the chat, and the line goes on
  const errs = [];
  s = TC.createRunSlots({ max: 1, onError: (id, e) => errs.push([id, e.message]) });
  const order = [];
  s.request('first', { start: () => order.push('first') });
  s.request('bad', { start: () => { throw new Error('no engine'); } });
  s.request('next', { start: () => order.push('next') });
  check('slots: the line is waiting behind a running chat', s.state('bad') === 'queued' && s.state('next') === 'queued');
  s.release('first');
  check('slots: a start that throws is reported (an error for the chat), its slot is given back and the next in line goes', J(errs) === '[["bad","no engine"]]' && s.state('bad') === null && s.state('next') === 'running' && J(order) === '["first","next"]', J({ errs, order, st: s.state('next') }));
  s = TC.createRunSlots({ max: 2, onError: (id, e) => errs.push([id, e.message]) });
  errs.length = 0;
  check('slots: a start that throws at once reports "failed" and holds no slot', s.request('x', { start: () => { throw new Error('boom'); } }) === 'failed' && s.size() === 0 && J(errs) === '[["x","boom"]]', J(errs));
  check('slots: a chat that already holds a slot and fails to restart gives it up', (() => { s.request('y', { start() {} }); const r = s.request('y', { start: () => { throw new Error('again'); } }); return r === 'failed' && s.state('y') === null; })());

  // the cap raised starts every chat that now fits, at once
  started.length = 0;
  s = mk(1);
  go(s, 'a'); go(s, 'b'); go(s, 'c');
  check('slots: with the cap at one, two chats wait', s.state('a') === 'running' && J(s.waitingIds()) === '["b","c"]');
  s.setMax(3);
  check('cap change: raising the cap starts the waiting chats right away', s.state('b') === 'running' && s.state('c') === 'running' && s.waitingIds().length === 0 && J(started) === '["a","b","c"]', J(started));

  // the watchdog: a slot whose run is gone without a done is released after two sweeps
  const stale = [];
  let engineAlive = true;
  s = TC.createRunSlots({ max: 1, cliMax: 1, onStale: (id) => stale.push(id) });
  started.length = 0;
  s.request('cli1', { kind: 'cli', start: () => started.push('cli1'), alive: () => engineAlive });
  s.request('cli2', { kind: 'cli', start: () => started.push('cli2'), alive: () => true });
  check('watchdog: nothing is released while the run lives', J(s.sweep()) === '[]' && s.state('cli2') === 'queued');
  engineAlive = false; // the engine process exited without ever saying done
  check('watchdog: one missed sweep is not enough (a run is just starting)', J(s.sweep()) === '[]' && s.state('cli1') === 'running');
  check('watchdog: the slot of a run that is gone is released, the chat is told, and the next CLI chat starts', J(s.sweep()) === '["cli1"]' && J(stale) === '["cli1"]' && s.state('cli1') === null && s.state('cli2') === 'running' && J(started) === '["cli1","cli2"]', J({ stale, started }));
  engineAlive = true;
  s = TC.createRunSlots({ max: 1 });
  let flaky = false;
  s.request('f', { start() {}, alive: () => !flaky });
  flaky = true; s.sweep(); flaky = false;
  check('watchdog: a run that comes back resets the count', J(s.sweep()) === '[]' && s.state('f') === 'running');
}

// ---- mark and badge styling: a state class must not match another component's rule (static check, no app needed)
// The "needs OK" mark once carried the class "approval", which is also the approval card (padding, background, hover lift):
// it drew as a 40px pill. The state classes of the tab marks and list badges are checked against every stylesheet.
{
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  const css = ['styles.css', 'chats.css', 'managers.css', 'private.css'].filter((n) => fs.existsSync(path.join(dir, n))).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const items = fs.readFileSync(path.join(dir, 'chat-items.js'), 'utf8');
  const stateClasses = ['running', 'waiting', 'queued', 'unread', 'done', 'needs-ok'];
  const loose = stateClasses.filter((c) => new RegExp('(^|[,}\\n])\\s*\\.' + c + '\\s*[{,:]').test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('marks: no stylesheet has a bare rule for a mark state class (it would style the mark too)', loose.length === 0, J(loose));
  check('marks: the needs-OK state uses its own class in the tab strip and the chat list, never "approval"', /'needs-ok'/.test(app) && /'needs-ok'/.test(items) && /\.tab-chat-mark\.needs-ok/.test(css) && /\.chat-badge\.needs-ok/.test(css) && !/\.(tab-chat-mark|chat-badge)\.approval/.test(css));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'en.json'), 'utf8'));
  check('marks: the four state words are in the locale table', ['running', 'queued', 'approval', 'unread'].every((k) => en['chats.state.' + k]), J(Object.keys(en).filter((k) => k.startsWith('chats.state'))));
  check('marks: the finished-row tint does not beat the hover and focus tint', /has-unread:not\(\.current\):not\(:hover\):not\(:focus-within\)/.test(css));
  check('marks: both the strip marks and the list badges have a forced-colors fallback', (css.match(/forced-colors: active[^]*?\.tab-chat-mark/) || [])[0] !== undefined && /forced-colors: active\) \{\s*\.chat-badge/.test(css));
  check('marks: the row actions float (they take no width from the title)', /\.chat-actions \{ position: absolute/.test(css));
  { // AA (4.5:1) for the small text on the row and the selected row, both themes: the colours as the sheets mix them
    const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
    const lum = (a) => a.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((t, v, i) => t + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const themes = { light: { bg: '#ffffff', text: '#1d1d1f', muted: '#6e6e73', accent: '#007aff', soft: [0, 122, 255, 0.14] }, dark: { bg: '#2c2c2e', text: '#f5f5f7', muted: '#98989d', accent: '#0a84ff', soft: [10, 132, 255, 0.2] } };
    const worst = { meta: 99, stop: 99 };
    for (const t of Object.values(themes)) {
      const bg = hex(t.bg), sel = mix(t.soft.slice(0, 3), bg, t.soft[3]);
      for (const under of [bg, sel]) {
        worst.meta = Math.min(worst.meta, ratio(mix(hex(t.muted), hex(t.text), 0.55), under));
        worst.stop = Math.min(worst.stop, ratio(mix(hex(t.accent), hex(t.text), 0.6), under));
      }
    }
    check('marks: the meta line and "Stop waiting" are AA (4.5:1) in both themes', /\.chat-meta \{[^}]*color-mix\(in srgb, var\(--muted\) 55%, var\(--text\)\)/.test(css) && /\.chat-stop-wait \{[^}]*color-mix\(in srgb, var\(--accent\) 60%, var\(--text\)\)/.test(css) && worst.meta >= 4.5 && worst.stop >= 4.5, J(worst));
  }
  const cp = fs.readFileSync(path.join(dir, 'chat-page.css'), 'utf8');
  check('list: the open chat on the chat page does not force its action bar visible over its title', !/chat-item\.current \.chat-actions/.test(cp));
  check('list: touch devices (no hover) get the buttons always, with room left in the title', /@media \(hover: none\) \{ \.chat-actions \{ opacity: 1; pointer-events: auto; \}/.test(css) && /@media \(hover: none\)[^\n]*\.chat-title \{ padding-right: min\(var\(--actions-w/.test(css));
  check('list: the title leaves room for the floating buttons, and for the armed Delete? pill', /chat-item:hover \.chat-title[^{]*\{ padding-right: min\(var\(--actions-w/.test(css) && /chat-delete\.armed\) \.chat-title \{ padding-right: min\(calc/.test(css) && /--actions-w/.test(items));
  check('list: the "go there" arrow shows only on rows a click takes you to the tab of (working ones)', /is\(\.has-running, \.has-queued, \.has-approval\) \.chat-place:not\(\.here\)::after/.test(css) && !/\n\.chat-place:not\(\.here\)::after/.test(css));
  check('list: forced-colors selectors are as specific as the state rules they override', /forced-colors: active\) \{\s*\.chat-badge, \.chat-badge\.queued, \.chat-badge\.unread/.test(css) && /\.tab-chat-mark, \.tab-chat-mark\.waiting, \.tab-chat-mark\.done \{ color: CanvasText/.test(css));
  check('list: "Exported" goes in its own span (the state word stays) and the badge is hidden from screen readers', /say\(tr\('chats\.exported'/.test(items) && /metaText\.textContent = text/.test(items) && !/[^a-zA-Z]meta\.textContent =/.test(items) && /badge\.setAttribute\('aria-hidden', 'true'\)/.test(items) && !/badge\.setAttribute\('aria-label'/.test(items));
  check('list: the usage line is AA like the meta line', /\.chat-usage \{[^}]*color-mix\(in srgb, var\(--muted\) 55%/.test(css));
  check('list: a narrow list drops "move here" from an idle chat in another tab and the title padding follows', /@container chatlist \(max-width: 240px\)[^]*drops-one \.chat-act-drop \{ display: none/.test(css) && /drops-one:hover \.chat-title[^{]*\{ padding-right: min\(var\(--actions-w-narrow\)/.test(css) && /setProperty\('--actions-w-narrow'/.test(items) && /setProperty\('--actions-w',/.test(items) && /chat-act-drop/.test(items));
  check('list: the title padding eases in with the bar (same --t-fast)', /\.chat-title \{ transition: padding-right var\(--t-fast\)/.test(css) && /\.chat-actions \{[^}]*top: 3px/.test(css));
  check('list: the armed Delete? pill keeps a border under forced-colors', /forced-colors: active[^]*chat-delete\.armed \{ border: 1px solid CanvasText/.test(css));
  check('list: export, delete, stop and open-tab report a failure instead of staying silent, and a passing note reverts', /exportFailed/.test(items) && /deleteFailed/.test(items) && /stopFailed/.test(items) && /tabFailed/.test(items) && /setTimeout\(\(\) => \{ metaText\.textContent = original/.test(items) && /stop\.disabled = true/.test(items) && /del\.disabled = true/.test(items));
  check('list: an idle chat in another tab says that a click moves it here', /clickMoves/.test(items) && ['clickMoves', 'exportFailed', 'deleteFailed', 'stopFailed', 'stopping', 'tabFailed'].every((k) => en['chats.' + k]));
  { // the real export handler's answers, and what the list does with each
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('chats:export'"), mainSrc.indexOf("if (TEST) global.__chats"));
    check('export: main answers { ok:false, reason } for an empty chat and a dismissed Save dialog', /reason: 'empty'/.test(handler) && /reason: 'canceled'/.test(handler) && !/\bcancelled?\s*:/.test(handler.replace(/const \{ canceled/, '')));
    check('export: the list stays quiet for reason "canceled", has its own words for "empty", and fails otherwise', /out\?\.reason === 'empty'/.test(items) && /out\?\.reason !== 'canceled'/.test(items) && !/out\.canceled/.test(items) && en['chats.exportEmpty']);
  }
  { // "Stop waiting" gets an answer from main (an invoke), and the button can never stay on "Stopping…"
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
    const chatPre = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'chat-preload.js'), 'utf8');
    const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'chat-page.js'), 'utf8');
    check('stop: chats:stop is a handle that returns stopChat()\'s answer, listed as a UI-only channel for the window and the chat page', /ipcMain\.handle\('chats:stop'[^\n]*stopChat\(id\)/.test(mainSrc) && /'chats:stop'/.test(mainSrc.slice(0, mainSrc.indexOf('ipcMain.handle('))) && /'chats:stop'/.test(page));
    check('stop: both preloads invoke it', /stopChat: \(id\) => ipcRenderer\.invoke\('chats:stop'/.test(pre) && /stopChat: \(id\) => ipcRenderer\.invoke\('chats:stop'/.test(chatPre));
    check('stop: a false answer or 4 seconds without one restores the button with a note', /\(await api\.stopChat\(chat\.id\)\) === false/.test(items) && /timedOut = true; fail\(\)/.test(items) && /clearTimeout\(lost\);/.test(items)); // (behaviour: test/chat-items-units.js)
  }
  { // the title-padding rules, in the order and with the specificity the cascade needs
    const spec = (sel) => { // [ids, classes+attrs+pseudo-classes, elements] (a :has()/:is() counts its most specific argument)
      let ids = 0, cls = 0, el = 0;
      const rest = sel.replace(/:(has|is|not)\(([^()]*)\)/g, (_m, _n, arg) => { const inner = arg.split(',').map((x) => spec(x.trim())).sort((p, q) => q[0] - p[0] || q[1] - p[1] || q[2] - p[2])[0]; ids += inner[0]; cls += inner[1]; el += inner[2]; return ''; });
      ids += (rest.match(/#[\w-]+/g) || []).length; cls += (rest.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length; el += (rest.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
      return [ids, cls, el];
    };
    const cmp = (p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2];
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = []; // { sel, at: order, spec } for each selector that sets the chat title's padding-right
    const re = /([^{}@]+)\{([^{}]*)\}/g;
    let m, n = 0;
    while ((m = re.exec(flat))) {
      n++;
      if (!/padding-right/.test(m[2])) continue;
      for (const sel of m[1].split(',').map((x) => x.trim()).filter((x) => /\.chat-title\b/.test(x))) rules.push({ sel, at: n, spec: spec(sel), val: (m[2].match(/padding-right:\s*([^;]+)/) || [])[1] });
    }
    const find = (needle, not) => rules.filter((r) => r.sel.includes(needle) && (!not || !r.sel.includes(not)));
    const hover = find('.chat-item:hover .chat-title')[0], armed = find('.chat-delete.armed', 'drops-one')[0];
    const nHover = find('.drops-one:hover .chat-title')[0], nArmed = find('.drops-one:has(.chat-delete.armed) .chat-title')[0], nTouch = find('.drops-one .chat-title', ':')[0];
    check('padding rules: every one of them was found', [hover, armed, nHover, nArmed, nTouch].every(Boolean), J(rules.map((r) => r.sel)));
    check('padding rules: the narrow hover rule outranks the plain hover rule, the armed rules come after their hover rules and are not weaker', cmp(nHover.spec, hover.spec) > 0 && armed.at > hover.at && cmp(armed.spec, hover.spec) >= 0 && nArmed.at > nHover.at && cmp(nArmed.spec, nHover.spec) >= 0, J({ hover: hover.spec, nHover: nHover.spec, armed: armed.spec, nArmed: nArmed.spec }));
    check('padding rules: the narrow touch rule outranks the plain touch rule', cmp(nTouch.spec, find('.chat-title', ':').filter((r) => r.sel === '.chat-title')[0].spec) > 0);
    check('padding rules: the narrow ones read --actions-w-narrow and the plain ones --actions-w', [nHover, nArmed, nTouch].every((r) => /--actions-w-narrow/.test(r.val)) && [hover, armed].every((r) => /--actions-w\b(?!-)/.test(r.val)));
  }
  check('marks: the tab mark and the list badge are the same size (14px)', /\.tab-chat-mark \{[^}]*width: 14px; height: 14px/.test(css) && /\.chat-badge \{[^}]*width: 14px; height: 14px/.test(css));
}

// ---- tool target
{
  const open = () => true;
  check('tool target: a chat acts on its own tab, not the one in front', J(TC.resolveToolTab({ pinned: 4, activeId: 9, exists: open })) === '{"id":4}');
  check('tool target: a run with no tab yet uses the one in front', J(TC.resolveToolTab({ pinned: null, activeId: 9 })) === '{"id":9}');
  check('tool target: nothing open, nothing to act on', J(TC.resolveToolTab({ pinned: null, activeId: null })) === '{"id":null}');
  check('tool target: its tab closed is an error, never a quiet switch to the front tab', J(TC.resolveToolTab({ pinned: 4, activeId: 9, exists: (id) => id !== 4 })) === '{"error":"closed"}');
  check('tool target: a tab another chat works in is busy', J(TC.resolveToolTab({ pinned: 4, activeId: 9, busyElsewhere: (id) => id === 4 })) === '{"error":"busy"}');
  check('tool target: open_tab / switch_tab may take the front only for the tab the user is watching', TC.mayTakeFront({ runTabId: 3, activeId: 3 }) && !TC.mayTakeFront({ runTabId: 3, activeId: 7 }) && !TC.mayTakeFront({ runTabId: null, activeId: 7 }));
}

// ---- tab marks and following
{
  check('mark: working', TC.tabStatus({ run: 'running' }) === 'running');
  check('mark: waiting its turn', TC.tabStatus({ run: 'queued' }) === 'waiting');
  check('mark: finished and not viewed', TC.tabStatus({ unread: true }) === 'done');
  check('mark: waiting for an OK outranks working', TC.tabStatus({ run: 'running', approvals: 1, unread: true }) === 'approval');
  check('mark: working outranks a done reply', TC.tabStatus({ run: 'running', unread: true }) === 'running');
  check('mark: nothing to show', TC.tabStatus({}) === null);
  check('place: where a chat lives', TC.chatPlace({}) === 'none' && TC.chatPlace({ tabId: 2 }) === 'other' && TC.chatPlace({ tabId: 2, here: true }) === 'here');
  const b = TC.createBindings();
  b.bind(1, 'c1');
  const plan = (tabId, open, idle = true) => TC.followPlan({ tabId, chatOf: b.chatOf, claimed: b.claimed, openChatId: open, openIdle: idle });
  check('follow: a tab shows its own chat', J(plan(1, 'c9')) === '{"chat":"c1"}');
  check('follow: a new tab gets its own empty chat while the open chat belongs to another tab', J(plan(2, 'c1')) === '{"fresh":true}');
  check('follow: the one chat no tab holds (the last chat after a restart) is adopted by the tab you are on', J(plan(2, 'orphan')) === '{"adopt":"orphan"}');
  check('follow: ... unless it is working: it is never taken from the run that started it', J(plan(2, 'orphan', false)) === '{"fresh":true}');
}

// ---- the agent: tools go to the chat's own tab, two chats run side by side
const tabOf = (id) => ({ id, webContents: { id: 100 + id } });
const fakeBrowser = (state) => ({
  activeTab: () => (state.active == null ? null : tabOf(state.active)),
  tabById: (id) => (state.open.has(id) ? tabOf(id) : null),
  listTabs: () => [...state.open].map((id) => ({ id, title: `t${id}`, url: `https://t${id}.test/`, active: id === state.active })),
  effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0,
});
const newAgent = (state) => {
  const agent = new Agent(fakeBrowser(state), () => null, () => ({ model: 'claude-opus-5' }));
  agent.closeSignedInTabs = () => {};
  agent.newActionLog = () => ({});
  agent.undoSummary = () => null;
  return agent;
};
const chat = () => { const m = []; m.settings = { model: 'claude-opus-5' }; return m; };

(async () => {
  {
    const state = { active: 2, open: new Set([1, 2, 3]) };
    const agent = newAgent(state);
    const c1 = chat();
    const signal = new AbortController().signal;
    check('agent: with no task the front tab is the target', (await agent.inTask(null, signal, async () => agent.taskTab().id)) === 2);
    check('agent: a task pinned to tab 1 acts on tab 1 while tab 2 is in front', (await agent.inTask(1, signal, async () => agent.taskTab().id, c1)) === 1);
    state.active = 3;
    check('agent: ... and still does after the user moves to tab 3', (await agent.inTask(1, signal, async () => agent.taskTab().id, c1)) === 1);
    let err = null;
    state.open.delete(1);
    try { await agent.inTask(1, signal, async () => agent.taskTab(), c1); } catch (e) { err = e; }
    check('agent: a pinned tab that closed ends the task\'s use of it instead of using the front tab', /was closed/.test(err?.message || ''), err?.message);
    state.open.add(1);

    // two chats, two tabs: a chat with no tab of its own may not use the tab the other chat works in
    const cA = chat();
    const cB = chat();
    let busy = null;
    await agent.inTask(1, signal, async () => {
      state.active = 1; // the user is looking at tab 1, where chat A works
      await agent.inTask(null, signal, async () => { try { agent.taskTab(); } catch (e) { busy = e; } }, cB);
    }, cA);
    check('agent: a chat never drives the tab another chat works in', /in use by a task running in another chat/.test(busy?.message || ''), busy?.message);

    // moving a running chat to another tab re-pins it
    const moved = await agent.inTask(1, signal, async () => {
      const ok = agent.repinRun(cA, 3, { rec: 'window-2' });
      return { ok, tab: agent.taskTab().id, scope: agent.currentScope().rec, runTab: agent.runTabIdFor(cA) };
    }, cA);
    check('agent: "move chat to this tab" re-points a running chat\'s tools (and its window) at the new tab', moved.ok && moved.tab === 3 && moved.scope === 'window-2' && moved.runTab === 3, J(moved));
    check('agent: moving a chat that is not running does nothing', agent.repinRun(chat(), 2) === false);
  }

  {
    // two chats on one agent, each started in its own tab, tools and approvals kept apart
    const state = { active: 1, open: new Set([1, 2]) };
    const agent = newAgent(state);
    const seen = { A: [], B: [] };
    let release;
    const gate = new Promise((r) => { release = r; });
    agent.runTask = async function (messages, tab, userText, images, controller, emit) {
      const who = userText;
      emit({ type: 'text', text: `${who} started in tab ${tab?.id}` });
      await gate; // both are in flight at the same time here
      state.active = 2; // the user switches tabs meanwhile
      seen[who].push(this.taskTab().id);
      seen[who].push(this.runTabIdFor(messages));
      emit({ type: 'text', text: `${who} done` });
    };
    const cA = chat();
    const cB = chat();
    const evA = []; const evB = [];
    agent.messages = cA;
    const pa = agent.run('A', (e) => evA.push(e), [], { tabId: 1, messages: cA });
    agent.messages = cB;
    const pb = agent.run('B', (e) => evB.push(e), [], { tabId: 2, messages: cB });
    await sleep(30);
    check('agent: two chats run at the same time', agent.busyCount === 2 && agent.runningFor(cA) && agent.runningFor(cB), `${agent.busyCount}`);
    check('agent: each started in the tab its chat is bound to, not the one in front', evA[0]?.text === 'A started in tab 1' && evB[0]?.text === 'B started in tab 2', J([evA[0], evB[0]]));
    check('agent: both tabs are in use while they run', agent.usingTab(1) && agent.usingTab(2) && J(agent.runTabIds().sort()) === '[1,2]', J(agent.runTabIds()));
    release();
    await Promise.all([pa, pb]);
    check('agent: after the user switched tabs each chat\'s tools still acted on its own tab', J(seen.A) === '[1,1]' && J(seen.B) === '[2,2]', J(seen));
    check('agent: both finish with their own done event and nothing left running', evA.at(-1).type === 'done' && evB.at(-1).type === 'done' && agent.busyCount === 0 && agent.scopes.size === 0);

    // a chat that waited for a slot starts on its own messages even though another chat is the open one
    const cC = chat();
    agent.messages = cB; // the sidebar is on another chat by now
    let startedOn = null;
    agent.runTask = async function (messages, tab) { startedOn = { same: messages === cC, tab: tab?.id }; };
    await agent.run('C', () => {}, [], { tabId: 2, messages: cC, hosts: new Set(['c.test']) });
    check('agent: a chat that was waiting starts on its own conversation and tab', startedOn?.same === true && startedOn.tab === 2, J(startedOn));

    check('agent: page text is tracked per chat (a WeakMap keyed by its messages)', agent.pageContexts instanceof WeakMap);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
