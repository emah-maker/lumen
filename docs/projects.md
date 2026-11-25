# Projects

A **project** groups chats and gives the AI things to work from. Its page is the home base for that work: open it from the project's row in the chat list (in lumen://chat or in the sidebar).

## The project page

- **Header**: the project's name and a one-line goal (both editable in place), and quick actions: **New chat**, **Add files** and **Open folder** (when the project has one). The ⋯ menu has Folder and more… and Delete project.
- **Start a chat**: the big box at the top starts a chat in the project, with a model picker (the project's default model, or the one you use) and an attach button. Enter sends.
- **Continue where you left off**: the latest chats as cards with the last thing said, the time, and a mark while a reply is working or needs your OK. Below them are all the project's chats, with a search that looks in the chats and the project's files.
- **Overview**: instructions (shown as text; Edit changes them), **Sources**, the folder, defaults and memory. The fine print is in each card's ⓘ tooltip.

## About you: what a job project remembers

A Job applications project keeps what the AI should never have to ask again, on its **About you** tab (the Overview's **About you** card says how much is filled in and opens it):

- **Résumé and cover letter**: your **base résumé** and **cover letter base**, files on this computer you choose (**Choose file…**). They are never changed: for each posting the AI makes a tailored copy in the project's **Tailored résumés** folder and changes only the copy, and the Word tool refuses an edit or a save over a base file. A **résumé in Google Drive** (paste its Drive or Docs link) is read for facts with the Drive connector.
- **Résumé highlights**: skills, projects and numbers in your own words. The AI may use them and never adds to them.
- **Your details**, in groups: You (name, email, phone), School (school, degree, major, graduation date, GPA), Work (authorized to work, sponsorship, available from, preferred locations), Links (LinkedIn, GitHub, website) and Address. Each box saves when you leave it.
- **Saved answers**: answers to application questions you approved ("Why this company?"). Click one to edit it; **Add answer** adds one.

It is the project's automation profile, the one [Automations](automations.md) fill forms from, so **Edit profile**, Automations and this tab change the same thing. Every chat in the project gets it (about 3,000 characters: the details first, then the files, highlights and answers), so the AI uses it instead of asking you. When you tell the AI a new lasting fact about yourself, it saves it there (the applications tool, action `remember`) and the chat says "Saved to your profile: …"; you can change or remove it on the tab. The AI never saves an answer about gender, race, ethnicity, veteran or disability status, salary, a birth date or anything secret: those stay yours to type. After the AI has read a page, an email or a file in that chat, a save asks on a card first (Bypass permissions answers it).

## Linked folders

**Sources → Add** has **Link a folder on this computer…** and **Link a Google Drive folder…** (paste the folder's address, drive.google.com/drive/folders/…, and a name if you like). A linked folder is listed first in Sources, with **Open**, **Rename** and **Remove** (which only unlinks it, with Undo).

- **A folder on this computer**: the AI lists it and reads its files with the project's files tool (`folder_list`, `folder_read`): PDF, Word, PowerPoint, email and text, read with Lumen's own readers. Only inside the folder you linked: never a hidden file, never through a link that points out of it. A whole drive or your home folder can't be linked. What a file says counts as outside content, like a page.
- **A Google Drive folder**: the AI lists and reads it with the Drive connector (Google Drive must be connected, and on in the project's Tools).
- Each chat in the project gets the list of linked folders. Nothing in them is copied or changed. Up to 12 per project; they stay on this computer (not in `project.json`).

## Tools: the apps, MCP servers and skills a project uses

A project chooses which of your tools its chats get. Open its page → **Tools** (or **Manage** on the Overview's **Tools** card):

- **The model and Plan first** for new chats, at the top (the same as the Defaults card).
- **Apps and connections**: every app from Settings → Apps and connections, each with its status (Connected, Not connected, Needs sign-in) and a switch. The ones on come first; **Show all apps** has the rest.
  - **Until you switch one**, the project uses every app you connect, including ones you connect later. Switching one off turns that into a list: the apps on now stay on, and an app you connect later stays off in this project until you switch it on. **Use every app** goes back.
  - **Connect** on an app that isn't connected yet: Google (Drive, Sheets, Docs, Calendar, Tasks, Contacts), Microsoft (Outlook, OneDrive, Outlook Calendar), Gmail, Canvas (when Lumen finds your school's address in your tabs) and the MCP cards (Linear, Atlassian, Sentry…) sign in in your browser from there, and the app is switched on in the project. An app that needs a token or an address typed (GitHub, Notion, Todoist, Zotero, a calendar's secret address) opens Settings → Apps and connections instead; come back when it says Connected.
- **MCP servers**: the servers you added yourself (Settings → AI → MCP servers), each with a switch. Their tools are sent with every message, so a project that doesn't need one can leave it off. A server an app card added (Linear, for example) is listed as that app.
- **Skills**: the skills the AI may use on its own (Settings → Skills). Switched to a list, only those are listed to the AI in the project's chats.

What it does: in the project's chats the AI is offered only the project's apps (the `connector` tool lists just those) and servers, a call to any other is refused, and only its skills are listed. Chats outside the project are not affected. The Overview's **Tools** card says what is on in one line ("Gmail, Google Sheets and 2 more · All MCP servers · All skills") and names the apps that are on but not connected yet, with **Connect…**. The lists are kept with the project and in its folder's `project.json` (`"apps"`, `"servers"`, `"skills"` under `"defaults"`); a list left out means every one. Nothing is connected or signed in on its own.

## Templates

**New project** asks what to **Start from**: **Blank** (name it and write its instructions yourself) or a template, a project that starts set up for one kind of work. Leave the name or the instructions empty and the template's are used; anything you type wins. Below the templates, **Tools and connections** lists the apps the new project's chats will get: a template's come ticked, tick or untick any, and **Connect** one you haven't signed in to yet. Left as it is on Blank, the project uses every app you connect. A template only sets a project up: afterwards it is an ordinary project you can change.

| Template | Its apps | Also |
| --- | --- | --- |
| **Job applications** | Gmail, Google Sheets, Drive, Docs, Calendar | The dashboard, tracker, résumé folder and profile below |
| **Coursework** | Canvas, Google Calendar, Google Tasks, Drive, Docs | Instructions for assignments and deadlines |
| **Code project** | GitHub | Plan first; instructions for reading before changing and asking before pushing |
| **Research** | Zotero, Drive, Docs, Notion | Instructions to cite every claim and never invent a reference |

A project you already have can become one too: its page → **Settings** → **Type** (**Standard**, **Job applications**, **Coursework**, **Code project** or **Research**; a type adds its instructions, and its apps stay as the Tools tab has them), or **⋯** → **Make it a Job applications project**. Switching adds the template's instructions after the project's own (if both would not fit in 4,000 characters, yours stay as they are and Lumen says so), its folder and its automation profile. Nothing else changes: the project's files, chats, memory and folder stay. Switching back to **Standard** hides the job views and takes the template's instructions out again (unless you edited them); the tracker and the profile are kept, so switching back later picks up where you were.

### Job applications

For applying to jobs and co-ops:

- **Instructions** for the AI in its chats: your master résumé and cover letter base are never edited, renamed or overwritten. For each posting the AI makes a tailored **copy** with the Word tool, saved in the project's **Tailored résumés** folder as "<Company> - <Role>.docx", and changes only the copy (reordering and rewording bullets, never inventing experience). It checks the tracker before starting on a posting and skips one you already applied to. It fills forms from your profile and saved answers and stops at the final Submit, leaving the submit to you. It drafts long answers ("Why this company?") for you to approve and saves the approved ones to memory for reuse. Questions about gender, race, veteran or disability status, salary and anything legal are left to you.
- **A "Tailored résumés" folder** in the project's folder (when the project has one).
- **An automation profile of its own**, named for the project: your résumé and cover letter files, major, start date, location and saved answers, the same profile [Automations](automations.md) fill forms from. An automation made in the project uses it. Its page shows and edits it as **About you** (see [About you](#about-you-what-a-job-project-remembers)), and its chats get it.
- **Its own look**: a briefcase in your accent colour in the sidebar and in All projects, and a "Job applications" badge on its page.
- **The Applications view**, the page it opens on (the dashboard, loaded only when shown). It reads top to bottom: one **action bar** (the views, Check email, Sync now, Export CSV, Edit profile, the Ctrl+K hint and **Add posting**), then **Progress** (the main numbers), then **Needs attention** (email suggestions, follow-ups) beside **Outcomes**, then the view you picked, then **Sources**. It follows your theme: light or dark, and your accent colour (Settings → Appearance).
  - **Ctrl+K** (⌘K on a Mac) while the dashboard shows opens its own command palette: type to filter every action, view, section and application (letters in order, so "bd" finds Boston Dynamics), ↑ ↓ to move, Enter to run, Esc to close. An application opens its card on the board. Everywhere else, and from the address bar, Ctrl+K is still Lumen's command bar.
  - **Stats**: applied this week and this month, the total, the response rate (heard back, meaning an interview, an offer or a rejection, out of all applied), interviews (every one that reached an interview or an offer), offers, rejections, the average days to a first answer, and the last 8 weeks as small bars. A posting saved for later doesn't count as an application.
  - **Follow-ups due**: applications from two weeks ago or more with no answer yet, the longest waiting first.
  - **Board**: Saved, Applied, Interview, Offer and Closed (rejected and withdrawn). Drag a card to another column to move it, or pick its stage from the menu on the card.
  - **Table**: every application, sorted by any column (company, role, stage, date, how long the answer took or how long it has been waiting).
  - **Timeline**: every move, newest first, by day.
  - Each row opens its posting and the **tailored résumé** it used: the copy the AI named for it, or the one in Tailored résumés named "<Company> - <Role>".
  - **Add posting** keeps one for later (Saved) or logs one you applied to yourself. **Edit profile** opens Automations; **Export CSV** saves the project's rows (the Status column saying where each one stands).
  - The Overview keeps a short **Applications** card: the profile, a count per stage and the newest few.
- **Your tracker sheet and your email**, on the Applications view:
  - **Link a Google Sheet** you already track in (Google Sheets must be connected in Settings → Apps and connections). Lumen reads its first row for the columns by name: Company, Role (or Position), Location (or Area), Status, Apply URL (or Link), Date Applied, Deadline and Notes. Each row becomes an application, at the stage its Status says ("Applied (user-reported)" is applied, "Interviewing" interview, "Not started", "Backup" or "Blocked" saved, "Skip" withdrawn; a Status it can't read, like "Ask Sam", is left alone), so your sheet counts in the stats.
  - It syncs when the dashboard opens (at most every 2 minutes) and on **Sync now**. A Status you change in the sheet moves the application here. With **Keep the sheet updated** on (the default), a move here (a drag, a stage menu, the AI logging a submit, an email you apply) writes that row's Status cell, and its Date Applied when it is empty; an application logged here that the sheet hasn't got is added as a new row. Rows are found again by their posting's address, else company and role, every time, so sorting or editing the sheet in between is fine. Nothing else in the sheet is touched, and cells are written as plain text. **Unlink** stops it; the applications stay.
  - **Email**: with Gmail connected (the Google sign-in, read-only), **Check email** (also on its own when the dashboard opens, at most every 30 minutes) searches the last 120 days for application emails and sorts them, on this computer, from the subject, sender and preview only (never the message itself): application received, interview, offer or rejection, and which company. Each one that would change the tracker is listed with what it would do (**Move to interview**, **Add as applied**) and **Ignore**; **Apply all** does them all. An email never changes the tracker on its own, never reopens a closed application or an offer, and one applied or ignored isn't listed again.
- **Find jobs**, the fourth view next to Board, Table and Timeline:
  - **With a job skill of your own** (a Lumen skill about finding jobs, or one of your Claude Code skills when Settings → Skills → "Use my Claude Code skills" is on), Find jobs uses it: type a role and a place, and **Search in a chat** starts a chat in the project with that skill. The postings you keep are saved to the tracker as Saved.
  - **With none**, it offers **Install Job search**: [JobSpy](https://github.com/speedyapply/JobSpy) (MIT, the most-starred job scraper on GitHub), installed only when you press it, in a Python environment of Lumen's own (`job-search` in Lumen's data folder; it needs Python 3.10 to 3.13 on the computer), pinned to one version, with a **job-search** skill the AI can use. Then search right on the page (role, place, internship or full-time, posted in the last 1 to 30 days): LinkedIn, Indeed and Google Jobs are searched from this computer, and each posting has **Open** and **Save**, or **Save all**. Saved ones go to the tracker as Saved and, with a linked sheet, to the sheet as new rows ("Not started"). Postings come straight from the job boards and aren't checked: open one before applying.
  - In the project's chats the AI can search too (the applications tool's `search`), then save the ones you want.
- **The applications tool** in the project's chats: `list`, `check` (applied to this posting already? The same posting whatever its tracking parameters), `add` (after you submit: company, role, address, the tailored résumé's file name, a note; a posting saved for later moves on to applied) and `update` (a stage: saved, applied, interview, offer, rejected, withdrawn). An automation in the project logs its submits to the same tracker. Everything is kept on this computer with your automations (`automations.json`, encrypted with your system keychain).

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
- **Tools**: the model and Plan first, then the apps, MCP servers and skills its chats get (see [Tools](#tools-the-apps-mcp-servers-and-skills-a-project-uses)).
- **Settings**: first the project as a whole (Keep as project for a temporary one, Pin to top, Archive, Export project…, Delete project), then the instructions, the permissions and the folder.

An archived project's page says so above the tabs, with **Move out of archive**.

## Save a project to Google Drive

For a project you want on another computer, or kept outside Lumen:

- **Turn it on per project.** In the project's **Settings** view, **Save to Drive** (or **Save to Drive** in its card's ⋯ menu on All projects). It is off for every project until you turn it on for that one. It needs Google Drive connected in Settings → Apps and connections; if it isn't, the line says so and nothing is sent.
- **Where and what.** A folder **Lumen/Projects/<project name>** in your Drive, with readable files: `README.md`, `INSTRUCTIONS.md`, `project.json` (the name, goal line and defaults), `sources.md` (its web pages and websites), `Memory.md` and `memory.json` (its notes), `Key documents.md` and `key-documents.json` (where its documents are: paths, addresses and names) and `Chats/` (each chat as Markdown). The files you added to the project (Sources) are never uploaded.
- **When.** About 30 seconds after a change (a chat, a note, an edit), and only the files that changed. The line says when it was last saved; **Save now** saves at once. Renaming the project renames its folder. A folder or file deleted in Drive is made again on the next save.
- **Temporary projects** can't be saved until you click **Keep as project**.
- **Stop saving to Drive** stops it; what is already in Drive stays there. Deleting the project stops it too.
- **Import from Drive…** (at the top of All projects) lists the projects saved in Lumen/Projects and brings one back as a new project: its instructions, goal line, defaults, sources, notes and key documents. Its chats stay in Drive as Markdown files; they are not turned back into chats. The new project goes on saving to the same folder.
- **Drive badge.** A project being saved has a **Drive** badge on its card (hover it for when it was saved).
- OneDrive isn't offered: Lumen's OneDrive connection can only read.

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
- **Defaults**: a model for new chats and plan-first. Which apps, MCP servers and skills its chats get is on the **Tools** tab (see [Tools](#tools-the-apps-mcp-servers-and-skills-a-project-uses)).
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
- **project.json** is `{ "format": 1, "description": "...", "defaults": { "model": "...", "plan": true, "apps": ["gmail", "sheets"], "servers": ["files"], "skills": ["job-search"] } }` (a key is left out when it has its usual value; a list left out means every one, `[]` none; the older `"connectors": false` and `"mcp": false` still mean none).
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
