// Where a window an AI made comes up: behind the window the user is in, never above it, never owned by it.
// This file is the pure part (main.js wires it to real windows).
//   behindPlan({ front, self })  what to do after `self` is shown without activating: 'raise-front' (the user is in the Lumen window
//                                `front`: put that one back on top of the z-order, stacking only, focus untouched) or 'minimize'
//                                (the user is in another app, or in nothing of ours: the window waits in the taskbar instead of covering them)
//   independent(options)         window options without `parent` and `modal`: a window that is owned by another one stays above its owner
//                                on Windows (and a modal one blocks it), so a popup or sign-in window is a top-level window of its own, as in Chrome
//
// A window is anything with isDestroyed() and isMinimized().
function behindPlan({ front, self } = {}) {
  const usable = Boolean(front) && front !== self && !front.isDestroyed() && !front.isMinimized();
  return usable ? 'raise-front' : 'minimize';
}

function independent(options) {
  if (!options || typeof options !== 'object') return options;
  const { parent, modal, ...rest } = options;
  return rest;
}

module.exports = { behindPlan, independent };
