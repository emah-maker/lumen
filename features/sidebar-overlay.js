// The AI sidebar over the new-tab page. Elsewhere the sidebar takes its column and the page's native
// view gets narrower (the site reflows to the new width). On Lumen's own new-tab page that would
// squeeze and re-flow the cards and the search box every time the sidebar opens. There the view is
// still narrowed (the sidebar is drawn by the UI, and a native view is always painted above the UI,
// so it must not reach under the sidebar) but the page keeps laying itself out at the full width:
// Chromium's device emulation is given the full-width view size, so what is behind the sidebar is
// simply covered, as if the sidebar floated over the page, and nothing moves or wraps.
//
//   overlayParams({ newTab, fullscreen, bounds })
//       bounds: { width, height, fullWidth } as the UI reported them: the view's width now, and the
//       width the page area has with the sidebar closed.
//       -> null (lay the page out normally) or the argument for webContents.enableDeviceEmulation().
//   sameParams(a, b)   whether two answers are the same, so main.js only calls Electron on a change
'use strict';

const MIN_COVER = 2; // px: a sliver narrower than this is rounding, not a sidebar
const MAX_SIZE = 16384;

function overlayParams({ newTab, fullscreen, bounds } = {}) {
  if (!newTab || fullscreen || !bounds) return null;
  const width = Math.round(Number(bounds.width));
  const height = Math.round(Number(bounds.height));
  const full = Math.round(Number(bounds.fullWidth));
  if (!(width > 0) || !(height > 0) || !Number.isFinite(full)) return null;
  if (full < width + MIN_COVER || full > MAX_SIZE) return null;
  return {
    screenPosition: 'desktop',
    screenSize: { width: full, height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 0, // keep the display's own
    viewSize: { width: full, height },
    scale: 1,
  };
}

function sameParams(a, b) {
  if (!a || !b) return !a && !b;
  return a.viewSize.width === b.viewSize.width && a.viewSize.height === b.viewSize.height;
}

module.exports = { overlayParams, sameParams, MIN_COVER };
