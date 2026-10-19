// Split view's pure rules: browser/split-layout.js (the page rectangles, the divider's ratio, the drop zone, the pair bookkeeping),
// and that the pieces main.js and the UI rely on are wired (the layout shows both pages, the IPC channels are UI-only, the strings exist).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../src/browser/split-layout');

let failures = 0;
const check = (label, fn) => { try { fn(); console.log(`PASS  ${label}`); } catch (e) { failures++; console.log(`FAIL  ${label}  -> ${e.message}`); } };
const area = { x: 0, y: 80, width: 1000, height: 600 };

check('an even split: two pages and the gap fill the page area exactly', () => {
  const r = L.compute(area, 0.5);
  assert.strictEqual(r.left.x, 0);
  assert.strictEqual(r.left.width + L.GAP + r.right.width, 1000);
  assert.strictEqual(r.right.x, r.left.width + L.GAP);
  assert.strictEqual(r.divider.x, r.left.width);
  assert.strictEqual(r.divider.width, L.GAP);
  assert.strictEqual(r.left.height, 600);
  assert.strictEqual(r.right.y, 80);
});
check('the pages sit at the page area own origin', () => {
  const r = L.compute({ x: 40, y: 100, width: 900, height: 500 }, 0.5);
  assert.strictEqual(r.left.x, 40);
  assert.strictEqual(r.right.x + r.right.width, 940);
});
check('the ratio moves the divider, widths stay whole pixels', () => {
  const r = L.compute(area, 0.3);
  assert.ok(Number.isInteger(r.left.width) && Number.isInteger(r.right.width));
  assert.ok(Math.abs(r.left.width - 0.3 * (1000 - L.GAP)) <= 0.5);
});
check('neither page gets narrower than the minimum, whatever the ratio', () => {
  for (const ratio of [-5, 0, 0.01, 0.99, 1, 7, NaN, undefined, null, Infinity]) {
    const r = L.compute(area, ratio);
    assert.ok(r.left.width >= L.MIN_PANE && r.right.width >= L.MIN_PANE, `ratio ${ratio}: ${r.left.width}/${r.right.width}`);
  }
});
check('a bad ratio is the middle', () => {
  const r = L.compute(area, NaN);
  assert.ok(Math.abs(r.left.width - r.right.width) <= 1);
});
check('a page area too narrow for two pages is not split', () => {
  assert.strictEqual(L.compute({ x: 0, y: 0, width: L.MIN_AREA - 1, height: 400 }, 0.5), null);
  assert.ok(L.compute({ x: 0, y: 0, width: L.MIN_AREA, height: 400 }, 0.5));
  assert.strictEqual(L.compute({ x: 0, y: 0, width: 1000, height: 0 }, 0.5), null);
  assert.strictEqual(L.compute(null, 0.5), null);
});
check('at the narrowest size both pages are exactly the minimum', () => {
  const r = L.compute({ x: 0, y: 0, width: L.MIN_AREA, height: 300 }, 0.9);
  assert.strictEqual(r.left.width, L.MIN_PANE);
  assert.strictEqual(r.right.width, L.MIN_PANE);
});
check('a divider dragged to x gives the ratio that puts it there, and back', () => {
  for (const ratio of [0.3, 0.5, 0.7]) {
    const r = L.compute(area, ratio);
    const back = L.ratioFromX(r.divider.x + L.GAP / 2, area);
    const again = L.compute(area, back);
    assert.ok(Math.abs(again.divider.x - r.divider.x) <= 1, `${ratio}: ${again.divider.x} vs ${r.divider.x}`);
  }
});
check('a drag past either end stops at the minimum', () => {
  assert.strictEqual(L.compute(area, L.ratioFromX(-500, area)).left.width, L.MIN_PANE);
  assert.strictEqual(L.compute(area, L.ratioFromX(5000, area)).right.width, L.MIN_PANE);
});
check('the drop zone is the right edge of the page area', () => {
  assert.ok(L.inDropZone({ x: 990, y: 300 }, area));
  assert.ok(L.inDropZone({ x: 1000 - Math.min(L.DROP_MAX, 1000 * L.DROP_EDGE) + 1, y: 300 }, area));
  assert.ok(!L.inDropZone({ x: 500, y: 300 }, area));
  assert.ok(!L.inDropZone({ x: 990, y: 40 }, area)); // over the toolbar
  assert.ok(!L.inDropZone({ x: 1010, y: 300 }, area)); // past the page area (the sidebar)
  assert.ok(!L.inDropZone({ x: 290, y: 300 }, { x: 0, y: 80, width: 300, height: 600 })); // too narrow to split
  assert.ok(!L.inDropZone(null, area));
});
check('the drop zone is never wider than its cap on a wide window', () => {
  assert.ok(!L.inDropZone({ x: 3000 - L.DROP_MAX - 5, y: 300 }, { x: 0, y: 0, width: 3000, height: 800 }));
  assert.ok(L.inDropZone({ x: 3000 - L.DROP_MAX + 5, y: 300 }, { x: 0, y: 0, width: 3000, height: 800 }));
});

