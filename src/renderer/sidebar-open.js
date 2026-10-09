// What the AI button (and Ctrl+J) does when it opens the sidebar (app.js): start a new chat, or leave the chat as it is.
// A plain script in the UI; test/sidebar-open-units.js loads it with require().
//   'keep'   leave the sidebar on the chat it shows (the setting is off, or the open request carries an intent: a chat to show,
//            "Ask AI about this", a task or run that needs an OK, a notification, an agent event)
//   'reuse'  the setting is on but the open chat is already empty: use it (empty chats are not piled up)
//   'new'    the setting is on and the open chat has messages: the sidebar opens on a fresh empty chat; the old one stays in
//            History (a run still going in it keeps going)
(function (root) {
  function sidebarOpenPlan({ setting = true, empty = false, intent = false } = {}) {
    if (intent || setting === false) return 'keep';
    return empty ? 'reuse' : 'new';
  }
  const api = { sidebarOpenPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.sidebarOpenPlan = sidebarOpenPlan;
})(typeof window !== 'undefined' ? window : globalThis);
