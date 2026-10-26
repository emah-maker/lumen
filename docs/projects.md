# Projects

A **project** groups chats and gives the AI things to work from. Its page is the home base for that work: open it from the project's row in the chat list (in lumen://chat or in the sidebar).

## The project page

- **Header**: the project's name and a one-line goal (both editable in place), and quick actions: **New chat**, **Add files** and **Open folder** (when the project has one). The ⋯ menu has Folder and more… and Delete project.
- **Start a chat**: the big box at the top starts a chat in the project, with a model picker (the project's default model, or the one you use) and an attach button. Enter sends.
- **Continue where you left off**: the latest chats as cards with the last thing said, the time, and a mark while a reply is working or needs your OK. Below them are all the project's chats, with a search that looks in the chats and the project's files.
- **Overview**: instructions (shown as text; Edit changes them), **Sources**, the folder, defaults and memory. The fine print is in each card's ⓘ tooltip.

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
- **Memory**: when Memory is on, notes the AI saves in a project chat belong to that project only. They show on the project's page, where you can forget them.
- **Defaults**: a model for new chats, plan-first, and switches for connectors and MCP tools.

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

There is no lumen://projects address (the page opens inside the chat page), and files can't yet be dragged in from outside by path.
