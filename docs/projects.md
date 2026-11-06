# Projects

A **project** groups chats and gives the AI things to work from. Its page is the home base for that work: open it from the project's row in the chat list (in lumen://chat or in the sidebar).

## The project page

- **Header**: the project's name and a one-line goal (both editable in place), and quick actions: **New chat**, **Add files** and **Open folder** (when the project has one). The ⋯ menu has Folder and more… and Delete project.
- **Start a chat**: the big box at the top starts a chat in the project, with a model picker (the project's default model, or the one you use) and an attach button. Enter sends.
- **Continue where you left off**: the latest chats as cards with the last thing said, the time, and a mark while a reply is working or needs your OK. Below them are all the project's chats, with a search that looks in the chats and the project's files.
- **Overview**: instructions (shown as text; Edit changes them), **Sources**, the folder, defaults and memory. The fine print is in each card's ⓘ tooltip.

## Project memory

With **Memory** on (Settings → AI → Instructions and memory), a project keeps notes of its own next to your general memory. Only the project's chats see them.

- **The AI saves them on its own.** In a project's chat the AI is asked to save the project's lasting facts when you state or decide them: its goal, deadlines, decisions, names, conventions, who does what. One short fact per note. As with all memory, only what you say in your own messages, never text from a page, a file or a tool result, and the same approval card shows when the chat holds outside content. Each save shows in the chat as **Remembered: …** with **Undo**.
- **No restatements.** A note that nearly repeats one the project already has (most of its words in common, or the same note with more said) updates that note instead of adding a second; the chat shows it as an update.
- **The relevant ones first.** Each new chat in the project gets the project's notes before your general memory, in about 3,000 characters of their own: pinned notes first, then the ones that share words with the chat's first message, then the newest. The rest stay saved, and the AI can search them.
- **Up to 60 notes per project.** A new note past that lets the project's oldest unpinned note go; Undo on the new note brings it back. A project whose 60 notes are all pinned asks you to unpin or forget one.
- **The Memory card** on the project's page lists them, pinned first. **Add** writes a note yourself; click a note to edit it (Enter saves, Escape cancels); **Pin** keeps a note first and never pushed out; **Forget** asks for a second click. With more than 8 notes there is a filter and **Show all**. Notes that haven't changed in 6 months (and aren't pinned) get a line ("3 notes haven’t changed in 6 months") whose **Forget them** clears them. Nothing is dropped on its own for being old.
- Settings → AI → Instructions and memory → **Saved memory** still lists every note, with the project's name on a project's. Deleting a project deletes its notes (Undo brings them back).

## Key documents and where things are

With **Memory** on, a project also keeps where its documents are, so neither you nor the AI has to look for them again.

- **Kept on its own.** When the AI in a project's chat opens, reads, edits or cites a document (a file on this computer, a PDF, a Word document, a web page, a Google Drive or OneDrive file), Lumen records where it is, with a short name: the file's name, the page's title, or "Google Doc". Searches, Lumen's own pages and local test servers are left out.
- **You can name one.** Say "the budget sheet is <link>" or "the photos are in D:\Lab\Photos" and the AI notes it with your name for it.
- **Where things are.** A folder two of the project's files came from, or a site two of its pages are on, is listed below the documents.
- **Most used first.** Each use counts, and older use counts less (half after two weeks). A project keeps up to 60; past that the least used one goes. Pinned ones always come first and are never pushed out.
- **The AI gets them.** Each new chat in the project gets the top ones, about 1,500 characters, the ones that share words with your first message first, and is told to open the one it needs directly instead of searching.
- **No duplicates, no dead ends.** A Google document is one entry in any view (edit, view, a shared link), a page is one entry with or without its tracking parameters, and a file moved to another folder under the same name keeps its entry (and its name and pin). A file that is gone from this computer, or a link the AI found dead (not found, 404), drops off, unless pinned.
- **The Key documents card** on the project's page lists them: **Open** opens one in a tab, click a name to rename it, **Pin** keeps it first, **Remove** takes it off.
- **What is kept.** Only the locations and names, never what the documents say, in `project-places.json` in Lumen's profile, encrypted with your system's keychain like memory. Turning Memory off stops recording and recalling them. Deleting the project deletes its list (Undo brings it back).
## Many projects

- **Find and sort.** With more than 6 projects the Projects block in lumen://chat has a **Find a project** box (it matches the name and the goal line; Escape clears it) and a switch between **Recent** (the project whose newest chat is most recent first) and **A–Z**. Lumen keeps the choice.
- **A short list.** It shows 8 projects, then **Show N more** (and **Show less**). Pinned projects and the project whose page is open always show.
- **Pin to top** (a project's ⋯ menu) keeps a project at the top, with a small mark; **Unpin** takes it off. Pinning doesn't count as using the project, so it doesn't change the Recent order of the others.
- **Archive** (the ⋯ menu) takes a project out of the lists, with Undo. Nothing is deleted: its chats, files, folder and memory stay as they are, and its chats still work. **Archived (N)** at the foot of the block lists the archived projects; **Move out of archive** in a project's ⋯ menu brings it back.
- **Move to project** and the tab menu's **Add to project** leave archived projects out and list pinned ones first; with more than 8 projects Move to project has a filter at the top.

## All projects

The grid button next to + in the Projects block (in lumen://chat, and in the sidebar's chat list, where it opens lumen://chat) and **Show N more** open **All projects**, every project you have on one page.

- **Groups.** **Pinned**, **Recent** (the rest), **Temporary** and **Archived**, each with its count. Archived is folded; click it to open it. A search opens it too.
- **A card** shows the project's mark (a colour and its first letter, the same every time), its name, Pinned or Temp, when it was last used, how many chats and key documents it has, its top three key documents and a line from its memory (a pinned note first) or its goal line. Click a card to open the project.
- **⋯ on a card**: **Open project**, **Pin to top** / **Unpin**, **Rename…**, **Archive** / **Move out of archive**, and **Keep as project** for a temporary one.
- **Find a project, a note or a document** looks in names, goal lines, memory lines and key document names. **Recent** / **A–Z** sorts inside each group, and **Cards** / **List** switches to one compact row per project. Lumen keeps both choices.
- **Many projects.** The cards are drawn 24 at a time as you scroll.
## Temporary projects

For something quick (a trip, an assignment due Friday) that may not deserve a project of its own:

- **The clock button** next to + in the Projects block makes one at once: no dialog, no folder, named for the day ("Quick project, Nov 5"; a second one that day gets a number). Its page opens, so you can start a chat, add files or rename it straight away.
- It is marked **Temp** in the list (hover it for the date), and its page says "Temporary project. Deleted Nov 12 unless you keep it."
- **It goes a week after it was last used.** Using it (a chat in it, an edit) moves the date on. Then Lumen deletes it the way **Delete project** does: its chats stay in your chat list, out of any project; its files and memory are erased. Lumen checks soon after it starts and every hour, never while one of its chats is working.
- **Keep as project** (on its page, in its ⋯ menu, or in Settings) makes it an ordinary project that stays until you delete it.

## The project page's views

The tabs under the header switch what the page shows (arrow keys move between them):

- **Overview**: everything described above, the chats on the left and the cards on the right.
- **Memory**: the project's notes on their own, all of them, with the same Add, edit, Pin and Forget, then its Key documents.
- **Settings**: first the project as a whole (Keep as project for a temporary one, Pin to top, Archive, Export project…, Delete project), then the instructions, the defaults, the permissions and the folder.

An archived project's page says so above the tabs, with **Move out of archive**.

## Projects in the sidebar

The browser's AI sidebar uses the same projects. A strip under its header shows the project the open chat is in; click it to pick another (or none). A chat with no messages yet starts again in the project, so it gets the project's default model and plan setting; a chat with messages is moved, and Undo is offered. The sidebar's chat list shows the projects first, with the chevron, + and ⋯ of the chat page's list, and each chat row has Move to project. A project row opens that project's page in lumen://chat. The sidebar and the chat page share one chat, so a move made in one shows in the other.

## What a project holds

- **Instructions** sent with every chat in the project (up to 4,000 characters).
- **Sources**: everything the AI can read in this project, in one list on the project's page (files, web pages and whole websites), with one **Add** menu and a ⋯ menu on each row.
  - **Files**: PDF, Word, PowerPoint, email, text and pictures. **Upload files…** or drop them on the card (or use **Add files** in the header). Lumen reads them on your computer and keeps the text encrypted in your profile. A file row shows its kind and size.
  - **Web pages**: **Add a web page…** takes an address; **Add open tabs…** lists the pages open in your tabs, with their titles and icons, and you tick the ones to add; a link dragged onto the card works too. In any chat, the + menu has **Add this tab to the project**, and a tab's right-click menu has **Add to project**. A page is kept by address and title (Lumen reads the title once when you add an address; a page from a tab already has one).
  - **Whole websites**: **Add a whole website…** takes a domain or a path (`docs.python.org/3/`, `northeastern.edu/coop`). When you type a bare domain or an address ending in `/`, the panel switches to **The whole site** for you (**Just this page** is one click away). A website is one row, "Website · whole site" or its path. When a chat needs it, the AI searches that site and reads pages under the address (never another host or a sibling path, at most 8 results and 6 pages per call) and names the pages it used.
  - The ⋯ menu: **Open** and **Re-read the page** (the title and icon again: from a tab that has it open, otherwise one request, only when you click) for pages and websites, **Rename** for any row (a name you give is kept when you re-read), **Remove** (a page or website shows Undo; a file asks first, because its text cannot be brought back). The search box above the chats looks in the sources too.
  - Pages pinned in earlier versions show up here unchanged; one with no title shows its site and path, and Re-read gives it a title.
- **Memory**: when Memory is on, notes the AI saves in a project chat belong to that project only (see [Project memory](#project-memory)).
- **Defaults**: a model for new chats, plan-first, and switches for connectors and MCP tools.
- **Permissions**: how much the AI asks in the project's chats (**Use default** follows Settings → AI; or Ask, Auto-allow actions, Bypass permissions), and the sites allowed with **Always allow <site> in <project>** on a site card in its chats, each with Remove. The sidebar's bolt menu says "…, from project <name>" while the project's level applies, and choosing a level there in a project's chat asks **Only in <project>** or **Everywhere**. These stay on this computer: they are not synced and not written to `project.json`, so a folder can't switch Bypass on. Background tasks and routines still bypass only with Settings → AI → **Bypass in background tasks and routines too**.

## How the AI uses them

Every chat in the project gets a short list of the files, pages and websites. The AI reads one, or searches them all, with the project_files tool (a page with read_urls; a website with site_search and site_read). Only then does that text go to your AI provider, and a page or website is fetched only then. A website's search and reads ask for the same OK as any other search or page the AI opens once it has read other pages. Plan mode allows the tool.

## Your project is just a folder

Nothing about a project depends on Lumen, on one AI provider or on one tool. A project with a folder keeps what it is made of as plain files there:

```
<project folder>/
  INSTRUCTIONS.md   the instructions (the source of truth)
  AGENTS.md         the same text; coding agents (Claude Code, Codex, Gemini CLI...) read it from their working directory
  CLAUDE.md         "@AGENTS.md", written only when there is no CLAUDE.md
  sources.md        web pages and websites, one per line
  Sources/          the files you added, as the real files
  project.json      the goal line and the defaults
  Chats/            the chats as Markdown (its own switch)
```

- **sources.md** looks like `- [Python docs](https://docs.python.org/3/) — whole site` for a website and `- [Title](https://example.com/page)` for a page. A bare address (`- https://example.com/`) and other bullets work too; any other line is yours and is ignored.
- **project.json** is `{ "format": 1, "description": "...", "defaults": { "model": "...", "plan": true, "connectors": false, "mcp": false } }` (a key is left out when it has its usual value).
- **Edits from outside are picked up** when you open the project, when Lumen's window gets focus again and when you change something in Lumen (Folder card: **Check the folder**). Edit `INSTRUCTIONS.md` (or `AGENTS.md`), drop a PDF, Word file, text file or picture into `Sources/`, or add a line to `sources.md`. A file edited in `Sources/` is read again; one deleted from it leaves the project; sub-folders, hidden files and types Lumen cannot read are ignored. Nothing watches the folder while Lumen is in the background.
- **When both sides changed** since the last pass, the newer one wins and the other text is kept beside it as `INSTRUCTIONS.conflict-<date>.md` (likewise `sources`, `project`). A file you remove in Lumen moves to `Sources/Removed/`. Nothing is written twice: a second pass over an unchanged folder does nothing.
- **It is a switch.** It is on for a new project whose folder Lumen makes. For a project you already have it is off until you turn it on (the editor's folder section, or the Folder card), and turning it on says that the files are **not encrypted** and that files you added earlier are not copied out (Lumen keeps only their text, encrypted). Turning it off leaves the files where they are. A project without a folder has **Save project to a folder**, which makes the folder and turns it on.
- **Any AI, any tool.** The instructions, sources and memory go to every model and engine. A command-line engine (Claude Code, Codex, Gemini CLI, Grok Build) started in a project works in the project's folder (or its working folder, if you set one), so it sees the same files, including `AGENTS.md`.
- **Export project…** (the project's ⋯ menu) writes a zip with `INSTRUCTIONS.md`, `AGENTS.md`, `sources.md`, `project.json` (with the name), `Sources/` (the real files when the folder has them, else their text), `Chats/` (Markdown), `Memory.md` and a `README.md`.
- **Open folder as project…** (the folder button in the projects list) makes a project of any folder. One with these files (made by Lumen or by hand: `INSTRUCTIONS.md`, `AGENTS.md` or `CLAUDE.md`, `sources.md`, `Sources/`, `project.json`) gives the project its instructions, sources and settings and keeps them as plain files. A plain folder of files makes its files the sources and writes nothing into it. A folder that is already a project opens that project.

## Deleting

Deleting a project shows **Undo** for a short while. After that its files and memory are erased.

## Not included

There is no lumen://projects address (the page opens inside the chat page), and files can't yet be dragged in from outside by path. A temporary project always lasts a week; that can't be changed yet.
