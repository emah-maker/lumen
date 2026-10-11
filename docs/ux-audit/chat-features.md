# UX audit: chat features (sidebar and lumen://chat)

Inventory and audit of Lumen's AI chat against ChatGPT, Claude.ai, Gemini, Perplexity and Copilot as of 2026. This document is the deliverable; it will be split into build tasks. The only code change in this PR is one trivial fix (bug B9).

How it was done: code read (paths below are relative to `src/`; the renderer bundle `ui.bundle.*` is generated from these files, so lines point at the sources) plus a walk in hidden Electron windows (`LUMEN_TEST_BACKGROUND=1`, a fresh temp profile, a fake Claude client that streams scripted replies: markdown, a 90-paragraph reply, a slow reply, thinking, errors). Screenshots are local only, in `docs/ux-audit/shots/` (gitignored): `md-light-sidebar-top`, `md-light-sidebar-narrow300`, `md-dark-sidebar-mid`, `long-streaming-scrolled-up`, `after-stop`, `edit-open`, `history-panel`, `error-overloaded`, `empty-sidebar-light/dark`, `page-light-wide`, `page-light-wide-mid`, `page-light-narrow520`. Dark mode was driven with Playwright `emulateMedia` (the OS-theme route does not reach a hidden window).

Not verified in a run (read from code only): PDF attachments, drag-drop, paste, the approval cards, a11y focus order, restart persistence of a draft. Error scenarios were run on a machine with Claude Code installed, so model fallback fired and changed what was shown; only the first error (overloaded) is reported from that run.

## 1. Feature gap table

Status: Have, Partial, Missing. Evidence is `file:line`.

