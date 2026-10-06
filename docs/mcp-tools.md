# MCP tool reference

Lumen's MCP server (see [Use Lumen from Claude Code, Codex, Antigravity](../README.md#use-lumen-from-claude-code-codex-antigravity)) offers the same 30 tools the sidebar AI uses. This page lists them with their parameters, as returned by `tools/list`. The source of truth is the `TOOLS` array in [`src/ai/agent.js`](../agent.js); `web_search` is the client-side search tool defined next to it.

A few things apply to every tool:

- **The active tab.** An agent works in a Lumen window of its own, opened on its first call that needs a tab; `list_tabs` shows only that window's tabs (an empty list before it has one), and you never see or reach the user's tabs. Page tools (`read_page`, `click`, `type_text`, `find`, `batch`, `screenshot`, …) work on the tab in front in that window. Use `list_tabs` and `switch_tab` to pick another of its tabs.
- **Element ids.** `read_page` and `find` number the page's links, buttons and fields. `click`, `type_text`, `hover`, `upload_file`, `fill_form` and `batch` (`ref`) take those numbers. They stay valid until the page changes; read again after a navigation.
- **Approvals.** The first time an agent acts on a site in a chat, Lumen asks you in the sidebar. Once it has read page content, opening, fetching or searching a site not yet approved asks too. See [Asking before it acts](../README.md#asking-before-it-acts). A refused call returns an error that says so.
- **Cheaper reads.** `read_page` with `mode: "compact"` or `since_last: true`, `find` and `batch` cost far fewer tokens than a full read. See [Token-efficient tools](../README.md#token-efficient-tools-all-ais).

The sidebar's Claude models use Anthropic's server-side web search instead of `web_search`; every other engine and MCP client gets the tool below.

## Tools

### `read_page`

Read the active tab. mode:"compact": outline with [id] refs (use first). mode:"outline": a cheap map with no refs: title, URL, page health, h1-h3 headings, structured-data summary, links grouped by landmark (main/article first, then nav/header/footer; up to 15 each, with counts), a repeated block ("main > ul.results: 20 items like ..."), and the next-page link. mode:"full": raw JSON elements and text (text_offset/element_offset to page; structured:true adds JSON-LD, meta tags and embedded data). extract:"tables"|"links"|"lists" (+selector): JSON, no run_script needed. Ids stay valid until the page changes.

A full read of a page that is not fine starts with one line, `Page: js_shell | wall | soft_404 | data_shell — ...` (what it is and what to try), and a page drawn by script (js_shell, data_shell) also shows its compact structured data.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text_offset` | integer |  | Character offset into the page text (full mode). |
| `element_offset` | integer |  | Elements to skip in the list (full mode). |
| `mode` | `compact`, `outline`, `full` |  |  |
| `since_last` | boolean |  | compact: only what changed since your last read. |
| `start_line` | integer |  | compact: continue a clipped outline. |
| `hrefs` | boolean |  | compact: include link URLs. |
| `structured` | boolean |  | full: add compact JSON-LD, meta tags and the largest embedded data (`__NEXT_DATA__`, `ytInitialData`, ...). |
| `extract` | `tables`, `links`, `lists` |  | Return these as JSON instead of a page read: tables (rows of cells, up to 5 tables), links (`[text, href]`, up to 80), lists (items of up to 8 lists). |
| `selector` | string |  | extract: limit to this CSS selector. |

### `screenshot`

Screenshot the visible part of the active tab (for visual layout, images, charts). Prefer read_page/find; they are far cheaper.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `max_width` | integer |  | Output width in px (default 1024, max 1600). Smaller is cheaper. |
| `quality` | integer |  | JPEG quality 30–90 (default 60). |
| `region` | object |  | Crop to this rectangle in page CSS pixels (not usable with click_at). |
| `region.x` | number | yes |  |
| `region.y` | number | yes |  |
| `region.width` | number | yes |  |
| `region.height` | number | yes |  |

### `navigate`

Load a URL in the active tab. read:true also returns the new outline; wait_for waits for that text first.

| Parameter | Type | Required |
|---|---|---|
| `url` | string | yes |
| `read` | boolean |  |
| `wait_for` | string |  |
| `wait` | `interactive` \| `load` \| `networkidle` |  |

`wait` says when the page counts as loaded. `interactive` (the default) returns as soon as the page's DOM is ready and already shows real text, without waiting for images, ads and trackers; a page with no text yet (a JavaScript app shell) is still waited for until it loads. `load` waits for the load event, `networkidle` also for ~500 ms without network activity. All are capped.

### `click`

Click by [id] from read_page/find, or by visible text. observe:true (also on click_at, type_text, press_key) returns what changed: no follow-up read.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer |  |  |
| `text` | string |  | Visible text or accessible label of the element to click. |
| `observe` | boolean |  |  |

### `fill_form`

Fill several fields by label/placeholder (text, select, date, checkbox "true"/"false", radio option label). submit:true only if the user approved submitting.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fields` | object[] | yes |  |
| `fields[].label` | string | yes |  |
| `fields[].value` | string | yes |  |
| `submit` | boolean |  | Submit the form after filling it. Only when the user has approved submitting. |

### `read_urls`

Read up to 6 pages in parallel in hidden tabs without cookies/logins; as_user:true asks to read the user's own account pages signed in. Returns title + text: an article-like page as compact markdown (headings, lists, `[text](url)` links, code blocks, simple tables), anything else as its visible text. A page that is not fine starts with a `Page: js_shell | wall | soft_404 | data_shell — ...` line, and a compact "Structured data" section (meta tags, JSON-LD, and for script-drawn pages the largest embedded JSON) follows the text. Long pages come in chunks: the result ends with the `offset` for the next one.

| Parameter | Type | Required |
|---|---|---|
| `urls` | string[] | yes |
| `max_chars` | integer | no |
| `offset` | integer | no |
| `as_user` | boolean | no |
| `wait` | `interactive` \| `load` \| `networkidle` | no |

`wait` is the same as on `navigate` (default `interactive`). Pages are read in reused hidden views with images, media and web fonts not loaded, and a page read a moment ago (same chat, within 5 minutes, same options) is returned from a small cache instead of being fetched again; `as_user` reads are never cached.

`max_chars` is the chunk size per page (1000-30000, default 8000) and `offset` the character to start at (take it from the previous result's note). Signed-in (`as_user`) reads are not chunked yet.

`as_user` works for the sidebar's own AI (including its Claude Code and Grok Build engines) only. Outside agents over MCP always read signed out: the result says so, and no card is shown.

### `read_pdf`

Read the text of a PDF open in a tab (the active tab, or `tab_id`). Lumen asks you first, once per PDF per chat, even with Auto-allow on (Bypass permissions answers it for you, and a step says so); the card and the result show the file name, never its folder. The text is untrusted page content and counts as page content for the leaving-with-what-it-read rule. Each page comes under a `--- Page N of M ---` marker. Pass `query` to find which page mentions something: one call returns the matching page numbers with a short snippet each (case-insensitive). Returns up to 30,000 characters; when cut off, the result lists the pages included and the `pages` value to ask for next. The parsed text is cached per PDF, so repeat calls are cheap. Scanned or encrypted PDFs give no text.

| Parameter | Type | Required |
|---|---|---|
| `tab_id` | integer | no |
| `pages` | string ("1-5", "3", "4-", "1-3,7") | no |
| `query` | string | no |

### `read_tabs`

Read the text of several open tabs at once, without switching to them (`ids` from `list_tabs`). Only web and file pages of the same window; Lumen's own pages, sites where you turned AI off, and tabs of other windows (or of private windows) are named and skipped, and a sleeping tab returns only its address. Each tab is cut to `max_chars_each` (default 6,000, at most 12,000) and the total is capped at 40,000 characters, split evenly; the result says when a tab was cut. Each tab comes back under a `[Tab: title — host]` line. The text is untrusted page content and counts as page content for the leaving-with-what-it-read rule.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ids` | integer[] | yes | Tab ids from `list_tabs` (at most 20). |
| `max_chars_each` | integer |  | Characters per tab. Default 6000. |

### `run_script`

LAST RESORT: run JavaScript in the page (use return; async ok); result is JSON. Only when read_page, find, click, type_text, navigate, read_urls, web_search, read_pdf and batch cannot do it (e.g. extracting a large table), in one call. Never to click, type or navigate, or to bypass confirmation rules.

| Parameter | Type | Required |
|---|---|---|
| `code` | string | yes |

### `wait_for`

Wait until the active tab contains some text, up to a timeout.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes |  |
| `seconds` | number |  | Timeout, 1 to 30. Default 10. |

### `type_text`

Replace an input/textarea/contenteditable value, pick a <select> option by label, or set date/time (e.g. 2026-03-14, 13:30). Use click for checkboxes/radios. press_enter submits.

| Parameter | Type | Required |
|---|---|---|
| `element_id` | integer | yes |
| `text` | string | yes |
| `press_enter` | boolean |  |
| `observe` | boolean |  |

### `press_key`

Press a key or shortcut in the active tab, e.g. key "Enter", or key "a" with modifiers ["control"] to select all.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | One character, or Enter, Escape, Tab, Backspace, Delete, Arrow*, PageUp/Down, Home, End, Space. |
| `modifiers` | string[] |  |  |
| `observe` | boolean |  |  |

### `click_at`

Click a point in the last screenshot's pixel coordinates (canvas, maps, custom widgets).

| Parameter | Type | Required |
|---|---|---|
| `x` | number | yes |
| `y` | number | yes |
| `observe` | boolean |  |

### `hover`

Move the mouse over an element by its id from read_page, e.g. to open a hover menu.

| Parameter | Type | Required |
|---|---|---|
| `element_id` | integer | yes |

### `upload_file`

Put a file into a page's file upload: `element_id` is the file input, its label or button, or a drop zone (from `read_page` or `find`). `files` are refs of files the user attached to the chat (listed in the message as `<attached_files>`); leave it out and the user is asked to choose a file with the OS picker. The AI never names a path: only refs and the user's own pick are accepted. It does not submit the form. See [Uploading files for you](uploading-files.md).

| Parameter | Type | Required |
|---|---|---|
| `element_id` | integer | yes |
| `files` | array of strings (refs) |  |

### `go_forward`

Go forward one page in the active tab history.

No parameters.

### `reload`

Reload the active tab.

No parameters.

### `close_tab`

Close a tab by id.

| Parameter | Type | Required |
|---|---|---|
| `tab_id` | integer | yes |

### `group_tabs`

Put tabs (ids from list_tabs) into a new named group; use 1-3 word names. Tabs in another group move.

| Parameter | Type | Required |
|---|---|---|
| `name` | string | yes |
| `tab_ids` | integer[] | yes |

### `ungroup_tabs`

Take tabs out of their groups. Empty groups disappear.

| Parameter | Type | Required |
|---|---|---|
| `tab_ids` | integer[] | yes |

### `scroll`

Scroll the active tab up or down by a number of screens.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `direction` | `up`, `down` | yes |  |
| `screens` | number |  | Default 1. |

### `go_back`

Go back one page in the active tab history.

No parameters.

### `list_tabs`

List open tabs with their ids, titles, and URLs.

No parameters.

### `open_tab`

Open a URL in a new tab and make it active. read:true also returns its outline.

| Parameter | Type | Required |
|---|---|---|
| `url` | string | yes |
| `read` | boolean |  |

### `switch_tab`

Make another tab active.

| Parameter | Type | Required |
|---|---|---|
| `tab_id` | integer | yes |

### `wait`

Wait for a page to finish updating.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `seconds` | number | yes | 1 to 10. |

### `find`

Search the active tab for text: returns matching controls as [id] refs and short text snippets with nearby refs. Much cheaper than reading the whole page; use it to locate a field, button, or fact.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes |  |
| `max` | integer |  | Max results (default 8). |

### `batch`

Run several actions on the active tab in one call; stops at the first failure or when the page moves to another site. Returns what changed, so no follow-up read_page is needed. Steps: {do:"type",ref,text,enter?} {do:"click",ref\|text} {do:"select",ref,text} {do:"press",key,modifiers?} {do:"wait_for",text} {do:"scroll",direction} {do:"hover",ref}. Confirmation rules still apply.

| Parameter | Type | Required |
|---|---|---|
| `steps` | object[] | yes |
| `steps[].do` | `type`, `click`, `select`, `press`, `wait_for`, `scroll`, `hover` | yes |
| `steps[].ref` | integer |  |
| `steps[].text` | string |  |
| `steps[].enter` | boolean |  |
| `steps[].key` | string |  |
| `steps[].modifiers` | string[] |  |
| `steps[].direction` | `up`, `down` |  |

### `web_search`

Search the web and get the top results (title, URL, snippet). Use it for current facts; then read_urls or navigate to open a result.

| Parameter | Type | Required |
|---|---|---|
| `query` | string | yes |

### `generate_image`

Make a picture, or edit the chat's latest one with `edit: true`; it is shown in the chat with a "Made with <provider · model>" line. Lumen sends the request to a provider you have already connected that makes pictures, whatever model the chat is on (see [Image generation](image-generation.md)). Only in Lumen's own sidebar chat: an outside MCP agent has nowhere to show a picture and is refused, so it can't spend your providers.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | What to draw. Style and size go in the words. |
| `edit` | boolean |  | Edit the latest picture in this chat (OpenAI, Gemini, OpenRouter and Grok Build can; Grok's API can't). |

### `analyze_posts`

Find which posts beat their own account's normal. Pure local math: it makes no request and needs no tab, so it works before an agent has a window. Give it rows you already collected (up to 200); it returns each account's median baseline, then the outliers by lift (`×3.4`) labelled `huge` (5x or more), `strong` (2 to 5x) or `mild` (1.5 to 2x). The baseline is per account, and per account and format when that format has 5 or more rows. An account with fewer than 10 rows is marked low confidence, and rows with no usable number are listed under "Not enough data" rather than guessed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `posts` | object[] | yes | `{ url, account?, format?, views?, likes?, replies?, reposts?, comments?, shares?, date? }` |
| `metric` | `views`, `engagement`, `auto` |  | `views` for video, `engagement` (likes + replies + reposts + comments + shares) for text; `auto` (default) uses views when most rows have them. |
