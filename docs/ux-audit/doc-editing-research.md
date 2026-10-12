# Document editing for Lumen's AI: research (2026-10-11)

Problem: the sidebar AI could not reorder sections or restyle a lab report in Google Docs. Docs paints on a canvas, Edit > Paste needs a clipboard permission, and the AI guessed with coordinate clicks. A later failure was worse: the engine "reformatted" a Doc copy by replacing the whole body with retyped text, which lost both graphs, fonts, headers, tables and equations, and it then claimed the wording was unchanged. Guardrails for that are the first section.

Builds on two in-flight PRs (not duplicated): `read-gdocs-pdf` (full Docs text through the export URL, read in-page with the user's session) and `ai-edit-commands` (native cut/copy/paste/undo/selectAll, trusted press_key combos, clipboard snapshot/restore).

## 0. Guardrails (top priority, from the real failure)

1. Preserve, do not retype. Reformatting = moving real ranges (cut/paste keeps images, tables, equations, fonts) and applying styles. Never select-all + replace; never retype body content. Whole-document replace only when the user explicitly asks to replace the text.
2. Destructive-action check. Any action expected to delete or replace more than ~20% of the text, or to remove an image, table or equation, goes through a confirm card ("This removes 40% of the document (2 images, 1 table). Continue?"), even under Auto-allow. Bypass skips the card but logs a step. Detection: before/after export diff plus object counts.
3. Verify after editing. Re-export and compare to the snapshot taken before the first edit: same words (modulo expected moves), same image/table/equation counts. If something was lost, say so and offer restore. Never say "unchanged" without the check. Exposed as `document {action:'verify'}` and run automatically at the end of an editing run.
4. Snapshot and undo. Record the version/timestamp before the first edit; offer "Undo all my edits to this document" via version history or inverse moves.

Counting objects from exports: `export?format=html` carries `<img>` and `<table>` tags (images as URLs or data); equations appear as images or as `<span>`/math-like markup, so equation count is best-effort from html (docx contains `<m:oMath>` OMML, the reliable count if the docx is fetched and unzipped). `format=txt` has no objects. See Sources [E1], [E2]. `format=md` is documented only by a community page, so do not depend on it.

## 1. How others edit Docs / Word / Notion without an API key

- Google Docs paints text on a canvas (announced May 2021), so DOM selectors break; Google said screen readers and braille are unaffected [S1].
- Docs receives keystrokes in a hidden iframe (`.docs-texteventtarget-iframe`, contenteditable). Userscripts such as DocsKeys dispatch synthetic key events to its active element [S2]. Synthetic (untrusted) events may be ignored; trusted CDP input (what `ai-edit-commands` adds) is the dependable route. Note: from outside knowledge, not confirmed by a source.
- Extensions such as Harper read and write the logical text through Docs' internal annotated-canvas API by setting a `_docs_annotate_canvas_by_ext` flag and injecting a main-world bridge [S3]. This depends on an undocumented hook and impersonates a supported extension; do not use.
- Generic automation tools (browser-pilot-cli, Playwright `keyboard`) send real key events to the focused canvas editor, clicking `.kix-appview-editor` first [S4]. That is exactly the coordinate/keyboard guesswork that failed; it needs a structured layer on top.
- Claude's own Google Workspace sidebar add-on (public beta reported 2026-10-06, single news source) edits the open file only, "ask before edits" by default [S5]. Useful product precedent: scope to the open doc, confirm before applying.

## 2. Docs screen-reader / braille mode (the "accessible DOM" idea)

- Enable: Ctrl+Alt+Z (Win) / Cmd+Option+Z (Mac), or Tools > Accessibility settings > "Turn on screen reader support"; braille support is Ctrl+Alt+H, separate, off by default [S6].
- Google's help page does not say the document becomes accessible DOM text; it describes announcements and braille output. Third-party guides say content is conveyed through ARIA live announcements as the cursor moves, plus Accessibility > Speak (selection, paragraph, cursor location, formatting; reported Ctrl+Alt+X) [S6][S7]. Landmark navigation is described as unreliable.
- Conclusion: UNVERIFIED that the mode exposes a full DOM mirror with a selection. Treat it as an optional signal: the live region echoes the current line/selection, which can confirm what a selection covers. Do not make correctness depend on it; use the export for full text and keyboard commands for actions. If used, enable only during the AI's operation and restore the user's prior setting (it is a per-user Docs setting, so read the Tools menu check state first).

## 3. Docs keyboard shortcuts (Windows; Google help [S8])

- Styles: Normal text Ctrl+Alt+0; Heading 1-6 Ctrl+Alt+1..6.
- Lists: bulleted Ctrl+Shift+8; numbered Ctrl+Shift+7.
- Find and replace Ctrl+H (Mac Cmd+Shift+H).
- Tool finder (formerly "Search the menus"): Alt+/ (also Alt+Shift+Z; Chrome Alt+Z). This is the best way to run any menu command (e.g. "Paste from Markdown") without coordinates.
- Outline: hold Ctrl+Alt, press A then H. No "Go to" shortcut is listed.
- Move paragraph up/down: Ctrl+Shift+Up/Down. Select all Ctrl+A. Link Ctrl+K. Clear formatting Ctrl+\. Paste without formatting Ctrl+Shift+V.
- Table navigation: hold Ctrl+Alt+Shift, press T then S/D/M/G/B/V/E.
- Equation: no shortcut listed; Insert > Equation (menu keys Alt+I, E reported) [S9]. Within the equation editor, backslash codes (`\pi`, `^`, `_`) convert symbols; it is a LaTeX-like subset, not full LaTeX [S9].
- Alt/Ctrl+Alt combos can collide with AltGr on non-US layouts and with browser/OS shortcuts [S6].

## 4. Docs Markdown [S10]

- Tools > Preferences > "Enable Markdown" (older label "Automatically detect Markdown"); right-click > "Paste from Markdown" and "Copy as Markdown"; File > Download > Markdown (.md); import .md via Open/Upload. Syntax: `#`..`######` headings (Docs only), italics, bold, strikethrough, links. Release was July 2024 with staged rollout; label and availability vary by account [S11]. Typed-markdown autoformat is inconsistent on paste; the explicit "Paste from Markdown" command is the dependable path. Tables, images and equations are not covered by Docs' Markdown paste.

## 5. Rich HTML paste into Docs

- Docs reads `text/html` from the clipboard on paste and maps headings, lists, bold/italic, links and tables. Its own copied HTML wraps content in `<b id="docs-internal-guid-...">` with inline spans [S12]. This is known behavior; I found no source for `document.execCommand('insertHTML')` against the Docs iframe, and that path is UNVERIFIED and likely to be ignored since Docs maintains its own model. Plan: write HTML (and plain-text fallback) to the clipboard with the snapshot/restore from `ai-edit-commands`, then trusted Ctrl+V.
- Paste with Ctrl+V keeps source formatting; Ctrl+Shift+V strips it.
- Pasting HTML/Markdown only for NEW content the user asked for. Never to rebuild existing content (guardrail 1).

## 6. Word Online

- Documented in Microsoft's Word for the web shortcut page: Find Ctrl+F/F3; select all Ctrl+A; Ctrl+Up/Down move the caret by paragraph (not content) [S13]. Ctrl+H opens Replace per the Find and Replace article [S14].
- Heading shortcuts Ctrl+Alt+1..3 are desktop Word; not confirmed for Word for the web. Alt+Shift+Up/Down paragraph move and Navigation-pane drag are desktop features; sources say they do not work on the web [S15]. So basic level only: Replace via Ctrl+H, styles via the ribbon/Tell Me (Alt+Q, unconfirmed), no section move.
- Collapse-heading-then-move technique is desktop Word [S15].

## 7. Notion

- Blocks. `/` opens the block menu and filters (`/h2`, `/toggle`); Esc selects the block; Shift+Up/Down extends the block selection; Ctrl+Shift+Up/Down moves selected blocks; Ctrl+Shift+0..9 turn blocks into text/headings/lists; markdown typing (`# `, `- `, `1. `, `[] `) converts [S16]. Block model means a "section" is a heading plus following sibling blocks (unless a toggle heading).

## 8. Reliable recipes (for Docs)

- Select a heading's section: place caret in the heading (find by Ctrl+F or the outline), then extend with Shift+Ctrl+Down to the next same-or-higher heading. Needs the outline (from export html headings with order) to know which heading is next. UNVERIFIED in real Docs: whether collapsed headings move with their content under Ctrl+Shift+Up (no source found; expandable headings were added 2023 [S17]).
- Move a section: select the range, Ctrl+X (native cut via `ai-edit-commands`), move caret to the target heading start, Ctrl+V. Cut/paste of a real range keeps images, tables, equations and fonts (the opposite of the failure above). Alternative: Ctrl+Shift+Up/Down per paragraph (slow, order-dependent).
- Apply heading styles: caret in the paragraph, Ctrl+Alt+0..6.
- Build a table: Insert > Table via Tool finder; or paste HTML `<table>`; table navigation shortcuts above.
- Insert an equation: Tool finder "Equation", then type backslash codes.
- Replace text precisely: Ctrl+H, fill Find and Replace fields, "Replace all" or "Replace" stepping; this keeps formatting of untouched text. Prefer it over retyping.

## 9. What is current in 2026 / caveats

- Canvas rendering (2021) still in place; Docs Markdown (2024) shipped; collapsible headings (2023); Claude for Google Workspace beta reported Oct 2026 (single source). The Docs export `format=md` is community-documented only.
- Not verified against real Google Docs: screen-reader DOM content, insertHTML, collapsed-heading move, Word Online heading shortcuts, equation count from html.

## Sources

- S1 https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html
- S2 https://greasyfork.org/en/scripts/562026-docskeys-vim-for-google-docs/code
- S3 https://writewithharper.com/docs/contributors/chrome-extension
- S4 https://socket.dev/npm/package/browser-pilot-cli/diff/0.1.5
- S5 https://support.claude.com/en/articles/16951679-use-claude-in-google-docs-sheets-and-slides
- S6 https://support.google.com/accessibility/answer/6282736
- S7 https://www.scu.edu/oae/assistive-tech/screen-readers/using-google-docs-with-a-screen-reader/
- S8 https://support.google.com/docs/answer/179738
- S9 https://it.lbl.gov/google-docs-latex-equation-shortcuts/
- S10 https://support.google.com/docs/answer/12014036
- S11 https://alternativeto.net/news/2024/7/google-docs-enhances-markdown-support-with-new-import-export-and-conversion-features
- S12 https://community.obsidian.md/plugins/google-docs-paste
- S13 https://support.microsoft.com/office/keyboard-shortcuts-in-word-web-app-2554e572-59c4-4406-bc4d-94a29c9879fb
- S14 https://support.office.com/en-us/article/6f0f7d58-9b49-4a14-aba8-1de2195c0ab6
- S15 https://www.techrepublic.com/article/microsoft-word-move-large-chunks-content/
- S16 https://www.notion.com/help/keyboard-shortcuts
- S17 https://workspaceupdates.googleblog.com/2023/05/expand-and-collapse-content-google-docs.html
- E1 https://www.webnots.com/5-google-docs-url-tricks-you-need-to-know/
- E2 https://openskillindex.com/skills/joelhooks-joelclaw-google-docs-md
