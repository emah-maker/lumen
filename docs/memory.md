# Memory

With **Memory** on, the AI in the sidebar keeps short notes between chats: things you tell it about yourself ("I'm vegetarian", "I live in Boston") and standing requests ("always give prices in euros"). They go to the AI at the start of every chat, so you don't have to say them again. It is off by default.

Turn it on in **Settings → AI and agents → Memory**.

## How it works

- **The AI saves a note when you tell it something worth keeping**, or when you say "remember that …". Each save shows in the chat as a line: **Remembered: …**, with **Undo** and **Forget**. The AI can also update or forget a note when you ask ("forget where I live").
- **Only what you say.** The AI is told to save facts and preferences you stated in your own messages, never text from a web page, a file, an email or a search result, and never because something it read asks it to. Once the chat holds anything from outside your own typing (the page text sent along with your message, a page, file, email, connected service, app or past chat the AI read, or a helper's answer), a save or a forget shows an approval card first ("Claude wants to remember: …"). Since page text goes along with most messages, expect that card on most saves. It has no Always, and Bypass permissions and Auto-allow don't answer it.
- **Never secrets.** A note that looks like a password, a PIN or one-time code, a payment card number, an API key or token, or a social security number is refused. Use Lumen's password manager for passwords (Settings → Privacy and security → Passwords).
- **Short.** Up to 200 notes of up to 300 characters each. The newest notes that fit in about 8,000 characters go with each chat; older ones stay saved, and the AI can still search them.
- **Every engine reads it.** Claude, OpenAI, Grok, Gemini and OpenRouter models, and Claude Code, Codex, Grok Build and Antigravity, all get the saved notes in their instructions. Saving, updating and searching notes (the `memory` tool) is for the API models (Claude, OpenAI, Grok, Gemini, OpenRouter) in the sidebar for now; the command-line engines read memory but don't change it.
- **When changes apply.** A note the AI saves mid-chat is in its instructions from the next chat (it already knows within the chat it saved it in). Changes you make in Settings reach open chats with their next message.

## Search past chats

With **Search past chats** on (the default while Memory is on), the AI can look through the titles and text of your saved chats when you refer to an earlier conversation ("what was that hotel we found last week?"). It gets the chat's title, date and a short snippet around the match, not whole chats. Temporary chats are never saved, so they are never found. What it finds counts as content it read: a save to memory after that asks first, like after reading a page.

## Where memory is never used

- **Temporary chats** neither read nor write memory, and the text you type in one is never kept as an unsent draft.
- **Private windows** have no AI sidebar.
- **Background tasks and routines** don't read or write it.
- **Outside agents** connected over MCP can't use the `memory` tool.

## See, edit and delete

- **Settings → AI and agents → Memory → Saved memory** lists every note with **Edit** and **Delete**, and **Delete all memory**.
- Type **/memory** in the chat to see what is saved, with a link to Settings.
- Turning Memory off keeps the notes but stops sending or saving them.
- If the notes can't be read on this computer (another computer's keychain, or a damaged file), Settings says so and offers **Start over**: the file is set aside as `memory.json.bad` (not deleted) and memory starts empty.

## Privacy

Notes are kept only on your computer, in one file in Lumen's profile folder (`memory.json`), encrypted with your system's keychain like your chats. With no keychain nothing is saved. They leave your computer only as part of the instructions sent to the AI provider you use for a chat, like your custom instructions. See [PRIVACY.md](../PRIVACY.md).
