// Full screen (F11) on Windows and Linux: as in Chrome, the tab strip and toolbar go away while the window
// is in full screen, so the page fills the screen edge to edge. Before this, a full-screen window kept its
// 82 px of tab strip and toolbar, and the new-tab page's colours (its background, gradient or picture)
// stopped at the toolbar's edge instead of reaching the top of the screen.
// The UI (renderer/app.js, styles.css body.window-fullscreen) collapses the chrome and reports the page
// area's new rect as usual (content-bounds), so the tab's view moves up to y = 0. The address bar stays
// focusable: typing in it, or Ctrl+L, shows the chrome again until it loses focus.
// macOS keeps its toolbar in full screen (Chrome's default there; the menu bar slides over the top).
//
//   hidesChrome({ fullScreen, platform })  -> whether the window's UI should hide its tab strip and toolbar
'use strict';

function hidesChrome({ fullScreen, platform } = {}) {
  return fullScreen === true && platform !== 'darwin';
}

module.exports = { hidesChrome };
