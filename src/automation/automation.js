// Automation tools over the Chrome DevTools Protocol (opt-in, off by default).
//
// With the setting on, a filtering proxy listens on 127.0.0.1:<port> (default 9222). Every proxy URL
// starts with a secret token (http://127.0.0.1:<port>/<token>, shown in Settings), so knowing the
// port isn't enough. Playwright's connectOverCDP, Playwright MCP (--cdp-endpoint) and other CDP
// tools connect to the proxy, which:
// - shows only the user's tabs: Lumen's own UI, hidden reader tabs and
//   extension pages are filtered out of every target list and event, and can't be attached to;
// - turns Target.createTarget (Playwright's newPage) into a real Lumen tab, Target.closeTarget
//   into closing that tab, and ignores Browser.close (disconnecting never quits Lumen);
// - reports connects and disconnects, so the sidebar shows "Lumen is being driven by …".
//
// Behind the proxy is one CDP connection to Chromium, shared by every client (multiplexer below):
// on Windows and Linux a pipe that only launcher.js holds the other end of, on macOS no connection
// at all (cdp-inproc.js answers from the tabs' own debuggers, since a launcher there would lose
// open-url events). Either way nothing else on the computer can reach Chromium's DevTools.
// Only in test runs under Playwright (why: launcher.js) is it Chromium's own
// debugging port on a random localhost port, which can't be locked:
// it has no authentication, and a local program that finds it gets everything, Lumen's own UI
// included. There the proxy reads DevToolsActivePort as soon as Chromium writes it and deletes it,
// and never hands out the port or the browser endpoint's id, so finding it takes a port scan.

const fs = require('fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const OWN_ID_BASE = 1e9; // ids for commands the proxy sends itself; clients count up from 1

// The debugging switches themselves are set before ready by prepareAutomation (features/ai-agents.js).

// Chromium writes "<port>\n<browser ws path>" once the debugging server is up.
async function internalEndpoint(file) {
  for (let i = 0; i < 100; i++) {
    try {
      const [port, wsPath] = fs.readFileSync(file, 'utf8').split('\n');
      if (port && wsPath) return { port: Number(port), wsPath: wsPath.trim() };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chromium did not open its debugging port.');
}

// ---------------------------------------------------------------- minimal WebSocket server side

function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

function encodeFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

// Wraps an upgraded socket: onMessage(text), onClose(); returns { send(text), close() }.
function serverSocket(socket, { onMessage, onClose }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.end(encodeFrame(Buffer.alloc(0), 8)); } catch {}
    setTimeout(() => socket.destroy(), 200);
    onClose();
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = buffer[0] & 0x80;
      const opcode = buffer[0] & 0x0f;
      const masked = buffer[1] & 0x80;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + len) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buffer[maskOffset + (i % 4)];
      buffer = buffer.subarray(offset + len);
      if (opcode === 8) { close(); return; }
      if (opcode === 9) { socket.write(encodeFrame(payload, 10)); continue; }
      if (opcode === 10) continue;
      fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        onMessage(text);
      }
    }
  });
  socket.on('end', close); // a client that goes away without a close frame
  socket.on('close', () => { if (!closed) { closed = true; onClose(); } });
  socket.on('error', () => {});
  return {
    send: (text) => { if (!closed) socket.write(encodeFrame(text)); },
    close,
  };
}

function upgrade(req, socket) {
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
    '', '',
  ].join('\r\n'));
}

// ---------------------------------------------------------------- the connection to Chromium

// Each is { ready: Promise, send(msg), onMessage(text), onClose() }: one browser-level connection.

// The launcher's pipe (launcher.js): NUL-terminated JSON, the same as Chromium's own pipe.
function pipeUpstream(fd) {
  const up = { onMessage() {}, onClose() {} };
  let socket;
  try {
    socket = new net.Socket({ fd, readable: true, writable: true });
  } catch (err) {
    up.ready = Promise.reject(new Error(`Chromium's debugging pipe is not connected (${err.message}).`));
    return up;
  }
  up.ready = Promise.resolve();
  up.send = (msg) => socket.write(`${JSON.stringify(msg)}\0`);
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\0')) >= 0; buffer = buffer.slice(end + 1)) up.onMessage(buffer.slice(0, end));
  });
  socket.on('close', () => up.onClose());
  socket.on('error', () => {});
  return up;
}

