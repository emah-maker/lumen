// [desktop apps] The AI operating other programs on this computer (Windows UI Automation, or System Events on macOS: platforms.js). Settings > AI > "Let the AI use other apps on
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
const liveLib = require('./live');
const platforms = require('./platforms');
const openFile = require('./open-file');

const THUMB_MS = 1500;
const POLL_MS = 200;
const ESC_HOLD_MS = 700;
const TAKEOVER_PX = 24;
const IDLE_END_MS = 90e3; // a session with no call for this long ends (a run that ends says so itself)
const PAUSE_WAIT_MS = 10 * 60e3;
const MAX_TYPE = 8000;
const LIST_CACHE_MS = 600;

// Everything an app told us (window titles, control names, values) goes to the AI inside this wrapper, with any literal wrapper tag in it defanged,
// so app text can never end the block and pass as the user's or Lumen's own words.
const defang = (t) => String(t ?? '').replace(/<(\/?)untrusted_page_content/gi, '\u2039$1untrusted_page_content');
const unwrap = (text, app) => `<untrusted_page_content source="app: ${defang(String(app || 'app')).replace(/["<>]/g, '')}">\n${defang(text)}\n</untrusted_page_content>`;
const sourceKey = (w) => `${w.app}|${w.pid}|${w.start || 0}|${w.hpid || 0}`; // one running program: its path, pid and start time
const targetOf = (w) => ({ hwnd: w.hwnd, pid: w.pid, hpid: w.hpid || 0, start: w.start || 0, title: String(w.title ?? '') }); // what the helper re-checks before it touches a window (macOS: the title tells two windows at the same place apart)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOf = (win) => `w${win.hwnd}`;

