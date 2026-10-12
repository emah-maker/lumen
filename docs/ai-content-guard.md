# The AI and your content

When the AI types, presses Delete, runs a script or clicks a Delete button on a page, Lumen checks what that did to the text field or editor it touched. It applies on every site and to every engine: the sidebar's own models, Claude Code, Codex, Grok Build, Antigravity and outside agents over MCP. Nothing it measures leaves your computer.

## What it watches

Before and after typing (`type_text`, and so `fill_form`), Delete, Backspace and cut, `run_script`, and a click on a button named Delete, Remove, Clear, Discard or Empty trash (by its text, label or tooltip), Lumen measures the field or editor in question: the one with the cursor, else the page's main editor. It counts characters, images, tables, equations, list items, table rows and formatting (bold, links, headings, colours).

A change is **big** when it takes out any of these that the AI did not write in this run:

- 300 characters, or a fifth of a field once that is at least 150 characters
- any image, table or equation
- 5 list items or 5 table rows
- most of the formatting

The run's edits are added up, so a hundred small deletions count as one big one. Text the AI typed itself in this run never counts, and text that only moved to another place in the same editor isn't lost.

## What you see

- **Before**, when Lumen can tell: typing over a field replaces everything in it (so a long document with pictures would be gone), a Delete over a selection, or a script that assigns `innerHTML` or `textContent`. The card says what would be removed: **Go ahead** / **Don't do it**.
- **After**, for anything else that turns out to be big. Lumen puts the content back first (the page's own undo, else a copy it took before), then asks: **Keep the change** / **Undo it**. If it could not put it back, the card says so and points to the site's version history.

The cards ask even with **Auto-allow** on. With **Bypass permissions** on there is no card: Lumen shows a step saying what was removed, leaves it as it is, and keeps the undo below available.

When you say no, the AI is told not to retry or work around it, and to edit in place instead.

## Undo the AI's edits on this page

Under a reply that edited a field or an editor, **Undo the AI's edits on this page** puts each of them back as it was at the start of the run. A plain field is restored from its saved copy. An editor goes back through its own undo, as many steps as it takes, checked against the saved copy; if that doesn't bring it back, the copy is put in. It says which pages it could and couldn't restore. A site that saves your work online (Google Docs, Notion) may already have saved the change: use its version history. Google Docs draws its pages on a canvas, so Lumen measures a Doc through its own export instead (text, pictures, tables, equations; [the AI and Google Docs](ai-document-tool.md)), and this button undoes with Docs' own undo.

## Truthful reports

`verify_changes` tells the AI what the run changed in each field or editor it edited: text size, images, tables, list items and rows, before and after. The AI is told never to say content is unchanged or edited without calling it, and a result that removed something big carries a note the AI has to pass on.

## Limits

- Only fields and editors are measured, not the rest of a page. Clicking Delete on a list of emails is not undone; only an editor that loses content is.
- Embedded frames, password fields and editors drawn on a canvas are not measured.
- A script can do anything; a wipe it does in a way Lumen can't read in advance is caught afterwards.
- Restoring an editor from its copy brings back the content and formatting, not the editor's own internal state. Prefer the editor's undo or the site's history for a document that matters.

The code is `src/ai/content-guard.js`; tests are `test/content-guard-units.js` and `test/content-guard.js`.
