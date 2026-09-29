// An in-process stand-in for Chromium's browser-level DevTools connection (no port, no pipe, no
// second process). It speaks the same protocol as the pipe upstream in automation.js: flat sessions,
// NUL-free JSON messages { id, method, params, sessionId } in, the same plus events out. Behind it is
// Electron's webContents.debugger on each user tab, so the token proxy's filters (user tabs only,
// createTarget/closeTarget/Browser.close handled by Lumen, one session per client) run unchanged on
// top of it. This is how macOS runs automation: a launcher there would lose the open-url events
// LaunchServices sends to the process it started (see launcher.js), and Chromium's debugging port
// has no authentication.
//
// What it emulates (the parts Playwright's connectOverCDP, Puppeteer and Playwright MCP use):
//   Browser.getVersion, Browser.close
//   Target.attachToBrowserTarget, getTargets, getTargetInfo, getBrowserContexts, setDiscoverTargets,
//   setAutoAttach (on the browser and on a tab or frame session), attachToTarget, detachFromTarget,
//   and the events targetCreated / targetInfoChanged / targetDestroyed / attachedToTarget /
//   detachedFromTarget.
// Everything else on a tab or one of its frames/workers goes to that target's debugger session. Not
// available (answered with a CDP error, never a hang): browser contexts (createBrowserContext...),
// Browser.* commands other than getVersion/close (download behavior, permissions, window bounds),
// Target.createTarget/closeTarget/activateTarget below the proxy, Page.close and Page.crash. Downloads
// stay in Lumen's download manager: Browser.setDownloadBehavior "allow" is accepted (Playwright sends it
// on connect) and does nothing, "deny" is refused, and a client gets no download events.
//
// Differences from a real browser connection, all because a tab has ONE debugger session shared
// with Lumen itself (applyChromeIdentity, site security):
//  - Lumen keeps auto-attaching to a tab's iframes and workers (to give them the Chrome identity), so
//    a client's Target.setAutoAttach is answered here and not passed on; each client gets its own
//    session id for every child, and a child that starts paused is resumed by Lumen, possibly before
//    the client's own runIfWaitingForDebugger (early events of a fresh iframe can be missed).
//  - Domain state is shared per tab, like Emulation overrides and Fetch interception would be: events
//    of a domain one client enabled reach every client attached to the tab. When the last client
//    leaves a tab, what it changed (scripts to run on new documents, Fetch interception, device and
//    media emulation, extra headers...) is undone. A client's user-agent override is not.

const crypto = require('crypto');

const BROWSER_TARGET = 'lumen-browser';
const CONTEXT_ID = 'LUMENDEFAULTBROWSERCONTEXT0000000000';

// Commands that change a tab's state, and the command that undoes each when the last client is gone.
const UNDO = {
  'Fetch.enable': ['Fetch.disable', {}],
  'Emulation.setDeviceMetricsOverride': ['Emulation.clearDeviceMetricsOverride', {}],
  'Emulation.setTouchEmulationEnabled': ['Emulation.setTouchEmulationEnabled', { enabled: false }],
  'Emulation.setEmulatedMedia': ['Emulation.setEmulatedMedia', { media: '', features: [] }],
  'Emulation.setGeolocationOverride': ['Emulation.clearGeolocationOverride', {}],
  'Emulation.setTimezoneOverride': ['Emulation.setTimezoneOverride', { timezoneId: '' }],
  'Emulation.setLocaleOverride': ['Emulation.setLocaleOverride', {}],
  'Emulation.setScriptExecutionDisabled': ['Emulation.setScriptExecutionDisabled', { value: false }],
  'Emulation.setFocusEmulationEnabled': ['Emulation.setFocusEmulationEnabled', { enabled: false }],
  'Page.setBypassCSP': ['Page.setBypassCSP', { enabled: false }],
  'Network.setExtraHTTPHeaders': ['Network.setExtraHTTPHeaders', { headers: {} }],
  'Network.setCacheDisabled': ['Network.setCacheDisabled', { cacheDisabled: false }],
};

// Domains Lumen itself uses on a tab's debugger (site security's Audits) or that are handled apart
// (Fetch): a client's enable is never switched off behind its back.
const NOT_UNDONE = new Set(['Audits', 'Target', 'Fetch']);
const scopeOf = (hub, sid) => {
  let scope = hub.scopes.get(sid || null);
  if (!scope) hub.scopes.set(sid || null, scope = { enabled: new Set(), contexts: new Map(), runtimeOn: false });
  return scope;
};

