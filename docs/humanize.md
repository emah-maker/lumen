# Humanize

Humanize rewrites text that sounds AI-written so it reads like a person wrote it. It keeps what the text says: the facts, names, numbers, dates, quotes and links, and formatting such as lists and code.

## Where to find it

- **Text on a page or in a text box.** Select it, right-click and choose **Humanize**. A card shows the text before and after.
  - In a text box (an email, a document, a form), **Replace** puts the rewrite where the selection was, the way typing would, so the page's own Ctrl+Z works too. A toast offers **Undo** for 10 seconds. If the text in the box changed while the rewrite was on its way, nothing is replaced and the card says so.
  - On text you can't edit, the card has **Copy**.
- **The AI's replies.** The pen button under a reply (next to the thumbs and Add to notes) rewrites that reply and shows the new version in its place, with **Show original** to switch back. Copy then copies the version on screen. The chat's history keeps the reply as the AI wrote it, so what the AI reads next is unchanged, and a reopened chat shows the original.
- **The chat box.** `/humanize` with text after it, or a message that starts with "humanize this:" followed by the text, shows the rewrite in a card with Copy. Nothing is sent to the chat. `/humanize` on its own humanizes the last reply.
- **Settings → AI → Write replies in a natural voice** (off by default) gives the AI a short form of the same rules for its own replies, in new chats.

The card says which model did the rewrite and what kinds of AI habits it took out. If the rewrite no longer has a number, link, code span, @mention or placeholder that the original had, the card names it so you can check before you use it.

## What it changes

The rules come from the humanizer skill and are applied strongest first:

- "Not X but Y" contrasts, one-line closers, staged openers ("Here's the thing", "Let's dive in"), sayings that only sound deep, and arguing with an objection nobody made.
- Ideas forced into threes, several sentences in a row that start the same way, and dashes used as the connector for everything (em and en dashes become commas, colons, periods or parentheses).
- Stock AI words (delve, crucial, pivotal, robust, seamless, showcase, testament), inflated significance, sales language, borrowed authority and stacked qualifiers.
- Bold labels on every list item, Title Case headings, emoji decoration.
- Chatbot wrappers ("Great question!", "I hope this helps") and knowledge-limit disclaimers.

Casual text such as a chat message or a comment is usually left as it is. Text with no real tell comes back unchanged, and the card says so.

## Which AI does it

Humanize uses the AI you already set up, through the same route the chat uses, and nothing else:

- A chat on an API model (Anthropic, OpenAI, Gemini, xAI, OpenRouter) uses that provider with your key, on its smaller, faster model (Haiku, a mini model, Flash) when there is one. Settings → AI → helpers set to the same model keeps the chat's model. If the smaller model isn't available on your key, the chat's own model is used.
- A chat on Claude Code, Grok Build or Antigravity runs that CLI with no tools, no MCP servers and an empty folder. Claude Code uses Haiku.
- A Codex chat (which has no one-shot mode) uses your OpenAI key, or your default API model.
- With no API key at all, your own Claude Code answers when it is installed and signed in.

The model used is the one of the chat open in the sidebar (or the chat page), else your default model. A rewrite takes up to 12,000 characters at once.

## Privacy

The selected text, the reply or the pasted text goes to that one provider, in one request with no tools. On a site where you turned AI off, Humanize does not read the page. See [PRIVACY.md](../PRIVACY.md).
