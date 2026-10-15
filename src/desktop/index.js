// [desktop apps] The AI operating other programs on this computer (Windows UI Automation). Settings > AI > "Let the AI use other apps on
// this computer". One tool, desktop(action, args), whose actions are in policy.stepLabel: list_apps, focus_app, read_app, click, type,
// press_keys, screenshot_app, open_app. docs/desktop-apps.md has the whole model; in short:
//   - the master switch (aiDesktopControl, off by default) and a card per app (Once = this chat, Always = Settings list, No);
//   - never available: security prompts, password managers, banking, terminals (unless allowed), Lumen itself; password fields always;
//   - while it works: a banner (The AI is using Word · Stop), Esc held or Ctrl+Alt+Esc stops it, the user touching the app pauses it,
//     and the chat shows a card with the app, what it is doing and a live thumbnail.
// This file is loaded on first use (agent.js), never at startup. Everything with a side effect comes in through `deps`, so
// test/desktop-units.js drives it with fakes in plain Node and test/desktop-apps.js drives the real thing.
'use strict';

const policy = require('./policy');
const treeLib = require('./tree');
const keysLib = require('./keys');

const THUMB_MS = 1500;
const POLL_MS = 200;
const ESC_HOLD_MS = 700;
const TAKEOVER_PX = 24;
const IDLE_END_MS = 90e3; // a session with no call for this long ends (a run that ends says so itself)
const PAUSE_WAIT_MS = 10 * 60e3;
const MAX_TYPE = 8000;
const LIST_CACHE_MS = 600;

const unwrap = (text, app) => `<untrusted_page_content source="app: ${String(app || 'app').replace(/["<>]/g, '')}">\n${text}\n</untrusted_page_content>`;
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const idOf = (win) => `w${win.hwnd}`;

