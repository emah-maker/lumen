// Automation tools over the Chrome DevTools Protocol (opt-in, off by default).
//
// With the setting on, Chromium's own debugging port is opened on a random localhost port and a
// filtering proxy listens on 127.0.0.1:<port> (default 9222). Playwright's connectOverCDP,
// Playwright MCP (--cdp-endpoint) and other CDP tools connect to the proxy, which:
// - shows only the user's tabs: Lumen's own UI, the AI side panels, hidden reader tabs and
//   extension pages are filtered out of every target list and event, and can't be attached to;
// - turns Target.createTarget (Playwright's newPage) into a real Lumen tab, Target.closeTarget
//   into closing that tab, and ignores Browser.close (disconnecting never quits Lumen);
// - reports connects and disconnects, so the sidebar shows "Lumen is being driven by …".

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORT = 9222;
const OWN_ID_BASE = 1e9; // ids for commands the proxy sends itself; clients count up from 1

const validPort = (port) => (Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT);

// Called at startup, before the app is ready: the debugging switch only works if set this early.
function prepare(app, settings) {
  if (!settings.automationEnabled) return null;
  const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
  try { fs.rmSync(file, { force: true }); } catch {}
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  return { port: validPort(settings.automationPort), file };
}

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

// ---------------------------------------------------------------- the proxy

// hooks: { tabs() -> [{ id, webContents }], openTab(url) -> { id, webContents }, closeTab(id),
//          onSession({ active, remaining }) }
function start({ port, file, hooks }) {
  const targetIds = new WeakMap(); // webContents -> targetId
  const clients = new Set();
  let internal = null;

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

  const hostOf = () => `127.0.0.1:${port}`;
  const localHost = (req) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
  const fetchJson = async (p) => (await fetch(`http://127.0.0.1:${internal.port}${p}`)).json();
  const rewrite = (req, t) => ({
    ...t,
    webSocketDebuggerUrl: t.webSocketDebuggerUrl?.replace(/ws:\/\/[^/]+/, `ws://${hostOf(req)}`),
    devtoolsFrontendUrl: undefined,
  });

  async function listPages(req) {
    const users = await userTargets();
    const list = await fetchJson('/json/list');
    return list.filter((t) => t.type === 'page' && users.has(t.id)).map((t) => rewrite(req, t));
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    };
    // Only local tools, not web pages: a page fetching localhost sends an Origin header, and a
    // DNS-rebinding page a foreign Host.
    if (req.headers.origin || !localHost(req)) return send(403, { error: 'Only local tools may connect.' });
    try {
      if (!internal) internal = await internalEndpoint(file);
      const url = new URL(req.url, 'http://x');
      const route = url.pathname.replace(/\/$/, '');
      if (route === '/json/version') {
        const version = await fetchJson('/json/version');
        return send(200, { ...version, Browser: `Lumen/${version.Browser?.split('/')[1] || ''}`.replace(/\/$/, ''), webSocketDebuggerUrl: `ws://${hostOf(req)}${internal.wsPath}` });
      }
      if (route === '/json' || route === '/json/list') return send(200, await listPages(req));
      if (route === '/json/protocol') return send(200, await fetchJson('/json/protocol'));
      if (route === '/json/new') {
        if (req.method !== 'PUT') return send(405, { error: 'Use PUT' });
        const target = decodeURIComponent(url.search.slice(1)) || 'about:blank';
        const tab = hooks.openTab(target);
        const id = await targetIdOf(tab.webContents);
        const page = (await listPages(req)).find((t) => t.id === id);
        return send(200, page || { id });
      }
      const m = /^\/json\/(close|activate)\/(.+)$/.exec(route);
      if (m) {
        const tabId = (await userTargets()).get(m[2]);
        if (!tabId) return send(404, { error: 'No such tab' });
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
      if (!internal) internal = await internalEndpoint(file);
      const pathname = new URL(req.url, 'http://x').pathname;
      if (pathname === internal.wsPath) return browserClient(req, socket);
      const page = /^\/devtools\/page\/(.+)$/.exec(pathname);
      if (page && (await userTargets()).has(page[1])) return pageClient(req, socket, pathname);
      throw new Error('target');
    } catch {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    }
  });

  const announce = () => hooks.onSession?.({ remaining: clients.size });

  // Page endpoints are one tab only: pass messages straight through.
  function pageClient(req, socket, pathname) {
    const upstream = new WebSocket(`ws://127.0.0.1:${internal.port}${pathname}`);
    const queue = [];
    let client;
    const entry = { close: () => client.close() };
    upstream.onopen = () => { for (const m of queue.splice(0)) upstream.send(m); };
    upstream.onmessage = (e) => client.send(String(e.data));
    upstream.onclose = () => client.close();
    upgrade(req, socket);
    client = serverSocket(socket, {
      onMessage: (text) => (upstream.readyState === 1 ? upstream.send(text) : queue.push(text)),
      onClose: () => { try { upstream.close(); } catch {} if (clients.delete(entry)) announce(); },
    });
    clients.add(entry);
    hooks.onSession?.({ active: true, remaining: clients.size });
  }

  // The browser endpoint: filter targets, sessions and a few commands.
  function browserClient(req, socket) {
    const upstream = new WebSocket(`ws://127.0.0.1:${internal.port}${internal.wsPath}`);
    const queue = [];
    const allowedSessions = new Set(); // sessions of user tabs (and their frames/workers)
    const heldSessions = new Map(); // sessionId -> messages waiting for the tab check
    const knownTargets = new Set(); // user targets this client was told about
    const attachWaiters = new Map(); // targetId -> resolve, for createTarget replies
    let autoAttaching = false;
    let ownId = OWN_ID_BASE;
    let client;
    const entry = { close: () => client.close() };

    const toUpstream = (msg) => {
      const text = JSON.stringify(msg);
      if (upstream.readyState === 1) upstream.send(text); else queue.push(text);
    };
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
      if (sessionId) return toUpstream(msg); // commands to a user tab go straight through
      switch (method) {
        case 'Target.createTarget': {
          const tab = hooks.openTab(params.url || 'about:blank', { background: Boolean(params.background) });
          const targetId = await targetIdOf(tab.webContents);
          if (!targetId) return reply(id, null, null, 'Could not open a tab.');
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
          hooks.closeTab(tabId);
          return reply(id, null, { success: true });
        }
        case 'Target.activateTarget': {
          const tabId = (await userTargets()).get(params.targetId);
          if (!tabId) return reply(id, null, null, 'No target with given id found');
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
      toUpstream(msg);
    }

    upstream.onopen = () => { for (const m of queue.splice(0)) upstream.send(m); };
    upstream.onmessage = (e) => fromUpstream(String(e.data));
    upstream.onclose = () => client.close();
    upstream.onerror = () => {};
    upgrade(req, socket);
    client = serverSocket(socket, {
      onMessage: (text) => { fromClient(text).catch(() => {}); },
      onClose: () => { try { upstream.close(); } catch {} if (clients.delete(entry)) announce(); },
    });
    clients.add(entry);
    hooks.onSession?.({ active: true, remaining: clients.size });
  }

  const state = { port, listening: false, error: null };
  server.on('error', (err) => { state.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : String(err.message); });
  server.listen(port, '127.0.0.1', () => { state.listening = true; });
  return {
    state,
    disconnectAll: () => { for (const c of [...clients]) c.close(); },
    clients: () => clients.size,
    close: () => { for (const c of [...clients]) c.close(); server.close(); },
  };
}

module.exports = { prepare, start, DEFAULT_PORT, validPort };
