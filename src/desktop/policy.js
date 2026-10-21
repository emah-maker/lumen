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

// Process names are lower case without ".exe" (or ".app"). On macOS an app's bundle id (lower case) is one more name it goes by, so each set
// below lists the Windows program names, the macOS app names and the macOS bundle ids together.
const SECURITY = new Set([
  'consent', // UAC prompts
  'logonui', 'lockapp', 'winlogon', 'credentialuibroker', 'credwiz', 'windowsterminalcredential', // sign-in, lock screen, credential UI
  'securityhealthsystray', 'securityhealthhost', 'sechealthui', 'smartscreen', 'mpcmdrun', 'msascui', // Windows Security
  'useraccountcontrolsettings', 'sdclt',
  // macOS: the password and permission prompts, the login window and the lock screen
  'securityagent', 'com.apple.securityagent', 'loginwindow', 'com.apple.loginwindow', 'coreservicesuiagent', 'com.apple.coreservices.uiagent',
  'universalaccessauthwarn', 'com.apple.accessibility.universalaccessauthwarn', 'screensaverengine', 'com.apple.screensaver.engine', 'authorizationhost',
]);
const SYSTEM = new Set([ // settings that change the computer itself
  'systemsettings', 'regedit', 'mmc', 'gpedit', 'secpol', 'control', 'taskschd', 'compmgmt', 'lusrmgr', 'msconfig', 'dism',
  'taskmgr', 'mstsc', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'netplwiz', 'wf', 'cleanmgr', 'diskmgmt', 'eventvwr', // task manager (Run new task), scripting hosts and installers: code execution
  // macOS: System Settings (all of it: its security panes live inside the one app), and the tools that run code, install or change the disk
  'system settings', 'system preferences', 'com.apple.systempreferences', 'com.apple.settings', 'activity monitor', 'com.apple.activitymonitor',
  'script editor', 'com.apple.scripteditor2', 'automator', 'com.apple.automator', 'shortcuts', 'com.apple.shortcuts', 'disk utility', 'com.apple.diskutility',
  'directory utility', 'com.apple.directoryutility', 'installer', 'com.apple.installer', 'migration assistant', 'com.apple.migrateassistant', 'boot camp assistant',
]);
const PASSWORD_MANAGERS = new Set([
  '1password', '1passwordcli', 'bitwarden', 'keepass', 'keepassxc', 'keepass2', 'dashlane', 'lastpass', 'nordpass', 'enpass',
  'roboform', 'keeper', 'keeperpasswordmanager', 'protonpass', 'proton pass', 'passwordsafe', 'psafe3', 'logmeonce', 'stickypassword',
  // macOS
  'keychain access', 'com.apple.keychainaccess', 'passwords', 'com.apple.passwords', '1password 7', 'com.1password.1password', 'com.agilebits.onepassword7',
  'com.bitwarden.desktop', 'com.lastpass.lastpassmacdesktop', 'com.dashlane.dashlanephonefinal', 'com.nordsec.nordpass', 'in.sinew.enpass-desktop',
  'strongbox', 'com.markmcguill.strongbox.mac', 'macpass', 'com.hicknhacksoftware.macpass', 'org.keepassxc.keepassxc', 'me.proton.pass.electron',
]);
const FINANCE = new Set([
  'quicken', 'qbw32', 'quickbooks', 'moneydance', 'ynab', 'turbotax', 'taxact', 'hrblock', 'coinbase', 'exodus', 'ledgerlive', 'ledger live',
  'electrum', 'trezor suite', 'trezorsuite', 'atomicwallet', 'wasabi', 'bisq', 'schwab', 'fidelity', 'etrade', 'robinhood', 'webull',
  'thinkorswim', 'tradingview', 'ninjatrader', 'metatrader', 'terminal64', 'paypal', 'venmo', 'zelle', 'bankofamerica', 'chase',
  'wellsfargo', 'citi', 'capitalone', 'quickenwillmaker', 'mintmobile',
  'banktivity', 'moneymoney', 'com.quicken.quicken', 'com.ledger.live', 'com.coinbase.wallet', 'com.robinhood.release.robinhood',
]);
// Finance windows by title, for a browser showing a bank (the process is the browser's, so the process list cannot tell).
const FINANCE_TITLE = /\b(online banking|internet banking|bank of america|chase online|wells fargo|citibank|capital one|paypal|venmo|coinbase|robinhood|charles schwab|fidelity investments|e\*?trade|vanguard|interactive brokers|zelle|wire transfer|checkout|credit card number)\b/i;
const SECURITY_TITLE = /^(windows security|user account control|windows defender|credential manager|windows hello|sign in to your account|lock screen|privacy & security|touch id & password|login password|users & groups)\b/i;
const PASSWORD_TITLE = /\b(1password|bitwarden|keepass|lastpass|dashlane|nordpass|enpass|roboform|password manager|keychain access)\b/i;
const TERMINALS = new Set([
  'cmd', 'powershell', 'powershell_ise', 'pwsh', 'windowsterminal', 'wt', 'conhost', 'openconsole', 'mintty', 'wsl', 'wslhost', 'bash', 'sh',
  'ubuntu', 'debian', 'alacritty', 'wezterm', 'wezterm-gui', 'hyper', 'tabby', 'cmder', 'conemu64', 'conemu', 'putty', 'kitty', 'terminus',
  // macOS
  'terminal', 'com.apple.terminal', 'iterm', 'iterm2', 'com.googlecode.iterm2', 'warp', 'dev.warp.warp-stable', 'ghostty', 'com.mitchellh.ghostty',
  'net.kovidgoyal.kitty', 'org.alacritty', 'com.github.wez.wezterm', 'co.zeit.hyper', 'org.tabby',
]);