// deps: client { call, stop, destroy }, settings { master(), terminals(), allowed(), allow(app, name), setMaster(on) }, banner, winapi, shortcut { register(accel, fn), unregister(accel) },
// stopRun(), icon(exe) -> Promise<dataUrl>, lumen { pid, exe }, platform, now, hooks (tests: observed events),
// macOS: access { accessibility(), screen() } (permission checks that never prompt), resize(buffer, w, q), openSettings(url)
function createDesktop(deps = {}) {
  const platform = deps.platform || process.platform;
  const backend = platforms.backendFor(platform);
  const now = deps.now || Date.now;
  const lumen = deps.lumen || { pid: process.pid, exe: backend ? backend.lumenExe(process.execPath) : process.execPath };
  const S = deps.settings;
  let client = deps.client || null;
  const getClient = () => (client ||= backend.client({ access: deps.access, resize: deps.resize }));
  let api = deps.winapi || null; // the checks behind Esc and "you took over" (winapi.js / mac-probe.js): loaded the first time a session starts
  const getApi = () => { if (!api) { const l = backend.probe(); api = l.ok ? l : { ok: false }; } return api.ok ? api : null; };
  const permissionShown = new WeakSet(); // runs that were already shown the "open System Settings" card

  let list = { at: 0, apps: [] };
  let session = null; // { id, signal, emit, target, cardId, ... }
  let seq = 0;
  const cards = new Map(); // card id -> { hwnd, app, name } (what "Open" may bring forward; only windows the AI used)
  const sources = new WeakMap(); // run (its signal / context) -> Map(program -> is it a document program) for the programs whose text the run has read
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
  async function windowFor(args, { force = true } = {}) {
    const all = await apps(force); // (a fresh list every time: the decision is made on the window as it is now)
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
  // `acting`: this call clicks, types, presses keys or starts an app. Once the run has read untrusted content (a web page, an email, a
  // connector's answer, text from an app) neither Always nor Once covers an acting call: it asks every time, naming what it wants to do.
  // Taint has two sources. Web, email or connector content (ctx.tainted) covers the whole run. Text read from an app covers only acting in
  // OTHER apps: reading Word and acting in Word needs no new card, reading Word and acting in Excel does.
  // Only a known document program (Word, Excel, PowerPoint, Notepad, MATLAB) is exempt from its own text: text read from a browser, a mail or chat
  // app, a file manager, a shell or any program not on that list counts like web content for acting anywhere, that same program included.
  const noteRead = (ctx, win) => { const k = ctx.signal || ctx; if (!sources.has(k)) sources.set(k, new Map()); sources.get(k).set(sourceKey(win), policy.isDocumentApp(win)); };
  const readElsewhere = (ctx, win) => { const map = sources.get(ctx.signal || ctx); return Boolean(map) && [...map].some(([k, doc]) => k !== sourceKey(win) || !doc); };
  async function authorize(win, ctx, { acting = false, what = '', file = '' } = {}) {
    const tainted = acting && (Boolean(ctx.tainted?.()) || readElsewhere(ctx, win));
    const opts = policyOpts(ctx);
    if (tainted) { opts.allowed = []; opts.once = new Set(); }
    const d = policy.decide(win, opts);
    if (d.status === 'blocked') throw new Error(`${d.name}: ${d.reason}`);
    if (d.status === 'off') {
      await offerSwitch(ctx);
      return authorize(win, ctx, { acting, what, file }); // (the switch is on now, or offerSwitch threw)
    }
    if (d.status === 'allow') return d;
    const where = `${d.name}\nProgram: ${win.exe || '(unknown)'}${win.company ? `\nPublisher: ${treeLib.clip(win.company, 80)}` : ''}\nWindow: "${treeLib.clip(win.title, 120)}"`;
    if (tainted) {
      const ok = await ctx.ask({
        title: `The AI read content earlier in this chat. Allow it to ${what || 'act'} in ${d.name}?`,
        detail: 'Text it read (a web page, an email, a connector, or another app) could have been written to make it do this. Allow only if you asked for it. This answer covers this one action; it is asked again next time.',
        args: where, noAlways: true, allowLabel: 'Allow this action',
      });
      if (!ok) throw new Error(`The user did not allow this action in ${d.name}. Ask them what to do instead.`);
      return { ...d, status: 'allow', always: false };
    }
    const answer = await ctx.ask({
      title: `Allow the AI to use ${d.name}?`,
      detail: `${file ? `It will start with the file ${file}. ` : ''}It can read what is in the app (and take a picture of its window, which can show things a password mask does not hide), and click and type in it, while a banner shows and Stop works. Once allows it for this chat; Always adds it to Settings > AI > Apps the AI can use. It never reads or fills password fields. ${d.warn || ''}`.trim(),
      args: where,
    });
    if (!answer) throw new Error(`The user did not let the AI use ${d.name}. Ask them what to do instead.`);
    if (answer === 'always') S.allow(d.app, d.name); else ctx.once?.add(d.app);
    return { ...d, status: 'allow', always: answer === 'always' };
  }

  async function offerSwitch(ctx) {
    if (S.master()) return;
    const answer = await ctx.ask({
      title: 'Let the AI use other apps on this computer?',
      detail: `This turns on Settings > AI > "Let the AI use other apps on this computer". The AI can then read and operate apps you allow one by one, ${backend.examples}. You are asked about each app first, a banner shows while it works with a Stop button, and holding Esc stops it. Passwords, banking, security prompts, terminals and Lumen itself are never available.`,
      args: backend.switchNote,
      noAlways: true, allowLabel: 'Turn on',
    });
    if (!answer) throw new Error(policy.OFF_TEXT);
    S.setMaster(true);
  }

  // ---- the session: banner, card, thumbnail, takeover, stop
  function startSession(ctx) {
    const w = getApi();
    try { w?.start?.(); } catch { /* failed() says so below */ }
    if (!w || w.failed?.()) { try { w?.stop?.(); } catch { /* gone */ } throw new Error('The check that lets you stop the AI (Esc held, taking over) could not start on this computer, so the AI will not use other apps. Restart Lumen, or tell the Lumen team if it keeps happening.'); }
    stats.sessions++;
    session = {
      id: ++seq, signal: ctx.signal, emit: ctx.emit, target: null, card: null, label: '', paused: false, stopped: false, busy: false, busyUntil: 0,
      lastCursor: w?.cursor?.() || null, escSince: 0, timers: [], thumbBusy: false, thumbSig: '', resume: [], once: ctx.once, lastCall: now(),
    };
    const s = session;
    if (deps.live) startLive(s);
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
    const moved = !s.target || s.target.hwnd !== win.hwnd || s.target.pid !== win.pid;
    s.target = { hwnd: win.hwnd, pid: win.pid, hpid: win.hpid || 0, start: win.start || 0, app: win.app, name: win.name, title: win.title, exe: win.exe };
    s.win = win; // (everything the policy looks at; the live picture asks it again with the window's current title)
    if (moved) s.approvedTitle = null;
    s.live?.kick({ fresh: moved });
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

  function endSession(s, status = 'completed', extra = {}) {
    if (!s || session !== s) return;
    if (status === 'stopped') { try { client?.abort?.('Stopped by the user.'); } catch { /* gone */ } }
    for (const t of s.timers) clearInterval(t);
    s.live?.stop();
    try { api?.stop?.(); } catch { /* gone */ }
    if (extra.blocked && s.card) s.card.thumb = null; // a window that turned into something blocked: its picture is not kept, the card shows the placeholder
    try { deps.shortcut?.unregister('Ctrl+Alt+Esc'); } catch { /* gone */ }
    try { deps.banner?.hide(); } catch { /* gone */ }
    if (s.card) cardEvent(s, status, extra.blocked ? { blocked: true } : {});
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
    if (s.busy) { try { client?.abort?.('The user took over.'); } catch { /* gone */ } } // a call in flight ends now, not after it finishes
    Promise.resolve(deps.banner?.update({ paused: true })).catch(() => {});
    if (s.card) cardEvent(s, 'paused');
    deps.hooks?.onPause?.(why);
  }

  // Every 200 ms while the AI is using an app: Esc held stops it; the person moving the mouse over the app or typing in it pauses it.
  function poll(s) {
    const w = getApi();
    if (!w || session !== s || s.stopped) return;
    if (w.failed?.()) { stop('checks'); return; } // (macOS: the checks stopped running, so Esc would not work: the AI stops)
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
      const over = [s.target.pid, s.target.hpid].includes(w.pidUnderCursor());
      if (cur && s.lastCursor && over && (Math.abs(cur.x - s.lastCursor.x) + Math.abs(cur.y - s.lastCursor.y) >= TAKEOVER_PX || w.mouseDown())) { pause(s, 'mouse'); }
      else if (!busy && [s.target.pid, s.target.hpid].includes(w.foregroundPid()) && w.typing()) pause(s, 'keys');
      if (!over) s.lastCursor = cur || s.lastCursor; // the baseline follows the pointer until it is over the app
      else if (cur && s.lastCursor && !s.paused) s.lastCursor = cur;
    } catch { /* a failed check never stops the run */ }
  }

  // The card's live picture (live.js): the helper makes the frames; this only supplies the checks and shows what comes back.
  function startLive(s) {
    const L = deps.live;
    const winNow = () => ({ ...(s.win || s.target || {}), title: s.approvedTitle ?? s.target?.title ?? '' });
    s.live = liveLib.createLive({
      now, setTimeout: L.setTimeout, clearTimeout: L.clearTimeout, visible: () => L.visible?.() !== false, light: () => Boolean(L.light?.()), dpr: () => L.dpr?.() || 1,
      canRun: () => session === s && !s.stopped && !s.paused && !s.busy && now() >= s.busyUntil && Boolean(s.target && s.card),
      target: () => (s.target ? targetOf(s.target) : null),
      allowed: () => { if (!s.target) return false; const d = policy.decide(winNow(), policyOpts({ once: s.once })); return d.status === 'allow'; },
      judge: (title) => policy.decide({ ...winNow(), title }, policyOpts({ once: s.once })).status === 'allow',
      approved: () => s.approvedTitle ?? null,
      approve: (title) => { s.approvedTitle = title; if (s.target) s.target.title = title; },
      frame: (args) => getClient().call('frame', args, { timeoutMs: 4000 }),
      onFrame: (image, info) => { if (session !== s || s.stopped || !s.card) return; s.card.thumb = `data:image/jpeg;base64,${image}`; s.thumbSig = ''; cardEvent(s, s.paused ? 'paused' : 'working', { frame: true }); deps.hooks?.onFrame?.(info); }, // (frame: only the picture changed; the run's other bookkeeping and the card's text are left alone)
      onEnd: (reason) => { if (session !== s || reason === 'failed') return; endSession(s, 'stopped', reason === 'gone' ? {} : { blocked: true }); },
    });
    s.live.start();
  }

  // The card's picture, one shot (the first one, and the one when live is off): asked of the helper (async: the main process only handles the small answer), skipped while a call is running.
  async function thumb(s) {
    if (session !== s || s.stopped || s.thumbBusy || s.busy || !s.target || !s.card) return;
    if (s.live?.active()) return; // (the live picture keeps it fresh; this one stays for when live is off or gave up)
    if (s.card.thumb && deps.live?.visible?.() === false) return; // the card is off screen: no capture
    s.thumbBusy = true;
    try {
      const fresh = (await apps(true)).find((w) => w.hwnd === s.target.hwnd);
      const dec = fresh ? policy.decide(fresh, policyOpts({ once: s.once })) : null;
      if (session !== s) return;
      if (!fresh || fresh.pid !== s.target.pid || (fresh.start || 0) !== (s.target.start || 0) || !dec || dec.status === 'blocked' || dec.status === 'off') { endSession(s, 'stopped', { blocked: true }); return; } // it changed into something else (or something blocked): no more pictures
      s.target.title = fresh.title;
      const r = await getClient().call('shot', { ...targetOf(fresh), w: 420, q: 55 }, { timeoutMs: 6000 });
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
    try { return await fn(); } catch (err) {
      if (err?.aborted) throw new Error(s.stopped ? 'Stopped by the user.' : 'The user took over the app while this was running, so it was cut off. It may have partly happened: read the app again before going on.');
      throw err;
    } finally { s.busy = false; s.busyUntil = now() + 250; s.lastCall = now(); if (session === s) { if (s.live?.active()) s.live.kick(); else if (!s.card?.thumb) setImmediate(() => thumb(s)); } }
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
      if (d.status === 'allow') noteRead(ctx, w); // (its title is app text now in the chat)
      const state = d.status === 'allow' ? '' : ' (asks you first; the title is shown once allowed)';
      rows.push(`${w.id}  ${w.name}${d.status === 'allow' ? ` - "${treeLib.clip(w.title, 100)}"` : ''}${w.minimized ? ' [minimized]' : ''}${state}`);
    }
    return unwrap(`Open apps (pass the id or the name to the other actions):\n${rows.join('\n') || '(none)'}${hidden ? `\n(${hidden} other window${hidden === 1 ? ' is' : 's are'} never available to the AI: security prompts, password managers, banking, terminals, Lumen itself.)` : ''}`, 'open apps');
  }

  async function focusApp(args, ctx) {
    const win = await windowFor(args);
    await authorize(win, ctx);
    noteRead(ctx, win);
    const s = await useWindow(win, ctx, policy.stepLabel('focus_app', { name: win.name }));
    const r = await act(s, () => getClient().call('focus', { ...targetOf(win), raise: true }));
    list.at = 0;
    return unwrap(`Switched to ${win.name} ("${treeLib.clip(win.title, 100)}")${r.foreground ? '' : '. It could not take the keyboard (another window kept it): reading and clicking still work, typing keys may not.'}`, win.name);
  }

  async function readApp(args, ctx) {
    const win = await windowFor(args);
    await authorize(win, ctx);
    noteRead(ctx, win);
    const s = await useWindow(win, ctx, policy.stepLabel('read_app', {}, win.name));
    const r = await act(s, () => getClient().call('tree', { ...targetOf(win), max: 700 }, { timeoutMs: 20000 }));
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
    if (win.app !== session.target.app) throw new Error('That window now belongs to a different program. Call list_apps and read the app again.');
    await authorize(win, ctx, { acting: true, what: `${action} ${el}` });
    const s = await useWindow(win, ctx, policy.stepLabel(action, { element: el }, win.name));
    return act(s, () => getClient().call(cmd, { ...targetOf(win), el, ...extra }, { timeoutMs: 20000 }));
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
    try { parsed = backend.parseKeys(args.keys); } catch (err) { throw new Error(err.message); }
    const win = await windowFor(args.name || args.id ? args : {});
    await authorize(win, ctx, { acting: true, what: `press ${parsed.shown}` });
    const s = await useWindow(win, ctx, policy.stepLabel('press_keys', { keys: parsed.shown }, win.name));
    await act(s, () => getClient().call('keys', { ...targetOf(win), chords: parsed.chords }, { timeoutMs: 15000 }));
    return `Pressed ${parsed.shown} in ${win.name}.`;
  }

  async function screenshot(args, ctx) {
    const win = await windowFor(args);
    await authorize(win, ctx);
    noteRead(ctx, win);
    const s = await useWindow(win, ctx, policy.stepLabel('screenshot_app', {}, win.name));
    const r = await act(s, () => getClient().call('shot', { ...targetOf(win), w: 1000, q: 70 }, { timeoutMs: 20000 }));
    if (!r.image) throw new Error(`${win.name} could not be captured (it may be minimized). Use focus_app first.`);
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.image } },
      { type: 'text', text: unwrap(`Picture of ${win.name} ("${treeLib.clip(win.title, 80)}"). Use read_app for text and ids.`, win.name) },
    ];
  }

  async function openApp(args, ctx) {
    // path: open that existing document in the app that owns it (open-file.js decides what may be opened); the name may then be left out
    const opening = args.path != null && String(args.path).trim() ? (deps.checkOpenFile || openFile.checkOpenFile)(args.path, { name: args.name, profile: deps.profile || '' }) : null;
    const name = String(args.name ?? '').trim().slice(0, 80) || opening?.label || '';
    if (!name) throw new Error('Say which app to open (name), or the path of a file to open.');
    if (!S.master()) await offerSwitch(ctx);
    const r = await getClient().call('resolve', { name });
    const found = (r.found || []).slice().sort((a, b) => Number(b.exact) - Number(a.exact) || a.name.length - b.name.length)[0];
    if (!found) throw new Error(backend.notFound(name));
    const target = policy.exeKey(found.exe);
    if (!backend.launchable(target)) throw new Error(backend.notLaunchable(found.name));
    const probe = { proc: policy.baseOf(target), title: found.name, exe: found.exe, description: found.name, bundle: found.bundle || '' }; // (macOS: the bundle id from its Info.plist, so a renamed blocked app is still blocked)
    const before = new Set((await apps(true)).map((w) => w.hwnd));
    await authorize(probe, ctx, { acting: true, what: opening ? `open ${found.name} with the file ${require('path').basename(opening.file)}` : `open ${found.name}`, file: opening ? opening.file : '' }); // blocked programs are refused before anything starts; the rest ask
    await getClient().call('launch', { key: found.key, ...(opening ? { file: opening.file } : {}) }, { timeoutMs: 15000 });
    const stamp = now();
    const waitMs = deps.openWaitMs ?? 9000;
    while (now() - stamp < waitMs) {
      await sleep(Math.min(400, Math.max(10, waitMs / 4)));
      list.at = 0;
      // The window that actually appeared, by its program's path (never by a title or a name the AI chose): it is approved on its own merits.
      const w = (await apps(true)).find((x) => !before.has(x.hwnd) && policy.appKey(x) === target);
      if (w) {
        if (policy.appKey(w) !== policy.appKey(probe)) await authorize(w, ctx, { acting: true, what: `use ${w.name}` });
        else if (policy.decide(w, policyOpts(ctx)).status === 'blocked') throw new Error(`${w.name}: ${policy.decide(w, policyOpts(ctx)).reason}`);
        noteRead(ctx, w);
        const s = await useWindow(w, ctx, policy.stepLabel('open_app', { name: w.name }));
        s.lastCall = now();
        return unwrap(`Opened ${w.name} (id ${w.id}, "${treeLib.clip(w.title, 100)}"). Use read_app to see it.`, w.name);
      }
    }
    return unwrap(`Started ${found.name}, but no window of that program appeared yet. Call list_apps in a moment.`, found.name);
  }

  // The tool. input: { action, args }. ctx: { ask({ title, detail, args, noAlways, allowLabel }) -> true | 'always' | false, emit, signal, once: Set }
  async function run(input, ctx) {
    if (!backend) throw new Error(policy.NOT_SUPPORTED);
    stats.calls++;
    const action = String(input?.action ?? '');
    const args = input?.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {};
    try {
      switch (action) {
        case 'list_apps': return await listApps(ctx);
        case 'focus_app': return await focusApp(args, ctx);
        case 'read_app': return await readApp(args, ctx);
        case 'click': return await click(args, ctx);
        case 'type': return await type(args, ctx);
        case 'press_keys': return await pressKeys(args, ctx);
        case 'screenshot_app': return await screenshot(args, ctx);
        case 'open_app': return await openApp(args, ctx);
        default: throw new Error(`Unknown action "${action}". Use list_apps, focus_app, read_app, click, type, press_keys, screenshot_app or open_app.`);
      }
    } catch (err) {
      if (err?.permission && err.settingsUrl) await offerPermission(err, ctx);
      throw err;
    }
  }

  // macOS: a permission Lumen does not have yet (Accessibility, Screen Recording, Automation). Lumen never grants it: a card says what is
  // missing, with a button that opens that System Settings pane. Once per run; the AI is told the same in the error.
  async function offerPermission(err, ctx) {
    const key = ctx?.signal || ctx;
    if (!key || permissionShown.has(key) || !ctx?.ask) return;
    permissionShown.add(key);
    const pane = { accessibility: 'Accessibility', screen: 'Screen & System Audio Recording', automation: 'Automation' }[err.permission] || 'Privacy & Security';
    let open;
    try {
      open = await ctx.ask({
        title: `Lumen needs the macOS ${pane} permission`,
        detail: `${err.permission === 'screen' ? 'To take a picture of another app\'s window' : 'To read and operate other apps'}, macOS has to allow Lumen in System Settings > Privacy & Security > ${pane}. Lumen cannot turn this on itself. Turn on Lumen there${err.permission === 'screen' ? ', then quit and reopen Lumen' : ''}, and ask again.`,
        args: `System Settings > Privacy & Security > ${pane}`,
        noAlways: true, allowLabel: 'Open System Settings',
      });
    } catch { open = false; }
    if (open) { try { await deps.openSettings?.(err.settingsUrl); } catch { /* the user can open it by hand */ } }
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
    destroy() { if (session) endSession(session, 'stopped'); try { client?.destroy?.(); } catch { /* gone */ } try { deps.banner?.destroy?.(); } catch { /* gone */ } },
    // tests
    _poll: () => session && poll(session),
    _thumb: () => (session ? thumb(session) : null),
    liveStats: () => session?.live?.stats() || null,
    _live: () => session?.live || null, // (tests)
  };
}

module.exports = { createDesktop, THUMB_MS, POLL_MS, ESC_HOLD_MS, TAKEOVER_PX };
