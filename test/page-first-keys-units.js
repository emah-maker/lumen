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
    const should = entry.not !== platform && (!entry.only || entry.only === platform);
    check(`${platform}: ${entry.combo} (${entry.does}) is ${should ? 'page-first' : 'the browser\'s'}`, Boolean(classify(inputFor(entry.combo, platform), platform)) === should);
  }
  for (const combo of BROWSER_ONLY) check(`${platform}: ${combo} is never page-first`, classify(inputFor(combo, platform), platform) === null, combo);
}
const PLATFORMS = ['win32', 'darwin', 'linux'];
// The shortcut modifier on a platform: Ctrl on Windows / Linux, Cmd (meta) on macOS (there Control is the text-editing key).
const modOf = (platform) => (platform === 'darwin' ? { meta: true } : { control: true });
for (const platform of PLATFORMS) {
  const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl';
  for (const combo of ['mod+t', 'mod+shift+t', 'mod+w', 'mod+shift+w', 'mod+n', 'mod+shift+n', 'mod+tab', 'mod+shift+tab', 'mod+pageup', 'mod+pagedown', 'mod+1', 'mod+9', 'f11']) {
    check(`${platform}: reserved: ${combo} is the browser's, a page cannot take it`, BROWSER_ONLY.includes(combo) && classify(inputFor(combo, platform), platform) === null, combo);
  }
  check(`${platform}: ${mod}+L, ${mod}+R, F5, zoom, Alt+Left and Alt+Right are the page first (as in Chrome)`, ['mod+l', 'mod+r', 'f5', 'mod+=', 'mod+-', 'mod+0', 'alt+arrowleft', 'alt+arrowright', 'mod+k', 'mod+e', 'f6'].every((c) => classify(inputFor(c, platform), platform) !== null));
  check(`${platform}: ${mod}+Alt+Left (AltGr) is not Back`, classify({ type: 'keyDown', key: 'ArrowLeft', ...modOf(platform), alt: true }, platform) === null);
  // a layout with no Latin letters: Ctrl / Cmd+W and +L go by the physical key
  check(`${platform}: layout: ${mod}+Д (key L on a Russian layout) is ${mod}+L`, classify({ type: 'keyDown', key: 'д', code: 'KeyL', ...modOf(platform) }, platform)?.combo === 'mod+l');
  check(`${platform}: layout: ${mod}+Ц is reserved (${mod}+W), not page-first`, classify({ type: 'keyDown', key: 'ц', code: 'KeyW', ...modOf(platform) }, platform) === null);
  check(`${platform}: layout: plain typing of a non-Latin letter is no shortcut`, classify({ type: 'keyDown', key: 'д', code: 'KeyL' }, platform) === null);
  check(`${platform}: Ctrl+F4 (close tab) is never page-first`, classify(inputFor('ctrl+f4', platform), platform) === null);
  check(`${platform}: ${mod}+Alt+S (AltGr) is not Save page`, classify({ type: 'keyDown', key: 's', ...modOf(platform), alt: true }, platform) === null);
  check(`${platform}: a key up is not a key press`, classify({ type: 'keyUp', key: 's', ...modOf(platform) }, platform) === null);
  check(`${platform}: a plain S is not a shortcut`, classify({ type: 'keyDown', key: 's' }, platform) === null);
}
check('Control+S on macOS is the text-editing key, not Save page', classify({ type: 'keyDown', key: 's', control: true }, 'darwin') === null);
check('Ctrl+Д on macOS (Control, not Cmd) is no shortcut', classify({ type: 'keyDown', key: 'д', code: 'KeyL', control: true }, 'darwin') === null);
check('no combo is in both lists', PAGE_FIRST.every((e) => !BROWSER_ONLY.includes(e.combo)));

// hold / done, with fake contents and frames
function fake(url = 'http://example.test/', ready = true) {
  const wc = { id: 7, getURL: () => url, mainFrame: { ready }, focusedFrame: null, once() {} };
  return wc;
}
const press = (key, extra = {}) => ({ type: 'keyDown', key, control: true, shift: false, alt: false, meta: false, ...extra });
const report = (key, prevented, extra = {}) => ({ key, ctrl: true, meta: false, shift: false, alt: false, prevented, ...extra });
{
  const keys = create({ isReady: (f) => f.ready, platform: 'win32' }); // (Ctrl presses: pin the platform, or on macOS they are not the shortcut)
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
  const keys = create({ isReady: () => true, platform: 'win32' });
  const wc = fake(); let ran = 0;
  keys.hold(wc, { type: 'keyDown', key: 'ArrowLeft', control: false, alt: true, shift: false, meta: false }, () => { ran++; });
  check('done: Alt+Left the page left alone goes back', keys.done(wc, { key: 'ArrowLeft', ctrl: false, meta: false, shift: false, alt: true, prevented: false }) === true && ran === 1);
  keys.hold(wc, { type: 'keyDown', key: 'F5', control: false, alt: false, shift: false, meta: false }, () => { ran += 10; });
  check('done: a page that handled F5 keeps it', keys.done(wc, { key: 'F5', ctrl: false, meta: false, shift: false, alt: false, prevented: true }) === false && ran === 1 && keys.pending(wc) === 0);
}
{
  let t = 1000;
  const keys = create({ isReady: () => true, now: () => t, platform: 'win32' });
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
