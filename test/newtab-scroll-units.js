// New-tab scrolling (src/renderer/newtab.html, newtab-scrollbar.js, newtab-widgets-grid.js, features/widget-layout.js): pure checks, no window.
// The page's room under its content exists only for a page that scrolls anyway, and a card's scrolling area at its end
// takes the wheel instead of handing it to the page.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WL = require('../src/features/widget-layout');

module.exports = async function newtabScrollUnits(check) {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const html = read('src/renderer/newtab.html');
  const grid = read('src/renderer/newtab-widgets-grid.js');
  const js = read('src/renderer/newtab-scrollbar.js');

  // pageRoom: room only under content that runs past the window
  check('page room: content that fits the window gets none', WL.pageRoom(500, 800, 32) === 0 && WL.pageRoom(800, 800, 32) === 0 && WL.pageRoom(800.4, 800, 32) === 0, '');
  check('page room: content past the window gets its room', WL.pageRoom(801, 800, 32) === 32 && WL.pageRoom(1500, 800, 48) === 48, '');
  check('page room: cards that end inside the last 32px of the window do not make it scroll (the old +32 did)', 800 - 10 + WL.pageRoom(790, 800, 32) <= 800, '');
  check('the cards\' page height uses pageRoom, not a fixed +32', /WL\.pageRoom\(lowest,/.test(grid) && !/bottom \+ 32 \+ slack/.test(grid), '');
  check('the centre column\'s bottom padding is a variable the scrollbar script drops while the column fits', /padding:\s*var\(--main-pad, 88px\) 0 var\(--main-room, 48px\)/.test(html) && /--main-room/.test(js) && /pageRoom/.test(js), '');
  check('no CSS overscroll-behavior on card areas (it would also stop a wheel over an area that does not scroll)', !/overscroll-behavior/.test(html), '');

  // the wheel absorber, driven with fake nodes
  const listeners = {};
  const root = { clientWidth: 1000, clientHeight: 500, scrollHeight: 500, scrollTop: 0, nodeType: 1, classList: { add() {}, remove() {}, toggle() {} } };
  const mk = () => ({ style: {}, children: [], setAttribute() {}, appendChild(c) { this.children.push(c); }, addEventListener() {} });
  const body = mk();
  const doc = { documentElement: root, scrollingElement: root, body, createElement: mk, addEventListener: (t, f) => { listeners[t] = f; } };
  const win = { addEventListener() {} };
  vm.runInNewContext(js, { document: doc, window: win, ResizeObserver: class { observe() {} }, setTimeout: () => 0, getComputedStyle: (n) => ({ overflowY: n.overflowY || 'visible' }) });
  const absorbs = win.newtabWheelAbsorbs;
  const style = (n) => ({ overflowY: n.overflowY || 'visible' });
  const area = (o, parent) => ({ nodeType: 1, parentElement: parent || null, overflowY: 'auto', clientHeight: 100, scrollHeight: 500, scrollTop: 0, ...o });
  const card = area({ overflowY: 'visible', scrollHeight: 100 });
  check('wheel: a list with room below keeps the wheel for itself (the browser scrolls it)', absorbs(area({ scrollTop: 0 }, card), 120, style) === false, '');
  check('wheel: a list at its bottom absorbs a wheel down', absorbs(area({ scrollTop: 400 }, card), 120, style) === true, '');
  check('wheel: a list at its top absorbs a wheel up, and has room for one down', absorbs(area({ scrollTop: 0 }, card), -120, style) === true && absorbs(area({ scrollTop: 0 }, card), 120, style) === false, '');
  check('wheel: an area that does not overflow lets the page have the wheel', absorbs(area({ scrollHeight: 100 }, card), 120, style) === false, '');
  check('wheel: an overflow-hidden area lets the page have the wheel', absorbs(area({ overflowY: 'hidden' }, card), 120, style) === false, '');
  const outer = area({ scrollTop: 0 }, card);
  check('wheel: an inner list at its end hands the wheel to an outer area that can still scroll', absorbs(area({ scrollTop: 400 }, outer), 120, style) === false, '');
  check('wheel: nothing scrolls under the pointer: not absorbed', absorbs(card, 120, style) === false, '');
  // the listener itself: ctrl+wheel (zoom) and handled wheels are left alone
  const fake = (o) => { const e = { deltaX: 0, deltaY: 120, ctrlKey: false, metaKey: false, defaultPrevented: false, target: area({ scrollTop: 400 }, card), prevented: false, preventDefault() { this.prevented = true; }, ...o }; listeners.wheel(e); return e.prevented; };
  check('wheel: at the end of a list the wheel is prevented', fake({}) === true, '');
  check('wheel: Ctrl + wheel (page zoom) is never prevented', fake({ ctrlKey: true }) === false && fake({ metaKey: true }) === false, '');
  check('wheel: a wheel somebody handled (a stack switching cards) is left alone', fake({ defaultPrevented: true }) === false, '');
  check('wheel: a sideways wheel is left alone', fake({ deltaX: 200, deltaY: 10 }) === false, '');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
