# Macros

A macro is a named list of steps you run on demand: open pages, click, type, press keys, wait, scroll, run a Lumen command, ask the AI. Make one in **Settings → Macros** (`lumen://settings/macros`).

## Making one

- **Record…** Press it (or ⋯ → Macros → Record a Macro…), then do the steps in the web page you were on. A small bar at the top of the window shows the count; **Stop and review** opens the steps in the editor. Clicks, typed text, menu choices, Enter and Escape, key shortcuts, page changes you made by typing an address, and tab switches are recorded. **Password, one-time-code and payment fields are never read:** typing in one leaves a **Pause** step ("Enter Password yourself") that waits for you when the macro runs. Nothing is saved until you press Save.
- **Describe it…** Say what you want in a sentence; the AI drafts the steps, which open in the editor to review. It only guesses at the page, so read each step.
- **New macro.** Add, change, reorder and delete steps by hand. A name, an optional description, an optional **keyboard shortcut** (press the keys; it is checked against Lumen's own shortcuts and your other macros), and an optional **site** ("only on example.com", also its subdomains). **Test run** runs the steps as they are now, without saving.

## Step types

| Step | What it does |
|---|---|
| Open a page | An `http(s)` address, in a new tab or this tab. |
| Click | An element, found again from its stored locator. |
| Type text | Into a field; optionally press Enter after. |
| Choose an option | In a menu, by its label. |
| Press a key | A key with optional Control, Shift, Alt, Meta. |
| Wait | A number of seconds, an element to appear, the page to finish loading, or some text. |
| Scroll | Up or down by screens. |
| Switch or close a tab | The next, previous, first or last tab, or one whose title or address matches. |
| Lumen action | Reader mode, mute, pin, put the tab in a group, open the sidebar with a prompt, new chat, bookmark, zoom, reload, back, forward, new tab. |
| Ask the AI | Sends a prompt to the sidebar AI (not waiting for the reply). |
| Pause for me | Waits for you (to sign in, to type a password); **Continue** or **Stop** in the toast. |

An element is stored as a **locator** with several ways to find it: a test id (`data-testid` and friends), an id that looks stable, the role and accessible name, the visible text, and a CSS selector. Lumen tries them in that order, so a page that changes a little still works. A step that cannot find its element stops the run and says which step.

## Variables

`{{query}}` in a step (an address, typed text, an option, a prompt) is asked for each time the macro runs. Filled in by Lumen: `{{clipboard}}`, `{{selection}}` (selected text on the page), `{{url}}`, `{{title}}`, `{{date}}` (2026-10-07) and `{{time}}`. In an address, values are percent-encoded. In an "Ask the AI" step, text taken from the page or clipboard is handed to the AI as untrusted data.

## Running one

- ⋯ menu → **Macros** → the macro's name.
- Its keyboard shortcut.
- `/macro name` in the sidebar (a unique start or piece of the name is enough). A macro that needs values asks for them in a small form above the message box.
- **Run** in Settings → Macros.
- The AI: the `run_macro` tool ([MCP tool reference](mcp-tools.md#run_macro)) runs a saved macro by name.

While one runs, a toast in the tab strip shows **step N/M** with **Stop**. A step that fails shows which step and why, with **Edit macro**.

Runs you start work in the front web page (or the last one you used when Settings is in front). They are your own actions: hands-off mode and "AI off on this site" are about the AI and do not stop them.

## Safety

- A macro does only what its steps say. There is no script step, and an imported file is shown in full for review before anything is saved.
- Steps that submit forms, buy or send are allowed because you wrote them. **When the AI runs a macro**, each step goes through the same approvals as the AI's own actions (the first click or typing on a new site asks), and a step that clicks a submit, buy, send, post or delete control, or presses Enter to submit, asks with a card naming the step. If you say no, the macro stops there. A macro with an "Ask the AI" step, or one that uses `{{clipboard}}`, is not run by the AI at all.
- Secrets are never stored: a step that types into a password, one-time-code or payment field is refused when saving or importing, a card number typed as text is refused, and the recorder never reads those fields.
- A step cannot open `javascript:`, `file:` or `data:` addresses, also when a variable fills the address in.

## Where they are kept

`macros.json` in Lumen's profile folder (next to `settings.json`), written atomically. **Export all…** and **Import…** use a JSON file (`{"format": "lumen-macros", "version": 1, "macros": [...]}`); an import is reviewed first, names that are taken are renamed, and a shortcut that conflicts is dropped.

## Limits

Elements inside embedded frames are not found by their locator (the page's own document only). A recorded click that opens a link in a new tab is replayed as the click plus a "switch tab" step. Up to 100 macros of up to 100 steps each.
