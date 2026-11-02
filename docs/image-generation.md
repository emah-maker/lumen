# Image generation

Any chat model in Lumen can get a picture made, even one that can't draw (Claude, Claude Code, Antigravity, Codex). Two things ask for it:

- you type "draw a cat", "generate an image of …" or `/image …`, and
- the AI calls the `generate_image` tool (every engine has it: the API tool list, and Lumen's MCP tools for Claude Code, Grok Build, Antigravity and Codex).

Lumen's image router (`src/ai/image-router.js`) hands the request to a provider **you have already connected**. It never uses a key you haven't set or switched off, and it never asks for one in the chat.

## Who makes the picture

| Provider | How | Edits |
|---|---|---|
| Grok Build | its own `image_gen` / `image_edit` tools, through your `grok` sign-in (your plan, no API key). One headless run in a temporary folder with only that tool allowed (`src/ai/image-grok.js`) | yes |
| Grok (xAI API key) | images API | no |
| Gemini (API key) | `generateContent` with image output | yes |
| OpenAI (API key) | `gpt-image` | yes |
| OpenRouter (API key) | a model its catalog lists as making pictures | yes |
| Antigravity (agy), **only when picked** | one headless `agy --sandbox --mode accept-edits --add-dir <temp folder> --print-timeout 3m -p "Generate an image: … Save to <file>."` run, through your Google sign-in (no API key, never `--always-approve`). Its own home (`<profile>/antigravity-image`) denies commands, URLs and MCP tools and loads none of your MCP servers; the picture must exist in the temp folder and be a real png/jpeg/webp/gif (`src/ai/image-agy.js`) | yes |

Codex is not an image provider here (its free tier is limited). Antigravity makes pictures only when you pick it in **Make pictures with**: Automatic never uses it (each picture is a slow headless run, and agy has no sign-in check that costs nothing). If agy isn't installed, isn't signed in, or saves no picture, the next connected provider makes it and the picture says "instead of Antigravity". In an Antigravity chat, Lumen's tool gate still denies agy's own image tool; pictures there go through `generate_image` like every other engine.

**Settings → AI → Make pictures with** (`imageGen`):

- **Automatic** (default). The chat's own provider first when it makes pictures (a Grok Build, OpenAI, Gemini or Grok chat), then Grok Build, Grok, Gemini, OpenAI, OpenRouter. A provider that is out of usage right now (the same cooldowns the model fallback uses) goes last. A provider you turned off for Auto ("Auto may use") is left out, unless it is the chat's own.
- **A single provider.** It makes every picture, whatever the chat is on (even if it is turned off for Auto). When it isn't set up, its key is switched off (Settings → AI → API keys), it can't edit pictures (Grok's API, for "edit the last one"), it is out of usage or it fails, the Automatic order takes over (without the providers turned off for Auto). The status line says so ("Making your picture with Gemini (OpenAI isn’t available)…") and the picture's credit ends in "(instead of OpenAI)". Providers with no key, or a key switched off, show "(not set up)" in the list.
- **Off.** Nothing is routed; the model says it can't make pictures.

## Failures

- Out of usage, unreachable, a rejected key, or no picture came back: the next provider is tried.
- A **content-policy refusal** is not a failure to route around. The provider's own words are shown (who declined, and why), and no other provider is asked.
- Stop ends the request.
- If every provider fails, one message names each and what went wrong.

## In the chat

The picture appears like any generated one (saved with the chat, encrypted; Save, Copy, enlarge) with a small "Made with OpenAI · gpt-image-1" line, kept when the chat is reopened. The model is told only that the picture was made and by whom, never sent the picture.

## Privacy and cost

The prompt goes to the provider that makes the picture, and may count against that provider's plan or your API key's billing. After the AI has read page content in a chat, the picture request waits for your OK first (the prompt is on the card), like a web search does, since page text could otherwise be steering what is sent.