// Chromium's port (test runs): its browser endpoint, read once from DevToolsActivePort,
// after which the file is taken away from anyone else.
function portUpstream(file) {
  const up = { onMessage() {}, onClose() {} };
  up.ready = internalEndpoint(file).then(({ port, wsPath }) => new Promise((resolve, reject) => {
    try { fs.rmSync(file, { force: true }); } catch {}
    const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    up.send = (msg) => ws.send(JSON.stringify(msg));
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Could not connect to Chromium.'));
    ws.onmessage = (e) => up.onMessage(String(e.data));
    ws.onclose = () => up.onClose();
  }));
  return up;
}

// Shares one connection among clients: each gets its own session (on the browser for the browser
// endpoint, on one tab for a page endpoint) and sees only the sessions it opened, with its own ids.
// open(targetId | null) -> { send(text), close(), onMessage(text), onClose() }.
function multiplexer(up) {
  let nextId = 1;
  const pending = new Map(); // upstream id -> { conn, id } for a client's command, { resolve } for ours
  const owners = new Map(); // sessionId -> the client it belongs to
  const roots = new Map(); // a client's own session -> the client
  const ready = up.ready;
  ready.catch(() => {});
  let lost = false;
  const send = (msg) => ready.then(() => up.send(msg));
  // Our own commands; resolves with Chromium's whole reply ({ result } or { error }).
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (lost) { reject(new Error('Lost the connection to Chromium.')); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params, ...(sessionId ? { sessionId } : {}) }).catch(reject);
  });

  function finish(conn, notify) {
    if (conn.closed) return;
    conn.closed = true;
    for (const [sessionId, owner] of owners) if (owner === conn) owners.delete(sessionId);
    roots.delete(conn.root);
    if (notify) conn.onClose();
    else if (conn.root) call('Target.detachFromTarget', { sessionId: conn.root }).catch(() => {});
  }
  function deliver(conn, msg) {
    if (conn.closed) return;
    if (msg.sessionId === conn.root) delete msg.sessionId;
    conn.onMessage(JSON.stringify(msg));
  }

  up.onMessage = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined) {
      const waiting = pending.get(msg.id);
      pending.delete(msg.id);
      if (waiting?.resolve) waiting.resolve(msg);
      else if (waiting) deliver(waiting.conn, { ...msg, id: waiting.id });
      return;
    }
    // Events outside every client's session: only a client's own session going away matters.
    if (!msg.sessionId) {
      if (msg.method === 'Target.detachedFromTarget' && roots.has(msg.params.sessionId)) finish(roots.get(msg.params.sessionId), true);
      return;
    }
    const conn = owners.get(msg.sessionId);
    if (!conn) return;
    if (msg.method === 'Target.attachedToTarget') owners.set(msg.params.sessionId, conn);
    if (msg.method === 'Target.detachedFromTarget') owners.delete(msg.params.sessionId);
    deliver(conn, msg);
  };
  up.onClose = () => {
    lost = true;
    for (const waiting of pending.values()) waiting.reject?.(new Error('Lost the connection to Chromium.'));
    pending.clear();
    for (const conn of [...roots.values()]) finish(conn, true);
  };

  function open(targetId) {
    const conn = { root: null, closed: false, onMessage() {}, onClose() {} };
    const attached = call(targetId ? 'Target.attachToTarget' : 'Target.attachToBrowserTarget', targetId ? { targetId, flatten: true } : {}).then((reply) => {
      const sessionId = reply.result?.sessionId;
      if (!sessionId) throw new Error(reply.error?.message || 'Could not attach.');
      conn.root = sessionId;
      if (conn.closed) { call('Target.detachFromTarget', { sessionId }).catch(() => {}); return; }
      owners.set(sessionId, conn);
      roots.set(sessionId, conn);
    });
    attached.catch(() => finish(conn, true));
    conn.send = (text) => attached.then(() => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (conn.closed) return;
      if (msg.sessionId && owners.get(msg.sessionId) !== conn) {
        deliver(conn, { id: msg.id, sessionId: msg.sessionId, error: { code: -32001, message: 'Session with given id not found.' } });
        return;
      }
      const id = nextId++;
      pending.set(id, { conn, id: msg.id });
      send({ ...msg, id, sessionId: msg.sessionId || conn.root });
    }, () => {});
    conn.close = () => finish(conn, false);
    return conn;
  }

  return { ready, call, open, sync: () => up.refresh?.() };
}

