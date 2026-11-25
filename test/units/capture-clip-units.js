// Plain Node: a clipped screenshot (features/tab-capture.js) is placed on what the tab shows, not the top of the document, and a tab that was clipped
// is laid out afresh when it next comes to the front. A clip at { x: 0, y: 0 } of a scrolled AI tab behind the one in front left its page drawn
// shifted down (a gray band above the page and its scrollbar) once the user switched to it.
const { viewClip, shoot, clippedSinceShown, checkPageSize } = require('../../src/features/tab-capture');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

(async () => {
  const sent = [];
  const dbg = {
    attached: true,
    isAttached() { return this.attached; },
    attach() {}, detach() {},
    async sendCommand(method, params) {
      sent.push([method, params]);
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 1240, clientWidth: 1400, clientHeight: 800 } };
      return { data: '' };
    },
  };

  const clip = await viewClip(dbg, { width: 1400, height: 875, scale: 1 });
  check('the clip starts at the scrolled-to spot, not the top of the page', clip.x === 0 && clip.y === 1240 && clip.width === 1400 && clip.height === 875 && clip.scale === 1, JSON.stringify(clip));
  const offset = await viewClip(dbg, { x: 10, y: 20, width: 50, height: 60 });
  check('a crop inside the view is moved by the scroll too', offset.x === 10 && offset.y === 1260, JSON.stringify(offset));
  const noMetrics = await viewClip({ sendCommand: async () => { throw new Error('gone'); } }, { width: 5, height: 5 });
  check('no layout metrics: from the page\'s top, no throw', noMetrics.x === 0 && noMetrics.y === 0, JSON.stringify(noMetrics));

  const wc = { isDestroyed: () => false, debugger: dbg };
  sent.length = 0;
  await shoot(wc, dbg, { format: 'jpeg', clip });
  const [method, params] = sent.pop();
  check('a clipped capture never reaches past the viewport', method === 'Page.captureScreenshot' && params.captureBeyondViewport === false, JSON.stringify(params));
  check('and the tab is remembered as clipped', clippedSinceShown(wc), '');
  const plain = { isDestroyed: () => false };
  await shoot(plain, dbg, { format: 'png' });
  check('a capture without a clip is sent as it is and not remembered', !('captureBeyondViewport' in sent.pop()[1]) && !clippedSinceShown(plain), '');

  // The safety net: the page reads the right size, and its bottom-right corner is drawn; only the clip says it may be shifted.
  let bounds = { x: 0, y: 82, width: 1400, height: 800 };
  const view = {
    getBounds: () => ({ ...bounds }),
    setBounds: (b) => { bounds = b; },
    webContents: { ...wc, isLoading: () => false, getZoomFactor: () => 1, executeJavaScript: async () => [1400, 800], capturePage: async () => ({ isEmpty: () => false }) },
  };
  clippedSinceShown(view.webContents) || await shoot(view.webContents, dbg, { clip });
  const fromCapture = await checkPageSize(view, { source: 'capture', now: () => 1e6 });
  check('while it is in front being captured, a clip alone does not relayout it (no jitter under the AI)', fromCapture === null, JSON.stringify(fromCapture));
  const shown = await checkPageSize(view, { source: 'show', now: () => 2e6 });
  check('brought to the front after a clip, it is laid out afresh', shown?.kind === 'clipped' && bounds.width === 1399, JSON.stringify(shown));
  check('and is no longer marked clipped', !clippedSinceShown(view.webContents), '');
  const again = await checkPageSize(view, { source: 'show', now: () => 3e6 });
  check('a later switch to it with nothing wrong does nothing', again === null, JSON.stringify(again));

  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
