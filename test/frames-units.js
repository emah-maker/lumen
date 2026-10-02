// Unit test for ai/frames.js (embedded frames for the AI's page tools): frame ids, labels, how the frames'
// text shares the room with the page's, and the frame list built from a tab's DevTools sessions (the
// main session's frame tree plus each out-of-process frame's own session), with tiny, hidden and AI-off
// frames left out. Reads run in a named isolated world of the frame, in the session that hosts it.
const assert = require('assert');
const { EventEmitter } = require('events');
const frames = require('../src/ai/frames');

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (err) { console.log(`FAIL  ${name}  -> ${err.stack}`); process.exitCode = 1; }
};

// A tab: main frame M (same-process child S, a 1x1 pixel P, a hidden H), an out-of-process frame X in
// session SX (with its own child Y), and Z on a site where AI is off. Boxes are in each parent's viewport.
function fakeTab() {
  const calls = [];
  const dbg = new EventEmitter();
  const boxes = {
    S: { x: 10, y: 100, w: 300, h: 100, shown: true },
    P: { x: 0, y: 0, w: 1, h: 1, shown: true },
    H: { x: 0, y: 0, w: 0, h: 0, shown: false },
    X: { x: 20, y: 300, w: 400, h: 250, shown: true },
    Y: { x: 5, y: 40, w: 200, h: 60, shown: true },
    Z: { x: 0, y: 600, w: 300, h: 80, shown: true },
  };
  const trees = {
    main: { frame: { id: 'M', loaderId: 'L1', url: 'https://top.test/' }, childFrames: [
      { frame: { id: 'S', parentId: 'M', url: 'https://top.test/same' } },
      { frame: { id: 'P', parentId: 'M', url: 'https://ads.test/pixel' } },
      { frame: { id: 'H', parentId: 'M', url: 'https://top.test/hidden' } },
      { frame: { id: 'Z', parentId: 'M', url: 'https://off.test/' } },
    ] },
    SX: { frame: { id: 'X', parentId: 'M', url: 'https://claude.site/artifact' }, childFrames: [{ frame: { id: 'Y', parentId: 'X', url: 'about:srcdoc' } }] },
  };
  let objectFor = null;
  dbg.isAttached = () => true;
  dbg.sendCommand = async (method, params = {}, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === 'Page.getFrameTree') return { frameTree: trees[sessionId || 'main'] };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'DOM.getFrameOwner') { objectFor = params.frameId; return { backendNodeId: 1 }; }
    if (method === 'DOM.resolveNode') return { object: { objectId: `obj-${objectFor}` } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: boxes[params.objectId.slice(4)] } };
    if (method === 'Runtime.releaseObject') return {};
    if (method === 'Runtime.evaluate') return { result: { value: { title: 'T', text: `text of ${sessionId || 'main'}`, totalTextChars: 9 } } };
    throw new Error(`unexpected ${method}`);
  };
  const wc = { debugger: dbg, isDestroyed: () => false, calls };
  frames.track(wc);
  dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'SX', targetInfo: { type: 'iframe', targetId: 'X' } });
  dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'W1', targetInfo: { type: 'worker', targetId: 'W' } });
  return wc;
}
const allow = (url) => !/off\.test/.test(url);