| # | Feature | Status | Evidence and notes |
|---|---|---|---|
| 1 | Edit and resend a sent message | Partial | Only the latest message, only once the reply is done: `renderer/chat-core.js:949` (`editLast`), button `:1003`. Earlier messages have no Edit. Sending truncates everything after. |
| 2 | Regenerate with version navigation (‹ 2/3 ›) | Missing | Regenerate exists (`chat-core.js:1555`, `askAgain` `:922`) but replaces the old answer (`rewind` in main); nothing keeps versions. Verified: reply 4 became reply 5, no navigator. |
| 3 | Branching | Missing | No code. Edit and regenerate both destroy the later turns. |
| 4 | Copy message | Partial | Assistant reply: copy button with rich-text plus Markdown source, `chat-core.js:1578-1620`. Your own bubbles have no copy. |
| 5 | Copy code | Have | `chat-core.js:1237-1250` (`decorateCode`, per-block Copy). |
| 6 | Code block: language label | Have | `chat-core.js:1244`. |
| 7 | Code block: syntax highlight | Partial | Hand-written tokenizer, 13 languages (`renderer/highlight.js:8-22`). `html`, `xml`, `yaml`, `php`, `ruby`, `kotlin`, `swift`, `toml`, `diff` show plain (verified for html). |
| 8 | Code block: wrap toggle | Missing | Long lines scroll sideways (`white-space: pre`, verified). No wrap or expand control. |
| 9 | Markdown tables | Partial | Rendered in a scroll wrapper, `renderer/markdown.js:446`. A wide table in the 360 px sidebar crushes text-heavy columns to one word per line and scrolls sideways (`md-light-sidebar-top`). No copy-as-table or CSV. |
| 10 | LaTeX / math | Have | Temml, MathML, inline and display, `\ce`, siunitx (`markdown.js:1-130`). Verified rendering light and dark. |
| 11 | Mermaid / diagrams | Missing | `mermaid` fences show as plain code (verified). |
| 12 | Artifacts / canvas side panel | Missing | No code. Long code and documents stay inline. |
| 13 | Inline citations and source cards | Partial | `/research` renders a sources block with quality chips (`chat-core.js:1239`, `researchUi.decorate`). In a normal answer `[1]` stays plain text and `[1]: url` shows as its own paragraph (B5). No hover card, no favicon row. |
| 14 | Thinking / reasoning display | Partial | Collapsible `<details>` with "Thought for 4s" (`chat-core.js:1293`, `:918`). Plain text, not Markdown, and not saved: gone after reopening the chat (B7). |
| 15 | Stop generating | Have | Stop button, Esc in an empty composer (`chat-core.js:2170`). Verified. |
| 16 | Continue generating | Partial | A "Continue" button only appears when a run hits its step limit (`chat-core.js:1414`, `event.action === 'continue'`). After a manual Stop there is none (verified: only Regenerate and Copy). |
| 17 | Scroll-to-bottom and "new messages" | Partial | Follow-while-at-bottom plus a "Jump to latest" button, reduced-motion aware (`chat-core.js:421-456`). Verified. No count or "new messages" label, and it overlaps content (B14). |
| 18 | Message timestamps | Missing | None on messages (no `<time>`); only the chat list shows times (`renderer/chat-items.js:13`). Transcript items carry no time (`ai/agent.js:1390`). |
| 19 | Model used per message | Partial | Quiet label under each live reply (`chat-core.js:1518`). Lost when the chat is reopened (B7). |
| 20 | Thumbs up/down feedback | Missing | No code. |
| 21 | Retry on error | Have | "Try again" on error cards (`chat-core.js:1436`), plus "Retry on <model>" after a fallback. |
| 22 | Attach: drag-drop | Have | Sidebar drop zone, `chat-core.js:797-806` (code read; the page uses its own handler). |
| 23 | Attach: paste image | Have | `chat-core.js:788`. |
| 24 | Attach: file chips with preview | Partial | Chips with name and size and a remove button (`chat-core.js:726`, `:1021`); no thumbnail or open-preview for files. Pictures show as thumbnails in the sent bubble. |
| 25 | Attach: PDFs | Partial | Files go through the uploads store (`features/upload-files.js`, `features/pdf-input.js`); max 10 attachments (`chat-core.js:572`). Not exercised in a run. |
| 26 | Voice dictation | Missing | No `SpeechRecognition` use anywhere in the renderer. |
| 27 | Read aloud (TTS) | Missing | No `speechSynthesis` use. |
| 28 | Follow-up suggestions | Missing | None after replies. |
| 29 | Prompt starters | Have | Five chips in the empty state (`chat-core.js:2231`); verified. |
| 30 | Chat search (full text) | Partial | Title-only filter, and the box only appears with more than 6 chats (`renderer/chats.js:48`, `chat-items.js` `matches`). |
| 31 | Pin chats | Missing | No code. |
| 32 | Rename chats | Have | `chat-items.js:94-118`. |
| 33 | Folders / projects | Missing | No code. |
| 34 | Archive | Missing | No code. |
| 35 | Delete with undo | Partial | Two-click confirm, then a hard delete with no undo (`chat-items.js:175-195`). Verified: row gone, no undo UI. |
| 36 | Share / export | Partial | Markdown only, via a save dialog (`main.js:8474`, `chat-items.js:208`). No PDF, no copy-link, no export of the open chat from the chat header. |
| 37 | Custom instructions / memory / personas | Partial | Skills and slash commands exist (`features/skills.js`, `renderer/skills.js`); no standing custom instructions, no memory, no persona. |
| 38 | Shortcut: Ctrl+K search | Missing | Verified: nothing happens (`chat-core.js:2156` handles only Enter and Esc). |
| 39 | Shortcut: Esc stops | Have | See 15. |
| 40 | Shortcut: Up edits last | Missing | Verified: Up in an empty composer does nothing. |
| 41 | Shortcut: Ctrl+Shift+C copies last | Missing | No handler. (Ctrl+Enter = "send now" exists, `chat-core.js:2158`.) |
| 42 | Draft persistence per chat | Missing | There is one composer value; it survives New chat and chat switches and lands in whichever chat is open next (`clearChatView` `chat-core.js:2237` never touches `prompt`). Verified. |
| 43 | Long user message collapse | Missing | Long pasted messages show in full. |
| 44 | Per-chat model switch | Have | Picker in the header; the model is saved in each chat (`features/chat-store.js` index `model`). |
| 45 | Usage / limits display | Have | "This chat: tokens and cost" line plus the context meter and provider bars (`renderer/chats.js:15`, `chat-extras.js`). |
| 46 | Accessibility: live regions | Have | Log role with `aria-live=off` while streaming, one polite status note per finished reply or approval, `role=alert` on errors (`chat-core.js:1540-1550`). |
| 47 | Accessibility: reduced motion | Have | Honoured in the jump button, chat list, picker, chat page (`chats.css:23`, `chat-page.css:42`). |
| 48 | Accessibility: focus order | Partial | List rows are arrow-key navigable (`chat-items.js:64`); the Edit and copy rows are reachable; the per-reply icon buttons are tiny (14 px). Not walked with a screen reader. |
| 49 | Dark / light parity | Have | Checked in both on the sidebar (`md-dark-sidebar-mid`); code colours have dark tokens (`ui.bundle.css:1236`). |
| 50 | Narrow sidebar layout | Have | 300 px and 360 px: no horizontal page scroll, long tokens wrap, wide content scrolls inside its own box (`md-light-sidebar-narrow300`). |

Counts (50 rows): Have 16, Partial 16, Missing 18.

