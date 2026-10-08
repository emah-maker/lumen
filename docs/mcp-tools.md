# MCP tool reference

Lumen's MCP server (see [Use Lumen from Claude Code, Codex, Antigravity](../README.md#use-lumen-from-claude-code-codex-antigravity)) offers the same 33 tools the sidebar AI uses. This page lists them with their parameters, as returned by `tools/list`. The source of truth is the `TOOLS` array in [`src/ai/agent.js`](../agent.js); `web_search` is the client-side search tool defined next to it.

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
| `mode` | `compact`, `full`, `outline`, `site` |  | `full`: the raw page text and elements, never the site view below. `outline`: the cheap map described above. `site`: ask for the site view explicitly. |
| `since_last` | boolean |  | compact: only what changed since your last read. |
| `start_line` | integer |  | compact: continue a clipped outline. |
| `hrefs` | boolean |  | compact: include link URLs. |
| `structured` | boolean |  | full: add compact JSON-LD, meta tags and the largest embedded data (`__NEXT_DATA__`, `ytInitialData`, ...). |
| `extract` | `tables`, `links`, `lists` |  | Return these as JSON instead of a page read: tables (rows of cells, up to 5 tables), links (`[text, href]`, up to 80), lists (items of up to 8 lists). |
| `selector` | string |  | extract: limit to this CSS selector. |

On a Reddit, Hacker News, YouTube, X, TikTok or GitHub page, a plain `read_page` (no `mode`, offsets, `elements`, `structured`, `selector` or `extract`), or `mode:"site"`, returns that site's [structured view](#site-views) instead of the raw page text. It has no element ids: use `mode:"compact"` or `find` to click, or `mode:"full"` for the raw page.

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

### `video_overview`

Look at the main `<video>` of a tab (the active tab, or `tab_id`; a video file or video URL opened directly counts) as ONE labelled contact sheet: frames evenly spaced over the video (or over `start`–`end`), each cell stamped with its time (`m:ss`). Lumen pauses the video, seeks to each moment with Chromium's own decoder (no ffmpeg), grabs the frame and puts playback back exactly (position, muted, playing or paused). The result is one JPEG plus a header: duration, resolution, the frame times, and the estimated image tokens (per model family: Claude, OpenAI or Gemini rules; an outside agent is estimated as Claude). Frames are fitted to `token_budget` (default 6,000) by shrinking the cells first, then using fewer frames. Speech is not in the frames: the result points to the page's transcript (`read_page`, `read_urls`) when it has one. Refused with a plain message: no video on the page (videos inside embedded frames are not reached), DRM-protected video (its frames would be black), live streams, a video that has not loaded. A cross-origin video is captured from the screen instead of the page (the video is scrolled into view and the scroll put back), so player overlays can show. Frames are page content: untrusted, and they count as page content for the leaving-with-what-it-read rule. Same checks as `screenshot` (AI off for the site, hands-off); it runs one at a time.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | integer | no | Another tab of the window. |
| `frames` | integer | no | 4–36, default 16. |
| `start` | string | no | Window start, seconds or `m:ss`. |
| `end` | string | no | Window end, seconds or `m:ss`. |
| `token_budget` | integer | no | Image tokens for the sheet (default 6,000). |

### `video_frames`

Full-size frames of the same video at chosen moments (`at`: up to 8 timestamps in seconds or `m:ss`), each stamped with its time: separate images up to 4, one compact 2-column sheet for more. Use it after `video_overview` for the moments that matter. Playback is restored the same way, and the same refusals and checks apply.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `at` | array of strings | yes | Timestamps, seconds or `m:ss`. |
| `tab_id` | integer | no | Another tab of the window. |
| `max_width` | integer | no | Frame width in px (default 1,024; 784 in a sheet; at most 1,568). |

### `navigate`

Load a URL in the active tab. read:true also returns the new outline; wait_for waits for that text first.

| Parameter | Type | Required |
|---|---|---|
| `url` | string | yes |
| `read` | boolean |  |
| `wait_for` | string |  |
| `wait` | `interactive` \| `load` \| `networkidle` |  |

`wait` says when the page counts as loaded. `interactive` (the default) returns as soon as the page's DOM is ready and already shows real text, without waiting for images, ads and trackers; a page with no text yet (a JavaScript app shell) is still waited for until it loads. `load` waits for the load event, `networkidle` also for ~500 ms without network activity (on a tab, judged by the same request tracker as `wait_for` `network_idle`, which ignores analytics and long-polls). All are capped.

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
| `wait` | `interactive` \| `load` \| `networkidle` | no |
| `max_chars` | integer | no |
| `offset` | integer | no |
| `as_user` | boolean | no |

