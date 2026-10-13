// features/page-first-keys.js, plain Node: which keys are the page's first, which stay the browser's, and the hold / done hand-off.
const { PAGE_FIRST, BROWSER_ONLY, classify, create } = require('../src/features/page-first-keys');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

// 'mod+shift+s' -> a before-input-event input on the platform ('mod' is Ctrl, or Cmd on macOS).
function inputFor(combo, platform = 'win32') {
  const parts = combo.split('+');
  const key = combo.endsWith('++') ? '+' : parts[parts.length - 1];
  const has = (p) => parts.slice(0, -1).includes(p) || (combo.endsWith('++') && parts.slice(0, -2).includes(p));
  const mod = has('mod'); const mac = platform === 'darwin';
  return { type: 'keyDown', key, control: has('ctrl') || (mod && !mac), meta: mod && mac, shift: has('shift'), alt: has('alt') };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  for (const entry of PAGE_FIRST) {
    const should = entry.not !== platform;
    check(`${platform}: ${entry.combo} (${entry.does}) is ${should ? 'page-first' : 'the browser\'s'}`, Boolean(classify(inputFor(entry.combo, platform), platform)) === should);
  }
  for (const combo of BROWSER_ONLY) check(`${platform}: ${combo} is never page-first`, classify(inputFor(combo, platform), platform) === null, combo);
}
check('Alt+D, Alt+Left and Alt+Right are never page-first', ['alt+d', 'alt+arrowleft', 'alt+arrowright'].every((c) => classify(inputFor(c)) === null));
check('Ctrl+F4 (close tab) is never page-first', classify(inputFor('ctrl+f4')) === null);
check('Ctrl+Alt+S (AltGr) is not Save page', classify({ type: 'keyDown', key: 's', control: true, alt: true }) === null);
check('Control+S on macOS is the text-editing key, not Save page', classify({ type: 'keyDown', key: 's', control: true }, 'darwin') === null);
check('a key up is not a key press', classify({ type: 'keyUp', key: 's', control: true }) === null);
check('a plain S is not a shortcut', classify({ type: 'keyDown', key: 's' }) === null);
check('no combo is in both lists', PAGE_FIRST.every((e) => !BROWSER_ONLY.includes(e.combo)));

// hold / done, with fake contents and frames
function fake(url = 'http://example.test/', ready = true) {
  const wc = { id: 7, getURL: () => url, mainFrame: { ready }, focusedFrame: null, once() {} };
  return wc;
}
const press = (key, extra = {}) => ({ type: 'keyDown', key, control: true, shift: false, alt: false, meta: false, ...extra });
const report = (key, prevented, extra = {}) => ({ key, ctrl: true, meta: false, shift: false, alt: false, prevented, ...extra });
{
  const keys = create({ isReady: (f) => f.ready });
  const wc = fake(); let ran = 0;
  check('hold: a page-first key on a web page is left to the page', keys.hold(wc, press('s'), () => { ran++; }) === true);
  check('hold: nothing runs before the page has answered', ran === 0 && keys.pending(wc) === 1);
  check('done: a prevented key does nothing', keys.done(wc, report('s', true)) === false && ran === 0 && keys.pending(wc) === 0);
  keys.hold(wc, press('s'), () => { ran++; });
  check('done: an unhandled key runs Lumen\'s action', keys.done(wc, report('s', false)) === true && ran === 1);
  check('done: a press runs at most once', keys.done(wc, report('s', false)) === false && ran === 1);
  check('done: a report with nothing queued does nothing (a page cannot make Lumen save)', keys.done(wc, report('s', false)) === false && ran === 1);
  keys.hold(wc, press('p'), () => { ran += 10; });
  check('done: another key does not run the queued one', keys.done(wc, report('s', false)) === false && ran === 1);
  check('done: Ctrl+Shift+P is not the queued Ctrl+P', keys.done(wc, report('p', false, { shift: true })) === false && ran === 1);
  check('done: the matching key runs it', keys.done(wc, report('P', false)) === true && ran === 11);
  check('hold: not a page-first key is the browser\'s', keys.hold(wc, press('t'), () => {}) === false);
  check('hold: a key held down is the page\'s but queues nothing', keys.hold(wc, press('s', { isAutoRepeat: true }), () => { ran++; }) === true && keys.pending(wc) === 0);
  check('hold: Lumen\'s own pages keep their keys', keys.hold(fake('file:///newtab.html'), press('s'), () => {}) === false && keys.hold(fake('lumen-pdf://x'), press('f'), () => {}) === false);
  check('hold: a frame the preload does not reach keeps Lumen\'s key', keys.hold(fake('http://example.test/', false), press('s'), () => {}) === false);
  const inFrame = fake(); inFrame.focusedFrame = { ready: false };
  check('hold: a focused cross-origin frame keeps Lumen\'s key', keys.hold(inFrame, press('s'), () => {}) === false);
  inFrame.focusedFrame = { ready: true };
  check('hold: a focused frame the preload covers is left to it', keys.hold(inFrame, press('s'), () => {}) === true);
}
{
  let t = 1000;
  const keys = create({ isReady: () => true, now: () => t });
  const wc = fake(); let ran = 0;
  keys.hold(wc, press('s'), () => { ran++; });
  t += 5000;
  check('done: a press that was never answered expires', keys.done(wc, report('s', false)) === false && ran === 0);
}
{
  const keys = create({ isReady: () => true, platform: 'darwin' });
  const wc = fake();
  check('macOS: Cmd+S is left to the page', keys.hold(wc, { type: 'keyDown', key: 's', meta: true }, () => {}) === true);
  check('macOS: Control+S is not', keys.hold(wc, { type: 'keyDown', key: 's', control: true }, () => {}) === false);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll page-first key unit checks passed');
process.exit(failures ? 1 : 0);