const mk = (...ids) => ids.map((id) => ({ id }));
check('linking two tabs gives both the same pair, left and right', () => {
  const tabs = mk(1, 2, 3);
  const pair = L.link(tabs, 1, 2, 0.4);
  assert.strictEqual(tabs[0].split, pair);
  assert.strictEqual(tabs[1].split, pair);
  assert.strictEqual(tabs[2].split, undefined);
  assert.strictEqual(L.sideOf(tabs[0]), 'left');
  assert.strictEqual(L.sideOf(tabs[1]), 'right');
  assert.strictEqual(L.sideOf(tabs[2]), null);
  assert.strictEqual(L.partnerOf(tabs, tabs[0]), tabs[1]);
  assert.strictEqual(L.partnerOf(tabs, tabs[1]), tabs[0]);
  assert.strictEqual(L.partnerOf(tabs, tabs[2]), null);
});
check('the ratio is shared: one change shows on both tabs', () => {
  const tabs = mk(1, 2);
  L.link(tabs, 1, 2);
  tabs[0].split.ratio = 0.7;
  assert.strictEqual(tabs[1].split.ratio, 0.7);
});
check('a tab is in one pair at most: pairing it again dissolves the old one', () => {
  const tabs = mk(1, 2, 3, 4);
  L.link(tabs, 1, 2);
  L.link(tabs, 2, 3);
  assert.strictEqual(tabs[0].split, undefined);
  assert.strictEqual(L.partnerOf(tabs, tabs[1]), tabs[2]);
  assert.strictEqual(L.sideOf(tabs[1]), 'left');
});
check('a tab cannot be paired with itself or with a tab that is not there', () => {
  const tabs = mk(1, 2);
  assert.strictEqual(L.link(tabs, 1, 1), null);
  assert.strictEqual(L.link(tabs, 1, 9), null);
  assert.strictEqual(tabs[0].split, undefined);
});
check('unlinking takes both tabs out and says who the partner was', () => {
  const tabs = mk(1, 2, 3);
  L.link(tabs, 1, 2);
  assert.strictEqual(L.unlink(tabs, 2), 1);
  assert.strictEqual(tabs[0].split, undefined);
  assert.strictEqual(tabs[1].split, undefined);
  assert.strictEqual(L.unlink(tabs, 3), null);
});
check('a pair whose other tab has gone is dropped when asked about', () => {
  const tabs = mk(1, 2);
  L.link(tabs, 1, 2);
  tabs.splice(1, 1);
  assert.strictEqual(L.partnerOf(tabs, tabs[0]), null);
  assert.strictEqual(tabs[0].split, undefined);
});

const src = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
check('main.js: layout shows both pages, the sidebar snapshot and the new-tab overlay stand aside, a click activates the side', () => {
  const main = src('src', 'main.js');
  assert.ok(/const sp = splitView\(\);/.test(main) && /tab === sp\?\.partner/.test(main), 'layout shows the partner');
  assert.ok(/visible && !sp && !tab\.fullscreen && isNewTab/.test(main), 'no full-width overlay in a split');
  assert.ok(/splitView\(\)\) return null/.test(main), 'no sidebar snapshot of one page');
  assert.ok(/if \(tab\.split\) activateSplitSide\(tab\)/.test(main), 'a click in a side makes it the tab in front');
  assert.ok(/splitView\(\)\?\.partner === tab\)/.test(main), 'the partner on show is not put to sleep');
});
check('main.js: the split channels are UI-only, and the preload sends exactly them', () => {
  const main = src('src', 'main.js');
  const pre = src('src', 'preload', 'preload.js');
  const gated = /const UI_ONLY_IPC = new Set\(\[[\s\S]*?\n\]\);/.exec(main)[0];
  for (const ch of ['split:ratio', 'split:close']) {
    assert.ok(gated.includes(`'${ch}'`), `${ch} gated`);
    assert.ok(pre.includes(`'${ch}'`), `${ch} in the preload`);
  }
});
check('the strings exist', () => {
  const en = JSON.parse(src('src', 'locales', 'en.json'));
  for (const k of ['menu.openSplitView', 'menu.closeSplitView', 'split.divider', 'split.close', 'tabs.state.split']) assert.ok(typeof en[k] === 'string' && en[k], k);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
