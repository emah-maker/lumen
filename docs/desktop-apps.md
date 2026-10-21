# The AI using other apps

Lumen's AI can operate other programs on your computer, such as Word, File Explorer or MATLAB, and the chat shows it working: a card with the app's icon, what it is doing and a live picture of the window. This works on **Windows** and **macOS** (see [On macOS](#on-macos) for the permissions a Mac asks for). On Linux the AI is told "Not available on this platform".

It is **off by default**. Turn it on in **Settings → AI → Let the AI use other apps on this computer**. If you ask for something like "fix the heading in my Word report" while it is off, the AI asks to turn it on with a card that explains what it allows.

## What the AI can do

One tool, `desktop(action, args)`, with eight actions:

| Action | What it does |
|---|---|
| `list_apps` | The open windows, by app name. Window titles are shown only for apps you have allowed. |
| `focus_app` | Brings an app forward. |
| `read_app` | Reads the window as a short outline: names, kinds, values, whether an item is disabled or checked, and an id (`e3`) for each item you can use. It is cut to a fixed size. |
| `click`, `type` | Acts on an item by its id. It uses the app's own Invoke, Value and Toggle controls first; if an item has none it focuses it and sends keys. |
| `press_keys` | A shortcut such as `ctrl+s` (`cmd+s` on a Mac). `Alt+F4`, `Alt+Tab`, `Ctrl+Alt+Delete`, `Ctrl+Esc`, `Ctrl+Shift+Esc` and the Windows key are never sent; on a Mac, `Cmd+Q`, `Cmd+Tab`, `Cmd+Space`, `Option+Cmd+Esc`, `Ctrl+Cmd+Q`, `Shift+Cmd+Q`, `Ctrl`+arrows, `fn`, `F3`, `F11` and any function key with a modifier are never sent. |
| `screenshot_app` | A picture of the window. |
| `open_app` | Starts an app by name, from the Start menu or the registered App Paths (on a Mac, the Applications folders, with `open -a`). It only starts what it finds there, never a program path or arguments it makes up. With `path` it opens one existing document in the app that owns it (`.xlsx` Excel, `.pptx` PowerPoint, `.docx` Word, `.mlx` MATLAB, `.sldprt` SolidWorks...: `src/ai/app-intent.js`): the file must be a regular file (links followed), outside Lumen's profile and the credentials folders list_files refuses, and never a program or script (.exe, .bat, .ps1, .lnk...); a name that is not the file's owner is refused. It is handed over as a single argument (Windows: the app's `.exe`, no shell; macOS: `open -a <app> -- <file>`), and the approval card names the file. |

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
- **Hold Esc** for about 0.7 seconds, or press **Ctrl+Alt+Esc** (**Control+Option+Esc** on a Mac), to stop at once. Stop kills the helper process, so typing or a click in progress ends immediately; a fresh helper starts when it is next needed. The shortcut is registered only while the AI is using an app. If the checks behind Esc and "you took over" cannot start, the AI does not use other apps at all.
- **Touch the app** (move the mouse over it, or type in it) and the AI pauses (a call in progress is cut off): the banner and the chat card say "You took over. Resume?" and the next step waits for Resume or Stop.
- The chat card has **Open** to bring the app forward, plus Resume and Stop while it works.

## How it works

Typed text is sent in pieces of at most 16 characters, and before each piece Lumen checks that the foreground window and the keyboard focus belong to the approved program and that the focused item is not a password field; if not, typing stops and the AI is told how much was typed. Where an item can be set directly (the Value pattern) that is used instead of keys, and key-by-key typing is limited to 500 characters. Everything an app tells the AI (titles, names, values) is passed inside an untrusted-content wrapper with any look-alike tag defanged.

On Windows, a small hidden PowerShell process (`src/desktop/uia-helper.ps1`) talks to Windows UI Automation and answers one JSON line per request. It starts on first use (about 0.3 s), ends on its own when idle, and is started through the same hidden-process path as Lumen's other helpers. Its window pictures and the card's live picture are made in that process, so Lumen's main process only handles the small answer. The live picture (`src/desktop/live.js`, the helper's `frame` command) follows the one window the AI works in: PrintWindow with PW_RENDERFULLCONTENT, scaled to the card (340 CSS px times the display scale, at most 2x), compared with the last picture sent and encoded as a JPEG only when it changed. About 6 pictures a second while the window changes, about 2 looks a second while it stands still (nothing is sent), 1.4 a second in Light graphics or software drawing; nothing while the card is off screen, the window is minimized, hidden or on another desktop, a call is running in the app, the person took over, or the run is over. Before each look the policy is asked again, the helper checks the window still belongs to the approved program, and a changed window title is judged before anything is captured: a window that turned into a blocked program is not captured, the session ends and the card shows no preview. Pictures are shown in the card only; they are not saved. Everything lives in `src/desktop/` and loads on first use, not at startup.

## On macOS

The same tool, cards, never list, banner, Stop, Esc and live card, built only from what macOS has (nothing is installed):

- **Reading and operating windows**: System Events, through `osascript -l JavaScript` (`src/desktop/mac-helper.jxa`, one short run per call). `read_app` reads the window's accessibility tree; each item's id (`e3`) stands for its place in that tree, and a click or typing is refused if the item there no longer has the same role, name and description ("read the app again"). An item with neither a name nor a description gets no id unless it is the only one of its kind in the window (a document's text area). Two windows of one app at exactly the same place and size are told apart by the approved title; if that does not single one out, the call is refused. A click uses the item's own press action, and clicks at its centre only when it has none. Typing sets the field's value where it can. Otherwise Lumen first confirms the keyboard focus is on that item (or refuses), then types in pieces of 16 characters. Before every key it sends (each piece, each `press_keys` chord, Cmd+A, Enter) it checks that the approved app is in front and the focus is not a password field; a focus it cannot read counts as one, so nothing is sent. Secure text fields are never read: not their name, not their value.
- **Pictures**: `screencapture -l <window id> -x`, into a file in Lumen's temp folder that is deleted as soon as it is read.
- **open_app**: `open -a` on an app it found in `/Applications`, `/Applications/Utilities`, `/System/Applications` (and its Utilities) or `~/Applications`. Its bundle id is read from `Contents/Info.plist` (with `plutil`) first, so a blocked app under another name is refused before it starts, and an app whose id cannot be read is not started.
- **Esc and "you took over"**: a small `osascript` (`src/desktop/mac-probe.jxa`) runs only while the AI is using an app and reports about 8 times a second whether Esc, a typing key or a mouse button is down (never which characters), where the pointer is and which app is in front. If it stops reporting, the AI stops: it does not use apps without these checks.

An app on a Mac is its **app bundle path** (`/Applications/Microsoft Word.app`); its bundle id (`com.microsoft.Word`) also counts for the never list, so a renamed copy of Terminal is still Terminal. Never available on a Mac: Keychain Access, Passwords, 1Password, Bitwarden and other password managers; System Settings (all of it, which covers its security panes), Activity Monitor, Script Editor, Automator, Shortcuts, Disk Utility and installers; banking and finance apps and a browser window showing a bank; password prompts (SecurityAgent), the login window and the screen saver; Lumen itself; and Terminal, iTerm, Warp, Ghostty, kitty and other terminals unless **Also allow terminals** is on. Finder and code editors carry the "can start a terminal" warning on their card. Known document apps (same-app exemption) on a Mac are Word, Excel, PowerPoint, TextEdit, Pages, Numbers and Keynote. v1 reads the window only, not the menu bar: use `press_keys` for menu shortcuts.

### Permissions

macOS asks the user, not Lumen, to allow this. Lumen never turns a permission on and does not trigger the system prompt on purpose: it checks without prompting, and when one is missing the AI gets a card, **Lumen needs the macOS … permission**, with an **Open System Settings** button that opens the right pane.

1. **Accessibility** (needed for everything): System Settings → Privacy & Security → **Accessibility**, turn on **Lumen**. It works right away.
2. **Screen Recording** (only for `screenshot_app` and the card's live picture; `read_app` works without it): System Settings → Privacy & Security → **Screen & System Audio Recording**, turn on **Lumen**, then quit and reopen Lumen.
3. **Automation** (asked by macOS the first time Lumen talks to System Events): allow **System Events**. If it was refused, System Settings → Privacy & Security → **Automation** → Lumen → turn on **System Events**.

To take any of it back, turn Lumen off in the same panes, or turn off the switch in Settings → AI.

Tests: `test/desktop-units.js` (permissions, pruning, keys, schema, the controller with a stand-in helper), `test/desktop-mac-units.js` (the macOS backend with a stand-in `execFile`: argument building, the tree and its ids, permission errors and the Settings card, the macOS never list and keys; it never runs `osascript`) and `test/desktop-apps.js` (a real WPF test window of its own, never a user app; Windows only).
