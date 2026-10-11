# UX audit 2: chat features after the first wave (ChatGPT and Claude.ai, 2026)

Second pass over Lumen's chat against ChatGPT (chatgpt.com) and Claude.ai. The first audit (`chat-features.md`) listed 50 gaps. Since then these shipped: #396 canvas and custom instructions, #400 Markdown and Mermaid, #401 library (undo delete, pin, archive, full-text search), #402 versions, message actions and Continue, #404 drafts, shortcuts and the paste chip, #413 the page redesign. This document lists what is still missing, ranks it for a browser AI, and records what this branch built.

Research notes. Public release notes and help pages (checked October 2026): ChatGPT has Projects (shared files and instructions per project), Temporary Chat (since August 2026 with a choice of memory, plugins and custom instructions, and "save" to turn it into a normal chat), memory with a summary page you can edit or turn off, scheduled tasks and connected apps, read aloud, voice, model picker per chat, and export through account data. Claude.ai has Projects (knowledge and instructions), memory as editable categorized entries (on by default for Free, Pro and Max; a monthly recap), artifacts, extended thinking, retry with another model, Stop, edit and branch, copy, share links, and Research. Features that need an account, a server, shared links or cloud storage are listed as out of scope below.

## Have (shipped before this branch)

| Feature | Where |
|---|---|
| Edit any message and keep versions, Regenerate with a version switch | #402 |
| Copy reply (rich text and Markdown), copy code, per-reply model and time, thumbs | #402 |
| Continue after Stop or a step limit | #402 |
| Markdown, tables, math, Mermaid, code highlighting | #400 |
| Canvas side panel, custom instructions | #396 |
| Chat library: search inside chats, pin, archive, undo delete, nothing silently dropped | #401 |
| Per-chat drafts, Ctrl+K, Up to edit, Ctrl+Shift+C, paste chip, long message collapse | #404 |
| Redesigned page: rail, header, composer, model picker per chat | #413 |
| Skills and `/` menu, per-chat model, usage and context meter, attachments and pictures, `@` tabs | earlier |

## Missing before this branch, ranked by value in a browser AI

1. **Projects**: a named group of chats with its own instructions. High value: people keep a course, a job search or a trip in one place and want the AI to know the ground rules without repeating them. Claude and ChatGPT both lead with it.
2. **Temporary chat**: a chat that leaves no trace. High value for a browser, where people ask about health, money or a page they would rather not file. ChatGPT and Claude both have it.
3. **Search hit jumps to the message**: search found a chat but left you at the bottom of a long conversation. High value, small.
4. **Retry with another model**: Claude.ai has it; Lumen is multi-model, so it matters more here.
5. **Export and share**: only Markdown to a file existed. Copy as Markdown and PDF are what people actually use.
6. **Read aloud**: accessibility and reading while doing something else. speechSynthesis works offline in Electron.
7. **Stop, then edit**: a mistyped question and Stop left a Continue button but no way to fix the message.
8. **Edit the title in the header**, and a visible divider when the model changes mid-chat.
9. **Follow-up suggestion chips** under a reply: a second model call per reply (cost, latency, tokens spent without being asked). Skipped, see below.
10. **Memory**: ChatGPT and Claude learn facts across chats. Skipped, see below.
11. **Voice dictation**: no confirmed `SpeechRecognition` backend in Electron without Google keys. Skipped.
12. **Share links, connected apps, scheduled tasks, shared projects with teammates**: need a server or an account. Out of scope.

## Worth doing in a browser AI (built in this branch)

| # | Feature | What it does |
|---|---|---|
| 1 | Projects | Rail block with + to make one. A project has a name and instructions (4000 characters) that go into the system prompt of every chat in it, fenced as the user's own words that never outrank safety rules. Move a chat from its row menu (Move to project, New project, Remove from project) or press New chat here. Deleting a project never touches a chat. Stored as optional index fields (`projects`, and `project` on a chat), so old indexes load unchanged. |
| 2 | Temporary chat | Menu item. The chat lives in memory only: no chat file, no index entry, not in the list, with a Temporary badge, a dashed composer and a note. It is gone when you leave it. |
| 3 | Search jump | Opening a result scrolls to the first matching message and highlights the words for a few seconds (reduced motion aware). Search also now sees what you typed: your messages carry Lumen's context block, which used to hide the whole message from the index. |
| 4 | Retry with another model | A button next to Regenerate lists the other models; choosing one switches and asks again, keeping the old reply as a version. |
| 5 | Copy as Markdown, Export as PDF | In the header's menu. PDF is the Markdown drawn by the chat's own renderer in an unseen script-free window, printed to a file you choose. |
| 6 | Read aloud | A speaker button under each reply, spoken by the computer's own voices in sentence-sized pieces so long replies do not cut off. |
| 7 | Stop, then Edit message | After Stop with no answer yet the notice offers Edit message: your message returns to the box and leaves the page. |
| 8 | Title in the header, model-switch divider | Click the title to rename it in place. Switching models leaves a "Switched to X" divider. |

## Not built, and why

- **Follow-up chips**: needs a second model call after every reply. That spends the user's tokens or quota without being asked and slows the end of every turn. It should be an opt-in setting with a cheap model; left for a follow-up.
- **Memory**: cross-chat memory writes things the user did not type into a file the AI later trusts. That needs a review page, an off switch and a prompt-injection story (a web page could plant a "memory"). Custom instructions and Projects cover the safe part.
- **Project files**: ChatGPT and Claude let you attach documents to a project. Lumen's attachments are per message and stored per chat; sharing them safely across chats needs its own storage and size limits. Instructions first.
- **Dictation, share links, apps, scheduled tasks**: see above.

## Known limits

- The "Switched to X" divider is shown live and is not saved: a reopened chat shows each reply's model label but not the divider.
- Project instructions are read when a chat starts and refreshed when it is opened, moved or its project is edited. A reply already running keeps the instructions it started with.
- The sidebar does not show projects; they are on the full-page chat only.
