// A stand-in for one computer running Lumen, for the sync suites: its own profile folder, settings object, history, saved chats (the real
// chat store), saved passwords (the real vault) and a sync service wired as main.js wires it. The keychain is a stand-in too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore } = require('../src/features/chat-store');
const { createVault } = require('../src/features/passwords');
const { createSyncService } = require('../src/features/sync-folder');
const P = require('../src/features/sync-providers');
const { DEFAULTS } = require('../src/settings/settings-backend');

const keychain = {
  available: () => true,
  encrypt: (text) => Buffer.from(`K:${Buffer.from(text).toString('base64')}`),
  decrypt: (buf) => { const s = buf.toString(); if (!s.startsWith('K:')) throw new Error('other keys'); return Buffer.from(s.slice(2), 'base64').toString(); },
};
const enc = (s) => `K:${Buffer.from(s, 'utf8').toString('base64')}`;
const dec = (s) => { if (!String(s).startsWith('K:')) throw new Error('other keys'); return Buffer.from(String(s).slice(2), 'base64').toString('utf8'); };

function computer(name, { timing, watchMode } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `lumen-sync-pc-${name}-`));
  const c = { name, userData, settings: {}, history: new Map(), historyLoaded: true, applied: [], busy: new Set(), historySaves: 0, status: 0, vaultBroken: false };
  const read = () => ({ ...c.settings });
  const write = (s) => { const prev = c.settings; c.settings = { ...s }; c.service?.touchSettings(prev, c.settings); };
  c.vaultFile = path.join(userData, 'passwords.bin');
  c.vault = createVault({ file: c.vaultFile, cipher: { available: () => true, encrypt: (t) => keychain.encrypt(t), decrypt: (b) => keychain.decrypt(b) } });
  c.chats = createChatStore({ dir: path.join(userData, 'chats'), encrypt: enc, decrypt: dec, onChange: () => c.service?.touch('chats') });
  const providers = {
    bookmarks: () => P.bookmarks({ read: () => c.settings.bookmarks, write: (list) => { c.settings = { ...c.settings, bookmarks: list }; } }),
    settings: () => P.settings({ read, set: async (k, v) => { if (!(k in DEFAULTS)) throw new Error('unknown'); c.settings = { ...c.settings, [k]: v }; }, writeDirect: (patch) => { c.settings = { ...c.settings, ...patch }; } }),
    widgets: () => P.widgets({ read, write: (patch) => { c.settings = { ...c.settings, ...patch }; }, refresh: () => { c.refreshed = (c.refreshed || 0) + 1; } }),
    history: () => P.history({ map: () => c.history, ready: async () => c.historyLoaded, save: () => { c.historySaves++; }, bump: () => {}, isWorthImporting: (u) => !/token=/.test(u) }),
    chats: () => P.chats({ store: c.chats, busy: (id) => c.busy.has(id) }),
    passwords: () => P.passwords({ vault: c.vault, unavailable: () => (c.vaultBroken ? 'vault broken' : null) }),
  };
  c.service = createSyncService({
    userData, readSettings: read, writeSettings: write, cipher: keychain, appVersion: 'test', deviceName: `pc-${name}`,
    timing: { local: 30, history: 60, watch: 30, poll: 40, periodic: 60000, first: 10, ...(timing || {}) }, watchMode,
    makeProvider: (kind) => providers[kind]?.(),
    onApplied: (kinds) => { c.applied.push(...kinds); },
    onStatus: () => { c.status++; },
  });
  c.snap = (n) => ({ messages: [{ role: 'user', content: [{ type: 'text', text: `question ${n}` }] }, { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] }] });
  return c;
}

module.exports = { computer, keychain, enc, dec };