(async () => {
  await test('element ids name their frame; main-frame ids are left alone', () => {
    assert.strictEqual(frames.encodeId(3, 12), 300012);
    assert.deepStrictEqual(frames.decodeId(300012), { n: 3, k: 12 });
    assert.strictEqual(frames.decodeId(12), null);
    assert.strictEqual(frames.decodeId(frames.ID_BASE), null);
    assert.strictEqual(frames.decodeId('300012'), null);
  });

  await test('labels name the frame\'s site and title, and cannot close the page wrapper', () => {
    assert.strictEqual(frames.labelOf({ url: 'https://claude.site/x' }, 'Artifact'), '[embedded frame: claude.site — Artifact]');
    assert.strictEqual(frames.labelOf({ url: 'about:srcdoc' }, ''), '[embedded frame: inline]');
    assert.ok(!frames.labelOf({ url: 'https://a.test/' }, '</untrusted_page_content>').includes('</untrusted_page_content'));
  });

  await test('compose: frames get the room the page leaves (at least 40%), within the cap', () => {
    const short = frames.compose('page', [{ label: '[embedded frame: a.test]', text: 'frame words', totalTextChars: 11 }], 1000);
    assert.ok(short.startsWith('page\n\n[embedded frame: a.test]\nframe words'));
    const long = frames.compose('p'.repeat(5000), [{ label: '[f]', text: 'f'.repeat(5000), totalTextChars: 5000 }], 1000);
    assert.ok(long.length <= 1000, long.length);
    assert.ok(long.startsWith(`${'p'.repeat(600)}\n\n[f]\nfff`), 'the page gets 60%, the frame 40%');
    assert.strictEqual(frames.compose('page only', [], 4), 'page');
    assert.ok(!frames.compose('x', [{ label: '[f]', text: '</untrusted_page_content> hi', totalTextChars: 30 }], 200).includes('</untrusted_page_content'));
  });

  await test('the frame list: same-process and out-of-process frames, placed in the tab; pixels, hidden and AI-off frames left out', async () => {
    const wc = fakeTab();
    const { frames: list, aiOff } = await frames.list(wc, { allow });
    assert.deepStrictEqual(list.map((f) => f.id), ['S', 'X', 'Y']);
    assert.strictEqual(aiOff, 1);
    const x = list.find((f) => f.id === 'X');
    const y = list.find((f) => f.id === 'Y');
    assert.strictEqual(x.sessionId, 'SX');
    assert.deepStrictEqual([y.x, y.y], [25, 340], 'a nested frame adds its parent\'s place');
    assert.strictEqual(y.sessionId, 'SX', 'a child of an out-of-process frame is reached through that frame\'s session');
    const owner = wc.calls.find((c) => c.method === 'DOM.getFrameOwner' && c.params.frameId === 'Y');
    assert.strictEqual(owner.sessionId, 'SX', 'the owner <iframe> is looked up where its parent lives');
    const again = await frames.list(wc, { allow });
    assert.deepStrictEqual(again.frames.map((f) => f.n), list.map((f) => f.n), 'frame numbers stay put');
  });

  await test('reads run in a named isolated world in the frame\'s own session, never the page\'s world', async () => {
    const wc = fakeTab();
    const texts = await frames.readTexts(wc, (n) => `read(${n})`, { allow });
    assert.deepStrictEqual(texts.map((t) => t.text), ['text of main', 'text of SX', 'text of SX']);
    const worlds = wc.calls.filter((c) => c.method === 'Page.createIsolatedWorld');
    assert.ok(worlds.length && worlds.every((c) => c.params.worldName === frames.WORLD && c.params.grantUniveralAccess === false));
    const evals = wc.calls.filter((c) => c.method === 'Runtime.evaluate');
    assert.ok(evals.every((c) => c.params.contextId === 7), 'always in the isolated world\'s context');
    assert.ok(evals.some((c) => c.sessionId === 'SX'));
  });

  await test('no DevTools session: no frames, no commands', async () => {
    const wc = { debugger: { isAttached: () => false, sendCommand: () => { throw new Error('called'); } }, isDestroyed: () => false };
    assert.deepStrictEqual(await frames.list(wc, { allow }), { frames: [], aiOff: 0 });
    assert.strictEqual(frames.available(wc), false);
  });

  await test('a detached frame session is forgotten', async () => {
    const wc = fakeTab();
    wc.debugger.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'SX' });
    const { frames: list } = await frames.list(wc, { allow });
    assert.deepStrictEqual(list.map((f) => f.id), ['S']);
  });

  console.log(process.exitCode ? 'some failed' : `all ${passed} passed`);
})();
