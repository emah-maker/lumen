# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting:

1. Go to [github.com/emah-maker/lumen/security/advisories/new](https://github.com/emah-maker/lumen/security/advisories/new) (or the repository's **Security** tab → **Report a vulnerability**).
2. Describe the problem, the Lumen version (Settings → About Lumen) and your operating system, and steps or a page that reproduces it.

Please don't open a public issue, pull request or discussion for a vulnerability until a fix is released. You'll get a reply on the advisory; once it's fixed, you'll be credited in it unless you'd rather not be.

Only the latest release is supported with security fixes.

## Scope

In scope:

- **The Lumen app:** the main process, the browser UI and sidebar, internal pages (settings, history, new tab), IPC between them, the way tabs, hidden reader views and sessions are isolated, permissions and downloads, the built-in ad blocker, extension installation, and how keys and chats are stored.
- **AI tool gating:** anything that lets a web page, search result or other untrusted content make the AI act on a site, open or fetch a site, or read tabs without the approval Lumen is meant to require; ways around `list_tabs` filtering; getting the AI to act outside http(s) pages.
- **File uploads by the AI** (`upload_file`, [docs/uploading-files.md](docs/uploading-files.md)): getting a file onto a page that the user did not attach to that chat or choose in the file picker (a path, a `file://` address, another chat's ref, a ref guessed or forged through a file name or page text), a model or page reaching the picker's answer, uploads past per-site AI off, a tab kept off or hands-off mode, uploads without the card where one is required, a file's contents or path reaching the model or a page, and files outliving their chat.
- **The MCP server** (`mcp.js`, `src/features/ai-agents.js`): connecting without the profile's token, one local user reaching another's Lumen, an MCP client skipping approval cards, and the Claude Code / Grok Build / Antigravity / Codex engines getting tools beyond Lumen's browser tools. (Each has an opt-in Settings → AI switch, off by default, that gives that CLI full access to the computer, as in a terminal; with it on, the CLI's own shell and file tools are out of scope, but Lumen's tools, their approvals and the fail-closed gate for them are not.)
- **The CDP automation proxy** (`src/automation/automation.js`) when turned on: exposing Lumen's own UI or hidden views, or listening beyond localhost.

Out of scope:

- **Third-party websites** and their content, including extensions from the Chrome Web Store.
- **AI provider behaviour:** what a model chooses to say or do within the permissions Lumen gives it, jailbreaks that don't get past an approval Lumen enforces, and the providers' own services, apps and CLIs (Anthropic, OpenAI, xAI, Google, OpenRouter, Claude Code, Grok Build).
- **Model instructions that aren't enforced by code**, such as "ask before purchases" or "don't type passwords". Reports that show Lumen itself failing to enforce something it claims to enforce are in scope.
- Chromium and Electron bugs that aren't specific to Lumen (report those upstream), and problems that need an attacker who already controls your computer or your user account.
- **Bypass permissions** (Settings → AI, the bolt menu in the sidebar head): with it on, every approval card is answered Allow automatically, for the sidebar AI and for connected agents, and the AI can read PDFs, use your signed-in accounts and send what it read to other sites without asking. That is the user's own choice and what the setting is for, so the AI doing those things with it on is not a vulnerability. In scope: Bypass turning on without the user choosing it (it is off by default and needs a second click), a page or an agent turning it on, a card being answered when it is off, getting past a site with AI off, a tab kept off or hands-off mode, uploading a file the user did not attach or pick (the **Choose file…** card is never answered for the user), or a background task bypassing.
- MCP agents acting in their own Lumen window without approval cards while **Agents in their own window don't ask** is on (the default): that is the setting's purpose. Getting past per-site AI off, a tab kept off or hands-off mode, or acting in the user's own tabs without a card, is in scope.
- Known, documented gaps in the AI's site approvals: an approved site redirecting elsewhere, and `web_search` queries going to DuckDuckGo without a card (see the README's "Asking before it acts"). Reports that make them worse than described are welcome.
- Unsigned builds and the resulting SmartScreen or Gatekeeper warnings, which are documented.
- Local programs controlling your tabs through the CDP port after you turn on **Allow automation tools (Chrome DevTools Protocol)**: that's what the setting is documented to do. Getting past the proxy's filtering is in scope (above). With **Don't let the AI act on my pages** on, the proxy also refuses acting commands (input, navigation, script evaluation, page and storage changes, closing or fronting a tab) on tabs the AI did not open; a way around that is in scope.