// Refused inside a tab's session: they reach past the tab (or close it around Lumen's own tab state).
const BLOCKED = new Set([
  'Page.close', 'Page.crash', 'Page.setWebLifecycleState', 'Browser.close', 'Browser.crash', 'Browser.crashGpuProcess',
  'Browser.getVersion', 'Browser.setDownloadBehavior', 'Browser.setPermission', 'Browser.grantPermissions', 'Browser.resetPermissions',
  'Browser.setWindowBounds', 'Browser.getWindowForTarget', 'Browser.getWindowBounds',
]);

const unavailable = (method) => ({ code: -32601, message: `${method} is not available in Lumen's automation backend.` });
const sessionId = () => crypto.randomBytes(16).toString('hex').toUpperCase();

// Pure: is this command allowed inside a tab/frame session? { ok } or { error }.
function tabCommandFilter(method) {
  if (BLOCKED.has(method) || /^Browser\./.test(method)) return { error: unavailable(method) };
  if (/^Target\./.test(method)) return { error: unavailable(method) }; // the ones we emulate are handled before this
  return { ok: true };
}

// tabs() -> [{ id, webContents }]: the user's tabs. userAgent(): for Browser.getVersion.
function inprocUpstream({ tabs, userAgent = () => '', versions = process.versions, interval = 250 }) {
  const up = { onMessage() {}, onClose() {}, ready: Promise.resolve() };
  const sessions = new Map(); // our session id -> { id, kind: 'browser'|'page'|'child', wc, hub, sid, parent, autoAttach, discover }
  const hubs = new WeakMap(); // webContents -> { wc, children: Map(chromium sid -> { targetInfo, parent }), applied: Set, scripts: Set }
  const known = new Map(); // targetId -> { wc, info }
  const targetIds = new WeakMap();
  let closed = false;
  let timer = null;
  let chain = Promise.resolve();

  const emit = (msg) => { if (!closed) queueMicrotask(() => { if (!closed) up.onMessage(JSON.stringify(msg)); }); };
  const reply = (id, sid, result, error) => emit({ id, ...(sid ? { sessionId: sid } : {}), ...(error ? { error } : { result: result || {} }) });
  const event = (method, params, sid) => emit({ method, params, ...(sid ? { sessionId: sid } : {}) });

  // ---- one hub per tab: the debugger's single message stream, fanned out to each client session
  function hubOf(wc) {
    let hub = hubs.get(wc);
    if (hub) return hub;
    hub = { wc, children: new Map(), applied: new Set(), scripts: new Set(), scopes: new Map(), fetchOwner: null };
    hubs.set(wc, hub);
    const onMessage = (_e, method, params, sid) => fromChromium(hub, method, params, sid || null);
    const onDetach = () => { detachAll(hub); hub.children.clear(); };
    try {
      wc.debugger.on('message', onMessage);
      wc.debugger.on('detach', onDetach);
    } catch {}
    return hub;
  }

  function fromChromium(hub, method, params, sid) {
    if (method === 'Target.attachedToTarget') {
      hub.children.set(params.sessionId, { targetInfo: params.targetInfo, parent: sid, waiting: params.waitingForDebugger });
      for (const s of [...sessions.values()]) {
        if (s.hub === hub && s.kind !== 'browser' && s.autoAttach && s.sid === sid) attachChild(s, params.sessionId, hub.children.get(params.sessionId), true);
      }
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      hub.children.delete(params.sessionId);
      hub.scopes.delete(params.sessionId);
      for (const s of [...sessions.values()]) if (s.hub === hub && s.kind === 'child' && s.sid === params.sessionId) drop(s, true);
      return;
    }
    const scope = hub.scopes.get(sid);
    if (scope?.runtimeOn) {
      if (method === 'Runtime.executionContextCreated') scope.contexts.set(params.context.id, params);
      else if (method === 'Runtime.executionContextDestroyed') scope.contexts.delete(params.executionContextId);
      else if (method === 'Runtime.executionContextsCleared') scope.contexts.clear();
    }
    for (const s of sessions.values()) {
      if (s.hub === hub && s.kind !== 'browser' && s.sid === sid) event(method, params, s.id);
    }
  }

  function attachChild(parent, sid, child, live) {
    for (const s of sessions.values()) if (s.kind === 'child' && s.parent === parent.id && s.sid === sid) return s;
    const s = { id: sessionId(), kind: 'child', wc: parent.wc, hub: parent.hub, sid, parent: parent.id, autoAttach: false, inflight: new Set() };
    sessions.set(s.id, s);
    event('Target.attachedToTarget', { sessionId: s.id, targetInfo: { ...child.targetInfo, attached: true }, waitingForDebugger: Boolean(live && child.waiting) }, parent.id);
    return s;
  }

  // ---- targets: the user's tabs, refreshed on demand and on a timer while a client is connected
  async function targetIdOf(wc) {
    if (targetIds.has(wc)) return targetIds.get(wc);
    if (wc.isDestroyed()) return null;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const { targetInfo } = await wc.debugger.sendCommand('Target.getTargetInfo');
      targetIds.set(wc, targetInfo.targetId);
      return targetInfo.targetId;
    } catch { return null; }
  }
  const infoOf = (targetId, wc) => ({
    targetId, type: 'page', title: wc.getTitle() || '', url: wc.getURL() || 'about:blank',
    attached: [...sessions.values()].some((s) => s.kind === 'page' && s.wc === wc), canAccessOpener: false, browserContextId: CONTEXT_ID,
  });
  const browsers = () => [...sessions.values()].filter((s) => s.kind === 'browser');

  function refresh() {
    chain = chain.then(async () => {
      if (closed) return;
      const seen = new Set();
      for (const tab of tabs()) {
        const wc = tab.webContents;
        if (wc.isDestroyed()) continue;
        const targetId = await targetIdOf(wc);
        if (!targetId) continue;
        seen.add(targetId);
        hubOf(wc);
        const info = infoOf(targetId, wc);
        const before = known.get(targetId);
        known.set(targetId, { wc, info });
        if (!before) {
          for (const b of browsers()) {
            if (b.discover) event('Target.targetCreated', { targetInfo: info }, b.id);
            if (b.autoAttach) attachPage(b, targetId, false);
          }
        } else if (before.info.url !== info.url || before.info.title !== info.title) {
          for (const b of browsers()) if (b.discover) event('Target.targetInfoChanged', { targetInfo: info }, b.id);
        }
      }
      for (const [targetId, entry] of [...known]) {
        if (seen.has(targetId)) continue;
        known.delete(targetId);
        for (const s of [...sessions.values()]) if (s.kind === 'page' && s.wc === entry.wc) drop(s, true);
        for (const b of browsers()) if (b.discover) event('Target.targetDestroyed', { targetId }, b.id);
      }
    }).catch(() => {});
    return chain;
  }
  function schedule() {
    if (closed) return;
    if (sessions.size && !timer) { timer = setInterval(refresh, interval); timer.unref?.(); }
    else if (!sessions.size && timer) { clearInterval(timer); timer = null; }
  }

  // ---- sessions
  function attachPage(issuer, targetId, announce = true) {
    const entry = known.get(targetId);
    if (!entry || entry.wc.isDestroyed()) return null;
    for (const s of sessions.values()) if (s.kind === 'page' && s.parent === (issuer ? issuer.id : null) && s.wc === entry.wc && issuer) return s;
    try { if (!entry.wc.debugger.isAttached()) entry.wc.debugger.attach('1.3'); } catch { return null; }
    const s = { id: sessionId(), kind: 'page', wc: entry.wc, hub: hubOf(entry.wc), sid: null, parent: issuer ? issuer.id : null, autoAttach: false, targetId, inflight: new Set() };
    sessions.set(s.id, s);
    if (issuer && announce !== 'silent') event('Target.attachedToTarget', { sessionId: s.id, targetInfo: { ...infoOf(targetId, entry.wc), attached: true }, waitingForDebugger: false }, issuer.id);
    schedule();
    return s;
  }

  // Removes a session and everything under it. `notify`: tell whoever owns it.
  function drop(s, notify) {
    if (!sessions.delete(s.id)) return;
    for (const c of [...sessions.values()]) if (c.parent === s.id) drop(c, notify);
    const owner = s.parent && sessions.get(s.parent);
    if (notify && (s.kind === 'page' || s.kind === 'child') && (owner || !s.parent)) {
      event('Target.detachedFromTarget', { sessionId: s.id, targetId: s.targetId || s.hub?.children.get(s.sid)?.targetInfo?.targetId }, owner ? owner.id : undefined);
    }
    // Its interception goes with it, whoever else is still attached.
    if (s.hub && s.hub.fetchOwner === s.id) {
      s.hub.fetchOwner = null;
      if (!s.wc.isDestroyed()) s.wc.debugger.sendCommand('Fetch.disable', {}, s.sid || undefined).catch(() => {});
    }
    if (s.kind === 'page') {
      const tabStillOpen = [...sessions.values()].some((o) => o.kind === 'page' && o.wc === s.wc);
      if (!tabStillOpen) undo(s.hub);
    }
    schedule();
  }
  function detachAll(hub) {
    for (const s of [...sessions.values()]) if (s.hub === hub && s.kind === 'page') drop(s, true);
    for (const s of [...sessions.values()]) if (s.hub === hub && s.kind === 'child') drop(s, true);
  }
  // The last client left a tab: put back what it changed.
  function undo(hub) {
    const { wc } = hub;
    if (wc.isDestroyed()) return;
    const send = (method, params) => wc.debugger.sendCommand(method, params).catch(() => {});
    for (const applied of hub.applied) if (UNDO[applied]) send(...UNDO[applied]);
    for (const identifier of hub.scripts) send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    // A domain left enabled would not report its state to the next client that enables it (Runtime's
    // execution contexts), so each one a client turned on is turned off again.
    for (const [sid, scope] of hub.scopes) {
      for (const domain of scope.enabled) wc.debugger.sendCommand(domain === 'lifecycle' ? 'Page.setLifecycleEventsEnabled' : `${domain}.disable`, domain === 'lifecycle' ? { enabled: false } : {}, sid || undefined).catch(() => {});
      scope.enabled.clear();
      scope.contexts.clear();
      scope.runtimeOn = false;
    }
    hub.applied.clear();
    hub.scripts.clear();
    hub.fetchOwner = null;
  }

  // ---- commands
  async function browserCommand(s, method, params) {
    switch (method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3', product: `Chrome/${versions.chrome}`, revision: `@${versions.chrome}`,
          userAgent: userAgent() || `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versions.chrome} Safari/537.36`, jsVersion: versions.v8,
        };
      case 'Browser.close': return {};
      // Playwright sends this when a client connects. Downloads stay in Lumen's own download manager
      // (nothing here can rename them or report them to the client), so "allow" is accepted as it is
      // and "deny" is refused rather than pretended.
      case 'Browser.setDownloadBehavior':
        if (params.behavior === 'deny') throw Object.assign(new Error('Blocking downloads is not available in Lumen\'s automation backend.'), { code: -32601 });
        return {};
      case 'Target.attachToBrowserTarget': {
        const b = { id: sessionId(), kind: 'browser', autoAttach: false, discover: false };
        sessions.set(b.id, b);
        schedule();
        return { sessionId: b.id };
      }
      case 'Target.getTargets':
        await refresh();
        return { targetInfos: [...known.entries()].map(([id, e]) => infoOf(id, e.wc)) };
      case 'Target.getBrowserContexts': return { browserContextIds: [] };
      case 'Target.getTargetInfo': {
        await refresh();
        if (!params.targetId || params.targetId === BROWSER_TARGET) return { targetInfo: { targetId: BROWSER_TARGET, type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
        const entry = known.get(params.targetId);
        if (!entry) throw new Error('No target with given id found');
        return { targetInfo: infoOf(params.targetId, entry.wc) };
      }
      case 'Target.setDiscoverTargets':
        await refresh();
        if (s) {
          s.discover = Boolean(params.discover);
          if (s.discover) queueMicrotask(() => { for (const [id, e] of known) event('Target.targetCreated', { targetInfo: infoOf(id, e.wc) }, s.id); });
        }
        return {};
      case 'Target.setAutoAttach':
      case 'Target.autoAttachRelated':
        await refresh();
        if (s) {
          s.autoAttach = Boolean(params.autoAttach ?? true);
          if (s.autoAttach) queueMicrotask(() => { for (const id of known.keys()) attachPage(s, id, true); });
        }
        return {};
      case 'Target.attachToTarget': {
        await refresh();
        const target = known.get(params.targetId);
        if (!target) throw new Error('No target with given id found');
        const page = attachPage(s, params.targetId, s ? true : 'silent');
        if (!page) throw new Error('Could not attach to the target.');
        return { sessionId: page.id };
      }
      case 'Target.detachFromTarget': {
        const victim = sessions.get(params.sessionId);
        if (!victim) throw new Error('No session with given id');
        drop(victim, true);
        return {};
      }
      default: throw Object.assign(new Error(unavailable(method).message), { code: -32601 });
    }
  }

  async function tabCommand(s, method, params) {
    if (s.wc.isDestroyed()) throw new Error('Target closed.');
    switch (method) {
      case 'Target.setAutoAttach':
        s.autoAttach = Boolean(params.autoAttach);
        if (s.autoAttach) {
          queueMicrotask(() => {
            for (const [sid, child] of s.hub.children) if (child.parent === s.sid) attachChild(s, sid, child, false);
          });
        }
        return {};
      case 'Target.getTargetInfo':
        if (s.kind === 'page') return { targetInfo: infoOf(s.targetId, s.wc) };
        return { targetInfo: { ...s.hub.children.get(s.sid)?.targetInfo, attached: true } };
      case 'Target.detachFromTarget': {
        const victim = sessions.get(params.sessionId);
        if (!victim || victim.parent !== s.id) throw new Error('No session with given id');
        drop(victim, true);
        return {};
      }
      case 'Runtime.runIfWaitingForDebugger':
        if (s.kind === 'page') return {}; // a tab is never paused here
        break;
      default:
    }
    const verdict = tabCommandFilter(method);
    if (verdict.error) throw Object.assign(new Error(verdict.error.message), { code: verdict.error.code });
    const scope = scopeOf(s.hub, s.sid);
    // Runtime reports the execution contexts that exist only when it is switched on; with one debugger
    // session per tab, a second client's enable would report nothing. So it is answered from what the
    // first enable reported (kept up to date from the events), and only the first one reaches Chromium.
    if (method === 'Runtime.enable') {
      s.runtime = true;
      if (scope.runtimeOn) {
        // Chromium reports contexts after the answers to the commands sent before (a client builds its
        // frames from Page.getFrameTree first), so the replay waits for those answers too.
        const earlier = [...s.inflight]; // (this command is added to it only after it returns its promise)
        await Promise.race([Promise.allSettled(earlier), new Promise((r) => setTimeout(r, 1500))]);
        for (const p of scope.contexts.values()) event('Runtime.executionContextCreated', p, s.id);
        return {};
      }
      scope.runtimeOn = true;
      scope.contexts.clear();
    }
    if (method === 'Runtime.disable') {
      s.runtime = false;
      if ([...sessions.values()].some((o) => o !== s && o.hub === s.hub && o.sid === s.sid && o.runtime)) return {};
      scope.runtimeOn = false;
    }
    // Interception is one setting per tab: a second client can't have its own.
    if (method === 'Fetch.enable') {
      if (s.hub.fetchOwner && s.hub.fetchOwner !== s.id && sessions.has(s.hub.fetchOwner)) throw new Error('Request interception on this tab is in use by another client.');
      s.hub.fetchOwner = s.id;
    }
    if (method === 'Fetch.disable' && s.hub.fetchOwner === s.id) s.hub.fetchOwner = null;
    const result = await s.wc.debugger.sendCommand(method, params, s.sid || undefined);
    const domain = /^(\w+)\.enable$/.exec(method)?.[1];
    if (domain && !NOT_UNDONE.has(domain)) scope.enabled.add(domain);
    if (method === 'Page.setLifecycleEventsEnabled') { if (params.enabled) scope.enabled.add('lifecycle'); else scope.enabled.delete('lifecycle'); }
    if (s.kind === 'page') {
      if (UNDO[method]) s.hub.applied.add(method);
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && result?.identifier) s.hub.scripts.add(result.identifier);
    }
    return result;
  }

  up.send = (msg) => {
    const { id, method, params = {}, sessionId: sid } = msg;
    const s = sid ? sessions.get(sid) : null;
    if (sid && !s) { reply(id, sid, null, { code: -32001, message: 'Session with given id not found.' }); return; }
    const run = !s || s.kind === 'browser' ? browserCommand(s, method, params) : tabCommand(s, method, params);
    if (s?.inflight) { s.inflight.add(run); run.then(() => s.inflight.delete(run), () => s.inflight.delete(run)); }
    run.then((result) => reply(id, sid, result), (err) => reply(id, sid, null, { code: err.code || -32000, message: String(err.message || err) }));
  };
  up.refresh = refresh;
  up.track = (wc) => { try { hubOf(wc); } catch {} };
  up.sessionCount = () => sessions.size;
  up.close = () => { closed = true; if (timer) clearInterval(timer); timer = null; sessions.clear(); };
  return up;
}

module.exports = { inprocUpstream, tabCommandFilter, UNDO, BROWSER_TARGET };
