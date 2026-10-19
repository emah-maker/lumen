// What a view should do with main's answer about the chat it shows (renderer/chat-core.js reconcile()): 'keep' when the
// view already matches (same chat, same running state), 'adopt' when only the chat's id was not known yet, 'sync' when
// the view is stale (another chat, or a run that ended or began while the sidebar was hidden) and must take main's view.
// Plain script in the UI; test/run-state-units.js loads it with require().
(function (root) {
  function reconcileAction(view, shownChatId, running) {
    if (!view || !view.id) return 'keep';
    const live = Boolean(view.live);
    if (view.id === shownChatId && live === running) return 'keep';
    if (!shownChatId && live === running) return 'adopt';
    return 'sync';
  }
  const api = { reconcileAction };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.runState = api;
})(this);
