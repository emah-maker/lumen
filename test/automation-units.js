// The Automation (CDP) proxy under hands-off mode, over real localhost sockets but with no Electron and no Chromium: automation.js start() is
// given a stand-in for its upstream (the multiplexer), fake tabs and the real hands-off rule (features/ai-manners.js). A WebSocket client plays
// Playwright; the "upstream" is told what Chromium would say (attachedToTarget ...) and records what reaches it.
const net = require('net');
const M = require('../src/features/ai-manners');
const { start } = require('../src/automation/automation');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  const port = await freePort();
  const token = 'tok123';
  const state = { handsOff: true, ai: new Set([2, 3]) };
  const fakeWc = (target) => ({ isDestroyed: () => false, debugger: { isAttached: () => true, attach() {}, sendCommand: async () => ({ targetInfo: { targetId: target } }) } });
  const tabs = new Map([[1, { id: 1, webContents: fakeWc('t1') }], [2, { id: 2, webContents: fakeWc('t2') }]]); // 1: the user's, 2: opened by the AI
  const opened = [];
  const hooks = {
    tabs: () => [...tabs.values()],
    openTab: (url, options) => { const tab = { id: 3, webContents: fakeWc('t3') }; tabs.set(3, tab); opened.push({ url, options }); return tab; },
    closeTab: (id) => { tabs.delete(id); },
    switchTab: () => {},
    onSession: () => {},
    handsOffVerdict: (method, tabId) => M.automationVerdict({ method, handsOff: state.handsOff, ownTab: state.ai.has(tabId) }),
  };
  // The stand-in for the multiplexer: open(targetId | null) -> a connection we can watch and speak through.
  const conns = [];
  const chromium = { ready: Promise.resolve(), sync() {}, call: async () => ({ result: {} }), open(targetId) { const c = { targetId, sent: [], send(text) { c.sent.push(JSON.parse(text)); }, close() {}, onMessage() {}, onClose() {} }; conns.push(c); return c; } };
  const proxy = start({ port, token, hooks, chromium });
  await sleep(100);

  const connect = (path) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${token}${path}`);
    const inbox = [];
    ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
    ws.onopen = () => resolve({ ws, inbox });
    ws.onerror = () => reject(new Error(`could not connect to ${path}`));
  });
  const ask = async (c, msg) => { const before = c.inbox.length; c.ws.send(JSON.stringify(msg)); for (let i = 0; i < 40; i++) { const hit = c.inbox.slice(before).find((m) => m.id === msg.id); if (hit) return hit; await sleep(25); } return null; };
  const refused = (r) => Boolean(r?.error && /Hands-off mode/.test(r.error.message));

  const b = await connect('/devtools/browser');
  const conn = conns.find((c) => c.targetId === null);
  const attach = async (sessionId, targetId, parent, type = 'page') => {
    conn.onMessage(JSON.stringify({ method: 'Target.attachedToTarget', ...(parent ? { sessionId: parent } : {}), params: { sessionId, waitingForDebugger: false, targetInfo: { targetId, type, url: 'http://example.test/' } } }));
    await sleep(60);
  };
  await attach('s1', 't1');
  await attach('s2', 't2');
  await attach('s2f', 'frame-of-ai', 's2', 'iframe');
  await attach('s3', 't1', 's2'); // the AI's session attaches to the USER's tab: the new session must be judged as the user's tab
  check('proxy: the client is told about the sessions it may see', b.inbox.filter((m) => m.method === 'Target.attachedToTarget').length === 4, JSON.stringify(b.inbox.map((m) => m.params?.sessionId)));

  let n = 100;
  const cmd = (sessionId, method, params = {}) => ask(b, { id: ++n, ...(sessionId ? { sessionId } : {}), method, params });
  check('act on the user\'s tab\'s session: refused', refused(await cmd('s1', 'Input.dispatchMouseEvent', { type: 'mousePressed' })));
  check('...and it never reached Chromium', !conn.sent.some((m) => m.sessionId === 's1' && m.method === 'Input.dispatchMouseEvent'));
  const sentBefore = conn.sent.length;
  void cmd('s2', 'Input.dispatchMouseEvent', { type: 'mousePressed' });
  await sleep(100);
  check('act on the AI\'s own tab\'s session: goes through', conn.sent.length === sentBefore + 1 && conn.sent.at(-1).method === 'Input.dispatchMouseEvent' && conn.sent.at(-1).sessionId === 's2');
  void cmd('s2f', 'Runtime.evaluate', { expression: '1' });
  await sleep(100);
  check('an iframe of the AI\'s tab takes its tab\'s right to act', conn.sent.at(-1).sessionId === 's2f' && conn.sent.at(-1).method === 'Runtime.evaluate');
  check('ESCALATION: a session the AI attached to the user\'s tab is the user\'s tab: Input is refused', refused(await cmd('s3', 'Input.dispatchMouseEvent', { type: 'mousePressed' })) && refused(await cmd('s3', 'Runtime.evaluate', { expression: '1' })));
  void cmd('s1', 'Page.captureScreenshot');
  await sleep(100);
  check('reading the user\'s tab goes through', conn.sent.at(-1).sessionId === 's1' && conn.sent.at(-1).method === 'Page.captureScreenshot');

  const init = await cmd('s1', 'Page.addScriptToEvaluateOnNewDocument', { source: 'x' });
  await sleep(50);
  check('init-time script injection on the user\'s tab: answered, not run', init?.result?.identifier === '0' && !conn.sent.some((m) => m.method === 'Page.addScriptToEvaluateOnNewDocument'));
  check('...with a one-time console warning on the client', b.inbox.filter((m) => m.method === 'Log.entryAdded' && /hands-off/i.test(m.params.entry.text)).length === 1);
  await cmd('s1', 'Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(30);
  check('...and it is said only once', b.inbox.filter((m) => m.method === 'Log.entryAdded').length === 1);

  check('browser-level commands that name no tab are refused', refused(await cmd(null, 'Storage.clearCookies')) && refused(await cmd(null, 'Browser.setDownloadBehavior', { behavior: 'allow' })) && refused(await cmd(null, 'Target.disposeBrowserContext', { browserContextId: 'x' })));
  const unav = await cmd(null, 'Target.exposeDevToolsProtocol', { targetId: 't1' });
  const unavSession = await cmd('s2', 'Target.sendMessageToTarget', { message: '{}' });
  check('Target.exposeDevToolsProtocol / sendMessageToTarget are unavailable, also on a session', /not available/.test(unav?.error?.message || '') && /not available/.test(unavSession?.error?.message || ''));
  check('a session in the AI\'s tab cannot close or front the user\'s tab by target id', refused(await cmd('s2', 'Target.closeTarget', { targetId: 't1' })) && refused(await cmd('s2', 'Target.activateTarget', { targetId: 't1' })) && tabs.has(1));
  check('closeTarget with no session is judged by the target\'s tab', refused(await cmd(null, 'Target.closeTarget', { targetId: 't1' })) && tabs.has(1));

  // createTarget: on the browser or on a session, it opens a background tab through hooks.openTab
  const made = await cmd(null, 'Target.createTarget', { url: 'http://new.test/' });
  check('Target.createTarget opens a tab through the hook, in the background by default', made?.result?.targetId === 't3' && opened.at(-1).options.background === true, JSON.stringify({ made, opened }));
  const made2 = await cmd('s1', 'Target.createTarget', { url: 'http://new2.test/', background: false });
  check('Target.createTarget sent on a session takes the same path (not passed upstream) and honors an explicit background:false', made2?.result?.targetId === 't3' && opened.length === 2 && opened.at(-1).options.background === false && !conn.sent.some((m) => m.method === 'Target.createTarget'), JSON.stringify(made2));

  state.handsOff = false;
  void cmd('s1', 'Input.dispatchMouseEvent', { type: 'mousePressed' });
  await sleep(100);
  check('with hands-off off nothing is held back', conn.sent.at(-1).sessionId === 's1' && conn.sent.at(-1).method === 'Input.dispatchMouseEvent');
  state.handsOff = true;

  // a direct page socket
  const p1 = await connect('/devtools/page/t1');
  const pc1 = conns.find((c) => c.targetId === 't1');
  check('page socket on the user\'s tab: acting refused, reading passes', refused(await ask(p1, { id: 1, method: 'Input.insertText', params: { text: 'x' } })) && !pc1.sent.some((m) => m.method === 'Input.insertText'));
  p1.ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot' }));
  await sleep(100);
  check('...reading passes to the page', pc1.sent.some((m) => m.method === 'Page.captureScreenshot'));
  check('page socket: Target.sendMessageToTarget / exposeDevToolsProtocol are unavailable', /not available/.test((await ask(p1, { id: 3, method: 'Target.sendMessageToTarget', params: {} }))?.error?.message || ''));
  const noop = await ask(p1, { id: 4, method: 'Page.addScriptToEvaluateOnNewDocument', params: {} });
  check('page socket: init-time injection is answered, not run', noop?.result?.identifier === '0' && !pc1.sent.some((m) => m.method === 'Page.addScriptToEvaluateOnNewDocument'));
  const p2 = await connect('/devtools/page/t2');
  p2.ws.send(JSON.stringify({ id: 1, method: 'Input.insertText', params: { text: 'x' } }));
  await sleep(100);
  check('page socket on the AI\'s own tab: acting passes', conns.find((c) => c.targetId === 't2').sent.some((m) => m.method === 'Input.insertText'));

  b.ws.close(); p1.ws.close(); p2.ws.close();
  proxy.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
