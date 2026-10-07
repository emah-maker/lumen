// Full screen and the new-tab page's colours, pure node: on Windows and Linux a full-screen window hides its tab strip
// and toolbar (so the page, and the new-tab page's background, reach the top of the screen), macOS keeps them; the UI is
// told from the enter/leave events themselves (on Windows isFullScreen() still answers the old state inside them);
// typing in the address bar or Ctrl+L brings the chrome back; and the new-tab page reserves no scrollbar column over a
// background (the gutter was painted black, a band down the right edge). No Electron window, no network.
const fs = require('fs');
const path = require('path');
const { hidesChrome } = require('../src/features/fullscreen-chrome');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

// ---- the decision ----
check('full screen on Windows hides the chrome', hidesChrome({ fullScreen: true, platform: 'win32' }) === true);
check('full screen on Linux hides the chrome', hidesChrome({ fullScreen: true, platform: 'linux' }) === true);
check('macOS keeps its toolbar in full screen', hidesChrome({ fullScreen: true, platform: 'darwin' }) === false);
check('a window that is not full screen keeps its chrome', hidesChrome({ fullScreen: false, platform: 'win32' }) === false && hidesChrome({ platform: 'linux' }) === false && hidesChrome() === false);
check('only a real true counts (no truthy junk)', hidesChrome({ fullScreen: 1, platform: 'win32' }) === false && hidesChrome({ fullScreen: 'yes', platform: 'win32' }) === false);

// ---- main.js: told from the events, not from isFullScreen() ----
const main = read('src/main.js');
check('main.js sends true on enter-full-screen', /w\.on\('enter-full-screen', \(\) => sendFullscreen\(true\)\)/.test(main));
check('main.js sends false on leave-full-screen', /w\.on\('leave-full-screen', \(\) => sendFullscreen\(false\)\)/.test(main));
check('main.js asks fullscreen-chrome, per platform', /fullscreenChrome\.hidesChrome\(\{ fullScreen, platform: process\.platform \}\)/.test(main));
check('a UI reloaded in full screen is told again', /did-finish-load', \(\) => \{ if \(w\.isFullScreen\(\)\) sendFullscreen\(true\); \}/.test(main));
check('Ctrl+L reveals the toolbar; a new tab\'s cursor does not', /key === 'l'\) focusAddress\(\{ reveal: true \}\)/.test(main) && /send\('focus-address', \{ reveal \}\)/.test(main));

// ---- the UI ----
const preload = read('src/preload/preload.js');
const bundle = read('src/preload/preload.bundle.js');
check('the preload passes window-fullscreen to the UI (and its bundle too)', /onWindowFullscreen: on\('window-fullscreen'\)/.test(preload) && /onWindowFullscreen: on\('window-fullscreen'\)/.test(bundle));
const app = read('src/renderer/app.js');
check('the UI toggles body.window-fullscreen', /onWindowFullscreen\?\.\(\(on\) => \{\n\s*document\.body\.classList\.toggle\('window-fullscreen', on === true\)/.test(app));
check('typing in the address bar shows the chrome, leaving it hides it again', /address\.addEventListener\('input', \(\) => revealChrome\(true\)\)/.test(app) && /address\.addEventListener\('blur', \(\) => revealChrome\(false\)\)/.test(app));
check('the reveal only happens in full screen', /function revealChrome\(on\) \{\n\s*if \(!document\.body\.classList\.contains\('window-fullscreen'\)\) on = false;/.test(app));
const css = read('src/renderer/styles.css');
check('the chrome collapses to no height in full screen, clipped (still focusable, never scrolled)', css.includes('body.window-fullscreen:not(.chrome-reveal) .chrome { height: 0; overflow: clip; }'));
check('the page area starts at the top in full screen (--chrome-h)', css.includes('body.window-fullscreen:not(.chrome-reveal) { --chrome-h: 0px; }'));
check('the rule is in the committed CSS bundle', read('src/renderer/ui.bundle.css').includes('body.window-fullscreen:not(.chrome-reveal) .chrome { height: 0; overflow: clip; }'));

// ---- the new-tab page: no black scrollbar column over a background ----
const ntp = read('src/renderer/newtab.html');
check('the new-tab page reserves no scrollbar gutter over a background or an effect', ntp.includes('html:has(> body.on-media), html:has(> body.has-effect) { scrollbar-gutter: auto; scrollbar-width: none; }'));
check('the backdrop is still fixed edge to edge', /#backdrop \{ position: fixed; inset: 0;/.test(ntp));
check('a plain page keeps its stable gutter (painted in the page colour)', /html \{ scrollbar-gutter: stable; \}/.test(ntp));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