// ---- [ai manners] hands-off mode for the proxy (features/ai-manners.js automationVerdict, via hooks.handsOffVerdict(method, tabId)
// -> { ok } | { noop } | { error }). Pure over its inputs, so test/ai-manners-units.js drives it with fakes.
// The Lumen tab a new session belongs to: a tab's own session, or (a frame / worker) its parent's.
async function sessionTabFor({ parentSession, sessionTab, targetInfo, userTargets }) {
  if (parentSession) return sessionTab.get(parentSession);
  return (await userTargets()).get(targetInfo.targetId);
}
// What an init-time command answered without being run gets as its result.
const noopResult = (method) => (method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: '0' } : {});
// Should this client command run? `sessionId` null: it names no session (a browser-level command). A Target.* command carrying a
// targetId is judged by THAT target's tab on any session (an AI-own-tab session may not close or front a user's tab); every other
// command by its session's tab. A command for no known tab counts as "not the AI's".
async function gateCommand({ method, params = {}, sessionId, sessionTab, userTargets, hooks }) {
  if (!hooks.handsOffVerdict) return { ok: true };
  let tabId = sessionId ? sessionTab.get(sessionId) : undefined;
  if (/^Target\./.test(method) && params.targetId) tabId = (await userTargets()).get(params.targetId);
  return hooks.handsOffVerdict(method, tabId);
}

// The in-process backend (cdp-inproc.js) over the user's tabs. hooks.onContents(cb) calls cb(webContents)
// for every web contents now and later, so a tab's iframes are known from the start.
function inprocBackend(hooks) {
  const { inprocUpstream } = require('./cdp-inproc');
  const up = inprocUpstream({ tabs: hooks.tabs, userAgent: hooks.userAgent });
  hooks.onContents?.((wc) => up.track(wc));
  return up;
}

// ---------------------------------------------------------------- the proxy

