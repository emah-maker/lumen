// [desktop apps] What the AI may and may not do in other programs on this computer (Settings > AI, "Let the AI use other apps on
// this computer"). Pure functions of their inputs, so test/desktop-units.js runs them in plain Node.
//
// Three layers, checked in this order for every call:
//   1. never: windows the AI is never given, whatever the settings or the user's answers say (blockedReason). The AI is told plainly.
//   2. the master switch (aiDesktopControl, off by default).
//   3. the app itself: allowed always (Settings list), allowed once (this chat), or ask on a card.
// A password field is a fourth, separate rule that lives next to the tree reader (tree.js): its node never leaves the helper's
// output, and typing into one is refused.
'use strict';

// Process names are lower case without ".exe".
const SECURITY = new Set([
  'consent', // UAC prompts
  'logonui', 'lockapp', 'winlogon', 'credentialuibroker', 'credwiz', 'windowsterminalcredential', // sign-in, lock screen, credential UI
  'securityhealthsystray', 'securityhealthhost', 'sechealthui', 'smartscreen', 'mpcmdrun', 'msascui', // Windows Security
  'useraccountcontrolsettings', 'sdclt',
]);
const SYSTEM = new Set([ // settings that change the computer itself
  'systemsettings', 'regedit', 'mmc', 'gpedit', 'secpol', 'control', 'taskschd', 'compmgmt', 'lusrmgr', 'msconfig', 'dism',
]);
const PASSWORD_MANAGERS = new Set([
  '1password', '1passwordcli', 'bitwarden', 'keepass', 'keepassxc', 'keepass2', 'dashlane', 'lastpass', 'nordpass', 'enpass',
  'roboform', 'keeper', 'keeperpasswordmanager', 'protonpass', 'proton pass', 'passwordsafe', 'psafe3', 'logmeonce', 'stickypassword',
]);
const FINANCE = new Set([
  'quicken', 'qbw32', 'quickbooks', 'moneydance', 'ynab', 'turbotax', 'taxact', 'hrblock', 'coinbase', 'exodus', 'ledgerlive', 'ledger live',
  'electrum', 'trezor suite', 'trezorsuite', 'atomicwallet', 'wasabi', 'bisq', 'schwab', 'fidelity', 'etrade', 'robinhood', 'webull',
  'thinkorswim', 'tradingview', 'ninjatrader', 'metatrader', 'terminal64', 'paypal', 'venmo', 'zelle', 'bankofamerica', 'chase',
  'wellsfargo', 'citi', 'capitalone', 'quickenwillmaker', 'mintmobile',
]);
// Finance windows by title, for a browser showing a bank (the process is the browser's, so the process list cannot tell).
const FINANCE_TITLE = /\b(online banking|internet banking|bank of america|chase online|wells fargo|citibank|capital one|paypal|venmo|coinbase|robinhood|charles schwab|fidelity investments|e\*?trade|vanguard|interactive brokers|zelle|wire transfer|checkout|credit card number)\b/i;
const SECURITY_TITLE = /^(windows security|user account control|windows defender|credential manager|windows hello|sign in to your account|lock screen)\b/i;
const PASSWORD_TITLE = /\b(1password|bitwarden|keepass|lastpass|dashlane|nordpass|enpass|roboform|password manager)\b/i;
const TERMINALS = new Set([
  'cmd', 'powershell', 'powershell_ise', 'pwsh', 'windowsterminal', 'wt', 'conhost', 'openconsole', 'mintty', 'wsl', 'wslhost', 'bash', 'sh',
  'ubuntu', 'debian', 'alacritty', 'wezterm', 'wezterm-gui', 'hyper', 'tabby', 'cmder', 'conemu64', 'conemu', 'putty', 'kitty', 'terminus',
]);

const procKey = (proc) => String(proc || '').trim().toLowerCase().replace(/\.exe$/, '');

// A friendly name for the approval card and the settings list. Falls back to the program's own description, then its process name.
const FRIENDLY = {
  winword: 'Microsoft Word', excel: 'Microsoft Excel', powerpnt: 'Microsoft PowerPoint', outlook: 'Microsoft Outlook', onenote: 'Microsoft OneNote',
  msaccess: 'Microsoft Access', mspub: 'Microsoft Publisher', visio: 'Microsoft Visio', winproj: 'Microsoft Project', teams: 'Microsoft Teams', ms_teams: 'Microsoft Teams',
  explorer: 'File Explorer', matlab: 'MATLAB', notepad: 'Notepad', mspaint: 'Paint', calc: 'Calculator', calculatorapp: 'Calculator',
  code: 'Visual Studio Code', devenv: 'Visual Studio', chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Firefox', brave: 'Brave',
  slack: 'Slack', discord: 'Discord', spotify: 'Spotify', zoom: 'Zoom', acrord32: 'Adobe Acrobat', acrobat: 'Adobe Acrobat', photoshop: 'Adobe Photoshop',
  soffice: 'LibreOffice', 'soffice.bin': 'LibreOffice', obsidian: 'Obsidian', notion: 'Notion', figma: 'Figma', vlc: 'VLC', wmplayer: 'Windows Media Player',
};
function friendlyName(proc, description = '') {
  const key = procKey(proc);
  if (FRIENDLY[key]) return FRIENDLY[key];
  const d = String(description || '').trim();
  if (d && d.length <= 60 && !/^[a-z0-9_.-]+$/.test(d)) return d;
  const base = String(proc || '').replace(/\.exe$/i, '');
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'this app';
}

