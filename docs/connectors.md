# Connectors

Connectors let the AI use services you already have: "what's due on Canvas this week", "summarize my unread email", "add a task to Todoist", "comment on that pull request", "put these notes in a Notion page". You connect each one in **Settings → You and AI → Connectors**. Nothing is connected until you press **Connect**, and an unconnected service adds nothing to what the AI is told.

## The gallery

Cards are grouped as Mail and calendar, School, Files and docs, Work, Tasks and Music. Each card shows what it is for, its state (**Not connected**, **Connected · account**, **Needs sign-in**, **Token refused**, or **Coming soon**) and one button. **What it can do** on a card lists exactly what the AI can read and do with it. Connect shows the same list before you confirm.

| Connector | How it signs in | What the AI can do |
|---|---|---|
| Canvas | The Canvas you are signed in to in Lumen. Lumen finds your school's address from your browsing, or you type it. | Course list, upcoming assignments and due dates, announcements (all or per course), read one announcement. Read only. |
| Gmail | Google sign-in in your browser (the same one the Gmail widget uses), read only. Without it, the Google sign-in already in Lumen works for unread mail only. | Unread mail; with the full sign-in also search and read a message. Read only: it can't make a draft (see below). |
| Google Calendar | The calendar's secret iCal address, which you paste. Only Google Calendar addresses (calendar.google.com, https) are accepted. | Events for the next days. Read only: it can't add events with an iCal address. |
| GitHub | Sign in with GitHub (a one-time code, or the GitHub CLI if it is signed in): the same sign-in as the GitHub card on the new-tab page, see [Sign in with GitHub](github-signin.md). A pasted fine-grained token still works: read-only is enough for reading; for the writes give it Issues and Pull requests **Read and write**. The sign-in reads only, unless you turn on **Include private repositories** (GitHub's `repo` permission, which also allows the writes) or use the GitHub CLI. | Your pull requests and issues (author, assigned, review), read one pull request. **Comment** on an issue or pull request and **Open an issue** ask you first. |
| Todoist | Your API token. | List tasks and projects. **Add a task** asks you first. |
| Notion | An internal integration secret. It sees only the pages you share with it. For the writes keep **Insert content** on in its capabilities. | Search and read a page. **Add a page** (under a page you shared) and **Add to a page** (at its end) ask you first. |
| Google Drive and Docs, Slack, Spotify | Coming soon. Slack waits for a maintained MCP server to point at: the one on npm is deprecated, so there is no preset. | |

## How the AI uses them

The AI gets one tool, `connector(app, action, args)`, whose description lists only the connected apps and their actions, one line each. Asking for `help` on an app explains its actions. This keeps the prompt small however many services you connect.

- **Reads** run straight away, and the step in the chat reads "Using Canvas · Upcoming assignments". What comes back is untrusted data, like a web page: once the AI has read it, the chat counts as having read page content, so a new site or a change asks first.
- **Writes** always ask, with the exact change on the card, and need a real click on **Allow** (Enter doesn't allow, and there is no "Always allow"). Auto-allow, **Bypass permissions** (in the background too), "Agents in their own window don't ask" never answer them, and hands-off mode blocks them. **Background tasks and routines** are offered the reads only, and a write they ask for anyway is refused. See [Writes](#writes).
- The sidebar and the full-page chat get the tool, whether the chat runs on an API model or on a command-line engine Lumen starts itself (Claude Code, Codex, Grok Build, Antigravity). Each such run connects to Lumen's MCP server with a random per-run tag that Lumen writes only into that run's own temporary config; the tool is listed and callable only for a session carrying a live tag, with the same rules as above (reads run, writes need a real click, results are untrusted). A command-line process that was already running when you connected a service lists its tools when it starts, so it sees the new service in the next chat.
- **Outside agents over MCP never get it** (a Claude Code you started in a terminal, an editor, any other app): it isn't in the tool list they get, and a call to it, or one with a forged tag, is refused with `Unknown tool`, so a program that can drive your browser can't read your mail or school account. Background tasks don't get it either. Letting a specific outside agent use a specific service would be its own opt-in, which doesn't exist yet.

## Writes

| Connector | Action | What is sent, and where | What you can edit on the card |
|---|---|---|---|
| GitHub | `comment(repo, number, body)` | A comment (Markdown) on that issue or pull request, as the token's owner. | The comment |
| GitHub | `create_issue(repo, title, body?)` | A new issue in that repository. | Title and description |
| Notion | `create_page(parent_id, title, body?)` | A new page under the page you shared, with the text as blocks (`#` headings, `-` bullets, `1.` numbered, `>` quotes, the rest paragraphs). | Title and text |
| Notion | `append(page_id, body)` | The text added to the end of that page, as blocks. | The text |
| Todoist | `add_task(content, due?, project_id?)` | A new task. | The task and its due date |

- The card shows where it goes (the repository and number, or the Notion page by its title, looked up with a read) and everything that will be sent. The text is in boxes you can change; **Allow** sends what the boxes hold, checked again like the AI's own input. Where it goes can't be changed on the card.
- Once done, the chat shows a step such as "GitHub · Opened ada/notes#8" with **Open**, and the AI gets the same link.
- A token that can only read gets a message instead of a failure: GitHub says to give the token Issues and Pull requests **Read and write**, Notion says to turn on **Insert content**.
- **Not available:** Gmail drafts need Google's `gmail.compose` permission, and Lumen's Google sign-in asks only for `gmail.readonly`, so the AI can't write a draft. Adding Calendar events would need a Google sign-in with Calendar access; the iCal address the connector uses can only be read, so the AI can't add events with an iCal link.

## Where your secrets go

- A token or secret address is saved encrypted with your operating system's own encryption (the same way saved passwords are), in `connectors.json` in the profile folder, next to the account name shown on the card. The settings page never gets a token back, only whether one is saved.
- Requests go only to the service itself (for Canvas, your school's address), over https, and redirects are not followed. Canvas uses the signed-in session you already have in Lumen; the others send their token in a header. Nothing goes to Lumen or anyone else.
- What a service returns goes into your chat, so it is also sent to the AI you are using (Anthropic, OpenAI, Google, xAI or whichever you picked), like the text of a page. Connect says so.
- Answers are kept in memory for 30 seconds so asking twice is one request. Nothing is cached on disk.
- **Disconnect** deletes the saved token and the card's entry and drops cached answers at once. For Gmail, the Google sign-in made by the Gmail widget stays (it is the widget's); one made from the connector is revoked.

## For developers

- `src/features/connectors/registry.js` declares each connector (id, name, icon, category, kind, fields, what it reads and does, its actions with tight argument schemas) and builds the single tool and its input check. `service.js` holds what is connected, the sealed secrets, the request helper and the dispatcher. `providers/` has one small file per service, loaded only when one is used. None of it loads at startup (`test/perf-budget.js`); `main.js` answers "is anything connected" from the small file until something needs the service.
- Tests: `test/connectors-units.js` (registry, tool size, input checks and the service against stand-in servers), `test/connector-writes-units.js` (each write's request with an injected fetch, the card's edits, the read-only messages, and the agent's gate: no bypass, background refusal) and `test/connectors.js` (the settings page, the AI with a fake model, approvals, MCP and disconnect in a real window). Stand-ins for Canvas, GitHub, Todoist, Notion and a calendar are in `test/fixtures/fake-connectors.js`; in test mode only, `global.__connectorEndpoints` points a connector at 127.0.0.1.
- Names that go into a request path (a GitHub owner/repo) are checked for `.` and `..` segments and any of `/ \ ? #`; ids in queries are plain words.
- To add a connector: declare it in `registry.js`, add `providers/<id>.js` exporting `verify(ctx)` and `actions`, and add a fake to the fixtures.
- A write action has `write: true` and `edit: [...]` (the text arguments the card lets the user change). Its provider returns `{ text, link, done }` and exports `describeWrite(action, args, names)` (everything sent) and `describeWhere` (the fixed part); an optional `cardNames(ctx, action, args)` looks up names for the card. `agent.js` `allowConnector` asks with `noBypass` and `noAlways`, applies the edits (`registry.applyEdits`), and refuses writes in background runs; `service.call(input, { readOnly })` refuses them too.
