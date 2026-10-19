# Notes

A small notepad in the sidebar. Notes stay on your computer, across tabs and restarts.

Open it from **⋯ → Notes** in the sidebar.

## Writing

- **New note** starts a note and puts the cursor in it. The first line is its title in the list.
- Write plain text. Markdown works: `# headings`, `**bold**`, `- lists`, `> quotes`, code blocks and formulas. **Preview** shows it drawn; **Write** goes back to the text.
- **It saves as you type**, a moment after you stop. The line next to the tabs says Saved. Leaving the note, closing the panel or closing the window saves at once.
- **Search** at the top of the list finds notes that contain every word you type, in any order.
- The bin icon deletes the open note. **Undo** is in the list right after.

## Adding to a note

- **Under an AI reply**, the **Add to notes** button (on hover, next to the thumbs) adds the whole reply to the note that is open. A diagram the AI drew comes along as a picture. If no note is open, it starts a new one.
- **On a diagram**, the **Notes** button in its header adds just the diagram.
- **On a picture the AI made**, the **Add to notes** button next to Save and Copy keeps the picture in your notes.
- **On a web page**, select text, right-click and choose **Add to notes**. The text goes in as a quotation, with the page's title and a link back.

The "open note" is the one you last wrote in or opened. Pictures are kept in a `notes-media` folder next to `notes.json`; one that no note uses any more is removed the next day.

## Asking the AI

- **Ask AI** at the bottom of a note sends the note, with your question (or "summarize this note and point out anything missing"), to the chat. Nothing is sent until you press it.
- **The AI can use your notes** when you ask it to ("what did I write about the lab?", "put this in my notes"). It can list, search and read notes, add text to the end of a note, and start a new note. It cannot edit, replace or delete anything you wrote. This works for the API models (Claude, OpenAI, Grok, Gemini, OpenRouter) in the sidebar; outside agents connected over MCP and the command-line engines don't have it.
- When the AI reads a note, its text goes to the AI provider you chose, like anything else in a chat.

## Where it lives

One file, `notes.json`, in Lumen's profile folder, written to a temporary file and renamed so a crash never leaves it half-written. It isn't encrypted, so you can read it and back it up. If the file is ever damaged, Lumen sets it aside as `notes.json.bad-…` and starts with an empty notepad rather than writing over it.

Up to 500 notes of up to 400,000 characters each.