## 2. Bug and issue audit

Severity: High (wrong or lost content), Medium (misleading or clearly broken), Low (polish). All reproduced in a hidden window unless marked "code".

| ID | Sev | Summary | Steps | Expected | Actual | Where |
|---|---|---|---|---|---|---|
| B1 | High | Block quotes are not rendered | Reply containing `> quote` | Indented quote block | Literal `> A block quote...` text | `renderer/markdown.js:449` (`render`, no blockquote branch) |
| B2 | High | Nested and mixed lists are flattened and the numbering breaks | `- a`, indented `  - b`, then `1. x`, indented `   - y`, `2. z` | Nested lists; one ordered list 1, 2 | Nested items at the top level; the ordered list is split into three lists, so it shows "1. first", a bullet, "2. second" | `markdown.js:457-540` (list handling is line-by-line, no indent depth) |
| B3 | Medium | Task lists, strikethrough and horizontal rules print their syntax | `- [x] done`, `~~gone~~`, `---` | Checkbox, struck text, a rule | Literal `[x] done`, `~~gone~~`, `---` | `markdown.js:454-540` |
| B4 | Medium | Bold containing italic, and backslash escapes, are wrong | `**bold *nested* inside**`, `\*` | Bold with italic inside; a star | Literal `**` around the text; `\*` keeps its backslash | `markdown.js` inline pass |
| B5 | Medium | Reference links, `[1]` citations and footnotes are not resolved | `Claim [1]` plus `[1]: https://...`, and `[^n]` | Linked marker; definition hidden | `[1]` plain; the definition prints as its own paragraph; `[^n]` literal | `markdown.js:449-540` |
| B6 | Low | Mermaid fences show source | ```` ```mermaid ```` | Diagram | Plain code block | `chat-core.js:1237` |
| B7 | Medium | Reopening a chat drops thinking, per-reply model label and the steps detail | Run a thinking reply, New chat, reopen it from history | Same view as live | `details.thinking` 1 to 0, `.reply-model` 1 to 0; tool steps collapse to "Used N actions" | `chat-core.js:1989-2080` (`showHistory`); `ai/agent.js:1390` (`transcriptFor` stores no model, time or thinking) |
| B8 | Medium | Stop leaves a half reply with no way to continue | Start a long reply, press Esc | A Continue action | "Stopped." plus Regenerate and Copy only | `chat-core.js:1414` (Continue only for step limits) |
| B9 | Low | Chat titles lost underscores: `my_func` became `myfunc`. **Fixed in this PR** | Ask "why does my_snake_case_fn fail" | Title keeps `my_snake_case_fn` | Underscores stripped everywhere | `features/chat-title.js:24` (now strips only emphasis-style underscores) |
| B10 | High | Deleting a chat is permanent with no undo, and the 50-chat cap silently deletes the oldest | Delete via the row's trash twice; or save a 51st chat | Undo window; a warning before pruning | Gone at once (and its pictures and uploads); old chats pruned silently | `chat-items.js:175-195`; `main.js:8440-8450`; `features/chat-store.js:27` (`limit = 50`) |
| B11 | Medium | Chat search is title-only and hidden below 7 chats | Have 5 chats, look for a way to search; search for a word from an answer | Search box always; matches message text | No box until 7 chats; titles only | `renderer/chats.js:48`; `chat-items.js` (`matches`) |
| B12 | Medium | One draft for all chats | Type text, click New chat or open another chat | Draft stays with its chat | The same text appears in the new chat's composer | `chat-core.js:2237-2262` (`clearChatView`, `$('new-chat').onclick`) |
| B13 | Medium | Regenerate and Edit destroy the earlier answer with no way back | Regenerate a good answer | Old answer kept as version 1 | Replaced; only a new roll remains | `chat-core.js:922-947`, `:949` |
| B14 | Low | "Jump to latest" floats over text with no label of what is new; wide tables crowd it | Scroll up in a long reply | Button clear of content, says what arrived | Circle button over the table and text (`md-light-sidebar-top`) | `chat-core.js:421-456`, `ui.bundle.css` `.jump-latest` |
| B15 | Low | Wide tables are cramped in the sidebar | 8-column table at 360 px | Readable columns or a fit-to-width view | Columns wrap to one word per line, plus a sideways scrollbar at the bottom | `markdown.js:446`; `styles.css` `.table-wrap` |
| B16 | Low | After an overloaded error with fallback there are two retry buttons | Fake a 529 | One retry path | "Retry on Claude Haiku 5.5" in the notice and "Try again" on the error | `chat-core.js:1387-1440` |
| B17 | Low | No keyboard path for Up-to-edit, Ctrl+K or Ctrl+Shift+C | Press them | See gap rows 38, 40, 41 | Nothing | `chat-core.js:2156` |
| B18 | Low | Reply action icons are 14 px with no visible labels | Hover and Tab over a reply | Comfortable targets | Tiny regenerate and copy icons | `chat-core.js:1550-1560` |

Checked and fine: streaming follows the bottom and stops following when you scroll up; Esc stops; a reply running in another chat keeps running when you start a new chat (the history row shows "Working" and the Stop button comes back when you reopen it); a long unbroken token wraps at 300 px; math renders in both themes; no console or page errors in any run; the full-page chat shows the same reply and the narrow window (the minimum is about 815 px wide) has no horizontal scroll.

## 3. Ranked build plan

Five packages, ordered by value. Each is 1 to 3 hours. They overlap only where noted.

### WP1: Markdown correctness (fixes B1 to B6, B15; gap rows 7, 8, 9, 11, 13)
Add block quotes, nested lists with a correct ordered-list numbering, task lists, rules, strikethrough, nested emphasis, backslash escapes, reference links and footnotes, `[n]` citation markers linked to their definitions; more highlight languages (html, xml, yaml, toml, diff, php, ruby, kotlin, swift); a code wrap toggle; a mermaid renderer loaded lazily from `renderer/vendor/`; a table fit mode.
Files: `src/renderer/markdown.js`, `src/renderer/highlight.js`, `src/renderer/styles.css` (code and table rules), new vendor file for mermaid, tests `test/markdown-*-units.js`. Touches `chat-core.js` only at `decorateCode` (`:1237`).

### WP2: Message actions and history fidelity (B7, B8, B13, B17 partly; rows 1, 2, 3, 4, 14, 16, 18, 19, 20, 41)
Save the model, time and thinking with each reply; show timestamps and the model after reopening; Continue after Stop; regenerate that keeps versions with a ‹ 2/3 › switch; edit on any earlier user message (starts a branch); copy on user bubbles; thumbs (stored locally); Ctrl+Shift+C. Put the new UI in a new file `src/renderer/chat-actions.js` so `chat-core.js` changes stay at the hooks.
Files: `src/ai/agent.js` (`transcriptFor`), `src/features/chat-store.js` (snapshot schema), `src/main.js` (`rewind`, history view `:4574`), `src/renderer/chat-core.js` (`:922-1060`, `:1518-1620`, `:1989-2080`), new `chat-actions.js`, `chat-page.html` and `index.src.html` script tags, `ui.bundle` rebuild, i18n strings.

### WP3: Chat library (B10, B11; rows 30 to 36)
Full-text search (a main-side index over saved chats, always-visible box), pin, archive, simple folders, delete with undo (soft delete for about 10 s), a warning and a setting before the 50-chat cap prunes, export as PDF (print the Markdown render) and Copy as Markdown from the chat header.
Files: `src/features/chat-store.js`, `src/main.js` (`chats:*` handlers `:8359-8500`, a new `chats:search`), `src/features/chat-preload.js` and the main preload, `src/renderer/chats.js`, `src/renderer/chat-items.js`, `src/renderer/chat-page.js`, `chat-page.html`, `chats.css`.

### WP4: Composer and shortcuts (B12, B17, B18; rows 24, 26, 27, 28, 38, 40, 42, 43, 48)
Per-chat drafts (kept in main with the chat), Up to edit last, Ctrl+K to focus chat search, collapse of long user messages, file chip previews, follow-up suggestion chips (one cheap model call, behind a setting), read aloud (`speechSynthesis`) and dictation if the Electron build supports `SpeechRecognition` (check first; otherwise leave it out), larger action targets with labels.
Files: `src/renderer/chat-core.js` (composer region `:582-800`, `:2122-2271`), `src/renderer/chat-commands.js`, `src/renderer/slash.js`, `chat-extras.js`, `src/renderer/styles.css` (composer and action rows), i18n. Lands after WP2 or rebases on it, since both touch `chat-core.js` (different regions).

### WP5: Canvas and standing instructions (rows 12, 37)
An artifact panel for long code and documents (open from a "Open in panel" button on code blocks over N lines, editable, copy and download), and Settings > AI custom instructions plus a small memory list that is added to the system prompt.
Files: new `src/renderer/chat-canvas.js` and css, `src/renderer/chat-page.html`/`.css` (side panel layout), `src/renderer/settings.js` and `settings.html` (the instructions field), `src/ai/agent.js` (`systemFor`, about `:94`), `src/features/settings` store.

Suggested order: WP1 (visible correctness, no overlap), WP3 (data-loss risk), WP2, WP4, WP5.