// win: { proc, title, pid, exe } as the helper reports a top-level window. opts: { lumenPid, lumenExe, terminals }.
// Returns '' when nothing blocks it, else the sentence the AI is told (and the user may see).
function blockedReason(win, opts = {}) {
  const proc = procKey(win?.proc);
  const title = String(win?.title || '');
  const exe = String(win?.exe || '').toLowerCase();
  if (!proc && !title) return 'That window could not be identified, so the AI does not use it.';
  const lumenExe = String(opts.lumenExe || '').toLowerCase();
  if ((opts.lumenPid && Number(win?.pid) === Number(opts.lumenPid)) || proc === 'lumen' || (lumenExe && exe && exe === lumenExe)) {
    return 'That is Lumen itself. The AI does not operate its own window; use the browser tools instead.';
  }
  if (SECURITY.has(proc) || SECURITY_TITLE.test(title)) return 'That is a Windows security, sign-in or permission prompt (UAC, Windows Security, the lock screen). The AI never uses these; the user has to answer them.';
  if (SYSTEM.has(proc)) return 'That changes Windows settings, which the AI does not touch. The user can do it themselves.';
  if (PASSWORD_MANAGERS.has(proc) || PASSWORD_TITLE.test(title)) return 'That is a password manager. The AI never uses password managers.';
  if (FINANCE.has(proc) || FINANCE_TITLE.test(title)) return 'That is a banking or finance app. The AI does not use these; the user can do it themselves.';
  if (TERMINALS.has(proc) && opts.terminals !== true) return 'That is a terminal. The AI does not use terminals unless the user allows it in Settings > AI (a terminal can run anything on this computer).';
  return '';
}

const appKey = (win) => procKey(win?.proc);

// The decision for one window.
//   opts: { master, terminals, allowed: Iterable<{app}|string>, once: Set<string>, lumenPid, lumenExe }
//   returns { status: 'blocked' | 'off' | 'allow' | 'ask', reason, app, name, always }
function decide(win, opts = {}) {
  const app = appKey(win);
  const name = friendlyName(win?.proc, win?.description);
  const reason = blockedReason(win, opts);
  if (reason) return { status: 'blocked', reason, app, name };
  if (opts.master !== true) return { status: 'off', reason: OFF_TEXT, app, name };
  const always = new Set([...(opts.allowed || [])].map((a) => procKey(typeof a === 'string' ? a : a?.app)));
  if (always.has(app)) return { status: 'allow', app, name, always: true };
  if (opts.once && opts.once.has(app)) return { status: 'allow', app, name, always: false };
  return { status: 'ask', app, name };
}

const OFF_TEXT = 'Using other apps on this computer is off. The user can turn on Settings > AI > "Let the AI use other apps on this computer".';
const NOT_WINDOWS = 'Not available on this platform. Operating other apps works on Windows only for now.';

// The Settings list: [{ app, name, added }], valid entries only, no duplicates, nothing that is never allowed.
const MAX_APPS = 100;
function clean(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const raw = typeof item === 'string' ? { app: item } : item && typeof item === 'object' ? item : null;
    if (!raw) continue;
    const app = procKey(raw.app);
    if (!/^[a-z0-9][a-z0-9 ._-]{0,63}$/.test(app) || seen.has(app)) continue;
    if (blockedReason({ proc: app, title: 'x' }, { terminals: true, lumenPid: 0 })) continue; // a never-app is never listed (terminals are a separate switch)
    seen.add(app);
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : friendlyName(app);
    const added = Number.isFinite(Number(raw.added)) && Number(raw.added) > 0 ? Math.round(Number(raw.added)) : 0;
    out.push({ app, name, added });
  }
  return out.slice(-MAX_APPS);
}

// The step the chat shows while the AI uses an app.
function stepLabel(action, args = {}, name = '') {
  const app = name ? ` in ${name}` : '';
  switch (action) {
    case 'list_apps': return 'Looking at the open apps';
    case 'focus_app': return `Switching to ${args.name || args.id || 'an app'}`;
    case 'read_app': return `Reading ${name || 'the app'}`;
    case 'click': return `Clicking ${args.element ? `item ${args.element}` : 'an item'}${app}`;
    case 'type': return `Typing into ${args.element ? `item ${args.element}` : 'a field'}${app}`;
    case 'press_keys': return `Pressing ${String(args.keys || 'keys').slice(0, 40)}${app}`;
    case 'screenshot_app': return `Looking at ${name || 'the app'}`;
    case 'open_app': return `Opening ${args.name || 'an app'}`;
    default: return 'Using another app';
  }
}

module.exports = {
  blockedReason, decide, clean, friendlyName, stepLabel, procKey, appKey, OFF_TEXT, NOT_WINDOWS, MAX_APPS,
  TERMINALS, SECURITY, PASSWORD_MANAGERS, FINANCE,
};
