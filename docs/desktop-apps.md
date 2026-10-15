# The AI using other apps

Lumen's AI can operate other programs on your computer, such as Word, File Explorer or MATLAB, and the chat shows it working: a card with the app's icon, what it is doing and a live picture of the window. This works on **Windows**. On macOS the AI is told "Not available on this platform".

It is **off by default**. Turn it on in **Settings → AI → Let the AI use other apps on this computer**. If you ask for something like "fix the heading in my Word report" while it is off, the AI asks to turn it on with a card that explains what it allows.

## What the AI can do

One tool, `desktop(action, args)`, with eight actions:

| Action | What it does |
|---|---|
| `list_apps` | The open windows, by app name. Window titles are shown only for apps you have allowed. |
| `focus_app` | Brings an app forward. |
| `read_app` | Reads the window as a short outline: names, kinds, values, whether an item is disabled or checked, and an id (`e3`) for each item you can use. It is cut to a fixed size. |
| `click`, `type` | Acts on an item by its id. It uses the app's own Invoke, Value and Toggle controls first; if an item has none it focuses it and sends keys. |
| `press_keys` | A shortcut such as `ctrl+s`. `Alt+F4`, `Alt+Tab`, `Ctrl+Alt+Delete`, `Ctrl+Esc`, `Ctrl+Shift+Esc` and the Windows key are never sent. |
| `screenshot_app` | A picture of the window. |
| `open_app` | Starts an app by name, from the Start menu or the registered App Paths. It only starts what it finds there, never a path or arguments it makes up. |

The tool is only in the AI's request while the switch is on, or when the conversation asks for an app, so it costs nothing otherwise. What an app shows is treated as untrusted content, the same as a web page: after reading one, the AI needs your OK for each new site it wants to open.

## Who decides

1. **Each app asks first.** "Allow the AI to use Microsoft Word?" with **Allow for this chat** (once), **Always allow this app**, or **Don't allow**. The card shows the program's full path. An app is its **full path**: a program that merely has the same file name (or is a renamed copy of a blocked one: Lumen also reads the name built into the file) does not inherit an approval, and a window whose program cannot be verified is not used. For Store (UWP) apps, which Windows hosts in ApplicationFrameHost windows, the app is the program inside the window, so approving Calculator does not approve other Store apps and the blocked list sees Windows Settings and Windows Security. Bypass permissions does not answer this card for you. Always adds the app to **Settings → AI → Apps the AI can use**, where **Revoke** removes it.
   **When an answer stops covering an action.** Text the AI has read could have been written to steer it, so Always and Once stop covering clicks, typing, key presses and app starts in two cases, and each such action then asks a fresh card saying what it wants to do (reading stays allowed):
   - **It read web, email or connector content** in this chat: every acting call asks, in every app.
   - **It read text from an app** (read_app, focus_app, a screenshot, or the window titles in list_apps): only acting in a *different* app asks. Reading Word and then typing in Word uses the answer you already gave; reading Word and then typing in Excel asks. Only known **document programs** (Word, Excel, PowerPoint, Notepad, MATLAB) get that same-app exemption, because their text is your own document. Text read from a browser, a mail or chat app (Outlook, Thunderbird, Teams, Slack, Discord and similar), File Explorer or a shell-capable app, or from any program not on the document list, counts like web content: after reading it, acting anywhere in the chat (that same program included) asks. Which app a piece of text came from is tracked per program (its path plus the running instance), for the length of one reply.
2. **Never available, with no override.** The AI is told plainly why when it tries:
   - password fields (the item is left out of what it reads, and typing into one is refused; fields whose name says password, PIN or secret count too);
   - Windows security, UAC (`consent.exe`), credential, lock-screen and sign-in windows;
   - password managers (1Password, Bitwarden, KeePass and others);
   - banking and finance apps, and a browser window showing a bank;
   - Windows Settings, the Registry Editor, Task Manager, script hosts, installers and similar tools that change the computer or run code;
   - Lumen's own window;
   - terminals (Command Prompt, PowerShell, Windows Terminal), unless you turn on **Also allow terminals**, which warns that a terminal can run anything.
3. **Hands-off mode** stops the AI clicking and typing in apps too; reading still works.

## You stay in control

- A small banner stays at the top of the screen while it works: **The AI is using Word · Stop**. It never takes focus and clicks go through it, except on its buttons.
- **Hold Esc** for about 0.7 seconds, or press **Ctrl+Alt+Esc**, to stop at once. Stop kills the helper process, so typing or a click in progress ends immediately; a fresh helper starts when it is next needed. The shortcut is registered only while the AI is using an app. If the checks behind Esc and "you took over" cannot start, the AI does not use other apps at all.
- **Touch the app** (move the mouse over it, or type in it) and the AI pauses (a call in progress is cut off): the banner and the chat card say "You took over. Resume?" and the next step waits for Resume or Stop.
- The chat card has **Open** to bring the app forward, plus Resume and Stop while it works.

## How it works

Typed text is sent in pieces of at most 16 characters, and before each piece Lumen checks that the foreground window and the keyboard focus belong to the approved program and that the focused item is not a password field; if not, typing stops and the AI is told how much was typed. Where an item can be set directly (the Value pattern) that is used instead of keys, and key-by-key typing is limited to 500 characters. Everything an app tells the AI (titles, names, values) is passed inside an untrusted-content wrapper with any look-alike tag defanged.

A small hidden PowerShell process (`src/desktop/uia-helper.ps1`) talks to Windows UI Automation and answers one JSON line per request. It starts on first use (about 0.3 s), ends on its own when idle, and is started through the same hidden-process path as Lumen's other helpers. Its window pictures and the card's thumbnails (every 1.5 s) are made in that process, so Lumen's main process only handles the small answer. Everything lives in `src/desktop/` and loads on first use, not at startup.

Tests: `test/desktop-units.js` (permissions, pruning, keys, schema, the controller with a stand-in helper) and `test/desktop-apps.js` (a real WPF test window of its own, never a user app).
