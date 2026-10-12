# The AI and Google Docs

Google Docs draws its pages on a canvas, so there is nothing for the AI to click. The AI's `document` tool edits a Google Doc the way a person does with the keyboard, and checks every step against Docs' own export (the text, plus the pictures, tables and equations). It never retypes your document.

## What it can do

`document` takes an `action`:

- **outline**: the headings with their level, paragraph number and word count, plus the whole document's counts. It also takes the snapshot that everything else is checked against, before the first edit.
- **select_section** (`heading`): selects a heading and everything under it, up to the next heading of the same or higher level. The selection is copied and compared with what the export says the section holds (its words, pictures and tables); if it is not exactly that, nothing is changed.
- **move_section** (`heading`, `where` before or after, `to`): cuts that section and pastes it before or after another, as a real range, so pictures, tables, equations and fonts come with it.
- **style** (`style`, optionally `heading`): Normal text or Heading 1 to 6, with Docs' own shortcut (Ctrl+Alt+0 to 6).
- **replace** (`find`, `replace`, `all`): Docs' own Find and replace (Ctrl+H), so the formatting around the text stays.
- **insert_markdown** (`text`, and `heading` with `where`, or `where` start or end): pastes the Markdown as formatted content (headings, lists, bold, links) at the cursor, a heading, or the start or end.
- **verify**: compares the document now with the snapshot from before the first edit.
- **undo**: takes back the AI's edits in this run, step by step, until the document matches the snapshot.
- **read**: the whole text (the same as `read_page` on a Doc).

It works only in Google Docs. Elsewhere it says so and points to `read_page` and cut and paste.

## It never retypes your content

Reformatting a document means moving and styling what is there. The AI is told never to select everything and retype or replace it, and Lumen enforces that on a Docs tab:

- Selecting everything and then typing, pasting or pressing Delete asks first ("This removes 100% of the document (3 images, 1 table)... Continue?").
- Any key that would remove more than a fifth of the words, or a picture, table or equation, asks first, with what it would remove.
- `insert_markdown` at the cursor with everything selected is refused.

The cards ask even with **Auto-allow** on. With **Bypass permissions** on there is no card: Lumen shows a step saying what was allowed.

## It checks its own work

After every edit the tool re-reads the document's export and compares it with the snapshot: the same words (reordering is fine), the same number of pictures, tables and equations, and the headings in the order and styles the edit planned. A move that comes out wrong is undone. The AI is told to say a document is unchanged only after `verify`, and when something was lost it says so and offers to restore it; **File > Version history** can bring back the version from before.

## Limits

- Docs saves a moment after an edit, so a check can wait a few seconds for the export to catch up.
- Equations and pictures are counted from the export's HTML; an equation Docs exports as a picture counts as a picture.
- A general "did the AI wipe my text" check cannot measure a canvas editor like Docs; this tool and the guard on Docs keys cover that gap for Google Docs.
- Word Online and Notion are not supported by the tool yet.

The code is `src/ai/document-tool.js` (the actions) and `src/ai/doc-edit.js` (the checks); tests are `test/doc-edit-units.js` and `test/document-tool.js`.
