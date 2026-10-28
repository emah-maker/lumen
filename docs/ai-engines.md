# What each AI can do in the sidebar

The sidebar can answer with an API model (Claude by key or sign-in, OpenAI, Gemini, Grok, OpenRouter, a local model) or with one of your own CLIs: **Claude Code**, **Codex**, **Grok Build** and **Antigravity**. They all use Lumen's browser tools. This page lists what differs between them, and what Lumen says when an engine can't do something.

The bar is a Claude Code chat: whatever it can do, every other engine should be able to do too, or say plainly why not.

## The same on every engine

| What | How it reaches each engine |
|---|---|
| Lumen's browser tools (read, click, type, tabs, PDFs, search, pictures, annotate...) | API models: in each request. CLIs: Lumen's MCP server (`src/automation/mcp-http.js`), one tool list shared by all of them and kept under its size budget. |
| Connected accounts (`connector`), project files (`project_files`), Word (`word`) | API models: in the request when they apply. CLIs: extras of that run's own MCP session (`runTools` in `src/features/ai-agents.js`), so they never grow the shared list. |
| Helpers (`delegate`) | API models: helpers on a cheaper model. Claude Code (without full access), Codex, Antigravity: a `delegate` extra that runs helpers on a CLI. Grok Build: its own `spawn_subagent`, answered by Lumen. Claude Code with full access: its own Agent tool. |
| **Your skills** (Settings → Skills, the ones the AI may use on its own) | Listed in the system prompt of every chat. API models and, now, every CLI get `use_skill` (for a CLI, an extra of the run). |
| **MCP servers you added** (Settings → AI → MCP servers) | API models: in the request. Every CLI now gets the tools of the servers that are running as extras of its run; Lumen starts them before the run (for up to 8 seconds) and says once if one failed. Each call asks first, exactly as in an API chat, unless you chose Always allow. A project that turns MCP servers off turns them off here too. |
| Memory, custom instructions, project instructions, work folder | In the system prompt of every chat. |
| Attached pictures and the screen | API models: as images (a text-only model is told it can't see them, in the chat). Claude Code, Grok Build: in the message. Codex: `--image`. Antigravity: as files it opens with `view_file`, which its hook now allows for exactly those files. |
| Approvals, site permissions, hands-off mode, Bypass | The same cards for every engine: a CLI's calls come through the same gate. |
| `/context` | Every chat. |
| **`/compact`** | Claude Code: runs in its own session. API models: the same model summarizes the earlier part. **Codex, Grok Build, Antigravity** (new): the same CLI writes the summary in one fresh run, and the chat's old CLI session is dropped, so the next message starts a new one handed the summary and the latest turns. If the summary fails, nothing changes and the chat says so. |
| Reply suggestions | Every chat, whichever AI answered: the chips are written by a small API model when one is set up (`src/ai/reply-suggest.js`), the same for a Claude Code chat. |

## What only some engines can do

| What | Who has it | What the others say |
|---|---|---|
| Plan mode | API models | Turning Plan on with a CLI shows: "Plan mode works with API models ... so turn off Plan first or pick another model." |
| Background tasks and routines | API models, Claude Code, Grok Build | Codex and Antigravity are not offered in the task's model menu. A task saved on one (or one moved to it) is refused with: "{name} answers in sidebar chats only, so it can't run a background task or routine. Pick Claude Code, Grok Build or an API model for it." Before, an Antigravity model was listed as usable and the task then failed with an unrelated error. |
| Desktop apps, notes, reading list, research board, memory tool, acting helpers | API models | These are Lumen tools for the API chats only; a CLI chat that asks gets its normal tools and its full-access shell where that is on. Claude Code doesn't have them either. |
| The CLI's own slash commands, own skills and own MCP servers | Claude Code with full access | Codex, Grok Build and Antigravity run in a config folder of Lumen's own, so their own skills and servers are not loaded. Lumen's skills and the MCP servers you added in Lumen work on all of them (above). |
| A tool-less model (an OpenRouter or local model marked "chat only") | — | Says once in the chat that it can read the page but can't act, and which models can. |

## For developers

- Per-run extras live in `runTools` (`src/features/ai-agents.js`), fed by `deps.connectorTools`, `projectTools`, `helperTools`, `wordTools`, `skillTools` and `mcpServerTools` (`src/main.js`). Add a capability there, never to `EXTERNAL_TOOLS`: the shared list is held to its budget by `test/units/units.js`, `test/units/mcp-tokens-units.js` and `test/acceptance/chat-prompt-budget.js`.
- A CLI chat's system prompt is `cliSystemFor(settings)` plus the engine's note (`src/ai/agent.js`). It adds the skills list only when the chat has skills, so the Grok budget is unchanged.
- Antigravity's own-file rule is `ownFileOk` in `src/ai/agy-tools.js`, shared by the hook (`agyDecision`) and the stream check (`offToolOf`).
- Tests: `test/units/engine-parity-units.js`.