// token: the secret every URL starts with.
// hooks: { tabs() -> [{ id, webContents }], openTab(url) -> { id, webContents }, closeTab(id),
//          onSession({ active, remaining }) }
// pipeFd: the launcher's pipe; file: DevToolsActivePort, where there is none (see the top);
// inproc: no Chromium connection at all, cdp-inproc.js answers from the tabs' own debuggers (macOS).
function start({ port, pipeFd, file, inproc, token, hooks }) {
  const targetIds = new WeakMap(); // webContents -> targetId
  const clients = new Set();
  const upstream = inproc ? inprocBackend(hooks) : pipeFd !== undefined ? pipeUpstream(pipeFd) : portUpstream(file);
  const chromium = multiplexer(upstream);
  // Our own command on the browser; throws Chromium's error.
  const command = async (method, params) => {
    const reply = await chromium.call(method, params);
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  };

  async function targetIdOf(wc) {
    if (targetIds.has(wc)) return targetIds.get(wc);
    if (wc.isDestroyed()) return null;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const { targetInfo } = await wc.debugger.sendCommand('Target.getTargetInfo');
      targetIds.set(wc, targetInfo.targetId);
      return targetInfo.targetId;
    } catch {
      return null;
    }
  }

  // targetId -> Lumen tab id, for every open tab.
  async function userTargets() {
    const map = new Map();
    for (const tab of hooks.tabs()) {
      const id = await targetIdOf(tab.webContents);
      if (id) map.set(id, tab.id);
    }
    return map;
  }

  // Is this target one of the user's tabs? New tabs may take a moment to be listed.
  async function isUserTarget(info) {
    if (info.type !== 'page') return false;
    for (let i = 0; i < 5; i++) {
      if ((await userTargets()).has(info.targetId)) return true;
      if (i === 0 && !/^(https?|about|data|blob):/i.test(info.url || '') && info.url) return false; // Lumen's own pages
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  const base = `127.0.0.1:${port}/${token}`; // every URL handed out starts with this
  const BROWSER_PATH = '/devtools/browser'; // not Chromium's own (its id would find the raw port's)
  const localHost = (req) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
  // { url, route }: the request with /<token> taken off, or null without the right token.
  const tokenPath = Buffer.from(`/${token}`);
  const routeOf = (req) => {
    const url = new URL(req.url, 'http://x');
    const given = Buffer.from(url.pathname.slice(0, tokenPath.length));
    const route = url.pathname.slice(tokenPath.length);
    if (given.length !== tokenPath.length || !crypto.timingSafeEqual(given, tokenPath) || (route && route[0] !== '/')) return null;
    return { url, route: route.replace(/\/$/, '') };
  };
  const NO_TOKEN = 'Wrong or missing token: use the full address from Lumen’s Settings (Advanced → Automation → Allow automation tools).';
  // /json/list, the way Chromium's own port answers it, for the user's tabs.
  async function listPages() {
    const users = await userTargets();
    const { targetInfos } = await command('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page' && users.has(t.targetId)).map((t) => ({
      description: '', id: t.targetId, title: t.title, type: t.type, url: t.url,
      webSocketDebuggerUrl: `ws://${base}/devtools/page/${t.targetId}`,
    }));
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    };
    // Only local tools, not web pages: a page fetching localhost sends an Origin header, and a
    // DNS-rebinding page a foreign Host.
    if (req.headers.origin || !localHost(req)) return send(403, { error: 'Only local tools may connect.' });
    const routed = routeOf(req);
    if (!routed) return send(401, { error: NO_TOKEN });
    try {
      const { url, route } = routed;
      if (route === '/json/version') {
        const version = await command('Browser.getVersion');
        return send(200, {
          Browser: `Lumen/${version.product?.split('/')[1] || ''}`.replace(/\/$/, ''),
          'Protocol-Version': version.protocolVersion,
          'User-Agent': version.userAgent,
          'V8-Version': version.jsVersion,
          'WebKit-Version': `537.36 (${version.revision})`,
          webSocketDebuggerUrl: `ws://${base}${BROWSER_PATH}`,
        });
      }
      if (route === '/json' || route === '/json/list') return send(200, await listPages());
      if (route === '/json/new') {
        if (req.method !== 'PUT') return send(405, { error: 'Use PUT' });
        const target = decodeURIComponent(url.search.slice(1)) || 'about:blank';
        const tab = hooks.openTab(target, { background: true }); // behind the user's tab, unless a client asks otherwise (Target.createTarget)
        const id = await targetIdOf(tab.webContents);
        const page = (await listPages()).find((t) => t.id === id);
        return send(200, page || { id });
      }
      const m = /^\/json\/(close|activate)\/(.+)$/.exec(route);
      if (m) {
        const tabId = (await userTargets()).get(m[2]);
        if (!tabId) return send(404, { error: 'No such tab' });
        if (hooks.handsOffVerdict?.(m[1] === 'close' ? 'Target.closeTarget' : 'Target.activateTarget', tabId)?.error) return send(403, { error: 'Hands-off mode is on: the AI may not close or front a tab it did not open.' });
        if (m[1] === 'close') hooks.closeTab(tabId);
        else hooks.switchTab?.(tabId);
        return send(200, m[1] === 'close' ? 'Target is closing' : 'Target activated');
      }
      send(404, { error: 'Not found' });
    } catch (err) {
      send(500, { error: String(err.message || err) });
    }
  });

  server.on('upgrade', async (req, socket) => {
    socket.on('error', () => {});
    try {
      if ((req.headers.origin && !/^(devtools|chrome-devtools):/.test(req.headers.origin)) || !localHost(req)) throw new Error('origin');
      const routed = routeOf(req);
      if (!routed) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
      await chromium.ready;
      if (routed.route === BROWSER_PATH) return browserClient(req, socket);
      const page = /^\/devtools\/page\/(.+)$/.exec(routed.route);
      const pageTab = page ? (await userTargets()).get(page[1]) : undefined;
      if (page && pageTab !== undefined) return pageClient(req, socket, page[1], pageTab);
      throw new Error('target');
    } catch {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    }
  });

  const announce = () => hooks.onSession?.({ remaining: clients.size });

  // Page endpoints are one tab only: pass messages straight through.
  function pageClient(req, socket, targetId, tabId) {
    const upstream = chromium.open(targetId);
    let client;
    const entry = { close: () => client.close() };
    upstream.onMessage = (text) => client.send(text);
    upstream.onClose = () => client.close();
    upgrade(req, socket);
    client = serverSocket(socket, {
      onMessage: (text) => {
        // [ai manners] hands-off mode: an act on a tab the AI did not open is answered with an error instead of reaching the page
        let msg = null;
        try { msg = JSON.parse(text); } catch {}
        const verdict = msg && typeof msg.method === 'string' ? hooks.handsOffVerdict?.(msg.method, tabId) : null;
        if (verdict?.error) { client.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: verdict.error } })); return; }
        if (verdict?.noop) { client.send(JSON.stringify({ id: msg.id, result: noopResult(msg.method) })); return; }
        upstream.send(text);
      },
      onClose: () => { upstream.close(); if (clients.delete(entry)) announce(); },
    });
    clients.add(entry);
    hooks.onSession?.({ active: true, remaining: clients.size });
  }

  // The browser endpoint: filter targets, sessions and a few commands.
  function browserClient(req, socket) {
    const upstream = chromium.open(null);
    const allowedSessions = new Set(); // sessions of user tabs (and their frames/workers)
    const sessionTab = new Map(); // sessionId -> Lumen tab id (a frame or worker has its tab's)
    const heldSessions = new Map(); // sessionId -> messages waiting for the tab check
    const knownTargets = new Set(); // user targets this client was told about
    const attachWaiters = new Map(); // targetId -> resolve, for createTarget replies
    let autoAttaching = false;
    let ownId = OWN_ID_BASE;
    let client;
    const entry = { close: () => client.close() };

    const toUpstream = (msg) => upstream.send(JSON.stringify(msg));
    const reply = (id, sessionId, result, error) => client.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), ...(error ? { error: { code: -32000, message: error } } : { result }) }));
    const own = (method, params, sessionId) => toUpstream({ id: ownId++, method, params, ...(sessionId ? { sessionId } : {}) });

    async function onAttached(msg) {
      const { sessionId, targetInfo, waitingForDebugger } = msg.params;
      // Children of a user tab (its iframes and workers) come in on the tab's own session.
      const parentOk = msg.sessionId && allowedSessions.has(msg.sessionId);
      heldSessions.set(sessionId, []);
      const ok = parentOk || (!msg.sessionId && await isUserTarget(targetInfo));
      const held = heldSessions.get(sessionId) || [];
      heldSessions.delete(sessionId);
      if (ok) {
        allowedSessions.add(sessionId);
        sessionTab.set(sessionId, await sessionTabFor({ parentSession: parentOk ? msg.sessionId : null, sessionTab, targetInfo, userTargets }));
        knownTargets.add(targetInfo.targetId);
        client.send(JSON.stringify(msg));
        for (const m of held) client.send(m);
        attachWaiters.get(targetInfo.targetId)?.();
      } else {
        // Not ours to see: let it run and let go of it.
        if (waitingForDebugger) own('Runtime.runIfWaitingForDebugger', {}, sessionId);
        own('Target.detachFromTarget', { sessionId }, msg.sessionId);
      }
    }

    function fromUpstream(text) {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id >= OWN_ID_BASE) return; // answers to our own commands
      if (msg.sessionId && heldSessions.has(msg.sessionId)) { heldSessions.get(msg.sessionId).push(text); return; }
      if (msg.method === 'Target.attachedToTarget') { onAttached(msg); return; }
      if (msg.sessionId && !allowedSessions.has(msg.sessionId)) return;
      switch (msg.method) {
        case 'Target.detachedFromTarget':
          if (!allowedSessions.delete(msg.params.sessionId)) return;
          break;
        case 'Target.targetCreated':
        case 'Target.targetInfoChanged':
          if (msg.sessionId) break;
          if (!knownTargets.has(msg.params.targetInfo.targetId)) {
            isUserTarget(msg.params.targetInfo).then((ok) => {
              if (!ok) return;
              knownTargets.add(msg.params.targetInfo.targetId);
              client.send(text);
            });
            return;
          }
          break;
        case 'Target.targetDestroyed':
        case 'Target.targetCrashed':
          if (!msg.sessionId && !knownTargets.delete(msg.params.targetId)) return;
          break;
        default:
      }
      if (msg.result?.targetInfos) {
        userTargets().then((users) => {
          msg.result.targetInfos = msg.result.targetInfos.filter((t) => users.has(t.targetId));
          client.send(JSON.stringify(msg));
        });
        return;
      }
      client.send(text);
    }

    async function fromClient(text) {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      const { id, method, params = {}, sessionId } = msg;
      if (typeof id !== 'number' || id >= OWN_ID_BASE) return reply(id, sessionId, null, 'Invalid message id.');
      if (sessionId && !allowedSessions.has(sessionId)) return reply(id, sessionId, null, 'No such session.');
      if (sessionId) { // commands to a user tab go straight through (unless hands-off mode holds back an act on a tab the AI did not open)
        const gate = await gateCommand({ method, params, sessionId, sessionTab, userTargets, hooks });
        if (gate.error) return reply(id, sessionId, null, gate.error);
        if (gate.noop) return reply(id, sessionId, noopResult(method));
        return toUpstream(msg);
      }
      switch (method) {
        case 'Target.createTarget': {
          const tab = hooks.openTab(params.url || 'about:blank', { background: params.background === undefined ? true : Boolean(params.background) }); // behind the user's tab unless the client says otherwise
          const targetId = await targetIdOf(tab.webContents);
          if (!targetId) return reply(id, null, null, 'Could not open a tab.');
          chromium.sync(); // the in-process backend learns of the tab now, not at its next look
          // Like Chrome, answer only after the client has been told about (auto-attached to) the tab.
          if (autoAttaching && !knownTargets.has(targetId)) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 5000);
              attachWaiters.set(targetId, () => { clearTimeout(timer); attachWaiters.delete(targetId); resolve(); });
            });
          }
          return reply(id, null, { targetId });
        }
        case 'Target.closeTarget': {
          const tabId = (await userTargets()).get(params.targetId);
          if (!tabId) return reply(id, null, null, 'No target with given id found');
          { const gate = await gateCommand({ method, params, sessionId: null, sessionTab, userTargets, hooks }); if (gate.error) return reply(id, null, null, gate.error); }
          hooks.closeTab(tabId);
          return reply(id, null, { success: true });
        }
        case 'Target.activateTarget': {
          const tabId = (await userTargets()).get(params.targetId);
          if (!tabId) return reply(id, null, null, 'No target with given id found');
          { const gate = await gateCommand({ method, params, sessionId: null, sessionTab, userTargets, hooks }); if (gate.error) return reply(id, null, null, gate.error); }
          hooks.switchTab?.(tabId);
          return reply(id, null, {});
        }
        case 'Target.attachToTarget':
        case 'Target.getTargetInfo':
        case 'Target.autoAttachRelated':
          if (params.targetId && !(await userTargets()).has(params.targetId)) return reply(id, null, null, 'No target with given id found');
          break;
        case 'Target.detachFromTarget':
          if (params.sessionId && !allowedSessions.has(params.sessionId)) return reply(id, null, null, 'No session with given id');
          break;
        case 'Target.setAutoAttach':
          autoAttaching = Boolean(params.autoAttach);
          break;
        case 'Browser.close':
          // Disconnecting never quits the user's browser.
          reply(id, null, {});
          setTimeout(() => client.close(), 50);
          return;
        case 'Browser.crash':
        case 'Browser.crashGpuProcess':
        case 'Target.attachToBrowserTarget':
        case 'Target.exposeDevToolsProtocol':
        case 'Target.sendMessageToTarget':
          return reply(id, null, null, `${method} is not available in Lumen.`);
        default:
      }
      { // a command that names no tab (storage, browser settings, contexts...): in hands-off mode only reads go through
        const gate = await gateCommand({ method, params, sessionId: null, sessionTab, userTargets, hooks });
        if (gate.error) return reply(id, null, null, gate.error);
        if (gate.noop) return reply(id, null, noopResult(method));
      }
      toUpstream(msg);
    }

    upstream.onMessage = fromUpstream;
    upstream.onClose = () => client.close();
    upgrade(req, socket);
    client = serverSocket(socket, {
      onMessage: (text) => { fromClient(text).catch(() => {}); },
      onClose: () => { upstream.close(); if (clients.delete(entry)) announce(); },
    });
    clients.add(entry);
    hooks.onSession?.({ active: true, remaining: clients.size });
  }

  const state = { port, listening: false, error: null };
  chromium.ready.catch((err) => { state.error = String(err.message); });
  server.on('error', (err) => { state.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : String(err.message); });
  server.listen(port, '127.0.0.1', () => { state.listening = true; });
  return {
    state,
    disconnectAll: () => { for (const c of [...clients]) c.close(); },
    clients: () => clients.size,
    close: () => { for (const c of [...clients]) c.close(); server.close(); upstream.close?.(); },
  };
}

module.exports = { start, gateCommand, sessionTabFor, noopResult };
