# The AI working in Microsoft Word

Lumen's AI can work with Word documents directly: read them with their headings, lists, tables, comments and tracked changes, add and change text, apply styles, insert tables and pictures, add comments, turn tracked changes on, and save. This is more reliable than clicking around Word (see [The AI using other apps](desktop-apps.md)), because the AI talks to the document itself rather than to a picture of it.

It is on by default (Settings → AI → **Let the AI use Microsoft Word**) and costs nothing until the AI first works with a document: nothing is started, and the tool is offered only when the conversation is about a Word document: you name one ("in Word", `.docx`), say "my essay / report / resume..." or "this doc", attach a .docx/.doc/.rtf/.odt, have one open in a Lumen tab, or a file tool (list_files, a download) shows one. A Google Doc in front is the `document` tool's, never Word's. The tool says to prefer it over reading the file or clicking in Word with `desktop`, and to open the document so you can watch. The routing is `src/ai/app-intent.js` (`test/units/app-intent-units.js`).

## What it can do

One tool, `word`, with these actions:

| Action | What it does |
|---|---|
| `list` | The documents open in Word. |
| `open` / `new` | Open a `.docx`, `.doc`, `.rtf`, `.odt` or `.txt` file (by full path) in Word, or start a new document (optionally saved straight to a new `.docx`). |
| `read` | The document's text with its structure (`#` headings, `-` lists, `\| tables \|`), comments and a tracked-changes summary, in chunks (`offset` pages through a long one). |
| `insert` | New paragraphs at the end, the start, after a heading or paragraph, or at the end of a heading's section, in a style (Normal, Heading 1 to 3, Title, List Bullet, List Number, Quote), optionally bold or italic. |
| `replace` | Find and replace text (exact case, every match, with the count). |
| `style` | Apply a style, bold or italic to text found in the document. |
| `table` / `image` | Insert a table from rows, or a picture (`.png`, `.jpg`, `.gif`, `.bmp`) from a file. |
| `comment` / `track` | Add a comment on some text; turn tracked changes on or off, so the AI's edits show as revisions you can accept or reject. |
| `save` / `save_as` | Save the document, or save a copy as `.docx` or `.pdf`. |
| `show` | Bring Word to the front at the place the AI last changed. |

## How it works

**On Windows with Word installed**, Lumen drives Word's own automation (COM) through one hidden PowerShell helper. It starts the first time the AI uses the tool and ends after a quiet spell. Every value (document text, find text, file names) travels to the helper as data in a JSON line; nothing the AI or a document says is ever put into a script or a command line. If Word is already running, the AI works in that Word; otherwise Lumen starts Word. Lumen never closes your documents, and it quits a Word only if Lumen started it and no document is open in it. Macros never run (documents are opened with macros disabled).

**Without Word** (not installed, or not Windows), a `.docx` file can still be read, and given new paragraphs, headings and tables by writing into the file itself. Those edits are written as tracked changes by "AI (Lumen)", the file is replaced in one step (a failure leaves the original untouched), and a card shows the file's path first. Find and replace, formatting, pictures and comments need Word. `.doc`, `.rtf` and `.odt` files need Word.

**Choosing where it works.** Settings → AI → **Work on files in their apps** (`aiFilesInApps`) picks the route for a file that is not already open in Word. **Automatic** (the default) is what is described above: a closed `.docx` is read from the file, and edits open it in Word when Word is installed. **In the app** always opens the document in Word and reads and edits it there, so you can watch, and offers the tool for any Word document in the chat (this setting does not turn the Word switch on). **From the file** reads and writes the `.docx` file itself and does not start Word, including for a new `.docx`; a kind the file route cannot change (`.doc`, `.rtf`) still opens in Word. A document Word already has open is always read and edited in Word, so unsaved changes are never missed.

**In Claude Code, Codex, Grok Build and Antigravity.** The word tool is not in their shared tool list (that list is size-limited); in a chat about a Word document it is added to that chat's own session, together with one line telling the assistant to edit the document with the word tool in Word, in place, and never to write scripts or new files to do it unless you ask. A chat that is not about a Word document sees neither. A chat's tool list is read when its assistant process starts, so a document first mentioned in a later message may need a new chat before the tool appears.

**On macOS** the Word actions are not available yet ("Windows only for now"); the `.docx` file route above works.

## What it asks

- **Editing a document** asks once per document for the chat (**Allow**), with the document and the text shown.
- **After the AI has read something from elsewhere** in the chat (a web page, an email, a connector, another document), every change asks again, with a warning: text it read could have been written to make it do that. Reading a file by path asks too.
- **Saving over a file, saving to a new path, creating a file** always asks, with the path shown, every time.
- These cards are never answered by Bypass permissions or Auto-allow: they are yours to answer, like the cards for other apps.
- **Hands-off mode** refuses everything that opens, changes or saves; listing and reading still work.
- Text from a document is data, never instructions: it reaches the AI inside a wrapper that marks it as untrusted.
- Nothing is deleted. There is no action that deletes a file or closes a document.
- Document text goes only to the AI provider you chose, as part of the chat, like a page does. Plan mode allows `list` and `read` only. Outside agents connected over MCP and background tasks never get the tool.

## The card

While the AI works in Word, the chat's one live activity card is titled **Word** and shows:

- the document's name as a chip (click it, the card's picture, or its header to bring Word to the front at the place that was changed, or, if nothing was changed yet, the place the AI last read; the picture is a button, so Enter or Space on it does the same) and, in the status line, what is being done ("Writing in Report.docx: adding a table of 3 rows after “Results”");
- a live picture of Word's window, at the same pace and under the same rules as the card for other apps (about 8 a second while it changes, slower while still, nothing while the card is off screen, a call is running, or Word is minimized or hidden; the picture is held in memory only to be shown);
- when Word's window cannot be shown (hidden, minimized, or the file route), a small page preview instead: the paragraphs around the last change, with the changed ones marked, updated after every change, and the lines being read while the AI reads;
- at the end, the last picture and "Done" with the answer.

## For developers

`src/word/spec.js` (arguments, labels, the untrusted wrapper), `src/word/index.js` (the controller: approvals, taint, routes), `src/word/com.js` and `src/word/host.ps1` (the helper), `src/word/docx.js` (the `.docx` reader and writer), `src/word/card.js` (the card's events and live picture). All of it loads on first use; the helper process starts with the first call. `test/units/word-units.js` covers it, with a fake COM host, the real PowerShell decoding, and (when Word is installed and can run fully hidden on a temp document) real Word. The card's drawing is checked in `test/e2e/step-labels.js`.
