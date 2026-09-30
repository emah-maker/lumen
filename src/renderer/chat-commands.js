// The chat's own "/" commands (skills add theirs in skills.js). Loaded after slash.js, in the sidebar and
// on the chat page alike.
//   /clear   starts a fresh conversation, like the New chat button: the current one stays in the chat
//            history, so nothing is lost.
(() => {
  const slash = window.slashCommands;
  const newChat = document.getElementById('new-chat');
  if (!slash || !newChat) return;
  const tr = (key, fallback) => {
    const text = window.t ? window.t(key) : key;
    return text && text !== key ? text : fallback;
  };
  slash.register({
    name: 'clear',
    label: tr('slash.clear', 'Clear chat'),
    description: tr('slash.clear.description', 'Start a fresh conversation. This one stays in your chat history.'),
    takesInput: false,
    run() {
      newChat.click();
      return { ok: true };
    },
  });
})();
