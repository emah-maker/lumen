# Humanize

Humanize runs your **humanizer skill** on a piece of text: the AI rewrites it with that skill's own instructions, so it reads like a person wrote it without changing what it says. Lumen adds no writing rules of its own.

## Set it up

Humanize uses a skill named `humanizer` (or `humanize`) from Lumen's skills (Settings → Skills):

- **Your Claude Code skill.** If you have `~/.claude/skills/humanizer/SKILL.md`, turn on Settings → Skills → **Use my Claude Code skills**. Lumen reads that file as it is, and changes you make to it in Claude Code apply the next time you use Humanize. A Claude Code skill may hold up to 40,000 characters of instructions.
- **A Lumen skill** named `humanizer` works too. A Lumen skill holds up to 8,000 characters.

Without the skill, Humanize says so ("Humanize needs the humanizer skill: add it under Settings → Skills"), with a button that opens Settings → Skills. When the skill is in `~/.claude/skills` but the switch is off, the message tells you to turn it on.

## Where to find it

- **Text on a page or in a text box.** Select it, right-click and choose **Humanize**. A card shows the text before and after.
  - In a text box (an email, a document, a form), **Replace** puts the rewrite where the selection was, the way typing would, so the page's own Ctrl+Z works too. A toast offers **Undo** for 10 seconds. If the text in the box changed while the rewrite was on its way, nothing is replaced and the card says so.
  - On text you can't edit, the card has **Copy**.
- **The AI's replies.** The pen button under a reply (next to the thumbs and Add to notes) rewrites that reply and shows the new version in its place, with **Show original** to switch back. Copy then copies the version on screen. The chat's history keeps the reply as the AI wrote it, so what the AI reads next is unchanged, and a reopened chat shows the original.
- **The chat box.** `/humanize` with text after it, or a message that starts with "humanize this:" followed by the text, shows the rewrite in a card with Copy. Nothing is sent to the chat. `/humanize` on its own humanizes the last reply.

The card says which model did the rewrite. If the rewrite no longer has a number, link, code span, @mention or placeholder that the original had, the card names it so you can check before you use it.

## Which AI does it

Humanize uses the AI you already set up, through the same route the chat uses, and nothing else:

- A chat on an API model (Anthropic, OpenAI, Gemini, xAI, OpenRouter) uses that provider with your key, on its smaller, faster model (Haiku, a mini model, Flash) when there is one. Settings → AI → helpers set to the same model keeps the chat's model. If the smaller model isn't available on your key, the chat's own model is used.
- A chat on Claude Code, Grok Build or Antigravity runs that CLI with no tools, no MCP servers and an empty folder. Claude Code uses Haiku.
- A Codex chat (which has no one-shot mode) uses your OpenAI key, or your default API model.
- With no API key at all, your own Claude Code answers when it is installed and signed in.

The model used is the one of the chat open in the sidebar (or the chat page), else your default model. A rewrite takes up to 12,000 characters at once. The skill's instructions go with each request, so a long skill uses more input tokens.

## Privacy

The skill's instructions and the selected text, the reply or the pasted text go to that one provider, in one request with no tools. On a site where you turned AI off, Humanize does not read the page. See [PRIVACY.md](../PRIVACY.md).
