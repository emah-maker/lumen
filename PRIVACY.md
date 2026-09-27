# Lumen privacy policy

Lumen has no account, no servers of its own, no telemetry, no analytics and no crash reporting. The people who make Lumen never receive your browsing, your chats or your keys.

## What stays on your computer

- **Browsing data:** history, bookmarks, open tabs, downloads, cookies and site data are stored in Lumen's profile folder on your computer.
- **API keys:** stored encrypted with your operating system's keychain (Windows DPAPI, macOS Keychain, or the Linux secret service).
- **Chats with the AI:** stored encrypted the same way. If your system has no keychain, which happens on some Linux setups, they're stored unencrypted in the profile folder. **New chat** deletes the saved conversation.

## What leaves your computer, and to whom

- **The AI you choose.** When you send a message, Lumen sends it to the provider you picked, with the page context it needs to answer: the text of the page you're on, and a screenshot when the AI asks for one. The provider can be Anthropic (directly or through Claude Code), OpenAI, xAI, Google or OpenRouter. Each provider's own privacy policy applies to what it receives. Nothing is sent to an AI until you ask it something or start a task.
- **The websites you visit,** as with any browser. The AI's background reading and research run without your cookies.
- **Your search engine,** when you search from the address bar or the start page.
- **Component downloads.** Lumen downloads ad and tracker block lists (Ghostery's published lists) and Google's Widevine component, which lets DRM video play. Extensions you install come from the Chrome Web Store.
- **Sign-in.** "Sign in with OpenRouter" opens OpenRouter's own sign-in page, and the key it returns is stored as described above.

## AI agents over MCP

If you turn on **Allow AI agents to connect**, AI apps on your computer (such as Claude Code, Codex, Gemini CLI or Cursor) can read and control your tabs through Lumen. They're asked before acting on a new site. This setting is off by default.

## Removing your data

Settings → Privacy and security → Clear browsing data clears history, cookies and site data. Removing a key in Settings → You and AI deletes it. To remove everything, delete Lumen's profile folder:

- Windows: `%APPDATA%\Lumen`
- macOS: `~/Library/Application Support/Lumen`
- Linux: `~/.config/Lumen`

## Contact

Questions about this policy: open an issue on Lumen's GitHub repository.
