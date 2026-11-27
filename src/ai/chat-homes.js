// The CLI engines that keep a home folder per chat (cli-utils.js chatHomes): named here once, so a deleted chat's homes all go
// (removeChatHomes) and the homes of chats that are gone are all pruned (pruneChatHomes) without main.js listing each engine.
// Each engine's module loads only when this is called; one engine failing never stops the others. Both resolve once every engine is done
// (main.js does not wait; the tests do).
const ENGINES = [() => require('./antigravity'), () => require('./codex')]; // Antigravity (conversation), Codex (thread)

function removeChatHomes(userData, chatId) {
  return Promise.all(ENGINES.map((engine) => engine().removeChatHome(userData, chatId).catch(() => false)));
}
// `keep`: the ids of every chat still there (never an empty list from a history that could not be read).
function pruneChatHomes(userData, keep) {
  return Promise.all(ENGINES.map((engine) => engine().pruneChatHomes(userData, keep).catch(() => [])));
}

module.exports = { removeChatHomes, pruneChatHomes };
