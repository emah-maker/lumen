# Let other apps use Lumen

Claude Desktop, Cursor, VS Code (Copilot, Continue) and Claude Code can read and use pages in Lumen, through Lumen's MCP server. Each app gets a name and a token of its own, you see when it is working, and you can stop it, take over or revoke it at any time.

It is off until you turn it on: **Settings → AI → Let other apps use Lumen**.

## How it works

- Each app works in a Lumen window of its own. It never sees your tabs, Lumen's settings, saved passwords or chat history.
- Every call goes through the same rules as Lumen's own AI: sites where you turned the AI off stay off, tabs you keep the AI off stay off, and new sites ask you first (the approval card shows in the app's window; a count in your toolbar tells you one is waiting). **Ask before it acts** on an app makes it ask for every new site even when Settings → AI → *Ask before agents act in their own window* is off.
- The connection is Lumen's stdio bridge (`mcp.js`), which also starts Lumen if it isn't running. Claude Desktop only speaks stdio, and a local port would change on every start, so this is the one transport for all four apps.
- The token never crosses the connection: the bridge proves it knows it, the way it proves Lumen's own per-run token. Lumen keeps each token encrypted with your system keychain (Windows DPAPI, macOS Keychain, the Secret Service on Linux) in `external-apps.json` in the profile folder. Without a keychain Lumen makes no tokens.

## Set up an app

1. Open **Settings → AI → Let other apps use Lumen** and turn it on.
2. Pick the app's tab, give it a name, and press **Add app**. The text below the tab now holds its token. **Copy it now**: Lumen can't show the token again. If you lose it, revoke the app and add it again.
3. Paste it where the app keeps its MCP servers:

| App | Where | What you paste |
|---|---|---|
| Claude Desktop | Settings → Developer → Edit Config (`claude_desktop_config.json`). **Open the config file** opens it. | The JSON, merged into the file's `mcpServers`. Restart Claude Desktop. |
| Cursor | `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a project. | The JSON, merged into `mcpServers`. |
| VS Code | Command Palette → *MCP: Open User Configuration* (`mcp.json`). Copilot, Continue and other extensions read it. | The JSON under `servers`. |
| Claude Code | A terminal. | The `claude mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -e LUMEN_CLIENT_TOKEN=… -- …` command. |

Without a token, the text holds the placeholder `PASTE-THE-TOKEN-FROM-ADD-APP`.

The token goes in the environment variable `LUMEN_CLIENT_TOKEN` of the bridge command. An app that gives a wrong or revoked token is refused ("Lumen refused the connection").

## Watching and stopping

- While an app is working, a pill in the toolbar says **Claude Desktop is using Lumen**, with **Stop** and **Take over**. The app's own window shows the same pill.
- **Stop** ends its calls now and closes its connection. It stays approved and can connect again.
- **Take over** ends its calls now and pauses it: its next calls are refused with a note that you took over, and its window comes forward for you to use. **Resume** on the pill lets it continue.
- Tabs in an app's window say **Opened by Claude Desktop** (the app's name) in the strip and its hover card.
- When it has been quiet for a few seconds after working, a quiet notification says **Claude Desktop finished in Lumen**.
- **Revoke** in the list deletes the token: the connection is cut at once and the token never works again.

The list shows each app's name, whether it is connected, working or paused, and when it was last used. The status line reads **Off** or **On · N apps connected**.

## Apps without a token

An agent set up the older way (Claude Code added with **Add to Claude Code**, Codex, Grok Build, Antigravity) has no token. It keeps working as before, unless **Ask me when an unknown app connects** is on. That option is on when you turn the switch on from this page for the first time (and stays as it was for someone who already had **Allow AI agents to connect** on). With it on, the first connection from a new name shows **“Legacy App” wants to use Lumen** under the toolbar and as a notification, with **Allow**, **Allow, ask before it acts** and **Deny**. Allow is remembered by name, which is only a label that any program on your computer could claim: use a token for anything you care about. A Deny holds for ten minutes, and no answer within 90 seconds counts as Deny.

Lumen's own AI engines (the sidebar's Claude Code, Grok Build, Codex and Antigravity) are not other apps: they are not asked about and not listed here.

## Reference: the connection

For a program that speaks Lumen's channel itself (the bridge's first line, `mcp.js`): along with `lumenProof` (HMAC-SHA256 of the challenge with the profile's `mcp-token`), send `lumenClient` (the token's 12-character id) and `lumenClientProof` (HMAC-SHA256 of `client:<challenge>` with the whole token). The server answers `lumenAuth: "denied"` for an unknown id or a wrong proof.
