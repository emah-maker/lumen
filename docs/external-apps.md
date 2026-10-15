# Let other apps use Lumen

Claude Desktop, Cursor, VS Code (Copilot, Continue) and Claude Code can read and use pages in Lumen, through Lumen's MCP server. Each app gets a name and a token of its own, you see when it is working, and you can stop it, take over or revoke it at any time.

It is off until you turn it on: **Settings → AI → Let other apps use Lumen**.

## How it works

- Each app works in a Lumen window of its own. It never sees your tabs, Lumen's settings, saved passwords or chat history.
- Every call goes through the same rules as Lumen's own AI: sites where you turned the AI off stay off, tabs you keep the AI off stay off, and new sites ask you first (the approval card shows in the app's window; a count in your toolbar tells you one is waiting). A new app asks before it acts by default (the **Ask before it acts** box on its row), even when Settings → AI → *Ask before agents act in their own window* is off.
- The connection is Lumen's stdio bridge (`mcp.js`), which also starts Lumen if it isn't running. Claude Desktop only speaks stdio, and a local port would change on every start, so this is the one transport for all four apps.
- The token proves who the app is. The bridge never sends it: it proves it knows it for each connection (a fresh challenge every time, so a recorded proof is useless later). That protects the secret, not the channel: a program that sits on Lumen's channel and passes both sides' messages along could still use a connection the real app opens, which is why the channel is per user.
- Lumen keeps each token encrypted with your system keychain (Windows DPAPI, macOS Keychain, the Secret Service on Linux) in `external-apps.json` in the profile folder, and the token also lives in a file of its own, `external-app-tokens/<id>.token`, that only your user can read. Without a keychain Lumen makes no tokens. This keeps other users and a stolen disk out; a program running as you can read your files, as with any local app.

## Set up an app

1. Open **Settings → AI → Let other apps use Lumen** and turn it on. **Require a token for every app** is on.
2. Pick the app's tab, give it a name, and press **Add app**. The text below the tab now names the app's token file. It holds a path, not the secret, so there is nothing to copy and keep safe, and **Show setup** on the app's row brings the text back any time.
3. Paste it where the app keeps its MCP servers:

| App | Where | What you paste |
|---|---|---|
| Claude Desktop | Settings → Developer → Edit Config (`claude_desktop_config.json`). **Open the config file** opens it. | The JSON, merged into the file's `mcpServers`. Restart Claude Desktop. |
| Cursor | `~/.cursor/mcp.json`, your user-level config. | The JSON, merged into `mcpServers`. |
| VS Code | Command Palette → *MCP: Open User Configuration* (`mcp.json`). Copilot, Continue and other extensions read it. | The JSON under `servers`. |
| Claude Code | A terminal. | The `claude mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -e "LUMEN_CLIENT_TOKEN_FILE=…" -- …` command. |

**Don't put this in a project file.** `.cursor/mcp.json`, `.vscode/mcp.json` and `claude mcp add --scope project` (`.mcp.json`) are meant to be committed. The text names a token file on your computer and the bridge command, which is of no use to others, but a config committed to a repository should not point at your profile folder. Use the user-level config.

Without the file, the text holds the placeholder `PATH-OF-THE-TOKEN-FILE-FROM-ADD-APP`. The bridge reads the file named in `LUMEN_CLIENT_TOKEN_FILE`; `LUMEN_CLIENT_TOKEN` (the token itself) works too, but then the secret sits in the app's config and in the environment of every program it starts, so prefer the file. A token variable that is set but empty or points at a missing file is refused, never treated as "no token". An app that gives a wrong or revoked token is refused ("Lumen refused the connection").

When the bridge has to start Lumen, it does not pass the token, the token file or an engine tag on to it.

## Watching and stopping

- While an app is working, a pill in the toolbar says **Claude Desktop is using Lumen**, with **Stop** and **Take over**. The app's own window shows the same pill. Unverified apps (below) get the same pill.
- **Stop** ends its calls now and closes its connection. It stays approved and can connect again.
- **Take over** ends its calls now and pauses it: its next calls are refused with a note that you took over, and its window comes forward for you to use. **Resume** on the pill lets it continue.
- Tabs in an app's window say **Opened by Claude Desktop** (the app's name) in the strip and its hover card.
- When it has been quiet for a few seconds after working, a quiet notification says **Claude Desktop finished in Lumen**.
- **Revoke** in the list deletes the token and its file: the connection is cut at once, even in the middle of a call, and the token never works again.

The list shows each app's name, whether it is connected, working or paused, and when it was last used. The status line reads **Off** or **On · N apps connected**.

## Apps without a token (unverified)

A program that has no token but knows Lumen's shared connection secret (an agent added the older way, such as Claude Code with **Add to Claude Code**, Codex, Grok Build, Antigravity, or any program of yours) is an **unverified app**: the name it gives is only what it calls itself.

- **New users:** turning the switch on from this page also turns on **Require a token for every app**. Apps without a token are refused, with a note on how to set them up.
- **Someone who already had Allow AI agents to connect on** keeps token-less agents working, but each connection now waits for you: **Unverified app “Legacy App” wants to use Lumen** under the toolbar and as a notification, with **Allow this time** and **Deny**. Allow lasts that connection only, is never stored, and the app always asks before it acts. A Deny holds for ten minutes, no answer in 90 seconds counts as Deny, and no more than three prompts are open at once. Settings shows a warning while this mode is on, with a button, **Require a token for every app**, that turns it off.
- A token-less client can't use the name of an app you set up (a token app's name, or Claude Desktop, Cursor, VS Code or Claude Code): it is refused without asking, because a click on Allow would then look like your own app. To use those names, give the app a token.

Lumen's own AI engines (the sidebar's Claude Code, Grok Build, Codex and Antigravity) are not other apps: they connect with their own per-run tokens, are not asked about and are not listed here.

## Reference: the connection

For a program that speaks Lumen's channel itself (the bridge's first line, `mcp.js`): along with `lumenProof` (HMAC-SHA256 of the challenge with the profile's `mcp-token`), send `lumenClient` (the token's 12-character id) and `lumenClientProof` (HMAC-SHA256 of `client:<challenge>` with the whole token). The server answers `lumenAuth: "denied"` for an unknown id or a wrong proof.