`wait` is the same as on `navigate` (default `interactive`). Pages are read in reused hidden views with images, media and web fonts not loaded, and a page read a moment ago (same chat, within 5 minutes, same options) is returned from a small cache instead of being fetched again; `as_user` reads are never cached.

`max_chars` is the chunk size per page (1000-30000, default 8000) and `offset` the character to start at (take it from the previous result's note). Signed-in (`as_user`) reads are not chunked yet.

`as_user` works for the sidebar's own AI (including its Claude Code and Grok Build engines) only. Outside agents over MCP always read signed out: the result says so, and no card is shown.

### Site views

`read_urls` (signed out) and a plain `read_page` read these addresses from the site's own compact feed instead of the page, so a long thread is not cut off in the middle of its comments. The text starts with `Source: <site> (<how>)` and stays inside `<untrusted_page_content>`; all approval, redirect and site-off rules apply first. If the feed fails, is blocked or rate limited, or the page is private, the normal page read is used. Read-only: no cookies are sent and nothing is posted or changed. In `read_urls` each view is capped at `max_chars` (default 8,000; a plain `read_page` uses 8,000), and `offset` pages through a longer view with the same next-offset note as a page read (comments are flattened one per line, `[d2] u/name 1.2k · 3h: text`, deepest replies dropped first, with a count of what was left out).

| Site | Addresses | Source |
|---|---|---|
| Reddit | posts and comment threads, subreddit listings, user pages, search | JSON, else Atom RSS (the RSS has no scores or reply nesting); on a loaded or signed-in page, the page itself |
| Hacker News | `item?id=`, front page, `/ask`, `/show`, `/newest`, `/jobs` | hn.algolia.com |
| YouTube | `watch?v=`, `youtu.be`, `/shorts`, `/live` | oEmbed, the player data, and captions as `[m:ss]` paragraphs (English or the video's own language; says so when there are none) |
| X / Twitter | `/status/<id>` | the public post embed data, else oEmbed |
| TikTok | `/@user/video/<id>` | oEmbed; on a loaded page, its own data (plays, likes, comments) |
| GitHub | repo, issue and pull request pages | the public GitHub API (README, discussion) |

### `read_pdf`

Read the text of a PDF open in a tab (the active tab, or `tab_id`). Lumen asks you first, once per PDF per chat, even with Auto-allow on (Bypass permissions answers it for you, and a step says so); the card and the result show the file name, never its folder. The text is untrusted page content and counts as page content for the leaving-with-what-it-read rule. Each page comes under a `--- Page N of M ---` marker. Pass `query` to find which page mentions something: one call returns the matching page numbers with a short snippet each (case-insensitive). Returns up to 30,000 characters; when cut off, the result lists the pages included and the `pages` value to ask for next. The parsed text is cached per PDF, so repeat calls are cheap. Scanned or encrypted PDFs give no text. It reads a PowerPoint deck (.pptx) open in Lumen's slide viewer the same way: one page per slide, with the speaker notes after each slide's text.

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

Wait until the active tab meets every condition given, up to a timeout. `url` is a substring of the tab's address, or a `*` glob that must match all of it. `gone` is text or a CSS selector (`#spinner`, `.loading`, `div.busy`) that must no longer be on the page. `network_idle` waits until nothing the page requested is still in flight for about 500 ms and the page has stopped loading; ad and tracker hosts, `data:` URLs, images, fonts and media still loading after 3 s, and requests open for over 10 s (long polls, streams) are ignored. A timeout says what is still pending, for example `Timed out after 10s; still pending: network busy: 3 requests in flight (api.example.com, cdn.example.com)`. The same options work in a `batch` `wait_for` step.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string |  | Text that must be on the page. |
| `url` | string |  | Substring or `*` glob the tab's address must match. |
| `gone` | string |  | Text or CSS selector that must disappear. |
| `network_idle` | boolean |  | No requests in flight for about 500 ms. |
| `seconds` | number |  | Timeout, 1 to 30. Default 10. |

At least one of `text`, `url`, `gone`, `network_idle` is needed.

### `get_console`

The tab's console messages and uncaught errors, as one line each: `[err] 12:01:03 TypeError: x is undefined (app.js:120)`. Lumen starts keeping them (the newest 300) when an agent first works in a tab, so the first call shows only what happened since then; the result says when capture began. Page content, so it is wrapped like any other page read.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | integer |  | A tab from `list_tabs`. Default: the active tab. |
| `level` | `error`, `warning`, `info`, `all` |  | Default `warning` (warnings and errors). |
| `since_last` | boolean |  | Only what came after the last `get_console` of this tab. |

### `get_network`

The requests a tab made, one line each: `GET 404 api.example.com/v1/items 230ms xhr` (or `GET ERR net::ERR_... host/path kind`). The newest 500 are kept from the moment an agent first works in the tab, so the first call can only show what came after; the result says when capture began and what is in flight now. Query strings are left out by default, and headers and bodies are never recorded. Lumen cannot tell `fetch` from `XMLHttpRequest`, so `fetch` and `xhr` filter the same requests.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tab_id` | integer |  | A tab from `list_tabs`. Default: the active tab. |
| `failed` | boolean |  | Only status 400 and above, or requests that failed. |
| `type` | `xhr`, `fetch`, `document`, `script`, `all` |  | Default `all`. |
| `url_contains` | string |  | Only requests whose address contains this (case-insensitive; matched against the full address, query included). |
| `since_last` | boolean |  | Only what came after the last `get_network` of this tab. |
| `include_query` | boolean |  | Keep query strings in the lines. |

### `handle_dialog`

Answer a `confirm` or `prompt` dialog the page opened. A dialog freezes the page, so while one is open every tool that needs the page stops and the result begins `Dialog open: confirm "Delete item?" — use handle_dialog`; `get_console`, `get_network`, `list_tabs` and the other tools that name no page still work. Lumen answers the others itself and tells you in the next result: an `alert` is accepted, and a `beforeunload` ("Leave site?") is accepted only while the agent's own `navigate`, `go_back`, `go_forward` or `reload` runs (otherwise the page is kept). A confirm or prompt is never answered automatically. Like a click, `handle_dialog` is an action: it needs the site's approval, and it is refused where the user keeps the AI from acting on the tab or hands-off mode applies.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `accept` | boolean | yes | true is OK, false is Cancel. |
| `text` | string |  | The answer to a `prompt`. |
| `tab_id` | integer |  | Default: the active tab. |

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

Put a file into a page's file upload: `element_id` is the file input, its label or button, or a drop zone (from `read_page` or `find`). `files` are refs of files the user attached to the chat (listed in the message as `<attached_files>`). `paths` are files on this computer (`~/Desktop/photo.png`, an absolute path or a `file://` address), accepted only while Settings > AI > "Let the AI use files on this computer" is on; Lumen's own profile, credentials folders (`~/.ssh`, `~/.aws`, keychains, ...) and `.env`/key files are always refused. Leave both out and the user is asked to choose a file with the OS picker. The first upload to a site in a chat shows a card naming the files (unless Auto-allow or Bypass is on). It does not submit the form. See [Uploading files for you](uploading-files.md).

| Parameter | Type | Required |
|---|---|---|
| `element_id` | integer | yes |
| `files` | array of strings (refs) |  |
| `paths` | array of strings (local paths) |  |

### `drag`

A mouse drag from an element (`from_id`) or a point of the last screenshot (`from_x`, `from_y`) to another (`to_id`, or `to_x`, `to_y`), sent through the tab's DevTools session so it works in a background tab too. If the page starts an HTML5 drag-and-drop, the drop (with its data) is delivered at the target; otherwise the pointer moves there with the button held (sliders, sortable lists, canvases). An acting tool: it asks like `click`.

| Parameter | Type | Required |
|---|---|---|
| `from_id` / `from_x`, `from_y` | integer / numbers | one of them |
| `to_id` / `to_x`, `to_y` | integer / numbers | one of them |

### `list_files`

List a folder on this computer, newest first, with sizes and dates (folders end in `/`, hidden files left out). `folder`: `desktop` (default), `downloads`, `documents`, `pictures`, `movies`, `music`, `home`, or a path. `match`: a glob (`*.png`) or words. Needs Settings > AI > "Let the AI use files on this computer"; credentials folders and Lumen's profile are never listed, and links are judged by where they point.

| Parameter | Type | Required |
|---|---|---|
| `folder` | string |  |
| `match` | string |  |
| `limit` | integer (1–200, default 50) |  |

### `clipboard`

`action: "write"` puts `text` on the system clipboard. `action: "read"` returns the clipboard's text (marked as untrusted content, cut at 20,000 characters) and needs the same setting as `list_files`.

| Parameter | Type | Required |
|---|---|---|
| `action` | `read`, `write` | yes |
| `text` | string |  |

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

Run several actions on the active tab in one call; stops at the first failure or when the page moves to another site. Returns what changed, so no follow-up read_page is needed. Steps: {do:"type",ref,text,enter?} {do:"click",ref\|text} {do:"select",ref,text} {do:"press",key,modifiers?} {do:"wait_for",text|url|gone|network_idle} {do:"scroll",direction} {do:"hover",ref}. Confirmation rules still apply.

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

### `annotate`

Draw on the page the user is looking at to explain it, like a teacher marking a screenshot: `box`, `circle`, `arrow`, `highlight`, `label`, `step` (numbered badges: number your written steps to match), `spotlight` (dims everything else) and `underline`. Marks follow an element (an id from `read_page` / `find`, or `text:…` for text on the page) through scroll, resize and zoom; marks given as `x`, `y`, `w`, `h` of the latest `screenshot` are anchored to the page where they were drawn. In Lumen's PDF viewer they stay on their PDF page. The drawing is a click-through overlay the page cannot read, with a "Clear drawings" button and Esc; it changes nothing on the page, so it needs no approval, but a site where the user turned AI off refuses it. Where an overlay can't go (Chrome's own PDF viewer), the marks are drawn on a screenshot, which is returned (and shown in Lumen's chat). Up to 20 marks per call, 30 on the page.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `marks` | object[] | yes (unless `clear`) | `{ type, target?, x?, y?, w?, h?, to?: { target } or { x, y }, text?, color? }`; `color` is one of red, orange, yellow, green, blue, purple, pink, black, white; `text` is a short label (80 characters). |
| `clear` | boolean |  | Remove the drawings first (alone: just remove them). |
| `duration` | string |  | `until_dismissed` (default) or a number of seconds. |

### `analyze_posts`

Find which posts beat their own account's normal. Pure local math: it makes no request and needs no tab, so it works before an agent has a window. Give it rows you already collected (up to 200); it returns each account's median baseline, then the outliers by lift (`×3.4`) labelled `huge` (5x or more), `strong` (2 to 5x) or `mild` (1.5 to 2x). The baseline is per account, and per account and format when that format has 5 or more rows. An account with fewer than 10 rows is marked low confidence, and rows with no usable number are listed under "Not enough data" rather than guessed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `posts` | object[] | yes | `{ url, account?, format?, views?, likes?, replies?, reposts?, comments?, shares?, date? }` |
| `metric` | `views`, `engagement`, `auto` |  | `views` for video, `engagement` (likes + replies + reposts + comments + shares) for text; `auto` (default) uses views when most rows have them. |

### `find_sources`

Search scholarly databases at once: OpenAlex, Crossref, Semantic Scholar, arXiv and PubMed (free, no key; nothing about the user is sent, only the query). Results are merged and deduped by DOI or title, ranked by how many databases agree, and each has authors, year, venue, DOI, an open-access PDF link (OpenAlex's best open-access location, or the preprint / PubMed Central copy), a citation count where the database has one, an abstract snippet and a `[type, year, citations, retraction]` label. A retracted work reads `RETRACTED per <database>`. A database that is rate limited, slow or offline is named in the answer and the others still answer; with all of them offline the answer says so. Repeated identical searches within ten minutes come from memory. `related` with `doi` follows one paper: `cited_by` lists who cites it (most cited first), `references` what it cites. In the sidebar chat the results are numbered `S1`, `S2`, ... for `research_board`. Read-only; in a chat that has read page content the search asks first, like `web_search`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes (unless `related`) | Keywords; arXiv terms are ANDed. |
| `from_year`, `to_year` | integer |  | Publication years, inclusive. |
| `open_access` | boolean |  | Only works with a free full text. |
| `limit` | integer |  | 1 to 20, default 8. |
| `related` | `cited_by`, `references` |  | Snowball from one paper. |
| `doi` | string |  | The paper for `related`. |

The sidebar chat also has `research_board` (not listed to MCP clients: it is the chat's own source list, saved with the chat): `add` (ids from `find_sources`, or `url` / `title` / `authors` / `year` / `venue` of a page it read; `url: "current"` captures the tab's own metadata), `quote` (pin an exact quote; it is checked against the page or PDF text the AI read in that chat and marked verified or not found, with the heading or page and a link to the passage), `star`, `remove` (never a source the user added), `list` and `cite` (`apa`, `mla`, `chicago`, `ieee`, `bibtex`, `ris`).

### `run_macro`

Run one of the user's saved macros (Settings → Macros: [docs/macros.md](macros.md)) by name. `list: true`, or no name, returns the names with their descriptions, the variables they ask for and any site they are limited to. The macro's steps run as the same tools listed here (`click`, `type_text`, `navigate`, `press_key`, `wait_for`, `scroll`, `switch_tab`, `open_tab`, `close_tab`), so every approval the AI's own steps need still applies: the first click or typing on a new site asks, and a step that clicks a submit, buy, send, post or delete control, or presses Enter to submit, asks again with a card naming the step. A macro that has an "Ask AI" step or uses `{{clipboard}}` is not run by an agent at all. Hands-off mode, a site where the user turned AI off and a tab kept off-limits refuse it like any acting tool. A failed step is an error naming the step and the reason.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string |  | The macro's name (any case; a unique start or piece of the name is enough). |
| `variables` | object |  | Values for the macro's `{{placeholders}}`, for example `{"query": "red shoes"}`. A missing one is reported by name. |
| `list` | boolean |  | List the macros instead of running one. |