// deps: client { call, stop, destroy }, settings { master(), terminals(), allowed(), allow(app, name), setMaster(on) }, banner, winapi, shortcut { register(accel, fn), unregister(accel) },
// stopRun(), icon(exe) -> Promise<dataUrl>, lumen { pid, exe }, platform, now, hooks (tests: observed events)
function createDesktop(deps = {}) {
  const platform = deps.platform || process.platform;
  const now = deps.now || Date.now;
  const lumen = deps.lumen || { pid: process.pid, exe: process.execPath };
  const S = deps.settings;
  let client = deps.client || null;
  const getClient = () => (client ||= require('./client').createClient());
  let api = deps.winapi || null; // koffi calls: loaded the first time a session starts
  const getApi = () => { if (!api) { const l = require('./winapi').load(); api = l.ok ? l : { ok: false }; } return api.ok ? api : null; };

  let list = { at: 0, apps: [] };
  let session = null; // { id, signal, emit, target, cardId, ... }
  let seq = 0;
  const cards = new Map(); // card id -> { hwnd, app, name } (what "Open" may bring forward; only windows the AI used)
  const stats = { calls: 0, sessions: 0, takeovers: 0, stops: 0 };

  const policyOpts = (ctx) => ({ master: S.master(), terminals: S.terminals(), allowed: S.allowed(), once: ctx?.once, lumenPid: lumen.pid, lumenExe: lumen.exe });
  const emit = (ev) => { try { session?.emit?.(ev); } catch { /* a closed view */ } deps.hooks?.onEvent?.(ev); };

  // ---- the windows
  async function apps(force = false) {
    if (!force && now() - list.at < LIST_CACHE_MS) return list.apps;
    const r = await getClient().call('apps');
    list = { at: now(), apps: (r.apps || []).map((w) => ({ ...w, id: idOf(w), app: policy.appKey(w), name: policy.friendlyName(w.proc, w.description) })) };
    return list.apps;
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // The window the call is about: args.id ("w123"), args.name, else the window used last.
  async function windowFor(args, { force = false } = {}) {
    const all = await apps(force);
    const idArg = args.id ?? args.window ?? args.app_id;
    if (idArg !== undefined && idArg !== null && String(idArg) !== '') {
      const want = String(idArg).replace(/^w/i, '');
      const hit = all.find((w) => String(w.hwnd) === want);
      if (!hit) throw new Error(`No open window ${idArg}. Call list_apps to see what is open.`);
      return hit;
    }
    const name = norm(args.name ?? args.app);
    if (name) {
      const matches = all.filter((w) => norm(w.name) === name || norm(w.proc) === name || norm(w.title).includes(name) || norm(w.name).includes(name) || norm(w.proc).includes(name));
      const best = matches.find((w) => !w.minimized && (norm(w.name) === name || norm(w.proc) === name)) || matches.find((w) => norm(w.name) === name || norm(w.proc) === name) || matches.find((w) => !w.minimized) || matches[0];
      if (!best) throw new Error(`No open app matches "${args.name ?? args.app}". Call list_apps to see what is open, or open_app to start it.`);
      return best;
    }
    if (session?.target) {
      const hit = all.find((w) => w.hwnd === session.target.hwnd);
      if (hit) return hit;
      throw new Error(`${session.target.name} is not open any more. Call list_apps.`);
    }
    throw new Error('Say which app: pass name or id (from list_apps).');
  }

  // ---- permission: blocked / switch off / ask
  async function authorize(win, ctx) {
    const d = policy.decide(win, policyOpts(ctx));
    if (d.status === 'blocked') throw new Error(`${d.name}: ${d.reason}`);
    if (d.status === 'off') {
      await offerSwitch(ctx);
      return authorize(win, ctx); // (the switch is on now, or offerSwitch threw)
    }
    if (d.status === 'allow') return d;
    const answer = await ctx.ask({
      title: `Allow the AI to use ${d.name}?`,
      detail: 'It can read what is in the app and click and type in it, while a banner shows and Stop works. Once allows it for this chat; Always adds it to Settings > AI > Apps the AI can use. It never reads or fills password fields.',
      args: `${d.name}\nWindow: "${treeLib.clip(win.title, 120)}"`,
    });
    if (!answer) throw new Error(`The user did not let the AI use ${d.name}. Ask them what to do instead.`);
    if (answer === 'always') S.allow(d.app, d.name); else ctx.once?.add(d.app);
    return { ...d, status: 'allow', always: answer === 'always' };
  }

  async function offerSwitch(ctx) {
    if (S.master()) return;
    const answer = await ctx.ask({
      title: 'Let the AI use other apps on this computer?',
      detail: 'This turns on Settings > AI > "Let the AI use other apps on this computer". The AI can then read and operate apps you allow one by one, such as Word or File Explorer. You are asked about each app first, a banner shows while it works with a Stop button, and holding Esc stops it. Passwords, banking, security prompts, terminals and Lumen itself are never available.',
      args: 'Windows only. Nothing leaves this computer except what is sent to the AI in this chat.',
      noAlways: true, allowLabel: 'Turn on',
    });
    if (!answer) throw new Error(policy.OFF_TEXT);
    S.setMaster(true);
  }

  // ---- the session: banner, card, thumbnail, takeover, stop
  function startSession(ctx) {
    stats.sessions++;
    const w = getApi();
    session = {
      id: ++seq, signal: ctx.signal, emit: ctx.emit, target: null, card: null, label: '', paused: false, stopped: false, busy: false, busyUntil: 0,
      lastCursor: w?.cursor?.() || null, escSince: 0, timers: [], thumbBusy: false, thumbSig: '', resume: [], once: ctx.once, lastCall: now(),
    };
    const s = session;
    s.timers.push(setInterval(() => poll(s), POLL_MS), setInterval(() => thumb(s), THUMB_MS), setInterval(() => { if (now() - s.lastCall > IDLE_END_MS) endSession(s, 'completed'); }, 5000));
    for (const t of s.timers) t.unref?.();
    try { deps.shortcut?.register('Ctrl+Alt+Esc', () => stop('shortcut')); } catch { /* taken by another program: Esc held and the banner still work */ }
    if (ctx.signal) {
      const onAbort = () => { if (session === s) endSession(s, 'stopped'); };
      if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    return s;
  }

  function cardEvent(s, status, extra = {}) {
    const c = s.card;
    if (!c) return;
    emit({ type: 'desktop_card', surface: 'app', id: c.id, app: c.name, title: c.title, status, task: s.label, thumbnail: c.thumb || null, icon: c.icon || null, ...extra });
  }

  async function useWindow(win, ctx, label) {
    if (!session || session.stopped) startSession(ctx);
    const s = session;
    s.lastCall = now();
    s.label = label;
    s.target = { hwnd: win.hwnd, pid: win.pid, app: win.app, name: win.name, title: win.title, exe: win.exe };
    if (!s.card || s.card.app !== win.app) {
      if (s.card) cardEvent(s, 'completed');
      const id = `desk-${s.id}-${win.app}`;
      s.card = { id, app: win.app, name: win.name, title: win.title, hwnd: win.hwnd, thumb: null, icon: null };
      cards.set(id, { hwnd: win.hwnd, app: win.app, name: win.name });
      while (cards.size > 40) cards.delete(cards.keys().next().value);
      s.thumbSig = '';
      cardEvent(s, 'working');
      Promise.resolve(deps.icon?.(win.exe)).then((icon) => { if (icon && session === s && s.card?.id === id) { s.card.icon = icon; cardEvent(s, s.paused ? 'paused' : 'working'); } }).catch(() => {});
    } else { s.card.title = win.title; s.card.hwnd = win.hwnd; cardEvent(s, s.paused ? 'paused' : 'working'); }
    try { await deps.banner?.show(win.name, { paused: s.paused }); } catch { /* the banner is a courtesy: the run goes on */ }
    return s;
  }

  function endSession(s, status = 'completed') {
    if (!s || session !== s) return;
    for (const t of s.timers) clearInterval(t);
    try { deps.shortcut?.unregister('Ctrl+Alt+Esc'); } catch { /* gone */ }
    try { deps.banner?.hide(); } catch { /* gone */ }
    if (s.card) cardEvent(s, status);
    s.stopped = status === 'stopped';
    for (const r of s.resume.splice(0)) r(false);
    session = null;
  }

  function stop(why = 'banner') {
    const s = session;
    if (!s) return false;
    stats.stops++;
    s.stopped = true;
    try { deps.stopRun?.(); } catch { /* the run may already be over */ }
    endSession(s, 'stopped');
    deps.hooks?.onStop?.(why);
    return true;
  }

  function resume() {
    const s = session;
    if (!s || !s.paused) return false;
    s.paused = false;
    s.lastCursor = getApi()?.cursor?.() || s.lastCursor;
    Promise.resolve(deps.banner?.update({ paused: false })).catch(() => {});
    if (s.card) cardEvent(s, 'working');
    for (const r of s.resume.splice(0)) r(true);
    return true;
  }

  function pause(s, why) {
    if (s.paused || session !== s) return;
    stats.takeovers++;
    s.paused = true;
    Promise.resolve(deps.banner?.update({ paused: true })).catch(() => {});
    if (s.card) cardEvent(s, 'paused');
    deps.hooks?.onPause?.(why);
  }

  // Every 200 ms while the AI is using an app: Esc held stops it; the person moving the mouse over the app or typing in it pauses it.
  function poll(s) {
    const w = getApi();
    if (!w || session !== s || s.stopped) return;
    try {
      if (w.escapeDown()) {
        if (!s.escSince) s.escSince = now();
        else if (now() - s.escSince >= ESC_HOLD_MS) { stop('esc'); return; }
        return; // (Esc is not also "typing")
      }
      s.escSince = 0;
      if (s.paused || !s.target) return;
      const busy = s.busy || now() < s.busyUntil;
      const cur = w.cursor();
      const over = w.pidUnderCursor() === s.target.pid;
      if (cur && s.lastCursor && over && (Math.abs(cur.x - s.lastCursor.x) + Math.abs(cur.y - s.lastCursor.y) >= TAKEOVER_PX || w.mouseDown())) { pause(s, 'mouse'); }
      else if (!busy && w.foregroundPid() === s.target.pid && w.typing()) pause(s, 'keys');
      if (!over) s.lastCursor = cur || s.lastCursor; // the baseline follows the pointer until it is over the app
      else if (cur && s.lastCursor && !s.paused) s.lastCursor = cur;
    } catch { /* a failed check never stops the run */ }
  }

  // The card's live picture: asked of the helper (async: the main process only handles the small answer), skipped while a call is running.
  async function thumb(s) {
    if (session !== s || s.stopped || s.thumbBusy || s.busy || !s.target || !s.card) return;
    s.thumbBusy = true;
    try {
      const r = await getClient().call('shot', { hwnd: s.target.hwnd, w: 420, q: 55 }, { timeoutMs: 6000 });
      if (session !== s || !r.image) return;
      const sig = require('crypto').createHash('md5').update(r.image).digest('hex');
      if (sig === s.thumbSig) return;
      s.thumbSig = sig;
      s.card.thumb = `data:image/jpeg;base64,${r.image}`;
      cardEvent(s, s.paused ? 'paused' : 'working');
    } catch { /* no picture this time */ } finally { s.thumbBusy = false; }
  }

  // Before a call that acts: if the person took over, wait for Resume (banner or card) or Stop.
  async function gate(s) {
    if (s.stopped) throw new Error('Stopped by the user.');
    if (!s.paused) return;
    const ok = await new Promise((resolve) => { s.resume.push(resolve); const t = setTimeout(() => resolve(false), PAUSE_WAIT_MS); t.unref?.(); });
    if (!ok || s.stopped) throw new Error('The user took over the app and did not let the AI carry on. Ask them what they want next.');
  }

  async function act(s, fn) {
    await gate(s);
    s.busy = true;
    try { return await fn(); } finally { s.busy = false; s.busyUntil = now() + 250; s.lastCall = now(); if (session === s && !s.card?.thumb) setImmediate(() => thumb(s)); }
  }

  // ---- the actions
  async function listApps(ctx) {
    if (!S.master()) await offerSwitch(ctx);
    const all = await apps(true);
    const opts = policyOpts(ctx);
    let hidden = 0;
    const rows = [];
    for (const w of all) {
      const d = policy.decide(w, opts);
      if (d.status === 'blocked') { hidden++; continue; }
      const state = d.status === 'allow' ? '' : ' (asks you first; the title is shown once allowed)';
      rows.push(`${w.id}  ${w.name}${d.status === 'allow' ? ` - "${treeLib.clip(w.title, 100)}"` : ''}${w.minimized ? ' [minimized]' : ''}${state}`);
    }
    return `Open apps (pass the id or the name to the other actions):\n${rows.join('\n') || '(none)'}${hidden ? `\n(${hidden} other window${hidden === 1 ? ' is' : 's are'} never available to the AI: security prompts, password managers, banking, terminals, Lumen itself.)` : ''}`;
  }

  async function focusApp(args, ctx) {
    const win = await windowFor(args);
    await authorize(win, ctx);
    const s = await useWindow(win, ctx, policy.stepLabel('focus_app', { name: win.name }));
    const r = await act(s, () => getClient().call('focus', { hwnd: win.hwnd, raise: true }));
    list.at = 0;
    return `Switched to ${win.name} ("${treeLib.clip(win.title, 100)}")${r.foreground ? '' : '. It could not take the keyboard (another window kept it): reading and clicking still work, typing keys may not.'}`;
  }

  async function readApp(args, ctx) {
    const win = await windowFor(args);
    await authorize(win, ctx);
    const s = await useWindow(win, ctx, policy.stepLabel('read_app', {}, win.name));
    const r = await act(s, () => getClient().call('tree', { hwnd: win.hwnd, max: 700 }, { timeoutMs: 20000 }));
    s.readHwnd = win.hwnd;
    s.ids = new Set(treeLib.prune(r.tree).ids);
    const text = treeLib.render({ title: win.title, proc: win.proc, name: win.name }, r.tree);
    return unwrap(`${text}${r.truncated ? '\n(The window is large: only the first part was read.)' : ''}\nUse an id such as e3 with click or type.`, win.name);
  }

  async function elementCall(action, args, ctx, cmd, extra) {
    const el = String(args.element ?? args.id ?? '').trim();
    if (!/^e\d+$/.test(el)) throw new Error('Pass element: an id like e3 from read_app.');
    if (!session?.target || session.readHwnd !== session.target.hwnd) throw new Error('Read the app first (read_app): ids come from the latest read.');
    const win = await windowFor({ id: idOf(session.target) });
    await authorize(win, ctx);
    const s = await useWindow(win, ctx, policy.stepLabel(action, { element: el }, win.name));
    return act(s, () => getClient().call(cmd, { el, ...extra }, { timeoutMs: 20000 }));
  }

  async function click(args, ctx) {
    const r = await elementCall('click', args, ctx, 'invoke', {});
    return `Clicked ${args.element} (${r.method})${r.note ? `. ${r.note}` : ''}. Read the app again to see the result.`;
  }

  async function type(args, ctx) {
    const text = String(args.text ?? '');
    if (text.length > MAX_TYPE) throw new Error(`Too much text for one call (limit ${MAX_TYPE} characters). Type it in parts.`);
    const r = await elementCall('type', args, ctx, 'settext', { text, append: args.append === true, submit: args.submit === true });
    return `Typed ${text.length} character${text.length === 1 ? '' : 's'} into ${args.element} (${r.method === 'value' ? 'set the field' : 'keyboard'}).${args.submit ? ' Pressed Enter.' : ''}`;
  }

  async function pressKeys(args, ctx) {
    let parsed;
    try { parsed = keysLib.parseKeys(args.keys); } catch (err) { throw new Error(err.message); }
    const win = await windowFor(args.name || args.id ? args : {});
    await authorize(win, ctx);
    const s = await useWindow(win, ctx, policy.stepLabel('press_keys', { keys: parsed.shown }, win.name));
    await act(s, () => getClient().call('keys', { hwnd: win.hwnd, seq: parsed.seq }, { timeoutMs: 15000 }));
    return `Pressed ${parsed.shown} in ${win.name}.`;
  }

  async function screenshot(args, ctx) {
    const win = await windowFor(args);
    await authorize(win, ctx);
    const s = await useWindow(win, ctx, policy.stepLabel('screenshot_app', {}, win.name));
    const r = await act(s, () => getClient().call('shot', { hwnd: win.hwnd, w: 1000, q: 70 }, { timeoutMs: 20000 }));
    if (!r.image) throw new Error(`${win.name} could not be captured (it may be minimized). Use focus_app first.`);
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.image } },
      { type: 'text', text: `Picture of ${win.name} ("${treeLib.clip(win.title, 80)}"). Use read_app for text and ids.` },
    ];
  }

  async function openApp(args, ctx) {
    const name = String(args.name ?? '').trim().slice(0, 80);
    if (!name) throw new Error('Say which app to open (name).');
    if (!S.master()) await offerSwitch(ctx);
    const r = await getClient().call('resolve', { name });
    const found = (r.found || []).slice().sort((a, b) => Number(b.exact) - Number(a.exact) || a.name.length - b.name.length)[0];
    if (!found) throw new Error(`No app called "${name}" was found in the Start menu. Tell the user, or ask for the exact name.`);
    const exeBase = String(found.exe || found.name).split(/[\\/]/).pop();
    const probe = { proc: exeBase, title: found.name, exe: found.exe, description: found.name };
    const before = new Set((await apps(true)).map((w) => w.hwnd));
    await authorize(probe, ctx); // blocked apps are refused before anything starts; others ask like any app
    const startedFor = policy.friendlyName(exeBase, found.name);
    await getClient().call('launch', { key: found.key }, { timeoutMs: 15000 });
    const stamp = now();
    while (now() - stamp < 9000) {
      await sleep(400);
      list.at = 0;
      const fresh = (await apps(true)).filter((w) => !before.has(w.hwnd) && (w.app === policy.procKey(exeBase) || norm(w.name).includes(norm(startedFor)) || norm(w.title).includes(norm(name))));
      if (fresh.length) {
        const w = fresh[0];
        const dec = policy.decide(w, policyOpts(ctx));
        if (dec.status === 'blocked') throw new Error(`${dec.name}: ${dec.reason}`);
        if (dec.status === 'ask') ctx.once?.add(w.app); // (allowed above under another name: the same app now)
        const s = await useWindow(w, ctx, policy.stepLabel('open_app', { name: startedFor }));
        s.lastCall = now();
        return `Opened ${w.name} (id ${w.id}, "${treeLib.clip(w.title, 100)}"). Use read_app to see it.`;
      }
    }
    return `Started ${startedFor}, but no window appeared yet. Call list_apps in a moment.`;
  }

  // The tool. input: { action, args }. ctx: { ask({ title, detail, args, noAlways, allowLabel }) -> true | 'always' | false, emit, signal, once: Set }
  async function run(input, ctx) {
    if (platform !== 'win32') throw new Error(policy.NOT_WINDOWS);
    stats.calls++;
    const action = String(input?.action ?? '');
    const args = input?.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {};
    switch (action) {
      case 'list_apps': return listApps(ctx);
      case 'focus_app': return focusApp(args, ctx);
      case 'read_app': return readApp(args, ctx);
      case 'click': return click(args, ctx);
      case 'type': return type(args, ctx);
      case 'press_keys': return pressKeys(args, ctx);
      case 'screenshot_app': return screenshot(args, ctx);
      case 'open_app': return openApp(args, ctx);
      default: throw new Error(`Unknown action "${action}". Use list_apps, focus_app, read_app, click, type, press_keys, screenshot_app or open_app.`);
    }
  }

  // The run ended (agent.js): the banner goes and the card says Completed.
  function finishRun(signal) { if (session && (!signal || session.signal === signal)) endSession(session, 'completed'); }

  // The card's "Open": bring that window forward (only one the AI used in this session of Lumen).
  async function openCard(id) {
    const c = cards.get(String(id));
    if (!c) return false;
    try { await getClient().call('focus', { hwnd: c.hwnd, raise: true }); return true; } catch { return false; }
  }

  return {
    run, stop, resume, finishRun, openCard, apps,
    paused: () => Boolean(session?.paused),
    active: () => Boolean(session),
    session: () => (session ? { app: session.target?.name || '', paused: session.paused, card: session.card?.id || null } : null),
    stats: () => ({ ...stats, helperMs: client?.startMs?.() || 0 }),
    client: getClient,
    destroy() { if (session) endSession(session, 'stopped'); try { client?.destroy?.(); } catch { /* gone */ } },
    // tests
    _poll: () => session && poll(session),
    _thumb: () => (session ? thumb(session) : null),
  };
}

module.exports = { createDesktop, THUMB_MS, POLL_MS, ESC_HOLD_MS, TAKEOVER_PX };