const procKey = (proc) => String(proc || '').trim().toLowerCase().replace(/\.(exe|app)$/, '');
// An app is its full image path, lower case with backslashes: "winword.exe" in another folder is another app. On macOS it is the full path
// of the app bundle ("/applications/microsoft word.app"), which keeps its forward slashes.
const exeKey = (p) => { const s = String(p || '').trim().toLowerCase(); return s.startsWith('/') ? s.replace(/\/+$/, '') : s.replace(/\//g, '\\'); };
const baseOf = (p) => procKey(exeKey(p).split(/[\\/]/).pop());
// Every name this window's program goes by: the file name, the process name and the name the file says it was built as (OriginalFilename);
// on macOS also the app's bundle id.
const identities = (win) => [...new Set([baseOf(win?.exe), procKey(win?.proc), procKey(win?.original), String(win?.bundle || '').trim().toLowerCase()].filter(Boolean))];

// A friendly name for the approval card and the settings list. Falls back to the program's own description, then its process name.
// (Names that look like markup are cleaned: they come from the program and are shown to the AI.)
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
  const d = String(description || '').replace(/[<>"`]/g, '').trim();
  if (d && d.length <= 60 && !/^[a-z0-9_.-]+$/.test(d)) return d;
  const base = String(proc || '').replace(/\.exe$/i, '').replace(/[<>"`]/g, '');
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'this app';
}

// win: { proc, title, pid, exe } as the helper reports a top-level window. opts: { lumenPid, lumenExe, terminals }.
// Returns '' when nothing blocks it, else the sentence the AI is told (and the user may see).
function blockedReason(win, opts = {}) {
  const ids = identities(win);
  const hit = (set) => ids.some((id) => set.has(id));
  const title = String(win?.title || '');
  const exe = exeKey(win?.exe);
  if (!ids.length && !title) return 'That window could not be identified, so the AI does not use it.';
  const lumenExe = opts.lumenExe || '';
  if (ids.includes('applicationframehost')) return 'That is a Windows app window whose program could not be identified (it is hosted by ApplicationFrameHost), so the AI does not use it. Windows Settings, Windows Security and others live in such windows.';
  if ((opts.lumenPid && (Number(win?.pid) === Number(opts.lumenPid) || Number(win?.hpid) === Number(opts.lumenPid))) || ids.includes('lumen') || (lumenExe && exe && exe === exeKey(lumenExe))) {
    return 'That is Lumen itself. The AI does not operate its own window; use the browser tools instead.';
  }
  if (hit(SECURITY) || SECURITY_TITLE.test(title)) return 'That is a security, sign-in or permission prompt (UAC, Windows Security, the lock screen, a macOS password prompt or the login window). The AI never uses these; the user has to answer them.';
  if (hit(SYSTEM)) return 'That changes the computer\'s own settings or runs code (Windows Settings, System Settings, Task Manager, Activity Monitor, script tools, installers), which the AI does not touch. The user can do it themselves.';
  if (hit(PASSWORD_MANAGERS) || PASSWORD_TITLE.test(title)) return 'That is a password manager. The AI never uses password managers.';
  if (hit(FINANCE) || FINANCE_TITLE.test(title)) return 'That is a banking or finance app. The AI does not use these; the user can do it themselves.';
  if (hit(TERMINALS) && opts.terminals !== true) return 'That is a terminal. The AI does not use terminals unless the user allows it in Settings > AI (a terminal can run anything on this computer).';
  return '';
}

const appKey = (win) => exeKey(win?.exe);
// Document-type programs: text read from one is the user's own document, so acting in that same program needs no new card. Everything else
// (browsers, mail, chat, file managers, shells, and any program not listed) is treated like web content: text read from it taints acting everywhere.
const DOCUMENT_APPS = new Set(['winword', 'excel', 'powerpnt', 'notepad', 'matlab',
  'microsoft word', 'microsoft excel', 'microsoft powerpoint', 'textedit', 'pages', 'numbers', 'keynote', // macOS, by name and by bundle id
  'com.microsoft.word', 'com.microsoft.excel', 'com.microsoft.powerpoint', 'com.apple.textedit', 'com.apple.iwork.pages', 'com.apple.iwork.numbers', 'com.apple.iwork.keynote']);
const isDocumentApp = (win) => { const ids = identities(win); return ids.length > 0 && ids.some((id) => DOCUMENT_APPS.has(id)) && !ids.some((id) => NOT_DOCUMENT.has(id)); };
const NOT_DOCUMENT = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'opera_gx', 'arc', 'outlook', 'olk', 'thunderbird', 'teams', 'ms-teams', 'slack', 'discord', 'whatsapp', 'telegram', 'zoom', 'messenger', 'explorer', 'cmd', 'powershell', 'pwsh', 'windowsterminal', 'code', 'devenv',
  'safari', 'google chrome', 'microsoft edge', 'mail', 'microsoft outlook', 'messages', 'microsoft teams', 'finder', 'terminal', 'visual studio code',
  'com.apple.safari', 'com.google.chrome', 'com.apple.mail', 'com.microsoft.outlook', 'com.apple.mobilesms', 'com.apple.finder', 'com.apple.terminal', 'com.microsoft.vscode']);
// Programs that are not terminals but can start one (or run anything) from inside: the card says so.
const SHELL_CAPABLE = new Set(['explorer', 'code', 'devenv', 'cursor', 'windsurf', 'idea64', 'pycharm64', 'rider64', 'sublime_text', 'notepad++',
  'finder', 'com.apple.finder', 'visual studio code', 'com.microsoft.vscode', 'xcode', 'com.apple.dt.xcode', 'sublime text', 'com.sublimetext.4', 'intellij idea', 'pycharm']);
const WARN_SHELL = 'Note: this program can also start a terminal or run commands (its address bar, "Open in terminal", a built-in terminal), so allowing it can let the AI run things.';

// The decision for one window.
//   opts: { master, terminals, allowed: Iterable<{app}|string>, once: Set<string>, lumenPid, lumenExe }
//   returns { status: 'blocked' | 'off' | 'allow' | 'ask', reason, app, name, always }
function decide(win, opts = {}) {
  const app = appKey(win);
  const name = friendlyName(win?.proc || baseOf(win?.exe), win?.description);
  const reason = blockedReason(win, opts);
  if (reason) return { status: 'blocked', reason, app, name };
  if (opts.master !== true) return { status: 'off', reason: OFF_TEXT, app, name };
  if (!app) return { status: 'blocked', reason: 'Which program this window belongs to could not be verified (its file could not be read), so the AI does not use it.', app, name };
  const warn = identities(win).some((id) => SHELL_CAPABLE.has(id)) ? WARN_SHELL : '';
  const always = new Set([...(opts.allowed || [])].map((a) => exeKey(typeof a === 'string' ? a : a?.app)));
  if (always.has(app)) return { status: 'allow', app, name, always: true, warn };
  if (opts.once && opts.once.has(app)) return { status: 'allow', app, name, always: false, warn };
  return { status: 'ask', app, name, warn };
}

const OFF_TEXT = 'Using other apps on this computer is off. The user can turn on Settings > AI > "Let the AI use other apps on this computer".';
const NOT_WINDOWS = 'Not available on this platform. Operating other apps works on Windows and macOS for now.';
const NOT_SUPPORTED = NOT_WINDOWS;

// The Settings list: [{ app, name, added }], valid entries only, no duplicates, nothing that is never allowed.
const MAX_APPS = 100;
function clean(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const raw = typeof item === 'string' ? { app: item } : item && typeof item === 'object' ? item : null;
    if (!raw) continue;
    const app = exeKey(raw.app);
    if (!(/^[a-z]:\\[^<>"|?*\0]{1,250}\.exe$/.test(app) || /^\/[^<>"|?*\0\\]{1,250}\.app$/.test(app)) || seen.has(app)) continue; // a full image path (or a macOS app bundle): a bare name is not an app
    if (blockedReason({ proc: baseOf(app), exe: app, title: 'x' }, { terminals: true, lumenPid: 0 })) continue; // a never-app is never listed (terminals are a separate switch)
    seen.add(app);
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : friendlyName(baseOf(app));
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

// The step with the window it is in, as the Word card says it ("Reading Excel — Budget.xlsx"): the title minus a trailing " - <App>", clipped; unchanged when that adds nothing.
function withWindow(label, win) {
  const name = String(win?.name || '');
  let title = String(win?.title || '').replace(/\s+/g, ' ').trim();
  for (const sep of [' - ', ' – ', ' — ']) if (name && title.toLowerCase().endsWith(sep + name.toLowerCase())) title = title.slice(0, title.length - sep.length - name.length).trim(); // (a trailing " - <App>")
  if (!name || !title || title.toLowerCase() === name.toLowerCase() || !String(label).includes(name) || String(label).includes(title)) return label;
  return `${label} — ${title.length > 60 ? `${title.slice(0, 59)}…` : title}`;
}

module.exports = {
  withWindow, blockedReason, decide, clean, isDocumentApp, DOCUMENT_APPS, friendlyName, stepLabel, procKey, exeKey, baseOf, identities, appKey, WARN_SHELL, OFF_TEXT, NOT_WINDOWS, NOT_SUPPORTED, MAX_APPS,
  TERMINALS, SECURITY, SYSTEM, PASSWORD_MANAGERS, FINANCE,
};
