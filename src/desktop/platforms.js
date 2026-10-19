// [desktop apps] One entry per operating system the desktop tool works on. index.js keeps the whole model (approval cards, the never list, the
// banner, Stop, Esc, takeover, the live card) and asks this table only for what differs: the helper that talks to the system, the checks
// behind Esc and "you took over", how keys are written, how open_app checks what it would start, and a few words in the cards.
// Another system (Linux) gets its own entry here with the same shape; until then it answers "Not available on this platform".
'use strict';

const BACKENDS = {
  win32: {
    client: () => require('./client').createClient(),
    probe: () => require('./winapi').load(),
    parseKeys: (k) => require('./keys').parseKeys(k),
    launchable: (key) => key.endsWith('.exe'),
    notLaunchable: (name) => `${name} is a Windows (Store) app, whose program cannot be checked before it starts, so the AI does not start it. The user can open it, and the AI can then use it.`,
    notFound: (name) => `No app called "${name}" was found in the Start menu. Tell the user, or ask for the exact name.`,
    examples: 'such as Word or File Explorer',
    switchNote: 'Windows and macOS. Nothing leaves this computer except what is sent to the AI in this chat.',
    lumenExe: (execPath) => execPath,
  },
  darwin: {
    client: (deps = {}) => require('./mac-client').createMacClient(deps),
    probe: () => require('./mac-probe').load(),
    parseKeys: (k) => require('./keys').parseKeysMac(k),
    launchable: (key) => key.startsWith('/') && key.endsWith('.app'),
    notLaunchable: (name) => `${name} could not be checked before it starts, so the AI does not start it. The user can open it, and the AI can then use it.`,
    notFound: (name) => `No app called "${name}" was found in the Applications folders. Tell the user, or ask for the exact name.`,
    examples: 'such as Word or Finder',
    switchNote: 'macOS asks once for Accessibility (and Screen Recording for pictures of a window): System Settings > Privacy & Security. Nothing leaves this computer except what is sent to the AI in this chat.',
    lumenExe: (execPath) => { const m = /^(.*?\.app)(?:\/|$)/.exec(String(execPath || '')); return m ? m[1] : execPath; }, // the app is its bundle
  },
};

const backendFor = (platform) => BACKENDS[platform] || null;
const supported = (platform) => Boolean(BACKENDS[platform]);

module.exports = { backendFor, supported, BACKENDS };
