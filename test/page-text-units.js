// Unit test for ai/page-text.js (the page text sent with a sidebar message) and for the agent's turn start:
// the text is read through the tab's DevTools session without waiting for the page to finish loading, in a
// named isolated world, and the old isolated-world call is the fallback; an outside MCP server starts while
// the page is read, not after.
const assert = require('assert');
const { readPageText, textScript, WORLD_NAME, TEXT_CHUNK } = require('../src/ai/page-text');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (err) { console.log(`FAIL  ${name}  -> ${err.stack}`); process.exitCode = 1; }
};

// A tab's webContents: its DevTools session answers like Chromium's.
function fakeWc({ attached = true, loaderIds = ['L1'], value = { url: 'https://a.test/', title: 'A', text: 'hello', totalTextChars: 5 }, evalMs = 0, throwOn = null, exception = false } = {}) {
  const calls = [];
  let trees = 0;
  const wc = {
    calls,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    debugger: {
      isAttached: () => attached,
      async sendCommand(method, params) {
        calls.push({ method, params });
        if (throwOn === method) throw new Error(`${method} failed`);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1', loaderId: loaderIds[Math.min(trees++, loaderIds.length - 1)] } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        if (method === 'Runtime.evaluate') {
          if (evalMs) await sleep(evalMs);
          return exception ? { exceptionDetails: { text: 'boom' }, result: {} } : { result: { type: 'object', value } };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  return wc;
}
const fallbackSpy = (result = { url: 'https://a.test/', title: 'A', text: 'from fallback', totalTextChars: 13 }) => {
  const spy = async (script, ms) => { spy.calls.push({ script, ms }); return result; };
  spy.calls = [];
  return spy;
};

(async () => {
  await test('the script reads text only, waits for a document still being parsed, and parses', () => {
    const s = textScript(7000);
    assert.ok(s.includes('innerText') && s.includes('slice(0, 7000)') && s.includes('DOMContentLoaded'));
    assert.ok(!s.includes('__claudeEls'), 'no element registry');
    new Function(`return ${s}`);
    assert.ok(textScript().includes(`slice(0, ${TEXT_CHUNK})`));
  });

  await test('read through the DevTools session in a named isolated world, never the load-waiting call', async () => {
    const wc = fakeWc();
    const fb = fallbackSpy();
    const out = await readPageText(wc, { fallback: fb });
    assert.strictEqual(out.text, 'hello');
    assert.strictEqual(fb.calls.length, 0);
    const world = wc.calls.find((c) => c.method === 'Page.createIsolatedWorld');
    assert.deepStrictEqual(world.params, { frameId: 'F1', worldName: WORLD_NAME, grantUniveralAccess: false });
    const evaluate = wc.calls.find((c) => c.method === 'Runtime.evaluate');
    assert.strictEqual(evaluate.params.contextId, 7, 'in the isolated world, not the page\'s');
    assert.ok(evaluate.params.returnByValue && evaluate.params.awaitPromise);
  });

  await test('no DevTools session (another debugger has the tab): the old way', async () => {
    const fb = fallbackSpy();
    const out = await readPageText(fakeWc({ attached: false }), { fallback: fb });
    assert.strictEqual(out.text, 'from fallback');
    assert.strictEqual(fb.calls.length, 1);
    assert.ok(fb.calls[0].script.includes('innerText'));
  });

  await test('a failing command or a script error: the old way', async () => {
    for (const opts of [{ throwOn: 'Page.createIsolatedWorld' }, { throwOn: 'Runtime.evaluate' }, { exception: true }]) {
      const fb = fallbackSpy();
      const out = await readPageText(fakeWc(opts), { fallback: fb });
      assert.strictEqual(out.text, 'from fallback', JSON.stringify(opts));
    }
  });

  await test('a new page committed during the read: its answer is not used', async () => {
    const fb = fallbackSpy();
    const out = await readPageText(fakeWc({ loaderIds: ['L1', 'L2'] }), { fallback: fb });
    assert.strictEqual(out.text, 'from fallback');
  });

  await test('a page that never answers: the old way gets what is left of the timeout', async () => {
    const fb = fallbackSpy();
    const started = Date.now();
    await readPageText(fakeWc({ evalMs: 5000 }), { timeoutMs: 300, fallback: fb });
    assert.ok(Date.now() - started < 1500, 'bounded by the timeout');
    assert.strictEqual(fb.calls.length, 1);
    assert.ok(fb.calls[0].ms >= 1 && fb.calls[0].ms <= 300, String(fb.calls[0].ms));
  });

  await test('a closed tab rejects instead of trying again', async () => {
    const wc = fakeWc({ attached: false });
    wc.destroyed = true;
    await assert.rejects(readPageText(wc, { fallback: fallbackSpy() }), /closed/);
  });

  // The agent's turn start (ai/agent.js runTask): the page is read with readPageText, and an outside MCP
  // server (Settings > MCP servers) is started while it is read rather than after.
  await test('an outside MCP server starts while the page is read, not after it', async () => {
    const { Agent } = require('../src/ai/agent');
    const order = [];
    let releasePage;
    const pageHeld = new Promise((r) => { releasePage = r; });
    const wc = {
      id: 1,
      getURL: () => 'https://a.test/',
      getTitle: () => 'A',
      isDestroyed: () => false,
      isLoading: () => true,
      debugger: {
        isAttached: () => true,
        async sendCommand(method) {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F', loaderId: 'L' } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 3 };
          order.push('page read');
          await pageHeld;
          return { result: { value: { url: 'https://a.test/', title: 'A', text: 'Page body', totalTextChars: 9 } } };
        },
      },
    };
    const tab = { id: 1, webContents: wc };
    let started = 0;
    const browser = {
      activeTab: () => tab,
      externalTools: { tools: async () => { started++; order.push('mcp start'); return { defs: [], failed: [] }; }, isExternal: () => false },
    };
    const sent = [];
    const client = { beta: { messages: { stream: (params) => {
      sent.push(params.messages[params.messages.length - 1].content.map((b) => b.text || '').join(''));
      const message = { role: 'assistant', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' };
      return { async *[Symbol.asyncIterator]() {}, finalMessage: async () => message };
    } } } };
    const agent = new Agent(browser, () => client, () => ({ model: 'claude-sonnet-4-5', adhdMode: false }));
    const done = new Promise((resolve) => agent.run('what is this?', (e) => { if (e.type === 'done') resolve(); }));
    for (let i = 0; i < 50 && order.length < 2; i++) await sleep(10);
    assert.deepStrictEqual(order.slice(0, 2).sort(), ['mcp start', 'page read'], `the server was not started during the read: ${order}`);
    releasePage();
    await done;
    assert.ok(started >= 1);
    assert.ok(sent.length === 1 && sent[0].includes('Page body'), sent[0]);
  });

  console.log(process.exitCode ? 'some failed' : `all ${passed} passed`);
})();
