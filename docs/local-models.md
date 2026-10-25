# Local models

Lumen can chat with AI models that run on your own computer, through **Ollama** or **LM Studio**. There is no key and no account, and nothing leaves your computer.

## Set it up

1. Install and start Ollama (it listens on `http://127.0.0.1:11434`) or LM Studio (turn on its local server; it listens on `http://127.0.0.1:1234/v1`), and download at least one model.
2. In Lumen, open **Settings → AI and agents → AI providers → Local (Ollama / LM Studio)**.
3. Switch on **Use local models**, choose the **Server**, and press **Detect**. Lumen lists the models you have installed.
4. Pick one from any model menu, under **Local**.

The address box starts with each server's usual address. Change it if your server listens somewhere else.

## Where messages go

- Only `localhost`, `127.0.0.1` and `::1` addresses work. Type another address (a server on your network, say) and Lumen asks first: **Use this address anyway**. Once confirmed, your messages and the page text you share go to that host, so use it only for a server you run yourself. Lumen remembers that one host; any other address asks again.
- Chat uses the OpenAI-compatible chat completions endpoint both servers offer (`/v1/chat/completions`, streamed).
- **Detect** reads the server's own list: `/api/tags` (and `/api/show` for what each model can do) for Ollama, `/v1/models` (and `/api/v0/models`) for LM Studio. Lumen does not ask the server for anything at startup; the list is the one Detect last saved.

## Tools and plain chat

A model that supports tools can click, type and read in your tabs like any other model. The model list marks each one: **Can use tools**, **Chat only**, or **Tools not known yet** (an older server doesn't say; Lumen tries tools on the first message). If a server refuses tools for a model, Lumen says so in the chat, answers that message as plain chat, and marks the model **Chat only**. A chat-only model can still read the page you are on. Browser actions need a tool-capable model.

## What local models don't do

- **Auto** never picks a local model, and a local model is never offered as the stand-in when another one is out of usage.
- If a local model fails (the server is stopped, say), Lumen does not hand the chat to a cloud model. It tells you to start the server.
- Local models don't count toward Usage: there is no limit or price to track.

## Tips

Small models handle long page text and many tools poorly. Raise the server's context length (Ollama's `num_ctx`, LM Studio's context length) if replies cut off or ignore the page. Lumen assumes about 32,000 tokens of context for local models when it trims a long chat.

Setting: `localAI` in [Settings reference](settings.md).
