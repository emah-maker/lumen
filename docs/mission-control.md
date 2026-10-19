# AI activity (lumen://tasks)

One page that shows everything the AI is doing: chats working in the sidebar or on the full-page chat, background tasks, routines and outside agents (Claude Code, Codex and others connected over MCP). Before it, these were spread over the sidebar's Tasks panel, the chat list, the agents' own windows and their approval cards.

## Opening it

- The sidebar's **⋯** menu → **AI activity**
- The Tasks panel's **Open full view** button (next to its close button)
- The ⋯ app menu → **AI activity**, or `Ctrl+Shift+X` (`⇧⌘X` on a Mac)
- Type `lumen://tasks` in the address bar

It opens in a tab like the Bookmarks and Downloads pages, one per window. The AI can't read or use this tab.

## What it shows

- **Needs you.** Every approval card that is waiting: in a chat, in a background task or routine, and in an outside agent's window. The oldest is first. A card that is a plain yes or no (a new site, opening a site after reading, a script, a PDF, an MCP tool, a terminal command, a signed-in account) has its answers right there: **Allow** / **Don't allow** for a chat or an agent, **Allow once** / **Allow site for this task** / **Don't allow** for a task. These go through the same path as the card in the sidebar or the Tasks panel, so the card there closes too. A card that needs more (choosing a file to upload, which app the AI may use, keeping or undoing a change that removed content) says to answer it where it was asked, and **Go to** takes you there. The page's tab title counts the cards, and screen readers hear new cards as they come.
- **Running now.** Chats that are writing a reply or waiting for their turn, background tasks and routines that are running, waiting for an OK or queued, and outside agents working in a window of their own (named by the program, for example "Claude Code"). Each row shows its status, how long it has been going, the step it is on, and for a task what it has cost so far. **Stop** stops it the way the sidebar's Stop, the Tasks panel's Stop or the agent window's Stop does (for an agent, its connection ends). **Go to** opens the chat in its tab with the sidebar, the task in the Tasks panel, or brings up the agent's window.
- **Scheduled.** Routines and repeating tasks, soonest next run first, with **Turn off** / **Turn on**. A routine that runs on its web link or on new email says so instead of a time. Ones that are off are at the end.
- **Where it came from.** A task you sent from [Telegram](telegram.md) says "From Telegram" (until Lumen restarts), and its cards can be answered here or on the phone: whichever answers first wins, and the other one closes. A routine run started by its web link or by new email says so under Running now and Recent, as does a missed time run late.
- **Recent.** The last 50 runs that finished: each task's and routine's run history (a watched page's checks are left out) and the sidebar chats that finished since Lumen started. Each shows how it ended, how long it took, what it cost when known, and the start of its result. **Open chat** or **Open task** takes you to it.

The page updates as chats, tasks and cards change, and looks again every 2 seconds while it is in view (for agents' windows and the elapsed times). It stops looking while the tab is in the background.

## What it can't do

The page only reads, and its buttons do what the sidebar, the Tasks panel and the agents' windows already do. It cannot answer a card with "Always", turn on Bypass permissions, start a task or change what a task may do. Its calls answer only the lumen://tasks tab itself; web pages have no way to reach them. Nothing on it leaves your computer.

Finished chats are kept in memory only: after a restart, **Recent** starts again with the tasks' saved history.
